import type {
  Capabilities,
  Connector,
  ReadResult,
  ReadRow,
  RecordDecision,
  RecordKey,
  ScanCursor,
  ScanPage,
  WriteResult,
} from "../contracts/index.ts";
import { type StateValue, stateHash } from "../records/index.ts";
import { FakeStore } from "./store.ts";

export type FakeDatabaseOptions = {
  /** The state fields the connector hashes, in config order. */
  readonly fields: readonly string[];
  /** Rows per scan page. Defaults to 10. */
  readonly pageSize?: number;
};

/** A row as the fake table keeps it: its insertion order, its state and the decision written to it. */
type FakeRow = {
  readonly seq: number;
  readonly state: Readonly<Record<string, StateValue>>;
  readonly decision: RecordDecision | null;
};

/** A queued job: who claimed it, or null while it waits. */
type FakeJob = {
  readonly claimedBy: string | null;
};

/**
 * One in-memory database shared by any number of worker connectors, the way one Postgres database
 * is shared by several workers. The application writes through `edit`; the installed trigger queues
 * the key and wakes every watcher. The table, the jobs and the change log live here; a
 * `FakeConnector` is one worker's view of them.
 */
export class FakeDatabase {
  readonly fields: readonly string[];
  readonly pageSize: number;
  readonly rows = new FakeStore<FakeRow>();
  readonly jobs = new FakeStore<FakeJob>();
  readonly #changes: RecordKey[] = [];
  readonly #waiters: (() => void)[] = [];
  #installed = false;
  #nextSeq = 1;
  #nextWorker = 1;

  constructor(options: FakeDatabaseOptions) {
    this.fields = options.fields;
    this.pageSize = options.pageSize ?? 10;
    if (!Number.isInteger(this.pageSize) || this.pageSize < 1) {
      throw new Error(`a page holds at least one row, not ${this.pageSize}`);
    }
  }

  /** The application's own write: inserts or updates a row's state fields, as the app would. */
  edit(key: RecordKey, state: Readonly<Record<string, StateValue>>): void {
    const stored: Record<string, StateValue> = {};
    for (const field of this.fields) {
      const value = state[field];
      if (value === undefined) {
        throw new Error(`state field "${field}" is missing for key "${key}"`);
      }
      stored[field] = value;
    }
    const existing = this.rows.get(key);
    this.rows.set(key, {
      seq: existing?.seq ?? this.#nextSeq++,
      state: stored,
      decision: existing?.decision ?? null,
    });
    if (this.#installed) {
      this.#fire(key);
    }
  }

  /** The stored decision for a key, or null. A test reads what a write left behind through this. */
  decisionOf(key: RecordKey): RecordDecision | null {
    return this.rows.get(key)?.decision ?? null;
  }

  registerWorker(): string {
    return `worker-${this.#nextWorker++}`;
  }

  get installed(): boolean {
    return this.#installed;
  }

  install(): void {
    this.#installed = true;
  }

  /** Drops the trigger, the jobs and the answers, as uninstall does. The state rows stay. */
  uninstall(): void {
    this.#installed = false;
    this.jobs.clear();
    for (const [key, row] of this.rows.entries()) {
      this.rows.set(key, { ...row, decision: null });
    }
  }

  assertInstalled(): void {
    if (!this.#installed) {
      throw new Error("the connector is not installed: run install first");
    }
  }

  changeCount(): number {
    return this.#changes.length;
  }

  changesSince(count: number): RecordKey[] {
    return this.#changes.slice(count);
  }

  /** Resolves once more than `count` changes have been logged. */
  waitForChangeAfter(count: number): Promise<void> {
    if (this.#changes.length > count) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** The trigger: insert the job once (`on conflict do nothing`), then wake every watcher. */
  #fire(key: RecordKey): void {
    if (!this.jobs.has(key)) {
      this.jobs.set(key, { claimedBy: null });
    }
    this.#changes.push(key);
    for (const wake of this.#waiters.splice(0)) {
      wake();
    }
  }
}

const FAKE_CAPABILITIES: Capabilities = {
  inlineColumns: true,
  pushWakeup: true,
  transactions: true,
  sideTable: false,
  multipleWorkers: true,
};

/**
 * One worker's connector over a `FakeDatabase`. It implements every operation of the contract with
 * the database's own rules: `write` only when the hash matches, `claim` only unclaimed jobs, `scan`
 * newest first from a cursor that does not shift when rows are added.
 */
export class FakeConnector implements Connector {
  readonly capabilities: Capabilities = FAKE_CAPABILITIES;
  readonly #db: FakeDatabase;
  readonly #worker: string;

  constructor(database: FakeDatabase) {
    this.#db = database;
    this.#worker = database.registerWorker();
  }

  install(): Promise<void> {
    this.#db.install();
    return Promise.resolve();
  }

  uninstall(): Promise<void> {
    this.#db.uninstall();
    return Promise.resolve();
  }

  /** Yields the keys changed after the watch starts; the worker deduplicates what it receives. */
  async *watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    let seen = this.#db.changeCount();
    for (;;) {
      await this.#db.waitForChangeAfter(seen);
      const batch = this.#db.changesSince(seen);
      seen += batch.length;
      yield batch;
    }
  }

  read(keys: readonly RecordKey[]): Promise<ReadResult> {
    const rows: ReadRow[] = [];
    const missing: RecordKey[] = [];
    for (const key of keys) {
      const row = this.#db.rows.get(key);
      if (row === undefined) {
        missing.push(key);
      } else {
        rows.push(this.#readRow(key, row));
      }
    }
    return Promise.resolve({ rows, missing });
  }

  async write(
    key: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    this.#db.assertInstalled();
    const row = this.#db.rows.get(key);
    if (row === undefined || stateHash(this.#db.fields, row.state) !== expectedHash) {
      return { written: false };
    }
    this.#db.rows.set(key, { ...row, decision });
    return { written: true };
  }

  async scan(cursor: ScanCursor | null): Promise<ScanPage> {
    const bound = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
    if (cursor !== null && !Number.isInteger(bound)) {
      throw new Error(`"${cursor}" is not a scan cursor from this connector`);
    }
    const candidates = this.#db.rows
      .entries()
      .filter(([, row]) => row.seq < bound)
      .sort(([, a], [, b]) => b.seq - a.seq);
    const page = candidates.slice(0, this.#db.pageSize);
    const last = page.at(-1);
    const next = candidates.length > page.length && last !== undefined ? String(last[1].seq) : null;
    return { rows: page.map(([key, row]) => this.#readRow(key, row)), next };
  }

  async claim(limit: number): Promise<readonly RecordKey[]> {
    this.#db.assertInstalled();
    const claimed: RecordKey[] = [];
    for (const [key, job] of this.#db.jobs.entries()) {
      if (claimed.length >= limit) {
        break;
      }
      if (job.claimedBy === null) {
        this.#db.jobs.set(key, { claimedBy: this.#worker });
        claimed.push(key);
      }
    }
    return claimed;
  }

  async ack(keys: readonly RecordKey[]): Promise<void> {
    for (const key of keys) {
      if (this.#db.jobs.get(key)?.claimedBy === this.#worker) {
        this.#db.jobs.delete(key);
      }
    }
  }

  async release(keys: readonly RecordKey[]): Promise<void> {
    for (const key of keys) {
      if (this.#db.jobs.get(key)?.claimedBy === this.#worker) {
        this.#db.jobs.set(key, { claimedBy: null });
      }
    }
  }

  #readRow(key: RecordKey, row: FakeRow): ReadRow {
    return { key, state: row.state, hash: stateHash(this.#db.fields, row.state) };
  }
}
