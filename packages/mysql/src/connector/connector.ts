import { randomUUID } from "node:crypto";
import {
  answerColumns,
  type Capabilities,
  type Clock,
  type CurrentDecision,
  EngineRefusal,
  type EngineTarget,
  type OpenConnector,
  parseCurrent,
  REVIEWED_COLUMN,
  type ReadResult,
  type ReadRow,
  type RecordDecision,
  type RecordKey,
  type ScanCursor,
  type ScanPage,
  STATUS_COLUMN,
  type StateValue,
  stateHash,
  UPDATED_AT_COLUMN,
  type WriteResult,
} from "@facetdb/core";
import { JOBS_TABLE, readPrimaryKey, readTableType, sideTableName } from "../install/index.ts";
import { type MysqlRow, quoteIdent, quoteTable } from "../sql/index.ts";
import {
  connectMysqlPool,
  DEFAULT_MAX_CONNECTIONS,
  type MysqlPool,
  type MysqlPoolConnect,
  rowsOf,
} from "./client.ts";

/**
 * The MySQL and MariaDB runtime connector. The triggers the install makes queue a changed record's
 * key in the database's one `facetdb_jobs`, shared by every installed table and keyed by
 * `(table_name, record_key)`, the key as the utf8mb4 bytes of its text; this connector polls it
 * every second through the clock, claims with one atomic `update … order by … limit` that stamps a
 * claim token and a lease, then reads its claims back by the token, and settles them by the token
 * too. One SQL text for both engines: MariaDB 10.5 has no `skip locked` and no `update …
 * returning`, so the token is what tells a claim apart. Every queue statement carries `table_name =
 * ?`, the table as the config spells it, which is what the triggers write.
 *
 * Times are the clock's, written and compared as UTC text (`YYYY-MM-DD hh:mm:ss.fff`, what a
 * `datetime(3)` prints): a fake clock decides whose lease ended, and the driver's timezone setting
 * plays no part, since the connector never asks it for a Date.
 *
 * `write` holds no lock across a round trip: the row is updated in one statement only where its
 * state still equals, byte for byte, the state whose hash the model was sent (the state the last
 * `read` of the key returned, or a fresh select's), so the only lock the worker takes on a customer
 * row is the update's own; the database checks it on the very row it locks, as Postgres's SQL hash
 * does, and nothing waits between a `select … for update` and a commit. Only FacetDB's columns are
 * ever set.
 *
 * No settle waits on another transaction's job row while holding one: it locks its batch with `for
 * update nowait` first, writes exactly the rows it locked, and goes one key at a time when it
 * cannot lock; `enqueue` and `claimKey` are one row each. The claim's `update … limit` is the one
 * statement that may wait holding rows it has stamped: on a locked job row whose committed version
 * still matches (this shape was chosen over a MariaDB 10.6 floor with `skip locked`). It runs under
 * `read committed` (every pool connection sets it as it opens, `SESSION_STATEMENTS`), where InnoDB
 * skips a locked row whose committed version no longer matches rather than wait for it, and locks
 * no gaps. The same connection setup drops `NO_BACKSLASH_ESCAPES` from the worker's own sessions,
 * the mode install refuses, since mysql2 escapes with backslashes.
 *
 * In side-table mode the record's answers are its row of `facetdb_<table>_answers`: `read`, `scan`
 * and the queue are the table's as inline, while `write` and `current` go to the side table, and
 * the worker holds no right to write the table at all. The hash check cannot be a guard on the row
 * the write updates, since the state is on another table, nor a locking read of the record: MySQL 8
 * refuses `select … for update` to an account with select alone (error 1142), and a locked read of
 * the record taken while holding the side row would close a cycle with an application transaction,
 * which holds the record and waits for the side row in its trigger. So the write locks the side row
 * first (creating it from the record when it has none), then reads the record's state as committed
 * and writes only when its hash is the one sent, in one short transaction. Every state change
 * upserts that same side row in its trigger, inside the application's transaction, so a change
 * either committed before the lock (and the read sees it) or waits on the lock until the write
 * committed (and then sets the row back to pending under `reset`, and queues the record again). The
 * write's one lock on the customer's row is the shared lock the foreign key's check takes when the
 * upsert creates a side row. Every lock involved is an InnoDB row lock (install refuses a table of
 * another engine, whose table locks InnoDB's deadlock detection cannot see), so a cycle with an
 * unusual application transaction (one in repeatable read whose trigger holds a gap lock of the
 * side table) is broken by InnoDB at once, rolling back the lighter side, most often the worker's,
 * whose write then fails with error 1213 and writes nothing.
 */

