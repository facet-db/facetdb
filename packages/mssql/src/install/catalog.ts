import { type MssqlConnect, type MssqlQuery, type MssqlRow, quoteString } from "../sql/index.ts";
import { markerQuery } from "./marker.ts";
import {
  COLUMN_MARK,
  JOBS_TABLE,
  MARKER_TABLE,
  SHARED_SCHEMA,
  type TableNames,
  WORKER_USER,
} from "./objects.ts";

/**
 * What the plans read of a database before they write a statement, from SQL Server's catalog views
 * with the admin credential: the server, the table's columns, key and owner, FacetDB's objects for
 * it, the marker, the worker and its rights. Install plans only what is missing, so a second plan
 * on an installed table has no statement; uninstall and prune drop only what this finds and FacetDB
 * marked, never a name taken from the config alone. The rows are a boundary: each value is checked
 * for the type the query promises.
 */

/**
 * Reads with the admin connection string: opened for the call and closed whatever happens; nothing
 * keeps it.
 */
export async function withAdmin<T>(
  connect: MssqlConnect,
  url: string,
  work: (query: MssqlQuery) => Promise<T>,
): Promise<T> {
  const client = connect(url);
  try {
    return await work(client.query);
  } finally {
    await client.close();
  }
}

/** `serverproperty('EngineEdition')` of Azure SQL Database: its users live in the database. */
export const AZURE_SQL_DATABASE = 5;

/** `serverproperty('EngineEdition')` of Azure SQL Managed Instance: logins, as on a server. */
export const AZURE_SQL_MANAGED_INSTANCE = 8;

/** The server and the database the admin credential reaches. */
export type ServerFacts = {
  readonly edition: number;
  /** `ProductMajorVersion`: 13 is SQL Server 2016; Azure SQL says 12 and is always current. */
  readonly majorVersion: number | null;
  /** `sys.databases.containment`: 1 when the database is partially contained. */
  readonly containment: number;
  /** The database's name (`db_name()`), for the words of a fix. */
  readonly database: string;
  /** The login that owns the database, or null when its owner has none (a restore from elsewhere). */
  readonly ownerLogin: string | null;
};

/** One column of a table, with what its type is spelled from and whether FacetDB marked it. */
export type CatalogColumn = {
  readonly name: string;
  /** The base type's name: `int`, `nvarchar`, `uniqueidentifier` (an alias type reads as its base). */
  readonly type: string;
  /** In bytes, -1 for `max`, as `sys.columns` says. */
  readonly maxLength: number;
  readonly precision: number;
  readonly scale: number;
  readonly collation: string | null;
  readonly computed: boolean;
  readonly marked: boolean;
};

/** Who owns a table: the principal its trigger runs as (`with execute as owner`). */
export type TableOwner = {
  readonly name: string;
  /**
   * `sys.database_principals.type`: `S`, `U` and `E` are users, which a trigger can run as; a role
   * (`R`, `A`), a group (`G`, `X`) or a user of a certificate or key (`C`, `K`) cannot be impersonated
   * (error 15517).
   */
  readonly type: string;
  /** Whether it is a member of `db_owner`, so it may write FacetDB's queue in `dbo`. */
  readonly dbOwner: boolean;
};

/** An object under one of FacetDB's names: the table's trigger, the queue, the marker. */
export type CatalogObject = {
  readonly schema: string;
  readonly name: string;
  /** `U` a table, `TR` a trigger, another code for anything else. */
  readonly type: string;
  /** The table a trigger is on. */
  readonly parentSchema: string | null;
  readonly parentTable: string | null;
  /** A trigger's text as it was created. */
  readonly definition: string | null;
  readonly disabled: boolean;
  /** Whether it carries FacetDB's own extended property (the side table and the view do). */
  readonly marked: boolean;
};

/** What install reads of the server's build and the table's storage (`TABLE_FACTS_QUERY`). */
export type TableFacts = {
  /** `ProductBuild`: 4001 and up on SQL Server 2016 is Service Pack 1 or later. */
  readonly build: number | null;
  readonly memoryOptimized: boolean;
};

/** A row of the marker: who installed on which table. */
export type MarkerRow = {
  readonly schema: string;
  readonly table: string;
  readonly projectId: string;
  readonly projectName: string;
};

