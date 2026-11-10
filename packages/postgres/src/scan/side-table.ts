import { REVIEWED_COLUMN, STATUS_COLUMN } from "@facetdb/core";
import { quoteIdent, quoteLiteral, quoteTable } from "../sql/index.ts";

/**
 * The dollar-quote tag of the `do` blocks that must carry a literal from the config: a name can hold
 * `$$`, but `migrate` refuses one that holds this tag, so no name can end a body early.
 */
export const BODY_TAG = "$fdb$";

/**
 * Side-table mode: the answer and status columns live in `facetdb.<table>_answers`, keyed by the
 * source's primary key, and the view `<table>_with_answers` (next to the source table) joins the
 * two. The application's table is not altered; change capture stays a trigger on it. This module
 * owns the names and the SQL pieces of the variant; the install generator (`installSql`) composes
 * them in its one order of statements.
 */

export type StorageMode = "inline" | "side-table";

/** Where the side tables live: FacetDB's own schema, so uninstall finds them. */
export const SIDE_TABLE_SCHEMA = "facetdb";

/** Postgres truncates identifiers beyond this many bytes, silently: two long names would collide. */
const MAX_IDENTIFIER_BYTES = 63;

/** What the side-table pieces need to know about the source table. */
export type SideTableSource = {
  readonly table: string;
  /** Defaults to `public`. */
  readonly schema?: string | undefined;
  readonly key: string;
  /**
   * The key column's SQL type as the catalog prints it (`format_type`: `integer`, `uuid`,
   * `character varying(20)`). The side table's key must be the same type to join on it; `migrate`
   * reads it from the catalog, and the generator refuses to guess.
   */
  readonly keyType?: string | undefined;
};

/** One column definition: its name and its SQL type with defaults, as the install generator lists them. */
export type ColumnDefinition = readonly [name: string, definition: string];

function checkedName(name: string): string {
  if (new TextEncoder().encode(name).length > MAX_IDENTIFIER_BYTES) {
    throw new Error(
      `"${name}" is longer than Postgres' ${MAX_IDENTIFIER_BYTES}-byte limit for a name; side-table mode derives a table and a view name from the source table's, so the table's name must leave room for the suffix`,
    );
  }
  return name;
}

/** `<table>_answers`, in the `facetdb` schema. */
export function sideTableName(table: string): string {
  return checkedName(`${table}_answers`);
}

/** `<table>_with_answers`, in the source table's schema. */
export function sideViewName(table: string): string {
  return checkedName(`${table}_with_answers`);
}

/** The relation that holds a source's answers and status, and its key column. */
export type AnswerTarget = {
  readonly schema: string;
  readonly table: string;
  readonly keyColumn: string;
};

/**
 * Where `read` finds the stored status and `write` stores a decision: the source table itself in
 * inline mode, the side table in side-table mode. The trigger is on the source table either way.
 */
export function answerTarget(
  source: SideTableSource & { readonly storage?: StorageMode },
): AnswerTarget {
  if (source.storage === "side-table") {
    return { schema: SIDE_TABLE_SCHEMA, table: sideTableName(source.table), keyColumn: source.key };
  }
  return { schema: source.schema ?? "public", table: source.table, keyColumn: source.key };
}

/** The side table, quoted. */
export function sideTableRelation(source: SideTableSource): string {
  return quoteTable({ schema: SIDE_TABLE_SCHEMA, name: sideTableName(source.table) });
}

/** The view, quoted. */
export function sideViewRelation(source: SideTableSource): string {
  return quoteTable({ schema: source.schema, name: sideViewName(source.table) });
}

/** The mark on the side table and the view, so a later install adopts them and uninstall finds them. */
export const SIDE_MARK = "facetdb";

/**
 * Transaction-local settings that carry the view's schema and name into the `do` blocks that save
 * and restore its grants (a `$$` body cannot quote a name; the generator sets them with
 * `set_config($n, true)` just before these statements).
 */
export const VIEW_SCHEMA_SETTING = "facetdb.install_view_schema";
export const VIEW_NAME_SETTING = "facetdb.install_view";
/** The side table's name (in the `facetdb` schema); the source's own schema and table use the install settings. */
export const SIDE_TABLE_SETTING = "facetdb.install_side_table";
const SOURCE_SCHEMA_SETTING = "facetdb.install_schema";
const SOURCE_TABLE_SETTING = "facetdb.install_table";

/**
 * Select on the side table and usage on its schema for every role that holds select on the source
 * table at install time: through a `security_invoker` view the reader needs both, and the install
 * cannot know the application's roles any other way. Readers granted later need a re-run. Row-level
 * security on the side table (`sideTableSecurityStatements`) keeps each reader to the rows it can
 * see in the source. Names reach the block as settings.
 */
