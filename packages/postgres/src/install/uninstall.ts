import { OWNED_MARK } from "../polling/index.ts";
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

/**
 * SQLSTATE `object_in_use`: the log-only purge's in-transaction re-check raises it when the source
 * became live after the checks before the confirmation (an install committed meanwhile).
 */
const SOURCE_LIVE_STATE = "55006";

export type UninstallSource = {
  readonly table: string;
  /** Defaults to `public`. */
  readonly schema?: string;
  /**
   * The source's name as the caller's config knows it. It is never compared with the table's name:
   * the log is found through the store's `sources` row of that name, the one the worker registers
   * for the source and writes the log under (see `resolveTableLog`).
   */
  readonly sourceId: string;
};

/**
 * What uninstall removes, as the catalog showed it, and which source's log rows `purge` deletes:
 * `sourceId` is the id already resolved against the store, or undefined when no source was found
 * (the script then has no `delete` of the log at all).
 */
export type UninstallTarget = Pick<
  InstalledTable,
  "schema" | "table" | "project" | "marked" | "sideColumns" | "viewMarked"
> & { readonly sourceId: string | undefined };

/**
 * The source's decision log as resolved against the store: `found` names the id its rows are
 * written under and how many rows it holds; `not-found` lists the names the store holds instead
 * (the table's project's sources, or for a log-only purge every source of that kind).
 */
export type SourceLog =
  | {
      readonly status: "found";
      /** The name the caller gave. */
      readonly given: string;
      readonly sourceId: string;
      readonly decisions: number;
      readonly versions: number;
    }
  | {
      readonly status: "not-found";
      readonly given: string;
      readonly found: readonly string[];
      /** Decisions the log holds under the given name with no registration (0: never logged). */
      readonly logged: number;
    };

/** Another source of the project whose log a purge leaves (an earlier name of this table's?). */
export type OtherSourceLog = { readonly source: string; readonly decisions: number };

/** Why the project's marker row stays after this script; any one keeps it. */
export type ProjectKeptBy =
  /** Another table of the project is still installed in this database. */
  | "another-table"
  /** The store holds a source, a credential or an API key (of any project). */
  | "store-in-use"
  /** The project's spending: its usage, reservations or alert marks. */
  | "usage"
  | "heartbeats"
  /** An unfinished backfill cursor (cursors name no project, so any keeps every project). */
  | "cursors"
  /** Records of one of the project's store sources. */
  | "records"
  /** Webhooks of the project neither delivered nor given up (retried for 24 hours). */
  | "pending-deliveries";

/** The command that deletes a log left behind by a plain uninstall, once nothing uses its source. */
export type LogOnlyPurge = { readonly source: string; readonly command: string };

/** An installed table other than the one uninstalled, as `schema.table`, with its project. */
export type OtherTable = {
  readonly name: string;
  readonly schema: string;
  readonly projectId: string;
};

/** A table by schema and name, as a run of several uninstalls names its other tables. */
export type TableName = { readonly schema: string; readonly table: string };

/** What the script removes from the table itself, each only when the catalog shows it there. */
export type TableRemoval = {
  /** FacetDB's marked columns on the table (inline mode). */
  readonly columns: readonly string[];
  /** The side table, as `schema.table`, in side-table mode. */
  readonly sideTable: string | undefined;
  /** FacetDB's marked view beside the table, as `schema.view`. */
  readonly view: string | undefined;
  /** The change-capture trigger, when it is on the table. */
  readonly trigger: string | undefined;
  /** FacetDB's row-level policies on the table. */
  readonly policies: readonly string[];
  /** Whether the worker login exists, so its rights on the table are revoked. */
  readonly workerGrants: boolean;
  /** Whether the worker loses its usage on the table's schema (no other installed table in it). */
  readonly schemaUsage: boolean;
};

/**
 * What the script does beyond the printed SQL, as read from the database before it runs (the script
 * decides again at run time; these are for the words the CLI prints).
 */
export type UninstallPlan = {
  /** `table` uninstalls an installed table; `log-only` only purges a log its earlier uninstall left. */
  readonly mode: "table" | "log-only";
  readonly schema: string;
  readonly table: string;
  /** The project whose marker the script may remove: the table's, or the purged source's. */
  readonly projectId: string;
  /**
   * The name the confirmation must have typed back: the project's name for a table, the source's
   * for a log-only purge.
   */
  readonly confirmName: string;
  /** What the script removes from the table; undefined for a log-only purge (nothing is left on it). */
  readonly tableRemoval: TableRemoval | undefined;
  /** Whether `--purge` was asked. The log's rows are deleted only when it was and `log` is found. */
  readonly purge: boolean;
  readonly log: SourceLog;
  /**
   * Whether the decision log's tables (`facetdb.decisions`, `facetdb.question_set_versions`) are
   * dropped: only by a purge, once no row of any source is left in them and no store uses them.
   */
  readonly logTablesDropped: boolean;
  /** Empty: the project's marker row goes. Otherwise every reason it stays. */
  readonly projectKeptBy: readonly ProjectKeptBy[];
  /**
   * Whether the store's shared tables (usage, alerts and their history, heartbeats, cursors,
   * records, the webhook outbox, the projects) are dropped: only when no project, no installed
   * table, no store use and no pending delivery is left.
   */
  readonly sharedTablesDropped: boolean;
  /** Whether `facetdb.table_owners` is there and dropped: no installed table and no store use is left. */
  readonly markerTablesDropped: boolean;
  /**
   * Whether `facetdb.jobs` is there and dropped: as the marker table, and only while it holds no
   * other table's entry and no trigger anywhere calls a function that writes to it.
   */
  readonly jobsTableDropped: boolean;
  /** Whether the enqueue trigger functions are there and go: no trigger outside this run calls them. */
  readonly queueFunctionsDropped: boolean;
  /** Queued jobs of tables outside this run; any keeps `facetdb.jobs`. */
  readonly queuedElsewhere: number;
  /**
   * Tables outside this run (`schema.table`) with a trigger calling the enqueue functions, owner
   * row or not: each keeps those functions, `facetdb.jobs` and so the schema.
   */
  readonly queueTriggers: readonly string[];
  /** Whether the `facetdb` schema goes too: a purge that leaves nothing in it. */
  readonly schemaDropped: boolean;
  /**
   * The schemas whose usage the worker login loses by the end of the run: each table's of the run,
   * once no installed table outside the run is in it (`tableRemoval.schemaUsage` is this script's).
   */
  readonly schemaUsageRevoked: readonly string[];
  /**
   * The installed tables other than this one (and the other tables of this run), of any project;
   * any keeps the shared tables.
   */
  readonly otherTables: readonly OtherTable[];
  /** The other projects of the store; any keeps the shared tables. */
  readonly otherProjects: readonly string[];
  /** Webhook deliveries of the project still pending; they and their project row stay. */
  readonly pendingDeliveries: number;
  /** Webhook deliveries of other projects still pending; any keeps the shared tables. */
  readonly pendingElsewhere: number;
  /** After a plain uninstall that leaves a log nothing else uses, the command that deletes it. */
  readonly logOnlyPurge: LogOnlyPurge | undefined;
  /** The run keys of unfinished backfill cursors (they keep every project and the shared tables). */
  readonly unfinishedCursors: readonly string[];
  /** With `--purge`: the project's other sources whose logs stay (none deleted but `log`'s). */
  readonly otherSourceLogs: readonly OtherSourceLog[];
  /** FacetDB objects the script leaves in place on purpose (an orphan side table), as `schema.table`. */
  readonly leftInPlace: readonly string[];
};

