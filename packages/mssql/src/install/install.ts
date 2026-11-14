import {
  type EnginePlan,
  type EngineTarget,
  type InstallOptions,
  type PlanResult,
  type PlanStatement,
  type Refusal,
  STATUS_COLUMN,
} from "@facetdb/core";
import { adminUrlRefusal, type MssqlConnect, quoteName, quoteString } from "../sql/index.ts";
import {
  AZURE_SQL_DATABASE,
  AZURE_SQL_MANAGED_INSTANCE,
  type CatalogColumn,
  type CatalogObject,
  columnType,
  type MarkerRow,
  readColumns,
  readGrants,
  readKey,
  readMarker,
  readObjects,
  readOwner,
  readServer,
  readWorker,
  type ServerFacts,
  sharedObject,
  type TableOwner,
  type WorkerFacts,
  type WorkerGrant,
  withAdmin,
} from "./catalog.ts";
import {
  anotherProject,
  claimStatement,
  markerTableStatement,
  ownerCheckStatement,
} from "./marker.ts";
import {
  COLUMN_MARK,
  CREATION_COLUMN,
  JOBS_TABLE,
  MARKER_TABLE,
  NAME_LIMIT,
  type OwnedColumn,
  ownedColumns,
  QUEUE_KEY_COLLATION,
  QUEUE_KEY_LENGTH,
  QUEUE_NAME_LENGTH,
  SHARED_SCHEMA,
  sourceStatement,
  type TableNames,
  tableNames,
  WORKER_USER,
} from "./objects.ts";
import { keyTextLength, queueStatement } from "./queue.ts";
import { sameTrigger, triggerText } from "./trigger.ts";

/**
 * `planInstall` on SQL Server 2016 and later and Azure SQL: inspect the database with the admin
 * credential, refuse what install must not touch (the Postgres engine's refusals, in SQL Server's
 * terms), and plan only what is missing, as one transaction, each statement guarded (`if
 * col_length(…) is null`, `if object_id(…) is null`) so the printed script can run again and change
 * nothing. A second plan on an installed table has no statement at all.
 *
 * The worker is a contained database user (`create user … with password`) on Azure SQL Database,
 * whose users live in the database, and on a partially contained database; on a server without
 * containment it is a server login with a user in this database. Its password is in no plan: the
 * `secret` statement reads it from `@p1`, which `run` binds. DDL takes no parameter, so that
 * statement writes the password into the text it executes, on the server, and never in a script.
 */

/**
 * How long a statement waits for a lock: an `alter table` waits behind the application's open
 * transactions and every query behind it waits too, so a failed migrate after ten seconds beats an
 * application stalled behind it (the Postgres script's `lock_timeout`).
 */
const LOCK_TIMEOUT_MS = 10_000;

/**
 * The worker's rights on the queue: select to find jobs, insert to queue keys (a backfill,
 * `claimKey`), update to claim them and delete to ack them, as on every other engine.
 */
const QUEUE_RIGHTS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;

/**
 * The principals a trigger can run as (`sys.database_principals.type`): a SQL user, a Windows user,
 * an external (Microsoft Entra) user. A role, a group or a user of a certificate or key cannot be
 * impersonated (error 15517).
 */
const USER_TYPES: ReadonlySet<string> = new Set(["S", "U", "E"]);

/** What a principal of another type is, in words. */
const PRINCIPAL_KINDS: Readonly<Record<string, string>> = {
  R: "database role",
  A: "application role",
  G: "Windows group",
  X: "Microsoft Entra group",
  C: "user mapped to a certificate",
  K: "user mapped to an asymmetric key",
};

/** What install reads before it plans: the server alone when the table is not there. */
type InstallCatalog =
  | { readonly table: false; readonly server: ServerFacts }
  | {
      readonly table: true;
      readonly server: ServerFacts;
      readonly columns: readonly CatalogColumn[];
      readonly key: readonly string[];
      readonly owner: TableOwner;
      readonly objects: readonly CatalogObject[];
      /** The columns of a table under the queue's name, when there is one. */
      readonly queueColumns: readonly CatalogColumn[];
      readonly marker: readonly MarkerRow[] | undefined;
      readonly worker: WorkerFacts;
      readonly grants: readonly WorkerGrant[];
    };

