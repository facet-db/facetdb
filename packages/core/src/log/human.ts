import type { DecisionLog, RecordDecision, RecordKey, WriteResult } from "../contracts/index.ts";
import type { Question } from "../questions/index.ts";
import { type RecordStatus, transition } from "../records/index.ts";
import {
  type Answer,
  choiceConfidence,
  type Decision,
  storedProbabilities,
} from "../thresholds/index.ts";
import {
  type AnswerEntry,
  type HumanDecisionEntry,
  type HumanEntry,
  type HumanValue,
  isHumanDecision,
  type LogEntry,
} from "./model.ts";

/**
 * What the worker and the review path write: a connector's `write`, passed in so this module never
 * names a database. The write lands only while `expectedHash` still equals the stored state hash.
 */
export type DecisionWriter = (
  key: RecordKey,
  decision: RecordDecision,
  expectedHash: string,
) => Promise<WriteResult>;

/**
 * The model's own numbers for a question: the yes probability of a noul, the confidence of a choice
 * or a score, a score's expected level, and a choice's option probabilities when the question
 * stores them. A person's decision keeps them in the row, so the columns still say what the model
 * thought while the value says what the person decided.
 */
function modelNumbers(
  question: Question,
  answer: Answer,
): Pick<
  Extract<Decision, { kind: "decided" }>,
  "probabilityOrConfidence" | "expected" | "probabilities"
> {
  switch (answer.type) {
    case "noul":
      return { probabilityOrConfidence: answer.probability };
    case "choice":
      return {
        probabilityOrConfidence: choiceConfidence(answer.probabilities),
        ...storedProbabilities(question, answer),
      };
    case "score":
      return { probabilityOrConfidence: answer.confidence, expected: answer.expected };
  }
}

/** The decision a person's value makes for a question, carrying the model's numbers from `answer`. */
export function humanDecision(question: Question, value: HumanValue, answer: Answer): Decision {
  if (answer.type !== question.type) {
    throw new Error(
      `question "${question.name}" is a ${question.type}; its logged answer is a ${answer.type}`,
    );
  }
  return { kind: "decided", value, ...modelNumbers(question, answer) };
}

/**
 * The human decision that stands for a question given a record's history: the person's latest word
 * on it, provided it was made against the record's current state (it stands until the record's
 * state changes). A decision made against an older state is retired, and so is one followed by an
 * answer at another state: after A, B, A the decision made at A does not return. A decision
 * followed by its withdrawal is ignored, and the word before it, if any still stands, is the latest
 * again.
 */
export function standingHuman(
  history: readonly LogEntry[],
  question: string,
  stateHash: string,
): HumanDecisionEntry | undefined {
  // The decisions on this question still in force, oldest first.
  let words: HumanDecisionEntry[] = [];
  for (const entry of history) {
    if (entry.kind === "answer") {
      words = words.filter((word) => word.stateHash === entry.stateHash);
    } else if (entry.question === question && isHumanDecision(entry)) {
      words.push(entry);
    } else if (entry.question === question) {
      // A withdrawal takes back its reviewer's own latest decision at its state, never another's.
      const taken = words.findLastIndex(
        (word) => word.reviewer === entry.reviewer && word.stateHash === entry.stateHash,
      );
      if (taken !== -1) {
        words.splice(taken, 1);
      }
    }
  }
  const latest = words.at(-1);
  return latest !== undefined && latest.stateHash === stateHash ? latest : undefined;
}

/**
 * Whether a person's decision stands for this question of this record at this state. Re-apply,
 * rewording and model upgrades consult it before touching a value.
 */
export async function humanDecisionStands(
  log: DecisionLog,
  key: RecordKey,
  question: string,
  stateHash: string,
): Promise<boolean> {
  return standingHuman(await log.history(key), question, stateHash) !== undefined;
}

