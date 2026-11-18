import type {
  EnginePlan,
  EngineTarget,
  InstallOptions,
  PlanResult,
  PlanStatement,
  Refusal,
} from "@facetdb/core";
import { adminUrlRefusal, type MysqlConnect, withClient } from "../sql/index.ts";
import {
  type Catalog,
  type CatalogColumn,
  type CatalogTrigger,
  CREATION_COLUMN,
  creationMarker,
  isMariaDb,
  NO_RIGHTS,
  readCatalog,
  readSession,
  readTriggerRights,
  readWorkerRights,
  type ServerName,
  type Session,
  serverNameOf,
  type WorkerRights,
  workerHosts,
} from "./catalog.ts";
import {
  anotherProject,
  autoCreateUserRefusal,
  backslashModeRefusal,
  binaryLoggingRefusal,
  inlineOverSideRefusal,
  installRefused,
  jobsTableRefusal,
  type NotText,
  nameTooLongRefusal,
  noDatabaseRefusal,
  notATableRefusal,
  queueKeyRefusal,
  refusing,
  sideNameTooLongRefusal,
  statementFormatRefusal,
  stateTypeRefusal,
  triggerNameRefusal,
  workerHostRefusal,
  workerLoginRefusal,
} from "./refusals.ts";
import {
  type Account,
  createSideTableStatement,
  createViewStatement,
  foreignKeyAllowed,
  foreignKeyNote,
  heldBy,
  markedTable,
  noForeignKeyNote,
  type Relation,
  readerGrantStatement,
  readersNote,
  readersOf,
  readRelation,
  readSideCatalog,
  SIDE_TABLE_NAME_LIMIT,
  SIDE_TABLE_PRIVILEGES,
  type SideCatalog,
  sideRefusal,
  sideTableName,
  sideTriggerDefinitions,
  sideViewName,
  viewCurrent,
  viewNote,
} from "./side-table.ts";
import {
  addColumnsStatement,
  type CaptureSource,
  type Claim,
  claimStatement,
  columnGrantStatement,
  createTrigger,
  dropTrigger,
  JOBS_TABLE,
  jobsTableStatement,
  NAME_LIMIT,
  OWNED_MARK,
  OWNERS_TABLE,
  type OwnedColumn,
  ownedColumns,
  ownerGuardStatement,
  ownersTableStatement,
  RECORD_KEY_BYTES,
  RECORD_KEY_LENGTH,
  SETTINGS,
  sourceStatement,
  type TriggerDefinition,
  tableGrantStatement,
  triggerDefinitions,
  triggerNames,
  WORKER_ACCOUNT,
  WORKER_HOST,
  WORKER_LOGIN_STATEMENT,
} from "./sql.ts";

/**
 * `planInstall` on MySQL and MariaDB: read the table and FacetDB's objects beside it, refuse what
 * install must not touch, and plan only what is missing, so a plan of an installed table is empty
 * and a plan after a stopped run finishes it. The plan is the source's alone: the store is a
 * Postgres elsewhere. The worker login and its grants come before the triggers: a run that stops at
 * the login (a password the server's policy refuses, error 1819) or at a trigger never leaves the
 * capture queueing records no worker can log in to answer.
 */

/**
 * The plan's note for a run that stops part way (the plan says a rerun completes it), in the
 * server's name.
 */
export function installRerunNote(server: ServerName): string {
  return `${server} runs these statements one by one, with no transaction around them: if one fails, the ones before it stay done, and running facetdb migrate again completes the install.`;
}

/** The note on a MySQL server. */
export const INSTALL_RERUN_NOTE = installRerunNote("MySQL");

/** What the queue keeps of a key, said when the plan creates it (`RECORD_KEY_BYTES`). */
export const QUEUE_NOTE = `facetdb_jobs is shared by the database's tables and keeps each record's key as the utf8mb4 bytes of its text (a varbinary(${RECORD_KEY_BYTES}), so two keys that differ only in trailing spaces stay two jobs); a table whose key can be longer than ${RECORD_KEY_LENGTH} characters is refused.`;

/** What the triggers' definer means for the operator, said whenever the plan creates them. */
function definerNote(label: string): string {
  return `The triggers run with the rights of the account that creates them (their definer): if that account is dropped, inserts and updates on ${label} fail until facetdb migrate runs again under another account.`;
}

