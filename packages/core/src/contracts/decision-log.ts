import type { AnswerEntry, HumanEntry, LogEntry } from "../log/model.ts";
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
  /** Every entry for the record, oldest first. */
  history(key: RecordKey): Promise<readonly LogEntry[]>;
  /**
   * The most recent model call of every record, optionally only those answered under a question-set
   * version of at least `version`. This is what a threshold change re-applies.
   */
  latestAnswersSince(version?: number): Promise<readonly AnswerEntry[]>;
};