/** The catalog of a table that is there. */
type TableCatalog = Extract<InstallCatalog, { readonly table: true }>;

/** Whether the worker is a user of the database alone: Azure SQL Database, or a contained database. */
export function containedUsers(server: ServerFacts): boolean {
  return server.edition === AZURE_SQL_DATABASE || server.containment === 1;
}

/** What the target itself makes impossible, before anything connects. */
function targetRefusal(target: EngineTarget, names: TableNames): Refusal | undefined {
  if (target.storage === "side-table") {
    return {
      code: "side-table",
      message: `side-table mode is not available on SQL Server yet, so ${names.label} cannot keep its answers in a table of their own`,
      fix: 'remove storage: "side-table" from the source in facetdb.config.ts: the answers then go in columns on the table',
    };
  }
  if (names.trigger.length > NAME_LIMIT || names.relation.length > QUEUE_NAME_LENGTH) {
    return {
      code: "name-length",
      message: `${names.label}: FacetDB names the table's trigger ${names.trigger} and its jobs ${names.relation}, and SQL Server keeps names of at most ${NAME_LIMIT} characters`,
      fix: `rename the table (or its schema) so that ${names.relation} is at most ${QUEUE_NAME_LENGTH} characters`,
    };
  }
  if (
    names.schema === SHARED_SCHEMA &&
    (names.trigger === JOBS_TABLE || names.trigger === MARKER_TABLE)
  ) {
    return {
      code: "name-taken",
      message: `${names.label}: its trigger would be named ${names.trigger}, the name of FacetDB's own ${names.trigger === JOBS_TABLE ? "queue" : "marker table"} in ${SHARED_SCHEMA}`,
      fix: "move the table to another schema, or keep FacetDB on another table",
    };
  }
  return undefined;
}

/** An object under one of FacetDB's names that is not what FacetDB put there, and what it should be. */
function takenName(
  names: TableNames,
  catalog: TableCatalog,
): { readonly name: string; readonly role: string } | undefined {
  const trigger = catalog.objects.find(
    (object) => object.schema === names.schema && object.name === names.trigger,
  );
  if (
    trigger !== undefined &&
    !(
      trigger.type === "TR" &&
      trigger.parentSchema === names.schema &&
      trigger.parentTable === names.table
    )
  ) {
    return { name: `${names.schema}.${names.trigger}`, role: `trigger on ${names.label}` };
  }
  const queue = sharedObject(catalog.objects, JOBS_TABLE);
  const queueShape = ["table_name", "record_key"].every((column) =>
    catalog.queueColumns.some((found) => found.name === column),
  );
  if (queue !== undefined && !(queue.type === "U" && queueShape)) {
    return { name: `${SHARED_SCHEMA}.${JOBS_TABLE}`, role: "queue" };
  }
  const marker = sharedObject(catalog.objects, MARKER_TABLE);
  return marker !== undefined && marker.type !== "U"
    ? { name: `${SHARED_SCHEMA}.${MARKER_TABLE}`, role: "marker table" }
    : undefined;
}

/**
 * Why the trigger could not run as the table's owner, if it could not: a principal SQL Server does
 * not impersonate (error 15517), or a user that may not write FacetDB's queue in `dbo`.
 */
function ownerRefusal(names: TableNames, owner: TableOwner): Refusal | undefined {
  const schema = `alter authorization on schema::${quoteName(names.schema)} to dbo`;
  if (!USER_TYPES.has(owner.type)) {
    return {
      code: "table-owner",
      message: `${names.label} belongs to ${owner.name}, a ${PRINCIPAL_KINDS[owner.type] ?? `principal of type ${owner.type}`}; its trigger runs as the table's owner, and SQL Server runs nothing as one (error 15517), so every write to the table would fail`,
      fix: `make dbo, or a user, the owner of the table's schema (${schema}), then run facetdb migrate again`,
    };
  }
  if (owner.name !== "dbo" && !owner.dbOwner) {
    return {
      code: "table-owner",
      message: `${names.label} belongs to ${owner.name}, which is not dbo and not in db_owner; its trigger runs as the table's owner and could not write FacetDB's queue ${SHARED_SCHEMA}.${JOBS_TABLE}, so every write to the table would fail`,
      fix: `make dbo the owner of the table's schema (${schema}), or add ${owner.name} to db_owner, then run facetdb migrate again`,
    };
  }
  return undefined;
}