/** What renaming a column the triggers name does, said whenever the plan creates them. */
function columnsNote(label: string, server: ServerName): string {
  return `${server} does not tie a trigger to the columns it names: renaming or dropping the key or a state column of ${label} makes the application's writes on it fail with error 1054 until facetdb migrate runs again.`;
}

/**
 * What remaking a trigger leaves open: a `read` change, or an `onChange` one, gives a trigger of
 * the table a new body, and MySQL has no statement that replaces a trigger in place.
 */
function remadeNote(label: string, server: ServerName, names: readonly string[]): string {
  const one = names.length === 1;
  return `${server} cannot replace a trigger in place: ${names.join(", ")} of ${label} ${one ? "is" : "are"} dropped and created again, and a change the application makes to ${label} between the two statements is not queued, so run this while the table is quiet.`;
}

/** Said when the plan grants the worker the creation marker its backfill scans by. */
function newestFirstNote(label: string): string {
  return `A backfill of ${label} asks its newest records first, by ${CREATION_COLUMN}: the worker login is granted select on that column to order by it.`;
}

/** The triggers of the table the plan drops and creates again, by name: those it has already. */
function remadeTriggers(
  catalog: Catalog,
  table: string,
  created: readonly TriggerDefinition[],
): readonly string[] {
  return created
    .filter((definition) =>
      catalog.triggers.some(
        (trigger) => trigger.name === definition.name && trigger.table === table,
      ),
    )
    .map((definition) => definition.name);
}

/** A plan with nothing to do: an installed table, as it was installed. */
const NOTHING: EnginePlan = {
  statements: [],
  transactional: false,
  removes: [],
  keeps: [],
  notes: [],
};

/** Key types MySQL indexes only by a prefix: the queue could not keep a record's whole key. */
const PREFIX_ONLY: ReadonlySet<string> = new Set([
  "tinytext",
  "text",
  "mediumtext",
  "longtext",
  "tinyblob",
  "blob",
  "mediumblob",
  "longblob",
]);

/**
 * Key types whose value is bytes, not text: the queue keeps a key as its utf8mb4 text, and their
 * bytes would not convert back to the key a worker reads the row by.
 */
const BINARY: ReadonlySet<string> = new Set(["binary", "varbinary", "bit"]);

/**
 * State types whose value is not text, by `data_type`: the worker reads a state field as utf8mb4
 * text, bytes that are not utf8mb4 read as the same replacement characters, and a spatial value
 * reads as NULL on MySQL 8 and fails the read on MariaDB (error 4079) (`stateTypeRefusal`). The
 * spatial names are both engines' (`geomcollection` on MySQL 8, `geometrycollection` on MariaDB);
 * `vector` is MariaDB 11.7's.
 */
const NOT_TEXT: ReadonlyMap<string, NotText> = new Map([
  ...[...BINARY, "tinyblob", "blob", "mediumblob", "longblob"].map(
    (type) => [type, "bytes"] as const,
  ),
  ...[
    "geometry",
    "point",
    "linestring",
    "polygon",
    "multipoint",
    "multilinestring",
    "multipolygon",
    "geomcollection",
    "geometrycollection",
  ].map((type) => [type, "spatial"] as const),
  ["vector", "bytes"] as const,
]);

/** A generated column: a trigger can read neither its old nor its new value. */
const GENERATED = /\b(VIRTUAL|STORED) GENERATED\b/i;

/** The privileges of the worker on the queue: claims are updates, a backfill enqueues. */
const JOBS_PRIVILEGES = ["select", "insert", "update", "delete"] as const;

/** Its privilege on the marker: it reads which project a table is. */
const OWNERS_PRIVILEGES = ["select"] as const;

/** The queue's columns, which the triggers and the connector's claims write and read. */
const JOBS_COLUMNS = [
  "table_name",
  "record_key",
  "enqueued_at",
  "claimed_by",
  "claimed_at",
  "claim_token",
] as const;

/** The queue's key: one job per record of each table. */
const JOBS_KEY = ["table_name", "record_key"] as const;

/** Whitespace aside: a script pasted with other line ends or indentation still reads as the same body. */
function sameText(a: string, b: string): boolean {
  const plain = (text: string) => text.replace(/\s+/g, " ").trim();
  return plain(a) === plain(b);
}