/** The jobs table is polled every second. */
export const POLL_MS = 1_000;

/**
 * How long a claim holds a job when its worker never acks or releases it (the process died in
 * flight): longer than the 10-minute retry window, as on Postgres.
 */
export const CLAIM_LEASE_MS = 15 * 60_000;

/** What MySQL and MariaDB can do: inline columns, a side table, several workers. */
export const MYSQL_CAPABILITIES: Capabilities = {
  inlineColumns: true,
  pushWakeup: false,
  transactions: true,
  sideTable: true,
  multipleWorkers: true,
};

/** The column that marks when a record was created, when the table has it (as the Postgres scan). */
export const CREATION_COLUMN = "created_at";

/** Column types a creation marker may have: anything else would not order by time. */
const MARKER_TYPES: ReadonlySet<string> = new Set(["datetime", "timestamp", "date"]);

/** Keys a watch announces per pass. */
const WATCH_BATCH = 200;

/** Rows per `scan` page, as on Postgres. */
const SCAN_PAGE_SIZE = 500;

/** Keys per `in` list: the driver writes the list into the statement, well under `max_allowed_packet`. */
const IN_LIST = 500;

/**
 * How many records' last-read state the connector keeps for `write`: the worker writes the records
 * of the batch it has just read, so a few hundred cover it, and the oldest go first.
 */
const STATE_CACHE = 1_000;

/** MySQL's `ER_DUP_ENTRY`: the row `claimKey` would insert is queued already. */
const DUPLICATE_ENTRY = 1062;

/** `ER_NO_REFERENCED_ROW_2`: a side row's record was deleted while the write waited for it. */
const NO_PARENT = 1452;

/**
 * A `for update nowait` that could not lock a row, or a cycle InnoDB broke: MySQL's
 * `ER_LOCK_NOWAIT` (3572), MariaDB's `ER_LOCK_WAIT_TIMEOUT` (1205, what its `nowait` reports) and
 * `ER_LOCK_DEADLOCK` (1213). The settle then goes one key at a time.
 */
const LOCK_REFUSED: ReadonlySet<number> = new Set([3572, 1205, 1213]);

function lockRefused(error: unknown): boolean {
  const number = errorNumber(error);
  return number !== undefined && LOCK_REFUSED.has(number);
}

export type MysqlConnectorDeps = {
  readonly clock: Clock;
  /** Names this worker's claims; a fresh id when absent. */
  readonly workerId?: string;
  /** Opens the pool; mysql2 by default, a test passes its own. */
  readonly connect?: MysqlPoolConnect;
  /** The most connections the pool opens at once; mysql2's 10 when absent. */
  readonly maxConnections?: number;
  /** The poll of `watch`; 1 second by default. */
  readonly pollMs?: number;
  /** Rows per `scan` page; 500 by default, a test pages smaller to cross page boundaries. */
  readonly scanPageSize?: number;
  /**
   * `facetdb migrate` and `facetdb uninstall` for `Connector.install` and `uninstall`; without it
   * both reject: the CLI installs through the engine's plans, shown before they run.
   */
  readonly installer?: {
    install(): Promise<void>;
    uninstall(): Promise<void>;
  };
};

export type MysqlConnector = OpenConnector & {
  readonly workerId: string;
};

/** The clock's time as a `datetime(3)` literal in UTC: what the queue's columns hold and compare. */
export function mysqlTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** A `datetime(3)` read back as text (`cast(… as char)`), as milliseconds; NaN for anything else. */
export function parseMysqlTime(text: string): number {
  return Date.parse(`${text.replace(" ", "T")}Z`);
}

/** A claim token: 32 hex characters, the queue's `char(32)`, unique across every worker. */
function claimToken(): string {
  return randomUUID().replaceAll("-", "");
}

/** A `varbinary` key as the driver returns it (a Buffer of its utf8mb4 bytes), or text, as text. */
function keyText(value: unknown, column: string): string {
  if (Buffer.isBuffer(value)) {
    return value.toString("utf8");
  }
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`column "${column}" came back as ${typeof value}, expected bytes or text`);
}

function stateText(value: unknown, column: string): StateValue {
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`column "${column}" came back as ${typeof value}, expected text`);
}

function textOf(row: MysqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`column "${column}" came back as ${typeof value}, expected text`);
  }
  return value;
}

