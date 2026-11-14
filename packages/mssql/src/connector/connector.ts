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
  type CatalogColumn,
  CREATION_COLUMN,
  columnType,
  keyText,
  readColumns,
  readKey,
  tableNames,
} from "../install/index.ts";
import { type MssqlClient, type MssqlRow, quoteName, quoteString } from "../sql/index.ts";
import { connectMssqlPool, DEFAULT_MAX_CONNECTIONS, type MssqlPoolConnect } from "./client.ts";

/**
 * The SQL Server and Azure SQL runtime connector. The trigger the install makes queues a changed
 * record's key in the database's one `dbo.facetdb_jobs`, shared by every installed table and keyed
 * by `(table_name, record_key)` under `ignore_dup_key`: `table_name` is the table as the trigger
 * spells it, `[dbo].[listings]`, and `record_key` the key as `keyText` writes it
 * (`convert(nvarchar(322), …)`, so a `decimal(10,2)` key is '5.00' and a uniqueidentifier is upper
 * case). This connector reads every key of the table through the same expression, so a key it hands
 * out is always the queue's text, and finds a row by a key's text converted back to the key's own
 * type (`try_convert`), which keeps the primary key's seek and turns a text of another type into no
 * row instead of an error.
 *
 * Claims, settles and the watch never wait on another transaction's job row: an application's
 * transaction holds a job row from its trigger's write until it commits (the trigger clears a held
 * claim, or queues a new key), and a statement of the worker that waited for it while holding other
 * job rows could close a cycle that SQL Server breaks by killing the cheaper side, the
 * application's. Every queue statement that touches several rows reads past the rows others hold
 * (`readpast`), through the queue's clustered key (`index(1)`): a read through the
 * `facetdb_jobs_claimed` index looks each row up in the clustered key afterwards, and that lookup
 * waits on a held row where `readpast` would skip it (proven on SQL Server 2022, under read
 * committed and under READ_COMMITTED_SNAPSHOT, the Azure SQL default). `readcommittedlock` keeps
 * the claim a locking read under READ_COMMITTED_SNAPSHOT too. The index stays: the watch and
 * doctor's counts read it alone, with no lookup.
 *
 * Times are the clock's, bound as text and converted with style 121 (`yyyy-mm-dd hh:mi:ss.mmm`): a
 * fake clock decides whose lease ended and when a decision was written, as the contract suite needs
 * (`current().updatedAt` is the write's time on the worker's clock), where `sysutcdatetime()` would
 * be the server's. Workers on several hosts compare their own clocks against the 15-minute lease,
 * as on MySQL.
 *
 * `write` holds no lock across a round trip: the row is updated in one statement only where its
 * state still equals, as bytes of its text, the state whose hash the model was sent, and only
 * FacetDB's columns are set.
 */

/** The jobs table is polled every second. */
export const POLL_MS = 1_000;

/**
 * How long a claim holds a job when its worker never acks or releases it (the process died in
 * flight): longer than the 10-minute retry window, as on Postgres and MySQL.
 */
export const CLAIM_LEASE_MS = 15 * 60_000;

/** What SQL Server can do: inline columns, several workers; no side tables yet. */
export const MSSQL_CAPABILITIES: Capabilities = {
  inlineColumns: true,
  pushWakeup: false,
  transactions: true,
  sideTable: false,
  multipleWorkers: true,
};

/** Column types a creation marker may have: anything else would not order by time. */
const MARKER_TYPES: ReadonlySet<string> = new Set([
  "datetime",
  "datetime2",
  "smalldatetime",
  "date",
  "datetimeoffset",
]);

/** Keys a watch announces per pass. */
const WATCH_BATCH = 200;

/** Rows per `scan` page, as on Postgres and MySQL. */
const SCAN_PAGE_SIZE = 500;

/** Keys per `in` list: one parameter each, far under the 2,100 parameters of one request. */
const IN_LIST = 500;