/** Whether a trigger of the schema is this definition, on this table. */
export function triggerInstalled(
  triggers: readonly CatalogTrigger[],
  table: string,
  definition: TriggerDefinition,
): boolean {
  const found = triggers.find((trigger) => trigger.name === definition.name);
  return (
    found !== undefined &&
    found.table === table &&
    found.timing.toLowerCase() === definition.timing &&
    found.event.toLowerCase() === definition.event &&
    sameText(found.body, definition.body)
  );
}

/** Whether the worker holds a privilege on a column, or on a table when `column` is undefined. */
function holds(rights: WorkerRights, table: string, privilege: string, column?: string): boolean {
  const wanted = privilege.toUpperCase();
  return column === undefined
    ? rights.tables.some((held) => held.table === table && held.privilege === wanted)
    : rights.columns.some(
        (held) => held.table === table && held.column === column && held.privilege === wanted,
      );
}

/** The table's key, as the refusals below proved it: one column, readable by a trigger. */
type Keyed = { readonly key: CatalogColumn };

/** The table as install needs it, or why install must not touch it. */
function tableRefusal(
  target: EngineTarget,
  catalog: Catalog,
  label: string,
  server: ServerName,
): Refusal | Keyed {
  if (catalog.tableType === undefined) {
    return installRefused(
      `${label} does not exist; FacetDB adds columns to a table, it does not create one.`,
    );
  }
  if (catalog.tableType !== "BASE TABLE") {
    return notATableRefusal(label, catalog.tableType);
  }
  if (target.storage === "side-table" && target.table.length > SIDE_TABLE_NAME_LIMIT) {
    return sideNameTooLongRefusal(target.table, SIDE_TABLE_NAME_LIMIT, server);
  }
  if (target.table.length > NAME_LIMIT - "facetdb__ins".length) {
    return nameTooLongRefusal(target.table, server);
  }
  const [name, ...rest] = catalog.primaryKey;
  if (name === undefined) {
    return installRefused(
      `${label} has no primary key; FacetDB keys its jobs and decisions by it. Add one and run migrate again.`,
    );
  }
  if (rest.length > 0) {
    return installRefused(
      `${label} has a composite primary key (${catalog.primaryKey.join(", ")}); FacetDB supports single-column keys only for now. Add a single-column surrogate key.`,
    );
  }
  if (target.key !== undefined && target.key !== name) {
    return installRefused(
      `${label}'s primary key is ${name}, not ${target.key}; the config and the table disagree.`,
    );
  }
  const key = catalog.columns.find((column) => column.name === name);
  if (key === undefined) {
    // The catalog listed the key in key_column_usage and not in columns: a boundary to trust no further.
    throw new Error(
      `information_schema lists the primary key ${name} of ${label} but not its column`,
    );
  }
  if (GENERATED.test(key.extra)) {
    return installRefused(
      `${label}'s primary key ${name} is a generated column, which a trigger cannot read, so FacetDB could not queue the record. Use a key the application sets.`,
    );
  }
  if (PREFIX_ONLY.has(key.dataType)) {
    return queueKeyRefusal(
      `${label}'s primary key ${name} is ${key.type}, which MySQL indexes only by a prefix; FacetDB's queue keeps a record's whole key`,
    );
  }
  if (BINARY.has(key.dataType)) {
    return queueKeyRefusal(
      `${label}'s primary key ${name} is ${key.type}, whose bytes are not text; FacetDB's queue keeps a key as its text`,
    );
  }
  if (key.maxLength !== undefined && key.maxLength > RECORD_KEY_LENGTH) {
    return queueKeyRefusal(
      `${label}'s primary key ${name} is ${key.type}, longer than the ${RECORD_KEY_LENGTH} characters FacetDB's queue keeps of a key`,
    );
  }
  return { key };
}

