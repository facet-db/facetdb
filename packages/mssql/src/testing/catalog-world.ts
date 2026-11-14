import type { EngineTarget, QuestionSet } from "@facetdb/core";
import {
  type CatalogColumn,
  COLUMNS_QUERY,
  CREATION_COLUMN,
  DATABASE_WORKER_QUERY,
  GRANTS_QUERY,
  JOBS_TABLE,
  KEY_QUERY,
  MARKER_TABLE,
  markerQuery,
  OBJECTS_QUERY,
  OWNER_QUERY,
  ownedColumns,
  QUEUE_KEY_COLLATION,
  QUEUE_KEY_LENGTH,
  QUEUE_NAME_LENGTH,
  QUEUE_USERS_QUERY,
  ROLES_QUERY,
  SERVER_QUERY,
  SHARED_SCHEMA,
  tableNames,
  triggerText,
  WORKER_QUERY,
  WORKER_USER,
} from "../install/index.ts";
import type { MssqlRow } from "../sql/index.ts";
import type { RecordingScript } from "./recording-client.ts";

/**
 * A SQL Server database as the install, uninstall and prune tests script it (no server): the
 * catalog's answer to every query the plans read, by the query and its parameters, served through
 * the recording client of `../testing`. `freshWorld` is the listings table as the application made
 * it; `installedWorld` is a database once an install ran on one of its tables.
 */

/** the listings example, as every engine's fixture takes it. */
export const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** One question of each type, the choice storing its probabilities. */
export const everyType: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Scam?", stakes: "low" },
    {
      type: "choice",
      name: "category",
      instructions: "Which category?",
      options: [
        { name: "car", description: "A car" },
        { name: "flat", description: "A flat" },
      ],
      stakes: "low",
      storeProbabilities: true,
    },
    {
      type: "score",
      name: "quality",
      instructions: "How good?",
      levels: [{ name: "poor" }, { name: "fine" }, { name: "great" }],
      stakes: "low",
    },
  ],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** The listings source of the project the fixture installs. */
export const LISTINGS: EngineTarget = {
  project: { id: "proj_listings", name: "Listings" },
  source: "listings",
  table: "listings",
  storage: "inline",
  onChange: "reset",
  questionSet: listings,
  urlVariable: "LISTINGS_URL",
};

export type WorldServer = {
  readonly edition: number;
  readonly majorVersion: number | null;
  readonly containment: number;
  readonly ownerLogin: string | null;
};

/** The database every world is. */
export const DATABASE = "listings";

/** Azure SQL Database (EngineEdition 5): users live in the database; it reports version 12. */
export const AZURE_SQL: WorldServer = {
  edition: 5,
  majorVersion: 12,
  containment: 0,
  ownerLogin: "facetdb_admin",
};

/** SQL Server 2022 Developer (EngineEdition 3), its databases not contained: logins. */
export const SQL_SERVER: WorldServer = {
  edition: 3,
  majorVersion: 16,
  containment: 0,
  ownerLogin: "sa",
};

/** SQL Server 2022 with a partially contained database: users in the database, as on Azure. */
export const CONTAINED_SQL_SERVER: WorldServer = { ...SQL_SERVER, containment: 1 };

export type WorldColumn = {
  readonly name: string;
  readonly type: string;
  readonly maxLength?: number;
  readonly precision?: number;
  readonly scale?: number;
  readonly collation?: string | null;
  readonly computed?: boolean;
  readonly marked?: boolean;
};

export type WorldTable = {
  readonly columns: readonly WorldColumn[];
  readonly key: readonly string[];
  /** Who owns it (`type` as `sys.database_principals` spells it): dbo, a SQL user, when absent. */
  readonly owner?: { readonly name: string; readonly type: string; readonly dbOwner: boolean };
};

export type WorldObject = {
  readonly schema: string;
  readonly name: string;
  readonly type: string;
  /** The table a trigger is on, in the object's schema. */
  readonly parent?: string;
  readonly definition?: string;
  readonly disabled?: boolean;
};

export type WorldGrant = {
  readonly schema: string;
  readonly object: string;
  /** Absent for a right on the whole object. */
  readonly column?: string;
  readonly permission: string;
};

export type WorldMarkerRow = {
  readonly schema: string;
  readonly table: string;
  readonly projectId: string;
  readonly projectName: string;
};

export type World = {
  readonly server: WorldServer;
  /** By `schema.table`. */
  readonly tables: Readonly<Record<string, WorldTable>>;
  readonly objects: readonly WorldObject[];
  /** The marker's rows; undefined when the database has none (its object goes in `objects` too). */
  readonly marker: readonly WorldMarkerRow[] | undefined;
  readonly worker: {
    readonly user: boolean;
    readonly login: boolean;
    /** The login the user's SID belongs to: FacetDB's own when absent and both exist, else none. */
    readonly userLogin?: string | null;
    readonly roles: readonly string[];
  };
  readonly grants: readonly WorldGrant[];
  /** The tables, as `schema.table`, whose FacetDB trigger writes the queue. */
  readonly queueUsers: readonly string[];
  /** How many jobs the queue holds for each table, by the name its jobs carry (`[dbo].[listings]`). */
  readonly queued: Readonly<Record<string, number>>;
};