/**
 * Install now creates the store's tables in every database it touches, so their presence says
 * nothing; a store is in use when a plugin or API source, a stored credential or an API key lives in
 * it. The `do` blocks that care declare `in_use` with this prelude (the tables are read through
 * `execute`, since an install from before the store was part of the script has none of them).
 */
const IN_USE_TABLES = ["sources", "credentials", "api_keys"] as const;

const IN_USE_DECLARE = `declare
  in_use boolean := false;
  t text;
begin
  foreach t in array array[${IN_USE_TABLES.map(quoteLiteral).join(", ")}] loop
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

/** The project's own state in the store, by table and the column naming the project. */
const PROJECT_STATE: readonly (readonly [table: string, column: string, kept: ProjectKeptBy])[] = [
  ["usage", "project_id", "usage"],
  ["usage_reservations", "project_id", "usage"],
  ["usage_alerts", "project_id", "usage"],
  ["heartbeats", "project", "heartbeats"],
];

/** A webhook still to be sent: neither delivered nor given up (retried for 24 hours). */
const PENDING_DELIVERY = "delivered_at is null and gave_up_at is null";

/** A backfill cursor a run would resume from; a finished one restarts from the top anyway. */
const UNFINISHED_CURSOR = "not done";

/** The uninstall script for one table, in the order it runs. */
export function uninstallSql(
  source: UninstallTarget,
  options: { readonly purge: boolean },
): readonly InstallStatement[] {
  const table = quoteTable({ schema: source.schema, name: source.table });
  const sourceSchema = `current_setting('${SCHEMA_SETTING}')`;
  const sourceTable = `current_setting('${TABLE_SETTING}')`;
  const worker = quoteLiteral(WORKER_ROLE);
  const workerExists = `exists (select 1 from pg_catalog.pg_roles where rolname = ${worker})`;
  const purged = options.purge ? source.sourceId : undefined;
  return [
    ...SCRIPT_HEADER,
    settingsStatement([
      [SCHEMA_SETTING, source.schema],
      [TABLE_SETTING, source.table],
      [PROJECT_SETTING, source.project.id],
      ...(purged === undefined ? [] : [[SOURCE_SETTING, purged] as const]),
    ]),
    // Before anything changes: a log another installed table may share is never purged.
    ...(purged === undefined ? [] : [sharedLogGuardStatement()]),
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
    // The log before the marker and the shared tables: the purged source's registration is what
    // kept the store "in use", and with it gone the sweep below can see that nothing is.
    ...(options.purge ? purgeStatements(purged) : []),
    projectMarkerStatement(),
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
    sharedTablesStatement(),
    projectsTableStatement(),
    ...(options.purge ? [dropSchemaStatement()] : []),
  ];
}

/**
 * The project marker, when the project has no other table here and no state of its own in the
 * store. A polling-mode source has no table owner but keeps usage and heartbeats under the project,
 * a webhook not yet delivered is retried under it for 24 hours, its store sources' records are
 * the sources' state, and an unfinished backfill cursor names no project at all (so any keeps
 * every project): any of them keeps the row, so the shared tables below still see a project that
 * remains. Every table is looked up first (`to_regclass`):
 * a log-only purge may run after the marker tables are gone.
 */
function projectMarkerStatement(): InstallStatement {
  const project = `current_setting('${PROJECT_SETTING}')`;
  const owned = PROJECT_STATE.map(([table, column]) => quoteLiteral(`${table}:${column}`)).join(
    ", ",
  );
  return plain(`do $$
${IN_USE_DECLARE}
  declare
    has_state boolean := false;
  begin
    foreach t in array array[${owned}] loop
      if to_regclass(format('facetdb.%I', split_part(t, ':', 1))) is not null then
        execute format('select exists (select 1 from facetdb.%I where %I = $1)', split_part(t, ':', 1), split_part(t, ':', 2))
          into has_state using ${project};
        exit when has_state;
      end if;
    end loop;
    if not has_state and to_regclass('facetdb.webhook_outbox') is not null then
      select exists (select 1 from facetdb.webhook_outbox
                      where project_id = ${project} and ${PENDING_DELIVERY})
        into has_state;
    end if;
    if not has_state and to_regclass('facetdb.cursors') is not null then
      select exists (select 1 from facetdb.cursors c where ${UNFINISHED_CURSOR}) into has_state;
    end if;
    if not has_state and to_regclass('facetdb.records') is not null
       and to_regclass('facetdb.sources') is not null then
      select exists (select 1 from facetdb.records r join facetdb.sources s on s.id = r.source_id
                      where s.project_id = ${project}) into has_state;
    end if;
    if not has_state and to_regclass('facetdb.table_owners') is not null then
      select exists (select 1 from facetdb.table_owners o where o.project_id = ${project}) into has_state;
    end if;
    if ${STORE_ABSENT} and not has_state and to_regclass('facetdb.projects') is not null then
      delete from facetdb.projects where id = ${project};
    end if;
  end;
end $$`);
}

/**
 * The queue and the marker tables, once no installed table and no store is left to use them; the
 * store's other tables once no project remains and no webhook is still to be delivered.
 */
function sharedTablesStatement(): InstallStatement {
  return plain(`do $$
