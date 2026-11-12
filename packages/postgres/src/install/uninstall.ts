import { SIDE_MARK, SIDE_TABLE_SCHEMA, sideViewName } from "../scan/index.ts";
import {
  connectPostgres,
  JOBS_TABLE,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  type SqlClient,
  type SqlConnect,
  type SqlQuery,
  type SqlRow,
} from "../sql/index.ts";
import { STORE_FUNCTIONS, STORE_TABLES, STORE_VERSION_TABLE } from "../store/index.ts";
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
  /**
   * The source's name or id as the caller knows it. `purge` never deletes by this alone: it is
   * resolved against the table's owner row and the store's `sources` (see `resolvePurgeSource`).
   */
  readonly sourceId: string;
};

/**
 * What uninstall removes, as the catalog showed it, and which source's log rows `purge` deletes:
 * `sourceId` is the id already resolved against the database, or undefined when no source was
 * found (the purge then deletes no row).
 */
export type UninstallTarget = Pick<
  InstalledTable,
  "schema" | "table" | "project" | "marked" | "sideColumns" | "viewMarked"
> & { readonly sourceId: string | undefined };

/**
 * Install now creates the store's tables in every database it touches, so their presence says
 * nothing; a store is in use when a plugin or API source, a stored credential or an API key lives in
 * it. The `do` blocks that care declare `in_use` with this prelude (the tables are read through
 * `execute`, since an install from before the store was part of the script has none of them).
 */
const IN_USE_DECLARE = `declare
  in_use boolean := false;
  t text;
begin
  foreach t in array array['sources', 'credentials', 'api_keys'] loop
    if to_regclass(format('facetdb.%I', t)) is not null then
      execute format('select exists (select 1 from facetdb.%I)', t) into in_use;
      exit when in_use;
    end if;
  end loop;`;

const STORE_ABSENT = "not in_use";

/** The store's tables that are not the decision log, one `drop` each (the log and its versions are the customer's). */
const BOOKKEEPING_TABLES = STORE_TABLES.filter(
  (name) => !["decisions", "question_set_versions", "jobs", "projects"].includes(name),
);

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
      [SOURCE_SETTING, source.sourceId ?? ""],
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
    // The project marker, when the project has no other table here and no state of its own in the
    // store. A polling-mode source has no table owner but keeps usage and heartbeats under the
    // project: its row stays, so the shared tables below still see a project that remains.
    plain(`do $$
${IN_USE_DECLARE}
  declare
    has_state boolean := false;
  begin
    foreach t in array array['usage:project_id', 'usage_reservations:project_id', 'usage_alerts:project_id', 'heartbeats:project'] loop
      if to_regclass(format('facetdb.%I', split_part(t, ':', 1))) is not null then
        execute format('select exists (select 1 from facetdb.%I where %I = $1)', split_part(t, ':', 1), split_part(t, ':', 2))
          into has_state using ${project};
        exit when has_state;
      end if;
    end loop;
    if ${STORE_ABSENT} and not has_state
       and not exists (select 1 from facetdb.table_owners where project_id = ${project}) then
      delete from facetdb.projects where id = ${project};
    end if;
  end;
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
${IN_USE_DECLARE}
  if ${STORE_ABSENT} and not exists (select 1 from facetdb.table_owners) then
    -- The queue stays while a trigger anywhere in the database still calls a function that writes to
    -- it (a table whose owner row is gone, or one installed by hand), and while it holds an entry.
    if not exists (select 1 from ${JOBS_TABLE})
       and not exists (
         select 1 from pg_catalog.pg_trigger t
           join pg_catalog.pg_proc p on p.oid = t.tgfoid
          where p.pronamespace = to_regnamespace('facetdb')
            and p.proname in ('enqueue', 'enqueue_keep', 'enqueue_side')
            and not t.tgisinternal) then
      drop table ${JOBS_TABLE};
    end if;
    drop table facetdb.table_owners;
    -- The store's other tables are shared by every project: they go only when no project remains
    -- (a polling-mode project has no table owner but keeps its usage, cursors and heartbeats).
    if not exists (select 1 from facetdb.projects) then
      drop table if exists ${["sources", "credentials", "api_keys"].map((name) => `facetdb.${quoteIdent(name)}`).join(", ")};
      drop table if exists ${[...BOOKKEEPING_TABLES, STORE_VERSION_TABLE].map((name) => `facetdb.${quoteIdent(name)}`).join(", ")};
      drop function if exists ${STORE_FUNCTIONS.join(", ")};
    end if;
  end if;
end $$`),
    ...(options.purge ? [purgeStatement()] : []),
    projectsTableStatement(),
    ...(options.purge ? [dropSchemaStatement()] : []),
  ];
}