/** The state columns: the table's own, plain columns, so the update trigger can compare them. */
function stateRefusal(
  target: EngineTarget,
  catalog: Catalog,
  label: string,
  owned: readonly OwnedColumn[],
): Refusal | undefined {
  const { read } = target.questionSet;
  const byName = new Map(catalog.columns.map((column) => [column.name, column]));
  const missing = read.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    return installRefused(
      `${label} has no column named ${missing.join(", ")}, which the source's read lists. Fix read in the config, or add the column.`,
    );
  }
  // A state column FacetDB writes would queue the record again on every write of the worker.
  const ownedNames = new Set(owned.map((column) => column.name));
  const circular = read.filter((name) => ownedNames.has(name) || name.startsWith("facetdb_"));
  if (circular.length > 0) {
    return installRefused(
      `${label}: the state field ${circular.join(", ")} is a column FacetDB writes; a state field must be the application's own column, or the worker's writes would re-queue every record.`,
    );
  }
  const generated = read.filter((name) => GENERATED.test(byName.get(name)?.extra ?? ""));
  if (generated.length > 0) {
    return installRefused(
      `${label}: the state field ${generated.join(", ")} is a generated column, which a MySQL trigger cannot compare. Read the columns it is generated from instead.`,
    );
  }
  const notText = read.flatMap((name) => {
    const column = byName.get(name);
    const kind = column === undefined ? undefined : NOT_TEXT.get(column.dataType);
    return column === undefined || kind === undefined ? [] : [{ ...column, kind }];
  });
  if (notText.length > 0) {
    return stateTypeRefusal(label, notText);
  }
  return undefined;
}

/**
 * Install's own columns against a table's (the application's table inline, the side table in
 * side-table mode): adopt FacetDB's, refuse the application's.
 */
function columnsRefusal(
  tableColumns: readonly CatalogColumn[],
  label: string,
  owned: readonly OwnedColumn[],
): Refusal | undefined {
  const byName = new Map(tableColumns.map((column) => [column.name, column]));
  const existing = owned.flatMap((column) => {
    const found = byName.get(column.name);
    return found === undefined ? [] : [{ column, found }];
  });
  const foreign = existing.filter(({ found }) => found.comment !== OWNED_MARK);
  if (foreign.length > 0) {
    return installRefused(
      `${label} already has a column named ${foreign.map(({ column }) => column.name).join(", ")} that is not FacetDB's; rename the question or the column.`,
    );
  }
  const drifted = existing.filter(
    ({ column, found }) => !column.dataTypes.includes(found.dataType),
  );
  if (drifted.length > 0) {
    const drifts = drifted.map(
      ({ column, found }) =>
        `${column.name} is ${found.type} and the question now needs ${column.definition.split(" ")[0] ?? column.definition}`,
    );
    return installRefused(
      `${label}: ${drifts.join("; ")}; a question's type cannot change in place. Remove the question (migrate --prune drops its columns), then add it back.`,
    );
  }
  return undefined;
}

/** What a table of the queue's name lacks of the queue, in words; none when it is the queue. */
function queueShape(catalog: Catalog): readonly string[] {
  const { jobs } = catalog;
  if (!jobs.present) {
    return [];
  }
  const present = new Set(jobs.columns.map((column) => column.name));
  const missing = JOBS_COLUMNS.filter((name) => !present.has(name));
  const keyed = jobs.primaryKey.join(", ") === JOBS_KEY.join(", ");
  return [
    ...(missing.length === 0 ? [] : [`it has no ${missing.join(", ")} column`]),
    ...(keyed
      ? []
      : [
          jobs.primaryKey.length === 0
            ? "it has no primary key"
            : `its primary key is (${jobs.primaryKey.join(", ")}), not (${JOBS_KEY.join(", ")})`,
        ]),
  ];
}

/** The rights an existing worker login holds that FacetDB never gives, in words. */
function foreignRights(rights: WorkerRights, schema: string, table: string): readonly string[] {
  return [
    ...rights.global
      .filter((privilege) => privilege !== "USAGE")
      .map((privilege) => `${privilege} on the server`),
    ...rights.schema.map((privilege) => `${privilege} on the database ${schema}`),
    ...rights.tables
      .filter((held) => held.table === table)
      .map((held) => `${held.privilege} on the whole table ${schema}.${table}`),
  ];
}

