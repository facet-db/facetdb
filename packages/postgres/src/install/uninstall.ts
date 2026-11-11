import { SIDE_TABLE_SCHEMA, sideViewName } from "../scan/index.ts";
import {
  connectPostgres,
  JOBS_TABLE,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  type SqlConnect,
} from "../sql/index.ts";
import {
  type InstalledTable,
  plain,
  readInstalled,
  SCRIPT_HEADER,
  settingsStatement,
} from "./catalog.ts";
import {
  type InstallStatement,
  type ProjectRef,
  queueKeyPrefix,
  renderSql,
  SCHEMA_SETTING,
  TABLE_SETTING,
  triggerName,
  WORKER_ROLE,
} from "./sql.ts";

/**
 * `facetdb uninstall`: prints its SQL, asks for the project name back, and removes what install
 * added to one table: the trigger, the queue entries, the answer and status columns (or the side
 * table and its view), the policies and the worker's rights on the table, and the project marker.
 * What other tables of the database still use stays: the trigger functions while a trigger calls
 * them, the queue while it holds anything else, the marker tables while another table is installed,
 * and every object of a FacetDB store living in the same database. The decision log is the
 * customer's: dropped only with `purge`, and the schema only then and only when nothing is left in
 * it. The worker and enqueue roles are shared by every project on the server and are left in place
 * (removing them is a documented manual step).
 *
 * Every statement is parameter-free (values written as literals outside any `do` body, read inside
 * one through `current_setting`), so the printed script and the statements run are one string.
 */

/** Transaction-local settings that carry the project and source to the `do` blocks. */
const PROJECT_SETTING = "facetdb.uninstall_project";
const SOURCE_SETTING = "facetdb.uninstall_source";

export type UninstallSource = {
  readonly table: string;
  /** Defaults to `public`. */
  readonly schema?: string;
  /** The source's id in `facetdb.decisions`: what `purge` deletes. */
  readonly sourceId: string;
};

/** What uninstall removes, as the catalog showed it, and which source's log rows `purge` deletes. */
export type UninstallTarget = Pick<
  InstalledTable,
  "schema" | "table" | "project" | "marked" | "sideColumns" | "viewMarked"
> & { readonly sourceId: string };

const STORE_ABSENT = `to_regclass('facetdb.store_migrations') is null`;

/** The uninstall script for one table, in the order it runs. */
export function uninstallSql(
  source: UninstallTarget,
  options: { readonly purge: boolean },
): readonly InstallStatement[] {
  const table = quoteTable({ schema: source.schema, name: source.table });
  const sourceSchema = `current_setting('${SCHEMA_SETTING}')`;
  const sourceTable = `current_setting('${TABLE_SETTING}')`;
  const project = `current_setting('${PROJECT_SETTING}')`;
  const worker = quoteLiteral(WORKER_ROLE);
  const workerExists = `exists (select 1 from pg_catalog.pg_roles where rolname = ${worker})`;
  return [
    ...SCRIPT_HEADER,
    settingsStatement([
      [SCHEMA_SETTING, source.schema],
      [TABLE_SETTING, source.table],
      [PROJECT_SETTING, source.project.id],
      [SOURCE_SETTING, source.sourceId],
    ]),
    // Change capture first, so nothing is queued while the rest goes.
    plain(`drop trigger if exists ${quoteIdent(triggerName(source))} on ${table}`),
    plain(`drop policy if exists ${quoteIdent("facetdb_reads")} on ${table}`),
    plain(`drop policy if exists ${quoteIdent("facetdb_writes")} on ${table}`),
    plain(`do $$
begin
  if ${workerExists} then
    execute format('revoke all on %I.%I from %I', ${sourceSchema}, ${sourceTable}, ${worker});
  end if;
end $$`),
    // FacetDB's marked columns only, never with cascade: a view of the customer's on one of them
    // fails the drop and rolls the whole uninstall back, naming the view.
    ...(source.marked.length === 0
      ? []
      : [
          plain(
            `alter table ${table}\n${source.marked
              .map((name) => `  drop column ${quoteIdent(name)}`)
              .join(",\n")}`,
          ),
        ]),
    ...(source.viewMarked
      ? [
          plain(
            `drop view ${quoteTable({ schema: source.schema, name: sideViewName(source.table) })}`,
          ),
        ]
      : []),
    ...(source.sideColumns === undefined
      ? []
      : [
          plain(
            `drop table ${quoteTable({ schema: SIDE_TABLE_SCHEMA, name: `${source.table}_answers` })}`,
          ),
        ]),
    // The table's queue entries (the shared queue keys every table under its own prefix).
    plain(
      `delete from ${JOBS_TABLE} where starts_with(record_key, ${quoteLiteral(queueKeyPrefix(source))})`,
    ),
    plain(
      `delete from facetdb.table_owners where table_schema = ${quoteLiteral(source.schema)} and table_name = ${quoteLiteral(source.table)}`,
    ),
    // The worker's usage on the table's schema, when no other installed table is in it.
    plain(`do $$
begin
  if ${workerExists} and ${sourceSchema} <> 'facetdb'
     and not exists (select 1 from facetdb.table_owners where table_schema = ${sourceSchema}) then
    execute format('revoke usage on schema %I from %I', ${sourceSchema}, ${worker});
  end if;
end $$`),
    // The project marker, when the project has no other table here (a store's projects are its own).
    plain(`do $$
begin
  if ${STORE_ABSENT}
     and not exists (select 1 from facetdb.table_owners where project_id = ${project}) then
    delete from facetdb.projects where id = ${project};
  end if;
end $$`),
    // The trigger functions are shared by every table of the database: each goes once no trigger calls it.
    plain(`do $$
declare
  name text;
  f regprocedure;
begin
  foreach name in array array['enqueue', 'enqueue_keep', 'enqueue_side'] loop
    f := to_regprocedure(format('%I.%I()', 'facetdb', name));
    if f is not null and not exists (select 1 from pg_catalog.pg_trigger t where t.tgfoid = f) then
      execute format('drop function %s', f);
    end if;
  end loop;
end $$`),
    // The queue and the marker tables, once no installed table and no store is left to use them.
    plain(`do $$
begin
  if ${STORE_ABSENT} and not exists (select 1 from facetdb.table_owners) then
    if not exists (select 1 from ${JOBS_TABLE}) then
      drop table ${JOBS_TABLE};
    end if;
    drop table facetdb.table_owners;
    if not exists (select 1 from facetdb.projects) then
      drop table facetdb.projects;
    end if;
  end if;
end $$`),
    ...(options.purge
      ? [
          // The decision log: this source's rows, and the table once no row of anyone's is left.
          plain(`do $$
begin
  if to_regclass('facetdb.decisions') is not null then
    delete from facetdb.decisions where source_id = current_setting('${SOURCE_SETTING}');
    if ${STORE_ABSENT} and not exists (select 1 from facetdb.decisions) then
      drop table facetdb.decisions;
    end if;
  end if;
end $$`),
          // The schema, only when empty: a plain drop refuses while anything is in it.
          plain(`do $$
begin
  drop schema if exists facetdb;
exception when dependent_objects_still_exist then
  null;
end $$`),
        ]
      : []),
  ];
}

