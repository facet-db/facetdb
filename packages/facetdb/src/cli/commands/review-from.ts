import {
  type AnswerEntry,
  chosenWords,
  type HumanDecisionEntry,
  type HumanValue,
  type LogEntry,
  type OpenedCard,
  type Question,
  type QuestionSet,
  type RecordKey,
  type ReviewCard,
  type ReviewService,
  standingHuman,
} from "@facetdb/core";
import { z } from "zod";
import { keyWords } from "../engines.ts";
import { CliError, EXIT_USAGE } from "../program.ts";
import { readAnswer } from "./export.ts";
import type { QueueRead, ReviewDoor, ReviewInput, ReviewSource } from "./review.ts";
import { oneLine, whenUtc } from "./review-card.ts";

/**
 * `facetdb review --from decisions.jsonl`: decisions made elsewhere, applied under the account that
 * runs the command through the same review service the card and the studio use (open the card by
 * its key, decide, release), so the lock, the log, the hash check and the actions are theirs. It
 * decides nothing it has not shown: the file is read and judged first, the count and every refusal
 * by line number are printed, and only then, once confirmed (or with `--yes`), is a lock taken or a
 * row written. `--dry-run` stops after the plan; it opens no card and asks no password.
 *
 * Two kinds of line:
 *
 * - A minimal row, `{ "source", "key", "question", "value", "note"? }`: one instruction. It carries
 *   no state hash, so it promises only what the review service promises: the decision is written
 *   to the record as the card shows it when the card is opened, and not if the record changes
 *   between that read and the write. It cannot tell that the record changed after the person made
 *   the row; a person who wants that promise starts from an export row.
 * - A line of `facetdb export --format jsonl`, which carries the state hash the row was made at
 *   (`state_hash`) and names no source (`--source`, or the config's only source, says which). The
 *   export is the whole log, so most of its lines are not instructions: a line is read as an edit.
 *   An answer row (`kind: "answer"`) holds, per question, the words the thresholds made of the
 *   model's answer; they are recomputed from the log's own answer entry at the row's `state_hash`
 *   and that version's saved question set, with the export's own function (`readAnswer`). Words
 *   that match say what the log says and are left as they are; words that differ are an edit, and
 *   an edit is applied (the card is open at that state for this reviewer) or refused by line
 *   number with its reason (the record changed, another reviewer has it, the thresholds decided
 *   it, a person did): never left. Only the last answer row of a record counts, the ones before it
 *   being its history. A human row (`kind: "human"`) is compared with what stands: the same
 *   decision is "already decided", a different one is refused, and none is ever applied over a
 *   person's.
 *
 * A row whose state hash is not the card's is refused and applied to nothing. Any line refused or
 * not applied ends the run with exit 1 and `ok: false` (after every outcome is printed).
 */

/** A line longer than this is not a decision row; it is refused without being parsed. */
const MAX_LINE = 1_048_576;

/** Rows listed one by one in the plan before "and N more" (refusals are always all listed). */
const PLAN_LISTED = 20;

/** What a row looks like, said once under the refusals of a file that has malformed ones. */
const ROW_SHAPE =
  'a decision row is {"source":"listings","key":"r1","question":"scam","value":"yes"} with an optional "note", or a line of facetdb export --format jsonl';

const text = (what: string) =>
  z.string({ error: `${what} is missing or not text` }).min(1, { error: `${what} is empty` });

/**
 * A state hash as the store writes it and the export copies it: a SHA-256 in lowercase hex
 * (`stateHash` in core). Anything else is refused at the boundary, so what the file calls a hash
 * is never text a terminal could act on.
 */
const stateHashText = z
  .string({ error: "state_hash is missing or not text" })
  .regex(/^[0-9a-f]{64}$/, {
    error: "state_hash must be the 64 lowercase hex characters the export writes",
  });

const minimalRow = z.strictObject({
  source: text("source"),
  key: z
    .union([text("key"), z.number().int()], { error: "key is missing or not text" })
    .transform(String),
  question: text("question"),
  value: z.union([z.boolean(), text("value")], {
    error: "value must be yes, no, or the name of an option or level",
  }),
  note: z.string({ error: "note must be text" }).optional(),
});

const answerRow = z.looseObject({
  record_key: text("record_key"),
  state_hash: stateHashText,
  time: z.string().optional(),
  answers: z.record(
    z.string(),
    z.looseObject({
      decision: z.string({ error: "decision must be text" }),
      value: z.unknown().optional(),
      top: z.unknown().optional(),
    }),
    { error: "answers must be an object with a decision per question" },
  ),
});

const humanRow = z.looseObject({
  record_key: text("record_key"),
  state_hash: stateHashText,
  question: text("question"),
  value: text("value"),
  decision: z.string({ error: "decision must be text" }).optional(),
  note: z.string({ error: "note must be text" }).optional(),
});

