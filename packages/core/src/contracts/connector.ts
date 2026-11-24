import type { RecordStatus, StateValue } from "../records/index.ts";
import type { Decision } from "../thresholds/index.ts";

/**
 * A record's primary key as text. The adapter converts its own key type to text at its boundary,
 * so no core code ever sees a database type.
 */
export type RecordKey = string;

/** A record as `read` and `scan` return it: its state fields and the hash of exactly those fields. */
export type ReadRow = {
  readonly key: RecordKey;
  readonly state: Readonly<Record<string, StateValue>>;
  readonly hash: string;
  /**
   * True when the source's `where` filter excludes the record. The connector evaluates the filter
   * in its own SQL; core never sees it, and skips an excluded record without a model call.
   */
  readonly excluded: boolean;
};

export type ReadResult = {
  readonly rows: readonly ReadRow[];
  /** Keys asked for that no longer exist. They are reported, never silently dropped. */
  readonly missing: readonly RecordKey[];
};

/** An opaque cursor a connector hands out with each page; it must survive a restart. */
export type ScanCursor = string;

export type ScanPage = {
  readonly rows: readonly ReadRow[];
  /** The cursor for the next page, or null after the last one. */
  readonly next: ScanCursor | null;
};

/** What the database can do. The worker and the backfill choose their paths from these. */
export type Capabilities = {
  readonly inlineColumns: boolean;
  readonly pushWakeup: boolean;
  readonly transactions: boolean;
  readonly sideTable: boolean;
  /** Whether several workers may claim from one queue safely (`skip locked` or its equivalent). */
  readonly multipleWorkers: boolean;
};

/**
 * What the worker writes for one record: the decision for each question name and the record's
 * status afterwards. The connector stores both; it never decides either.
 */
export type RecordDecision = {
  readonly decisions: Readonly<Record<string, Decision>>;
  readonly status: RecordStatus;
  /**
   * Set when a person decided a question of this record. `facetdb_reviewed` is true once any
   * question was decided by a person, so the connector sets it here and never
   * clears it: a write without `reviewed` leaves the flag as it was.
   */
  readonly reviewed?: true;
};

export type WriteResult = {
  /** False when the stored state hash no longer matches `expectedHash`, or the row is gone. */
  readonly written: boolean;
};

/**
 * A record's decision as the connector holds it now: what the last `write` stored, read back from
 * where the engine keeps it (the record's own columns, the side table, the store), for `explain`
 * and the review screens. After a change under `onChange: "reset"` a record reads pending with its
 * previous decisions still there, until the new answer is written.
 */
export type CurrentDecision = {
  /**
   * The decision of each question that holds one. A question without one (not answered yet, or
   * waiting for review: its value is NULL) is absent; the status says which.
   */
  readonly decisions: Readonly<Record<string, Extract<Decision, { readonly kind: "decided" }>>>;
  readonly status: RecordStatus;
  /** `facetdb_reviewed`: true once a person decided any question of the record. */
  readonly reviewed: boolean;
  /**
   * When the record was last decided (`facetdb_updated_at`). The store keeps one time per record,
   * so there it is when the record last changed or was decided. Null before the first decision.
   */
  readonly updatedAt: Date | null;
};

/**
 * A database a worker reads from and writes decisions to. Methods take keys, cursors and decisions,
 * never a database handle or a URL: those belong to the adapter's factory. Every connector
 * implements all of them; a capability says which paths it can take.
 */
export type Connector = {
  readonly capabilities: Capabilities;
  /** Creates the answer columns or side table, the jobs table and the change capture. Idempotent. */
  install(): Promise<void>;
  /** Removes what install created. Idempotent. */
  uninstall(): Promise<void>;
  /** Yields batches of changed keys, at least once each; duplicates are fine, the worker dedupes. */
  watch(): AsyncIterable<readonly RecordKey[]>;
  /** The state and hash of each key; keys that do not exist are reported in `missing`. */
  read(keys: readonly RecordKey[]): Promise<ReadResult>;
  /** Writes the decision only if the stored state hash equals `expectedHash`. */
  write(key: RecordKey, decision: RecordDecision, expectedHash: string): Promise<WriteResult>;
  /**
   * The decision each key holds now, keyed by record key; a key that names no record is absent,
   * whatever its form. A record never decided is absent where FacetDB has no row or status for it
   * yet (a side table, a polling install that has not seen it), and reads as pending with nothing
   * decided and no `updatedAt` where it has one (inline columns, the store).
   */
  current(keys: readonly RecordKey[]): Promise<ReadonlyMap<RecordKey, CurrentDecision>>;
  /** Pages through every record, newest first, from a cursor that survives a restart. */
  scan(cursor: ScanCursor | null): Promise<ScanPage>;
  /**
   * Queues keys for the workers, as the change capture does: a key already queued stays one entry.
   * A backfill enqueues. Returns the keys the queue holds once the call is done, one already queued
   * among them (a worker holds it or will): a database's queue returns every key it was given; a
   * plugin source leaves out a key its plugin no longer returns, and a backfill counts only these.
   */
  enqueue(keys: readonly RecordKey[]): Promise<readonly RecordKey[]>;
  /** Claims up to `limit` queued keys so no other worker on the same queue takes them. */
  claim(limit: number): Promise<readonly RecordKey[]>;
  /**
   * Queues `key` already claimed by this worker and returns true, or returns false when the key is
   * queued already: a worker holds it or will, and asks it whole. Settle it with `ack` or `release`.
   * Never hold an uncommitted job row across the model call: the app's trigger would wait on it.
   * In SQL, commit `insert … on conflict do nothing returning` first, then claim the row with
   * `select … for update skip locked` (false if a worker took it in between).
   */
  claimKey(key: RecordKey): Promise<boolean>;
  /** Removes claimed keys from the queue once their work is done. */
  ack(keys: readonly RecordKey[]): Promise<void>;
  /** Returns claimed keys to the queue for another attempt. */
  release(keys: readonly RecordKey[]): Promise<void>;
};