/** The worker as the database knows it. */
export type WorkerFacts = {
  /** A user of that name in this database. */
  readonly userExists: boolean;
  /** A login of that name on the server (never read where users live in the database). */
  readonly loginExists: boolean;
  /**
   * The login the user's SID belongs to, whatever its name: null when no login has it (a user a
   * restore brought from another server, or a contained user), or when there is no user.
   */
  readonly userLogin: string | null;
  /** The database roles the user is a member of. */
  readonly roles: readonly string[];
};

/** A right the worker holds on one of the objects an install grants on. */
export type WorkerGrant = {
  readonly schema: string;
  /** The object's name: the table, the queue, the marker. */
  readonly object: string;
  /** The column, or undefined for a right on the whole object. */
  readonly column: string | undefined;
  /** `SELECT`, `INSERT`, `UPDATE`, `DELETE`, as `sys.database_permissions` spells them. */
  readonly permission: string;
};

/** The server and the database; a containment Azure SQL Database leaves NULL reads as none. */
export const SERVER_QUERY = `select cast(serverproperty('EngineEdition') as int) as edition,
       cast(serverproperty('ProductMajorVersion') as int) as major_version,
       cast(coalesce(d.containment, 0) as int) as containment,
       db_name() as database_name,
       suser_sname(d.owner_sid) as owner_login
  from sys.databases d
 where d.database_id = db_id()`;

/** A table's columns in order (none when there is no such table), `@p1` its schema, `@p2` its name. */
export const COLUMNS_QUERY = `select c.name as name,
       case when ty.is_user_defined = 1 and ty.is_assembly_type = 0
            then type_name(ty.system_type_id) else ty.name end as type,
       cast(c.max_length as int) as max_length,
       cast(c.precision as int) as precision,
       cast(c.scale as int) as scale,
       c.collation_name as collation,
       c.is_computed as computed,
       cast(case when exists (select 1 from sys.extended_properties p
                               where p.class = 1 and p.major_id = c.object_id
                                 and p.minor_id = c.column_id and p.name = ${quoteString(COLUMN_MARK)})
            then 1 else 0 end as bit) as marked
  from sys.columns c
  join sys.types ty on ty.user_type_id = c.user_type_id
  join sys.objects o on o.object_id = c.object_id
  join sys.schemas s on s.schema_id = o.schema_id
 where s.name = @p1 and o.name = @p2 and o.type = 'U'
 order by c.column_id`;

/** The primary key's columns in key order, `@p1` the schema, `@p2` the table. */
export const KEY_QUERY = `select c.name as name
  from sys.key_constraints k
  join sys.objects o on o.object_id = k.parent_object_id
  join sys.schemas s on s.schema_id = o.schema_id
  join sys.index_columns ic on ic.object_id = k.parent_object_id and ic.index_id = k.unique_index_id
  join sys.columns c on c.object_id = ic.object_id and c.column_id = ic.column_id
 where s.name = @p1 and o.name = @p2 and k.type = 'PK'
 order by ic.key_ordinal`;

/**
 * The table's owner (its own, or its schema's), what kind of principal it is and whether it is in
 * db_owner, `@p1` the schema, `@p2` the table.
 */
export const OWNER_QUERY = `select dp.name as owner_name, dp.type as owner_type,
       cast(coalesce(is_rolemember(N'db_owner', dp.name), 0) as bit) as db_owner
  from sys.objects o
  join sys.schemas s on s.schema_id = o.schema_id
  join sys.database_principals dp on dp.principal_id = coalesce(o.principal_id, s.principal_id)
 where s.name = @p1 and o.name = @p2 and o.type = 'U'`;

/**
 * The objects under FacetDB's names: `@p1` the table's schema with `@p2` its trigger's name, `@p6`
 * its side table's and `@p7` its view's (side-table mode); `@p3` the shared schema with `@p4` the
 * queue and `@p5` the marker. `marked` is the object's own `facetdb` extended property, which the
 * side table and the view carry, so a later install adopts them and uninstall drops them, and an
 * object of those names without it is the application's.
 */
