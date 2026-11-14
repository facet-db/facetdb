import { type MysqlQuery, type MysqlRow, quoteIdent, quoteTable } from "../sql/index.ts";
import {
  type HeldRight,
  JOBS_TABLE,
  OWNERS_TABLE,
  WORKER_ACCOUNT,
  WORKER_HOST,
  WORKER_USER,
} from "./sql.ts";

/**
 * What a plan reads before it writes a statement, from `information_schema` and the marker: the
 * plans emit only what is missing, since MySQL has no `add column if not exists` and commits each
 * statement on its own. Every value of a row is read here, at the boundary; every column is
 * aliased in lower case, since MySQL 8 labels an `information_schema` column in upper case.
 */

/** What the session says: the rules its literals are read by, the database the URL names, the server. */
export type Session = {
  readonly sqlMode: string;
  /** `database()`: undefined when the connection string names none. */
  readonly database: string | undefined;
  /** `version()`: `8.4.3`, `10.5.27-MariaDB`. */
  readonly version: string;
};

/** Whether the server is MariaDB, as its version says (MySQL's never names it). */
export function isMariaDb(session: Session): boolean {
  return /mariadb/i.test(session.version);
}

/**
 * What creating a trigger needs of the admin: with binary logging on and
 * `log_bin_trust_function_creators` off, MySQL and MariaDB let only an account with SUPER create one
 * (error 1419), which a managed server's admin (RDS, Cloud SQL) does not have.
 */
export type TriggerRights = {
  readonly binaryLogging: boolean;
  readonly trustCreators: boolean;
  /** Whether the running account holds SUPER, as its own row of `user_privileges` shows. */
  readonly superUser: boolean;
};

/** A column of a table as `information_schema.columns` shows it. */
export type CatalogColumn = {
  readonly name: string;
  /** `column_type`: `int`, `int unsigned`, `varchar(36)`, `tinyint(1)`. */
  readonly type: string;
  /** `data_type`: `int`, `varchar`, `tinyint`. */
  readonly dataType: string;
  readonly comment: string;
  /** `extra`: `auto_increment`, `STORED GENERATED`, `DEFAULT_GENERATED`. */
  readonly extra: string;
  /** A text column's character set and collation; undefined for any other. */
  readonly charset: string | undefined;
  readonly collation: string | undefined;
  /**
   * `character_maximum_length`: the most characters of a text column, bytes of a binary one, or
   * characters of an enum's longest member; undefined for a number or a date.
   */
  readonly maxLength: number | undefined;
};

/** A trigger of the schema as `information_schema.triggers` shows it. */
export type CatalogTrigger = {
  readonly name: string;
  /** The table it is on. */
  readonly table: string;
  /** `BEFORE` or `AFTER`. */
  readonly timing: string;
  /** `INSERT`, `UPDATE` or `DELETE`. */
  readonly event: string;
  readonly body: string;
};

/** A row of the marker: a table of the database and the project and source that installed on it. */
export type Owner = { readonly table: string; readonly projectId: string; readonly source: string };

/** One table of a database as the plans read it, with what FacetDB keeps beside it. */
export type Catalog = {
  readonly schema: string;
  /** `table_type` (`BASE TABLE`, `VIEW`, `SEQUENCE`); undefined when there is no such table. */
  readonly tableType: string | undefined;
  /** In table order; none when there is no table. */
  readonly columns: readonly CatalogColumn[];
  /** The primary key's columns in key order; none when there is no primary key. */
  readonly primaryKey: readonly string[];
  /** The queue every table of the database shares, with its columns and key when it is there. */
  readonly jobs: {
    readonly present: boolean;
    readonly columns: readonly CatalogColumn[];
    readonly primaryKey: readonly string[];
  };
  readonly ownersPresent: boolean;
  /** The marker's rows, every table of the database. */
  readonly owners: readonly Owner[];
  /** Every trigger of the schema: FacetDB's of this table, and any other's on the queue. */
  readonly triggers: readonly CatalogTrigger[];
};

/** The worker login's rights, as `information_schema`'s privilege views show them. */
export type WorkerRights = {
  /** Global privileges, `USAGE` included. */
  readonly global: readonly string[];
  /** Privileges on the whole schema. */
  readonly schema: readonly string[];
  /** Table-level privileges on the schema's tables. */
  readonly tables: readonly { readonly table: string; readonly privilege: string }[];
  /** Column privileges on the schema's tables. */
  readonly columns: readonly {
    readonly table: string;
    readonly column: string;
    readonly privilege: string;
  }[];
};

/** A login that does not exist holds nothing. */
export const NO_RIGHTS: WorkerRights = { global: [], schema: [], tables: [], columns: [] };

const SESSION =
  "select @@session.sql_mode as sql_mode, database() as current_database, version() as server_version";

/** A user's own row of `user_privileges` is always visible to it; its grantee is quoted, `current_user()` not. */
const TRIGGER_RIGHTS = `select @@global.log_bin as log_bin,
       @@global.log_bin_trust_function_creators as trust_creators,
       (select count(*) from information_schema.user_privileges
         where privilege_type = 'SUPER' and replace(grantee, '''', '') = current_user()) as super_user`;

