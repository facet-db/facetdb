import type {
  Clock,
  Connector,
  CurrentDecision,
  DecisionLog,
  RecordDecision,
  RecordKey,
} from "../contracts/index.ts";
import type { QuestionSet } from "../questions/index.ts";
import type { RecordStatus } from "../records/index.ts";
import { answerDecision, writeAnswer } from "./answer.ts";
import type { DecisionWriter } from "./human.ts";
import type { AnswerEntry } from "./model.ts";

/**
 * `facetdb backfill --from-log`: every record the decision log has answered gets its latest logged
 * decision written back, with no model call and no action. The recovery after a table rebuild that
 * emptied FacetDB's columns (S:144): a plain backfill skips a record the log answered at its state,
 * so its columns would stay empty until the state next changed.
 */

/** Records read from the source in one call: one `read` and one `current` per chunk. */
export const RESTORE_CHUNK = 500;

const MS_PER_SECOND = 1_000;

/**
 * Statuses only the worker sets, after the record's latest answer, and that the log does not hold:
 * an error or unchecked outcome of a later ask, a record the filter now excludes. A restore leaves
 * them, since the row is newer than the log there. A rebuilt row reads `pending`, never one of these.
 */
const WORKER_STATUSES: ReadonlySet<RecordStatus> = new Set(["error", "unchecked", "skipped"]);

/** What a restore reads and writes through: nothing that reaches the model or runs an action. */
export type RestoreDeps = {
  /** The question set and the thresholds in force. */
  readonly questionSet: QuestionSet;
  readonly log: DecisionLog;
  /** The source's records: their state hashes, what their columns hold, and the hash-guarded write. */
  readonly connector: Pick<Connector, "read" | "current" | "write">;
  /**
   * The review queue following a write that landed (`followReview`), as it follows the worker's: a
   * record written needs_review gets its card, any other status takes the card out.
   */
  readonly follow: (
    record: { readonly key: RecordKey; readonly stateHash: string },
    decision: RecordDecision,
    answer: AnswerEntry,
  ) => Promise<void>;
  readonly clock: Clock;
};

export type RestoreOptions = {
  /** Records written per second, at most. */
  readonly pace: number;
  /** Counts what a run would do, and writes nothing and follows no review queue. */
  readonly dryRun?: boolean;
  /**
   * Told how many records the log has an answer for, before any is read or written; false stops
   * the run with nothing written.
   */
  readonly confirm: (records: number) => boolean | Promise<boolean>;
  /** Told after each chunk how many of the records were looked at. */
  readonly onProgress?: (looked: number, records: number) => void;
};

/** What a restore did with each record the log has an answer for. */
export type RestoreReport = {
  readonly status: "completed" | "declined";
  /** Records with a logged answer. */
  readonly examined: number;
  /** Written from the log (on a dry run: would be). */
  readonly written: readonly RecordKey[];
  /** Their columns already held the log's decision: nothing written. */
  readonly current: readonly RecordKey[];
  /** Their state changed since the logged answer, or changed before the write landed: not written. */
  readonly changed: readonly RecordKey[];
  /** Their latest answer lacks a question of the set (added since): only a model call decides it. */
  readonly incomplete: readonly RecordKey[];
  /** Their status was set by the worker after the answer (error, unchecked, skipped): left as is. */
  readonly kept: readonly RecordKey[];
  /** No longer in the source. */
  readonly gone: readonly RecordKey[];
};

/**
 * Writes each record's latest logged decision back. Each record is decided from its latest answer
 * under the thresholds in force, with every person's decision made at that answer's state laid over
 * it and `reviewed` set (`answerDecision`, the worker's own rule), and written through the worker's
 * own path (`writeAnswer`): only while the record's state hash still equals the answer's, so a
 * record changed since is never written from the log, and a person's decision logged while the
 * write was on its way is carried too. A record whose columns already hold that decision is not
 * written, so a second run writes nothing. Nothing asks the model and nothing runs an action:
 * neither is among the dependencies.
 *
 * A run that stops part way is resumed by running it again: what it wrote reads as current.
 */
