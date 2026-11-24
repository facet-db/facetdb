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
  answeredSet,
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
import { followReview } from "./follow.ts";
import {
  answerFigure,
  type LockResult,
  type ReviewFilter,
  type ReviewQueue,
  reviewsOf,
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
 * session left to undo (only the last one can be, once). `stale`: the decision named is not the
 * viewer's last one, or it no longer stands (the record changed, or another decision replaced it),
 * so there is nothing to take back; `reason` says which, in words. `held`: another reviewer holds
 * the card; nothing was written and the decision can still be undone once they let it go.
 */
export type UndoResult =
  | {
      readonly kind: "undone";
      readonly status: RecordStatus;
      readonly card: OpenedCard | null;
      readonly failures: readonly ReviewActionFailure[];
    }
  | { readonly kind: "nothing" }
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "held"; readonly by: string; readonly until: Date };

// The reasons a card or an undo no longer applies, in the words the screen and the terminal show.
const EDITED =
  "the record was edited while the card was open, so it left the queue to be asked again";
const REASKED =
  "the record is waiting for the model to answer it again, so its card left the queue";
const NOT_LAST =
  "that decision is not your last one, and only your last decision can be taken back";

/**
 * What opening a named card did. `opened`: locked for the viewer. `held`: another reviewer's lease
 * has not expired. `gone`: no card of that record waits in the queue (it was decided, or it
 * changed, which withdraws the card).
 */
export type OpenKeyResult =
  | { readonly kind: "opened"; readonly card: OpenedCard }
  | { readonly kind: "held"; readonly by: string; readonly until: Date }
  | { readonly kind: "gone" };

export type ReviewService = {
  /** The next card for the viewer under `filter`, locked for them; null when none is left. */
  open(viewer: string, filter: ReviewFilter): Promise<OpenedCard | null>;
  /** The card of one named record, locked for the viewer (`POST /v1/review/open` with a key). */
  openKey(viewer: string, source: string, key: RecordKey): Promise<OpenKeyResult>;
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
  /**
   * Takes back the viewer's last decision of this session, named by the card and the question it
   * decided: refused unless they are that decision, and while another reviewer holds the card.
   */
  undo(viewer: string, card: CardRef, question: string): Promise<UndoResult>;
  /** The viewer signed out: their last decision can no longer be undone. */
  forget(viewer: string): void;
};

/** The viewer's last decision of this session: what an undo takes back. */
type LastDecision = {
  readonly card: CardRef;
  readonly question: string;
  readonly at: Date;
};

/** What a card is judged on: one logged answer at its state, and what the thresholds make of it. */
type Judged = {
  readonly answer: AnswerEntry;
  /**
   * The questions the card is judged on, in question-set order: those of the set in force that the
   * answer has (all of them unless a question was added after the answer was logged).
   */
  readonly questions: readonly Question[];
  /** The thresholds' decisions alone, what the people's standing decisions are laid over. */
  readonly byThresholds: Readonly<Record<string, Decision>>;
};

/** A card's record as the source holds it now, checked against the state the card shows. */
type Loaded = Judged & {
  readonly row: ReadRow;
  readonly status: RecordStatus;
  /** The history the latest answer, `answer`, was read from. */
  readonly history: readonly LogEntry[];
  /** The decisions with the people's standing decisions laid over them. */
  readonly decisions: Readonly<Record<string, Decision>>;
};

/**
 * What a person's entry landed as: the last write's decision, and what it was judged on, the card's
 * answer or one logged at its state while the entry was written.
 */