${IN_USE_DECLARE}
  declare
    owned boolean := false;
    remaining boolean := false;
    pending boolean := false;
  begin
    if to_regclass('facetdb.table_owners') is not null then
      select exists (select 1 from facetdb.table_owners) into owned;
    end if;
    if ${STORE_ABSENT} and not owned then
      -- The queue stays while a trigger anywhere in the database still calls a function that writes
      -- to it (a table whose owner row is gone, or one installed by hand), and while it holds an entry.
      if to_regclass('${JOBS_TABLE}') is not null then
        if not exists (select 1 from ${JOBS_TABLE})
           and not exists (
             select 1 from pg_catalog.pg_trigger t
               join pg_catalog.pg_proc p on p.oid = t.tgfoid
              where p.pronamespace = to_regnamespace('facetdb')
                and p.proname in ('enqueue', 'enqueue_keep', 'enqueue_side')
                and not t.tgisinternal) then
          drop table ${JOBS_TABLE};
        end if;
      end if;
      drop table if exists facetdb.table_owners;
      -- The store's other tables are shared by every project: they go only when no project remains
      -- (a polling-mode project has no table owner but keeps its usage, cursors and heartbeats), and
      -- never while a webhook is still to be delivered, whoever's it is.
      if to_regclass('facetdb.projects') is not null then
        select exists (select 1 from facetdb.projects) into remaining;
      end if;
      if to_regclass('facetdb.webhook_outbox') is not null then
        select exists (select 1 from facetdb.webhook_outbox where ${PENDING_DELIVERY}) into pending;
      end if;
      if not remaining and not pending then
        drop table if exists ${IN_USE_TABLES.map((name) => `facetdb.${quoteIdent(name)}`).join(", ")};
        drop table if exists ${[...BOOKKEEPING_TABLES, STORE_VERSION_TABLE].map((name) => `facetdb.${quoteIdent(name)}`).join(", ")};
        drop function if exists ${STORE_FUNCTIONS.join(", ")};
      end if;
    end if;
  end;
end $$`);
}

/**
 * The decision log: the resolved source's rows, its question-set versions (they only explain the
 * log's version numbers) and its registration in `sources` (the worker's, under the project, as a
 * plugin-kind source; with its log gone it holds nothing). An unresolved source gets no `delete` at
 * all. Then each table, once no row of anyone's is left and no store uses it.
 */
function purgeStatements(sourceId: string | undefined): readonly InstallStatement[] {
  const source = `current_setting('${SOURCE_SETTING}')`;
  const project = `current_setting('${PROJECT_SETTING}')`;
  const deletes =
    sourceId === undefined
      ? []
      : [
          plain(`do $$
begin
  if to_regclass('facetdb.decisions') is not null then
    delete from facetdb.decisions where source_id = ${source};
  end if;
  if to_regclass('facetdb.question_set_versions') is not null then
    delete from facetdb.question_set_versions where source_id = ${source};
  end if;
  if to_regclass('facetdb.sources') is not null then
    delete from facetdb.sources where id = ${source} and project_id = ${project} and kind = 'plugin';
  end if;
end $$`),
        ];
  return [
    ...deletes,
    plain(`do $$
${IN_USE_DECLARE}
  if to_regclass('facetdb.decisions') is not null then
    if ${STORE_ABSENT} and not exists (select 1 from facetdb.decisions) then
      drop table facetdb.decisions;
    end if;
  end if;
  if to_regclass('facetdb.question_set_versions') is not null then
    if ${STORE_ABSENT} and not exists (select 1 from facetdb.question_set_versions) then
      drop table facetdb.question_set_versions;
    end if;
  end if;
end $$`),
  ];
}

/**
 * `facetdb.projects` goes last among the store's tables, after the purge block: once no project
 * remains and nothing that references it is left (the sweep dropped those with it empty).
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
 * FacetDB's marks on a table, in any install mode: a marked column (inline or polling), a trigger
 * calling a function of the `facetdb` schema, or a marked side table whose foreign key references
 * it. `relation` is an SQL expression for the table's `regclass` (a constant of this module, never
 * a user value); shared by the check before the confirmation and the re-check in the transaction.
 */
const installMarks = (relation: string) => `exists (
      select 1 from pg_catalog.pg_attribute a
       where a.attrelid = ${relation} and a.attnum > 0 and not a.attisdropped
         and col_description(a.attrelid, a.attnum) = ${quoteLiteral(OWNED_MARK)})
   or exists (
      select 1 from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid = t.tgfoid
       where t.tgrelid = ${relation} and not t.tgisinternal
         and p.pronamespace = to_regnamespace('facetdb'))
   or exists (
      select 1 from pg_catalog.pg_constraint k
       where k.confrelid = ${relation} and k.contype = 'f'
         and obj_description(k.conrelid, 'pg_class') = ${quoteLiteral(SIDE_MARK)})`;

/**
 * The words of a purge refused because another table is installed. The store keys a source's
 * log by its name alone (`ensureSource` registers `id = name`, `on conflict do nothing`), so two
 * projects whose sources share a name write one log: while any other table is installed, the log
 * may be partly its source's. Shared by the check before the confirmation and the guard below.
 */
const sharedLogReason = (source: string, table: string, project: string) =>
  `the decision log of source "${source}" may be shared with ${table} (project ${project}), which is still installed; uninstall that table first, or keep the log. Nothing was changed.`;

/**
 * Every purge's guard, first inside its transaction when it deletes a log: the owner rows are
 * locked (`share` waits for an install in flight and keeps a new one out until the purge commits),
 * and an owner row of any table but this one, of any project in any schema, raises
 * `object_in_use` with `sharedLogReason`'s words.
 */
function sharedLogGuardStatement(): InstallStatement {
  return plain(`do $$
declare
  v_schema text := current_setting('${SCHEMA_SETTING}');
  v_table text := current_setting('${TABLE_SETTING}');
  v_project text := current_setting('${PROJECT_SETTING}');
  v_source text := current_setting('${SOURCE_SETTING}');
  v_owner text;
  v_owner_project text;
begin
  if to_regclass('facetdb.table_owners') is not null then
    lock table facetdb.table_owners in share mode;
    select format('%I.%I', o.table_schema, o.table_name), o.project_id
      into v_owner, v_owner_project
      from facetdb.table_owners o
     where not (o.table_schema = v_schema and o.table_name = v_table)
     order by o.project_id = v_project desc, 1
     limit 1;
    if v_owner is not null then
      raise exception '${sharedLogReason("%", "%", "%")}', v_source, v_owner, v_owner_project
        using errcode = 'object_in_use';
    end if;
  end if;
end $$`);
}

/**
 * The log-only purge's checks, again inside its transaction, after every check before the
 * confirmation: the owner rows are locked first (`share` waits for an install in flight, which
 * inserts its owner row, and keeps a new one out until the purge commits), then any sign that the
 * source is live raises `object_in_use` and the whole script rolls back.
 */
function liveRecheckStatement(): InstallStatement {
  return plain(`do $$
