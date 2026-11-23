import type { AnswerEntry, HumanEntry, LogEntry } from "../log/index.ts";
import type { RecordKey } from "./connector.ts";

/**
 * One page of a source's log, oldest first. `next` is the cursor to pass as `after` for the page
 * after this one, and is undefined when this page was the last (a short page).
 */
export type LogPage = {
  readonly entries: readonly LogEntry[];
  readonly next: number | undefined;
};

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
  /**
   * The source's whole log in append order, oldest first by id, `limit` entries at a time (the
   * export reads it this way, never in one query). `after` is the cursor the previous page returned,
   * undefined for the first page.
   */
  page(after: number | undefined, limit: number): Promise<LogPage>;
  /**
   * How many entries the source's log holds, answers and human decisions alike, optionally only
   * those of question-set version `version`: one query, never a read of the rows (`facetdb export
   * --dry-run` says how many it would write this way).
   */
  count(version?: number): Promise<number>;
};

/**
 * The model each question-set version is held to: the store keeps, per source and version, the
 * model the first answer under it named. The Postgres store
 * (`facetdb.question_set_versions.answered_by`) implements it.
 */
export type VersionModels = {
  /**
   * Sets the version's model to `named` when no answer has set it yet, and answers the name held,
   * in one statement: of two workers' first answers the first write wins and both are answered
   * its name. A version the store does not keep is an error.
   */
  answeredBy(sourceId: string, version: number, named: string): Promise<string>;
};