/** Whether the server lists the views that read a table: MySQL 8.0.13 and later, not MariaDB. */
const VIEW_USAGE_LISTED = `select count(*) as n from information_schema.tables
 where table_schema = 'information_schema' and table_name = 'VIEW_TABLE_USAGE'`;

const VIEWS = `select view_schema as view_schema, view_name as view_name
  from information_schema.view_table_usage
 where table_schema = ? and table_name = ?
 order by view_schema, view_name`;

const TABLE_TYPE =
  "select table_type as type from information_schema.tables where table_schema = ? and table_name = ?";

const FACETDB_TABLES =
  "select table_name as name from information_schema.tables where table_schema = ? and table_name in (?, ?)";

const COLUMNS = `select column_name as name, column_type as type, data_type as data_type,
       column_comment as comment, extra as extra,
       character_set_name as charset_name, collation_name as collation_name,
       character_maximum_length as max_length
  from information_schema.columns
 where table_schema = ? and table_name = ?
 order by ordinal_position`;

const PRIMARY_KEY = `select column_name as name from information_schema.key_column_usage
 where table_schema = ? and table_name = ? and constraint_name = 'PRIMARY'
 order by ordinal_position`;

const TRIGGERS = `select trigger_name as name, event_object_table as table_name, action_timing as timing,
       event_manipulation as event, action_statement as body
  from information_schema.triggers
 where trigger_schema = ?
 order by trigger_name`;

/**
 * Every account of the worker's name, whatever its host. Reading `mysql.user` needs the admin's
 * select on it, which every managed server's admin has.
 */
const WORKER_HOSTS = "select host as host from mysql.user where user = ? order by host";

const WORKER_GLOBAL =
  "select privilege_type as privilege from information_schema.user_privileges where grantee = ?";

const WORKER_SCHEMA =
  "select privilege_type as privilege from information_schema.schema_privileges where grantee = ? and table_schema = ?";

const WORKER_TABLES =
  "select table_name as table_name, privilege_type as privilege from information_schema.table_privileges where grantee = ? and table_schema = ?";

const WORKER_COLUMNS = `select table_name as table_name, column_name as name, privilege_type as privilege
  from information_schema.column_privileges
 where grantee = ? and table_schema = ?`;

/** The marker's rows: its own table, so a query and not a parameter names it. */
function ownersQuery(schema: string): string {
  return `select ${quoteIdent("table_name")} as table_name, ${quoteIdent("project_id")} as project_id, ${quoteIdent("source")} as source_name
  from ${quoteTable(schema, OWNERS_TABLE)}
 order by ${quoteIdent("table_name")}`;
}

/** A row's value as text, or undefined for SQL null. */
function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function names(rows: readonly MysqlRow[]): readonly string[] {
  return rows.map((row) => String(row["name"]));
}

function column(row: MysqlRow): CatalogColumn {
  return {
    name: String(row["name"]),
    type: String(row["type"]),
    dataType: String(row["data_type"]).toLowerCase(),
    comment: optionalText(row["comment"]) ?? "",
    extra: optionalText(row["extra"]) ?? "",
    charset: optionalText(row["charset_name"]),
    collation: optionalText(row["collation_name"]),
    maxLength:
      row["max_length"] === null || row["max_length"] === undefined
        ? undefined
        : Number(row["max_length"]),
  };
}

export async function readSession(query: MysqlQuery): Promise<Session> {
  const [row] = await query(SESSION);
  return {
    sqlMode: optionalText(row?.["sql_mode"]) ?? "",
    database: optionalText(row?.["current_database"]),
    version: optionalText(row?.["server_version"]) ?? "",
  };
}

/** Whether the admin may create a trigger here, read before a plan creates one (`TriggerRights`). */
export async function readTriggerRights(query: MysqlQuery): Promise<TriggerRights> {
  const [row] = await query(TRIGGER_RIGHTS);
  return {
    binaryLogging: Number(row?.["log_bin"] ?? 0) !== 0,
    trustCreators: Number(row?.["trust_creators"] ?? 0) !== 0,
    superUser: Number(row?.["super_user"] ?? 0) > 0,
  };
}

/**
 * The views that read a table, as `schema.view`, where the server lists them; undefined on a server
 * that cannot (MariaDB has no `view_table_usage`). A dropped column a view reads breaks the view.
 */
export async function readViews(
  query: MysqlQuery,
  schema: string,
  table: string,
): Promise<readonly string[] | undefined> {
  const [listed] = await query(VIEW_USAGE_LISTED);
  if (Number(listed?.["n"] ?? 0) === 0) {
    return undefined;
  }
  return (await query(VIEWS, [schema, table])).map(
    (row) => `${String(row["view_schema"])}.${String(row["view_name"])}`,
  );
}