/** One instruction the file gives, before it is judged against the store. */
type Row = {
  readonly line: number;
  readonly origin: "minimal" | "answer" | "human";
  /** The config's name for the source; undefined for an export row, which names none. */
  readonly source: string | undefined;
  /** The record key as the file writes it (a MongoDB key as the user writes it). */
  readonly keyText: string;
  readonly question: string;
  /** A boolean, or the words of the decision (yes, no, an option or level name). */
  readonly raw: boolean | string;
  readonly note: string | undefined;
  /** The state the row was made at: export rows only. */
  readonly stateHash: string | undefined;
  /**
   * An edited answer row only: whether the model's answer at that state left the question to a
   * person, which is what the thresholds made of it when the row was written.
   */
  readonly wasOpen: boolean | undefined;
};

/** A line of the export's answers, kept as it is until the log says what it should read. */
type AnswerLine = {
  readonly line: number;
  readonly keyText: string;
  readonly stateHash: string;
  readonly time: string | undefined;
  readonly answers: Readonly<
    Record<string, { readonly decision: string; readonly value?: unknown; readonly top?: unknown }>
  >;
};

type Refusal = { readonly line: number; readonly reason: string };

type Parsed = {
  /** Non-blank lines. */
  readonly lines: number;
  readonly rows: readonly Row[];
  /** The last answer line of each record, in file order. */
  readonly answerLines: readonly AnswerLine[];
  readonly malformed: readonly Refusal[];
};

/** File text in a message: one line, no control characters, never more than `max` characters. */
function shown(value: string, max = 60): string {
  const clean = oneLine(value);
  const characters = [...clean];
  return characters.length > max ? `${characters.slice(0, max - 3).join("")}...` : clean;
}

/** What a schema found wrong, in words that carry nothing the file wrote but cleaned, clipped text. */
function issuesOf(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.map(String).join(".");
      return shown(path === "" ? issue.message : `${path}: ${issue.message}`, 200);
    })
    .join("; ");
}

function usage(code: string, message: string, fix: string): CliError {
  return new CliError(code, message, fix, EXIT_USAGE);
}