/**
 * The decision log: this source's rows (the id resolved against the database, or none), and the
 * table once no row of anyone's is left. Its question-set versions go with it: they only explain
 * the log's version numbers.
 */
function purgeStatement(): InstallStatement {
  return plain(`do $$
${IN_USE_DECLARE}
  if to_regclass('facetdb.decisions') is not null then
    delete from facetdb.decisions where source_id = current_setting('${SOURCE_SETTING}');
    if ${STORE_ABSENT} and not exists (select 1 from facetdb.decisions) then
      drop table facetdb.decisions;
    end if;
  end if;
  if to_regclass('facetdb.question_set_versions') is not null then
    delete from facetdb.question_set_versions where source_id = current_setting('${SOURCE_SETTING}');
    if ${STORE_ABSENT} and not exists (select 1 from facetdb.question_set_versions) then
      drop table facetdb.question_set_versions;
    end if;
  end if;
end $$`);
}

/**
 * `facetdb.projects` goes last among the store's tables, after the purge block: once no project
 * remains and nothing that references it is left (the first sweep dropped those with it empty).
 */
function projectsTableStatement(): InstallStatement {
  return plain(`do $$
begin
  if to_regclass('facetdb.projects') is not null
     and not exists (select 1 from facetdb.projects)
     and to_regclass('facetdb.table_owners') is null
     and to_regclass('facetdb.sources') is null
     and to_regclass('facetdb.credentials') is null
     and to_regclass('facetdb.api_keys') is null then
    drop table facetdb.projects;
  end if;
end $$`);
}

/** The schema, only when empty: a plain drop refuses while anything is in it. */
function dropSchemaStatement(): InstallStatement {
  return plain(`do $$
begin
  drop schema if exists facetdb;
exception when dependent_objects_still_exist then
  null;
end $$`);
}

/**
 * The script of a log-only purge: the table was uninstalled earlier (its owner row is gone), so
 * only the source's rows of the decision log (and their question-set versions) are deleted.
 */