/** The collation the world's text columns have, as the database's default. */
export const COLLATION = "SQL_Latin1_General_CP1_CI_AS";

/** A column of a type as DDL spells it (`nvarchar(255)`), as `sys.columns` would describe it. */
export function typed(
  name: string,
  definition: string,
  more: Partial<WorldColumn> = {},
): WorldColumn {
  const match = /^(\w+)(?:\((max|\d+)(?:, (\d+))?\))?$/.exec(definition);
  if (match === null) {
    throw new Error(`no column type ${definition}`);
  }
  const [, type = "", size, scale] = match;
  const units = size === undefined ? 0 : size === "max" ? -1 : Number(size);
  const text = ["nvarchar", "nchar", "varchar", "char"].includes(type);
  return {
    name,
    type,
    ...(["nvarchar", "nchar"].includes(type) ? { maxLength: units === -1 ? -1 : units * 2 } : {}),
    ...(["varchar", "char", "varbinary", "binary"].includes(type) ? { maxLength: units } : {}),
    ...(["decimal", "numeric"].includes(type)
      ? { precision: units, scale: Number(scale ?? 0) }
      : {}),
    ...(["datetime2", "datetimeoffset", "time"].includes(type) ? { scale: units } : {}),
    ...(text ? { collation: COLLATION } : {}),
    ...more,
  };
}

/** A world column as the catalog reads it. */
export function catalogColumn(column: WorldColumn): CatalogColumn {
  return {
    name: column.name,
    type: column.type,
    maxLength: column.maxLength ?? 0,
    precision: column.precision ?? 0,
    scale: column.scale ?? 0,
    collation: column.collation ?? null,
    computed: column.computed ?? false,
    marked: column.marked ?? false,
  };
}

/** dbo.listings as the application made it: an int key, the title and the description. */
export const LISTINGS_COLUMNS: readonly WorldColumn[] = [
  typed("id", "int"),
  typed("title", "nvarchar(200)"),
  typed("description", "nvarchar(max)"),
];

/** The listings database before any install: the table alone, the worker nowhere. */
export function freshWorld(server: WorldServer = AZURE_SQL): World {
  return {
    server,
    tables: { "dbo.listings": { columns: LISTINGS_COLUMNS, key: ["id"] } },
    objects: [],
    marker: undefined,
    worker: { user: false, login: false, roles: [] },
    grants: [],
    queueUsers: [],
    queued: {},
  };
}

/** The queue as install makes it. */
const QUEUE_COLUMNS: readonly WorldColumn[] = [
  typed("table_name", `nvarchar(${QUEUE_NAME_LENGTH})`),
  typed("record_key", `nvarchar(${QUEUE_KEY_LENGTH})`, { collation: QUEUE_KEY_COLLATION }),
  typed("enqueued_at", "datetime2(3)"),
  typed("claimed_by", "nvarchar(128)"),
  typed("claimed_at", "datetime2(3)"),
  typed("claim_token", "char(32)"),
];

/**
 * `world` once `target` was installed on it, exactly as the install leaves a database: FacetDB's
 * columns marked, the trigger of this question set, the queue and the marker (made by the first
 * install), the marker's row, the worker and every right it is granted.
 */
export function installedWorld(
  target: EngineTarget = LISTINGS,
  world: World = freshWorld(),
): World {
  const names = tableNames(target);
  const table = world.tables[names.label];
  if (table === undefined) {
    throw new Error(`the world has no table ${names.label} to install on`);
  }
  const [keyName = ""] = table.key;
  const key = table.columns.find((column) => column.name === keyName);
  if (key === undefined) {
    throw new Error(`the world's ${names.label} has no key column`);
  }
  const owned = ownedColumns(target.questionSet);
  const contained = world.server.edition === 5 || world.server.containment === 1;
  const has = (name: string) =>
    world.objects.some((object) => object.schema === SHARED_SCHEMA && object.name === name);
  const on = (schema: string, object: string, permission: string, column?: string): WorldGrant => ({
    schema,
    object,
    permission,
    ...(column === undefined ? {} : { column }),
  });
  return {
    ...world,
    tables: {
      ...world.tables,
      [names.label]: {
        ...table,
        columns: [
          ...table.columns,
          ...owned.map((column) => typed(column.name, column.type, { marked: true })),
        ],
      },
      [`${SHARED_SCHEMA}.${JOBS_TABLE}`]: {
        columns: QUEUE_COLUMNS,
        key: ["table_name", "record_key"],
      },
    },
    objects: [
      ...world.objects,
      {
        schema: names.schema,
        name: names.trigger,
        type: "TR",
        parent: names.table,
        definition: triggerText(
          names,
          catalogColumn(key),
          target.questionSet.read,
          target.onChange,
        ),
      },
      ...(has(JOBS_TABLE) ? [] : [{ schema: SHARED_SCHEMA, name: JOBS_TABLE, type: "U" }]),
      ...(has(MARKER_TABLE) ? [] : [{ schema: SHARED_SCHEMA, name: MARKER_TABLE, type: "U" }]),
    ],
    marker: [
      ...(world.marker ?? []),
      {
        schema: names.schema,
        table: names.table,
        projectId: target.project.id,
        projectName: target.project.name,
      },
    ],
    worker: { user: true, login: !contained, roles: [] },
    grants: [
      ...world.grants,
      ...[
        ...new Set([
          keyName,
          ...target.questionSet.read,
          ...owned.map((column) => column.name),
          ...(table.columns.some((column) => column.name === CREATION_COLUMN)
            ? [CREATION_COLUMN]
            : []),
        ]),
      ].map((column) => on(names.schema, names.table, "SELECT", column)),
      ...owned.map((column) => on(names.schema, names.table, "UPDATE", column.name)),
      ...(has(JOBS_TABLE)
        ? []
        : ["SELECT", "INSERT", "UPDATE", "DELETE"].map((right) =>
            on(SHARED_SCHEMA, JOBS_TABLE, right),
          )),
      ...(has(MARKER_TABLE) ? [] : [on(SHARED_SCHEMA, MARKER_TABLE, "SELECT")]),
    ],
    queueUsers: [...world.queueUsers, names.label],
  };
}

