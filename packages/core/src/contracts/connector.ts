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
  /** True when a person decided a question of this record: the connector sets `facetdb_reviewed`. */
  readonly reviewed?: boolean;
};

export type WriteResult = {
  /** False when the stored state hash no longer matches `expectedHash`, or the row is gone. */
  readonly written: boolean;
};

/**
 * A database a worker reads from and writes decisions to. Methods take keys, cursors and
 * decisions, never a database handle or a URL: those belong to the adapter's factory. Every
 * connector implements all of them; a capability says which paths it can take.
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
  /** Pages through every record, newest first, from a cursor that survives a restart. */
  scan(cursor: ScanCursor | null): Promise<ScanPage>;
  /** Claims up to `limit` queued keys so no other worker on the same queue takes them. */
  claim(limit: number): Promise<readonly RecordKey[]>;
  /** Removes claimed keys from the queue once their work is done. */
  ack(keys: readonly RecordKey[]): Promise<void>;
  /** Returns claimed keys to the queue for another attempt. */
  release(keys: readonly RecordKey[]): Promise<void>;
};