/** A `cast(… as char)` of one of FacetDB's columns: text, or NULL. */
function textOrNull(value: unknown, column: string): string | null {
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`column "${column}" came back as ${typeof value}, expected text`);
}

/** A noul answer as MySQL prints its `boolean` (1 or 0), as the text `parseCurrent` reads. */
function yesNo(value: unknown, column: string): string | null {
  if (value === null) {
    return null;
  }
  if (value === "1" || value === "0") {
    return value === "1" ? "true" : "false";
  }
  throw new Error(`column "${column}" holds ${String(value)}, expected 1 or 0`);
}

/** A `boolean` column as the driver returns its `tinyint(1)`. */
function flag(value: unknown, column: string): boolean {
  if (value === 0 || value === 1) {
    return value === 1;
  }
  throw new Error(`column "${column}" holds ${String(value)}, expected 1 or 0`);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let from = 0; from < items.length; from += size) {
    out.push(items.slice(from, from + size));
  }
  return out;
}

/** The server's error number, read off the driver's error (a boundary). */
function errorNumber(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("errno" in error)) {
    return undefined;
  }
  return typeof error.errno === "number" ? error.errno : undefined;
}

/** A scan cursor: the last row's ordering values as JSON, the key last. */
type Position = { readonly key: string; readonly created?: string | null };

function cursorOf(position: Position): ScanCursor {
  return JSON.stringify(
    position.created === undefined ? [position.key] : [position.created, position.key],
  );
}

/** A cursor is a boundary: it may come from a saved backfill. */
function parseCursor(cursor: ScanCursor, byCreation: boolean): Position {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    parsed = undefined;
  }
  const invalid = () => new Error(`"${cursor}" is not a scan cursor of a MySQL source`);
  if (!Array.isArray(parsed)) {
    throw invalid();
  }
  if (!byCreation) {
    const [key] = parsed;
    if (parsed.length !== 1 || typeof key !== "string") {
      throw invalid();
    }
    return { key };
  }
  const [created, key] = parsed;
  if (
    parsed.length !== 2 ||
    typeof key !== "string" ||
    (created !== null && typeof created !== "string")
  ) {
    throw invalid();
  }
  return { key, created };
}

function primaryKeyRefusal(message: string): EngineRefusal {
  return new EngineRefusal({
    code: "primary-key",
    message,
    fix: "run facetdb migrate first; a table needs a single-column primary key, FacetDB keys its answers by it",
  });
}

/**
 * The runtime connector of one installed table, under the worker login's `url`. The table's key is
 * read from the catalog as the worker sees it; a table it cannot see, or one without a single-column
 * key, is refused (`EngineRefusal`). The pool opens here and closes with `close`.
 */