/** Why install must not touch the table, or the table's key when it may. */
function installRefusal(
  target: EngineTarget,
  session: Session,
  catalog: Catalog,
  rights: WorkerRights,
  loginExists: boolean,
  side: SideCatalog | undefined,
  inlineSide: Relation | undefined,
): Refusal | Keyed {
  const { schema } = catalog;
  const label = `${schema}.${target.table}`;
  const modes = session.sqlMode.split(",");
  if (modes.includes("NO_BACKSLASH_ESCAPES")) {
    return backslashModeRefusal();
  }
  if (!loginExists && isMariaDb(session) && !modes.includes("NO_AUTO_CREATE_USER")) {
    return autoCreateUserRefusal();
  }
  const keyed = tableRefusal(target, catalog, label, serverNameOf(session));
  if (!("key" in keyed)) {
    return keyed;
  }
  const owner = catalog.owners.find((row) => row.table === target.table);
  if (owner !== undefined && owner.projectId !== target.project.id) {
    return installRefused(anotherProject(label, owner.projectId));
  }
  // The queue is shared with the database's other tables: a table of its name that is not it
  // would take the triggers' inserts, and fail the application's writes with them.
  const lacks = queueShape(catalog);
  if (lacks.length > 0) {
    return jobsTableRefusal(schema, lacks);
  }
  const names = triggerNames(target.table);
  const ours = new Set([names.pending, names.insert, names.update]);
  const misplaced = catalog.triggers.find(
    (trigger) => ours.has(trigger.name) && trigger.table !== target.table,
  );
  if (misplaced !== undefined) {
    return triggerNameRefusal(label, misplaced.name, `${schema}.${misplaced.table}`);
  }
  const owned = ownedColumns(target.questionSet);
  const state = stateRefusal(target, catalog, label, owned);
  if (state !== undefined) {
    return state;
  }
  // One storage per table: inline over a side-table install would keep the answers twice (side-table
  // mode refuses the reverse, `sideRefusal`).
  if (inlineSide !== undefined && markedTable(inlineSide)) {
    return inlineOverSideRefusal(label, `${schema}.${sideTableName(target.table)}`);
  }
  // Inline, FacetDB's columns are the table's; in side-table mode they are the side table's, and
  // the table must have none of them, nor a column of their names (the view lists both).
  const columns =
    side === undefined
      ? columnsRefusal(catalog.columns, label, owned)
      : (sideRefusal(catalog.columns, side, schema, target.table, keyed.key.name, owned) ??
        columnsRefusal(side.side.columns, `${schema}.${sideTableName(target.table)}`, owned));
  if (columns !== undefined) {
    return columns;
  }
  const held = foreignRights(rights, schema, target.table);
  return held.length > 0
    ? installRefused(
        `the user ${WORKER_ACCOUNT} on this server holds ${held.join(", ")}, rights FacetDB never gives it; FacetDB grants it single columns of a table and its own two tables only. Revoke those rights, or drop the user if no project uses it, then run migrate again.`,
      )
    : keyed;
}

/** The worker's grants the table and the two FacetDB tables still need (none on an installed table). */
function grantStatements(
  catalog: Catalog,
  table: string,
  select: readonly string[],
  update: readonly string[],
  rights: WorkerRights,
): readonly PlanStatement[] {
  const { schema } = catalog;
  const selects = select.filter((column) => !holds(rights, table, "select", column));
  const updates = update.filter((column) => !holds(rights, table, "update", column));
  const jobs = JOBS_PRIVILEGES.filter((privilege) => !holds(rights, JOBS_TABLE, privilege));
  const owners = OWNERS_PRIVILEGES.filter((privilege) => !holds(rights, OWNERS_TABLE, privilege));
  return [
    ...(selects.length === 0 ? [] : [columnGrantStatement("select", schema, table, selects)]),
    ...(updates.length === 0 ? [] : [columnGrantStatement("update", schema, table, updates)]),
    ...(jobs.length === 0 ? [] : [tableGrantStatement(jobs, schema, JOBS_TABLE)]),
    ...(owners.length === 0 ? [] : [tableGrantStatement(owners, schema, OWNERS_TABLE)]),
  ];
}

/**
 * The statements that change the table and FacetDB's objects, each only when it is missing, and
 * whether they create a trigger (the binary log's check is about creating one).
 */