/** The table's key column once every check passed, or why install must not touch the table. */
type Checked =
  | { readonly refusal: Refusal }
  | { readonly key: CatalogColumn; readonly catalog: TableCatalog };

/**
 * The refusals the catalog shows, in the order the Postgres engine reports its own: the server,
 * the table and its key, the project, the state columns, FacetDB's columns, the names, the owner
 * the trigger runs as, the worker.
 */
function check(
  target: EngineTarget,
  names: TableNames,
  read: InstallCatalog,
  options: InstallOptions,
): Checked {
  const refuse = (code: string, message: string, fix: string): Checked => ({
    refusal: { code, message, fix },
  });
  const { server } = read;
  const { label } = names;
  const azure =
    server.edition === AZURE_SQL_DATABASE || server.edition === AZURE_SQL_MANAGED_INSTANCE;
  if (!azure && (server.majorVersion === null || server.majorVersion < 13)) {
    return refuse(
      "server-version",
      `this server is SQL Server ${server.majorVersion === null ? "2008 R2 or older" : `version ${server.majorVersion}`}; FacetDB needs SQL Server 2016 (version 13) or later, or Azure SQL`,
      "upgrade the server, or point the source at a SQL Server 2016 or later",
    );
  }
  if (!read.table) {
    return refuse(
      "no-table",
      `${label} does not exist; FacetDB adds columns to a table, it does not create one`,
      "check the source's table (and its schema) in facetdb.config.ts, or create the table first",
    );
  }
  const catalog = read;
  const { columns, key, worker } = catalog;
  const [keyName] = key;
  if (keyName === undefined) {
    return refuse(
      "primary-key",
      `${label} has no primary key; FacetDB keys its jobs and decisions by it`,
      "add a single-column primary key to the table, then run facetdb migrate again",
    );
  }
  if (key.length > 1) {
    return refuse(
      "primary-key",
      `${label} has a composite primary key (${key.join(", ")}); FacetDB supports single-column keys only for now`,
      "give the table a single-column surrogate key as its primary key, then run facetdb migrate again",
    );
  }
  if (target.key !== undefined && target.key !== keyName) {
    return refuse(
      "primary-key",
      `${label}'s primary key is ${keyName}, not ${target.key}; the config and the table disagree`,
      `set the source's key to ${keyName} in facetdb.config.ts, or leave it out`,
    );
  }
  const byName = new Map(columns.map((column) => [column.name, column]));
  const keyColumn = byName.get(keyName);
  if (keyColumn === undefined) {
    throw new Error(`the catalog names ${keyName} as ${label}'s key but lists no such column`);
  }
  const textLength = keyTextLength(keyColumn);
  if (textLength === undefined || textLength > QUEUE_KEY_LENGTH) {
    return refuse(
      "key-type",
      `${label}'s primary key ${keyName} is ${columnType(keyColumn)}; FacetDB queues a key as text of at most ${QUEUE_KEY_LENGTH} characters that reads back as the same value: a whole number, a decimal, a uniqueidentifier or text`,
      "give the table a single-column key of one of those types (an int, a bigint or a uniqueidentifier), then run facetdb migrate again",
    );
  }
  // Another project's install first: its columns would read as a question's type changed here.
  const claim = catalog.marker?.find(
    (row) => row.schema === names.schema && row.table === names.table,
  );
  if (claim !== undefined && claim.projectId !== target.project.id) {
    return refuse(
      "another-project",
      anotherProject(label, claim.projectId),
      "uninstall it from that project first, or point this source at another table",
    );
  }
  const owned = ownedColumns(target.questionSet);
  const ownedNames = new Set(owned.map((column) => column.name));
  const { read: state } = target.questionSet;
  // A state column FacetDB writes would fire the trigger on the worker's own update and queue the
  // record again forever.
  const circular = state.filter((name) => ownedNames.has(name) || name.startsWith("facetdb_"));
  if (circular.length > 0) {
    return refuse(
      "state-column",
      `${label}: the state field ${circular.join(", ")} is a column FacetDB writes; a state field must be the application's own column, or the worker's writes would queue every record again`,
      "remove it from the source's read list in facetdb.config.ts",
    );
  }
  const missing = state.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    return refuse(
      "missing-column",
      `${label} has no column named ${missing.join(", ")}, which the source's read list names`,
      "correct the name in the source's read list in facetdb.config.ts, or add the column to the table first",
    );
  }
  const computed = state.filter((name) => byName.get(name)?.computed === true);
  if (computed.length > 0) {
    return refuse(
      "state-column",
      `${label}: the state field ${computed.join(", ")} is a computed column, and a trigger cannot tell when one changes`,
      "list the columns it is computed from in the source's read list instead",
    );
  }
  const foreign = owned.filter((column) => byName.get(column.name)?.marked === false);
  if (foreign.length > 0) {
    return refuse(
      "column-collision",
      `${label} already has a column named ${foreign.map((column) => column.name).join(", ")} that is not FacetDB's`,
      "rename the question in facetdb.config.ts, or rename the column",
    );
  }
  const drifted = owned.flatMap((column) => {
    const found = byName.get(column.name);
    return found === undefined || columnType(found) === column.type
      ? []
      : [`${column.name} is ${columnType(found)} and the question now needs ${column.type}`];
  });
  if (drifted.length > 0) {
    return refuse(
      "column-type",
      `${label}: ${drifted.join("; ")}; a question's type cannot change in place`,
      "remove the question and run facetdb migrate --prune (it drops its columns), then add it back",
    );
  }
  const taken = takenName(names, catalog);
  if (taken !== undefined) {
    return refuse(
      "name-taken",
      `${taken.name} already exists and is not FacetDB's ${taken.role}`,
      `rename that object, or keep FacetDB on another table: ${taken.name} is the name FacetDB gives its ${taken.role}`,
    );
  }
  // The trigger runs as the table's owner, and writes FacetDB's queue in dbo with its rights.
  const runsAs = ownerRefusal(names, catalog.owner);
  if (runsAs !== undefined) {
    return { refusal: runsAs };
  }
  if (
    catalog.owner.name === "dbo" &&
    server.edition !== AZURE_SQL_DATABASE &&
    server.ownerLogin === null
  ) {
    return refuse(
      "database-owner",
      `this database's owner has no login on the server (usual after a restore from another server); the trigger runs as the owner, so every write to ${label} would fail`,
      `make a login the database's owner (alter authorization on database::${quoteName(server.database)} to <a login>), then run facetdb migrate again`,
    );
  }
  if (worker.userExists && worker.roles.length > 0) {
    return refuse(
      "worker-roles",
      `the user ${WORKER_USER} in this database is a member of ${worker.roles.join(", ")}; FacetDB's user belongs to no role (least privilege)`,
      `remove it from those roles (alter role <role> drop member ${WORKER_USER}) or drop the user, then run facetdb migrate again`,
    );
  }
  const contained = containedUsers(server);
  if (
    !contained &&
    worker.userExists &&
    worker.userLogin !== null &&
    worker.userLogin !== WORKER_USER
  ) {
    return refuse(
      "worker-user",
      `the user ${WORKER_USER} in this database belongs to the login ${worker.userLogin}, not to the login ${WORKER_USER} FacetDB connects as`,
      `rename that user if the application uses it (alter user ${WORKER_USER} with name = <another name>), or drop it, then run facetdb migrate again: FacetDB makes its own`,
    );
  }
  const creates = contained ? !worker.userExists : !worker.loginExists;
  if (creates && options.workerPassword === undefined) {
    // The contract's code, so the CLI can say how to put the password in the source's string.
    const what = contained ? "user" : "login";
    return refuse(
      "worker-login",
      `the worker ${what} ${WORKER_USER} does not exist ${contained ? "in this database" : "on this server"} yet, and no password was given to create it with`,
      `put the worker ${what} and a long random password in ${target.urlVariable ?? "the source's connection string"}: mssql://${WORKER_USER}:<a long random password>@<host>/<database>; the install creates the ${what} with that password`,
    );
  }
  return { key: keyColumn, catalog };
}