export const OBJECTS_QUERY = `select s.name as object_schema, o.name as name, rtrim(o.type) as type,
       object_schema_name(o.parent_object_id) as parent_schema,
       object_name(o.parent_object_id) as parent_table,
       object_definition(o.object_id) as definition,
       cast(coalesce(objectproperty(o.object_id, 'ExecIsTriggerDisabled'), 0) as bit) as disabled,
       cast(case when exists (select 1 from sys.extended_properties p
                               where p.class = 1 and p.major_id = o.object_id
                                 and p.minor_id = 0 and p.name = ${quoteString(COLUMN_MARK)})
            then 1 else 0 end as bit) as marked
  from sys.objects o
  join sys.schemas s on s.schema_id = o.schema_id
 where (s.name = @p1 and o.name in (@p2, @p6, @p7)) or (s.name = @p3 and o.name in (@p4, @p5))
 order by s.name, o.name`;

/**
 * The server's build and the table's storage, `@p1` the table as `[schema].[table]`: the build,
 * which side-table mode needs (`create or alter view` came with SQL Server 2016 Service Pack 1,
 * build 13.0.4001), and whether the table is memory-optimized, which every mode refuses: it takes
 * only natively compiled triggers and no Change Tracking, and no foreign key joins it to a
 * disk-based side table.
 */
export const TABLE_FACTS_QUERY = `select cast(serverproperty('ProductBuild') as int) as build,
       cast(coalesce(objectproperty(object_id(@p1), 'TableIsMemoryOptimized'), 0) as bit) as memory_optimized`;

/**
 * The worker on a server with logins, `@p1` its name: its user here, a login of that name, and the
 * login the user's SID belongs to.
 */
export const WORKER_QUERY = `select cast(case when database_principal_id(@p1) is null then 0 else 1 end as bit) as user_exists,
       cast(case when exists (select 1 from sys.server_principals sp where sp.name = @p1) then 1 else 0 end as bit) as login_exists,
       suser_sname((select dp.sid from sys.database_principals dp where dp.name = @p1)) as user_login`;

/**
 * The worker on Azure SQL Database, `@p1` its name: its user alone, since logins are master's there
 * and the user is a contained one.
 */
export const DATABASE_WORKER_QUERY = `select cast(case when database_principal_id(@p1) is null then 0 else 1 end as bit) as user_exists`;

/** The database roles the worker is a member of, `@p1` its name. */
export const ROLES_QUERY = `select r.name as name
  from sys.database_role_members m
  join sys.database_principals r on r.principal_id = m.role_principal_id
 where m.member_principal_id = database_principal_id(@p1)
 order by r.name`;

/**
 * The worker's rights on the table, its side table, the queue and the marker: `@p1` the worker,
 * `@p2` the table's schema, `@p3` the table, `@p7` the side table, `@p4` the shared schema, `@p5`
 * the queue, `@p6` the marker. A right on a column has its name; one on the whole object has none.
 */
export const GRANTS_QUERY = `select s.name as schema_name, o.name as object_name, c.name as column_name, p.permission_name as permission
  from sys.database_permissions p
  join sys.objects o on o.object_id = p.major_id
  join sys.schemas s on s.schema_id = o.schema_id
  left join sys.columns c on c.object_id = p.major_id and c.column_id = p.minor_id
 where p.class = 1 and p.state in ('G', 'W')
   and p.grantee_principal_id = database_principal_id(@p1)
   and ((s.name = @p2 and o.name in (@p3, @p7)) or (s.name = @p4 and o.name in (@p5, @p6)))
 order by s.name, o.name, c.column_id, p.permission_name`;

/**
 * The tables whose FacetDB trigger names the queue, `@p1` the queue's name: the queue stays while
 * one does, or that table's writes would fail.
 */
export const QUEUE_USERS_QUERY = `select object_schema_name(t.parent_id) as table_schema, object_name(t.parent_id) as table_name
  from sys.triggers t
  join sys.sql_modules m on m.object_id = t.object_id
 where t.parent_class = 1 and t.name like N'facetdb[_]%' and charindex(@p1, m.definition) > 0
 order by 1, 2`;

/** How many keys the queue holds for each table, by the name its jobs carry. */
export function queuedQuery(names: TableNames): string {
  return `select [table_name] as table_name, count(*) as queued
  from ${names.jobsRelation}
 group by [table_name]
 order by [table_name]`;
}

function field(row: MssqlRow, column: string): unknown {
  if (!(column in row)) {
    throw new Error(`the catalog's answer has no column ${column}`);
  }
  return row[column];
}

function catalogError(column: string, value: unknown, expected: string): Error {
  return new Error(`the catalog's ${column} is ${String(value)}, not ${expected}`);
}

