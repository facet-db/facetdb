import type { DatabaseSync } from "node:sqlite";
import { quoteIdent } from "../sql/index.ts";
import { JOBS_TABLE, markedIn, OWNERS_TABLE } from "./sql.ts";

/**
 * What the plans read of a SQLite file, from `sqlite_master` and `pragma table_info`: a plan reads,
 * it never writes. Rows are a boundary: every field is checked where it is read.
 */

/** A value bound to a `?` of a query. */
export type SqliteValue = string | number;

/** One row of a query, its fields not yet checked. */
export type SqliteRow = Readonly<Record<string, unknown>>;

/**
 * How the plans read the source's database: node:sqlite's handle (`sqliteQuery`) here, libSQL's
 * client later, or a test's own.
 */
export type SqliteQuery = (
  sql: string,
  params?: readonly SqliteValue[],
) => Promise<readonly SqliteRow[]>;

/** The plans' reads on a node:sqlite handle; whoever opened it closes it. */
export function sqliteQuery(db: DatabaseSync): SqliteQuery {
  return async (sql, params = []) => db.prepare(sql).all(...params);
}

/** SQLite matches names without regard to ASCII case: `Listings` and `listings` are one table. */
export function sameName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function shown(row: SqliteRow): string {
  return JSON.stringify(row, (_key, value: unknown) =>
    typeof value === "bigint" ? String(value) : value,
  );
}

export function textOf(row: SqliteRow, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new Error(`SQLite returned ${shown(row)}, where ${field} should be text`);
  }
  return value;
}

export function integerOf(row: SqliteRow, field: string): number {
  const value = row[field];
  if (typeof value === "bigint") {
    return Number(value);
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error(`SQLite returned ${shown(row)}, where ${field} should be an integer`);
  }
  return value;
}

/** One column of a table, generated ones included. */
export type ColumnFacts = {
  /** As the table declares it. */
  readonly name: string;
  /** The declared type in lower case, empty for a column declared without one. */
  readonly type: string;
  /** Its place in the primary key, from 1; 0 for a column outside it. */
  readonly pk: number;
  /** A generated column: no update sets it, so no trigger sees it change. */
  readonly generated: boolean;
};

export type TableFacts = {
  readonly kind: "table";
  /** As the file declares it; every statement uses this spelling. */
  readonly name: string;
  /** Its `create table` text in `sqlite_master`. */
  readonly sql: string;
  readonly withoutRowid: boolean;
  /** The integer primary key column that is the rowid itself, which VACUUM never renumbers. */
  readonly rowidAlias: string | undefined;
  readonly columns: readonly ColumnFacts[];
};

/** A table, or why the name is not one FacetDB can install on. */
export type TableLookup =
  | TableFacts
  | { readonly kind: "missing" }
  | { readonly kind: "view"; readonly name: string }
  | { readonly kind: "virtual"; readonly name: string };

const TABLE_QUERY =
  "select type, name, sql from sqlite_master where type in ('table', 'view') and name = ? collate nocase";

/** `hidden` is 2 or 3 for a generated column (1 is a virtual table's hidden column). */
const COLUMNS_QUERY = "select name, type, pk, hidden from pragma_table_xinfo(?) order by cid";

/** An index made for the primary key: an integer primary key with none is the rowid itself. */
const PRIMARY_INDEX_QUERY = "select 1 from pragma_index_list(?) where origin = 'pk'";

const VIRTUAL_TABLE = /^\s*create\s+virtual\s+table\b/i;

/**
 * SQL text (a table's, an index's, a view's or a trigger's) with its string literals and comments
 * blanked and its quoted identifiers unquoted, so a name can be looked for as a word: `"is_scam"`,
 * `[is_scam]` and `t.is_scam` all read `is_scam`, and `'is_scam'` (a string) and a comment do not.
 */
function identifiersOf(sql: string): string {
  return sql.replaceAll(
    /"((?:[^"]|"")*)"|`((?:[^`]|``)*)`|\[([^\]]*)\]|'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/g,
    (_match, double?: string, back?: string, bracket?: string) => {
      const name = double?.replaceAll('""', '"') ?? back?.replaceAll("``", "`") ?? bracket;
      return name === undefined ? " " : ` ${name} `;
    },
  );
}