/** A column FacetDB adds, marked as FacetDB's in the same statement. */
function columnStatement(names: TableNames, column: OwnedColumn): PlanStatement {
  return sourceStatement(
    "columns",
    `if col_length(${quoteString(names.relation)}, ${quoteString(column.name)}) is null
begin
  alter table ${names.relation} add ${quoteName(column.name)} ${column.type} null;
  exec sys.sp_addextendedproperty @name = ${quoteString(COLUMN_MARK)}, @value = ${quoteString(COLUMN_MARK)},
    @level0type = N'SCHEMA', @level0name = ${quoteString(names.schema)},
    @level1type = N'TABLE', @level1name = ${quoteString(names.table)},
    @level2type = N'COLUMN', @level2name = ${quoteString(column.name)};
end`,
  );
}

/**
 * The trigger, when the table has none, or one that differs from this question set's (other state
 * columns, another `onChange`), or one that is disabled: dropped and created again inside the
 * transaction, so the table is never without its capture once the script commits.
 */
function captureStatements(
  target: EngineTarget,
  names: TableNames,
  key: CatalogColumn,
  trigger: CatalogObject | undefined,
): readonly PlanStatement[] {
  const wanted = triggerText(names, key, target.questionSet.read, target.onChange);
  const current =
    trigger !== undefined &&
    trigger.definition !== null &&
    !trigger.disabled &&
    sameTrigger(trigger.definition, wanted);
  return current
    ? []
    : [
        sourceStatement("capture", `drop trigger if exists ${names.triggerRelation}`),
        sourceStatement("capture", wanted),
      ];
}