function noteOf(note: string | undefined): string | undefined {
  const trimmed = note?.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Reads the file's lines into rows. A line of the export belongs to `exportedFrom`, the one source
 * the run covers; with none, a file that holds one stops here, asking for `--source`.
 */
async function parseRows(
  lines: AsyncIterable<string>,
  exportedFrom: string | undefined,
  sourceNames: string,
): Promise<Parsed> {
  const rows: Row[] = [];
  const malformed: Refusal[] = [];
  // The last answer row of each record: the rows before it are its history, not instructions.
  const latestAnswers = new Map<string, AnswerLine>();
  // Likewise the last human row of each question of a record (a mind changed is in the log twice).
  const latestHumans = new Map<string, Row | undefined>();
  let line = 0;
  let nonBlank = 0;
  for await (const raw of lines) {
    line += 1;
    if (raw.trim() === "") {
      continue;
    }
    nonBlank += 1;
    if (raw.length > MAX_LINE) {
      malformed.push({ line, reason: `the line is longer than ${MAX_LINE} characters` });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      malformed.push({ line, reason: "is not JSON" });
      continue;
    }
    if (typeof json !== "object" || json === null || Array.isArray(json)) {
      malformed.push({ line, reason: "is not a JSON object" });
      continue;
    }
    if (!("kind" in json)) {
      const parsed = minimalRow.safeParse(json);
      if (!parsed.success) {
        malformed.push({ line, reason: issuesOf(parsed.error) });
        continue;
      }
      rows.push({
        line,
        origin: "minimal",
        source: parsed.data.source,
        keyText: parsed.data.key,
        question: parsed.data.question,
        raw: parsed.data.value,
        note: noteOf(parsed.data.note),
        stateHash: undefined,
        wasOpen: undefined,
      });
      continue;
    }
    if (json.kind !== "answer" && json.kind !== "human") {
      malformed.push({
        line,
        reason: `kind is ${shown(JSON.stringify(json.kind))}, and an export row's kind is answer or human`,
      });
      continue;
    }
    if (exportedFrom === undefined) {
      throw usage(
        "review-from-source",
        `line ${line} is a row of facetdb export, which names no source, and the config has more than one: ${sourceNames}`,
        "pass --source <name> for the source the file was exported from",
      );
    }
    if (json.kind === "human") {
      const parsed = humanRow.safeParse(json);
      if (!parsed.success) {
        malformed.push({ line, reason: issuesOf(parsed.error) });
        continue;
      }
      // The export writes the words twice, as `value` and `decision`; one edited and not the
      // other is a line that says two things.
      if (parsed.data.decision !== undefined && parsed.data.decision !== parsed.data.value) {
        malformed.push({
          line,
          reason: `value is "${shown(parsed.data.value)}" and decision is "${shown(parsed.data.decision)}"; a person's decision is written in both, so edit both or neither`,
        });
        continue;
      }
      // The last row of a question is what the file says of it; a reviewer's undo reads
      // "withdrawn", a take-back, which leaves nothing to apply.
      latestHumans.set(
        JSON.stringify([parsed.data.record_key, parsed.data.question]),
        parsed.data.value === "withdrawn"
          ? undefined
          : {
              line,
              origin: "human",
              source: undefined,
              keyText: parsed.data.record_key,
              question: parsed.data.question,
              raw: parsed.data.value,
              note: noteOf(parsed.data.note),
              stateHash: parsed.data.state_hash,
              wasOpen: undefined,
            },
      );
      continue;
    }
    const parsed = answerRow.safeParse(json);
    if (!parsed.success) {
      malformed.push({ line, reason: issuesOf(parsed.error) });
      continue;
    }
    latestAnswers.set(parsed.data.record_key, {
      line,
      keyText: parsed.data.record_key,
      stateHash: parsed.data.state_hash,
      time: parsed.data.time,
      answers: parsed.data.answers,
    });
  }
  // File order.
  const exported: Row[] = [];
  for (const human of latestHumans.values()) {
    if (human !== undefined) {
      exported.push(human);
    }
  }
  const all = [...rows, ...exported].sort((a, b) => a.line - b.line);
  const answerLines = [...latestAnswers.values()].sort((a, b) => a.line - b.line);
  return { lines: nonBlank, rows: all, answerLines, malformed };
}

/** The value a decision's words name for this question, or why they name none. */
function fit(
  question: Question,
  raw: boolean | string,
): { readonly value: HumanValue } | { readonly reason: string } {
  if (question.type === "noul") {
    if (typeof raw === "boolean") {
      return { value: raw };
    }
    const words = raw.trim().toLowerCase();
    return words === "yes" || words === "no"
      ? { value: words === "yes" }
      : { reason: `"${shown(raw)}" is not an answer to "${question.name}", a yes-or-no question` };
  }
  const names =
    question.type === "choice"
      ? question.options.map((option) => option.name)
      : question.levels.map((level) => level.name);
  return typeof raw === "string" && names.includes(raw)
    ? { value: raw }
    : {
        reason: `"${shown(String(raw))}" is not ${question.type === "choice" ? "an option" : "a level"} of "${question.name}"; pick one of ${names.join(", ")}`,
      };
}

/** A row checked against the sources and question sets in force: what it would decide, and where. */
type Planned = {
  readonly row: Row;
  readonly view: ReviewSource;
  readonly key: RecordKey;
  readonly question: string;
  readonly value: HumanValue;
  /** The state of the record the decision is about; none for a record never answered. */
  readonly state: string | undefined;
};

type RowOutcome = "applied" | "would-apply" | "already-decided" | "refused" | "not-applied";

/** What happened to one instruction, as the document `--json` prints it. */
type RowResult = {
  readonly line: number;
  readonly source: string;
  readonly key: string;
  readonly question: string;
  readonly decision: string;
  readonly outcome: RowOutcome;
  readonly reason?: string;
  /** Who decided it, for an already decided row. */
  readonly by?: string;
  readonly actionFailures?: readonly string[];
};

function resultOf(
  planned: Planned,
  outcome: RowOutcome,
  more: { reason?: string; by?: string; actionFailures?: readonly string[] } = {},
): RowResult {
  // The key may be what the file wrote for a record that was never there: cleaned like everything
  // printed. The source and question are the config's and the question set's own; the reviewer
  // named by `by` is a name from the log.
  return {
    line: planned.row.line,
    source: planned.view.name,
    key: oneLine(keyWords(planned.view.keyText, planned.key)),
    question: planned.question,
    decision: chosenWords(planned.value),
    outcome,
    ...more,
    ...(more.by === undefined ? {} : { by: oneLine(more.by) }),
  };
}

/** `listings r1, scam: yes`: one decision, in words, for a line of output. */
function decisionWords(item: Planned): string {
  return `${oneLine(item.view.name)} ${shown(keyWords(item.view.keyText, item.key))}, ${oneLine(item.question)}: ${chosenWords(item.value)}`;
}

function changedWords(rowHash: string, cardHash: string): string {
  return `the record changed since this row was made (the row is for state ${rowHash.slice(0, 8)}, the record is now at ${cardHash.slice(0, 8)}), so the decision was not applied to its new state`;
}

const NO_CARD =
  "no card for this record is waiting for you: it is decided, it changed since the worker answered it, or another reviewer has it open";

const NEVER_ANSWERED =
  "the worker has never answered this record, so nothing is waiting for a person";

function latestAnswerHash(history: readonly LogEntry[]): string | undefined {
  return history.findLast((entry) => entry.kind === "answer")?.stateHash;
}

function whoWords(reviewer: string, by: string): string {
  return by === reviewer ? `you (${oneLine(by)})` : oneLine(by);
}

function decidedWords(reviewer: string, standing: HumanDecisionEntry): string {
  return `already decided as ${chosenWords(standing.value)} by ${whoWords(reviewer, standing.reviewer)} on ${whenUtc(standing.at)}`;
}

/** What judging a planned row came to against the queue and the log, before anything is locked. */
type Judged =
  | { readonly kind: "apply" }
  | { readonly kind: "decided"; readonly standing: HumanDecisionEntry }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "left" };

/** Everything the plan decided, nothing yet done. */
type Plan = {
  readonly toApply: Planned[];
  /** Plan-time outcomes: refused and already decided. */
  readonly results: RowResult[];
  /** Rows refused while being read, and why. */
  readonly malformed: Refusal[];
  /** The lines that came to something worth a word; the rest of the file is left as it is. */
  readonly listed: Set<number>;
};