/**
 * How many records' last-read state the connector keeps for `write`: the worker writes the records
 * of the batch it has just read, so a few hundred cover it, and the oldest go first.
 */
const STATE_CACHE = 1_000;

export type MssqlConnectorDeps = {
  readonly clock: Clock;
  /** Names this worker's claims; a fresh id when absent. */
  readonly workerId?: string;
  /** Opens the pool; tedious by default, a test passes its own. */
  readonly connect?: MssqlPoolConnect;
  /** The most connections the pool opens at once; 10 when absent. */
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

export type MssqlConnector = OpenConnector & {
  readonly workerId: string;
};

/** The clock's time as text SQL Server converts with style 121, in UTC: what the queue compares. */
export function mssqlTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** A `datetime2` read back with style 121, as milliseconds; NaN for anything else. */
export function parseMssqlTime(text: string): number {
  return Date.parse(`${text.replace(" ", "T")}Z`);
}

/** The clock's time bound as `placeholder`, as SQL: `convert(datetime2(3), @p4, 121)`. */
function timeOf(placeholder: string): string {
  return `convert(datetime2(3), ${placeholder}, 121)`;
}

/** A claim token: 32 hex characters, the queue's `char(32)`, unique across every worker. */
function claimToken(): string {
  return randomUUID().replaceAll("-", "");
}

/** `@p3, @p4, …` for `count` parameters starting at `from`. */
function placeholders(count: number, from: number): string[] {
  return Array.from({ length: count }, (_, index) => `@p${from + index}`);
}

/**
 * A state column as text, the form `stateHash` hashes and `write` compares: each type in the style
 * that keeps every digit of its value (a `float` in default style keeps six, so a change in the
 * seventh would not move the hash; `money` keeps two decimals of its four), times as ISO text, binary
 * as hex, a CLR type by its `ToString()`. A column the worker cannot see in the catalog reads as
 * nvarchar, which a column it cannot read fails anyway.
 */
export function stateTextOf(
  alias: string,
  name: string,
  column: CatalogColumn | undefined,
): string {
  const value = `${alias}.${quoteName(name)}`;
  switch (column?.type) {
    case "float":
    case "real":
      return `convert(nvarchar(max), ${value}, 3)`;
    case "money":
    case "smallmoney":
      return `convert(nvarchar(max), ${value}, 2)`;
    case "date":
    case "time":
    case "datetime":
    case "datetime2":
    case "smalldatetime":
    case "datetimeoffset":
      return `convert(nvarchar(max), ${value}, 121)`;
    case "binary":
    case "varbinary":
    case "timestamp":
      return `convert(nvarchar(max), ${value}, 1)`;
    case "image":
      return `convert(nvarchar(max), convert(varbinary(max), ${value}), 1)`;
    case "geography":
    case "geometry":
    case "hierarchyid":
      return `${value}.ToString()`;
    default:
      return `convert(nvarchar(max), ${value})`;
  }
}

function textOf(row: MssqlRow, column: string): string {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`column "${column}" came back as ${typeof value}, expected text`);
  }
  return value;
}

function textOrNull(row: MssqlRow, column: string): string | null {
  const value = row[column];
  return value === null ? null : textOf(row, column);
}

function stateText(value: unknown, column: string): StateValue {
  if (value === null || typeof value === "string") {
    return value;
  }
  throw new Error(`column "${column}" came back as ${typeof value}, expected text`);
}

/** A noul answer as SQL Server prints its `bit` (1 or 0), as the text `parseCurrent` reads. */
function yesNo(value: string | null, column: string): string | null {
  if (value === null) {
    return null;
  }
  if (value === "1" || value === "0") {
    return value === "1" ? "true" : "false";
  }
  throw new Error(`column "${column}" holds ${value}, expected 1 or 0`);
}