/** Where the `secret` statement's text says the password comes from. */
const PASSWORD_COMMENT =
  "-- @p1 is the worker password from the source's connection string: facetdb migrate binds it\n-- here and never prints it.";

/**
 * The text that creates the worker as `what` (a contained user, or a login) with the password `@p1`
 * holds, when `missing`: DDL takes no parameter, so the statement writes the password into the text
 * it executes, with every `'` doubled, and only the server ever sees that text. The doubling
 * compares by code point (`collate … BIN2`): under a linguistic collation another apostrophe could
 * match `'`, be doubled, and the created password would differ from the connection string's.
 */
function withPassword(what: "user" | "login", missing: string): string {
  const create = quoteString(`create ${what} ${quoteName(WORKER_USER)} with password = N'`);
  return `${PASSWORD_COMMENT}
if ${missing}
begin
  declare @create nvarchar(max) = ${create} + replace(@p1 collate ${QUEUE_KEY_COLLATION}, N'''', N'''''') + N'''';
  exec (@create);
end`;
}

/** What a plan that creates a server login must tell the operator. */
export const LOGIN_NOTE =
  "this database is not contained, so the worker is a server login with a user in this database; creating the login needs the ALTER ANY LOGIN permission on the server";

/** What a plan that maps an orphaned worker user to FacetDB's login must tell the operator. */
export const REMAP_NOTE = `the user ${WORKER_USER} of this database has no login on this server (a database restored from another server keeps its users so): the install maps it to the login ${WORKER_USER} and changes nothing else of it`;

/**
 * The worker: a contained user, or a server login and its user in this database. A user whose login
 * is gone (a database restored from another server) is mapped to FacetDB's login, or the worker
 * could log in to the server and not into the database.
 */