declare
  v_schema text := current_setting('${SCHEMA_SETTING}');
  v_table text := current_setting('${TABLE_SETTING}');
  v_project text := current_setting('${PROJECT_SETTING}');
  v_source text := current_setting('${SOURCE_SETTING}');
  v_relation regclass := to_regclass(format('%I.%I', v_schema, v_table));
begin
  if to_regclass('facetdb.table_owners') is not null then
    lock table facetdb.table_owners in share mode;
    if exists (select 1 from facetdb.table_owners o
                where o.table_schema = v_schema and o.table_name = v_table) then
      raise exception 'the decision log of source "%" is live again: %.% is now installed for its project; nothing was changed', v_source, v_schema, v_table
        using errcode = 'object_in_use';
    end if;
  end if;
  if v_relation is not null and (${installMarks("v_relation")}) then
    raise exception 'the decision log of source "%" is live again: %.% has FacetDB columns or a trigger; nothing was changed', v_source, v_schema, v_table
      using errcode = 'object_in_use';
  end if;
  if to_regclass('facetdb.records') is not null then
    if exists (select 1 from facetdb.records r where r.source_id = v_source) then
      raise exception 'the decision log of source "%" is live again: the store holds records for it; nothing was changed', v_source
        using errcode = 'object_in_use';
    end if;
  end if;
end $$`);
}

/**
 * The script of a log-only purge: the table was uninstalled earlier (its owner row is gone), so
 * after the re-check only the source's log (its rows, versions and registration) is deleted, and
 * what that leaves unused goes as after an uninstall: the project marker, the shared tables, the
 * schema.
 */
function logOnlyPurgeSql(target: {
  readonly schema: string;
  readonly table: string;
  readonly projectId: string;
  readonly sourceId: string;
}): readonly InstallStatement[] {
  return [
    ...SCRIPT_HEADER,
    settingsStatement([
      [SCHEMA_SETTING, target.schema],
      [TABLE_SETTING, target.table],
      [PROJECT_SETTING, target.projectId],
      [SOURCE_SETTING, target.sourceId],
    ]),
    liveRecheckStatement(),
    sharedLogGuardStatement(),
    ...purgeStatements(target.sourceId),
    projectMarkerStatement(),
    sharedTablesStatement(),
    projectsTableStatement(),
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
  /**
   * The other tables a caller uninstalls in the same run (before or after this one): the plan
   * counts them as gone, so it says what the whole run leaves. The script is not changed by it; it
   * decides again at run time from what is installed then.
   */
  readonly alsoUninstalling?: readonly TableName[];
  readonly connect?: SqlConnect;
};

export type UninstallResult =
  | {
      readonly ok: true;
      readonly statements: readonly InstallStatement[];
      readonly sql: string;
      /** False on a dry run. */
      readonly applied: boolean;
      readonly plan: UninstallPlan;
      /**
       * What the caller must be told besides the script: which source's log the purge deletes (or
       * why it deletes none), the log a plain uninstall leaves, pending webhook deliveries, and
       * objects left in place on purpose.
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

/**
 * How many rows of a store table match a condition, 0 while the store has no such table. The
 * table and the condition are this module's constants; values travel as parameters.
 */
async function storeRows(
  query: SqlQuery,
  table: string,
  condition: string,
  params: readonly unknown[] = [],
): Promise<number> {
  if (!(await relationPresent(query, `facetdb.${table}`))) {
    return 0;
  }
  const rows = await query(
    `select count(*)::int as n from facetdb.${quoteIdent(table)} where ${condition}`,
    params,
  );
  return Number(rows[0]?.["n"]);
}

/** Whether `facetdb.table_owners` has a row for the table: the mark that install claimed it. */
async function hasOwnerRow(query: SqlQuery, schema: string, table: string): Promise<boolean> {
  return (
    (await storeRows(query, "table_owners", "table_schema = $1 and table_name = $2", [
      schema,
      table,
    ])) > 0
  );
}

const INSTALL_MARKS = `select ${installMarks("c.relation")} as present
  from (select to_regclass(format('%I.%I', $1::text, $2::text)) as relation) c
 where c.relation is not null`;

/** Whether the table carries anything of a FacetDB install, in any mode, owner row or not. */
async function hasInstallMarks(query: SqlQuery, schema: string, table: string): Promise<boolean> {
  return flag(await query(INSTALL_MARKS, [schema, table]));
}

/** A source of the store as uninstall sees it. */
type StoreSource = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
  /** A store-backed source (plugin or API) keeps records; a database table's source never does. */
  readonly hasRecords: boolean;
};

/**
 * The store's plugin-kind sources matching `condition` (on `s`): a database table's source is
 * registered as one by the worker and backfill (the store has no third kind), its log written
 * under its id. API sources are never a table's and are not listed.
 */
async function pluginSources(
  query: SqlQuery,
  condition: string,
  params: readonly unknown[],
): Promise<readonly StoreSource[]> {
  if (!(await relationPresent(query, "facetdb.sources"))) {
    return [];
  }
  const records = (await relationPresent(query, "facetdb.records"))
    ? "exists (select 1 from facetdb.records r where r.source_id = s.id)"
    : "false";
  const rows = await query(
    `select s.id, s.name, s.project_id, ${records} as has_records
       from facetdb.sources s where s.kind = 'plugin' and ${condition} order by s.name, s.id`,
    params,
  );
  return rows.map((row) => ({
    id: String(row["id"]),
    name: String(row["name"]),
    projectId: String(row["project_id"]),
    hasRecords: row["has_records"] === true,
  }));
}

type LogCounts = { readonly decisions: number; readonly versions: number };

/** How many rows of a source's decision log, and of its question-set versions, a purge deletes. */
async function logCounts(query: SqlQuery, sourceId: string): Promise<LogCounts> {
  return {
    decisions: await storeRows(query, "decisions", "source_id = $1", [sourceId]),
    versions: await storeRows(query, "question_set_versions", "source_id = $1", [sourceId]),
  };
}

/**
 * The log of an installed table's source: the store's `sources` row of the table's project whose
 * name is the one given (unique per project), as the worker registered it, and not a store-backed
 * source (no records). Never a name compared with the table's: `facetdb init` may name a source
 * `t_listings` or lowercase it, and a source may be renamed.
 */
async function resolveTableLog(
  query: SqlQuery,
  installed: InstalledTable,
  given: string,
): Promise<SourceLog> {
  const candidates = await pluginSources(query, "s.project_id = $1", [installed.project.id]);
  const match = candidates.find((source) => source.name === given && !source.hasRecords);
  if (match === undefined) {
    return {
      status: "not-found",
      given,
      found: candidates.map((source) => source.name),
      logged: await storeRows(query, "decisions", "source_id = $1", [given]),
    };
  }
  return { status: "found", given, sourceId: match.id, ...(await logCounts(query, match.id)) };
}

/**
 * The project's other plugin-kind sources (no records) whose logs hold decisions: a purge leaves
 * them, and one may be this table's source under an earlier name (a rename registers a new row).
 */
async function otherSourceLogs(
  query: SqlQuery,
  projectId: string,
  sourceId: string,
): Promise<readonly OtherSourceLog[]> {
  const others = (
    await pluginSources(query, "s.project_id = $1 and s.id <> $2", [projectId, sourceId])
  ).filter((source) => !source.hasRecords);
  const logs: OtherSourceLog[] = [];
  for (const source of others) {
    const decisions = await storeRows(query, "decisions", "source_id = $1", [source.id]);
    if (decisions > 0) {
      logs.push({ source: source.name, decisions });
    }
  }
  return logs;
}

/**
 * An installed table other than this one, of any project in any schema (the project's own
 * first): while one exists, a log may be shared (`sharedLogReason`) and no purge runs.
 */
async function otherInstalledTable(
  query: SqlQuery,
  target: { readonly schema: string; readonly table: string; readonly projectId: string },
): Promise<{ readonly table: string; readonly projectId: string } | undefined> {
  if (!(await relationPresent(query, "facetdb.table_owners"))) {
    return undefined;
  }
  const rows = await query(
    `select format('%I.%I', table_schema, table_name) as name, project_id from facetdb.table_owners
      where not (table_schema = $1 and table_name = $2)
      order by project_id = $3 desc, 1 limit 1`,
    [target.schema, target.table, target.projectId],
  );
  const row = rows[0];
  return row === undefined
    ? undefined
    : { table: String(row["name"]), projectId: String(row["project_id"]) };
}

/** What a log-only purge acts on, or why it cannot. */
type LogOnlyTarget =
  | { readonly ok: true; readonly projectId: string; readonly log: SourceLog & { status: "found" } }
  | { readonly ok: false; readonly reason: string };

const listed = (names: readonly string[]) => (names.length === 0 ? "none" : names.join(", "));

/**
 * The source of a log-only purge, when the table's owner row is gone: the one plugin-kind source of
 * the store with the name given. It is refused while anything may still write its log: a store
 * source's records, or any installed table at all (the store does not record which table a source
 * reads, and two projects' same-named sources share one log). The log must hold something. The
 * transaction checks the same again (`liveRecheckStatement`, `sharedLogGuardStatement`).
 */
async function resolveLogOnlyTarget(
  query: SqlQuery,
  source: UninstallSource,
  schema: string,
  label: string,
): Promise<LogOnlyTarget> {
  const given = source.sourceId;
  const notInstalled = `FacetDB is not installed on ${label} (facetdb.table_owners has no row for it)`;
  const candidates = await pluginSources(query, "s.name = $1", [given]);
  const [match, ...others] = candidates;
  if (match === undefined) {
    const found = (await pluginSources(query, "true", [])).map((s) => s.name);
    return {
      ok: false,
      reason: `${notInstalled}, and the FacetDB store registers no source named "${given}" whose decision log could be purged (sources found: ${listed(found)}). Check the source's name, table and schema.`,
    };
  }
  if (others.length > 0) {
    return {
      ok: false,
      reason: `${notInstalled}, and the source name "${given}" is registered by several projects (${candidates.map((s) => s.projectId).join(", ")}); nothing was purged, since the log to delete cannot be told apart.`,
    };
  }
  if (match.hasRecords) {
    return {
      ok: false,
      reason: `${notInstalled}, and the source "${given}" is a live store source (it holds records); its decision log is not purged through a table.`,
    };
  }
  const other = await otherInstalledTable(query, {
    schema,
    table: source.table,
    projectId: match.projectId,
  });
  if (other !== undefined) {
    return { ok: false, reason: sharedLogReason(given, other.table, other.projectId) };
  }
  const counts = await logCounts(query, match.id);
  if (counts.decisions + counts.versions === 0) {
    return {
      ok: false,
      reason: `${notInstalled}, and the decision log holds nothing for source "${given}"; there is nothing to purge.`,
    };
  }
  return {
    ok: true,
    projectId: match.projectId,
    log: { status: "found", given, sourceId: match.id, ...counts },
  };
}

