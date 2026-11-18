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
import {
  JOBS_TABLE,
  OWNERS_TABLE,
  readTable,
  type SqliteQuery,
  type SqliteRow,
  sameName,
  type TableFacts,
  textOf,
} from "../install/index.ts";
import { quoteIdent } from "../sql/index.ts";
import {
  type OpenSqlite,
  openNodeSqlite,
  type SqliteClient,
  type SqliteParam,
  type SqliteStatements,
} from "./client.ts";
import { LOCK_HEARTBEAT_MS, type Repeat, repeatEvery } from "./heartbeat.ts";

/**
 * The SQLite runtime connector. The triggers the install makes queue a changed record's key in the
 * file's one `facetdb_jobs`, shared by every installed table and keyed by `(table_name,
 * record_key)`; this connector polls it every second through the clock, claims with one `update …
 * returning` under a 15-minute lease, reads the state fields and hashes them with core's
 * `stateHash`, and writes a decision inside `begin immediate` only while the state still hashes to
 * what was sent. Every queue statement names the table as the file spells it (`table_name` compares
 * case-sensitively). Times are the clock's, as ISO text, the form the queue's own defaults write.
 *
 * One worker: `watch` and `claim`, the queue worker's calls, take the lock row of the table in
 * `facetdb_table_owners` (`worker_id`, `heartbeat_at`) and renew it every poll and every claim, and
 * refuse while another worker's lock on the file is fresh, saying who holds it, when it last
 * renewed it and when it frees; a lock not renewed for 2 minutes is taken over, and `close` lets go
 * of it. While it holds the lock, a heartbeat of its own renews it every 30 seconds, so a pass
 * waiting on the model keeps it. A backfill's `enqueue` and `claimKey`, and `read`, `write`, `scan`
 * and `current`, take no lock, so a backfill, `explain` or the review screen run beside the worker.
 */

/** The jobs table is polled every second. */
export const POLL_MS = 1_000;

/**
 * How long a claim holds a job when its worker never acks or releases it (the process died in
 * flight): longer than the 10-minute retry window, as on Postgres.
 */
export const CLAIM_LEASE_MS = 15 * 60_000;

/** A worker lock renewed within this is fresh: a second worker is refused; older, it is taken over. */
export const LOCK_FRESH_MS = 2 * 60_000;

/** What a SQLite file can do: inline columns only, one worker, no push. */
export const SQLITE_CAPABILITIES: Capabilities = {
  inlineColumns: true,
  pushWakeup: false,
  transactions: true,
  sideTable: false,
  multipleWorkers: false,
};

/** Keys a watch announces per pass. */
const WATCH_BATCH = 200;

/** Rows per `scan` page, as on Postgres. */
const SCAN_PAGE_SIZE = 500;

/** Keys per `in` list: well under SQLite's 32,766 bound parameters. */
const IN_LIST = 500;

export type SqliteConnectorDeps = {
  readonly clock: Clock;
  /** Names this worker's claims and its lock; a fresh id when absent. */
  readonly workerId?: string;
  /** Opens the file; node:sqlite by default (a missing file is refused, never created). */
  readonly open?: OpenSqlite;
  /**
   * How the connector's words name the database: the file's path by default; a libSQL server's
   * database by its host, never its URL, which the words never echo.
   */
  readonly label?: string;
  /** The poll of `watch`; 1 second by default. */
  readonly pollMs?: number;
  /** Rows per `scan` page; 500 by default, a test pages smaller to cross page boundaries. */
  readonly scanPageSize?: number;
  /**
   * Beats the lock's own heartbeat every `LOCK_HEARTBEAT_MS` while this worker holds the lock:
   * real timers by default (`repeatEvery`); a test passes its own, run by its fake clock.
   */
  readonly repeat?: Repeat;
  /**
   * Where the connector says what nobody is waiting on: a heartbeat that could not renew the lock,
   * once per run of failed beats. A line to stderr by default; a test passes its own.
   */
  readonly warn?: (line: string) => void;
  /**
   * `facetdb migrate` and `facetdb uninstall` for `Connector.install` and `uninstall`; without it
   * both reject: the CLI installs through the engine's plans, shown before they run.
   */
  readonly installer?: {
    install(): Promise<void>;
    uninstall(): Promise<void>;
  };
};