function installPlan(
  target: EngineTarget,
  catalog: Catalog,
  key: CatalogColumn,
  loginExists: boolean,
  rights: WorkerRights,
  server: ServerName,
): { readonly plan: EnginePlan; readonly createsTriggers: boolean } {
  const { schema } = catalog;
  const { table } = target;
  const label = `${schema}.${table}`;
  const owned = ownedColumns(target.questionSet);
  const present = new Set(catalog.columns.map((column) => column.name));
  const missing = owned.filter((column) => !present.has(column.name));
  const capture: CaptureSource = {
    schema,
    table,
    key: key.name,
    state: target.questionSet.read,
    onChange: target.onChange,
  };
  const definitions = triggerDefinitions(capture);
  const triggers = definitions.filter(
    (definition) => !triggerInstalled(catalog.triggers, table, definition),
  );
  // A trigger of FacetDB's this onChange does not define: `_new` after a switch to `keep`.
  const names = triggerNames(table);
  const defined = new Set(definitions.map((definition) => definition.name));
  const stale = [names.pending, names.insert, names.update].filter(
    (name) =>
      !defined.has(name) &&
      catalog.triggers.some((trigger) => trigger.name === name && trigger.table === table),
  );
  // The worker reads the key, the state, the creation marker its scan orders by and its own columns
  // (`current`, and its writes test facetdb_reviewed), and writes only its own: never a right on
  // another column.
  const ownedNames = owned.map((column) => column.name);
  const marker = creationMarker(catalog.columns);
  const select = [
    ...new Set([
      key.name,
      ...target.questionSet.read,
      ...(marker === undefined ? [] : [marker.name]),
      ...ownedNames,
    ]),
  ];
  const held = loginExists ? rights : NO_RIGHTS;
  const ordered = marker !== undefined && !holds(held, table, "select", marker.name);
  const replaced = remadeTriggers(catalog, table, triggers);
  const work: readonly PlanStatement[] = [
    ...(missing.length === 0 ? [] : [addColumnsStatement(schema, table, missing)]),
    ...(catalog.jobs.present ? [] : [jobsTableStatement(schema)]),
    ...(loginExists ? [] : [WORKER_LOGIN_STATEMENT]),
    ...grantStatements(catalog, table, select, ownedNames, held),
    ...stale.map((name) => dropTrigger(schema, name)),
    ...triggers.flatMap((definition) => [
      dropTrigger(schema, definition.name),
      sourceStatement("capture", createTrigger(capture, definition)),
    ]),
  ];
  const claimed = catalog.owners.some((owner) => owner.table === table);
  if (work.length === 0 && claimed) {
    return { plan: NOTHING, createsTriggers: false };
  }
  const claim: Claim = {
    schema,
    table,
    projectId: target.project.id,
    source: target.source,
  };
  return {
    plan: {
      statements: [
        SETTINGS,
        ...(catalog.ownersPresent ? [] : [ownersTableStatement(schema)]),
        ...(claimed ? [] : [claimStatement(claim)]),
        ownerGuardStatement(claim),
        ...work,
      ],
      transactional: false,
      removes: [],
      keeps: [],
      notes: [
        installRerunNote(server),
        ...(catalog.jobs.present ? [] : [QUEUE_NOTE]),
        ...(triggers.length === 0 ? [] : [definerNote(label), columnsNote(label, server)]),
        ...(replaced.length === 0 ? [] : [remadeNote(label, server, replaced)]),
        ...(ordered ? [newestFirstNote(label)] : []),
      ],
    },
    createsTriggers: triggers.length > 0,
  };
}

/**
 * The grants side-table mode still needs: the worker reads the key and the state of the table and
 * nothing else of it, holds the four row rights on the side table (`write` inserts a first answer's
 * row and updates it), select on the view, and its rights on the two shared tables; every account
 * that reads the table gets select on the view and the side table, which an invoker's view needs.
 */