/** The store as the script will find it, read before it runs. */
type StoreForecast = Pick<
  UninstallPlan,
  | "projectKeptBy"
  | "sharedTablesDropped"
  | "logTablesDropped"
  | "otherTables"
  | "otherProjects"
  | "pendingDeliveries"
  | "pendingElsewhere"
  | "unfinishedCursors"
  | "markerTablesDropped"
  | "jobsTableDropped"
  | "queueFunctionsDropped"
  | "queuedElsewhere"
  | "queueTriggers"
  | "schemaDropped"
>;

/** The tables, owner row or not, with a trigger calling a function that writes to the queue. */
const QUEUE_TRIGGERS = `select distinct n.nspname as schema, c.relname as name
  from pg_catalog.pg_trigger t
  join pg_catalog.pg_proc p on p.oid = t.tgfoid
  join pg_catalog.pg_class c on c.oid = t.tgrelid
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where p.pronamespace = to_regnamespace('facetdb')
   and p.proname in ('enqueue', 'enqueue_keep', 'enqueue_side')
   and not t.tgisinternal
 order by 1, 2`;

const inRun = (run: readonly TableName[], schema: string, table: string) =>
  run.some((item) => item.schema === schema && item.table === table);

/**
 * The rows of a store table matching `condition`, ordered by the first column selected; none while
 * the store has no such table. The table, selection and condition are this module's constants.
 */
async function storeNames(
  query: SqlQuery,
  table: string,
  select: string,
  condition: string,
  params: readonly unknown[],
): Promise<readonly SqlRow[]> {
  if (!(await relationPresent(query, `facetdb.${table}`))) {
    return [];
  }
  return query(
    `select ${select} from facetdb.${quoteIdent(table)} where ${condition} order by 1`,
    params,
  );
}

/**
 * What the marker, purge and sweep blocks will decide, read before the script runs: the same
 * conditions on the same tables, with the purged source's registration and log rows (which the
 * script deletes first) already discounted. `schema`/`table` is the table whose owner row the
 * script deletes; `alsoUninstalling` are the other tables of the caller's run, counted as gone,
 * so the forecast is the run's.
 */
