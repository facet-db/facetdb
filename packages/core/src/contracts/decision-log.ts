import type { AnswerEntry, HumanEntry, LogEntry } from "../log/index.ts";
import type { RecordKey } from "./connector.ts";

/**
 * The decision log as the worker, the review path and re-apply see it. The Postgres store
 * (`facetdb.decisions`) and the in-memory fake implement it; nothing above them knows which.
 * Entries are append-only: a correction is a new entry, never an edit.
 */
export type DecisionLog = {
  /** Records one model call. The worker awaits this before it writes the row. */
  appendAnswer(entry: AnswerEntry): Promise<void>;
  /** Records one human decision. */
  appendHuman(entry: HumanEntry): Promise<void>;
  /** The most recent model call for the record, or undefined when it was never answered. */
  latestAnswer(key: RecordKey): Promise<AnswerEntry | undefined>;
  /**
   * `latestAnswer` for many records in one call: the most recent model call of each key, keyed by
   * record key; a key never answered is absent. The backfill reads a whole page through this, so a
   * far database costs one round trip per page instead of one per record.
   */
  latestAnswers(keys: readonly RecordKey[]): Promise<ReadonlyMap<RecordKey, AnswerEntry>>;
  /** Every entry for the record, oldest first. */
  history(key: RecordKey): Promise<readonly LogEntry[]>;
  /**
   * The most recent model call of every record, optionally only those answered under a question-set
   * version of at least `version`. This is what a threshold change re-applies.
   */
  latestAnswersSince(version?: number): Promise<readonly AnswerEntry[]>;
};
