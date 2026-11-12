import type { QuestionSet } from "@facetdb/core";
import {
  BODY_TAG,
  SIDE_MARK,
  SIDE_TABLE_SCHEMA,
  sideTableName,
  sideViewName,
} from "../scan/index.ts";
import { connectPostgres, type SqlConnect, type SqlQuery, type SqlRow } from "../sql/index.ts";
import {
  ENQUEUE_ROLE,
  type InstallStatement,
  installOwnedColumns,
  installOwnedColumnTypes,
  installSql,
  ownedColumnsQuery,
  type ProjectRef,
  renderSql,
  type TableSource,
  WORKER_ROLE,
} from "./sql.ts";

/**
 * `migrate`: inspect the table, refuse what install must not touch, print the complete SQL, run it
 * in one transaction with the admin credential, and forget that credential. The command in
 * `facetdb` wraps this; the connector's `install` calls it.
 */

/** What the caller knows about the source; the key comes from the catalog unless given. */
export type MigrateSource = Omit<TableSource, "key" | "keyType"> & { readonly key?: string };

export type MigratePlan = {
  readonly source: MigrateSource;
  readonly questionSet: QuestionSet;
  readonly project: ProjectRef;
  /**
   * Required the first time, when the worker role does not exist yet. Given later, it resets the
   * role's password. The worker login is one per server: while another project (in this database
   * or another on the server) uses it, a reset is refused unless `rotateWorkerPassword` says so,
   * because that project's stored password would stop working without a word. The caller stores
   * the password encrypted; this function only passes it on.
   */
  readonly workerPassword?: string;
  /** Reset the shared worker password even though other projects use the login; they must be told. */
  readonly rotateWorkerPassword?: boolean;
};

export type MigrateOptions = {
  /** The admin connection string; used for this call and not retained. */
  readonly adminUrl: string;
  readonly plan: MigratePlan;
  /** Receives the complete script before anything runs; `facetdb migrate` prints it. */
  readonly print: (sql: string) => void;
  /** Print and stop, touching nothing. */
  readonly dryRun?: boolean;
  /** The driver; a test passes PGlite or a fake through the same parameter. */
  readonly connect?: SqlConnect;
};

export type MigrateResult =
  | {
      readonly ok: true;
      /** The key column, as inspected or given. */
      readonly key: string;
      readonly statements: readonly InstallStatement[];
      readonly sql: string;
      /** False on a dry run. */
      readonly applied: boolean;
      /** Whether the table lacked any of FacetDB's columns before this run: false on a repeat. */
      readonly changed: boolean;
      /** Whether the worker role's password was set by this run (created or reset). */
      readonly workerPasswordApplied: boolean;
    }
  | {
      /** A refusal: the table as it is must not be touched. The reason says what to do. */
      readonly ok: false;
      readonly reason: string;
    };

/** What a role on the server looks like, when it exists. */
type RoleFacts = {
  readonly exists: boolean;
  readonly superuser: boolean;
  readonly canLogin: boolean;
  readonly bypassRls: boolean;
  readonly createRole: boolean;
  readonly createDb: boolean;
  /** Roles it belongs to; FacetDB's roles belong to none. */
  readonly memberOf: readonly string[];
};

type Inspection = {
  /** Side-table mode and a role besides the owner holds select on the source. */
  readonly sourceReaders: boolean;
  readonly primaryKey: readonly string[];
  /** The primary key column's SQL type as `format_type` prints it; side-table mode creates its key with it. */
  readonly keyType: string | undefined;
  /** The columns of `facetdb.<table>_answers` (none when it does not exist); looked up in every mode, so a switch of mode is noticed. */
  readonly sideColumns: readonly string[];
  /** `data_type` of each side-table column, to notice a question whose type changed there too. */
  readonly sideTypes: ReadonlyMap<string, string>;
  /** `server_version_num`: side-table mode needs 150000 (views with `security_invoker`). */
  readonly serverVersion: number;
  /**
   * The relation named `<table>_with_answers` beside the source, when one exists: its comment
   * (`facetdb` for the view an earlier install made) or null for a comment-less relation of the
   * customer's; undefined when there is none.
   */
  readonly viewMark: string | null | undefined;
  /** Views or rules built on FacetDB's view beside the table (side-table mode drops and recreates it). */
  readonly viewDependents: number;
  /** The primary key is a stored generated column (null in a BEFORE trigger: the queue would get no key). */
  readonly generatedKey: boolean;
  /** `data_type` of each marked column, to notice a question whose type changed. */
  readonly markedTypes: ReadonlyMap<string, string>;
  readonly appOwned: readonly string[];
  readonly marked: readonly string[];
  readonly owner: string | null;
  readonly worker: RoleFacts;
  readonly enqueuer: RoleFacts;
  /** Other projects that installed in this database (the worker login is theirs too). */
  readonly otherProjects: readonly string[];
  /** Whether the worker login holds grants in other databases of this server. */
  readonly usedElsewhere: boolean;
};