function sideGrantStatements(
  catalog: Catalog,
  side: SideCatalog,
  table: string,
  key: string,
  read: readonly string[],
  marker: string | undefined,
  rights: WorkerRights,
): { readonly worker: readonly PlanStatement[]; readonly readers: readonly PlanStatement[] } {
  const { schema } = catalog;
  const sideName = sideTableName(table);
  const viewName = sideViewName(table);
  const select = [...new Set([key, ...read, ...(marker === undefined ? [] : [marker])])].filter(
    (column) => !holds(rights, table, "select", column),
  );
  const sideRights = SIDE_TABLE_PRIVILEGES.filter(
    (privilege) => !holds(rights, sideName, privilege),
  );
  const jobs = JOBS_PRIVILEGES.filter((privilege) => !holds(rights, JOBS_TABLE, privilege));
  const owners = OWNERS_PRIVILEGES.filter((privilege) => !holds(rights, OWNERS_TABLE, privilege));
  const readers = readersOf(side, table);
  const lacking = (name: string): readonly Account[] =>
    readers.filter((account) => !heldBy(side.grants, account, name, "select"));
  const sideReaders = lacking(sideName);
  const viewReaders = lacking(viewName);
  return {
    worker: [
      ...(select.length === 0 ? [] : [columnGrantStatement("select", schema, table, select)]),
      ...(sideRights.length === 0 ? [] : [tableGrantStatement(sideRights, schema, sideName)]),
      ...(holds(rights, viewName, "select")
        ? []
        : [tableGrantStatement(["select"], schema, viewName)]),
      ...(jobs.length === 0 ? [] : [tableGrantStatement(jobs, schema, JOBS_TABLE)]),
      ...(owners.length === 0 ? [] : [tableGrantStatement(owners, schema, OWNERS_TABLE)]),
    ],
    readers: [
      ...(sideReaders.length === 0 ? [] : [readerGrantStatement(schema, sideName, sideReaders)]),
      ...(viewReaders.length === 0 ? [] : [readerGrantStatement(schema, viewName, viewReaders)]),
    ],
  };
}

/**
 * Side-table mode's plan, in inline mode's order and by its rule (only what is missing, so the plan
 * of an installed table is empty): the marker and its guard, the side table (created, or given a
 * new question's columns), the view when it is not the one the plan makes, the queue, the login,
 * the grants, then the triggers. The table itself gains no column; every statement on it is a
 * trigger's.
 */
function sideInstallPlan(
  target: EngineTarget,
  catalog: Catalog,
  side: SideCatalog,
  key: CatalogColumn,
  loginExists: boolean,
  rights: WorkerRights,
  server: ServerName,
): { readonly plan: EnginePlan; readonly createsTriggers: boolean } {
  const { schema } = catalog;
  const { table } = target;
  const label = `${schema}.${table}`;
  const owned = ownedColumns(target.questionSet);
  const sideName = sideTableName(table);
  const present = new Set(side.side.columns.map((column) => column.name));
  const missing = owned.filter((column) => !present.has(column.name));
  const creates = side.side.type === undefined;
  const foreignKey = foreignKeyAllowed(side);
  const view = !viewCurrent(side, table, catalog.columns, owned);
  const capture: CaptureSource = {
    schema,
    table,
    key: key.name,
    state: target.questionSet.read,
    onChange: target.onChange,
  };
  const definitions = sideTriggerDefinitions(capture, owned);
  const triggers = definitions.filter(
    (definition) => !triggerInstalled(catalog.triggers, table, definition),
  );
  // FacetDB's triggers this mode does not define: inline mode's `_new`, left by an earlier install.
  const names = triggerNames(table);
  const defined = new Set(definitions.map((definition) => definition.name));
  const stale = [names.pending, names.insert, names.update].filter(
    (name) =>
      !defined.has(name) &&
      catalog.triggers.some((trigger) => trigger.name === name && trigger.table === table),
  );
  const held = loginExists ? rights : NO_RIGHTS;
  const marker = creationMarker(catalog.columns)?.name;
  const ordered = marker !== undefined && !holds(held, table, "select", marker);
  const replaced = remadeTriggers(catalog, table, triggers);
  const grants = sideGrantStatements(
    catalog,
    side,
    table,
    key.name,
    target.questionSet.read,
    marker,
    held,
  );
  const work: readonly PlanStatement[] = [
    ...(creates
      ? [createSideTableStatement(schema, table, key, owned, foreignKey)]
      : missing.length === 0
        ? []
        : [addColumnsStatement(schema, sideName, missing)]),
    ...(view
      ? [
          createViewStatement(
            schema,
            table,
            key.name,
            owned.map((column) => column.name),
          ),
        ]
      : []),
    ...(catalog.jobs.present ? [] : [jobsTableStatement(schema)]),
    ...(loginExists ? [] : [WORKER_LOGIN_STATEMENT]),
    ...grants.worker,
    ...grants.readers,
    ...stale.map((name) => dropTrigger(schema, name)),
    ...triggers.flatMap((definition) => [
      dropTrigger(schema, definition.name),
      sourceStatement("capture", createTrigger(capture, definition)),
    ]),
  ];
  const claimed = catalog.owners.some((owner) => owner.table === table);
  if (work.length === 0 && claimed) {
    return { plan: NOTHING, createsTriggers: false };
  }
  const claim: Claim = { schema, table, projectId: target.project.id, source: target.source };
  const readersGranted = grants.readers.length > 0;
  return {
    plan: {
      statements: [
        SETTINGS,
        ...(catalog.ownersPresent ? [] : [ownersTableStatement(schema)]),
        ...(claimed ? [] : [claimStatement(claim)]),
        ownerGuardStatement(claim),
        ...work,
      ],
      transactional: false,
      removes: [],
      keeps: [],
      notes: [
        installRerunNote(server),
        ...(catalog.jobs.present ? [] : [QUEUE_NOTE]),
        ...(triggers.length === 0 ? [] : [definerNote(label), columnsNote(label, server)]),
        ...(creates
          ? [
              foreignKey
                ? foreignKeyNote(label, schema, table)
                : noForeignKeyNote(label, schema, table),
            ]
          : []),
        ...(view ? [viewNote(label, schema, table)] : []),
        ...(view || readersGranted ? [readersNote(label, schema, table)] : []),
        ...(replaced.length === 0 ? [] : [remadeNote(label, server, replaced)]),
        ...(ordered ? [newestFirstNote(label)] : []),
      ],
    },
    createsTriggers: triggers.length > 0,
  };
}

