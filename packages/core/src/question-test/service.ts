import { PRICE_PER_MILLION_INPUT_TOKENS } from "../backfill/index.ts";
import type {
  Clock,
  Connector,
  DecisionLog,
  ModelProvider,
  ReadRow,
  RecordKey,
} from "../contracts/index.ts";
import { type AnswerEntry, type HumanEntry, standingHuman } from "../log/index.ts";
import {
  askFor,
  createPreviewService,
  newestRows,
  type PreviewCost,
  type PreviewRow,
  type PreviewSkipReason,
} from "../preview/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import { type StateValue, stateHash } from "../records/index.ts";
import type { SpendingGate } from "../spending/index.ts";
import { type Answer, type Decision, decide, resolveThresholds } from "../thresholds/index.ts";
import { DEFAULT_MAX_IN_FLIGHT } from "../worker/index.ts";

/**
 * `facetdb test` and `POST /v1/test`: a draft question set run on the newest records and on every
 * record a person has decided, and per question what would change against the version in force and
 * how agreement with reviewers moves. Nothing is written anywhere: the connector is only scanned
 * and read, the log only read, and the draft is answered through the preview service, whose every
 * request is admitted under the project's spending cap. The cost is estimated first, from the same
 * request text the spending gate reserves; the run is a separate call.
 */

/** Up to 1,000 recent records, and that is also the default. */
export const TEST_DEFAULT_SAMPLE = 1_000;
export const TEST_MAX_SAMPLE = 1_000;

/**
 * How far the printed estimate may sit from the tokens counted after the run: the estimate is four
 * characters to a token, the model counts exactly, and the estimate's words say "about". A run that
 * lands outside this is a defect in the estimate, not in the run.
 */
export const TEST_ESTIMATE_TOLERANCE = 0.25;

/** Log entries read per page while looking for people's decisions. */
const LOG_PAGE_ENTRIES = 1_000;

/** Keys asked of the connector or the log in one call. */
const KEYS_PER_CALL = 200;

/** Histories read at once; each is one round trip to the store. */
const HISTORIES_IN_FLIGHT = 8;

export type QuestionTestDeps = {
  /** The source's connector: `scan` for the newest records, `read` for the reviewed ones. */
  readonly connector: Pick<Connector, "scan" | "read">;
  /** The source's decision log, only read. */
  readonly decisions: Pick<DecisionLog, "page" | "history" | "latestAnswers">;
  readonly provider: ModelProvider;
  /** The project's spending gate, the one its workers share. */
  readonly spending: SpendingGate;
  /** Hears what went wrong without changing the test (the preview service's `log`). */
  readonly note: (line: string) => void;
  /** The source's `maxStateTokens`; absent, core's refusal size. */
  readonly maxStateTokens?: number;
  readonly clock: Clock;
};

export type QuestionTestInput = {
  /** The question set in force: the stored version the answers in the log were given under. */
  readonly current: QuestionSet;
  /** The draft: what the file on disk, or the editor, says now. */
  readonly draft: QuestionSet;
  /** How many of the newest records to test, 1 to `TEST_MAX_SAMPLE`. */
  readonly sample: number;
  /** Whether to add every record a person has decided, whatever its age. */
  readonly reviewed: boolean;
};

/** What the test would ask and cost, before anything is asked. */
export type TestEstimate = {
  /** The newest records read for the test. */
  readonly sampleRecords: number;
  /** Records with a person's decision that still stands, in the sample or not; 0 unless asked for. */
  readonly reviewedRecords: number;
  /** Model requests: the records of both groups the draft would ask, each once. */
  readonly requests: number;
  /** Estimated billable input tokens (four characters to a token). */
  readonly inputTokens: number;
  readonly dollars: number;
};

/** How often the version decided what the person decided, among the records it decided at all. */
export type AgreementSide = {
  readonly agreed: number;
  readonly disagreed: number;
  /** Fell between the thresholds: no decision to agree or disagree with. */
  readonly unsure: number;
  /** agreed of (agreed + disagreed), 0 to 1; null when the version decided none of them. */
  readonly rate: number | null;
};

export type QuestionAgreement =
  /** No record with a person's decision on this question was tested: no number to give. */
  | { readonly kind: "none"; readonly reason: "no-reviewed-records" }
  | {
      readonly kind: "measured";
      /** Records with a person's decision on this question that were asked with the draft. */
      readonly records: number;
      /** The version in force; null for a question the current version does not have. */
      readonly now: AgreementSide | null;
      readonly draft: AgreementSide;
    };