const EXISTS_QUERY = `select 1 from information_schema.tables where table_schema = $1 and table_name = $2`;

const PRIMARY_KEY_QUERY = `select kcu.column_name as name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on kcu.constraint_name = tc.constraint_name
   and kcu.constraint_schema = tc.constraint_schema
   and kcu.table_schema = tc.table_schema
   and kcu.table_name = tc.table_name
 where tc.table_schema = $1 and tc.table_name = $2 and tc.constraint_type = 'PRIMARY KEY'
 order by kcu.ordinal_position`;

const KEY_TYPE_QUERY = `select format_type(a.atttypid, a.atttypmod) as type
  from pg_catalog.pg_attribute a
 where a.attrelid = format('%I.%I', $1::text, $2::text)::regclass and a.attname = $3 and not a.attisdropped`;

const SIDE_COLUMNS_QUERY = `select column_name as name, data_type as type from information_schema.columns
 where table_schema = $1 and table_name = $2 order by ordinal_position`;

const SERVER_VERSION_QUERY = `select current_setting('server_version_num')::int as v`;

/** Any relation (table, view, materialized view, foreign table) of that name, with its comment. */
const RELATION_MARK_QUERY = `select obj_description(c.oid, 'pg_class') as mark
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid = c.relnamespace
 where n.nspname = $1 and c.relname = $2 and c.relkind in ('r', 'v', 'm', 'f', 'p')`;

/** The roles a role is a member of: a pre-existing FacetDB role with `pg_read_all_data` is not least privilege. */
const MEMBERSHIP_QUERY = `select r.rolname as name
  from pg_catalog.pg_auth_members m
  join pg_catalog.pg_roles r on r.oid = m.roleid
  join pg_catalog.pg_roles mem on mem.oid = m.member
 where mem.rolname = $1 order by 1`;

/** A primary key that is a stored generated column is still null in a BEFORE trigger. */
const GENERATED_KEY_QUERY = `select is_generated as generated from information_schema.columns
 where table_schema = $1 and table_name = $2 and column_name = $3`;

/** Views and rules that depend on a relation, other than itself: a drop would take them down. */
const DEPENDENTS_QUERY = `select count(distinct r.ev_class)::int as n
  from pg_catalog.pg_depend d
  join pg_catalog.pg_rewrite r on r.oid = d.objid
 where d.refobjid = format('%I.%I', $1::text, $2::text)::regclass and r.ev_class <> d.refobjid`;

/** Roles other than the owner that hold table-level select on the source (what the reader grants copy). */
const READERS_QUERY = `select 1
  from pg_catalog.pg_class c
  join pg_catalog.pg_namespace n on n.oid = c.relnamespace
  cross join lateral pg_catalog.aclexplode(c.relacl) a
 where n.nspname = $1 and c.relname = $2 and a.privilege_type = 'SELECT' and a.grantee <> c.relowner
 limit 1`;

const OWNERS_EXISTS_QUERY = `select 1 from information_schema.tables where table_schema = 'facetdb' and table_name = 'table_owners'`;

const OWNER_QUERY = `select project_id from facetdb.table_owners where table_schema = $1 and table_name = $2`;

const OTHER_PROJECTS_QUERY = `select distinct project_id as name from facetdb.table_owners where project_id <> $1 order by 1`;

const ROLE_QUERY = `select rolsuper, rolcanlogin, rolbypassrls, rolcreaterole, rolcreatedb
  from pg_catalog.pg_roles where rolname = $1`;

/** Grants the role holds in databases other than this one (shared dependencies, `pg_shdepend`). */
const USED_ELSEWHERE_QUERY = `select 1
  from pg_catalog.pg_shdepend d
  join pg_catalog.pg_roles r on r.oid = d.refobjid
 where r.rolname = $1 and d.refclassid = 'pg_catalog.pg_authid'::regclass
   and d.dbid <> 0 and d.dbid <> (select oid from pg_catalog.pg_database where datname = current_database())
 limit 1`;