export function sideTableReaderGrants(): string {
  return `do $$
declare
  r record;
begin
  for r in
    select case when a.grantee = 0 then 'public' else quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) end as grantee_sql
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(c.relacl) a
     where n.nspname = current_setting('${SOURCE_SCHEMA_SETTING}') and c.relname = current_setting('${SOURCE_TABLE_SETTING}')
       and a.privilege_type = 'SELECT' and a.grantee <> c.relowner
  loop
    execute format('grant usage on schema %I to %s', '${SIDE_TABLE_SCHEMA}', r.grantee_sql);
    execute format('grant select on %I.%I to %s', '${SIDE_TABLE_SCHEMA}', current_setting('${SIDE_TABLE_SETTING}'), r.grantee_sql);
    execute format('grant select on %I.%I to %s', current_setting('${VIEW_SCHEMA_SETTING}'), current_setting('${VIEW_NAME_SETTING}'), r.grantee_sql);
  end loop;
end $$`;
}

/** The side table's foreign key to the source, named so a re-run finds it. */
export function sideKeyConstraint(table: string): string {
  return checkedName(`${table}_answers_key_fkey`);
}

/**
 * The side table and its view. The table carries the key and exactly the columns inline mode adds
 * to the source table (`columns`, same definitions, same order); `add column if not exists` keeps a
 * later install, with more questions, idempotent. The key references the source `on delete
 * cascade`: a deleted record takes its answers, status and review flag with it, so a record
 * re-inserted under the same key starts fresh, as it would in inline mode.
 * The view reads `source.*` plus the answer columns; a record without a side row (never answered,
 * or inserted without the trigger) reads as pending and unreviewed, the defaults inline mode gives.
 * It runs with the caller's rights (`security_invoker`, Postgres 15), so the source's row-level
 * security applies to whoever reads it; a Supabase REST role sees through it exactly what it sees in
 * the table. It is dropped and created, not replaced: `t.*` is expanded at creation, and `create or
 * replace` would refuse the next run after the application added a column. Both relations carry
 * the mark; `migrate` refuses to touch a relation of these names that does not.
 * `whileViewDropped` runs between the drop and the create: `migrate --prune` drops the side
 * table's columns of removed questions there, since the view reads them by name.
 */
export function sideTableStatements(
  source: SideTableSource,
  columns: readonly ColumnDefinition[],
  options: { readonly whileViewDropped?: readonly string[] } = {},
): readonly string[] {
  if (source.keyType === undefined) {
    throw new Error(
      `side-table mode needs the type of ${source.table}'s key column (${source.key}); migrate reads it from the catalog`,
    );
  }
  const side = sideTableRelation(source);
  const view = sideViewRelation(source);
  const sourceTable = quoteTable({ schema: source.schema, name: source.table });
  const key = quoteIdent(source.key);
  const defaults: Readonly<Record<string, string>> = {
    [STATUS_COLUMN]: "'pending'",
    [REVIEWED_COLUMN]: "false",
  };
  const selected = columns.map(([name]) => {
    const fallback = defaults[name];
    const column = `a.${quoteIdent(name)}`;
    return fallback === undefined
      ? column
      : `coalesce(${column}, ${fallback}) as ${quoteIdent(name)}`;
  });
  return [
    `create table if not exists ${side} (\n  ${key} ${source.keyType} primary key\n)`,
    `alter table ${side}\n${columns
      .map(([name, definition]) => `  add column if not exists ${quoteIdent(name)} ${definition}`)
      .join(",\n")}`,
    // Added once: re-adding it on every run would re-validate every side row under a lock on the
    // customer's table. The constraint's name is FacetDB's, so its presence is the whole check.
    // The body is dollar-quoted with FacetDB's own tag, so the two literals from the config (the
    // key column, the constraint name) cannot end it; `migrate` refuses a name that holds the tag.
    `do ${BODY_TAG}
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = ${quoteLiteral(sideKeyConstraint(source.table))}
                    and conrelid = format('%I.%I', '${SIDE_TABLE_SCHEMA}', current_setting('${SIDE_TABLE_SETTING}'))::regclass) then
    execute format('alter table %I.%I add constraint %I foreign key (%I) references %I.%I (%I) on delete cascade',
                   '${SIDE_TABLE_SCHEMA}', current_setting('${SIDE_TABLE_SETTING}'), ${quoteLiteral(sideKeyConstraint(source.table))},
                   ${quoteLiteral(source.key)}, current_setting('${SOURCE_SCHEMA_SETTING}'), current_setting('${SOURCE_TABLE_SETTING}'), ${quoteLiteral(source.key)});
  end if;
end ${BODY_TAG}`,
    `comment on table ${side} is '${SIDE_MARK}'`,
    // The customer's grants on the view (an app reader, a REST role) outlive the drop: saved from
    // the catalog into a temp table that lives for the transaction, re-applied after the create.
    // The owner's own rights are implicit and skipped. Names come from the settings, not the text.
    `do $$
begin
  create temp table if not exists facetdb_view_grants (grantee_sql text, privilege text, grantable boolean) on commit drop;
  delete from facetdb_view_grants;
  insert into facetdb_view_grants
    select case when a.grantee = 0 then 'public' else quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) end,
           a.privilege_type, a.is_grantable
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(c.relacl) a
     where n.nspname = current_setting('${VIEW_SCHEMA_SETTING}') and c.relname = current_setting('${VIEW_NAME_SETTING}')
       and a.grantee <> c.relowner;
end $$`,
    `drop view if exists ${view}`,
    ...(options.whileViewDropped ?? []),
    `create view ${view} with (security_invoker = true) as
select t.*,
  ${selected.join(",\n  ")}
  from ${sourceTable} t
  left join ${side} a on a.${key} = t.${key}`,
    `comment on view ${view} is '${SIDE_MARK}'`,
    `do $$
declare
  g record;
begin
  for g in select * from facetdb_view_grants loop
    execute format('grant %s on %I.%I to %s%s', g.privilege, current_setting('${VIEW_SCHEMA_SETTING}'),
                   current_setting('${VIEW_NAME_SETTING}'), g.grantee_sql,
                   case when g.grantable then ' with grant option' else '' end);
  end loop;
end $$`,
  ];
}