function escaped(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** How many times a name appears in SQL text as an identifier, in any case and any quoting. */
function mentions(sql: string, name: string): number {
  const word = new RegExp(`(?<![\\p{L}\\p{N}_$])${escaped(name)}(?![\\p{L}\\p{N}_$])`, "giu");
  return identifiersOf(sql).match(word)?.length ?? 0;
}

/** The table options follow the column list's closing parenthesis: `) without rowid, strict`. */
function isWithoutRowid(sql: string): boolean {
  const text = identifiersOf(sql);
  return /\bwithout\s+rowid\b/i.test(text.slice(text.lastIndexOf(")") + 1));
}

/** The table a source names, as the file declares it, or why it is not a table FacetDB can use. */
export async function readTable(query: SqliteQuery, table: string): Promise<TableLookup> {
  const [row] = await query(TABLE_QUERY, [table]);
  if (row === undefined) {
    return { kind: "missing" };
  }
  const name = textOf(row, "name");
  if (textOf(row, "type") === "view") {
    return { kind: "view", name };
  }
  const sql = textOf(row, "sql");
  if (VIRTUAL_TABLE.test(sql)) {
    return { kind: "virtual", name };
  }
  const columns = (await query(COLUMNS_QUERY, [name])).map(
    (column): ColumnFacts => ({
      name: textOf(column, "name"),
      type: textOf(column, "type").toLowerCase(),
      pk: integerOf(column, "pk"),
      generated: integerOf(column, "hidden") >= 2,
    }),
  );
  const withoutRowid = isWithoutRowid(sql);
  const primary = columns.filter((column) => column.pk > 0);
  const [only] = primary;
  const rowidAlias =
    !withoutRowid &&
    only !== undefined &&
    primary.length === 1 &&
    only.type === "integer" &&
    (await query(PRIMARY_INDEX_QUERY, [name])).length === 0
      ? only.name
      : undefined;
  return { kind: "table", name, sql, withoutRowid, rowidAlias, columns };
}

/** Which of FacetDB's own tables the file has. */
export type FacetdbTables = {
  readonly jobs: boolean;
  readonly owners: boolean;
};

export async function readFacetdbTables(query: SqliteQuery): Promise<FacetdbTables> {
  const rows = await query(
    "select name from sqlite_master where type = 'table' and name in (?, ?)",
    [JOBS_TABLE, OWNERS_TABLE],
  );
  const names = new Set(rows.map((row) => textOf(row, "name")));
  return { jobs: names.has(JOBS_TABLE), owners: names.has(OWNERS_TABLE) };
}

/**
 * The table's columns that carry FacetDB's mark in its stored definition (`markedIn`), in table
 * order: the only columns FacetDB ever adopts or drops. A column of the same name without the mark
 * is the application's, whatever its history: rebuilt with the table, or dropped and added again.
 */
export function markedColumns(table: TableFacts): readonly string[] {
  return table.columns
    .filter((column) => markedIn(table.sql, column.name))
    .map((column) => column.name);
}

/** The project that installed on a table; `run` reads it too, inside its transaction. */
export const OWNER_QUERY = `select project_id from ${quoteIdent(OWNERS_TABLE)} where table_name = ? collate nocase`;

/** The project that installed on the table, from the marker; undefined when nobody has. */
export async function readOwner(
  query: SqliteQuery,
  table: string,
  tables: FacetdbTables,
): Promise<string | undefined> {
  if (!tables.owners) {
    return undefined;
  }
  const [row] = await query(OWNER_QUERY, [table]);
  return row === undefined ? undefined : textOf(row, "project_id");
}

/** What an earlier install left on a table, for uninstall and prune to remove. */
export type Installed = {
  readonly table: TableFacts;
  /** The project that installed on it. */
  readonly owner: string;
  /** FacetDB's marked columns on the table, in table order: the only ones ever dropped. */
  readonly marked: readonly string[];
  readonly tables: FacetdbTables;
};

/** Reads what FacetDB installed on a table, or says in plain words why there is nothing to read. */
export async function readInstalled(
  query: SqliteQuery,
  name: string,
): Promise<Installed | { readonly reason: string }> {
  const table = await readTable(query, name);
  if (table.kind === "missing") {
    return { reason: `${name} does not exist; there is nothing of FacetDB's on it to remove.` };
  }
  if (table.kind !== "table") {
    return {
      reason: `${table.name} is a ${table.kind === "view" ? "view" : "virtual table"}, which FacetDB never installs on; there is nothing of FacetDB's on it to remove.`,
    };
  }
  const tables = await readFacetdbTables(query);
  const owner = await readOwner(query, table.name, tables);
  if (owner === undefined) {
    return {
      reason: `FacetDB is not installed on ${table.name} (${OWNERS_TABLE} has no row for it); run migrate first, or check the source's table.`,
    };
  }
  return { table, owner, marked: markedColumns(table), tables };
}

/** Something of the application's that a column's drop would break, which SQLite refuses. */
export type Blocker = { readonly by: string; readonly columns: readonly string[] };

const SCHEMA_OBJECTS =
  "select type, name, tbl_name, sql from sqlite_master where type in ('index', 'view', 'trigger') order by type, name";

const INDEX_COLUMNS = "select name from pragma_index_info(?)";

/**
 * What would make SQLite refuse to drop these columns, read before trying: an index on the table
 * that keys on one, or names one in an expression or a partial `where`; a view or a trigger that
 * names the table and one of them; the table's own definition naming one beside its column (a
 * check, a generated column, a foreign key). Names are matched as words in the SQL text, so a view
 * naming another table's column of the same name is counted too: the refusal is the safe side, and
 * whatever this misses, the drop itself fails inside the transaction and nothing is changed.
 * `ignoring` names FacetDB's own triggers, which the plan drops first.
 */
export async function dropBlockers(
  query: SqliteQuery,
  table: TableFacts,
  columns: readonly string[],
  ignoring: readonly string[],
): Promise<readonly Blocker[]> {
  if (columns.length === 0) {
    return [];
  }
  const blockers: Blocker[] = [];
  const own = columns.filter((column) => mentions(table.sql, column) > 1);
  if (own.length > 0) {
    blockers.push({
      by: `the definition of ${table.name} itself (a check constraint, a generated column or a foreign key)`,
      columns: own,
    });
  }
  for (const row of await query(SCHEMA_OBJECTS)) {
    const type = textOf(row, "type");
    const name = textOf(row, "name");
    const on = textOf(row, "tbl_name");
    const sql = row["sql"] === null ? undefined : textOf(row, "sql");
    if (ignoring.includes(name)) {
      continue;
    }
    let used: readonly string[] = [];
    if (type === "index" && sameName(on, table.name)) {
      const keys = (await query(INDEX_COLUMNS, [name]))
        .map((key) => key["name"])
        .filter((key): key is string => typeof key === "string");
      used = columns.filter(
        (column) =>
          keys.some((key) => sameName(key, column)) ||
          (sql !== undefined && mentions(sql, column) > 0),
      );
    } else if (
      sql !== undefined &&
      (type === "view" || type === "trigger") &&
      (sameName(on, table.name) || mentions(sql, table.name) > 0)
    ) {
      used = columns.filter((column) => mentions(sql, column) > 0);
    }
    if (used.length > 0) {
      blockers.push({ by: `the ${type} ${name}`, columns: used });
    }
  }
  return blockers;
}

/** `a`, `a and b`, `a, b and c`. */
export function inWords(items: readonly string[]): string {
  const last = items.at(-1);
  return items.length < 2 || last === undefined
    ? items.join("")
    : `${items.slice(0, -1).join(", ")} and ${last}`;
}

/** The refusal's words for what blocks a drop, naming each object and the columns it uses. */
export function blockedMessage(
  table: string,
  blockers: readonly Blocker[],
  command: string,
): string {
  const uses = blockers.map(({ by, columns }) => `${by} uses ${inWords(columns)}`);
  return `${table}: ${inWords(uses)}; SQLite cannot drop a column that an index, a view, a trigger or the table's own definition uses, and FacetDB never changes what is not its own. Drop or change ${blockers.length === 1 ? "it" : "them"} first, then run ${command} again.`;
}
