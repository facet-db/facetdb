import type { QuestionSet } from "@facetdb/core";
import { connectPostgres, type SqlConnect, type SqlQuery, type SqlRow } from "../sql/index.ts";
import {
  ENQUEUE_ROLE,
  type InstallStatement,
  installOwnedColumns,
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
export type MigrateSource = Omit<TableSource, "key"> & { readonly key?: string };

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
};

type Inspection = {
  readonly primaryKey: readonly string[];
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
  const unmarked = ownedColumnsQuery(source, questionSet, { marked: false });
  const markedQuery = ownedColumnsQuery(source, questionSet, { marked: true });
  const appOwned = names(await query(unmarked.text, unmarked.params));
  const marked = names(await query(markedQuery.text, markedQuery.params));
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
  return { primaryKey, appOwned, marked, owner, worker, enqueuer, otherProjects, usedElsewhere };
}

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
  if (inspection.appOwned.length > 0) {
    return `${table} already has a column named ${inspection.appOwned.join(", ")} that is not FacetDB's; rename the question or the column.`;
  }
  if (inspection.owner !== null && inspection.owner !== project.id) {
    return `${table} already carries FacetDB columns from another project (${inspection.owner}); one table belongs to one project. Uninstall there first, or point this project at another table.`;
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
  if (worker.exists && plan.workerPassword !== undefined && !plan.rotateWorkerPassword) {
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
    const source: TableSource = { ...plan.source, key };
    const statements = installSql(source, plan.questionSet, plan.project, {
      ...(plan.workerPassword === undefined ? {} : { workerPassword: plan.workerPassword }),
    });
    const sql = renderSql(statements);
    options.print(sql);
    const changed = installOwnedColumns(plan.questionSet).some(
      (name) => !inspection.marked.includes(name),
    );
    const workerPasswordApplied = plan.workerPassword !== undefined;
    if (options.dryRun) {
      return { ok: true, key, statements, sql, applied: false, changed, workerPasswordApplied };
    }
    await client.transaction(async (query) => {
      for (const statement of statements) {
        await query(statement.text, statement.params);
      }
    });
    return { ok: true, key, statements, sql, applied: true, changed, workerPasswordApplied };
  } finally {
    await client.close();
  }
}
