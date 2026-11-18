import type {
  ActionDecisions,
  ActionRecord,
  Clock,
  Connector,
  DecisionLog,
  ReadRow,
  RecordDecision,
  RecordKey,
} from "../contracts/index.ts";
import {
  type AnswerEntry,
  applyHumanDecision,
  type DecisionWriter,
  decideRecord,
  type HumanEntry,
  type HumanValue,
  type LogEntry,
  standingHuman,
  WITHDRAWN,
} from "../log/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import type { RecordStatus, StateValue } from "../records/index.ts";
import type { Answer, Decision } from "../thresholds/index.ts";
import type { ActionStep } from "../worker/index.ts";
import {
  answerFigure,
  type LockResult,
  type ReviewFilter,
  type ReviewQueue,
  reviewEntryOf,
} from "./queue.ts";

/** A source's question set and the version in force: every human entry carries the version. */
export type ReviewQuestions = {
  readonly questionSet: QuestionSet;
  readonly version: number;
};

/**
 * What the review service is built from, every source keyed by its store id (`<project>:<name>`),
 * the id the queue's cards carry. A card whose source is not here is left alone by `open`.
 */
export type ReviewServiceDeps = {
  readonly queue: ReviewQueue;
  readonly log: ReadonlyMap<string, DecisionLog>;
  readonly connectors: ReadonlyMap<string, Connector>;
  /** Each source's configured actions, in order, as the worker runs them. */
  readonly actions: ReadonlyMap<string, readonly ActionStep[]>;
  readonly questionSets: ReadonlyMap<string, ReviewQuestions>;
  readonly clock: Clock;
};

/** A card as a viewer saw it: the decision is made against this state, and only this one. */
export type CardRef = {
  readonly source: string;
  readonly key: RecordKey;
  readonly stateHash: string;
};

/** A question still waiting for a person, with the model's answer behind it. */
export type OpenQuestion = {
  readonly question: Question;
  readonly answer: Answer;
  /** The model's figure the thresholds compared: a noul's yes probability, otherwise a confidence. */
  readonly figure: number;
};

/** A question already decided, by the thresholds or a person: shown greyed out with its value. */
export type DecidedQuestion = {
  readonly question: Question;
  readonly value: HumanValue;
};

/** An opened card, locked for the viewer until `lockedUntil`. */
export type OpenedCard = CardRef & {
  readonly state: Readonly<Record<string, StateValue>>;
  /** In question-set order. */
  readonly open: readonly OpenQuestion[];
  readonly decided: readonly DecidedQuestion[];
  /** When the record began waiting. */
  readonly since: Date;
  readonly lockedUntil: Date;
};

/** An action that failed after a decision; the decision stands, the others still ran. */
export type ReviewActionFailure = {
  readonly action: string;
  readonly error: unknown;
};

/**
 * What a decision did. `decided`: logged, written, the actions run (`failures` lists those that
 * failed), the card removed when the record is done or refreshed with what is still open. `stale`:
 * the record changed, was deleted or left review since the card was opened; nothing was decided and
 * the card left the queue (a record edited while it sits in the queue disappears from it and is
 * asked again); `reason` says which, in words. `held`: another reviewer holds the card. `lost`: the
 * viewer's lease is gone (released, skipped, or the card was replaced). `refused`: the question is
 * not open on this card or the value does not fit it, in words.
 */
export type DecideResult =
  | {
      readonly kind: "decided";
      readonly status: RecordStatus;
      /** The questions still open on the card; empty once the record is done. */
      readonly open: readonly string[];
      readonly failures: readonly ReviewActionFailure[];
    }
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "held"; readonly by: string; readonly until: Date }
  | { readonly kind: "lost" }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * What an undo did. `undone`: the withdrawal was logged and written, the actions ran again, and
 * the card is back in the queue, opened for the viewer (`card`, null when the thresholds now decide
 * the question or another reviewer holds it). `nothing`: the viewer has no decision of this
 * session left to undo (only the last one can be, once). `stale`: the decision no longer stands
 * (the record changed, or another decision replaced it), so there is nothing to take back; `reason`
 * says which, in words.
 */
export type UndoResult =
  | {
      readonly kind: "undone";
      readonly status: RecordStatus;
      readonly card: OpenedCard | null;
      readonly failures: readonly ReviewActionFailure[];
    }
  | { readonly kind: "nothing" }
  | { readonly kind: "stale"; readonly reason: string };

// The reasons a card or an undo no longer applies, in the words the screen and the terminal show.
const EDITED =
  "the record was edited while the card was open, so it left the queue to be asked again";
const REASKED =
  "the record is waiting for the model to answer it again, so its card left the queue";