/** The table as the plans read it, and FacetDB's objects in its schema. Nothing is changed. */
export async function readCatalog(
  query: MysqlQuery,
  schema: string,
  table: string,
): Promise<Catalog> {
  const tableType = optionalText((await query(TABLE_TYPE, [schema, table]))[0]?.["type"]);
  const present = tableType !== undefined;
  const facetdb = names(await query(FACETDB_TABLES, [schema, JOBS_TABLE, OWNERS_TABLE]));
  const jobsPresent = facetdb.includes(JOBS_TABLE);
  const ownersPresent = facetdb.includes(OWNERS_TABLE);
  return {
    schema,
    tableType,
    columns: present ? (await query(COLUMNS, [schema, table])).map(column) : [],
    primaryKey: present ? names(await query(PRIMARY_KEY, [schema, table])) : [],
    jobs: {
      present: jobsPresent,
      columns: jobsPresent ? (await query(COLUMNS, [schema, JOBS_TABLE])).map(column) : [],
      primaryKey: jobsPresent ? names(await query(PRIMARY_KEY, [schema, JOBS_TABLE])) : [],
    },
    ownersPresent,
    owners: ownersPresent
      ? (await query(ownersQuery(schema))).map((row) => ({
          table: String(row["table_name"]),
          projectId: String(row["project_id"]),
          source: String(row["source_name"]),
        }))
      : [],
    triggers: (await query(TRIGGERS, [schema])).map((row) => ({
      name: String(row["name"]),
      table: String(row["table_name"]),
      timing: String(row["timing"]),
      event: String(row["event"]),
      body: String(row["body"]),
    })),
  };
}

/**
 * What dropping FacetDB's columns may do to the application's views, for a plan that drops some:
 * MySQL and MariaDB drop a column a view reads without a word, and the view fails with error 1356
 * from then on. The catalog cannot refuse it beforehand where it cannot list the views (MariaDB);
 * where it can, the note names them, and none means no note.
 */
export function droppedColumnsNote(
  label: string,
  views: readonly string[] | undefined,
): string | undefined {
  if (views === undefined) {
    return `MySQL and MariaDB drop a column that a view reads, and the view then fails with error 1356; MariaDB cannot list the views that read ${label}, so check them before this runs.`;
  }
  if (views.length === 0) {
    return undefined;
  }
  const one = views.length === 1;
  return `MySQL drops a column that a view reads, and the view then fails with error 1356: ${views.join(", ")} ${one ? "reads" : "read"} ${label}, so check ${one ? "it" : "them"} before this runs.`;
}

/** The hosts of every account named like the worker login: FacetDB's is the one for any host. */
export async function workerHosts(query: MysqlQuery): Promise<readonly string[]> {
  return (await query(WORKER_HOSTS, [WORKER_USER])).map((row) => String(row["host"]));
}

/** Whether the worker login exists: install creates it only when it does not. */
export async function workerExists(query: MysqlQuery): Promise<boolean> {
  return (await workerHosts(query)).includes(WORKER_HOST);
}

/** The rights the worker login holds, globally and in the schema. */
export async function readWorkerRights(query: MysqlQuery, schema: string): Promise<WorkerRights> {
  const privilege = (row: MysqlRow) => String(row["privilege"]).toUpperCase();
  return {
    global: (await query(WORKER_GLOBAL, [WORKER_ACCOUNT])).map(privilege),
    schema: (await query(WORKER_SCHEMA, [WORKER_ACCOUNT, schema])).map(privilege),
    tables: (await query(WORKER_TABLES, [WORKER_ACCOUNT, schema])).map((row) => ({
      table: String(row["table_name"]),
      privilege: privilege(row),
    })),
    columns: (await query(WORKER_COLUMNS, [WORKER_ACCOUNT, schema])).map((row) => ({
      table: String(row["table_name"]),
      column: String(row["name"]),
      privilege: privilege(row),
    })),
  };
}

/**
 * The worker's rights on one table, as `revokeStatement` takes them back: its rights on the columns
 * in `columns` (MySQL keeps the grants of a dropped column, and a revoke naming a column the table
 * no longer has is not one to risk), then its rights on the whole table.
 */
export function rightsOn(
  rights: WorkerRights,
  table: string,
  columns: ReadonlySet<string>,
): readonly HeldRight[] {
  return [
    ...rights.columns
      .filter((held) => held.table === table && columns.has(held.column))
      .map((held) => ({ privilege: held.privilege, column: held.column })),
    ...rights.tables
      .filter((held) => held.table === table)
      .map((held) => ({ privilege: held.privilege })),
  ];
}

/** The tables of the schema other than `table` whose records the queue holds or will hold. */
export function otherQueueTables(catalog: Catalog, table: string): readonly string[] {
  const fromOwners = catalog.owners.map((owner) => owner.table);
  const fromTriggers = catalog.triggers
    .filter((trigger) => trigger.name.startsWith("facetdb_") && trigger.body.includes(JOBS_TABLE))
    .map((trigger) => trigger.table);
  return [...new Set([...fromOwners, ...fromTriggers])].filter((other) => other !== table).sort();
}