/**
 * Each row against the sources and question sets in force, then against the queue and the log as
 * they are now: no lock, no write. An export row is the file's own account of the log, so what
 * does not fit the sets in force (an option a newer version renamed) is history and left as it
 * is, unless it is an answer row for a question that waits for a person right now: that one is an
 * edit gone wrong, and refused.
 */
async function planRows(
  input: ReviewInput,
  parsed: Parsed,
  read: QueueRead,
  exportedFrom: string | undefined,
): Promise<Plan> {
  const { config, sources } = input;
  const { options, deps } = input.context;
  const reviewer = read.reviewer;
  const byName = new Map(read.sources.map((view) => [view.name, view]));
  const plan: Plan = {
    toApply: [],
    results: [],
    malformed: [...parsed.malformed],
    listed: new Set(),
  };

  const waiting = new Map<string, Map<RecordKey, ReviewCard>>();
  const now = deps.clock.now();
  async function cardOf(view: ReviewSource, key: RecordKey): Promise<ReviewCard | undefined> {
    let cards = waiting.get(view.id);
    if (cards === undefined) {
      const listed = await read.queue.list({ source: view.id }, reviewer, now);
      cards = new Map(listed.map((card) => [card.key, card]));
      waiting.set(view.id, cards);
    }
    return cards.get(key);
  }
  // Only the last record's history is kept: rows of one record are mostly next to each other, and a
  // file of a hundred thousand records must not hold a hundred thousand histories.
  let lastHistory: { readonly id: string; readonly history: readonly LogEntry[] } | undefined;
  async function historyOf(view: ReviewSource, key: RecordKey): Promise<readonly LogEntry[]> {
    const id = JSON.stringify([view.id, key]);
    if (lastHistory?.id === id) {
      return lastHistory.history;
    }
    const log = read.logs.get(view.id);
    if (log === undefined) {
      throw new Error(`the review has no log for "${view.id}"`);
    }
    const history = await log.history(key);
    lastHistory = { id, history };
    return history;
  }

  /** The source and the store's key a line names, or the refusal that says it names none. */
  function recordOf(
    name: string | undefined,
    keyText: string,
    line: number,
  ): { readonly view: ReviewSource; readonly key: RecordKey } | undefined {
    const view = name === undefined ? undefined : byName.get(name);
    if (view === undefined) {
      const reason = !config.sources.some((source) => source.name === name)
        ? `the config has no source named "${shown(name ?? "")}"; its sources are: ${config.sources.map((source) => source.name).join(", ")}`
        : sources.some((source) => source.name === name)
          ? `${shown(name ?? "")} has never run a worker, so it has no cards to review`
          : `${shown(name ?? "")} is not the source --source ${options.source ?? ""} names`;
      plan.malformed.push({ line, reason });
      return undefined;
    }
    try {
      return { view, key: view.keyText === undefined ? keyText : view.keyText.fromText(keyText) };
    } catch {
      plan.malformed.push({
        line,
        reason: `"${shown(keyText)}" is not a key of ${oneLine(view.name)}${view.keyText === undefined ? "" : `: keys are written as ${view.keyText.form}`}`,
      });
      return undefined;
    }
  }

  const savedSets = new Map<string, QuestionSet | undefined>();
  async function setOf(view: ReviewSource, version: number): Promise<QuestionSet | undefined> {
    const id = JSON.stringify([view.id, version]);
    if (!savedSets.has(id)) {
      savedSets.set(id, (await read.versions(view.id, [version])).get(version));
    }
    return savedSets.get(id);
  }

  /**
   * The edits of the export's answer lines. What a line should read is in the log: the answer
   * entry at its `state_hash`, read with the export's own function under the question set of that
   * entry's version. Words that match are the log's own and say nothing new; words that differ are
   * an edit, to be applied or refused, never left. A field edited that is not the decision is
   * refused too, saying where a decision goes.
   */
  async function editsOf(): Promise<Row[]> {
    const edits: Row[] = [];
    for (const written of parsed.answerLines) {
      const at = recordOf(exportedFrom, written.keyText, written.line);
      if (at === undefined) {
        continue;
      }
      const history = await historyOf(at.view, at.key);
      const entries = history.filter(
        (entry): entry is AnswerEntry =>
          entry.kind === "answer" && entry.stateHash === written.stateHash,
      );
      const entry = entries.find((one) => one.at.toISOString() === written.time) ?? entries.at(-1);
      for (const [question, said] of Object.entries(written.answers)) {
        const refuse = (reason: string) =>
          plan.malformed.push({ line: written.line, reason: `${shown(question)}: ${reason}` });
        const decides = said.decision !== "needs review" && said.decision !== "";
        if (entry === undefined) {
          if (decides) {
            refuse(
              `the log has no answer to this record at state ${written.stateHash.slice(0, 8)}, so this decision cannot be compared with what the log says`,
            );
          }
          continue;
        }
        const set = await setOf(at.view, entry.version);
        if (set === undefined) {
          if (decides) {
            refuse(
              `the store does not keep question set version ${entry.version}, so this decision cannot be compared with what the log says`,
            );
          }
          continue;
        }
        const answer = entry.answers[question];
        const reading = answer === undefined ? undefined : readAnswer(set, question, answer);
        const words = reading?.decision ?? "";
        if (said.decision === words) {
          if (answer !== undefined && reading !== undefined) {
            const field =
              typeof said.value === "string" && said.value !== reading.value
                ? "value"
                : answer.type === "choice" &&
                    typeof said.top === "string" &&
                    said.top !== answer.top
                  ? "top"
                  : undefined;
            if (field !== undefined) {
              refuse(
                `the model's ${field} was changed, but that decides nothing: a decision is written in the decision field (it still says "${shown(said.decision)}")`,
              );
            }
          }
          continue;
        }
        if (!decides) {
          refuse(
            `the decision was changed to "${shown(said.decision)}", which decides nothing; write yes, no, or the name of an option or level`,
          );
          continue;
        }
        edits.push({
          line: written.line,
          origin: "answer",
          source: undefined,
          keyText: written.keyText,
          question,
          raw: said.decision,
          note: undefined,
          stateHash: written.stateHash,
          wasOpen: words === "needs review",
        });
      }
    }
    return edits;
  }

  // The rows that name a record this config's sources can decide, with the value they mean.
  const planned: Planned[] = [];
  const rows = [...parsed.rows, ...(await editsOf())].sort((a, b) => a.line - b.line);
  for (const row of rows) {
    const at = recordOf(row.source ?? exportedFrom, row.keyText, row.line);
    if (at === undefined) {
      continue;
    }
    const { view, key } = at;
    // What a human line of the export says is the log's history, which may name what a newer
    // version renamed; a line anyone could have edited (a minimal row, an edited answer) must fit.
    const isHistory = row.origin === "human";
    const question = view.questionSet.questions.find(
      (candidate) => candidate.name === row.question,
    );
    if (question === undefined) {
      if (!isHistory) {
        plan.malformed.push({
          line: row.line,
          reason: `${oneLine(view.name)} has no question named "${shown(row.question)}"; it asks ${view.questionSet.questions.map((q) => q.name).join(", ")}`,
        });
      }
      continue;
    }
    const fitted = fit(question, row.raw);
    if ("reason" in fitted) {
      if (!isHistory) {
        plan.malformed.push({ line: row.line, reason: fitted.reason });
      }
      continue;
    }
    // The state an instruction is about: an export row's own, and a minimal row's the latest the
    // worker answered, which is the state its card shows. Two rows are one instruction only there.
    const state =
      row.stateHash ??
      (row.origin === "minimal" ? latestAnswerHash(await historyOf(view, key)) : undefined);
    planned.push({ row, view, key, question: question.name, value: fitted.value, state });
  }

  /**
   * What a row comes to. A minimal row is an instruction. A human line of the export is the log's
   * account: compared with what stands, the same decision is "already decided", another is
   * refused, and none is applied. An edited answer line is an instruction about the state it was
   * made at: applied where the card is open at that state, otherwise refused with the reason.
   */
  async function judge(item: Planned): Promise<Judged> {
    const { row } = item;
    const card = await cardOf(item.view, item.key);
    const open = card?.openQuestions.includes(item.question) === true;
    if (row.origin === "answer" && card !== undefined && open) {
      return row.stateHash === card.stateHash
        ? { kind: "apply" }
        : { kind: "refused", reason: changedWords(row.stateHash ?? "", card.stateHash) };
    }
    const history = await historyOf(item.view, item.key);
    const answered = latestAnswerHash(history);
    const at = row.stateHash ?? answered;
    const standing = at === undefined ? undefined : standingHuman(history, item.question, at);
    if (standing !== undefined) {
      return standing.value === item.value
        ? { kind: "decided", standing }
        : {
            kind: "refused",
            reason: `"${item.question}" was ${decidedWords(reviewer, standing)}; a decision a person made is never overwritten`,
          };
    }
    if (row.origin === "human") {
      return { kind: "left" };
    }
    if (row.origin === "answer") {
      if (answered !== row.stateHash) {
        return {
          kind: "refused",
          reason: `the record changed since this row was made (the row is for state ${(row.stateHash ?? "").slice(0, 8)}, the log's latest answer is at ${(answered ?? "").slice(0, 8)}), so the decision was not applied to its new state`,
        };
      }
      // No person's decision stands at that state. What is true depends on where the card is.
      const decidedByThresholds = `"${item.question}" is not waiting for a person on this record: the thresholds decided it`;
      if (row.wasOpen !== true) {
        return { kind: "refused", reason: decidedByThresholds };
      }
      return {
        kind: "refused",
        reason:
          card === undefined
            ? `"${item.question}" is waiting for a person, but its card is not in your queue: another reviewer has it open, or it just left the queue`
            : `"${item.question}" was waiting for a person when this row was made, but it is not open on this record's card any more: the thresholds decide it now`,
      };
    }
    if (card === undefined) {
      return { kind: "refused", reason: answered === undefined ? NEVER_ANSWERED : NO_CARD };
    }
    return open
      ? { kind: "apply" }
      : {
          kind: "refused",
          reason: `"${item.question}" is not waiting for a person on this record: the thresholds decided it`,
        };
  }

  // One file may say the same thing twice; saying two things about one question is a mistake.
  // The same question at another state of the record is another instruction.
  const first = new Map<string, Planned>();
  for (const item of planned) {
    const id = JSON.stringify([item.view.id, item.key, item.question, item.state ?? ""]);
    const earlier = first.get(id);
    if (earlier === undefined) {
      first.set(id, item);
    } else if (earlier.value !== item.value) {
      plan.listed.add(item.row.line);
      plan.results.push(
        resultOf(item, "refused", {
          reason: `line ${earlier.row.line} decides this question as ${chosenWords(earlier.value)} and this line as ${chosenWords(item.value)}`,
        }),
      );
    }
    // The same decision again is the file repeating itself: nothing more to do for the second.
  }
  for (const item of first.values()) {
    const judged = await judge(item);
    if (judged.kind === "apply") {
      plan.listed.add(item.row.line);
      plan.toApply.push(item);
    } else if (judged.kind === "decided") {
      plan.listed.add(item.row.line);
      plan.results.push(
        resultOf(item, "already-decided", {
          reason: decidedWords(reviewer, judged.standing),
          by: judged.standing.reviewer,
        }),
      );
    } else if (judged.kind === "refused") {
      plan.listed.add(item.row.line);
      plan.results.push(resultOf(item, "refused", { reason: judged.reason }));
    }
  }
  plan.toApply.sort((a, b) => a.row.line - b.row.line);
  for (const refusal of plan.malformed) {
    plan.listed.add(refusal.line);
  }
  return plan;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The plan, in words: the count, the first decisions, every refusal by line number. */
function printPlan(
  print: (text: string) => void,
  file: string,
  reviewer: string,
  dryRun: boolean,
  parsed: Parsed,
  plan: Plan,
): void {
  print(`Read ${shown(file)}: ${plural(parsed.lines, "line", "lines")}.`);
  const { toApply } = plan;
  if (toApply.length > 0) {
    print(
      `${dryRun ? "Would apply" : "Will apply"} ${plural(toApply.length, "decision", "decisions")} as ${oneLine(reviewer)}:`,
    );
    for (const item of toApply.slice(0, PLAN_LISTED)) {
      print(`  line ${item.row.line}: ${decisionWords(item)}`);
    }
    if (toApply.length > PLAN_LISTED) {
      print(`  and ${toApply.length - PLAN_LISTED} more`);
    }
  } else {
    print("No decision to apply.");
  }
  const decided = plan.results.filter((result) => result.outcome === "already-decided");
  if (decided.length > 0) {
    print(
      `${plural(decided.length, "row is", "rows are")} already decided, so nothing is applied twice:`,
    );
    for (const result of decided.slice(0, PLAN_LISTED)) {
      print(
        `  line ${result.line}: ${oneLine(result.source)} ${shown(result.key)}, ${oneLine(result.question)}: ${result.reason ?? ""}`,
      );
    }
    if (decided.length > PLAN_LISTED) {
      print(`  and ${decided.length - PLAN_LISTED} more`);
    }
  }
  const refusals = [
    ...plan.malformed,
    ...plan.results
      .filter((result) => result.outcome === "refused")
      .map((result) => ({
        line: result.line,
        reason: `${oneLine(result.source)} ${shown(result.key)}, ${oneLine(result.question)}: ${result.reason ?? ""}`,
      })),
  ].sort((a, b) => a.line - b.line);
  if (refusals.length > 0) {
    print(`${plural(refusals.length, "row is", "rows are")} refused and skipped:`);
    for (const refusal of refusals) {
      print(`  line ${refusal.line}: ${refusal.reason}`);
    }
    if (plan.malformed.length > 0) {
      print(`  (${ROW_SHAPE})`);
    }
  }
  const left = parsed.lines - plan.listed.size;
  if (left > 0) {
    print(
      `${plural(left, "line is", "lines are")} left as ${left === 1 ? "it is" : "they are"}: the log's own account of answers and of decisions the thresholds or a person made, which an export holds and which are not edits.`,
    );
  }
}

/** The document `--json` prints, and the counts the last line of the run says. */
function documentOf(
  file: string,
  reviewer: string,
  dryRun: boolean,
  parsed: Parsed,
  plan: Plan,
  results: readonly RowResult[],
  stoppedBy?: string,
) {
  const ordered = [...results].sort((a, b) => a.line - b.line);
  const count = (outcome: RowOutcome) => ordered.filter((r) => r.outcome === outcome).length;
  return {
    // Lines left because they say what the log says do not count against a run.
    ok:
      stoppedBy === undefined &&
      count("refused") + count("not-applied") + plan.malformed.length === 0,
    from: file,
    reviewer,
    dryRun,
    counts: {
      lines: parsed.lines,
      applied: count("applied"),
      wouldApply: count("would-apply"),
      alreadyDecided: count("already-decided"),
      refused: count("refused") + plan.malformed.length,
      notApplied: count("not-applied"),
      left: parsed.lines - plan.listed.size,
    },
    malformed: plan.malformed,
    rows: ordered,
    ...(stoppedBy === undefined ? {} : { stoppedBy }),
  };
}

type Document = ReturnType<typeof documentOf>;

/**
 * The end of a run, once every outcome is printed: a run in which everything asked for was applied
 * (or already was) is the document; one with a line refused or not applied is a problem in the
 * file, exit 1 with the fix and the same document under `details`, so a script can tell.
 */
function endOf(document: Document): Document {
  if (document.ok) {
    return document;
  }
  const { counts } = document;
  const problems = counts.refused + counts.notApplied;
  throw new CliError(
    "rows-refused",
    `${plural(problems, "line was", "lines were")} refused or not applied (listed above by line number)${counts.applied === 0 ? "" : `; the other ${plural(counts.applied, "decision was", "decisions were")} applied`}`,
    "correct or remove those lines and run the same file again: rows already applied are reported as already decided and applied to nothing twice",
    1,
    document,
  );
}

export async function reviewFromFile(
  input: ReviewInput,
  door: ReviewDoor,
  file: string,
): Promise<unknown> {
  const { sources } = input;
  const { options, deps, print } = input.context;
  const found = await deps.workspace.peek(file);
  if (found.kind !== "file") {
    throw usage(
      "review-from-file",
      found.kind === "none"
        ? `there is no file at ${shown(file)}`
        : `${shown(file)} is not a regular file (a directory or a link), and is not read`,
      "pass --from the JSONL file of decisions; facetdb export --source <name> --format jsonl --out decisions.jsonl writes one to edit",
    );
  }
  // An export row names no source: it belongs to the one source this run covers.
  const exportedFrom = sources.length === 1 ? sources[0]?.name : undefined;
  const parsed = await parseRows(
    deps.workspace.lines(file),
    exportedFrom,
    sources.map((source) => source.name).join(", "),
  );

  // Deciding is signing: the password of --user is asked at a terminal, or read from a pipe. A dry
  // run decides nothing and asks none.
  if (options.user !== undefined && !options.dryRun && !(await deps.io.answerable())) {
    throw new CliError(
      "no-password",
      `--user ${options.user} needs the account's password, and there is no terminal to ask it on and nothing piped in to read it from`,
      "run facetdb review --from at a terminal, or pipe the password as the first line of standard input (printf '%s\\n' \"$PASSWORD\" | facetdb review --from <file> --user <name> --yes)",
    );
  }
  if (options.dryRun) {
    const read = await door.queue(input);
    try {
      const plan = await planRows(input, parsed, read, exportedFrom);
      printPlan(print, file, read.reviewer, true, parsed, plan);
      const results = [
        ...plan.results,
        ...plan.toApply.map((item) => resultOf(item, "would-apply")),
      ];
      print(
        `Dry run: nothing was locked, decided or logged${options.user === undefined ? "" : `, and no password was asked (${oneLine(read.reviewer)} is an account)`}.`,
      );
      return endOf(documentOf(file, read.reviewer, true, parsed, plan, results));
    } finally {
      await read.close();
    }
  }

  const review = await door.cards(input);
  try {
    const { reviewer, service } = review;
    const plan = await planRows(input, parsed, review, exportedFrom);
    printPlan(print, file, reviewer, false, parsed, plan);
    if (plan.toApply.length === 0) {
      print("Nothing was locked or written.");
      return endOf(documentOf(file, reviewer, false, parsed, plan, plan.results));
    }
    if (options.yes !== true) {
      if (!(await deps.io.answerable())) {
        throw new CliError(
          "not-confirmed",
          "the decisions above were not confirmed, so nothing was locked or written, and there is no terminal to ask on",
          "run the command at a terminal and type yes, or pass --yes once you have read the plan",
        );
      }
      const answer = await deps.io.prompt(
        `Apply ${plural(plan.toApply.length, "decision", "decisions")} as ${oneLine(reviewer)}? Type yes to continue: `,
      );
      if (answer.trim().toLowerCase() !== "yes") {
        throw new CliError(
          "not-confirmed",
          "the decisions were not confirmed, so nothing was locked or written",
          "run the command again and type yes, or pass --yes once you have read the plan",
        );
      }
    }
    return await applyRows(input, file, parsed, plan, reviewer, service);
  } finally {
    await review.close();
  }
}

/** The records of the plan, each with its decisions in file order, in the order of their first line. */
function recordsOf(toApply: readonly Planned[]): Planned[][] {
  const records = new Map<string, Planned[]>();
  for (const item of toApply) {
    const id = JSON.stringify([item.view.id, item.key]);
    records.set(id, [...(records.get(id) ?? []), item]);
  }
  return [...records.values()];
}

/**
 * One record at a time: open its card, decide each of its questions, let it go. The card is let go
 * of whatever became of the rows, and when an error or a stop signal ends the run part way.
 */
async function applyRows(
  input: ReviewInput,
  file: string,
  parsed: Parsed,
  plan: Plan,
  reviewer: string,
  service: ReviewService,
): Promise<unknown> {
  const { print, deps } = input.context;
  const stop = deps.stopSignal();
  const results: RowResult[] = [...plan.results];
  // In an object, not a local: the card handler below sets it and the end of the run reads it.
  const state = { stopped: false };

  const fail = (item: Planned, outcome: "refused" | "not-applied", reason: string): void => {
    plan.listed.add(item.row.line);
    results.push(resultOf(item, outcome, { reason }));
    print(`line ${item.row.line}: ${decisionWords(item)}: not applied: ${reason}.`);
  };

  async function decideCard(group: readonly Planned[], card: OpenedCard): Promise<void> {
    const ref = { source: card.source, key: card.key, stateHash: card.stateHash };
    // The questions still open, as the service reports them after each decision.
    let open: readonly string[] = card.open.map((entry) => entry.question.name);
    let gone: string | undefined;
    try {
      for (const item of group) {
        const { row } = item;
        if (gone !== undefined) {
          fail(item, "refused", gone);
        } else if (stop.aborted) {
          state.stopped = true;
          fail(item, "not-applied", "the command was asked to stop before this decision");
        } else if (row.stateHash !== undefined && row.stateHash !== card.stateHash) {
          fail(item, "refused", changedWords(row.stateHash, card.stateHash));
        } else if (!open.includes(item.question)) {
          const decided = card.decided.find((entry) => entry.question.name === item.question);
          fail(
            item,
            "refused",
            `"${item.question}" is not waiting for a person on this record any more${decided === undefined ? "" : `: it is decided as ${chosenWords(decided.value)}`}`,
          );
        } else {
          const result = await service.decide(reviewer, ref, item.question, item.value, row.note);
          switch (result.kind) {
            case "decided": {
              open = result.open;
              plan.listed.add(row.line);
              const failures = result.failures.map(
                (failure) =>
                  `The action "${oneLine(failure.action)}" failed: ${oneLine(failure.error instanceof Error ? failure.error.message : String(failure.error))}. The decision stands.`,
              );
              results.push(
                resultOf(
                  item,
                  "applied",
                  failures.length === 0 ? {} : { actionFailures: failures },
                ),
              );
              print(
                `line ${row.line}: ${decisionWords(item)}. Written to the record and logged for ${oneLine(reviewer)}.`,
              );
              for (const words of failures) {
                print(`line ${row.line}: ${words}`);
              }
              break;
            }
            case "stale":
              gone = result.reason;
              fail(item, "refused", result.reason);
              break;
            case "held":
              gone = `${oneLine(result.by)} has this card open until ${whenUtc(result.until)}`;
              fail(item, "refused", gone);
              break;
            case "lost":
              gone = "your lock on this card ended before the decision was saved";
              fail(item, "refused", gone);
              break;
            case "refused":
              fail(item, "refused", result.reason);
              break;
          }
        }
      }
    } finally {
      await service.release(reviewer, ref);
    }
  }

  try {
    for (const group of recordsOf(plan.toApply)) {
      const [head] = group;
      if (head === undefined) {
        continue;
      }
      if (stop.aborted) {
        state.stopped = true;
        for (const item of group) {
          fail(item, "not-applied", "the command was asked to stop before this record");
        }
        continue;
      }
      let opened: Awaited<ReturnType<ReviewService["openKey"]>>;
      try {
        opened = await service.openKey(reviewer, head.view.id, head.key);
      } catch (error) {
        // The lock may be taken before the card could be read: let go of it (the lease is the
        // record's, not the state's), and let the original error be the one that is reported.
        await service
          .release(reviewer, { source: head.view.id, key: head.key, stateHash: "" })
          .catch(() => undefined);
        throw error;
      }
      if (opened.kind === "opened") {
        await decideCard(group, opened.card);
        continue;
      }
      const reason =
        opened.kind === "held"
          ? `${oneLine(opened.by)} has this card open until ${whenUtc(opened.until)}`
          : NO_CARD;
      for (const item of group) {
        fail(item, "refused", reason);
      }
    }
  } catch (error) {
    // Each card was let go of where it was opened; what was applied stands, and says so.
    const why = oneLine(error instanceof Error ? error.message : String(error));
    const done = results.filter((result) => result.outcome === "applied").length;
    throw new CliError(
      "review-from-failed",
      `stopped by an error after ${plural(done, "decision was", "decisions were")} applied (those stand and are logged): ${why}`,
      "fix the cause and run the same file again: the rows already applied are reported as already decided and applied to nothing twice",
      1,
      documentOf(file, reviewer, false, parsed, plan, results, why),
    );
  }

  const document = documentOf(file, reviewer, false, parsed, plan, results);
  const { counts } = document;
  print(
    `Done: ${counts.applied} applied, ${counts.alreadyDecided} already decided, ${counts.refused + counts.notApplied} not applied, ${counts.left} left as they were. Every card opened was released.`,
  );
  if (state.stopped) {
    print(
      "Stopped early: run the same file again to carry on; the rows already applied are reported as already decided.",
    );
  }
  return endOf(document);
}