export async function restoreFromLog(
  deps: RestoreDeps,
  options: RestoreOptions,
): Promise<RestoreReport> {
  const { questionSet, log, connector, clock } = deps;
  if (!Number.isFinite(options.pace) || options.pace <= 0) {
    throw new Error(
      `a restore pace is a positive number of records per second, not ${options.pace}`,
    );
  }
  const answers = await log.latestAnswersSince();
  const report = {
    examined: answers.length,
    written: [] as RecordKey[],
    current: [] as RecordKey[],
    changed: [] as RecordKey[],
    incomplete: [] as RecordKey[],
    kept: [] as RecordKey[],
    gone: [] as RecordKey[],
  };
  if (!(await options.confirm(answers.length))) {
    return { status: "declined", ...report };
  }

  const interval = MS_PER_SECOND / options.pace;
  let nextWriteAt = clock.now();
  /** Each write takes the next slot, `interval` apart: at most `pace` writes in any second. */
  async function waitForTurn(): Promise<void> {
    const start = Math.max(nextWriteAt, clock.now());
    nextWriteAt = start + interval;
    const wait = start - clock.now();
    if (wait > 0) {
      await clock.sleep(wait);
    }
  }

  /** The connector's write, and the review queue following each write that lands, as the worker's. */
  function writeAndFollow(answer: AnswerEntry): DecisionWriter {
    return async (key, decision, expectedHash) => {
      const result = await connector.write(key, decision, expectedHash);
      if (result.written) {
        await deps.follow({ key, stateHash: expectedHash }, decision, answer);
      }
      return result;
    };
  }

  for (let from = 0; from < answers.length; from += RESTORE_CHUNK) {
    const chunk = answers.slice(from, from + RESTORE_CHUNK);
    const read = await connector.read(chunk.map((entry) => entry.key));
    const hashes = new Map(read.rows.map((row) => [row.key, row.hash]));
    const standing = chunk.filter((entry) => hashes.get(entry.key) === entry.stateHash);
    const held = await connector.current(standing.map((entry) => entry.key));
    for (const entry of chunk) {
      const hash = hashes.get(entry.key);
      const now = held.get(entry.key);
      if (hash === undefined) {
        report.gone.push(entry.key);
      } else if (hash !== entry.stateHash) {
        report.changed.push(entry.key);
      } else if (now !== undefined && WORKER_STATUSES.has(now.status)) {
        report.kept.push(entry.key);
      } else if (
        !questionSet.questions.every((question) => entry.answers[question.name] !== undefined)
      ) {
        report.incomplete.push(entry.key);
      } else {
        const history = await log.history(entry.key);
        if (holds(now, answerDecision(entry, questionSet, history), questionSet)) {
          report.current.push(entry.key);
        } else if (options.dryRun === true) {
          report.written.push(entry.key);
        } else {
          await waitForTurn();
          const landed = await writeAnswer(entry, questionSet, log, writeAndFollow(entry), history);
          (landed.written ? report.written : report.changed).push(entry.key);
        }
      }
    }
    options.onProgress?.(from + chunk.length, answers.length);
  }
  return { status: "completed", ...report };
}

/**
 * Whether a row's columns already hold `decision`: the same status, `reviewed` where the decision
 * sets it (the flag is never cleared, so a row may hold it without), and for every question the
 * same value and model number, or no value where the question waits for review.
 */
function holds(
  held: CurrentDecision | undefined,
  decision: RecordDecision,
  questionSet: QuestionSet,
): boolean {
  if (held === undefined || held.status !== decision.status) {
    return false;
  }
  if (decision.reviewed === true && !held.reviewed) {
    return false;
  }
  return questionSet.questions.every((question) => {
    const want = decision.decisions[question.name];
    const have = held.decisions[question.name];
    if (want?.kind !== "decided") {
      return have === undefined;
    }
    return (
      have !== undefined &&
      have.value === want.value &&
      near(have.probabilityOrConfidence, want.probabilityOrConfidence) &&
      (want.expected === undefined ||
        (have.expected !== undefined && near(have.expected, want.expected)))
    );
  });
}

/**
 * Two model numbers equal as a column keeps them: a `real` column on Postgres or SQL Server is
 * single precision, so 0.123456789 reads back as 0.12345679. Without this a second run would write
 * every record again.
 */
function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b));
}