async function forecastStore(
  query: SqlQuery,
  target: {
    readonly schema: string;
    readonly table: string;
    readonly projectId: string;
    readonly purge: boolean;
    readonly purgedSourceId: string | undefined;
    readonly alsoUninstalling: readonly TableName[];
  },
): Promise<StoreForecast> {
  const project = target.projectId;
  const run: readonly TableName[] = [
    { schema: target.schema, table: target.table },
    ...target.alsoUninstalling,
  ];
  const otherTables = (
    await storeNames(
      query,
      "table_owners",
      "table_schema || '.' || table_name as name, project_id, table_schema, table_name",
      "true",
      [],
    )
  )
    .filter((row) => !inRun(run, String(row["table_schema"]), String(row["table_name"])))
    .map((row) => ({
      name: String(row["name"]),
      schema: String(row["table_schema"]),
      projectId: String(row["project_id"]),
    }));
  const queueTriggers = (await query(QUEUE_TRIGGERS))
    .filter((row) => !inRun(run, String(row["schema"]), String(row["name"])))
    .map((row) => `${String(row["schema"])}.${String(row["name"])}`);
  // The queue's entries of every table of the run go with their tables.
  const runEntries = run
    .map((item) => `starts_with(record_key, ${quoteLiteral(queueKeyPrefix(item))})`)
    .join(" or ");
  const queuedElsewhere = (await relationPresent(query, JOBS_TABLE))
    ? Number(
        (
          await query(`select count(*)::int as n from ${JOBS_TABLE} where not (${runEntries})`)
        )[0]?.["n"],
      )
    : 0;
  const sources =
    (await storeRows(query, "sources", "true")) - (target.purgedSourceId === undefined ? 0 : 1);
  const inUse =
    sources > 0 ||
    (await storeRows(query, "credentials", "true")) > 0 ||
    (await storeRows(query, "api_keys", "true")) > 0;
  const pendingDeliveries = await storeRows(
    query,
    "webhook_outbox",
    `project_id = $1 and ${PENDING_DELIVERY}`,
    [project],
  );
  const keptBy: ProjectKeptBy[] = [];
  const keep = (reason: ProjectKeptBy, present: boolean) => {
    if (present && !keptBy.includes(reason)) {
      keptBy.push(reason);
    }
  };
  keep(
    "another-table",
    otherTables.some((other) => other.projectId === project),
  );
  keep("store-in-use", inUse);
  for (const [table, column, reason] of PROJECT_STATE) {
    keep(reason, (await storeRows(query, table, `${quoteIdent(column)} = $1`, [project])) > 0);
  }
  const unfinishedCursors = (await relationPresent(query, "facetdb.cursors"))
    ? (await query(`select run from facetdb.cursors where ${UNFINISHED_CURSOR} order by run`)).map(
        (row) => String(row["run"]),
      )
    : [];
  keep("cursors", unfinishedCursors.length > 0);
  const projectRecords = (await relationPresent(query, "facetdb.sources"))
    ? await storeRows(
        query,
        "records",
        "source_id in (select s.id from facetdb.sources s where s.project_id = $1)",
        [project],
      )
    : 0;
  keep("records", projectRecords > 0);
  keep("pending-deliveries", pendingDeliveries > 0);
  const otherProjects = (await storeNames(query, "projects", "id", "id <> $1", [project])).map(
    (row) => String(row["id"]),
  );
  const pendingElsewhere = await storeRows(
    query,
    "webhook_outbox",
    `project_id <> $1 and ${PENDING_DELIVERY}`,
    [project],
  );
  // The purge block drops each log table once no row of anyone's is left in it and no store uses it.
  const others = target.purgedSourceId === undefined ? "true" : "source_id <> $1";
  const othersParams = target.purgedSourceId === undefined ? [] : [target.purgedSourceId];
  const logTablesDropped =
    target.purge &&
    !inUse &&
    (await storeRows(query, "decisions", others, othersParams)) === 0 &&
    (await storeRows(query, "question_set_versions", others, othersParams)) === 0;
  const sharedTablesDropped =
    !inUse &&
    otherTables.length === 0 &&
    keptBy.length === 0 &&
    otherProjects.length === 0 &&
    pendingDeliveries + pendingElsewhere === 0;
  // The sweep's first branch: no store use and no owned table left (`sharedTablesStatement`).
  const sweeps = !inUse && otherTables.length === 0;
  const markerTablesDropped = sweeps && (await relationPresent(query, "facetdb.table_owners"));
  const jobsTableDropped =
    sweeps &&
    queuedElsewhere === 0 &&
    queueTriggers.length === 0 &&
    (await relationPresent(query, JOBS_TABLE));
  const queueFunctionsDropped =
    queueTriggers.length === 0 &&
    flag(
      await query(
        `select exists (select 1 from pg_catalog.pg_proc
                         where pronamespace = to_regnamespace('facetdb')
                           and proname in ('enqueue', 'enqueue_keep', 'enqueue_side')) as present`,
      ),
    );
  return {
    projectKeptBy: keptBy,
    sharedTablesDropped,
    logTablesDropped,
    markerTablesDropped,
    jobsTableDropped,
    queueFunctionsDropped,
    queuedElsewhere,
    queueTriggers,
    // The schema goes only empty: everything above gone, the trigger functions included.
    schemaDropped:
      target.purge &&
      logTablesDropped &&
      sharedTablesDropped &&
      queueTriggers.length === 0 &&
      queuedElsewhere === 0,
    otherTables,
    otherProjects,
    pendingDeliveries,
    pendingElsewhere,
    unfinishedCursors,
  };
}

/** What the script removes from the table itself, read from the catalog before it runs. */
async function tableRemoval(query: SqlQuery, installed: InstalledTable): Promise<TableRemoval> {
  // This script's own revoke decides on the tables installed now, whatever else the run removes.
  const neighbours = await storeRows(
    query,
    "table_owners",
    "table_schema = $1 and table_name <> $2",
    [installed.schema, installed.table],
  );
  const facts = await query(
    `select exists (select 1 from pg_catalog.pg_trigger t
                     where t.tgrelid = format('%I.%I', $1::text, $2::text)::regclass
                       and t.tgname = $3 and not t.tgisinternal) as trigger,
            exists (select 1 from pg_catalog.pg_roles where rolname = $4) as worker,
            array(select p.policyname::text from pg_catalog.pg_policies p
                   where p.schemaname = $1 and p.tablename = $2
                     and p.policyname in ('facetdb_reads', 'facetdb_writes') order by 1) as policies`,
    [installed.schema, installed.table, triggerName(installed), WORKER_ROLE],
  );
  const row = facts[0];
  const worker = row?.["worker"] === true;
  const policies = row?.["policies"];
  return {
    columns: installed.marked,
    sideTable:
      installed.sideColumns === undefined
        ? undefined
        : `${SIDE_TABLE_SCHEMA}.${installed.table}_answers`,
    view: installed.viewMarked ? `${installed.schema}.${sideViewName(installed.table)}` : undefined,
    trigger: row?.["trigger"] === true ? triggerName(installed) : undefined,
    policies: Array.isArray(policies) ? policies.map(String) : [],
    workerGrants: worker,
    // As the script's revoke: never on the `facetdb` schema, and not while another table is in it.
    schemaUsage: worker && installed.schema !== "facetdb" && neighbours === 0,
  };
}