function columnRow(column: WorldColumn): MssqlRow {
  const read = catalogColumn(column);
  return {
    name: read.name,
    type: read.type,
    max_length: read.maxLength,
    precision: read.precision,
    scale: read.scale,
    collation: read.collation,
    computed: read.computed,
    marked: read.marked,
  };
}

/** The catalog's answers for `world`, as the recording client takes them. */
export function answer(world: World): NonNullable<RecordingScript["answer"]> {
  const markerText = markerQuery(tableNames({ table: "" }));
  return (text, params) => {
    const [p1, p2, p3, p4, p5, p6] = params.map(String);
    switch (text) {
      case SERVER_QUERY:
        return [
          {
            edition: world.server.edition,
            major_version: world.server.majorVersion,
            containment: world.server.containment,
            database_name: DATABASE,
            owner_login: world.server.ownerLogin,
          },
        ];
      case COLUMNS_QUERY:
        return (world.tables[`${p1}.${p2}`]?.columns ?? []).map(columnRow);
      case KEY_QUERY:
        return (world.tables[`${p1}.${p2}`]?.key ?? []).map((name) => ({ name }));
      case OWNER_QUERY: {
        const table = world.tables[`${p1}.${p2}`];
        const owner = table?.owner ?? { name: "dbo", type: "S", dbOwner: true };
        // `sys.database_principals.type` is char(2): a one-letter type ends in a space.
        return table === undefined
          ? []
          : [{ owner_name: owner.name, owner_type: `${owner.type} `, db_owner: owner.dbOwner }];
      }
      case OBJECTS_QUERY:
        return world.objects
          .filter(
            (object) =>
              (object.schema === p1 && object.name === p2) ||
              (object.schema === p3 && (object.name === p4 || object.name === p5)),
          )
          .map((object) => ({
            object_schema: object.schema,
            name: object.name,
            type: object.type,
            parent_schema: object.parent === undefined ? null : object.schema,
            parent_table: object.parent ?? null,
            definition: object.definition ?? null,
            disabled: object.disabled ?? false,
          }));
      case WORKER_QUERY: {
        const { user, login } = world.worker;
        const given = world.worker.userLogin;
        const mapped = given === undefined ? (user && login ? WORKER_USER : null) : given;
        return [{ user_exists: user, login_exists: login, user_login: user ? mapped : null }];
      }
      case DATABASE_WORKER_QUERY:
        return [{ user_exists: world.worker.user }];
      case ROLES_QUERY:
        return world.worker.roles.map((name) => ({ name }));
      case GRANTS_QUERY:
        return world.grants
          .filter(
            (grant) =>
              (grant.schema === p2 && grant.object === p3) ||
              (grant.schema === p4 && (grant.object === p5 || grant.object === p6)),
          )
          .map((grant) => ({
            schema_name: grant.schema,
            object_name: grant.object,
            column_name: grant.column ?? null,
            permission: grant.permission,
          }));
      case QUEUE_USERS_QUERY:
        return p1 === JOBS_TABLE
          ? world.queueUsers.map((label) => {
              const [schema = "", ...table] = label.split(".");
              return { table_schema: schema, table_name: table.join(".") };
            })
          : [];
      case markerText:
        return (world.marker ?? []).map((row) => ({
          table_schema: row.schema,
          table_name: row.table,
          project_id: row.projectId,
          project_name: row.projectName,
        }));
      default:
        break;
    }
    if (text.startsWith("select [table_name] as table_name, count(*) as queued")) {
      return Object.entries(world.queued).map(([table, queued]) => ({ table_name: table, queued }));
    }
    return undefined;
  };
}