export type ReviewService = {
  /** The next card for the viewer under `filter`, locked for them; null when none is left. */
  open(viewer: string, filter: ReviewFilter): Promise<OpenedCard | null>;
  /** Extends the viewer's lease on an open card (every 60 seconds). */
  renew(viewer: string, card: CardRef): Promise<LockResult>;
  /** Decides one question of the card the viewer holds. */
  decide(
    viewer: string,
    card: CardRef,
    question: string,
    value: HumanValue,
    note?: string,
  ): Promise<DecideResult>;
  /** The card goes behind the rest for this viewer, and their lease is released. */
  skip(viewer: string, card: CardRef): Promise<void>;
  /** Lets go of the viewer's lease, so another reviewer may open the card. */
  release(viewer: string, card: CardRef): Promise<void>;
  /** Takes back the viewer's last decision of this session. */
  undo(viewer: string): Promise<UndoResult>;
};

/** The viewer's last decision of this session: what an undo takes back. */
type LastDecision = {
  readonly card: CardRef;
  readonly question: string;
  readonly at: Date;
};

/** A card's record as the source holds it now, checked against the state the card shows. */
type Loaded = {
  readonly row: ReadRow;
  readonly status: RecordStatus;
  readonly answer: AnswerEntry;
  readonly history: readonly LogEntry[];
  /** The thresholds' decisions alone, what the people's standing decisions are laid over. */
  readonly byThresholds: Readonly<Record<string, Decision>>;
  /** The decisions with the people's standing decisions laid over them. */
  readonly decisions: Readonly<Record<string, Decision>>;
};

type Source = {
  readonly log: DecisionLog;
  readonly connector: Connector;
  readonly actions: readonly ActionStep[];
  readonly questions: ReviewQuestions;
};

/**
 * The review screen's and the terminal's one door to human decisions. Every decision and every undo
 * goes through `applyHumanDecision`, which logs first and writes second under the hash check; the
 * service never writes a decision around it. The undo memory is the viewer's last decision while
 * this service runs: a session's.
 */