/** A record on the review screen: what is decided so far, and the model's answers behind it. */
export type ReviewedRecord = {
  readonly key: RecordKey;
  /** The hash of the state the reviewer saw; the write lands only while it still matches. */
  readonly hash: string;
  readonly status: RecordStatus;
  /** Every question of the set, in order. */
  readonly questions: readonly Question[];
  /**
   * What is decided so far; an undecided question is `needs_review`. The people's decisions that
   * stand in the log are laid over these, so for a withdrawal they must be the thresholds' alone:
   * a person's value here would outlive its withdrawal.
   */
  readonly decisions: Readonly<Record<string, Decision>>;
  /** The latest logged answers for this state. */
  readonly answers: Readonly<Record<string, Answer>>;
};

/** What a card is judged on, built from one logged answer: the part of a `ReviewedRecord` it sets. */
type ReviewedAnswer = Pick<ReviewedRecord, "questions" | "decisions" | "answers">;

/**
 * Builds what the card is judged on from a model answer logged at the card's state after the card
 * was loaded (a backfill's merge of an added question, or the worker asking again at an unchanged
 * state): the questions of the set that answer has, their thresholds' decisions alone, and its
 * answers. Undefined when the answer has none of the set's questions, so nothing on the card can be
 * judged on it. `applyHumanDecision` calls it just before the write it decides from what it
 * returns.
 */
type ReloadRecord = (answer: AnswerEntry) => ReviewedAnswer | undefined;

export type HumanResult = {
  readonly written: boolean;
  readonly status: RecordStatus;
};

/**
 * Applies one reviewer decision, or one withdrawal of a reviewer's own decision, through the same
 * door. The entry is logged first, so a crash between the two steps leaves a logged decision and an
 * unchanged row, never a changed row nobody can explain; then the value is written at once with
 * `reviewed` set, and the status becomes done when every question is decided. Every person's
 * decision standing in the log is written, not only this one: two reviewers working from the same
 * card snapshot would otherwise each write the other's question back to review. If the record
 * changed while the card was open the write is refused and the entry no longer stands, because its
 * hash is old.
 *
 * A decision is taken only on a needs_review record. A withdrawal is taken on a needs_review or a
 * done record (the decision it takes back may have closed it): its question falls back to what
 * `record.decisions` says of it, so a record whose question no threshold decides is needs_review
 * again, and `reviewed` stays true, since a person did decide.
 */
