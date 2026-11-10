import {
  type Capabilities,
  type Clock,
  type Connector,
  type ReadResult,
  type ReadRow,
  type RecordDecision,
  type RecordKey,
  type RecordStatus,
  type ScanCursor,
  type ScanPage,
  type StateValue,
  stateHash,
  type WriteResult,
} from "@facetdb/core";
import { CLAIM_LEASE_MS, jobsQueries, type SqlClient, type SqlRow } from "../sql/index.ts";
import { flag, fromMs, jsonObject, jsonOrNull, text } from "./rows.ts";
import { migrateStore } from "./schema.ts";

/**
 * What the source's job keys start with in `facetdb.jobs`. That table has no source column (the
 * shape the Postgres connector shares: `on conflict (record_key)`), so the store puts the source
 * into the key: its id, length-prefixed so no source's prefix can begin another's.
 */
export function queuePrefix(sourceId: string): string {
  return `${sourceId.length}:${sourceId}:`;
}

export type StoreConnectorOptions = {
  /** The source's id in `facetdb.sources`; its records, jobs and log are keyed by it. */
  readonly sourceId: string;
  /** The state fields the model is shown and the hash covers, in config order. */
  readonly fields: readonly string[];
  /** Names this worker's claims in `facetdb.jobs`; two workers on one queue need two names. */
  readonly workerId: string;
  /** Rows per `scan` page. Defaults to 500. */
  readonly pageSize?: number;
  /** How often `watch` looks at the queue. Defaults to 2 seconds. */
  readonly pollMs?: number;
};

/** A record of a plugin or API source as the store holds it. */
export type StoredRecord = {
  readonly key: RecordKey;
  readonly state: Readonly<Record<string, StateValue>>;
  readonly hash: string;
  readonly status: RecordStatus;
  /** The decision last written, or null before the first one. */
  readonly decision: RecordDecision | null;
};

/**
 * The connector contract over `facetdb.records` and `facetdb.jobs`, plus the two operations a source
 * that is not a database needs because nobody else changes its rows: `upsertRecord`, the "app's own
 * write" (what the check API calls), and `getRecord`.
 */