async function roleFacts(query: SqlQuery, name: string): Promise<RoleFacts> {
  const rows = await query(ROLE_QUERY, [name]);
  const row: SqlRow = rows[0] ?? {};
  return {
    exists: rows.length > 0,
    superuser: row["rolsuper"] === true,
    canLogin: row["rolcanlogin"] === true,
    bypassRls: row["rolbypassrls"] === true,
    createRole: row["rolcreaterole"] === true,
    createDb: row["rolcreatedb"] === true,
    memberOf:
      rows.length === 0
        ? []
        : (await query(MEMBERSHIP_QUERY, [name])).map((r) => String(r["name"])),
  };
}

async function inspect(
  query: SqlQuery,
  plan: MigratePlan,
): Promise<Inspection | { readonly missing: true }> {
  const { source, questionSet, project } = plan;
  const schema = source.schema ?? "public";
  const exists = await query(EXISTS_QUERY, [schema, source.table]);
  if (exists.length === 0) {
    return { missing: true };
  }
  const names = (rows: readonly SqlRow[]) => rows.map((row) => String(row["name"]));
  const primaryKey = names(await query(PRIMARY_KEY_QUERY, [schema, source.table]));
  const keyType =
    primaryKey.length === 1
      ? String((await query(KEY_TYPE_QUERY, [schema, source.table, primaryKey[0]]))[0]?.["type"])
      : undefined;
  // Looked up in every mode, by the plain derived name (a name over the limit simply is not found).
  const sideRows = await query(SIDE_COLUMNS_QUERY, [SIDE_TABLE_SCHEMA, `${source.table}_answers`]);
  const sideColumns = names(sideRows);
  const sideTypes = new Map(
    sideRows.map((row) => [String(row["name"]), String(row["type"])] as const),
  );
  const serverVersion = Number((await query(SERVER_VERSION_QUERY))[0]?.["v"] ?? 0);
  const viewRows = await query(RELATION_MARK_QUERY, [schema, `${source.table}_with_answers`]);
  const viewMark =
    viewRows.length === 0
      ? undefined
      : viewRows[0]?.["mark"] == null
        ? null
        : String(viewRows[0]["mark"]);
  const viewDependents =
    viewRows.length === 0
      ? 0
      : Number(
          (await query(DEPENDENTS_QUERY, [schema, `${source.table}_with_answers`]))[0]?.["n"] ?? 0,
        );
  const unmarked = ownedColumnsQuery(source, questionSet, { marked: false });
  const markedQuery = ownedColumnsQuery(source, questionSet, { marked: true });
  const appOwned = names(await query(unmarked.text, unmarked.params));
  const markedRows = await query(markedQuery.text, markedQuery.params);
  const marked = names(markedRows);
  const markedTypes = new Map(
    markedRows.map((row) => [String(row["name"]), String(row["type"])] as const),
  );
  const generatedKey =
    primaryKey.length === 1 &&
    (await query(GENERATED_KEY_QUERY, [schema, source.table, primaryKey[0]]))[0]?.["generated"] ===
      "ALWAYS";
  let owner: string | null = null;
  let otherProjects: readonly string[] = [];
  if ((await query(OWNERS_EXISTS_QUERY)).length > 0) {
    const rows = await query(OWNER_QUERY, [schema, source.table]);
    owner = rows.length === 0 ? null : String(rows[0]?.["project_id"]);
    otherProjects = names(await query(OTHER_PROJECTS_QUERY, [project.id]));
  }
  const worker = await roleFacts(query, WORKER_ROLE);
  const enqueuer = await roleFacts(query, ENQUEUE_ROLE);
  const usedElsewhere =
    worker.exists && (await query(USED_ELSEWHERE_QUERY, [WORKER_ROLE])).length > 0;
  const sourceReaders =
    source.storage === "side-table" &&
    (await query(READERS_QUERY, [schema, source.table])).length > 0;
  return {
    sourceReaders,
    primaryKey,
    keyType,
    sideColumns,
    sideTypes,
    serverVersion,
    viewMark,
    viewDependents,
    generatedKey,
    markedTypes,
    appOwned,
    marked,
    owner,
    worker,
    enqueuer,
    otherProjects,
    usedElsewhere,
  };
}

function anotherProject(table: string, owner: string): string {
  return `${table} already carries FacetDB columns from another project (${owner}); one table belongs to one project. Uninstall there first, or point this project at another table.`;
}