export async function applyHumanDecision(
  entry: HumanEntry,
  record: ReviewedRecord,
  log: DecisionLog,
  write: DecisionWriter,
  /**
   * The record's history as the caller just read it, so the first write needs no read of its own
   * (`[...before, entry]`, as `writeAnswer` does); without it the log is read after the append.
   * Either way the re-read after each write stands, so a decision logged meanwhile is written too.
   */
  before?: readonly LogEntry[],
  /**
   * How to judge the card again on a model answer logged at its state after the history the last
   * write was made from. Without it a newer answer is not looked for, as before. It counts answers
   * from `before`. A caller passing `reload` without `before` cannot see an answer appended between
   * its own read and the append: the first history is then the read after the append, which already
   * holds that answer, so it is not counted as newer than `record`'s.
   */
  reload?: ReloadRecord,
): Promise<HumanResult> {
  if (isHumanDecision(entry) && record.status !== "needs_review") {
    throw new Error(
      `only a needs_review record can take a human decision, not one that is ${record.status}`,
    );
  }
  if (record.status !== "needs_review" && record.status !== "done") {
    throw new Error(
      `only a needs_review or done record can take a withdrawal, not one that is ${record.status}`,
    );
  }
  if (entry.key !== record.key || entry.stateHash !== record.hash) {
    throw new Error(`the decision for "${entry.key}" was made against a different record or state`);
  }
  const question = record.questions.find((candidate) => candidate.name === entry.question);
  const answer = record.answers[entry.question];
  if (question === undefined || answer === undefined) {
    throw new Error(
      `"${entry.question}" is not a question of record "${record.key}" with a logged answer`,
    );
  }
  await log.appendHuman(entry);
  // Overlapping reviewers: each one re-reads the log after its write and writes again when a
  // person decided something meanwhile, so the write that lands last always carries every
  // decision logged before it (an entry appended after that re-read comes with its own write).
  // With `before`, the window the first write can miss spans the caller's own read too: a
  // decision logged between that read and this append is carried back by the second write,
  // one round trip later; only a death between the two writes leaves the row short of it until
  // the card is opened again (the same class as a logged, unwritten decision).
  //
  // The same read also looks for a model answer logged at the card's state since that history (a
  // backfill merging an added question into the answer, or the worker asking again at an unchanged
  // state). Written from the card alone, the record would be judged on the older answer's questions
  // and could be written done over a question the newer one left open. So the card is judged again
  // on the newer answer (`reload`): its questions, its thresholds' decisions, every person's
  // decision standing at this state laid over them, and the write is made again. The answer's own
  // writer reads the log after its write too and carries this person's entry, so whichever write
  // lands last carries both.
  let judged = record;
  let history = before === undefined ? await log.history(record.key) : [...before, entry];
  for (;;) {
    const { decisions, status } = withPeople(judged, history);
    const result = await write(record.key, { decisions, status, reviewed: true }, record.hash);
    if (!result.written) {
      return { written: false, status };
    }
    const after = await log.history(record.key);
    const newer = reload === undefined ? undefined : newerAnswer(after, history, record.hash);
    // A newer answer with nothing on the card to judge on it (none of the set's questions) is no
    // reason to stop looking: the people's entries are checked as without it, and a person's entry
    // logged meanwhile is still written again from the card held. Only when neither applies does
    // the loop end.
    const reloaded = newer === undefined ? undefined : reload?.(newer);
    if (reloaded !== undefined) {
      judged = { ...judged, ...reloaded };
    } else if (humanCount(after) === humanCount(history)) {
      return { written: true, status };
    }
    history = after;
  }
}

/**
 * The model answer logged since `decidedFrom` that the record now stands on at `hash`: the latest
 * answer of `after`, when `after` holds more answers than `decidedFrom` and the latest is at that
 * state. An answer at another state is not newer at this one: the record changed, and the hash
 * check refuses a write made for the old state.
 */
function newerAnswer(
  after: readonly LogEntry[],
  decidedFrom: readonly LogEntry[],
  hash: string,
): AnswerEntry | undefined {
  if (answerCount(after) === answerCount(decidedFrom)) {
    return undefined;
  }
  const latest = after.findLast((entry): entry is AnswerEntry => entry.kind === "answer");
  return latest !== undefined && latest.stateHash === hash ? latest : undefined;
}

function answerCount(history: readonly LogEntry[]): number {
  return history.filter((entry) => entry.kind === "answer").length;
}

/** The card's decisions with every person's decision standing in `history` laid over them. */
function withPeople(
  record: ReviewedRecord,
  history: readonly LogEntry[],
): { decisions: Record<string, Decision>; status: RecordStatus } {
  const decisions: Record<string, Decision> = { ...record.decisions };
  for (const candidate of record.questions) {
    const standing = standingHuman(history, candidate.name, record.hash);
    const logged = record.answers[candidate.name];
    if (standing !== undefined && logged !== undefined) {
      decisions[candidate.name] = humanDecision(candidate, standing.value, logged);
    }
  }
  const allDecided = record.questions.every(
    (candidate) => decisions[candidate.name]?.kind === "decided",
  );
  return { decisions, status: statusAfterPeople(record.status, allDecided) };
}

/**
 * A needs_review record is done once every question is decided; a done record a withdrawal left
 * with an undecided question goes back to review.
 */
function statusAfterPeople(current: RecordStatus, allDecided: boolean): RecordStatus {
  if (current === "done") {
    return allDecided ? "done" : transition(current, "human-withdrew");
  }
  return allDecided ? transition(current, "human-decided-last") : current;
}

/** How many people's entries (decisions and withdrawals) a record's history holds. */
export function humanCount(history: readonly LogEntry[]): number {
  return history.filter((entry) => entry.kind === "human").length;
}