export type QuestionTestRow = {
  readonly question: string;
  /**
   * `compared`: the current version has this question, of the same kind. `new`: it does not, so
   * there is nothing to compare. `kind-changed`: it was another kind (yes or no, a choice, a
   * score), so its answers cannot be compared.
   */
  readonly comparison: "compared" | "new" | "kind-changed";
  /** Sample records with a current decision and no person's decision to keep: the "of" of `changed`. */
  readonly compared: number;
  /** Answers that would change: `toDecided` + `toReview` + `toAnotherValue`. */
  readonly changed: number;
  /** Unsure now, decided by the draft. */
  readonly toDecided: number;
  /** Decided now, unsure under the draft. */
  readonly toReview: number;
  /** Decided both times, to a different value. */
  readonly toAnotherValue: number;
  /** Sample records the log holds no answer for at their present state: nothing to compare with. */
  readonly noCurrentAnswer: number;
  /** Sample records whose person's decision stands whatever the draft says; not compared. */
  readonly keptForPeople: number;
  readonly agreement: QuestionAgreement;
};

export type QuestionTestResult =
  | {
      readonly kind: "tested";
      readonly sample: { readonly records: number; readonly asked: number };
      readonly reviewed: { readonly records: number; readonly asked: number };
      /** Records of either group that were not asked, by why. */
      readonly skipped: Readonly<Record<PreviewSkipReason, number>>;
      /** Questions the current version has and the draft dropped. */
      readonly removed: readonly string[];
      /** One row per question of the draft, in its order. */
      readonly questions: readonly QuestionTestRow[];
      /** Counted by the model after the run. */
      readonly cost: PreviewCost;
      /** What was said before the run, for the two to be read side by side. */
      readonly estimate: TestEstimate;
    }
  | {
      /** The cap was already reached: nothing was asked. */
      readonly kind: "capped";
      readonly message: string;
      readonly fix: string;
      readonly retryAfterSeconds: number;
    };

export type QuestionTestPlan = {
  readonly estimate: TestEstimate;
  /** Asks the model; calling it is the "yes" to the estimate. */
  run(): Promise<QuestionTestResult>;
};

export type QuestionTestService = {
  /** Reads the records and prices the run; asks the model nothing. */
  testQuestionSet(input: QuestionTestInput): Promise<QuestionTestPlan>;
};

/**
 * The rows lack state fields the test needs: the current version's, to tell whether a decision
 * still stands (its hash), and the draft's, to show the model. The connector was opened with
 * other fields.
 */
export class QuestionTestFieldsError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[]) {
    super(
      `the rows do not carry the state fields ${missing.map((name) => `"${name}"`).join(", ")}`,
    );
    this.name = "QuestionTestFieldsError";
    this.missing = missing;
  }
}

type State = Readonly<Record<string, StateValue>>;

function pick(state: State, fields: readonly string[]): State {
  const picked: Record<string, StateValue> = {};
  for (const field of fields) {
    const value = state[field];
    if (value !== undefined) {
      picked[field] = value;
    }
  }
  return picked;
}

function inGroups<Item>(items: readonly Item[], size: number): Item[][] {
  const groups: Item[][] = [];
  for (let start = 0; start < items.length; start += size) {
    groups.push(items.slice(start, start + size));
  }
  return groups;
}

/** Whether a logged answer can be decided by this question at all (an older version may differ). */
function fits(question: Question, answer: Answer): boolean {
  if (answer.type !== question.type) {
    return false;
  }
  switch (question.type) {
    case "noul":
      return true;
    case "choice":
      return answer.type === "choice" && answer.probabilities.length === question.options.length;
    case "score":
      return answer.type === "score" && answer.probabilities.length === question.levels.length;
  }
}

function decideAnswer(
  question: Question,
  set: QuestionSet,
  answer: Answer | undefined,
): Decision | undefined {
  if (answer === undefined || !fits(question, answer)) {
    return undefined;
  }
  return decide(question, resolveThresholds(question, set.thresholds[question.name]), answer);
}

function sameValue(a: Decision, b: Decision): boolean {
  return a.kind === "decided" && b.kind === "decided" && a.value === b.value;
}

type Tally = { agreed: number; disagreed: number; unsure: number };

function sideOf(tally: Tally): AgreementSide {
  const decided = tally.agreed + tally.disagreed;
  return { ...tally, rate: decided === 0 ? null : tally.agreed / decided };
}

function count(tally: Tally, person: HumanEntry, decision: Decision): void {
  if (decision.kind === "needs_review") {
    tally.unsure += 1;
  } else if (decision.value === person.value) {
    tally.agreed += 1;
  } else {
    tally.disagreed += 1;
  }
}