export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const { queue, clock } = deps;
  const lastDecisions = new Map<string, LastDecision>();

  function sourceOf(source: string): Source | undefined {
    const log = deps.log.get(source);
    const connector = deps.connectors.get(source);
    const actions = deps.actions.get(source);
    const questions = deps.questionSets.get(source);
    if (
      log === undefined ||
      connector === undefined ||
      actions === undefined ||
      questions === undefined
    ) {
      return undefined;
    }
    return { log, connector, actions, questions };
  }

  function requireSource(source: string): Source {
    const found = sourceOf(source);
    if (found === undefined) {
      throw new Error(`"${source}" is not a source this review service was given`);
    }
    return found;
  }

  /**
   * The card's record, or the reason, in words, the card no longer shows it: deleted, edited since,
   * no longer in one of `statuses`, or without a logged answer at this state for every question of
   * the set (only the worker can answer those).
   */
  async function load(
    source: Source,
    card: CardRef,
    statuses: readonly RecordStatus[],
  ): Promise<Loaded | { readonly stale: string }> {
    const { questionSet } = source.questions;
    const { rows } = await source.connector.read([card.key]);
    const [row] = rows;
    if (row === undefined) {
      return { stale: "the record was deleted, so its card left the queue" };
    }
    if (row.hash !== card.stateHash) {
      return { stale: EDITED };
    }
    const current = (await source.connector.current([card.key])).get(card.key);
    if (current === undefined || !statuses.includes(current.status)) {
      return { stale: "the record is no longer waiting for review, so its card left the queue" };
    }
    const answer = await source.log.latestAnswer(card.key);
    if (answer === undefined || answer.stateHash !== card.stateHash) {
      return { stale: REASKED };
    }
    const history = await source.log.history(card.key);
    const byThresholds = decideRecord(questionSet, questionSet.thresholds, answer, []);
    const decisions = decideRecord(questionSet, questionSet.thresholds, answer, history);
    if (byThresholds === undefined || decisions === undefined) {
      return { stale: REASKED };
    }
    return { row, status: current.status, answer, history, byThresholds, decisions };
  }

  function cardOf(
    source: Source,
    card: CardRef,
    loaded: Pick<Loaded, "row" | "answer">,
    decisions: Readonly<Record<string, Decision>>,
    lockedUntil: Date,
  ): OpenedCard {
    const open: OpenQuestion[] = [];
    const decided: DecidedQuestion[] = [];
    for (const question of source.questions.questionSet.questions) {
      const decision = decisions[question.name];
      const answer = loaded.answer.answers[question.name];
      if (decision === undefined || answer === undefined) {
        throw new Error(`the question "${question.name}" has no decision for "${card.key}"`);
      }
      if (decision.kind === "decided") {
        decided.push({ question, value: decision.value });
      } else {
        open.push({ question, answer, figure: answerFigure(answer) });
      }
    }
    return {
      source: card.source,
      key: card.key,
      stateHash: card.stateHash,
      state: loaded.row.state,
      open,
      decided,
      since: loaded.answer.at,
      lockedUntil,
    };
  }

  /**
   * The queue follows the write that landed. A record still in review has its card refreshed with
   * what is open (its `since` and the viewer's lease kept); any other status takes the card out.
   */
  async function followQueue(
    card: CardRef,
    written: RecordDecision,
    answer: AnswerEntry,
  ): Promise<void> {
    if (written.status !== "needs_review") {
      await queue.remove(card.source, card.key);
      return;
    }
    await queue.upsert({
      source: card.source,
      ...reviewEntryOf({
        key: card.key,
        stateHash: card.stateHash,
        decisions: written.decisions,
        answers: answer.answers,
        since: answer.at,
      }),
    });
  }

  /** The actions run again after a person's decision. */
  async function runActions(
    source: Source,
    row: ReadRow,
    status: RecordStatus,
    decisions: ActionDecisions,
    decidedAt: Date,
  ): Promise<ReviewActionFailure[]> {
    const record: ActionRecord = { key: row.key, state: row.state, status, decidedAt };
    const failures: ReviewActionFailure[] = [];
    // One action failing does not keep the others from running.
    for (const step of source.actions) {
      try {
        await step.run(record, decisions);
      } catch (error) {
        failures.push({ action: step.name, error });
      }
    }
    return failures;
  }

  /**
   * The one door: `applyHumanDecision` logs `entry`, then writes every standing decision under the
   * hash check. Returns what landed, or undefined when the record changed before the write.
   */
  async function apply(
    source: Source,
    entry: HumanEntry,
    loaded: Loaded,
  ): Promise<RecordDecision | undefined> {
    const writes: RecordDecision[] = [];
    const write: DecisionWriter = (key, decision, expectedHash) => {
      writes.push(decision);
      return source.connector.write(key, decision, expectedHash);
    };
    const result = await applyHumanDecision(
      entry,
      {
        key: entry.key,
        hash: loaded.row.hash,
        status: loaded.status,
        questions: source.questions.questionSet.questions,
        decisions: loaded.byThresholds,
        answers: loaded.answer.answers,
      },
      source.log,
      write,
    );
    // The last write is the one that landed: `applyHumanDecision` writes again only after a landed one.
    return result.written ? writes.at(-1) : undefined;
  }

  async function open(viewer: string, filter: ReviewFilter): Promise<OpenedCard | null> {
    const nowMs = clock.now();
    for (const listed of await queue.list(filter, viewer, nowMs)) {
      const source = sourceOf(listed.source);
      if (source === undefined) {
        continue;
      }
      const lock = await queue.lock(listed.source, listed.key, viewer, nowMs);
      if (lock.kind !== "locked") {
        // Another reviewer took it between the list and the lock, or it left the queue.
        continue;
      }
      const card: CardRef = {
        source: listed.source,
        key: listed.key,
        stateHash: listed.stateHash,
      };
      const loaded = await load(source, card, ["needs_review"]);
      if ("stale" in loaded || !hasOpenQuestion(loaded.decisions)) {
        // A record edited while it sits in the queue leaves it; the change capture has queued it,
        // and the worker asks it again.
        await queue.withdraw(card.source, card.key, card.stateHash);
        continue;
      }
      return cardOf(source, card, loaded, loaded.decisions, lock.until);
    }
    return null;
  }

  function renew(viewer: string, card: CardRef): Promise<LockResult> {
    return queue.renew(card.source, card.key, viewer, clock.now());
  }

  async function decide(
    viewer: string,
    card: CardRef,
    question: string,
    value: HumanValue,
    note?: string,
  ): Promise<DecideResult> {
    const source = requireSource(card.source);
    const { questionSet, version } = source.questions;
    const asked = questionSet.questions.find((candidate) => candidate.name === question);
    if (asked === undefined) {
      return { kind: "refused", reason: `"${question}" is not a question of this source` };
    }
    const misfit = valueMisfit(asked, value);
    if (misfit !== undefined) {
      return { kind: "refused", reason: misfit };
    }
    const lease = await queue.renew(card.source, card.key, viewer, clock.now());
    if (lease.kind === "held") {
      return { kind: "held", by: lease.by, until: lease.until };
    }
    if (lease.kind === "lost") {
      return { kind: "lost" };
    }
    const loaded =
      lease.kind === "gone"
        ? { stale: "the card left the queue: the record was decided or changed meanwhile" }
        : await load(source, card, ["needs_review"]);
    if ("stale" in loaded) {
      await queue.withdraw(card.source, card.key, card.stateHash);
      return { kind: "stale", reason: loaded.stale };
    }
    if (loaded.decisions[question]?.kind !== "needs_review") {
      return { kind: "refused", reason: `"${question}" is already decided on this card` };
    }
    const entry: HumanEntry = {
      kind: "human",
      key: card.key,
      question,
      value,
      reviewer: viewer,
      ...(note === undefined ? {} : { note }),
      stateHash: card.stateHash,
      version,
      at: new Date(clock.now()),
    };
    const written = await apply(source, entry, loaded);
    if (written === undefined) {
      // Edited between the read and the write: the decision is logged at a state it no longer has,
      // so it does not stand, and the card leaves the queue.
      await queue.withdraw(card.source, card.key, card.stateHash);
      return { kind: "stale", reason: EDITED };
    }
    lastDecisions.set(viewer, { card, question, at: entry.at });
    await followQueue(card, written, loaded.answer);
    const failures = await runActions(
      source,
      loaded.row,
      written.status,
      written.decisions,
      entry.at,
    );
    return {
      kind: "decided",
      status: written.status,
      open: openQuestions(questionSet, written.decisions),
      failures,
    };
  }

  async function skip(viewer: string, card: CardRef): Promise<void> {
    await queue.skip(card.source, card.key, viewer);
  }

  async function release(viewer: string, card: CardRef): Promise<void> {
    await queue.release(card.source, card.key, viewer);
  }

  async function undo(viewer: string): Promise<UndoResult> {
    const last = lastDecisions.get(viewer);
    if (last === undefined) {
      return { kind: "nothing" };
    }
    const { card, question } = last;
    const source = requireSource(card.source);
    // The decision may have closed the record, so a done record is taken back too.
    const loaded = await load(source, card, ["needs_review", "done"]);
    if ("stale" in loaded) {
      lastDecisions.delete(viewer);
      return { kind: "stale", reason: loaded.stale };
    }
    const standing = standingHuman(loaded.history, question, card.stateHash);
    if (standing?.reviewer !== viewer || standing.at.getTime() !== last.at.getTime()) {
      lastDecisions.delete(viewer);
      return {
        kind: "stale",
        reason: "another decision on this question replaced yours, so there is nothing to undo",
      };
    }
    const withdrawal: HumanEntry = {
      kind: "human",
      key: card.key,
      question,
      value: WITHDRAWN,
      reviewer: viewer,
      stateHash: card.stateHash,
      version: source.questions.version,
      at: new Date(clock.now()),
    };
    const written = await apply(source, withdrawal, loaded);
    // Only the last decision of the session can be undone, and only once.
    lastDecisions.delete(viewer);
    if (written === undefined) {
      return { kind: "stale", reason: EDITED };
    }
    await followQueue(card, written, loaded.answer);
    let reopened: OpenedCard | null = null;
    if (written.status === "needs_review") {
      const lock = await queue.lock(card.source, card.key, viewer, clock.now());
      if (lock.kind === "locked") {
        reopened = cardOf(source, card, loaded, written.decisions, lock.until);
      }
    }
    const failures = await runActions(
      source,
      loaded.row,
      written.status,
      written.decisions,
      withdrawal.at,
    );
    return { kind: "undone", status: written.status, card: reopened, failures };
  }

  return { open, renew, decide, skip, release, undo };
}