function purgeNote(applied: boolean, log: SourceLog): string {
  if (log.status === "not-found" && log.logged === 0) {
    return `purge: no decisions were ever logged for source "${log.given}", nothing to purge.`;
  }
  if (log.status === "not-found") {
    return `purge: no source named "${log.given}" belongs to this table or its project, so no decision was deleted (the script has no delete of the log). The project's sources in the FacetDB store: ${listed(log.found)}.`;
  }
  return `purge: ${applied ? "deleted" : "will delete"} ${log.decisions} decision(s) and ${log.versions} question-set version(s) of source "${log.sourceId}".`;
}

/** The note for a log a plain uninstall leaves behind, and how it can be deleted later. */
function keptLogNote(log: SourceLog, later: LogOnlyPurge | undefined): string | undefined {
  if (log.status === "not-found" || log.decisions + log.versions === 0) {
    return undefined;
  }
  const kept = `the decision log of source "${log.given}" stays (${log.decisions} decision(s), ${log.versions} question-set version(s))`;
  return later === undefined
    ? `${kept}; it can be purged once no other table is installed in this database (facetdb uninstall --purge --source ${log.given}).`
    : `${kept}; to delete it later: ${later.command}`;
}

/** The logs a purge leaves: the project's other sources, perhaps this table's under an older name. */
function otherLogsNotes(logs: readonly OtherSourceLog[]): readonly string[] {
  return logs.map(
    ({ source, decisions }) =>
      `left in place: the decision log of source "${source}" (${decisions} decision(s)), another source of this project in the FacetDB store; if it was this table's source under an earlier name, delete it with: facetdb uninstall --purge --source ${source}`,
  );
}

/** When an unfinished backfill cursor alone keeps the project and the store's shared tables. */
function cursorNote(forecast: StoreForecast, projectId: string): string | undefined {
  if (forecast.projectKeptBy.length !== 1 || forecast.projectKeptBy[0] !== "cursors") {
    return undefined;
  }
  return `the project ${projectId} and the store's shared tables stay because of an unfinished backfill cursor (run ${forecast.unfinishedCursors.join(", ")}); it keeps the shared tables until the backfill finishes or the cursor is deleted.`;
}

function pendingNote(n: number, projectId: string): string | undefined {
  if (n === 0) {
    return undefined;
  }
  return `${n} webhook deliver${n === 1 ? "y" : "ies"} of project ${projectId} still pending: the project and the webhook outbox stay until each is delivered or given up (retried for 24 hours).`;
}

const SIDE_TABLE_FACTS = `select obj_description(c.oid, 'pg_class') as mark,
       exists (select 1 from pg_catalog.pg_constraint k where k.conrelid = c.oid and k.contype = 'f') as present
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'p')`;

/**
 * A side table of FacetDB's (its mark) with no foreign key at all can no longer be tied to the
 * table being uninstalled, so the script leaves it in place; this names it (`schema.table`, for the
 * plan) and says how to remove it (the note). A same-named table installed in another schema
 * shares the side table's name, so then it may be that table's, and it is not named at all.
 */
async function orphanSideTable(
  query: SqlQuery,
  installed: InstalledTable,
): Promise<{ readonly name: string; readonly note: string } | undefined> {
  if (installed.sideColumns !== undefined) {
    return undefined;
  }
  const name = `${installed.table}_answers`;
  const rows = await query(SIDE_TABLE_FACTS, [SIDE_TABLE_SCHEMA, name]);
  const row = rows[0];
  if (row === undefined || row["mark"] !== SIDE_MARK || flag(rows)) {
    return undefined;
  }
  const namesake = await storeRows(
    query,
    "table_owners",
    "table_name = $1 and table_schema <> $2",
    [installed.table, installed.schema],
  );
  if (namesake > 0) {
    return undefined;
  }
  const side = quoteTable({ schema: SIDE_TABLE_SCHEMA, name });
  return {
    name: `${SIDE_TABLE_SCHEMA}.${name}`,
    note: `left in place: ${side} is FacetDB's side table but has no foreign key to ${installed.schema}.${installed.table} (dropped by hand?), so it was not tied to this table. Drop it yourself when sure: drop table ${side};`,
  };
}

/**
 * SQLSTATEs of a script that lost to a concurrent command: `deadlock_detected` (40P01) and
 * `lock_not_available` (55P03, the script's `lock_timeout`). The transaction rolled back whole.
 */
const CONCURRENT_STATES: readonly string[] = ["40P01", "55P03"];

const CONCURRENT_REASON =
  "another FacetDB command was running on this database at the same time; nothing was changed. Run it again.";

/**
 * The driver's error (a boundary), as the reason nothing was changed: a re-check's
 * `object_in_use` with its own message, or a lost race with a concurrent command.
 */
function refusedByDatabase(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  if (error.code === SOURCE_LIVE_STATE && error instanceof Error) {
    return error.message;
  }
  return typeof error.code === "string" && CONCURRENT_STATES.includes(error.code)
    ? CONCURRENT_REASON
    : undefined;
}

/**
 * Runs the script's statements in one transaction: all of it happens or none of it. A re-check
 * that found the source live again, or a lost race, comes back as the reason nothing was changed.
 */
async function runScript(
  client: SqlClient,
  statements: readonly InstallStatement[],
): Promise<string | undefined> {
  try {
    await client.transaction(async (query) => {
      for (const statement of statements) {
        await query(statement.text, statement.params);
      }
    });
    return undefined;
  } catch (error) {
    const refused = refusedByDatabase(error);
    if (refused === undefined) {
      throw error;
    }
    return refused;
  }
}

/**
 * A purge after the table was uninstalled earlier (no owner row, and nothing of an install of any
 * mode on the table): only the decision log of the source the store registers under the name given
 * is deleted, the script says exactly that, and the name typed back is the source's. It refuses,
 * changing nothing, when no single such source is found, when it may still be live, or when the
 * log holds nothing for it.
 */
