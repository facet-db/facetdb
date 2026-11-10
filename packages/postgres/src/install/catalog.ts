import { OWNED_MARK } from "../polling/index.ts";
import { SIDE_MARK, SIDE_TABLE_SCHEMA } from "../scan/index.ts";
import { quoteLiteral, type SqlQuery, type SqlRow } from "../sql/index.ts";
import type { InstallStatement, ProjectRef } from "./sql.ts";

/**
 * What an earlier install left on a table, read from the catalog: `migrate --prune` and `uninstall`
 * drop only what this finds and FacetDB marked, never a name taken from the config alone.
 */
export type InstalledTable = {
  readonly schema: string;
  readonly table: string;
  /** The project that installed on the table, from `facetdb.table_owners`. */
  readonly project: ProjectRef;
  readonly key: string;
  /** The key column's type as `format_type` prints it (the side table is created with it). */
  readonly keyType: string;
  /** FacetDB's marked columns on the table itself (inline mode), in table order. */
  readonly marked: readonly string[];
  /** The columns of FacetDB's marked side table other than the key; undefined when there is none. */
  readonly sideColumns: readonly string[] | undefined;
  /** Whether `<table>_with_answers` beside the table exists and carries FacetDB's mark. */
  readonly viewMarked: boolean;
};

const TABLE_PRESENT = `select to_regclass(format('%I.%I', $1::text, $2::text)) is not null as present`;

const OWNERS_PRESENT = `select to_regclass('facetdb.table_owners') is not null and to_regclass('facetdb.projects') is not null as present`;

const OWNER = `select o.project_id as id, p.name as name
  from facetdb.table_owners o join facetdb.projects p on p.id = o.project_id
 where o.table_schema = $1 and o.table_name = $2`;

const PRIMARY_KEY = `select a.attname as name, format_type(a.atttypid, a.atttypmod) as type
  from pg_catalog.pg_index i
  join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
 where i.indrelid = format('%I.%I', $1::text, $2::text)::regclass and i.indisprimary`;

const MARKED_COLUMNS = `select a.attname as name
  from pg_catalog.pg_attribute a
 where a.attrelid = format('%I.%I', $1::text, $2::text)::regclass
   and a.attnum > 0 and not a.attisdropped
   and col_description(a.attrelid, a.attnum) = $3
 order by a.attnum`;

const RELATION_MARK = `select obj_description(c.oid, 'pg_class') as mark
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = $1 and c.relname = $2 and c.relkind = any($3::text[])`;

/**
 * The side table's mark, found only when its foreign key references this table: a same-named
 * table in another schema shares `facetdb.<table>_answers`, and only its owner may touch it.
 */
const SIDE_MARK_FOR = `select obj_description(c.oid, 'pg_class') as mark
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p')
   and exists (select 1 from pg_catalog.pg_constraint k
                where k.conrelid = c.oid and k.contype = 'f'
                  and k.confrelid = format('%I.%I', $3::text, $4::text)::regclass)`;

const ALL_COLUMNS = `select a.attname as name
  from pg_catalog.pg_attribute a
 where a.attrelid = format('%I.%I', $1::text, $2::text)::regclass and a.attnum > 0 and not a.attisdropped
 order by a.attnum`;

/** Reads what FacetDB installed on a table, or says in plain words why there is nothing to read. */
export async function readInstalled(
  query: SqlQuery,
  source: { readonly table: string; readonly schema?: string },
): Promise<InstalledTable | { readonly reason: string }> {
  const schema = source.schema ?? "public";
  const { table } = source;
  const label = `${schema}.${table}`;
  const flag = (rows: readonly SqlRow[]) => rows[0]?.["present"] === true;
  if (!flag(await query(TABLE_PRESENT, [schema, table]))) {
    return { reason: `${label} does not exist; there is nothing of FacetDB's on it to remove.` };
  }
  const owners = flag(await query(OWNERS_PRESENT)) ? await query(OWNER, [schema, table]) : [];
  const owner = owners[0];
  if (owner === undefined) {
    return {
      reason: `FacetDB is not installed on ${label} (facetdb.table_owners has no row for it); run migrate first, or check the source's schema and table.`,
    };
  }
  const keys = await query(PRIMARY_KEY, [schema, table]);
  const keyRow = keys[0];
  if (keys.length !== 1 || keyRow === undefined) {
    return {
      reason: `${label} no longer has a single-column primary key, which FacetDB installed by; restore it first.`,
    };
  }
  const key = String(keyRow["name"]);
  const names = (rows: readonly SqlRow[]) => rows.map((row) => String(row["name"]));
  const sideName = `${table}_answers`;
  const sideRows = await query(SIDE_MARK_FOR, [SIDE_TABLE_SCHEMA, sideName, schema, table]);
  const sideColumns =
    sideRows[0]?.["mark"] === SIDE_MARK
      ? names(await query(ALL_COLUMNS, [SIDE_TABLE_SCHEMA, sideName])).filter((c) => c !== key)
      : undefined;
  const viewRows = await query(RELATION_MARK, [schema, `${table}_with_answers`, ["v"]]);
  return {
    schema,
    table,
    project: { id: String(owner["id"]), name: String(owner["name"]) },
    key,
    keyType: String(keyRow["type"]),
    marked: names(await query(MARKED_COLUMNS, [schema, table, OWNED_MARK])),
    sideColumns,
    viewMarked: viewRows[0]?.["mark"] === SIDE_MARK,
  };
}

/** A statement with no parameter: printed exactly as it runs. */
export function plain(text: string): InstallStatement {
  return { text, params: [] };
}

/**
 * Transaction-local settings as one plain statement, the values written as literals (outside any
 * `do` body, so `quoteLiteral` is enough): the `do` blocks read them with `current_setting`, and the
 * printed script carries no parameter, so what prints is what runs.
 */
export function settingsStatement(
  settings: readonly (readonly [name: string, value: string])[],
): InstallStatement {
  return plain(
    `select ${settings
      .map(([name, value]) => `set_config(${quoteLiteral(name)}, ${quoteLiteral(value)}, true)`)
      .join(", ")}`,
  );
}

/** The rules every destructive script pins for its transaction, as install does. */
export const SCRIPT_HEADER: readonly InstallStatement[] = [
  plain("set local standard_conforming_strings = on"),
  plain("set local lock_timeout = '10s'"),
];
