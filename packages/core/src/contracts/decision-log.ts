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
  /**
   * The version's hold, so a worker that starts while its source is held starts held: null while no
   * response has named another model, or since one named the held model again. A version the store
   * does not keep is an error.
   */
  readHold(sourceId: string, version: number): Promise<VersionHold | null>;
  /**
   * Holds the version, in one statement: the name the response gave, and `probeAt` as the next
   * probe's time unless the version is already held, whose probe time is kept, so every worker of a
   * fleet keeps one probe time. Answers the probe time the store holds. A version the store does
   * not keep is an error.
   */
  setHold(sourceId: string, version: number, named: string, probeAt: number): Promise<number>;
  /** Lets the version go, in one statement: a response named the held model again. */
  clearHold(sourceId: string, version: number): Promise<void>;
  /**
   * Claims the held version's probe at `now`, in one statement that moves the probe time to
   * `next` only where it is `now` or earlier: of several workers asking at once, one is answered
   * `claimed`. A version the store does not keep is an error.
   */
  claimProbe(sourceId: string, version: number, now: number, next: number): Promise<ProbeClaim>;
};

/** A held version as the store keeps it. */
export type VersionHold = {
  /** The model the version is held to: the one its first answer named. */
  readonly held: string;
  /** The model the holding response named instead. */
  readonly named: string;
  /** When the next probe may be asked (ms, on the workers' clock). */
  readonly probeAt: number;
};

/** How a probe claim ended. */
export type ProbeClaim =
  /** This worker asks the probe; the next one is due at the `next` it passed. */
  | { readonly kind: "claimed" }
  /**
   * Another worker took the probe, or its time has not come: the store's probe time as this
   * statement read it (at or before `now` when the other claim committed while it ran).
   */
  | { readonly kind: "taken"; readonly probeAt: number }
  /** No longer held: a response named the held model again. */
  | { readonly kind: "released" };