export function logOnlyPurgeSql(sourceId: string): readonly InstallStatement[] {
  return [
    ...SCRIPT_HEADER,
    settingsStatement([[SOURCE_SETTING, sourceId]]),
    purgeStatement(),
    dropSchemaStatement(),
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
      /**
       * What the caller must be told besides the script: which source's log the purge deletes (or
       * that it deletes none), and objects left in place on purpose.
       */
      readonly notes: readonly string[];
    }
  | {
      /** Nothing was changed. The reason says why and what to do. */
      readonly ok: false;
      readonly reason: string;
    };

const flag = (rows: readonly SqlRow[]) => rows[0]?.["present"] === true;

const relationPresent = async (query: SqlQuery, name: string) =>
  flag(await query(`select to_regclass($1) is not null as present`, [name]));

/** Whether `facetdb.table_owners` has a row for the table: the mark that install claimed it. */
async function hasOwnerRow(query: SqlQuery, source: UninstallSource): Promise<boolean> {
  if (!(await relationPresent(query, "facetdb.table_owners"))) {
    return false;
  }
  const rows = await query(
    "select true as present from facetdb.table_owners where table_schema = $1 and table_name = $2",
    [source.schema ?? "public", source.table],
  );
  return flag(rows);
}

/** The ids of the store's `sources` rows matching a condition (none while the store has no such table). */
async function storeSourceIds(
  query: SqlQuery,
  condition: string,
  params: readonly string[],
): Promise<readonly string[]> {
  if (!(await relationPresent(query, "facetdb.sources"))) {
    return [];
  }
  const rows = await query(`select id from facetdb.sources where ${condition} order by id`, params);
  return rows.map((row) => String(row["id"]));
}

/**
 * The source whose log the purge deletes, for a table with an owner row. A database table's log
 * lives under the table's own name (`facetdb init` names a database source after its table), and
 * the store's `sources` hold only plugin and API sources, which can never be this table. So the
 * caller's id counts only when it is the owner row's table name, and not when a live store source
 * has that id (that log is not this table's). Anything else resolves to nothing, and the purge
 * deletes no row.
 */
async function resolveOwnedPurgeSource(
  query: SqlQuery,
  installed: InstalledTable,
  given: string,
): Promise<string | undefined> {
  if (given !== installed.table) {
    return undefined;
  }
  return (await storeSourceIds(query, "id = $1", [given])).length > 0 ? undefined : given;
}

/**
 * The source for a log-only purge, when the table's owner row is gone. Only the table's own name
 * counts (the same rule as for an installed table), so a mistyped table or schema cannot reach
 * another source's log; and it resolves to nothing while that name is still live: a plugin or API
 * source in the store's `sources`, or an installed table of that name in any schema. The log must
 * hold rows for it.
 */
async function resolveLogOnlySource(
  query: SqlQuery,
  source: UninstallSource,
): Promise<string | undefined> {
  const given = source.sourceId;
  if (given !== source.table) {
    return undefined;
  }
  if ((await storeSourceIds(query, "id = $1 or name = $1", [given])).length > 0) {
    return undefined;
  }
  if (await relationPresent(query, "facetdb.table_owners")) {
    const installedElsewhere = await query(
      "select true as present from facetdb.table_owners where table_name = $1",
      [given],
    );
    if (flag(installedElsewhere)) {
      return undefined;
    }
  }
  return (await logCounts(query, given)).decisions > 0 ? given : undefined;
}

type LogCounts = { readonly decisions: number; readonly versions: number };

/** How many rows of a source's decision log, and of its question-set versions, a purge deletes. */
async function logCounts(query: SqlQuery, sourceId: string): Promise<LogCounts> {
  const count = async (relation: "decisions" | "question_set_versions") =>
    (await relationPresent(query, `facetdb.${relation}`))
      ? Number(
          (
            await query(`select count(*)::int as n from facetdb.${relation} where source_id = $1`, [
              sourceId,
            ])
          )[0]?.["n"],
        )
      : 0;
  return { decisions: await count("decisions"), versions: await count("question_set_versions") };
}

function purgeNote(
  applied: boolean,
  given: string,
  resolved: string | undefined,
  counts: LogCounts | undefined,
): string {
  if (resolved === undefined || counts === undefined) {
    return `purge: no source named "${given}" belongs to this table or its project, so no decision was deleted.`;
  }
  return `purge: ${applied ? "deleted" : "will delete"} ${counts.decisions} decision(s) and ${counts.versions} question-set version(s) of source "${resolved}".`;
}

const SIDE_TABLE_FACTS = `select obj_description(c.oid, 'pg_class') as mark,
       exists (select 1 from pg_catalog.pg_constraint k where k.conrelid = c.oid and k.contype = 'f') as present
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p')`;

/**
 * A side table of FacetDB's (its mark) with no foreign key at all can no longer be tied to the
 * table being uninstalled, so the script leaves it in place; this says so, and how to remove it.
 */
async function orphanSideTable(
  query: SqlQuery,
  installed: InstalledTable,
): Promise<string | undefined> {
  if (installed.sideColumns !== undefined) {
    return undefined;
  }
  const name = `${installed.table}_answers`;
  const rows = await query(SIDE_TABLE_FACTS, [SIDE_TABLE_SCHEMA, name]);
  const row = rows[0];
  if (row === undefined || row["mark"] !== SIDE_MARK || flag(rows)) {
    return undefined;
  }
  const side = quoteTable({ schema: SIDE_TABLE_SCHEMA, name });
  return `left in place: ${side} is FacetDB's side table but has no foreign key to ${installed.schema}.${installed.table} (dropped by hand?), so it was not tied to this table. Drop it yourself when sure: drop table ${side};`;
}

/**
 * A purge after the table was uninstalled earlier (no owner row): only the decision log of the
 * source whose name matches is deleted, the script says exactly that, and the name typed back is
 * the source's. It refuses, changing nothing, when the log holds nothing for that name.
 */
async function logOnlyPurge(
  client: SqlClient,
  options: UninstallOptions,
): Promise<UninstallResult> {
  const given = options.source.sourceId;
  const label = `${options.source.schema ?? "public"}.${options.source.table}`;
  const resolved = await resolveLogOnlySource(client.query, options.source);
  if (resolved === undefined) {
    return {
      ok: false,
      reason: `FacetDB is not installed on ${label} (facetdb.table_owners has no row for it), and no leftover decision log is named "${options.source.table}" (the source must carry the table's name, and not be live in the store or on an installed table); there is nothing to purge. Check the table and schema.`,
    };
  }
  const counts = await logCounts(client.query, resolved);
  const statements = logOnlyPurgeSql(resolved);
  const sql = renderSql(statements);
  options.print(sql);
  const notes = (applied: boolean) => [
    `${label} has no FacetDB install left; only the decision log was purged.`,
    purgeNote(applied, given, resolved, counts),
  ];
  if (options.dryRun === true) {
    return { ok: true, statements, sql, applied: false, notes: notes(false) };
  }
  const typed = await options.confirm({ project: { id: resolved, name: given } });
  if (typed.trim() !== given) {
    return {
      ok: false,
      reason: `the name typed is not the source's name (${given}); nothing was changed. Type the source name exactly to purge its decision log.`,
    };
  }
  await client.transaction(async (query) => {
    for (const statement of statements) {
      await query(statement.text, statement.params);
    }
  });
  return { ok: true, statements, sql, applied: true, notes: notes(true) };
}

/**
 * Reads what install left on the table, prints the script, asks for the project name, and runs the
 * script's statements in one transaction: all of it happens or none of it. The admin connection is
 * closed before this returns, whatever happened.
 */
export async function uninstall(options: UninstallOptions): Promise<UninstallResult> {
  const client = (options.connect ?? connectPostgres)(options.adminUrl);
  try {
    const purge = options.purge ?? false;
    if (purge && !(await hasOwnerRow(client.query, options.source))) {
      return await logOnlyPurge(client, options);
    }
    const installed = await readInstalled(client.query, options.source);
    if ("reason" in installed) {
      return { ok: false, reason: installed.reason };
    }
    const resolved = purge
      ? await resolveOwnedPurgeSource(client.query, installed, options.source.sourceId)
      : undefined;
    const statements = uninstallSql({ ...installed, sourceId: resolved }, { purge });
    const orphan = await orphanSideTable(client.query, installed);
    const counts = resolved === undefined ? undefined : await logCounts(client.query, resolved);
    const notes = (applied: boolean): readonly string[] => [
      ...(purge ? [purgeNote(applied, options.source.sourceId, resolved, counts)] : []),
      ...(orphan === undefined ? [] : [orphan]),
    ];
    const sql = renderSql(statements);
    options.print(sql);
    if (options.dryRun === true) {
      return { ok: true, statements, sql, applied: false, notes: notes(false) };
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
    return { ok: true, statements, sql, applied: true, notes: notes(true) };
  } finally {
    await client.close();
  }
}