/**
 * What the owner of the trigger function needs on the side table so `enqueue_side` can put a
 * changed record's stored status back to pending (`onChange: reset`): read the key and the status,
 * update the status, nothing else.
 */
export function sideTableEnqueuerGrants(source: SideTableSource, role: string): readonly string[] {
  const side = sideTableRelation(source);
  const key = quoteIdent(source.key);
  const status = quoteIdent(STATUS_COLUMN);
  return [`grant select (${key}, ${status}), update (${status}) on ${side} to ${role}`];
}

/**
 * Row-level security on the side table, mirroring the source's: a reader sees a side row only
 * when it can see the source row (the policy's subquery runs as the reader, so the source's own
 * policies decide), while the worker and the trigger's owner see and write every row. Without it,
 * select on the side table would show a tenant every record's answers.
 * Emitted after the worker role exists; the names reach the block as settings, the key through
 * FacetDB's own dollar tag.
 */
export function sideTableSecurityStatements(
  source: SideTableSource,
  workerRole: string,
  enqueueRole: string,
): readonly string[] {
  return [
    `alter table ${sideTableRelation(source)} enable row level security`,
    `do ${BODY_TAG}
begin
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = '${SIDE_TABLE_SCHEMA}'
                  and tablename = current_setting('${SIDE_TABLE_SETTING}') and policyname = 'facetdb_side_reads') then
    execute format('create policy %I on %I.%I for select using (exists (select 1 from %I.%I s where s.%I = %I.%I.%I))',
                   'facetdb_side_reads', '${SIDE_TABLE_SCHEMA}', current_setting('${SIDE_TABLE_SETTING}'),
                   current_setting('${SOURCE_SCHEMA_SETTING}'), current_setting('${SOURCE_TABLE_SETTING}'), ${quoteLiteral(source.key)},
                   '${SIDE_TABLE_SCHEMA}', current_setting('${SIDE_TABLE_SETTING}'), ${quoteLiteral(source.key)});
  end if;
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = '${SIDE_TABLE_SCHEMA}'
                  and tablename = current_setting('${SIDE_TABLE_SETTING}') and policyname = 'facetdb_side_workers') then
    execute format('create policy %I on %I.%I to %I, %I using (true) with check (true)',
                   'facetdb_side_workers', '${SIDE_TABLE_SCHEMA}', current_setting('${SIDE_TABLE_SETTING}'), ${quoteLiteral(workerRole)}, ${quoteLiteral(enqueueRole)});
  end if;
end ${BODY_TAG}`,
  ];
}

/**
 * The worker's rights on the side table: read and insert its own columns and the key (a first
 * answer inserts the row), update its own columns only. The source table needs select on the state
 * columns and nothing more (the caller grants that).
 */
export function sideTableWorkerGrants(
  source: SideTableSource,
  owned: readonly string[],
  role: string,
): readonly string[] {
  const side = sideTableRelation(source);
  const withKey = [source.key, ...owned].map(quoteIdent).join(", ");
  return [
    `grant select (${withKey}) on ${side} to ${role}`,
    `grant insert (${withKey}) on ${side} to ${role}`,
    `grant update (${owned.map(quoteIdent).join(", ")}) on ${side} to ${role}`,
  ];
}