export type StoreConnector = Connector & {
  /**
   * Stores the record's state. A state that differs from the stored one (or a new record) goes back
   * to `pending` and is queued, in one transaction; the same state again changes nothing and resolves
   * false. The stored decision stays until a new one is written over it.
   */
  upsertRecord(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<boolean>;
  getRecord(key: RecordKey): Promise<StoredRecord | undefined>;
};

const CAPABILITIES: Capabilities = {
  inlineColumns: false,
  pushWakeup: false,
  transactions: true,
  sideTable: false,
  multipleWorkers: true,
};

const DEFAULT_PAGE_SIZE = 500;
const DEFAULT_POLL_MS = 2000;
const WATCH_BATCH = 500;

/** Keys compare as bytes, so the scan order is the same on every database. */
const BYTE_ORDER = 'collate "C"';

export function createStoreConnector(
  client: SqlClient,
  clock: Clock,
  isClosed: () => boolean,
  options: StoreConnectorOptions,
): StoreConnector {
  const {
    sourceId,
    fields,
    workerId,
    pageSize = DEFAULT_PAGE_SIZE,
    pollMs = DEFAULT_POLL_MS,
  } = options;
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`a page holds at least one row, not ${pageSize}`);
  }
  const prefix = queuePrefix(sourceId);
  const queued = (key: RecordKey): string => prefix + key;
  const unqueued = (queuedKey: string): RecordKey => queuedKey.slice(prefix.length);

  function toReadRow(row: SqlRow): ReadRow {
    return {
      key: text(row, "record_key"),
      state: state(row),
      hash: text(row, "hash"),
      // A source of the store has no `where` filter: every record it holds is asked.
      excluded: false,
    };
  }

  function state(row: SqlRow): Record<string, StateValue> {
    const stored = jsonObject(row, "state");
    const picked: Record<string, StateValue> = {};
    for (const field of fields) {
      const value = stored[field];
      if (value !== null && typeof value !== "string") {
        throw new Error(
          `state field "${field}" is stored as ${typeof value}, expected text or null`,
        );
      }
      picked[field] = value;
    }
    return picked;
  }

  const recordColumns =
    "record_key, state::text as state, hash, status, decision::text as decision, reviewed";

  async function* watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    // Keys already announced and still waiting; a key that was claimed and queued again is announced again.
    let announced = new Set<RecordKey>();
    while (!isClosed()) {
      const rows = await client.query(jobsQueries.waiting, [prefix, WATCH_BATCH]);
      const waiting = rows.map((row) => unqueued(text(row, "record_key")));
      const fresh = waiting.filter((key) => !announced.has(key));
      announced = new Set(waiting);
      if (fresh.length > 0) {
        yield fresh;
      }
      await clock.sleep(pollMs);
    }
  }

  async function read(keys: readonly RecordKey[]): Promise<ReadResult> {
    const wanted = [...new Set(keys)];
    if (wanted.length === 0) {
      return { rows: [], missing: [] };
    }
    const result = await client.query(
      `select record_key, state::text as state, hash from facetdb.records
        where source_id = $1 and record_key = any($2::text[])`,
      [sourceId, wanted],
    );
    const found = new Map(result.map((row) => [text(row, "record_key"), toReadRow(row)]));
    const rows: ReadRow[] = [];
    const missing: RecordKey[] = [];
    for (const key of wanted) {
      const row = found.get(key);
      if (row === undefined) {
        missing.push(key);
      } else {
        rows.push(row);
      }
    }
    return { rows, missing };
  }

  async function write(
    key: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    // One conditional update: the hash is compared and the decision stored in the same statement, so
    // a state that changed after the read is never overwritten. `reviewed` can only turn on.
    const rows = await client.query(
      `update facetdb.records
          set decision = $3::jsonb, status = $4, reviewed = reviewed or $5::boolean,
              updated_at = ${fromMs("$6")}
        where source_id = $1 and record_key = $2 and hash = $7
        returning record_key`,
      [
        sourceId,
        key,
        JSON.stringify({ decisions: decision.decisions, status: decision.status }),
        decision.status,
        decision.reviewed === true,
        clock.now(),
        expectedHash,
      ],
    );
    return { written: rows.length > 0 };
  }

  async function scan(cursor: ScanCursor | null): Promise<ScanPage> {
    // Keyset paging by key, highest first: rows added meanwhile never shift a page.
    const rows =
      cursor === null
        ? await client.query(
            `select record_key, state::text as state, hash from facetdb.records
              where source_id = $1 order by record_key ${BYTE_ORDER} desc limit $2`,
            [sourceId, pageSize + 1],
          )
        : await client.query(
            `select record_key, state::text as state, hash from facetdb.records
              where source_id = $1 and record_key ${BYTE_ORDER} < $2
              order by record_key ${BYTE_ORDER} desc limit $3`,
            [sourceId, cursor, pageSize + 1],
          );
    const visible = rows.slice(0, pageSize).map(toReadRow);
    const last = visible.at(-1);
    return { rows: visible, next: rows.length > pageSize && last !== undefined ? last.key : null };
  }

  async function upsertRecord(
    key: RecordKey,
    values: Readonly<Record<string, StateValue>>,
  ): Promise<boolean> {
    const hash = stateHash(fields, values);
    const stored = Object.fromEntries(fields.map((field) => [field, values[field]]));
    return client.transaction(async (query) => {
      const changed = await query(
        `insert into facetdb.records (source_id, record_key, state, hash, status)
         values ($1, $2, $3::jsonb, $4, 'pending')
         on conflict (source_id, record_key) do update
           set state = excluded.state, hash = excluded.hash, status = 'pending', updated_at = now()
           where facetdb.records.hash is distinct from excluded.hash
         returning record_key`,
        [sourceId, key, JSON.stringify(stored), hash],
      );
      if (changed.length === 0) {
        return false;
      }
      // A worker may hold this record's job right now, asking about the old state; its ack must not
      // delete the job for the new one, so the claim is taken away.
      await query(jobsQueries.requeue, [[queued(key)]]);
      return true;
    });
  }

  async function getRecord(key: RecordKey): Promise<StoredRecord | undefined> {
    const rows = await client.query(
      `select ${recordColumns} from facetdb.records where source_id = $1 and record_key = $2`,
      [sourceId, key],
    );
    const row = rows[0];
    if (row === undefined) {
      return undefined;
    }
    // The stored decision is what was last written, with the status it was written under; the
    // record's own status moves on (to pending) when its state changes.
    const written = jsonOrNull(row, "decision") as Pick<
      RecordDecision,
      "decisions" | "status"
    > | null;
    const reviewed = flag(row, "reviewed");
    return {
      key,
      state: state(row),
      hash: text(row, "hash"),
      status: text(row, "status") as RecordStatus,
      decision:
        written === null ? null : { ...written, ...(reviewed ? { reviewed: true as const } : {}) },
    };
  }

  return {
    capabilities: CAPABILITIES,
    // The store's tables are created at start; install brings them up to date, which is a no-op
    // when they are. A source adds no objects of its own, so there is nothing for uninstall to
    // remove: the records and the log are the customer's data and go only by an explicit purge.
    install: () => migrateStore(client),
    uninstall: () => Promise.resolve(),
    watch,
    read,
    write,
    scan,
    upsertRecord,
    getRecord,
    async enqueue(keys) {
      if (keys.length > 0) {
        await client.query(jobsQueries.enqueue, [keys.map(queued)]);
      }
    },
    async claim(limit) {
      if (limit < 1) {
        return [];
      }
      const rows = await client.query(jobsQueries.claim, [
        prefix,
        workerId,
        limit,
        clock.now(),
        CLAIM_LEASE_MS,
      ]);
      return rows.map((row) => unqueued(text(row, "record_key")));
    },
    async claimKey(key) {
      const rows = await client.query(jobsQueries.claimKey, [queued(key), workerId, clock.now()]);
      return rows.length > 0;
    },
    async ack(keys) {
      if (keys.length > 0) {
        await client.query(jobsQueries.ack, [workerId, keys.map(queued)]);
      }
    },
    async release(keys) {
      if (keys.length > 0) {
        await client.query(jobsQueries.release, [workerId, keys.map(queued)]);
      }
    },
  };
}