export async function createMysqlConnector(
  target: EngineTarget,
  url: string,
  deps: MysqlConnectorDeps,
): Promise<MysqlConnector> {
  const { clock, installer } = deps;
  const workerId = deps.workerId ?? `worker-${randomUUID()}`;
  const pollMs = deps.pollMs ?? POLL_MS;
  const pageSize = deps.scanPageSize ?? SCAN_PAGE_SIZE;
  if (!Number.isInteger(pollMs) || pollMs < 1) {
    throw new Error(`the poll interval is a positive number of milliseconds, not ${pollMs}`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`a page holds at least one row, not ${pageSize}`);
  }
  const pool: MysqlPool = (deps.connect ?? connectMysqlPool)(url, {
    maxConnections: deps.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
  });
  const rows = rowsOf(pool.query);
  const subject = target.urlVariable ?? "the source's connection string";
  let schema: string;
  let keyName: string;
  try {
    const named = target.schema ?? (await currentDatabase());
    if (named === undefined) {
      throw new EngineRefusal({
        code: "no-database",
        message: `${subject} names no database, and the source names no database for the table ${target.table}`,
        fix: `add the database to ${subject} (mysql://facetdb_worker:<password>@host:3306/<database>), or name the table as <database>.${target.table} in the config`,
      });
    }
    schema = named;
    keyName = await keyOf(schema);
    if (target.storage === "side-table") {
      await sideTableOf(schema);
    }
  } catch (error) {
    await pool.close();
    throw error;
  }

  async function currentDatabase(): Promise<string | undefined> {
    const value = (await rows("select database() as name"))[0]?.["name"];
    return value === null || value === undefined ? undefined : String(value);
  }

  /**
   * The key the queue holds for each record, by the install's rule: the table's one-column primary
   * key. A config naming another column disagrees with the table and is refused, as install refuses
   * it. `information_schema` shows the worker login only the tables it has a right on, so an
   * uninstalled table reads as missing.
   */
  async function keyOf(inSchema: string): Promise<string> {
    const label = `${inSchema}.${target.table}`;
    const type = await readTableType(rows, inSchema, target.table);
    if (type === undefined) {
      throw new EngineRefusal({
        code: "no-table",
        message: `${label} does not exist, or the worker login has no right on it`,
        fix: "point the source at the table FacetDB was installed on, and run facetdb migrate on it first",
      });
    }
    const primary = await readPrimaryKey(rows, inSchema, target.table);
    const [only] = primary;
    if (only === undefined || primary.length > 1) {
      throw primaryKeyRefusal(
        `${label} needs a single-column primary key, and ${only === undefined ? "has none" : "has a composite one"}`,
      );
    }
    if (target.key !== undefined && target.key !== only) {
      throw primaryKeyRefusal(
        `${label}'s primary key is ${only}, not ${target.key}; the config and the table disagree`,
      );
    }
    return only;
  }

  /**
   * In side-table mode, the side table the worker writes: refused at open rather than at the first
   * write, in words that say what to run. The worker sees it only when install granted it.
   */
  async function sideTableOf(inSchema: string): Promise<void> {
    const side = sideTableName(target.table);
    if ((await readTableType(rows, inSchema, side)) === undefined) {
      throw new EngineRefusal({
        code: "no-side-table",
        message: `${inSchema}.${side}, where side-table mode keeps the answers of ${inSchema}.${target.table}, does not exist, or the worker login has no right on it`,
        fix: "run facetdb migrate with storage side-table for this source first",
      });
    }
  }

  const { questionSet } = target;
  const fields = questionSet.read;
  /** The table as the config spells it: what the triggers write into `table_name`. */
  const name = target.table;
  const table = quoteTable(schema, name);
  const jobs = quoteTable(schema, JOBS_TABLE);
  const keyColumn = quoteIdent(keyName);
  const sideMode = target.storage === "side-table";
  /** Where a decision is written and `current` reads it: the table inline, the side table else. */
  const answers = sideMode ? quoteTable(schema, sideTableName(name)) : table;
  /** A value as its utf8mb4 text, the form `stateHash` and the key compare in. */
  const asText = (column: string, alias?: string) =>
    `cast(${alias === undefined ? "" : `${alias}.`}${quoteIdent(column)} as char character set utf8mb4)`;
  // `where` is the source's own SQL filter from the config file, spliced as written (as on
  // Postgres): the config is the operator's code, not a user value.
  const excluded =
    questionSet.where === undefined ? "false" : `not coalesce((${questionSet.where}), false)`;
  const rowColumns = [
    `${asText(keyName)} as k`,
    ...fields.map((field, index) => `${asText(field)} as s${index}`),
    `(${excluded}) as x`,
  ].join(", ");
  /**
   * The state still equals what was read, byte for byte: the collation stays out of it (under the
   * usual `_ci` collations `'Scam' = 'scam'`), as the trigger's own comparison does, and two NULLs
   * are equal (`<=>`). The bound text is the connection's utf8mb4, so both sides are utf8mb4 bytes.
   */
  const stateGuard = fields
    .map((field) => `cast(${asText(field)} as binary) <=> cast(? as binary)`)
    .join(" and ");

  function parseRow(row: MysqlRow): ReadRow {
    const state: Record<string, StateValue> = {};
    fields.forEach((field, index) => {
      state[field] = stateText(row[`s${index}`], field);
    });
    return {
      key: textOf(row, "k"),
      state,
      hash: stateHash(fields, state),
      excluded: row["x"] === 1,
    };
  }

  /** The state each key last read as, for `write`'s guard (the newest last; the oldest leave first). */
  const lastRead = new Map<RecordKey, ReadRow>();
  function remember(row: ReadRow): void {
    lastRead.delete(row.key);
    lastRead.set(row.key, row);
    if (lastRead.size > STATE_CACHE) {
      const oldest = lastRead.keys().next();
      if (oldest.done !== true) {
        lastRead.delete(oldest.value);
      }
    }
  }

  /** The token each key this worker holds was claimed under; `ack` and `release` settle by it. */
  const tokens = new Map<RecordKey, string>();
  function byToken(keys: readonly RecordKey[]): Map<string, RecordKey[]> {
    const groups = new Map<string, RecordKey[]>();
    for (const key of new Set(keys)) {
      const token = tokens.get(key);
      if (token !== undefined) {
        groups.set(token, [...(groups.get(token) ?? []), key]);
      }
    }
    return groups;
  }

  /** The two settles: what the batch statement and the one-key statement do to a held job. */
  const SETTLES = {
    ack: `delete from ${jobs}`,
    release: `update ${jobs} set claimed_at = null, claimed_by = null, claim_token = null`,
  } as const;

  /**
   * Settles the keys this worker holds, by their tokens. A batch is one short transaction: the rows
   * are locked first with `for update nowait`, which never waits, then written in one statement
   * that touches only rows this transaction holds. When the probe cannot lock a row (an application
   * transaction whose trigger just cleared that job's claim holds it), the batch is given up and
   * each key is settled in a statement of its own, which may wait but holds nothing while it waits:
   * a statement that waited holding other job rows could close a cycle with the application's
   * transaction, and InnoDB breaks a cycle by rolling back the lighter side, which is the
   * application's. A key's token is forgotten only once its settle ran; a settle that threw leaves
   * the claim to its lease.
   */
  async function settle(kind: keyof typeof SETTLES, keys: readonly RecordKey[]): Promise<void> {
    const statement = SETTLES[kind];
    for (const [token, group] of byToken(keys)) {
      for (const part of chunks(group, IN_LIST)) {
        const whole = await pool
          .transaction(async (tx) => {
            // Exactly the rows the probe locked are written: a job whose claim was cleared and
            // committed before the probe is not among them, so nothing of this statement can wait
            // on a transaction that takes it in between.
            const held = (
              await tx(
                `select record_key from ${jobs} where table_name = ? and claim_token = ? and record_key in (?) for update nowait`,
                [name, token, part],
              )
            ).rows.map((row) => keyText(row["record_key"], "record_key"));
            if (held.length > 0) {
              await tx(
                `${statement} where table_name = ? and claim_token = ? and record_key in (?)`,
                [name, token, held],
              );
            }
            return true;
          })
          .catch((error: unknown) => {
            if (!lockRefused(error)) {
              throw error;
            }
            return false;
          });
        if (!whole) {
          for (const key of part) {
            await pool.query(
              `${statement} where table_name = ? and claim_token = ? and record_key = ?`,
              [name, token, key],
            );
          }
        }
        for (const key of part) {
          tokens.delete(key);
        }
      }
    }
  }

  // `close()` sets the flag while `watch` awaits; read through a call so TypeScript does not narrow it.
  let closed = false;
  const isClosed = () => closed;
  let wake: (() => void) | undefined;

  async function* watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    // Keys already announced and still waiting are not announced again; a key claimed and queued
    // again is.
    let announced = new Set<RecordKey>();
    while (!isClosed()) {
      const waiting = (
        await rows(
          `select record_key from ${jobs} where table_name = ? and claimed_at is null order by enqueued_at, record_key limit ?`,
          [name, WATCH_BATCH],
        )
      ).map((row) => keyText(row["record_key"], "record_key"));
      const fresh = waiting.filter((one) => !announced.has(one));
      announced = new Set(waiting);
      if (fresh.length > 0) {
        yield fresh;
      }
      if (isClosed()) {
        return;
      }
      await Promise.race([
        clock.sleep(pollMs),
        new Promise<void>((resolve) => {
          wake = resolve;
        }),
      ]);
      wake = undefined;
    }
  }

  async function read(keys: readonly RecordKey[]): Promise<ReadResult> {
    const wanted = [...new Set(keys)];
    const found = new Map<RecordKey, ReadRow>();
    for (const part of chunks(wanted, IN_LIST)) {
      // The key binds as a literal the server converts to the column's type: '42' finds 42.
      const result = await rows(`select ${rowColumns} from ${table} where ${keyColumn} in (?)`, [
        part,
      ]);
      for (const row of result) {
        const parsed = parseRow(row);
        found.set(parsed.key, parsed);
        remember(parsed);
      }
    }
    const out: ReadRow[] = [];
    const missing: RecordKey[] = [];
    for (const one of wanted) {
      const row = found.get(one);
      if (row === undefined) {
        missing.push(one);
      } else {
        out.push(row);
      }
    }
    return { rows: out, missing };
  }

  /**
   * The columns a decision sets: answer columns per question role, the status, the update time, and
   * the reviewed flag only when the decision carries it (set once, never cleared). A choice's
   * probability list is not in a decision; its column keeps what it holds.
   */
  function assignmentsFor(decision: RecordDecision): (readonly [string, unknown])[] {
    const out: (readonly [string, unknown])[] = [];
    for (const [question, answer] of Object.entries(decision.decisions)) {
      const asked = questionSet.questions.find((candidate) => candidate.name === question);
      if (asked === undefined) {
        throw new Error(`a decision names "${question}", which is not a question of this source`);
      }
      const decided = answer.kind === "decided" ? answer : undefined;
      for (const column of answerColumns(asked)) {
        switch (column.role) {
          case "value":
            out.push([column.name, decided?.value ?? null]);
            break;
          case "probability":
          case "confidence":
            out.push([column.name, decided?.probabilityOrConfidence ?? null]);
            break;
          case "expected":
            out.push([column.name, decided?.expected ?? null]);
            break;
          case "probabilities":
            break;
        }
      }
    }
    out.push([STATUS_COLUMN, decision.status]);
    out.push([UPDATED_AT_COLUMN, mysqlTime(clock.now())]);
    if (decision.reviewed === true) {
      out.push([REVIEWED_COLUMN, true]);
    }
    return out;
  }

  /**
   * The row is updated only where its state still equals the state whose hash was sent. The state
   * the last `read` returned for the key serves when its hash is the expected one; otherwise the
   * state is read and hashed first, and a hash already moved writes nothing. Either way the check
   * and the write are one statement on the row.
   */
  async function write(
    recordKey: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    const assignments = assignmentsFor(decision);
    if (sideMode) {
      return writeSide(recordKey, assignments, expectedHash);
    }
    const remembered = lastRead.get(recordKey);
    const sent =
      remembered !== undefined && remembered.hash === expectedHash
        ? remembered
        : (await rows(`select ${rowColumns} from ${table} where ${keyColumn} = ?`, [recordKey]))
            .map(parseRow)
            .find((one) => one.key === recordKey);
    if (sent === undefined || sent.hash !== expectedHash) {
      return { written: false };
    }
    const { affectedRows } = await pool.query(
      `update ${table} set ${assignments.map(([column]) => `${quoteIdent(column)} = ?`).join(", ")} where ${keyColumn} = ? and ${stateGuard}`,
      [
        ...assignments.map(([, value]) => value),
        recordKey,
        ...fields.map((field) => sent.state[field]),
      ],
    );
    return { written: affectedRows > 0 };
  }

  /**
   * Side-table mode's write (the header says why it takes this shape): one transaction of three
   * statements. The upsert locks the record's side row, inserting it from the record when it has
   * none (no record, no row, and no lock: the read below then finds nothing); its update assigns the
   * status to itself, which changes nothing and holds the row. Inserting a side row runs the foreign
   * key's check, which takes a shared lock on the customer's row until the commit; updating one that
   * exists takes nothing there. The state is then read as committed now (`read committed` takes a
   * fresh snapshot per statement, and the plain select adds no lock), and the side row is written
   * only when its hash is the one the model was sent. A stale answer leaves the row as it was:
   * pending with no answer when the upsert made it, which is what the view shows for a record
   * without one. A record deleted while the upsert waited fails the foreign key's check (error 1452,
   * `NO_PARENT`): the record is gone, so nothing is written, as when the read finds no row.
   */
  async function writeSide(
    recordKey: RecordKey,
    assignments: readonly (readonly [string, unknown])[],
    expectedHash: string,
  ): Promise<WriteResult> {
    const status = quoteIdent(STATUS_COLUMN);
    return pool.transaction(async (tx): Promise<WriteResult> => {
      try {
        await tx(
          `insert into ${answers} (${keyColumn}) select ${keyColumn} from ${table} where ${keyColumn} = ? on duplicate key update ${status} = ${status}`,
          [recordKey],
        );
      } catch (error) {
        if (errorNumber(error) === NO_PARENT) {
          return { written: false };
        }
        throw error;
      }
      const now = (
        await tx(`select ${rowColumns} from ${table} where ${keyColumn} = ?`, [recordKey])
      ).rows
        .map(parseRow)
        .find((one) => one.key === recordKey);
      if (now === undefined || now.hash !== expectedHash) {
        return { written: false };
      }
      const { affectedRows } = await tx(
        `update ${answers} set ${assignments.map(([column]) => `${quoteIdent(column)} = ?`).join(", ")} where ${keyColumn} = ?`,
        [...assignments.map(([, value]) => value), recordKey],
      );
      return { written: affectedRows > 0 };
    });
  }

  /** The aliases `parseCurrent` reads, each of FacetDB's answer columns as text, a noul converted. */
  const currentColumns = questionSet.questions.flatMap((question, index) =>
    answerColumns(question).flatMap((column) => {
      const alias =
        column.role === "value"
          ? "v"
          : column.role === "probability" || column.role === "confidence"
            ? "p"
            : column.role === "expected"
              ? "e"
              : undefined;
      return alias === undefined
        ? []
        : [
            {
              alias: `q${index}${alias}`,
              column: column.name,
              noul: alias === "v" && question.type === "noul",
            },
          ];
    }),
  );
  // Inline the columns are the table's own; in side-table mode they are read through the alias `a`
  // of the side table, joined to the table so that a deleted record's leftover side row (one no
  // foreign key took with it) names no record, as the view shows it.
  const side = sideMode ? "a" : undefined;
  const currentSelect = [
    `${asText(keyName, side)} as k`,
    ...currentColumns.map(({ alias, column }) => `${asText(column, side)} as ${alias}`),
    `${side === undefined ? "" : `${side}.`}${quoteIdent(STATUS_COLUMN)} as cs`,
    `${asText(UPDATED_AT_COLUMN, side)} as cu`,
    `${side === undefined ? "" : `${side}.`}${quoteIdent(REVIEWED_COLUMN)} as cr`,
  ].join(", ");
  const currentFrom = sideMode
    ? `from ${answers} a join ${table} t on t.${keyColumn} = a.${keyColumn} where a.${keyColumn} in (?)`
    : `from ${table} where ${keyColumn} in (?)`;

  async function current(
    keys: readonly RecordKey[],
  ): Promise<ReadonlyMap<RecordKey, CurrentDecision>> {
    const wanted = new Set(keys);
    const found = new Map<RecordKey, CurrentDecision>();
    for (const part of chunks([...wanted], IN_LIST)) {
      const result = await rows(`select ${currentSelect} ${currentFrom}`, [part]);
      for (const row of result) {
        const recordKey = textOf(row, "k");
        // A key of another form the column's type matched ('042' for 42) names no record.
        if (!wanted.has(recordKey)) {
          continue;
        }
        const updated = textOrNull(row["cu"], UPDATED_AT_COLUMN);
        const updatedMs = updated === null ? null : parseMysqlTime(updated);
        if (updatedMs !== null && Number.isNaN(updatedMs)) {
          throw new Error(`column "${UPDATED_AT_COLUMN}" holds "${updated}", not a datetime`);
        }
        const parsed: Record<string, unknown> = {
          cs: row["cs"],
          cu: updatedMs === null ? null : String(updatedMs),
          cr: flag(row["cr"], REVIEWED_COLUMN),
        };
        for (const { alias, column, noul } of currentColumns) {
          const value = textOrNull(row[alias], column);
          parsed[alias] = noul ? yesNo(value, column) : value;
        }
        const decision = parseCurrent(parsed, questionSet.questions);
        if (decision !== undefined) {
          found.set(recordKey, decision);
        }
      }
    }
    return found;
  }

  /**
   * Whether the table has a creation marker the worker may read: `information_schema.columns`
   * lists only the columns the login has a right on, and install grants the key, the state and
   * FacetDB's own, so the marker orders a scan only where the operator granted it (else the key,
   * newest first for a growing key). Looked up once, at the first page.
   */
  let marker: Promise<boolean> | undefined;
  const byCreation = (): Promise<boolean> => {
    marker ??= rows(
      "select data_type as data_type from information_schema.columns where table_schema = ? and table_name = ? and column_name = ?",
      [schema, name, CREATION_COLUMN],
    ).then((found) => {
      const type = found[0]?.["data_type"];
      return typeof type === "string" && MARKER_TYPES.has(type.toLowerCase());
    });
    return marker;
  };

  /**
   * Every record, newest first, in pages, by keyset: the creation marker then the key where the
   * marker is readable, else the key alone, so rows that arrive or get answered between pages
   * neither shift a page nor repeat a record. `desc` puts a null marker last on both engines.
   */
  async function scan(cursor: ScanCursor | null): Promise<ScanPage> {
    const ordered = await byCreation();
    const position = cursor === null ? undefined : parseCursor(cursor, ordered);
    const created = quoteIdent(CREATION_COLUMN);
    const params: unknown[] = [];
    let where = "";
    if (position !== undefined) {
      if (!ordered) {
        where = ` where ${keyColumn} < ?`;
        params.push(position.key);
      } else if (position.created === null || position.created === undefined) {
        // Nulls sort last: after a null marker only smaller keys among the nulls remain.
        where = ` where ${created} is null and ${keyColumn} < ?`;
        params.push(position.key);
      } else {
        where = ` where (${created} < ? or (${created} = ? and ${keyColumn} < ?) or ${created} is null)`;
        params.push(position.created, position.created, position.key);
      }
    }
    const select = ordered ? `${asText(CREATION_COLUMN)} as o, ${rowColumns}` : rowColumns;
    const order = ordered ? `${created} desc, ${keyColumn} desc` : `${keyColumn} desc`;
    const result = await rows(`select ${select} from ${table}${where} order by ${order} limit ?`, [
      ...params,
      pageSize,
    ]);
    const parsed = result.map(parseRow);
    const last = result.at(-1);
    const lastRow = parsed.at(-1);
    let next: ScanCursor | null = null;
    if (result.length >= pageSize && last !== undefined && lastRow !== undefined) {
      next = cursorOf(
        ordered
          ? { key: lastRow.key, created: textOrNull(last["o"], CREATION_COLUMN) }
          : { key: lastRow.key },
      );
    }
    return { rows: parsed, next };
  }

  return {
    capabilities: MYSQL_CAPABILITIES,
    workerId,
    install() {
      if (installer === undefined) {
        return Promise.reject(
          new Error(
            "install runs through the engine's plan, shown before it runs: run `facetdb migrate`, or pass an installer",
          ),
        );
      }
      return installer.install();
    },
    uninstall() {
      if (installer === undefined) {
        return Promise.reject(
          new Error(
            "uninstall runs through the engine's plan, shown before it runs: run `facetdb uninstall`, or pass an installer",
          ),
        );
      }
      return installer.uninstall();
    },
    watch,
    read,
    write,
    current,
    scan,
    /**
     * One statement per key (never a multi-row insert: it would wait on a job row an open
     * application transaction holds while holding the rows it inserted), each the no-op upsert the
     * install's claim uses: a key queued already stays one row and keeps its claim, as Postgres's
     * `enqueue` does, since only a change of the record's state (the trigger's upsert) takes a
     * claim away. Not `insert ignore`, which turns a too-long key's error into a truncated key.
     */
    async enqueue(keys) {
      for (const one of new Set(keys)) {
        await pool.query(
          `insert into ${jobs} (table_name, record_key) values (?, ?) on duplicate key update table_name = table_name`,
          [name, one],
        );
      }
    },
    /**
     * One atomic update stamps this claim's token, this worker and the lease's start on the oldest
     * unclaimed jobs and those whose lease ended, in queue order; a second worker's update waits
     * for the rows this one holds and then finds them claimed. The claims are read back by the
     * token, which nothing else ever writes.
     */
    async claim(limit) {
      if (limit < 1) {
        return [];
      }
      const now = clock.now();
      const token = claimToken();
      const { affectedRows } = await pool.query(
        `update ${jobs} set claim_token = ?, claimed_by = ?, claimed_at = ? where table_name = ? and (claimed_at is null or claimed_at < ?) order by enqueued_at, record_key limit ?`,
        [token, workerId, mysqlTime(now), name, mysqlTime(now - CLAIM_LEASE_MS), limit],
      );
      if (affectedRows === 0) {
        return [];
      }
      const claimed = (
        await rows(`select record_key from ${jobs} where table_name = ? and claim_token = ?`, [
          name,
          token,
        ])
      ).map((row) => keyText(row["record_key"], "record_key"));
      for (const key of claimed) {
        tokens.set(key, token);
      }
      return claimed;
    },
    /**
     * Inserts the job already claimed, in one committed statement: the queue's key refuses a row
     * for a key queued already (error 1062), claimed or not, and that is the false. Never a row
     * held across the model call: the app's trigger would wait on it.
     */
    async claimKey(recordKey) {
      const token = claimToken();
      try {
        await pool.query(
          `insert into ${jobs} (table_name, record_key, claimed_by, claimed_at, claim_token) values (?, ?, ?, ?, ?)`,
          [name, recordKey, workerId, mysqlTime(clock.now()), token],
        );
      } catch (error) {
        if (errorNumber(error) === DUPLICATE_ENTRY) {
          return false;
        }
        throw error;
      }
      tokens.set(recordKey, token);
      return true;
    },
    /**
     * By the token each key was claimed under: a job whose claim the trigger cleared (the record
     * changed) or whose lease ended and another worker took stays, to be asked again at its new
     * state.
     */
    ack: (keys) => settle("ack", keys),
    release: (keys) => settle("release", keys),
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      wake?.();
      await pool.close();
    },
  };
}