function loginStatements(
  server: ServerFacts,
  worker: WorkerFacts,
): { readonly statements: readonly PlanStatement[]; readonly notes: readonly string[] } {
  const secret = (text: string): PlanStatement => ({
    ...sourceStatement("login", text),
    secret: true,
  });
  const name = quoteString(WORKER_USER);
  const user = quoteName(WORKER_USER);
  if (containedUsers(server)) {
    return {
      statements: worker.userExists
        ? []
        : [secret(withPassword("user", `database_principal_id(${name}) is null`))],
      notes: [],
    };
  }
  const login = worker.loginExists
    ? []
    : [
        secret(
          withPassword(
            "login",
            `not exists (select 1 from sys.server_principals where name = ${name})`,
          ),
        ),
      ];
  if (!worker.userExists) {
    return {
      statements: [
        ...login,
        sourceStatement(
          "login",
          `if database_principal_id(${name}) is null\n  create user ${user} for login ${user}`,
        ),
      ],
      notes: login.length > 0 ? [LOGIN_NOTE] : [],
    };
  }
  // The user exists: mapped to FacetDB's login already, or (checked) to no login at all.
  const remap = worker.userLogin === null;
  return {
    statements: [
      ...login,
      ...(remap
        ? [
            sourceStatement(
              "login",
              `if database_principal_id(${name}) is not null\n  alter user ${user} with login = ${user}`,
            ),
          ]
        : []),
    ],
    notes: [...(login.length > 0 ? [LOGIN_NOTE] : []), ...(remap ? [REMAP_NOTE] : [])],
  };
}

/** Whether the worker holds `permission` on `schema.object`: on all of it, or on `column`. */
function holds(
  grants: readonly WorkerGrant[],
  at: { readonly schema: string; readonly object: string },
  permission: string,
  column?: string,
): boolean {
  return grants.some(
    (grant) =>
      grant.schema === at.schema &&
      grant.object === at.object &&
      grant.permission === permission &&
      (grant.column === undefined || grant.column === column),
  );
}

/**
 * The least permission that works, the part not held yet, as every engine grants it: read the key,
 * the state columns, FacetDB's own columns (the connector's `current` reads them, and a write that
 * tests `facetdb_reviewed` must) and the creation marker `scan` orders by; write FacetDB's own
 * columns and nothing else; on the queue select, insert, update and delete; read the marker. No
 * right to create anything, and the application's login needs none on the queue, since the trigger
 * runs as the table's owner.
 */
function grantStatements(
  target: EngineTarget,
  names: TableNames,
  key: string,
  catalog: TableCatalog,
): readonly PlanStatement[] {
  const { grants } = catalog;
  const table = { schema: names.schema, object: names.table };
  const owned = ownedColumns(target.questionSet).map((column) => column.name);
  const created = catalog.columns.some((column) => column.name === CREATION_COLUMN);
  const readable = [
    ...new Set([key, ...target.questionSet.read, ...owned, ...(created ? [CREATION_COLUMN] : [])]),
  ].filter((column) => !holds(grants, table, "SELECT", column));
  const writable = owned.filter((column) => !holds(grants, table, "UPDATE", column));
  const queue = QUEUE_RIGHTS.filter(
    (right) => !holds(grants, { schema: SHARED_SCHEMA, object: JOBS_TABLE }, right),
  );
  const marker = !holds(grants, { schema: SHARED_SCHEMA, object: MARKER_TABLE }, "SELECT");
  const worker = quoteName(WORKER_USER);
  const list = (columns: readonly string[]) => columns.map(quoteName).join(", ");
  return [
    ...(readable.length === 0
      ? []
      : [
          sourceStatement(
            "grants",
            `grant select (${list(readable)})\n  on ${names.relation} to ${worker}`,
          ),
        ]),
    ...(writable.length === 0
      ? []
      : [
          sourceStatement(
            "grants",
            `grant update (${list(writable)})\n  on ${names.relation} to ${worker}`,
          ),
        ]),
    ...(queue.length === 0
      ? []
      : [
          sourceStatement(
            "grants",
            `grant ${queue.map((right) => right.toLowerCase()).join(", ")} on ${names.jobsRelation} to ${worker}`,
          ),
        ]),
    ...(marker
      ? [sourceStatement("grants", `grant select on ${names.markerRelation} to ${worker}`)]
      : []),
  ];
}

/** What a table that gets its first trigger means for an application that writes to it. */
function triggerNote(names: TableNames): string {
  return `${names.label} now has a trigger, ${names.trigger}: an application statement on the table with an OUTPUT clause and no INTO fails (error 334), as Entity Framework Core 7 and later write by default; declare the trigger to EF Core (HasTrigger("${names.trigger}") on the table's entity), or, once FacetDB offers it, watch the table with Change Tracking instead of a trigger`;
}