export type UninstallOptions = {
  /** The admin connection string; used for this call and not retained. */
  readonly adminUrl: string;
  readonly source: UninstallSource;
  /** Also delete the source's decision log, and the schema when nothing is left in it. */
  readonly purge?: boolean;
  /** Receives the complete script before anything is asked or run. */
  readonly print: (sql: string) => void;
  /**
   * Asks for the project's name back, after the script is printed, and returns what was typed;
   * anything else runs nothing. The CLI wires it to the terminal.
   */
  readonly confirm: (request: { readonly project: ProjectRef }) => Promise<string>;
  /** Print and stop: nothing is asked and nothing runs. */
  readonly dryRun?: boolean;
  readonly connect?: SqlConnect;
};

export type UninstallResult =
  | {
      readonly ok: true;
      readonly statements: readonly InstallStatement[];
      readonly sql: string;
      /** False on a dry run. */
      readonly applied: boolean;
    }
  | {
      /** Nothing was changed. The reason says why and what to do. */
      readonly ok: false;
      readonly reason: string;
    };

/**
 * Reads what install left on the table, prints the script, asks for the project name, and runs the
 * script's statements in one transaction: all of it happens or none of it. The admin connection is
 * closed before this returns, whatever happened.
 */
export async function uninstall(options: UninstallOptions): Promise<UninstallResult> {
  const client = (options.connect ?? connectPostgres)(options.adminUrl);
  try {
    const installed = await readInstalled(client.query, options.source);
    if ("reason" in installed) {
      return { ok: false, reason: installed.reason };
    }
    const statements = uninstallSql(
      { ...installed, sourceId: options.source.sourceId },
      { purge: options.purge ?? false },
    );
    const sql = renderSql(statements);
    options.print(sql);
    if (options.dryRun === true) {
      return { ok: true, statements, sql, applied: false };
    }
    const typed = await options.confirm({ project: installed.project });
    if (typed.trim() !== installed.project.name) {
      return {
        ok: false,
        reason: `the name typed is not the project's name (${installed.project.name}); nothing was changed. Type the project name exactly to uninstall.`,
      };
    }
    await client.transaction(async (query) => {
      for (const statement of statements) {
        await query(statement.text, statement.params);
      }
    });
    return { ok: true, statements, sql, applied: true };
  } finally {
    await client.close();
  }
}
