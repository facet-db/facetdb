import type { DecisionLog, RecordDecision, RecordKey, WriteResult } from "../contracts/index.ts";
import type { Question } from "../questions/index.ts";
import { type RecordStatus, transition } from "../records/index.ts";
import { type Answer, choiceConfidence, type Decision } from "../thresholds/index.ts";
import type { HumanEntry, HumanValue, LogEntry } from "./model.ts";

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
 * The model's own number for a question: the yes probability of a noul, the confidence of a choice
 * or a score, and a score's expected level. A person's decision keeps it in the row, so the column
 * still says what the model thought while the value says what the person decided.
 */
function modelNumber(
  answer: Answer,
): Pick<Extract<Decision, { kind: "decided" }>, "probabilityOrConfidence" | "expected"> {
  switch (answer.type) {
    case "noul":
      return { probabilityOrConfidence: answer.probability };
    case "choice":
      return { probabilityOrConfidence: choiceConfidence(answer.probabilities) };
    case "score":
      return { probabilityOrConfidence: answer.confidence, expected: answer.expected };
  }
}

/** The decision a person's value makes for a question, carrying the model's number from `answer`. */
export function humanDecision(question: Question, value: HumanValue, answer: Answer): Decision {
  if (answer.type !== question.type) {
    throw new Error(
      `question "${question.name}" is a ${question.type}; its logged answer is a ${answer.type}`,
    );
  }
  return { kind: "decided", value, ...modelNumber(answer) };
}

/**
 * The human decision that stands for a question given a record's history: the person's latest word
 * on it, provided it was made against the record's current state, since it stands until that
 * state changes. A decision made against an older state is retired, and so is one followed by an
 * answer at another state: after A, B, A the decision made at A does not return.
 */
export function standingHuman(
  history: readonly LogEntry[],
  question: string,
  stateHash: string,
): HumanEntry | undefined {
  let latest: HumanEntry | undefined;
  for (const entry of history) {
    if (entry.kind === "human" && entry.question === question) {
      latest = entry;
    } else if (
      entry.kind === "answer" &&
      latest !== undefined &&
      entry.stateHash !== latest.stateHash
    ) {
      latest = undefined;
    }
  }
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
  /** What is decided so far; an undecided question is `needs_review`. */
  readonly decisions: Readonly<Record<string, Decision>>;
  /** The latest logged answers for this state. */
  readonly answers: Readonly<Record<string, Answer>>;
};

export type HumanResult = {
  readonly written: boolean;
  readonly status: RecordStatus;
};

/**
 * Applies one reviewer decision from the review screen. The entry is logged first, so a crash
 * between the two steps leaves a logged decision and an unchanged row, never a changed row nobody
 * can explain; then the value is written at once with `reviewed` set, and the status becomes done
 * when every question is decided. Every person's decision standing in the log is written, not
 * only this one: two reviewers working from the same card snapshot would otherwise each write
 * the other's question back to review. If the record changed while the card was open the write
 * is refused and the entry no longer stands, because its hash is old.
 */
export async function applyHumanDecision(
  entry: HumanEntry,
  record: ReviewedRecord,
  log: DecisionLog,
  write: DecisionWriter,
): Promise<HumanResult> {
  if (record.status !== "needs_review") {
    throw new Error(
      `only a needs_review record can take a human decision, not one that is ${record.status}`,
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
  let history = await log.history(record.key);
  for (;;) {
    const { decisions, status } = withPeople(record, history);
    const result = await write(record.key, { decisions, status, reviewed: true }, record.hash);
    if (!result.written) {
      return { written: false, status };
    }
    const after = await log.history(record.key);
    if (humanCount(after) === humanCount(history)) {
      return { written: true, status };
    }
    history = after;
  }
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
  const status = allDecided ? transition(record.status, "human-decided-last") : record.status;
  return { decisions, status };
}

function humanCount(history: readonly LogEntry[]): number {
  return history.filter((entry) => entry.kind === "human").length;
}