export type SqliteConnector = OpenConnector & {
  readonly workerId: string;
};

/**
 * The record's key: a column, or the rowid itself for a table keyed by its rowid. A column declared
 * with no type has no affinity, so a key bound as text never equals the integer it holds: such a
 * key is compared as text.
 */
type Key =
  | { readonly kind: "column"; readonly name: string; readonly untyped: boolean }
  | { readonly kind: "rowid" };

/** How a SQLite table names its rowid, when no column of the table is called so. */
const ROWID = "rowid";

function primaryKeyRefusal(message: string): EngineRefusal {
  return new EngineRefusal({
    code: "primary-key",
    message,
    fix: "run facetdb migrate first; a table needs a single-column primary key (or rowid named as the source's key), FacetDB keys its answers by it",
  });
}

/** The table as the file declares it, or the refusal that says why it cannot be opened. */
function tableOf(target: EngineTarget, found: Awaited<ReturnType<typeof readTable>>): TableFacts {
  if (found.kind === "table") {
    return found;
  }
  throw new EngineRefusal({
    code: "no-table",
    message:
      found.kind === "missing"
        ? `${target.table} does not exist in the SQLite file`
        : `${found.name} is a ${found.kind === "view" ? "view" : "virtual table"}, which FacetDB never installs on`,
    fix: "point the source at the table FacetDB was installed on, and run facetdb migrate on it first",
  });
}

/**
 * The key the queue holds for each record, by the install's rule: the table's one-column primary
 * key, or its rowid when the source names it. A config naming another column disagrees with the
 * table and is refused, as install refuses it. A BLOB key is refused: the queue holds keys as text.
 */
function keyOf(target: EngineTarget, table: TableFacts): Key {
  const column = (name: string) => table.columns.find((one) => sameName(one.name, name));
  if (target.key !== undefined && sameName(target.key, ROWID) && column(ROWID) === undefined) {
    if (table.withoutRowid) {
      throw primaryKeyRefusal(`${table.name} is a WITHOUT ROWID table, so it has no rowid`);
    }
    return { kind: "rowid" };
  }
  const primary = table.columns.filter((one) => one.pk > 0);
  const [only] = primary;
  if (only === undefined || primary.length > 1) {
    throw primaryKeyRefusal(
      `${table.name} needs a single-column primary key, and ${only === undefined ? "has none" : "has a composite one"}`,
    );
  }
  if (target.key !== undefined && !sameName(target.key, only.name)) {
    throw primaryKeyRefusal(
      `${table.name}'s primary key is ${only.name}, not ${target.key}; the config and the table disagree`,
    );
  }
  if (only.type.includes("blob")) {
    throw primaryKeyRefusal(
      `${table.name}'s primary key ${only.name} is a BLOB, which the queue and the decision log cannot hold as text`,
    );
  }
  return { kind: "column", name: only.name, untyped: only.type === "" };
}

/**
 * How the table's rowid is named in SQL: `rowid`, unless a column of the table is called so, then
 * SQLite's other two names for it.
 */
function rowidOf(table: TableFacts): string {
  const alias = ["rowid", "_rowid_", "oid"].find(
    (name) => !table.columns.some((column) => sameName(column.name, name)),
  );
  if (alias === undefined) {
    throw primaryKeyRefusal(
      `${table.name} has columns named rowid, _rowid_ and oid, so its rowid cannot be named`,
    );
  }
  return alias;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** A value read back as text, the form `parseCurrent` reads: a number as its shortest round trip. */
function textual(value: unknown, column: string): string | null {
  if (value === null || typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  throw new Error(`column "${column}" came back as ${typeof value}, expected text or a number`);
}

function stateText(value: unknown, column: string): StateValue {
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`column "${column}" came back as ${typeof value}, expected text`);
}

/** A noul answer as SQLite holds it (0 or 1), as the text `parseCurrent` reads. */
function yesNo(value: unknown, column: string): string | null {
  if (value === null) {
    return null;
  }
  if (value === 0 || value === 1) {
    return value === 1 ? "true" : "false";
  }
  throw new Error(`column "${column}" holds ${String(value)}, expected 0 or 1`);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let from = 0; from < items.length; from += size) {
    out.push(items.slice(from, from + size));
  }
  return out;
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/** A scan cursor: the last row's ordering value, a rowid or a key, as JSON. */
function cursorOf(value: unknown): ScanCursor {
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`a scan ordered by a value of type ${typeof value} cannot be resumed`);
  }
  return JSON.stringify([value]);
}