/** What added columns mean for an application's inserts. */
function columnsNote(names: TableNames, added: number): string {
  return `${names.label} gains ${added} ${added === 1 ? "column" : "columns"}: an application insert that lists no columns (insert into ${names.label} values (…)) fails (error 213) until it names them`;
}

/** What the status column's NULL means for an application's queries. */
function pendingNote(names: TableNames): string {
  return `${STATUS_COLUMN} starts out NULL on ${names.label}'s rows (a default would rewrite every row on SQL Server Standard, so there is none, where other databases have 'pending'), and FacetDB reads NULL as pending: a query for pending rows asks for ${STATUS_COLUMN} = 'pending' or ${STATUS_COLUMN} is null`;
}

/**
 * The install for a checked table: only what is missing, behind the lock timeout and the marker's
 * claim and owner check (in every non-empty plan, so a hand run of the printed script stops at a
 * table another project claimed since); a marker row deleted by hand is a change too. Nothing at all
 * on an installed table.
 */
function installPlan(
  target: EngineTarget,
  names: TableNames,
  catalog: TableCatalog,
  key: CatalogColumn,
): EnginePlan {
  const present = new Set(catalog.columns.map((column) => column.name));
  const added = ownedColumns(target.questionSet).filter((column) => !present.has(column.name));
  const trigger = catalog.objects.find(
    (object) => object.schema === names.schema && object.name === names.trigger,
  );
  const capture = captureStatements(target, names, key, trigger);
  const login = loginStatements(catalog.server, catalog.worker);
  const claimed =
    catalog.marker?.some((row) => row.schema === names.schema && row.table === names.table) ===
    true;
  const changes = [
    ...added.map((column) => columnStatement(names, column)),
    ...(sharedObject(catalog.objects, JOBS_TABLE) === undefined ? [queueStatement(names)] : []),
    ...capture,
    ...login.statements,
    ...grantStatements(target, names, key.name, catalog),
  ];
  const nothing = changes.length === 0 && claimed;
  return {
    statements: nothing
      ? []
      : [
          sourceStatement("settings", `set lock_timeout ${LOCK_TIMEOUT_MS}`),
          markerTableStatement(names),
          claimStatement(names, target.project),
          ownerCheckStatement(names, target.project),
          ...changes,
        ],
    transactional: true,
    removes: [],
    keeps: [],
    notes: [
      ...(trigger === undefined && capture.length > 0 ? [triggerNote(names)] : []),
      ...(added.length === 0 ? [] : [columnsNote(names, added.length)]),
      ...(added.some((column) => column.name === STATUS_COLUMN) ? [pendingNote(names)] : []),
      ...login.notes,
    ],
  };
}

/** The catalog as install reads it: a missing table stops the reading after the server's facts. */
async function inspect(
  connect: MssqlConnect,
  url: string,
  names: TableNames,
): Promise<InstallCatalog> {
  return withAdmin(connect, url, async (query): Promise<InstallCatalog> => {
    const server = await readServer(query);
    const columns = await readColumns(query, names.schema, names.table);
    if (columns.length === 0) {
      return { table: false, server };
    }
    const objects = await readObjects(query, names);
    return {
      table: true,
      server,
      columns,
      key: await readKey(query, names.schema, names.table),
      owner: await readOwner(query, names),
      objects,
      queueColumns: await readColumns(query, SHARED_SCHEMA, JOBS_TABLE),
      marker: await readMarker(query, names, objects),
      worker: await readWorker(query, server),
      grants: await readGrants(query, names),
    };
  });
}

export async function planInstall(
  connect: MssqlConnect,
  target: EngineTarget,
  url: string,
  options: InstallOptions,
): Promise<PlanResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  const names = tableNames(target);
  const impossible = targetRefusal(target, names);
  if (impossible !== undefined) {
    return { ok: false, refusal: impossible };
  }
  const checked = check(target, names, await inspect(connect, url, names), options);
  return "refusal" in checked
    ? { ok: false, refusal: checked.refusal }
    : { ok: true, plan: installPlan(target, names, checked.catalog, checked.key) };
}