/** Thrown inside the install transaction to roll it back with a refusal's words. */
class Refused extends Error {}

function refusal(plan: MigratePlan, inspection: Inspection): string | null {
  const { source, project } = plan;
  const table = `${source.schema ?? "public"}.${source.table}`;
  if (inspection.primaryKey.length === 0) {
    return `${table} has no primary key; FacetDB keys its jobs and decisions by it. Add one and run migrate again.`;
  }
  if (inspection.primaryKey.length > 1) {
    return `${table} has a composite primary key (${inspection.primaryKey.join(", ")}); FacetDB supports single-column keys only for now. Add a surrogate key or watch a view with one.`;
  }
  if (source.key !== undefined && source.key !== inspection.primaryKey[0]) {
    return `${table}'s primary key is ${inspection.primaryKey[0]}, not ${source.key}; the config and the table disagree.`;
  }
  // The trigger fires on updates of the state columns: a state column that is one of FacetDB's
  // own (a question's column, or any facetdb_ column) would fire it on the worker's own write and
  // queue the record again forever.
  const owned = new Set(installOwnedColumns(plan.questionSet));
  const circular = plan.questionSet.read.filter((c) => owned.has(c) || c.startsWith("facetdb_"));
  if (circular.length > 0) {
    return `${table}: the state field ${circular.join(", ")} is a column FacetDB writes; a state field must be the application's own column, or the worker's writes would re-queue every record.`;
  }
  if (inspection.appOwned.length > 0) {
    return `${table} already has a column named ${inspection.appOwned.join(", ")} that is not FacetDB's; rename the question or the column.`;
  }
  const key = inspection.primaryKey[0] ?? "";
  if ([source.schema ?? "public", source.table, key].some((name) => name.includes(BODY_TAG))) {
    return `${table}: a schema, table or key name holding ${BODY_TAG} cannot be installed; FacetDB quotes its SQL bodies with that tag.`;
  }
  if (inspection.generatedKey) {
    return `${table}'s primary key ${key} is a generated column, still null when the trigger runs, so FacetDB could not queue the record. Use a key the application sets.`;
  }
  const expected = installOwnedColumnTypes(plan.questionSet);
  const stored = source.storage === "side-table" ? inspection.sideTypes : inspection.markedTypes;
  const drifted = [...stored]
    .filter(([name, type]) => expected.has(name) && expected.get(name) !== type)
    .map(([name, type]) => `${name} is ${type} and the question now needs ${expected.get(name)}`);
  if (drifted.length > 0) {
    return `${table}: ${drifted.join("; ")}; a question's type cannot change in place. Remove the question (migrate --prune drops its columns), then add it back.`;
  }
  for (const [name, facts] of [
    [WORKER_ROLE, inspection.worker],
    [ENQUEUE_ROLE, inspection.enqueuer],
  ] as const) {
    if (facts.memberOf.length > 0) {
      return `the role ${name} on this server is a member of ${facts.memberOf.join(", ")}; FacetDB's roles belong to no other role (least privilege). Revoke those memberships or drop the role, then run migrate again.`;
    }
  }
  const sideMode = source.storage === "side-table";
  if (sideMode) {
    try {
      sideTableName(source.table);
      sideViewName(source.table);
    } catch (error) {
      return `${table}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (sideMode && inspection.serverVersion < 150000) {
    return `${table}: side-table mode needs Postgres 15 or later (this server is ${inspection.serverVersion}); its view runs with the caller's rights (security_invoker) so the table's row-level security still applies to whoever reads it. Use storage "inline" on this server.`;
  }
  if (sideMode && inspection.viewMark !== undefined && inspection.viewMark !== SIDE_MARK) {
    return `${table}: a relation named ${source.table}_with_answers already exists beside the table and FacetDB did not make it; side-table mode would replace it. Rename it, or keep storage "inline".`;
  }
  if (sideMode && inspection.viewMark === SIDE_MARK && inspection.viewDependents > 0) {
    return `${table}: ${inspection.viewDependents} view(s) or rule(s) of yours depend on ${source.table}_with_answers, which this migrate recreates. Drop them, run migrate, then create them again.`;
  }
  if (sideMode && inspection.marked.length > 0) {
    return `${table} carries FacetDB columns from an inline install (${inspection.marked.join(", ")}); side-table mode would put the same names in the view twice. Uninstall the inline install first, or keep storage "inline".`;
  }
  if (!sideMode && inspection.sideColumns.length > 0 && inspection.owner !== null) {
    return `${table} is installed in side-table mode (facetdb.${source.table}_answers); installing inline would keep two copies of the answers. Uninstall first, or keep storage "side-table".`;
  }
  if (sideMode && inspection.sideColumns.length > 0 && inspection.owner === null) {
    return `facetdb.${source.table}_answers already exists and no install of FacetDB on ${table} made it; rename it or point this source at another table.`;
  }
  if (inspection.owner !== null && inspection.owner !== project.id) {
    return anotherProject(table, inspection.owner);
  }
  const { worker, enqueuer } = inspection;
  if (worker.superuser || worker.bypassRls || worker.createRole || worker.createDb) {
    return `the role ${WORKER_ROLE} on this server has rights FacetDB never uses (superuser, bypass RLS, create role or create database); FacetDB creates it with login only. Drop or rename that role, then run migrate again.`;
  }
  if (enqueuer.exists && (enqueuer.superuser || enqueuer.canLogin || enqueuer.bypassRls)) {
    return `the role ${ENQUEUE_ROLE} on this server was not created by FacetDB (it can log in, is a superuser or bypasses RLS); the trigger must not run as it. Drop or rename that role, then run migrate again.`;
  }
  if (!worker.exists && plan.workerPassword === undefined) {
    return `the worker role ${WORKER_ROLE} does not exist yet and no password was given for it; pass workerPassword on the first install.`;
  }
  if (worker.exists && plan.workerPassword !== undefined && plan.rotateWorkerPassword !== true) {
    const others = [
      ...inspection.otherProjects.map((id) => `project ${id} in this database`),
      ...(inspection.usedElsewhere ? ["another database on this server"] : []),
    ];
    if (others.length > 0) {
      return `the worker login ${WORKER_ROLE} is shared with ${others.join(" and ")}; a new password would lock them out. Reuse the stored password, or rotate it on purpose (rotateWorkerPassword) and update every project.`;
    }
  }
  return null;
}

/**
 * Inspects, refuses, prints, and only then runs the install in one transaction. The admin
 * connection is closed before this returns, whatever happened, and nothing retains it.
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const connect = options.connect ?? connectPostgres;
  const client = connect(options.adminUrl);
  try {
    const { plan } = options;
    const inspection = await inspect(client.query, plan);
    if ("missing" in inspection) {
      const table = `${plan.source.schema ?? "public"}.${plan.source.table}`;
      return {
        ok: false,
        reason: `${table} does not exist; FacetDB adds columns to a table, it does not create one.`,
      };
    }
    const reason = refusal(plan, inspection);
    if (reason !== null) {
      return { ok: false, reason };
    }
    const key = inspection.primaryKey[0] as string;
    const source: TableSource = {
      ...plan.source,
      key,
      ...(inspection.keyType === undefined ? {} : { keyType: inspection.keyType }),
    };
    const statements = installSql(source, plan.questionSet, plan.project, {
      sourceReaders: inspection.sourceReaders,
      ...(plan.workerPassword === undefined ? {} : { workerPassword: plan.workerPassword }),
    });
    const sql = renderSql(statements);
    options.print(sql);
    const present =
      plan.source.storage === "side-table" ? inspection.sideColumns : inspection.marked;
    const changed = installOwnedColumns(plan.questionSet).some((name) => !present.includes(name));
    const workerPasswordApplied = plan.workerPassword !== undefined;
    if (options.dryRun === true) {
      return { ok: true, key, statements, sql, applied: false, changed, workerPasswordApplied };
    }
    const schema = plan.source.schema ?? "public";
    try {
      await client.transaction(async (query) => {
        for (const statement of statements) {
          await query(statement.text, statement.params);
          if (statement.claimsOwner === true) {
            // The inspection ran before this transaction: another project may have claimed the table
            // since. The claim above did nothing then, so the owner now read is the truth, and
            // nothing after it (columns, trigger, grants) has run yet.
            const rows = await query(OWNER_QUERY, [schema, plan.source.table]);
            const owner = String(rows[0]?.["project_id"]);
            if (owner !== plan.project.id) {
              throw new Refused(anotherProject(`${schema}.${plan.source.table}`, owner));
            }
          }
        }
      });
    } catch (error) {
      if (error instanceof Refused) {
        return { ok: false, reason: error.message };
      }
      throw error;
    }
    return { ok: true, key, statements, sql, applied: true, changed, workerPasswordApplied };
  } finally {
    await client.close();
  }
}