type Applied = Judged & { readonly decision: RecordDecision };

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
 * this service runs: a session's. It is kept by the viewer's name, which is all a request carries
 * (the studio's cookie is the same in every tab, and the OS user has none), so an undo names the
 * decision it takes back, as the page or terminal that made it remembers it, and is refused for any
 * other.
 */
export function createReviewService(deps: ReviewServiceDeps): ReviewService {
  const { queue, clock } = deps;
  const lastDecisions = new Map<string, LastDecision>();
  /** Each viewer's undo in flight: a second one waits for it, so a decision is withdrawn once. */
  const undoing = new Map<string, Promise<unknown>>();

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
   *
   * Three reads of one key, none depending on another, so they go out together (on a far database
   * each round trip is the Review page's whole budget); the latest answer is the history's last
   * answer entry, so no fourth read. The checks still run in their order.
   */
  async function load(
    source: Source,
    card: CardRef,
    statuses: readonly RecordStatus[],
  ): Promise<Loaded | { readonly stale: string }> {
    const { questionSet } = source.questions;
    const [{ rows }, currents, history] = await Promise.all([
      source.connector.read([card.key]),
      source.connector.current([card.key]),
      source.log.history(card.key),
    ]);
    const [row] = rows;
    if (row === undefined) {
      return { stale: "the record was deleted, so its card left the queue" };
    }
    if (row.hash !== card.stateHash) {
      return { stale: EDITED };
    }
    const current = currents.get(card.key);
    if (current === undefined || !statuses.includes(current.status)) {
      return { stale: "the record is no longer waiting for review, so its card left the queue" };
    }
    const answer = history.findLast(isAnswerEntry);
    if (answer === undefined || answer.stateHash !== card.stateHash) {
      return { stale: REASKED };
    }
    const judged = judge(questionSet, answer);
    if (judged === undefined) {
      return { stale: REASKED };
    }
    const decisions = decideRecord(
      { ...questionSet, questions: judged.questions },
      questionSet.thresholds,
      answer,
      history,
    );
    if (decisions === undefined) {
      throw new Error(`the answer for "${card.key}" lacks a question it was narrowed to`);
    }
    return { row, status: current.status, history, ...judged, decisions };
  }

  /**
   * What a card is judged on from one logged answer: the questions of the set in force that the
   * answer has, and their thresholds' decisions alone. An answer that predates a question added
   * since has no word on it: that is no staleness (the backfill of the added question answers it,
   * and the card follows), and a question the set no longer has is not among them. Undefined when
   * the answer has none of the set's questions: nothing on the card can be judged on it.
   */
  function judge(questionSet: QuestionSet, answer: AnswerEntry): Judged | undefined {
    const answered = answeredSet(questionSet, answer);
    if (answered.questions.length === 0) {
      return undefined;
    }
    const byThresholds = decideRecord(answered, answered.thresholds, answer, []);
    if (byThresholds === undefined) {
      throw new Error(`the answer for "${answer.key}" lacks a question it was narrowed to`);
    }
    return { answer, questions: answered.questions, byThresholds };
  }

  /** The history's last model call: what `DecisionLog.latestAnswer` reads, without the read. */
  function isAnswerEntry(entry: LogEntry): entry is AnswerEntry {
    return entry.kind === "answer";
  }

  function cardOf(
    card: CardRef,
    loaded: Pick<Loaded, "row" | "answer" | "questions">,
    decisions: Readonly<Record<string, Decision>>,
    lockedUntil: Date,
  ): OpenedCard {
    const open: OpenQuestion[] = [];
    const decided: DecidedQuestion[] = [];
    for (const question of loaded.questions) {
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
   * The queue follows the write that landed, through the one `followReview` the worker and the
   * backfill share. A record still in review has its card refreshed with what is open (its `since`
   * and the viewer's lease kept); any other status takes the card out.
   */
  function followQueue(card: CardRef, written: RecordDecision, answer: AnswerEntry): Promise<void> {
    return followReview(reviewsOf(queue, card.source), card, written, answer);
  }

  /** The actions run again after a person's decision. */
  async function runActions(
    source: Source,
    row: ReadRow,
    status: RecordStatus,
    decisions: ActionDecisions,
    decidedAt: Date,
  ): Promise<ReviewActionFailure[]> {
    const record: ActionRecord = {
      key: row.key,
      state: row.state,
      status,
      stateHash: row.hash,
      decidedAt,
    };
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
   * hash check. Returns what landed last, or undefined when the record changed before the write.
   *
   * When a model answer was logged at the card's state after the card was loaded (a backfill's
   * merge of an added question), the decision is written again judged on that answer: its questions
   * and its thresholds' decisions, every person's standing decision laid over them, done only when
   * every one of its questions is decided. The queue follows each write that lands, before the read
   * after it, with the answer that write was judged on (as the worker's writer does): a follow
   * after the loop would take out the card a newer answer's own write put back after that read.
   * `landed` runs once, at the first write that lands, before its follow.
   */
  async function apply(
    source: Source,
    card: CardRef,
    entry: HumanEntry,
    loaded: Loaded,
    landed: () => void = () => undefined,
  ): Promise<Applied | undefined> {
    let judged: Judged = loaded;
    let last: Applied | undefined;
    const write: DecisionWriter = async (key, decision, expectedHash) => {
      const result = await source.connector.write(key, decision, expectedHash);
      if (result.written) {
        if (last === undefined) {
          landed();
        }
        last = { ...judged, decision };
        await followQueue(card, decision, judged.answer);
      }
      return result;
    };
    const result = await applyHumanDecision(
      entry,
      {
        key: entry.key,
        hash: loaded.row.hash,
        status: loaded.status,
        // The questions the answer has: a decision on a card never speaks for one that has no answer yet.
        questions: loaded.questions,
        decisions: loaded.byThresholds,
        answers: loaded.answer.answers,
      },
      source.log,
      write,
      // The history just loaded stands in for the first re-read: the read after the write still
      // catches a person's decision, or a model answer at this state, logged meanwhile.
      loaded.history,
      (answer) => {
        // Judged with this service's own question set, as `load` judges the card: a review session
        // started before the version that added a question still leaves that question out, even
        // when the newer answer has it.
        const next = judge(source.questions.questionSet, answer);
        if (next === undefined) {
          return undefined;
        }
        // `applyHumanDecision` writes from what this returns next, so the follow names its answer.
        judged = next;
        return { questions: next.questions, decisions: next.byThresholds, answers: answer.answers };
      },
    );
    // `applyHumanDecision` writes again only after a landed write, so a written result's last
    // write is the one that landed last.
    return result.written ? last : undefined;
  }

  /**
   * The card under the lock the viewer just took, or undefined when it is stale and was withdrawn.
   * A record edited while it sits in the queue leaves it; the change capture has queued it, and the
   * worker asks it again.
   */
  async function openLocked(
    source: Source,
    card: CardRef,
    lockedUntil: Date,
  ): Promise<OpenedCard | undefined> {
    const loaded = await load(source, card, ["needs_review"]);
    if ("stale" in loaded || !hasOpenQuestion(loaded.decisions)) {
      await queue.withdraw(card.source, card.key, card.stateHash);
      return undefined;
    }
    return cardOf(card, loaded, loaded.decisions, lockedUntil);
  }

  /**
   * How many cards an open reads at a time: eight first, since the first is nearly always the one
   * opened and the rest cover a card another reviewer takes between the listing and the lock, or
   * one gone stale; then wider, and last the whole queue as before, so cards that are never
   * consumed (a source the worker no longer runs, whose cards stay until purge) cannot hold the
   * front of every listing. Never the whole queue first (1,759 cards with their figures took 3.8 s
   * to list before the first was even locked).
   */
  const OPEN_BATCHES: readonly (number | undefined)[] = [8, 64, 512, undefined];

  async function open(viewer: string, filter: ReviewFilter): Promise<OpenedCard | null> {
    const nowMs = clock.now();
    /** Cards met and passed over (no source here, or taken meanwhile): not locked again. */
    const passed = new Set<string>();
    for (const limit of OPEN_BATCHES) {
      const listed = await queue.list(
        limit === undefined ? filter : { ...filter, limit },
        viewer,
        nowMs,
      );
      for (const candidate of listed) {
        const id = `${candidate.source}\u0000${candidate.key}`;
        if (passed.has(id)) {
          continue;
        }
        const source = sourceOf(candidate.source);
        if (source === undefined) {
          passed.add(id);
          continue;
        }
        const lock = await queue.lock(candidate.source, candidate.key, viewer, nowMs);
        if (lock.kind !== "locked") {
          // Another reviewer took it between the list and the lock, or it left the queue.
          passed.add(id);
          continue;
        }
        const card = await openLocked(
          source,
          { source: candidate.source, key: candidate.key, stateHash: candidate.stateHash },
          lock.until,
        );
        if (card !== undefined) {
          return card;
        }
      }
      // A short batch was the queue's end; a full one, consumed or passed over, has more behind it.
      if (limit === undefined || listed.length < limit) {
        return null;
      }
    }
    return null;
  }

  async function openKey(viewer: string, sourceId: string, key: RecordKey): Promise<OpenKeyResult> {
    const source = requireSource(sourceId);
    const nowMs = clock.now();
    const lock = await queue.lock(sourceId, key, viewer, nowMs);
    if (lock.kind === "held") {
      return lock;
    }
    if (lock.kind !== "locked") {
      return { kind: "gone" };
    }
    // The lease is the viewer's now, so the card is in their listing, and it names the state hash.
    // But the worker may have re-answered the record since the lock, and a card at a new hash
    // starts with no lease (the queue's rule): unless the listed card carries the lease just taken,
    // it is not the viewer's to see, and no state comes back.
    const [listed] = await queue.list({ source: sourceId, key, limit: 1 }, viewer, nowMs);
    if (
      listed === undefined ||
      listed.lock?.by !== viewer ||
      listed.lock.until.getTime() !== lock.until.getTime()
    ) {
      return { kind: "gone" };
    }
    const card = await openLocked(
      source,
      { source: sourceId, key, stateHash: listed.stateHash },
      lock.until,
    );
    return card === undefined ? { kind: "gone" } : { kind: "opened", card };
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
    // The lease and the card's reads go out together (reads only: a lease not the viewer's
    // decides first, and what was read is then dropped, a failed read included), one round trip
    // instead of two.
    const [leased, read] = await Promise.allSettled([
      queue.renew(card.source, card.key, viewer, clock.now()),
      load(source, card, ["needs_review"]),
    ]);
    if (leased.status === "rejected") {
      throw leased.reason;
    }
    const lease = leased.value;
    if (lease.kind === "held") {
      return { kind: "held", by: lease.by, until: lease.until };
    }
    if (lease.kind === "lost") {
      return { kind: "lost" };
    }
    if (lease.kind !== "gone" && read.status === "rejected") {
      throw read.reason;
    }
    const loaded =
      lease.kind === "gone" || read.status === "rejected"
        ? { stale: "the card left the queue: the record was decided or changed meanwhile" }
        : read.value;
    if ("stale" in loaded) {
      await queue.withdraw(card.source, card.key, card.stateHash);
      return { kind: "stale", reason: loaded.stale };
    }
    const standing = loaded.decisions[question];
    if (standing === undefined) {
      return {
        kind: "refused",
        reason: `"${question}" has no answer from the model on this card yet`,
      };
    }
    if (standing.kind !== "needs_review") {
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
    // The undo memory is set once the decision is in the row, before the queue follows it.
    const applied = await apply(source, card, entry, loaded, () => {
      lastDecisions.set(viewer, { card, question, at: entry.at });
    });
    if (applied === undefined) {
      // Edited between the read and the write: the decision is logged at a state it no longer has,
      // so it does not stand, and the card leaves the queue.
      await queue.withdraw(card.source, card.key, card.stateHash);
      return { kind: "stale", reason: EDITED };
    }
    const written = applied.decision;
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

  /**
   * One viewer's undos run one after another: two tabs sending the same last decision at once would
   * otherwise both pass the memory and the log's check before either withdrawal landed, and log it
   * twice. The second finds the memory spent.
   */
  function undo(viewer: string, card: CardRef, question: string): Promise<UndoResult> {
    const before = undoing.get(viewer) ?? Promise.resolve();
    const run = before.then(() => undoLast(viewer, card, question));
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    undoing.set(viewer, settled);
    void settled.then(() => {
      if (undoing.get(viewer) === settled) {
        undoing.delete(viewer);
      }
    });
    return run;
  }

  function forget(viewer: string): void {
    lastDecisions.delete(viewer);
  }

  /**
   * The card's lease for an undo, taken before anything is written: the viewer's own, renewed; or
   * taken now when theirs ended and nobody else holds the card (`taken`, so an undo that writes
   * nothing lets go of it again); or none when the card left the queue (the decision closed the
   * record), which the withdrawal brings back. `held` while another reviewer's lease is live.
   */
  async function leaseForUndo(
    viewer: string,
    card: CardRef,
  ): Promise<
    | { readonly kind: "held"; readonly by: string; readonly until: Date }
    | { readonly kind: "leased"; readonly taken: boolean }
  > {
    const nowMs = clock.now();
    const renewed = await queue.renew(card.source, card.key, viewer, nowMs);
    if (renewed.kind === "held") {
      return renewed;
    }
    if (renewed.kind !== "lost") {
      return { kind: "leased", taken: false };
    }
    const locked = await queue.lock(card.source, card.key, viewer, nowMs);
    if (locked.kind === "held") {
      return locked;
    }
    return { kind: "leased", taken: locked.kind === "locked" };
  }

  async function undoLast(viewer: string, card: CardRef, question: string): Promise<UndoResult> {
    const last = lastDecisions.get(viewer);
    if (last === undefined) {
      return { kind: "nothing" };
    }
    if (
      last.card.source !== card.source ||
      last.card.key !== card.key ||
      last.card.stateHash !== card.stateHash ||
      last.question !== question
    ) {
      // Nothing is written and the memory stays: the page or terminal that made it may still ask.
      return { kind: "stale", reason: NOT_LAST };
    }
    /** Spends the memory, unless a newer decision of the viewer replaced it meanwhile. */
    const spend = () => {
      if (lastDecisions.get(viewer) === last) {
        lastDecisions.delete(viewer);
      }
    };
    const source = requireSource(card.source);
    const lease = await leaseForUndo(viewer, card);
    if (lease.kind === "held") {
      // Nothing written, and the memory kept: the undo can be asked again once their hold ends.
      return lease;
    }
    /** An undo that writes nothing gives back a lease it took itself; the viewer's own stays. */
    const letGo = async () => {
      if (lease.taken) {
        await queue.release(card.source, card.key, viewer);
      }
    };
    // The decision may have closed the record, so a done record is taken back too.
    const loaded = await load(source, card, ["needs_review", "done"]);
    if ("stale" in loaded) {
      spend();
      await letGo();
      return { kind: "stale", reason: loaded.stale };
    }
    const standing = standingHuman(loaded.history, question, card.stateHash);
    if (standing?.reviewer !== viewer || standing.at.getTime() !== last.at.getTime()) {
      spend();
      await letGo();
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
    // Only the last decision of the session can be undone, and only once: spent as the withdrawal
    // lands, before the queue follows it, and in any case once the door returns.
    const applied = await apply(source, card, withdrawal, loaded, spend);
    spend();
    if (applied === undefined) {
      await letGo();
      return { kind: "stale", reason: EDITED };
    }
    const written = applied.decision;
    let reopened: OpenedCard | null = null;
    if (written.status === "needs_review") {
      // The viewer's lease, renewed; or, for a card the decision had closed, taken now that the
      // withdrawal put it back (another reviewer may have opened it in between: then it is theirs).
      const lock = await queue.lock(card.source, card.key, viewer, clock.now());
      if (lock.kind === "locked") {
        // The card shows what the last write was judged on: a newer answer's questions with it.
        reopened = cardOf(
          card,
          { row: loaded.row, answer: applied.answer, questions: applied.questions },
          written.decisions,
          lock.until,
        );
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

  return { open, openKey, renew, decide, skip, release, undo, forget };
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