export async function planInstall(
  connect: MysqlConnect,
  target: EngineTarget,
  url: string,
  options: InstallOptions,
): Promise<PlanResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  return withClient(connect, url, (query) =>
    refusing(async (): Promise<PlanResult> => {
      // The worker login is FacetDB's one account of the name, for any host; an existing one keeps
      // its password, which other projects on the server may share: the contract's code before
      // anything else is read, as on Postgres.
      const hosts = await workerHosts(query);
      if (hosts.some((host) => host !== WORKER_HOST)) {
        // In the server's name, read only for the refusal: a plan reads it next anyway.
        const server = serverNameOf(await readSession(query));
        return { ok: false, refusal: workerHostRefusal(hosts, server) };
      }
      const loginExists = hosts.includes(WORKER_HOST);
      if (!loginExists && options.workerPassword === undefined) {
        return { ok: false, refusal: workerLoginRefusal(target) };
      }
      const session = await readSession(query);
      // Under statement-based binary logging the worker could write nothing (doctor's words):
      // refused whatever the plan holds, an installed table's empty plan included.
      const logging = await readTriggerRights(query);
      if (logging.binaryLogging && logging.binlogFormat === "STATEMENT") {
        return { ok: false, refusal: statementFormatRefusal() };
      }
      const schema = target.schema ?? session.database;
      if (schema === undefined) {
        return { ok: false, refusal: noDatabaseRefusal(target) };
      }
      const catalog = await readCatalog(query, schema, target.table);
      const rights = loginExists ? await readWorkerRights(query, schema) : NO_RIGHTS;
      const side =
        target.storage === "side-table"
          ? await readSideCatalog(query, schema, target.table, isMariaDb(session))
          : undefined;
      const inlineSide =
        side === undefined
          ? await readRelation(query, schema, sideTableName(target.table))
          : undefined;
      const checked = installRefusal(
        target,
        session,
        catalog,
        rights,
        loginExists,
        side,
        inlineSide,
      );
      if (!("key" in checked)) {
        return { ok: false, refusal: checked };
      }
      const server = serverNameOf(session);
      const planned =
        side === undefined
          ? installPlan(target, catalog, checked.key, loginExists, rights, server)
          : sideInstallPlan(target, catalog, side, checked.key, loginExists, rights, server);
      if (
        planned.createsTriggers &&
        logging.binaryLogging &&
        !logging.trustCreators &&
        !logging.superUser
      ) {
        return { ok: false, refusal: binaryLoggingRefusal() };
      }
      return { ok: true, plan: planned.plan };
    }),
  );
}