function hasOpenQuestion(decisions: Readonly<Record<string, Decision>>): boolean {
  return Object.values(decisions).some((decision) => decision.kind === "needs_review");
}

function openQuestions(
  questionSet: QuestionSet,
  decisions: Readonly<Record<string, Decision>>,
): string[] {
  return questionSet.questions
    .filter((question) => decisions[question.name]?.kind === "needs_review")
    .map((question) => question.name);
}

/**
 * Why a value cannot decide the question, in words, or undefined when it fits: yes or no for a
 * noul, one of the options of a choice, one of the levels of a score.
 */
function valueMisfit(question: Question, value: HumanValue): string | undefined {
  switch (question.type) {
    case "noul":
      return typeof value === "boolean"
        ? undefined
        : `"${question.name}" is a yes-or-no question; answer yes or no`;
    case "choice": {
      const names = question.options.map((option) => option.name);
      return typeof value === "string" && names.includes(value)
        ? undefined
        : `"${String(value)}" is not an option of "${question.name}"; pick one of ${names.join(", ")}`;
    }
    case "score": {
      const names = question.levels.map((level) => level.name);
      return typeof value === "string" && names.includes(value)
        ? undefined
        : `"${String(value)}" is not a level of "${question.name}"; pick one of ${names.join(", ")}`;
    }
  }
}