const NO_SKIPS: Readonly<Record<PreviewSkipReason, number>> = {
  "filtered-out": 0,
  "empty-state": 0,
  "too-large": 0,
  "spending-cap": 0,
};

export function createQuestionTestService(deps: QuestionTestDeps): QuestionTestService {
  const { connector, decisions } = deps;
  const preview = createPreviewService({
    connector,
    provider: deps.provider,
    spending: deps.spending,
    log: deps.note,
    clock: deps.clock,
    inFlight: DEFAULT_MAX_IN_FLIGHT,
    ...(deps.maxStateTokens === undefined ? {} : { maxStateTokens: deps.maxStateTokens }),
  });

  /** Every record with a person's decision on one of `names`, found in one pass over the log. */
  async function keysWithPeople(names: ReadonlySet<string>): Promise<Set<RecordKey>> {
    const keys = new Set<RecordKey>();
    let after: number | undefined;
    for (;;) {
      const page = await decisions.page(after, LOG_PAGE_ENTRIES);
      for (const entry of page.entries) {
        if (entry.kind === "human" && names.has(entry.question)) {
          keys.add(entry.key);
        }
      }
      if (page.next === undefined) {
        return keys;
      }
      after = page.next;
    }
  }

  async function readKeys(keys: readonly RecordKey[]): Promise<ReadRow[]> {
    const rows: ReadRow[] = [];
    for (const group of inGroups(keys, KEYS_PER_CALL)) {
      // A key that no longer exists is reported in `missing` and has no row to test.
      rows.push(...(await connector.read(group)).rows);
    }
    return rows;
  }

  async function testQuestionSet(input: QuestionTestInput): Promise<QuestionTestPlan> {
    const { current, draft } = input;
    const draftNames = new Set(draft.questions.map((question) => question.name));

    const sampleRows = await newestRows(connector, input.sample);
    const sampleKeys = new Set(sampleRows.map((row) => row.key));

    // A person's decision stands only while the state is the one they saw, so the hash is the
    // current version's fields of the row as it is now.
    const hashOf = (row: ReadRow) => stateHash(current.read, row.state);
    const peopleKeys = await keysWithPeople(draftNames);
    const wanted = [...peopleKeys].filter((key) => input.reviewed || sampleKeys.has(key));
    const outside = wanted.filter((key) => !sampleKeys.has(key));
    const reviewedOutside = await readKeys(outside);

    const needed = [...new Set([...current.read, ...draft.read])];
    const missing = needed.filter((field) =>
      [...sampleRows, ...reviewedOutside].some((row) => row.state[field] === undefined),
    );
    if (missing.length > 0) {
      throw new QuestionTestFieldsError(missing);
    }

    const rowOf = new Map<RecordKey, ReadRow>();
    for (const row of [...sampleRows, ...reviewedOutside]) {
      rowOf.set(row.key, row);
    }

    // Who decided what, still standing: question name to the person's entry, per record.
    const standing = new Map<RecordKey, ReadonlyMap<string, HumanEntry>>();
    for (const group of inGroups(wanted, HISTORIES_IN_FLIGHT)) {
      const histories = await Promise.all(
        group.map(async (key) => ({ key, history: await decisions.history(key) })),
      );
      for (const { key, history } of histories) {
        const row = rowOf.get(key);
        if (row === undefined) {
          continue;
        }
        const hash = hashOf(row);
        const people = new Map<string, HumanEntry>();
        for (const name of draftNames) {
          const entry = standingHuman(history, name, hash);
          if (entry !== undefined) {
            people.set(name, entry);
          }
        }
        if (people.size > 0) {
          standing.set(key, people);
        }
      }
    }
    const reviewedKeys = new Set(input.reviewed ? standing.keys() : []);

    // The records the draft is asked about: each once, newest first, the older reviewed ones after.
    const asked = [
      ...sampleRows,
      ...reviewedOutside.filter((row) => reviewedKeys.has(row.key)),
    ].map((row): ReadRow => ({ ...row, state: pick(row.state, draft.read) }));

    // The estimate counts the rows the run will ask, with the very request text it will send.
    let requests = 0;
    let estimatedTokens = 0;
    for (const row of asked) {
      const plan = askFor(draft, row, deps.maxStateTokens);
      if (plan.kind === "ask") {
        requests += 1;
        estimatedTokens += plan.requestTokens;
      }
    }
    const estimate: TestEstimate = {
      sampleRecords: sampleRows.length,
      reviewedRecords: reviewedKeys.size,
      requests,
      inputTokens: estimatedTokens,
      dollars: (estimatedTokens * PRICE_PER_MILLION_INPUT_TOKENS) / 1_000_000,
    };

    async function run(): Promise<QuestionTestResult> {
      const result = await preview.previewRows(draft, asked);
      if (result.kind === "capped") {
        return result;
      }
      const answered = new Map<RecordKey, Extract<PreviewRow, { kind: "answered" }>>();
      const skipped = { ...NO_SKIPS };
      for (const row of result.rows) {
        if (row.kind === "answered") {
          answered.set(row.key, row);
        } else {
          skipped[row.reason] += 1;
        }
      }

      // The version in force answered each record when it last changed: the latest logged answer,
      // used only if it was given for the state the record has now.
      const latest = new Map<RecordKey, AnswerEntry>();
      for (const group of inGroups(
        asked.map((row) => row.key),
        KEYS_PER_CALL,
      )) {
        for (const [key, entry] of await decisions.latestAnswers(group)) {
          latest.set(key, entry);
        }
      }
      const answerNow = (key: RecordKey, question: Question): Answer | undefined => {
        const row = rowOf.get(key);
        const entry = latest.get(key);
        return row !== undefined && entry?.stateHash === hashOf(row)
          ? entry.answers[question.name]
          : undefined;
      };

      const rows = draft.questions.map((question): QuestionTestRow => {
        const before = current.questions.find((candidate) => candidate.name === question.name);
        // Only a question of the same kind has answers the draft's can be set against.
        const prior = before?.type === question.type ? before : undefined;
        const comparison =
          before === undefined ? "new" : prior === undefined ? "kind-changed" : "compared";
        let compared = 0;
        let toDecided = 0;
        let toReview = 0;
        let toAnotherValue = 0;
        let noCurrentAnswer = 0;
        let keptForPeople = 0;
        const now: Tally = { agreed: 0, disagreed: 0, unsure: 0 };
        const next: Tally = { agreed: 0, disagreed: 0, unsure: 0 };
        let nowRecords = 0;
        let reviewedRecords = 0;

        for (const [key, row] of answered) {
          const draftDecision = row.decisions[question.name];
          if (draftDecision === undefined) {
            throw new Error(`the preview answered record ${key} without "${question.name}"`);
          }
          const decidedBefore =
            prior === undefined ? undefined : decideAnswer(prior, current, answerNow(key, prior));
          const person = standing.get(key)?.get(question.name);

          if (sampleKeys.has(key)) {
            if (person !== undefined) {
              keptForPeople += 1;
            } else if (decidedBefore === undefined) {
              noCurrentAnswer += 1;
            } else {
              compared += 1;
              if (decidedBefore.kind === "needs_review" && draftDecision.kind === "decided") {
                toDecided += 1;
              } else if (
                decidedBefore.kind === "decided" &&
                draftDecision.kind === "needs_review"
              ) {
                toReview += 1;
              } else if (
                decidedBefore.kind === "decided" &&
                !sameValue(decidedBefore, draftDecision)
              ) {
                toAnotherValue += 1;
              }
            }
          }

          // Agreement is the model's decision against the person's value, never the row's value:
          // once a person decided, the row holds their value and would agree with itself.
          if (reviewedKeys.has(key) && person !== undefined) {
            reviewedRecords += 1;
            count(next, person, draftDecision);
            if (decidedBefore !== undefined) {
              nowRecords += 1;
              count(now, person, decidedBefore);
            }
          }
        }

        return {
          question: question.name,
          comparison,
          compared,
          changed: toDecided + toReview + toAnotherValue,
          toDecided,
          toReview,
          toAnotherValue,
          noCurrentAnswer,
          keptForPeople,
          agreement:
            reviewedRecords === 0
              ? { kind: "none", reason: "no-reviewed-records" }
              : {
                  kind: "measured",
                  records: reviewedRecords,
                  now: nowRecords === 0 ? null : sideOf(now),
                  draft: sideOf(next),
                },
        };
      });

      return {
        kind: "tested",
        sample: {
          records: sampleRows.length,
          asked: sampleRows.filter((row) => answered.has(row.key)).length,
        },
        reviewed: {
          records: reviewedKeys.size,
          asked: [...reviewedKeys].filter((key) => answered.has(key)).length,
        },
        skipped,
        removed: current.questions
          .map((question) => question.name)
          .filter((name) => !draftNames.has(name)),
        questions: rows,
        cost: result.cost,
        estimate,
      };
    }

    return { estimate, run };
  }

  return { testQuestionSet };
}