function text(row: MssqlRow, column: string): string {
  const value = field(row, column);
  if (typeof value !== "string") {
    throw catalogError(column, value, "text");
  }
  return value;
}

function textOrNull(row: MssqlRow, column: string): string | null {
  const value = field(row, column);
  return value === null ? null : text(row, column);
}

function whole(row: MssqlRow, column: string): number {
  const value = field(row, column);
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw catalogError(column, value, "a whole number");
  }
  return value;
}

function wholeOrNull(row: MssqlRow, column: string): number | null {
  const value = field(row, column);
  return value === null ? null : whole(row, column);
}

/** A `bit`: the driver reads it as a boolean. */
function flag(row: MssqlRow, column: string): boolean {
  const value = field(row, column);
  if (typeof value !== "boolean") {
    throw catalogError(column, value, "true or false");
  }
  return value;
}

export async function readServer(query: MssqlQuery): Promise<ServerFacts> {
  const [row] = await query(SERVER_QUERY);
  if (row === undefined) {
    throw new Error("the catalog has no row for the database the admin connection string reaches");
  }
  return {
    edition: whole(row, "edition"),
    majorVersion: wholeOrNull(row, "major_version"),
    containment: whole(row, "containment"),
    database: text(row, "database_name"),
    ownerLogin: textOrNull(row, "owner_login"),
  };
}

export async function readColumns(
  query: MssqlQuery,
  schema: string,
  table: string,
): Promise<readonly CatalogColumn[]> {
  return (await query(COLUMNS_QUERY, [schema, table])).map((row) => ({
    name: text(row, "name"),
    type: text(row, "type"),
    maxLength: whole(row, "max_length"),
    precision: whole(row, "precision"),
    scale: whole(row, "scale"),
    collation: textOrNull(row, "collation"),
    computed: flag(row, "computed"),
    marked: flag(row, "marked"),
  }));
}

export async function readKey(
  query: MssqlQuery,
  schema: string,
  table: string,
): Promise<readonly string[]> {
  return (await query(KEY_QUERY, [schema, table])).map((row) => text(row, "name"));
}

export async function readOwner(query: MssqlQuery, names: TableNames): Promise<TableOwner> {
  const [row] = await query(OWNER_QUERY, [names.schema, names.table]);
  if (row === undefined) {
    throw new Error(`the catalog names no owner of ${names.label}`);
  }
  return {
    name: text(row, "owner_name"),
    // `char(2)`: a one-letter type comes back with a trailing space.
    type: text(row, "owner_type").trim(),
    dbOwner: flag(row, "db_owner"),
  };
}

export async function readObjects(
  query: MssqlQuery,
  names: TableNames,
): Promise<readonly CatalogObject[]> {
  return (
    await query(OBJECTS_QUERY, [
      names.schema,
      names.trigger,
      SHARED_SCHEMA,
      JOBS_TABLE,
      MARKER_TABLE,
      names.sideTable,
      names.view,
    ])
  ).map((row) => ({
    schema: text(row, "object_schema"),
    name: text(row, "name"),
    type: text(row, "type"),
    parentSchema: textOrNull(row, "parent_schema"),
    parentTable: textOrNull(row, "parent_table"),
    definition: textOrNull(row, "definition"),
    disabled: flag(row, "disabled"),
    marked: flag(row, "marked"),
  }));
}

/** The object of that name in the table's schema: its side table or its view, when it is there. */
export function ownObject(
  objects: readonly CatalogObject[],
  names: TableNames,
  name: string,
): CatalogObject | undefined {
  return objects.find((object) => object.schema === names.schema && object.name === name);
}

/** The side table install made (a table carrying FacetDB's mark), when it is there. */
export function sideTableOf(
  objects: readonly CatalogObject[],
  names: TableNames,
): CatalogObject | undefined {
  const found = ownObject(objects, names, names.sideTable);
  return found?.type === "U" && found.marked ? found : undefined;
}

/** The view install made (a view carrying FacetDB's mark), when it is there. */
export function viewOf(
  objects: readonly CatalogObject[],
  names: TableNames,
): CatalogObject | undefined {
  const found = ownObject(objects, names, names.view);
  return found?.type === "V" && found.marked ? found : undefined;
}