/** A `bit` as tedious reads it: true, false, or NULL (FacetDB's columns have no default). */
function bitOf(row: MssqlRow, column: string): boolean | null {
  const value = row[column];
  if (value === null || typeof value === "boolean") {
    return value;
  }
  throw new Error(`column "${column}" came back as ${typeof value}, expected a bit`);
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let from = 0; from < items.length; from += size) {
    out.push(items.slice(from, from + size));
  }
  return out;
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
  const invalid = () => new Error(`"${cursor}" is not a scan cursor of a SQL Server source`);
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

/** What `open` learns of the table from the catalog, as the worker login sees it. */
type TableFacts = {
  readonly key: CatalogColumn;
  readonly columns: ReadonlyMap<string, CatalogColumn>;
};

/**
 * The runtime connector of one installed table, under the worker login's `url`. The table's key is
 * read from the catalog as the worker sees it; a table it cannot see, or one without a single-column
 * key, is refused (`EngineRefusal`). The pool opens here and closes with `close`.
 */
export async function createMssqlConnector(
  target: EngineTarget,
  url: string,
  deps: MssqlConnectorDeps,
): Promise<MssqlConnector> {
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
  const names = tableNames(target);
  const pool: MssqlClient = (deps.connect ?? connectMssqlPool)(url, {
    maxConnections: deps.maxConnections ?? DEFAULT_MAX_CONNECTIONS,
  });
  let facts: TableFacts;
  try {
    facts = await factsOf();
  } catch (error) {
    await pool.close();
    throw error;
  }

  /**
   * The key the queue holds for each record, by the install's rule: the table's one-column primary
   * key. A config naming another column disagrees with the table and is refused, as install refuses
   * it. The catalog shows the worker login only the tables it has a right on, so an uninstalled
   * table reads as missing.
   */
  async function factsOf(): Promise<TableFacts> {
    const columns = await readColumns(pool.query, names.schema, names.table);
    if (columns.length === 0) {
      throw new EngineRefusal({
        code: "no-table",
        message: `${names.label} does not exist, or the worker login has no right on it`,
        fix: "point the source at the table FacetDB was installed on, and run facetdb migrate on it first",
      });
    }
    const primary = await readKey(pool.query, names.schema, names.table);
    const [only] = primary;
    if (only === undefined || primary.length > 1) {
      throw primaryKeyRefusal(
        `${names.label} needs a single-column primary key, and ${only === undefined ? "has none" : "has a composite one"}`,
      );
    }
    if (target.key !== undefined && target.key !== only) {
      throw primaryKeyRefusal(
        `${names.label}'s primary key is ${only}, not ${target.key}; the config and the table disagree`,
      );
    }
    const byName = new Map(columns.map((column) => [column.name, column]));
    const key = byName.get(only);
    if (key === undefined) {
      throw primaryKeyRefusal(`${names.label}'s primary key ${only} is not among its columns`);
    }
    return { key, columns: byName };
  }

  const { questionSet } = target;
  const fields = questionSet.read;
  const table = names.relation;
  const jobs = names.jobsRelation;
  /** The table as the trigger writes it into the queue's `table_name`: `[dbo].[listings]`. */
  const queued = names.relation;
  const keyColumn = `t.${quoteName(facts.key.name)}`;
  /** The row's key as the queue's text. */
  const keyExpr = keyText("t", facts.key);
  /** A key's text as the key's own type; text of another type finds no row. */
  const keyAs = (index: number) => `try_convert(${columnType(facts.key)}, @p${index})`;
  const stateExprs = fields.map((field) => stateTextOf("t", field, facts.columns.get(field)));
  // `where` is the source's own SQL filter from the config file, spliced as written (as on
  // Postgres and MySQL): the config is the operator's code, not a user value. A filter that is not
  // true (false or unknown) excludes the record.
  const excluded =
    questionSet.where === undefined
      ? "cast(0 as bit)"
      : `cast(case when (${questionSet.where}) then 0 else 1 end as bit)`;
  const rowColumns = [
    `${keyExpr} as k`,
    ...stateExprs.map((expression, index) => `${expression} as s${index}`),
    `${excluded} as x`,
  ].join(", ");

  function parseRow(row: MssqlRow): ReadRow {
    const state: Record<string, StateValue> = {};
    fields.forEach((field, index) => {
      state[field] = stateText(row[`s${index}`], field);
    });
    return {
      key: textOf(row, "k"),
      state,
      hash: stateHash(fields, state),
      excluded: row["x"] === true,
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

  /** The two settles: what a statement does to a held job, and what it outputs. */
  const SETTLES = {
    ack: "delete j output deleted.[record_key] as record_key",
    release:
      "update j set [claimed_at] = null, [claimed_by] = null, [claim_token] = null output inserted.[record_key] as record_key",
  } as const;

  /**
   * Settles the keys this worker holds, by their tokens. A batch is one statement that reads past
   * the job rows another transaction holds (an application's, whose trigger just cleared that job's
   * claim), so it never waits, and says which rows it settled; each key it skipped is then settled
   * in a statement of its own, which may wait but holds nothing while it waits: a statement that
   * waited holding other job rows could close a cycle with the application's transaction, and SQL
   * Server breaks a cycle by rolling back the cheaper side. The batch is a locking read
   * (`readcommittedlock`), as the claim is, so under READ_COMMITTED_SNAPSHOT (Azure SQL's default)
   * it never finds its rows in their versions and then waits on a held one while holding the rows
   * it already settled, whatever plan the server picks; on SQL Server 2022 the batch skipped a held
   * row under that option without the hint too (the db suite runs it both ways), so the hint pins
   * the behaviour rather than fixing a failure seen. A key whose claim the trigger cleared and
   * committed matches no row, and stays queued, to be asked at its new state. A key's token is
   * forgotten only once its settle ran; a settle that threw leaves the claim to its lease.
   */
  async function settle(kind: keyof typeof SETTLES, keys: readonly RecordKey[]): Promise<void> {
    const statement = SETTLES[kind];
    for (const [token, group] of byToken(keys)) {
      for (const part of chunks(group, IN_LIST)) {
        const done = new Set(
          (
            await pool.query(
              `${statement} from ${jobs} j with (readcommittedlock, readpast, rowlock, index(1)) where j.[table_name] = @p1 and j.[claim_token] = @p2 and j.[record_key] in (${placeholders(part.length, 3).join(", ")})`,
              [queued, token, ...part],
            )
          ).map((row) => textOf(row, "record_key")),
        );
        for (const key of part.filter((one) => !done.has(one))) {
          await pool.query(
            `${statement} from ${jobs} j where j.[table_name] = @p1 and j.[claim_token] = @p2 and j.[record_key] = @p3`,
            [queued, token, key],
          );
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

  /**
   * The table's waiting keys, every second: an announcement only (the worker claims what it takes),
   * so no order is asked for, and the `facetdb_jobs_claimed` index answers it alone. A key an
   * uncommitted application transaction just queued is read past, and announced at the next poll.
   */
  async function* watch(): AsyncGenerator<readonly RecordKey[], void, undefined> {
    // Keys already announced and still waiting are not announced again; a key claimed and queued
    // again is.
    let announced = new Set<RecordKey>();
    while (!isClosed()) {
      const waiting = (
        await pool.query(
          `select top (@p2) j.[record_key] as record_key from ${jobs} j with (readpast) where j.[table_name] = @p1 and j.[claimed_at] is null`,
          [queued, WATCH_BATCH],
        )
      ).map((row) => textOf(row, "record_key"));
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
      const result = await pool.query(
        `select ${rowColumns} from ${table} t where ${keyColumn} in (${part.map((_, index) => keyAs(index + 1)).join(", ")})`,
        part,
      );
      for (const row of result) {
        const parsed = parseRow(row);
        found.set(parsed.key, parsed);
        remember(parsed);
      }
    }
    const out: ReadRow[] = [];
    const missing: RecordKey[] = [];
    for (const one of wanted) {
      // A key of another form the key's type matched ('042' for 42) names no record.
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
   * The columns a decision sets, each with its value: answer columns per question role, the status,
   * the update time, and the reviewed flag only when the decision carries it (set once, never
   * cleared). A choice's probability list is not in a decision; its column keeps what it holds.
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
    out.push([UPDATED_AT_COLUMN, mssqlTime(clock.now())]);
    if (decision.reviewed === true) {
      out.push([REVIEWED_COLUMN, true]);
    }
    return out;
  }

  /**
   * The row is updated only where its state still equals the state whose hash was sent. The state
   * the last `read` returned for the key serves when its hash is the expected one; otherwise the
   * state is read and hashed first, and a hash already moved writes nothing. Either way the check
   * and the write are one statement on the row, comparing each state column's text as bytes
   * (`varbinary`), so no collation decides it (under the usual `_CI_AS` collations 'Scam' = 'scam',
   * and trailing spaces never count), and a NULL only equals a NULL.
   *
   * The table carries FacetDB's trigger, and SQL Server refuses an `output` without `into` on a
   * table with an enabled trigger (error 334), so the rows the update matched are counted through a
   * table variable; the driver's row count would add the rows any other trigger of the application
   * touched, a trigger without `set nocount on` among them.
   */
  async function write(
    recordKey: RecordKey,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> {
    const assignments = assignmentsFor(decision);
    const remembered = lastRead.get(recordKey);
    const sent =
      remembered !== undefined && remembered.hash === expectedHash
        ? remembered
        : (
            await pool.query(
              `select ${rowColumns} from ${table} t where ${keyColumn} = ${keyAs(1)}`,
              [recordKey],
            )
          )
            .map(parseRow)
            .find((one) => one.key === recordKey);
    if (sent === undefined || sent.hash !== expectedHash) {
      return { written: false };
    }
    const params: unknown[] = [];
    const bind = (value: unknown): string => {
      params.push(value);
      return `@p${params.length}`;
    };
    const set = assignments
      .map(([column, value]) =>
        column === UPDATED_AT_COLUMN
          ? `${quoteName(column)} = ${timeOf(bind(value))}`
          : `${quoteName(column)} = ${bind(value)}`,
      )
      .join(", ");
    const key = bind(recordKey);
    const guard = fields
      .map((field, index) => {
        const value = sent.state[field];
        const expression = stateExprs[index] ?? "";
        return value === null || value === undefined
          ? `${expression} is null`
          : `convert(varbinary(max), ${expression}) = convert(varbinary(max), ${bind(value)})`;
      })
      .join(" and ");
    const rows = await pool.query(
      `declare @written table ([n] int);
update t set ${set} output 1 into @written ([n]) from ${table} t where ${keyColumn} = try_convert(${columnType(facts.key)}, ${key}) and ${keyExpr} = ${key}${guard === "" ? "" : ` and ${guard}`};
select count(*) as written from @written;`,
      params,
    );
    // The driver hands back the rows of every result set the batch produced, in order: an
    // application trigger on the table that returns a result set (a `select` left in its body, or
    // an `output` without `into` of its own) puts its rows before the count, so the count is the
    // last row that carries a `written` column, the batch's last statement.
    const counted = rows.findLast((one) => "written" in one);
    return { written: Number(counted?.["written"] ?? 0) > 0 };
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
  /**
   * FacetDB's columns as `parseCurrent` reads them: a `real` in its default style, six digits, the
   * digits a `real` holds (0.93 is stored as 0.930000007 and reads back 0.93); a NULL status as
   * pending, since the install's columns are nullable with no default (a row the trigger never
   * saw).
   */
  const currentSelect = [
    `${keyExpr} as k`,
    ...currentColumns.map(
      ({ alias, column }) => `convert(nvarchar(max), t.${quoteName(column)}) as ${alias}`,
    ),
    `coalesce(t.${quoteName(STATUS_COLUMN)}, ${quoteString("pending")}) as cs`,
    `convert(nvarchar(30), t.${quoteName(UPDATED_AT_COLUMN)}, 121) as cu`,
    `t.${quoteName(REVIEWED_COLUMN)} as cr`,
  ].join(", ");

  async function current(
    keys: readonly RecordKey[],
  ): Promise<ReadonlyMap<RecordKey, CurrentDecision>> {
    const wanted = new Set(keys);
    const found = new Map<RecordKey, CurrentDecision>();
    for (const part of chunks([...wanted], IN_LIST)) {
      const result = await pool.query(
        `select ${currentSelect} from ${table} t where ${keyColumn} in (${part.map((_, index) => keyAs(index + 1)).join(", ")})`,
        part,
      );
      for (const row of result) {
        const recordKey = textOf(row, "k");
        // A key of another form the key's type matched ('042' for 42) names no record.
        if (!wanted.has(recordKey)) {
          continue;
        }
        const updated = textOrNull(row, "cu");
        const updatedMs = updated === null ? null : parseMssqlTime(updated);
        if (updatedMs !== null && Number.isNaN(updatedMs)) {
          throw new Error(`column "${UPDATED_AT_COLUMN}" holds "${updated}", not a datetime2`);
        }
        const parsed: Record<string, unknown> = {
          cs: row["cs"],
          cu: updatedMs === null ? null : String(updatedMs),
          cr: bitOf(row, "cr") === true,
        };
        for (const { alias, column, noul } of currentColumns) {
          const value = textOrNull(row, alias);
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
   * The creation marker a scan orders by, when the table has a time-typed `created_at` the worker
   * may read: install grants it the select where the column exists, and an operator may revoke it,
   * so the right is asked of the server, else the key orders the scan, newest first for a growing
   * key. Looked up once, at the first page.
   */
  let marker: Promise<CatalogColumn | undefined> | undefined;
  const creation = (): Promise<CatalogColumn | undefined> => {
    const column = facts.columns.get(CREATION_COLUMN);
    if (column === undefined || !MARKER_TYPES.has(column.type)) {
      return Promise.resolve(undefined);
    }
    marker ??= pool
      .query("select has_perms_by_name(@p1, N'OBJECT', N'SELECT', @p2, N'COLUMN') as readable", [
        table,
        CREATION_COLUMN,
      ])
      .then(([row]) => (row?.["readable"] === 1 ? column : undefined));
    return marker;
  };

  /**
   * Every record, newest first, in pages, by keyset: the creation marker then the key where the
   * marker is readable, else the key alone, so rows that arrive or get answered between pages
   * neither shift a page nor repeat a record. `desc` puts a NULL marker last, as on MySQL. The key
   * compares in its own type, the cursor's key text converted back.
   */
  async function scan(cursor: ScanCursor | null): Promise<ScanPage> {
    const ordered = await creation();
    const position = cursor === null ? undefined : parseCursor(cursor, ordered !== undefined);
    const created = `t.${quoteName(CREATION_COLUMN)}`;
    const params: unknown[] = [pageSize];
    let where = "";
    if (position !== undefined) {
      const keyAfter = () => {
        params.push(position.key);
        return `${keyColumn} < ${keyAs(params.length)}`;
      };
      if (ordered === undefined) {
        where = ` where ${keyAfter()}`;
      } else if (position.created === null || position.created === undefined) {
        // NULLs sort last: after a NULL marker only smaller keys among the NULLs remain.
        where = ` where ${created} is null and ${keyAfter()}`;
      } else {
        params.push(position.created);
        const at = `convert(${columnType(ordered)}, @p${params.length}, 121)`;
        where = ` where (${created} < ${at} or (${created} = ${at} and ${keyAfter()}) or ${created} is null)`;
      }
    }
    const select =
      ordered === undefined
        ? rowColumns
        : `convert(nvarchar(40), ${created}, 121) as o, ${rowColumns}`;
    const order =
      ordered === undefined ? `${keyColumn} desc` : `${created} desc, ${keyColumn} desc`;
    const result = await pool.query(
      `select top (@p1) ${select} from ${table} t${where} order by ${order}`,
      params,
    );
    const parsed = result.map(parseRow);
    const last = result.at(-1);
    const lastRow = parsed.at(-1);
    let next: ScanCursor | null = null;
    if (result.length >= pageSize && last !== undefined && lastRow !== undefined) {
      next = cursorOf(
        ordered === undefined
          ? { key: lastRow.key }
          : { key: lastRow.key, created: textOrNull(last, "o") },
      );
    }
    return { rows: parsed, next };
  }

  return {
    capabilities: MSSQL_CAPABILITIES,
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
     * application transaction holds while holding the rows it inserted), each a plain insert the
     * queue's `ignore_dup_key` turns into nothing for a key queued already, which keeps its claim.
     * Not the trigger's clear-then-insert, which the Context of the task names: the contract's rule
     * is "a key already queued stays one entry", and only a change of the record's state (the
     * trigger) takes a claim away; a backfill that cleared a claim would hand the worker a key
     * another holds, and the model would be asked twice at one state.
     */
    async enqueue(keys) {
      for (const one of new Set(keys)) {
        await pool.query(`insert into ${jobs} ([table_name], [record_key]) values (@p1, @p2)`, [
          queued,
          one,
        ]);
      }
    },
    /**
     * One statement stamps this claim's token, this worker and the lease's start on up to `limit`
     * of the table's unclaimed jobs and those whose lease ended, reading past every job row another
     * transaction holds (another worker's claim in flight, an application's trigger write), so it
     * never waits for one, and hands the keys back through `output` (the queue has no trigger, so
     * error 334 cannot arise). The order is the clustered key's: the claim takes what it meets
     * first, which `top` with an `order by` would trade for a sort that locks the whole backlog.
     */
    async claim(limit) {
      if (limit < 1) {
        return [];
      }
      const now = clock.now();
      const token = claimToken();
      const claimed = (
        await pool.query(
          `update top (@p1) j set [claim_token] = @p2, [claimed_by] = @p3, [claimed_at] = ${timeOf("@p4")} output inserted.[record_key] as record_key from ${jobs} j with (readcommittedlock, readpast, updlock, rowlock, index(1)) where j.[table_name] = @p5 and (j.[claimed_at] is null or j.[claimed_at] < ${timeOf("@p6")})`,
          [limit, token, workerId, mssqlTime(now), queued, mssqlTime(now - CLAIM_LEASE_MS)],
        )
      ).map((row) => textOf(row, "record_key"));
      for (const key of claimed) {
        tokens.set(key, token);
      }
      return claimed;
    },
    /**
     * Inserts the job already claimed, in one committed statement: the queue's `ignore_dup_key`
     * turns the insert of a key queued already, claimed or not, into nothing, and an `output` with
     * no row is the false. Never a row held across the model call: the app's trigger would wait on
     * it. A key too long for the queue fails (truncation is an error with `ansi_warnings` on).
     */
    async claimKey(recordKey) {
      const token = claimToken();
      const inserted = await pool.query(
        `insert into ${jobs} ([table_name], [record_key], [claimed_by], [claimed_at], [claim_token]) output inserted.[record_key] as record_key values (@p1, @p2, @p3, ${timeOf("@p4")}, @p5)`,
        [queued, recordKey, workerId, mssqlTime(clock.now()), token],
      );
      if (inserted.length === 0) {
        return false;
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