async function logOnlyPurge(
  client: SqlClient,
  options: UninstallOptions,
  schema: string,
): Promise<UninstallResult> {
  const given = options.source.sourceId;
  const { table } = options.source;
  const label = `${schema}.${table}`;
  const target = await resolveLogOnlyTarget(client.query, options.source, schema, label);
  if (!target.ok) {
    return target;
  }
  const { log, projectId } = target;
  const forecast = await forecastStore(client.query, {
    schema,
    table,
    projectId,
    purge: true,
    purgedSourceId: log.sourceId,
    alsoUninstalling: options.alsoUninstalling ?? [],
  });
  const statements = logOnlyPurgeSql({ schema, table, projectId, sourceId: log.sourceId });
  const sql = renderSql(statements);
  options.print(sql);
  const plan: UninstallPlan = {
    mode: "log-only",
    schema,
    table,
    projectId,
    confirmName: given,
    tableRemoval: undefined,
    schemaUsageRevoked: [],
    purge: true,
    log,
    ...forecast,
    logOnlyPurge: undefined,
    otherSourceLogs: [],
    leftInPlace: [],
  };
  const pending = pendingNote(plan.pendingDeliveries, projectId);
  const cursor = cursorNote(forecast, projectId);
  const notes = (applied: boolean) => [
    `${label} has no FacetDB install left; only the decision log ${applied ? "was" : "is"} purged.`,
    purgeNote(applied, log),
    ...(pending === undefined ? [] : [pending]),
    ...(cursor === undefined ? [] : [cursor]),
  ];
  if (options.dryRun === true) {
    return { ok: true, statements, sql, applied: false, plan, notes: notes(false) };
  }
  const typed = await options.confirm({ project: { id: log.sourceId, name: given } });
  if (typed.trim() !== given) {
    return {
      ok: false,
      reason: `the name typed is not the source's name (${given}); nothing was changed. Type the source name exactly to purge its decision log.`,
    };
  }
  const live = await runScript(client, statements);
  if (live !== undefined) {
    return { ok: false, reason: live };
  }
  return { ok: true, statements, sql, applied: true, plan, notes: notes(true) };
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
    const schema = options.source.schema ?? "public";
    const { table } = options.source;
    // The log-only path only for a table with no install of any mode left: a polling-mode table
    // (marked columns, no owner row) or one whose owner row went by hand gets the refusal below.
    if (
      purge &&
      !(await hasOwnerRow(client.query, schema, table)) &&
      !(await hasInstallMarks(client.query, schema, table))
    ) {
      return await logOnlyPurge(client, options, schema);
    }
    const installed = await readInstalled(client.query, options.source);
    if ("reason" in installed) {
      return { ok: false, reason: installed.reason };
    }
    const log = await resolveTableLog(client.query, installed, options.source.sourceId);
    const purgedSourceId = purge && log.status === "found" ? log.sourceId : undefined;
    // A purge that would delete a log runs only while no other table is installed: two projects'
    // same-named sources write one log (the transaction checks again, `sharedLogGuardStatement`).
    if (purgedSourceId !== undefined) {
      const other = await otherInstalledTable(client.query, {
        schema: installed.schema,
        table: installed.table,
        projectId: installed.project.id,
      });
      if (other !== undefined) {
        return {
          ok: false,
          reason: sharedLogReason(options.source.sourceId, other.table, other.projectId),
        };
      }
    }
    const statements = uninstallSql({ ...installed, sourceId: purgedSourceId }, { purge });
    const forecast = await forecastStore(client.query, {
      schema: installed.schema,
      table: installed.table,
      projectId: installed.project.id,
      purge,
      purgedSourceId,
      alsoUninstalling: options.alsoUninstalling ?? [],
    });
    const later: LogOnlyPurge | undefined =
      !purge &&
      log.status === "found" &&
      log.decisions + log.versions > 0 &&
      forecast.otherTables.length === 0
        ? { source: log.given, command: `facetdb uninstall --purge --source ${log.given}` }
        : undefined;
    const others =
      purgedSourceId === undefined
        ? []
        : await otherSourceLogs(client.query, installed.project.id, purgedSourceId);
    const orphan = await orphanSideTable(client.query, installed);
    const removal = await tableRemoval(client.query, installed);
    // The schemas whose usage the run takes from the worker: each run table's, once no table
    // outside the run is left in it (the last script in that schema revokes it).
    const runSchemas = [
      installed.schema,
      ...(options.alsoUninstalling ?? []).map((other) => other.schema),
    ];
    const schemaUsageRevoked = removal.workerGrants
      ? [...new Set(runSchemas)].filter(
          (schema) =>
            schema !== "facetdb" && !forecast.otherTables.some((other) => other.schema === schema),
        )
      : [];
    const plan: UninstallPlan = {
      mode: "table",
      schema: installed.schema,
      table: installed.table,
      projectId: installed.project.id,
      confirmName: installed.project.name,
      tableRemoval: removal,
      schemaUsageRevoked,
      purge,
      log,
      ...forecast,
      // An orphan side table left in place keeps the schema from being empty.
      schemaDropped: forecast.schemaDropped && orphan === undefined,
      logOnlyPurge: later,
      otherSourceLogs: others,
      leftInPlace: orphan === undefined ? [] : [orphan.name],
    };
    const kept = purge ? undefined : keptLogNote(log, later);
    const pending = pendingNote(plan.pendingDeliveries, installed.project.id);
    const cursor = cursorNote(forecast, installed.project.id);
    const notes = (applied: boolean): readonly string[] => [
      ...(purge ? [purgeNote(applied, log)] : []),
      ...otherLogsNotes(others),
      ...(kept === undefined ? [] : [kept]),
      ...(pending === undefined ? [] : [pending]),
      ...(cursor === undefined ? [] : [cursor]),
      ...(orphan === undefined ? [] : [orphan.note]),
    ];
    const sql = renderSql(statements);
    options.print(sql);
    if (options.dryRun === true) {
      return { ok: true, statements, sql, applied: false, plan, notes: notes(false) };
    }
    const typed = await options.confirm({ project: installed.project });
    if (typed.trim() !== installed.project.name) {
      return {
        ok: false,
        reason: `the name typed is not the project's name (${installed.project.name}); nothing was changed. Type the project name exactly to uninstall.`,
      };
    }
    const live = await runScript(client, statements);
    if (live !== undefined) {
      return { ok: false, reason: live };
    }
    return { ok: true, statements, sql, applied: true, plan, notes: notes(true) };
  } finally {
    await client.close();
  }
}