export async function readTableFacts(query: MssqlQuery, names: TableNames): Promise<TableFacts> {
  const [row] = await query(TABLE_FACTS_QUERY, [names.relation]);
  if (row === undefined) {
    throw new Error(`the catalog gave no answer about ${names.label}'s server and storage`);
  }
  return { build: wholeOrNull(row, "build"), memoryOptimized: flag(row, "memory_optimized") };
}

/** The shared object of that name in `dbo`: the queue or the marker, when it is there. */
export function sharedObject(
  objects: readonly CatalogObject[],
  name: string,
): CatalogObject | undefined {
  return objects.find((object) => object.schema === SHARED_SCHEMA && object.name === name);
}

/** The marker's rows, or undefined when the database has no marker table (no install yet). */
export async function readMarker(
  query: MssqlQuery,
  names: TableNames,
  objects: readonly CatalogObject[],
): Promise<readonly MarkerRow[] | undefined> {
  if (sharedObject(objects, MARKER_TABLE)?.type !== "U") {
    return undefined;
  }
  return (await query(markerQuery(names))).map((row) => ({
    schema: text(row, "table_schema"),
    table: text(row, "table_name"),
    projectId: text(row, "project_id"),
    projectName: text(row, "project_name"),
  }));
}

/**
 * The worker as the database knows it. On Azure SQL Database the server's logins are master's and
 * not read: the worker is a contained user there.
 */
export async function readWorker(query: MssqlQuery, server: ServerFacts): Promise<WorkerFacts> {
  const logins = server.edition !== AZURE_SQL_DATABASE;
  const [row] = await query(logins ? WORKER_QUERY : DATABASE_WORKER_QUERY, [WORKER_USER]);
  if (row === undefined) {
    throw new Error("the catalog gave no answer about the worker user");
  }
  return {
    userExists: flag(row, "user_exists"),
    loginExists: logins ? flag(row, "login_exists") : false,
    userLogin: logins ? textOrNull(row, "user_login") : null,
    roles: (await query(ROLES_QUERY, [WORKER_USER])).map((role) => text(role, "name")),
  };
}

export async function readGrants(
  query: MssqlQuery,
  names: TableNames,
): Promise<readonly WorkerGrant[]> {
  return (
    await query(GRANTS_QUERY, [
      WORKER_USER,
      names.schema,
      names.table,
      SHARED_SCHEMA,
      JOBS_TABLE,
      MARKER_TABLE,
      names.sideTable,
    ])
  ).map((row) => {
    const column = textOrNull(row, "column_name");
    return {
      schema: text(row, "schema_name"),
      object: text(row, "object_name"),
      column: column ?? undefined,
      permission: text(row, "permission"),
    };
  });
}

/** The tables, as `schema.table`, whose FacetDB trigger writes the queue. */
export async function readQueueUsers(query: MssqlQuery): Promise<readonly string[]> {
  return (await query(QUEUE_USERS_QUERY, [JOBS_TABLE])).map(
    (row) => `${text(row, "table_schema")}.${text(row, "table_name")}`,
  );
}

/** How many keys the queue holds for each table, by the name its jobs carry (`[dbo].[listings]`). */
export async function readQueued(
  query: MssqlQuery,
  names: TableNames,
): Promise<ReadonlyMap<string, number>> {
  return new Map(
    (await query(queuedQuery(names))).map((row) => [text(row, "table_name"), whole(row, "queued")]),
  );
}

/**
 * A column's type as SQL Server spells it in DDL, from the catalog: `int`, `nvarchar(50)`,
 * `decimal(18, 0)`, `datetime2(3)`. A FacetDB column's type is compared with what its question
 * needs by it, and a refusal names a key's type with it.
 */
export function columnType(
  column: Pick<CatalogColumn, "type" | "maxLength" | "precision" | "scale">,
): string {
  const { type, maxLength, precision, scale } = column;
  const length = (units: number) => (maxLength === -1 ? "max" : String(units));
  switch (type) {
    case "nvarchar":
    case "nchar":
      return `${type}(${length(maxLength / 2)})`;
    case "varchar":
    case "char":
    case "varbinary":
    case "binary":
      return `${type}(${length(maxLength)})`;
    case "decimal":
    case "numeric":
      return `${type}(${precision}, ${scale})`;
    case "datetime2":
    case "datetimeoffset":
    case "time":
      return `${type}(${scale})`;
    default:
      return type;
  }
}