/** A cursor is a boundary: it may come from a saved backfill. */
function parseCursor(cursor: ScanCursor): string | number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(cursor);
  } catch {
    parsed = undefined;
  }
  const [value] = Array.isArray(parsed) && parsed.length === 1 ? parsed : [];
  if (typeof value !== "number" && typeof value !== "string") {
    throw new Error(`"${cursor}" is not a scan cursor of a SQLite source`);
  }
  return value;
}

/**
 * The runtime connector of one installed table of the SQLite file at `path`. The table's key is
 * read from the file; a missing table or one without a single-column key is refused
 * (`EngineRefusal`). The connection opens here and closes with `close`.
 */
export async function createSqliteConnector(
  target: EngineTarget,
  path: string,
  deps: SqliteConnectorDeps,
): Promise<SqliteConnector> {
  const { clock, installer } = deps;
  const repeat = deps.repeat ?? repeatEvery;
  const warn = deps.warn ?? ((line: string) => process.stderr.write(`${line}\n`));
  const workerId = deps.workerId ?? `worker-${randomUUID()}`;
  const pollMs = deps.pollMs ?? POLL_MS;
  const pageSize = deps.scanPageSize ?? SCAN_PAGE_SIZE;
  if (!Number.isInteger(pollMs) || pollMs < 1) {
    throw new Error(`the poll interval is a positive number of milliseconds, not ${pollMs}`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new Error(`a page holds at least one row, not ${pageSize}`);
  }
  const where = deps.label ?? path;
  const client: SqliteClient = (deps.open ?? openNodeSqlite)(path);
  let facts: TableFacts;
  let key: Key;
  let rowid: string | undefined;
  try {
    const query: SqliteQuery = (sql, params = []) => client.all(sql, params);
    facts = tableOf(target, await readTable(query, target.table));
    key = keyOf(target, facts);
    rowid = facts.withoutRowid ? undefined : rowidOf(facts);
  } catch (error) {
    await client.close();
    throw error;
  }
  const { questionSet } = target;
  const fields = questionSet.read;
  /** The table as the file spells it: what the triggers write into `table_name`. */
  const name = facts.name;
  const table = quoteIdent(name);
  const keyColumn = key.kind === "rowid" ? ROWID : quoteIdent(key.name);
  /** What a bound key is compared with: the key, or its text where the column has no affinity. */
  const keyMatch = key.kind === "column" && key.untyped ? `cast(${keyColumn} as text)` : keyColumn;
  /** A rowid table pages by its rowid, which grows with every insert; a WITHOUT ROWID one by its key. */
  const order = rowid ?? keyColumn;
  // `where` is the source's own SQL filter from the config file, spliced as written (as on
  // Postgres): the config is the operator's code, not a user value.
  const excluded =
    questionSet.where === undefined ? "0" : `not coalesce((${questionSet.where}), 0)`;
  const stateColumns = fields.map(
    (field, index) => `cast(${quoteIdent(field)} as text) as s${index}`,
  );
  const rowColumns = [`cast(${keyColumn} as text) as k`, ...stateColumns, `${excluded} as x`].join(
    ", ",
  );
  const jobs = quoteIdent(JOBS_TABLE);
  const owners = quoteIdent(OWNERS_TABLE);

  function parseRow(row: SqliteRow): ReadRow {
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

  // `close()` sets the flag while `watch` awaits; read through a call so TypeScript does not narrow it.
  let closed = false;
  const isClosed = () => closed;
  /** Stops the lock's heartbeat; set while this worker holds the lock. */
  let stopBeating: (() => void) | undefined;
  /** When this worker last renewed its lock, by a poll, a claim or a beat. */
  let lastRenewed = 0;
  /** Whether the last beat failed, so a run of failures is said once. */
  let beatFailing = false;

  /**
   * Takes or renews this worker's lock on the table, inside the caller's transaction: refused
   * while another worker's lock anywhere in the file is fresh, taken over once it is stale. The
   * first lock taken starts its heartbeat.
   */
  async function holdLock(tx: SqliteStatements, now: number): Promise<void> {
    const marker = await tx.all("select 1 from sqlite_master where type = 'table' and name = ?", [
      OWNERS_TABLE,
    ]);
    const [owner] =
      marker.length === 0
        ? []
        : await tx.all(`select project_id from ${owners} where table_name = ?`, [name]);
    if (owner === undefined) {
      throw new EngineRefusal({
        code: "not-installed",
        message: `FacetDB is not installed on ${name} in ${where} (${OWNERS_TABLE} has no row for it)`,
        fix: "run facetdb migrate first",
      });
    }
    const projectId = textOf(owner, "project_id");
    if (projectId !== target.project.id) {
      throw new EngineRefusal({
        code: "another-project",
        message: `${name} in ${where} belongs to another project (${projectId}); one table belongs to one project`,
        fix: "run this worker from that project's directory, or point the source at another table",
      });
    }
    const [holder] = await tx.all(
      `select table_name, worker_id, heartbeat_at from ${owners}
        where worker_id is not null and worker_id <> ? and heartbeat_at > ?
        order by heartbeat_at desc limit 1`,
      [workerId, iso(now - LOCK_FRESH_MS)],
    );
    if (holder !== undefined) {
      const at = textOf(holder, "heartbeat_at");
      const renewed = Date.parse(at);
      if (Number.isNaN(renewed)) {
        throw new Error(`${OWNERS_TABLE} holds heartbeat_at "${at}", not an ISO time`);
      }
      // Fresh while renewed within LOCK_FRESH_MS: stale, and taken over, from exactly then.
      const frees = iso(renewed + LOCK_FRESH_MS);
      throw new EngineRefusal({
        code: "one-worker",
        message: `SQLite allows one worker, and worker ${textOf(holder, "worker_id")} holds the lock on ${textOf(holder, "table_name")} in ${where}: it last renewed it at ${at}, and the lock frees at ${frees} unless it is renewed before then (a running worker renews it every 30 seconds)`,
        fix: `stop the other facetdb worker first: a worker that stops lets go of its lock at once. One that was killed keeps it until ${frees}, 2 minutes after its last renewal; start this worker after then, and it takes the lock over`,
      });
    }
    await tx.run(`update ${owners} set worker_id = ?, heartbeat_at = ? where table_name = ?`, [
      workerId,
      iso(now),
      name,
    ]);
    lastRenewed = now;
    stopBeating ??= repeat(LOCK_HEARTBEAT_MS, beat);
  }

  /**
   * The lock's own heartbeat: renews this worker's lock, and only while it is still this worker's;
   * never takes one. A lock another worker took over, after this one went 2 minutes without a
   * renewal, stops the beat, and this worker's next poll or claim is refused. A beat that fails (a
   * busy file, a server away) changes nothing: the next beat, poll or claim renews, and the first
   * failure of a run is said through `warn` with the time the lock frees without a renewal.
   */
  async function beat(): Promise<void> {
    if (isClosed()) {
      return;
    }
    const now = clock.now();
    try {
      const renewed = await client.run(
        `update ${owners} set heartbeat_at = ? where table_name = ? and worker_id = ?`,
        [iso(now), name, workerId],
      );
      if (renewed.changes === 0) {
        stopBeating?.();
        stopBeating = undefined;
        return;
      }
      lastRenewed = now;
      beatFailing = false;
    } catch (error) {
      // The lock stays fresh for 2 minutes, four beats: said once per run of failures, not each.
      if (!beatFailing) {
        beatFailing = true;
        warn(
          `facetdb: the worker's lock on ${name} in ${where} could not be renewed (${error instanceof Error ? error.message : String(error)}); it tries again every 30 seconds, and unless a renewal lands by ${iso(lastRenewed + LOCK_FRESH_MS)} the lock frees and another worker may take it over`,
        );
      }
    }
  }

  let wake: (() => void) | undefined;

  async function* watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    // Keys already announced and still waiting are not announced again; a key claimed and queued
    // again is.
    let announced = new Set<RecordKey>();
    while (!isClosed()) {
      const rows = await client.transaction(async (tx) => {
        await holdLock(tx, clock.now());
        return tx.all(
          `select record_key from ${jobs} where table_name = ? and claimed_at is null
            order by enqueued_at, record_key limit ?`,
          [name, WATCH_BATCH],
        );
      });
      const waiting = rows.map((row) => textOf(row, "record_key"));
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
      // The key binds as text and compares under the column's affinity: '42' finds 42.
      const rows = await client.all(
        `select ${rowColumns} from ${table} where ${keyMatch} in (${placeholders(part.length)})`,
        part,
      );
      for (const row of rows) {
        const parsed = parseRow(row);
        found.set(parsed.key, parsed);
      }
    }
    const rows: ReadRow[] = [];
    const missing: RecordKey[] = [];
    for (const one of wanted) {
      const row = found.get(one);
      if (row === undefined) {
        missing.push(one);
      } else {
        rows.push(row);
      }
    }
    return { rows, missing };
  }

  /**
   * The columns a decision sets: answer columns per question role (a noul as 0 or 1), the status,
   * the update time, and the reviewed flag only when the decision carries it (set once, never
   * cleared). A choice's probability list is not in a decision; its column keeps what it holds.
   */
  function assignmentsFor(decision: RecordDecision): (readonly [string, SqliteParam])[] {
    const out: (readonly [string, SqliteParam])[] = [];
    for (const [question, answer] of Object.entries(decision.decisions)) {
      const asked = questionSet.questions.find((candidate) => candidate.name === question);
      if (asked === undefined) {
        throw new Error(`a decision names "${question}", which is not a question of this source`);
      }
      const decided = answer.kind === "decided" ? answer : undefined;
      for (const column of answerColumns(asked)) {
        switch (column.role) {
          case "value": {
            const value = decided?.value ?? null;
            out.push([column.name, typeof value === "boolean" ? (value ? 1 : 0) : value]);
            break;
          }
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
    out.push([UPDATED_AT_COLUMN, iso(clock.now())]);
    if (decision.reviewed === true) {
      out.push([REVIEWED_COLUMN, 1]);
    }
    return out;
  }

  /**
   * Inside `begin immediate`, so nothing writes the row between the read and the update: the state
   * is read and hashed here, in code, and FacetDB's columns are updated only when the hash is the
   * one the model was sent. Only FacetDB's own columns are set.
   */
  async function write(
    recordKey: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    const assignments = assignmentsFor(decision);
    return client.transaction(async (tx) => {
      const rows = await tx.all(`select ${rowColumns} from ${table} where ${keyMatch} = ?`, [
        recordKey,
      ]);
      const row = rows.map(parseRow).find((one) => one.key === recordKey);
      if (row === undefined || row.hash !== expectedHash) {
        return { written: false };
      }
      await tx.run(
        `update ${table} set ${assignments.map(([column]) => `${quoteIdent(column)} = ?`).join(", ")} where ${keyMatch} = ?`,
        [...assignments.map(([, value]) => value), recordKey],
      );
      return { written: true };
    });
  }

  /** The aliases `parseCurrent` reads, each question's answer columns raw, converted below. */
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
  const currentSelect = [
    `cast(${keyColumn} as text) as k`,
    ...currentColumns.map(({ alias, column }) => `${quoteIdent(column)} as ${alias}`),
    `${quoteIdent(STATUS_COLUMN)} as cs`,
    `${quoteIdent(UPDATED_AT_COLUMN)} as cu`,
    `${quoteIdent(REVIEWED_COLUMN)} as cr`,
  ].join(", ");

  async function current(
    keys: readonly RecordKey[],
  ): Promise<ReadonlyMap<RecordKey, CurrentDecision>> {
    const wanted = new Set(keys);
    const found = new Map<RecordKey, CurrentDecision>();
    for (const part of chunks([...wanted], IN_LIST)) {
      const rows = await client.all(
        `select ${currentSelect} from ${table} where ${keyMatch} in (${placeholders(part.length)})`,
        part,
      );
      for (const row of rows) {
        const recordKey = textOf(row, "k");
        // A key of another form that the column's affinity matched ('01' for 1) names no record.
        if (!wanted.has(recordKey)) {
          continue;
        }
        const updated = textual(row["cu"], UPDATED_AT_COLUMN);
        const updatedMs = updated === null ? null : Date.parse(updated);
        if (updatedMs !== null && Number.isNaN(updatedMs)) {
          throw new Error(`column "${UPDATED_AT_COLUMN}" holds "${updated}", not an ISO time`);
        }
        const parsed: Record<string, unknown> = {
          cs: row["cs"],
          cu: updatedMs === null ? null : String(updatedMs),
          cr: row["cr"] === 1,
        };
        for (const { alias, column, noul } of currentColumns) {
          parsed[alias] = noul ? yesNo(row[alias], column) : textual(row[alias], column);
        }
        const decision = parseCurrent(parsed, questionSet.questions);
        if (decision !== undefined) {
          found.set(recordKey, decision);
        }
      }
    }
    return found;
  }

  async function scan(cursor: ScanCursor | null): Promise<ScanPage> {
    const params: SqliteParam[] = [];
    let after = "";
    if (cursor !== null) {
      after = `where ${order} < ?`;
      params.push(parseCursor(cursor));
    }
    const rows = await client.all(
      `select ${order} as o, ${rowColumns} from ${table} ${after} order by ${order} desc limit ?`,
      [...params, pageSize],
    );
    const last = rows.at(-1);
    return {
      rows: rows.map(parseRow),
      next: rows.length < pageSize || last === undefined ? null : cursorOf(last["o"]),
    };
  }

  return {
    capabilities: SQLITE_CAPABILITIES,
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
     * One `insert or ignore` per key, in one transaction: a key queued already stays one row and
     * keeps its claim, as Postgres's `enqueue` does. Only a change of the record's state (the
     * trigger's upsert) takes a claim away: a backfill's enqueue of a key another backfill holds
     * would otherwise hand it to the worker, and the model would be asked twice at one state. A
     * single writer: SQLite has no row locks for two of these to wait on each other.
     */
    async enqueue(keys) {
      const unique = [...new Set(keys)];
      if (unique.length === 0) {
        return;
      }
      await client.transaction(async (tx) => {
        for (const one of unique) {
          await tx.run(`insert or ignore into ${jobs} (table_name, record_key) values (?, ?)`, [
            name,
            one,
          ]);
        }
      });
    },
    async claim(limit) {
      if (limit < 1) {
        return [];
      }
      const now = clock.now();
      // The keys are read inside the transaction: a row that is not text rolls the claim back
      // rather than leaving the batch held for a lease.
      return client.transaction(async (tx) => {
        await holdLock(tx, now);
        const rows = await tx.all(
          `update ${jobs} set claimed_by = ?, claimed_at = ?
            where table_name = ? and record_key in (
              select record_key from ${jobs}
               where table_name = ? and (claimed_at is null or claimed_at < ?)
               order by enqueued_at, record_key limit ?)
           returning record_key`,
          [workerId, iso(now), name, name, iso(now - CLAIM_LEASE_MS), limit],
        );
        return rows.map((row) => textOf(row, "record_key"));
      });
    },
    claimKey(recordKey) {
      const at = iso(clock.now());
      return client.transaction(async (tx) => {
        const inserted = await tx.run(
          `insert or ignore into ${jobs} (table_name, record_key) values (?, ?)`,
          [name, recordKey],
        );
        if (inserted.changes === 0) {
          return false;
        }
        await tx.run(
          `update ${jobs} set claimed_by = ?, claimed_at = ? where table_name = ? and record_key = ?`,
          [workerId, at, name, recordKey],
        );
        return true;
      });
    },
    async ack(keys) {
      for (const part of chunks([...new Set(keys)], IN_LIST)) {
        await client.run(
          `delete from ${jobs} where table_name = ? and claimed_by = ? and record_key in (${placeholders(part.length)})`,
          [name, workerId, ...part],
        );
      }
    },
    async release(keys) {
      for (const part of chunks([...new Set(keys)], IN_LIST)) {
        await client.run(
          `update ${jobs} set claimed_by = null, claimed_at = null
            where table_name = ? and claimed_by = ? and record_key in (${placeholders(part.length)})`,
          [name, workerId, ...part],
        );
      }
    },
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      stopBeating?.();
      stopBeating = undefined;
      wake?.();
      try {
        // Lets go of the lock, so the next worker need not wait 2 minutes for it to go stale.
        const marker = await client.all(
          "select 1 from sqlite_master where type = 'table' and name = ?",
          [OWNERS_TABLE],
        );
        if (marker.length > 0) {
          await client.run(
            `update ${owners} set worker_id = null, heartbeat_at = null where table_name = ? and worker_id = ?`,
            [name, workerId],
          );
        }
      } finally {
        await client.close();
      }
    },
  };
}
