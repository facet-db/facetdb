import type { MysqlRow } from "../sql/index.ts";
import type { Answer } from "./recording.ts";

/**
 * A MySQL database as the install, uninstall and prune plans read it, scripted: the answers of the
 * recording driver to their `information_schema` and marker reads, from a plain description of one
 * schema. A read is a `select`; anything else (the plan's statements, sent by `run`) answers no row.
 * It answers by what a query reads (`from information_schema.columns`), so a plan's query texts can
 * change without the script changing.
 */

export type ScriptedColumn = {
  readonly name: string;
  /** `column_type` as MySQL 8 prints it: `int`, `varchar(255)`, `tinyint(1)`, `datetime(3)`. */
  readonly type: string;
  readonly comment?: string;
  /** `extra`: `auto_increment`, `STORED GENERATED`. */
  readonly extra?: string;
  /** A text column's character set and collation. */
  readonly charset?: string;
  readonly collation?: string;
};

export type ScriptedTable = {
  readonly name: string;
  /** `table_type`; `BASE TABLE` when absent. */
  readonly type?: string;
  readonly columns: readonly ScriptedColumn[];
  readonly primaryKey?: readonly string[];
};

export type ScriptedTrigger = {
  readonly name: string;
  readonly table: string;
  /** `BEFORE` or `AFTER`, as the catalog prints it. */
  readonly timing: string;
  /** `INSERT` or `UPDATE`. */
  readonly event: string;
  readonly body: string;
};

/** The worker login's rights, as the catalog's privilege views list them (privileges upper case). */
export type ScriptedRights = {
  readonly global?: readonly string[];
  readonly schema?: readonly string[];
  readonly tables?: readonly { readonly table: string; readonly privilege: string }[];
  readonly columns?: readonly {
    readonly table: string;
    readonly column: string;
    readonly privilege: string;
  }[];
};

export type ScriptedDatabase = {
  /** The schema every table and trigger is in. */
  readonly schema: string;
  /** What `database()` returns: the connection string's database, or null when it names none. */
  readonly database: string | null;
  /** `@@session.sql_mode`; MySQL 8's default when absent. */
  readonly sqlMode?: string;
  /** Every table of the schema but the marker: the source's, FacetDB's queue. */
  readonly tables: readonly ScriptedTable[];
  readonly triggers?: readonly ScriptedTrigger[];
  /** The marker's rows; the marker table exists only when this is given, empty or not. */
  readonly owners?: readonly {
    readonly table: string;
    readonly projectId: string;
    readonly source: string;
  }[];
  /** The worker login `'facetdb_worker'@'%'`: absent, the login does not exist. */
  readonly worker?: ScriptedRights;
  /** Hosts of other accounts named `facetdb_worker` (`localhost`, `10.0.0.%`). */
  readonly otherWorkerHosts?: readonly string[];
  /** `version()`; a MySQL 8.4 when absent. */
  readonly version?: string;
  /**
   * What creating a trigger needs here: binary logging on, `log_bin_trust_function_creators` off
   * and SUPER held, MySQL 8's defaults for its root, when absent.
   */
  readonly triggerRights?: {
    readonly binaryLogging: boolean;
    readonly trustCreators: boolean;
    readonly superUser: boolean;
  };
  /**
   * The views that read a table of the schema, as `information_schema.view_table_usage` lists them;
   * `unlisted` for a server without that view (MariaDB). None, listed, when absent.
   */
  readonly views?: readonly { readonly view: string; readonly table: string }[] | "unlisted";
};

/** MySQL 8.0's default `sql_mode`. */
export const DEFAULT_SQL_MODE =
  "ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION";

/** MariaDB 10.5's default `sql_mode`. */
export const MARIADB_SQL_MODE =
  "STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_AUTO_CREATE_USER,NO_ENGINE_SUBSTITUTION";

/** `data_type` as the catalog derives it from `column_type`: `varchar(36)` → `varchar`. */
function dataType(type: string): string {
  return type.split(/[ (]/)[0] ?? type;
}

/** `character_maximum_length` of a char, varchar, binary or varbinary column; null for the rest here. */
function maxLength(type: string): number | null {
  const length = /^(?:var)?(?:char|binary)\((\d+)\)/.exec(type)?.[1];
  return length === undefined ? null : Number(length);
}

/** The marker table as install creates it, there whenever the script gives its rows. */
const OWNERS: ScriptedTable = {
  name: "facetdb_table_owners",
  columns: [
    { name: "table_name", type: "varchar(64)", charset: "utf8mb4", collation: "utf8mb4_bin" },
    { name: "project_id", type: "varchar(255)", charset: "utf8mb4", collation: "utf8mb4_bin" },
    { name: "source", type: "varchar(255)", charset: "utf8mb4", collation: "utf8mb4_bin" },
    { name: "installed_at", type: "datetime(3)", extra: "DEFAULT_GENERATED" },
  ],
  primaryKey: ["table_name"],
};

export function scriptedDatabase(database: ScriptedDatabase): Answer {
  const { schema, owners } = database;
  const tables = [...database.tables, ...(owners === undefined ? [] : [OWNERS])];
  const tableNamed = (name: unknown) => tables.find((table) => table.name === name);
  const inSchema = (params: readonly unknown[]) => params[0] === schema;
  const rights = database.worker ?? {};
  const triggerRights = database.triggerRights ?? {
    binaryLogging: true,
    trustCreators: false,
    superUser: true,
  };
  const views = database.views ?? [];
  return (text, params) => {
    if (!text.trimStart().startsWith("select")) {
      return [];
    }
    if (text.includes("@@session.sql_mode")) {
      return [
        {
          sql_mode: database.sqlMode ?? DEFAULT_SQL_MODE,
          current_database: database.database,
          server_version: database.version ?? "8.4.3",
        },
      ];
    }
    if (text.includes("@@global.log_bin")) {
      return [
        {
          log_bin: triggerRights.binaryLogging ? 1 : 0,
          trust_creators: triggerRights.trustCreators ? 1 : 0,
          super_user: triggerRights.superUser ? 1 : 0,
        },
      ];
    }
    if (text.includes("select database()")) {
      return [{ name: database.database }];
    }
    if (text.includes("'VIEW_TABLE_USAGE'")) {
      return [{ n: views === "unlisted" ? 0 : 1 }];
    }
    if (text.includes("from information_schema.view_table_usage")) {
      return views === "unlisted" || params[0] !== schema
        ? []
        : views
            .filter((usage) => usage.table === params[1])
            .map((usage): MysqlRow => ({ view_schema: schema, view_name: usage.view }));
    }
    if (text.includes("from information_schema.tables")) {
      if (!inSchema(params)) {
        return text.includes("count(*)") ? [{ n: 0 }] : [];
      }
      if (text.includes("count(*)")) {
        return [{ n: tableNamed(params[1]) === undefined ? 0 : 1 }];
      }
      if (text.includes(" in (")) {
        return params
          .slice(1)
          .filter((name) => tableNamed(name) !== undefined)
          .map((name): MysqlRow => ({ name }));
      }
      const table = tableNamed(params[1]);
      return table === undefined ? [] : [{ type: table.type ?? "BASE TABLE" }];
    }
    if (text.includes("from information_schema.columns")) {
      const table = inSchema(params) ? tableNamed(params[1]) : undefined;
      return (table?.columns ?? []).map(
        (column): MysqlRow => ({
          name: column.name,
          type: column.type,
          data_type: dataType(column.type),
          comment: column.comment ?? "",
          extra: column.extra ?? "",
          charset_name: column.charset ?? null,
          collation_name: column.collation ?? null,
          max_length: maxLength(column.type),
        }),
      );
    }
    if (text.includes("from information_schema.key_column_usage")) {
      const table = inSchema(params) ? tableNamed(params[1]) : undefined;
      return (table?.primaryKey ?? []).map((name): MysqlRow => ({ name }));
    }
    if (text.includes("from information_schema.triggers")) {
      return inSchema(params)
        ? (database.triggers ?? []).map(
            (trigger): MysqlRow => ({
              name: trigger.name,
              table_name: trigger.table,
              timing: trigger.timing,
              event: trigger.event,
              body: trigger.body,
            }),
          )
        : [];
    }
    if (text.includes("from mysql.user")) {
      return [...(database.worker === undefined ? [] : ["%"]), ...(database.otherWorkerHosts ?? [])]
        .sort()
        .map((host): MysqlRow => ({ host }));
    }
    if (text.includes("from information_schema.user_privileges")) {
      return (rights.global ?? []).map((privilege): MysqlRow => ({ privilege }));
    }
    if (text.includes("from information_schema.schema_privileges")) {
      return params[1] === schema
        ? (rights.schema ?? []).map((privilege): MysqlRow => ({ privilege }))
        : [];
    }
    if (text.includes("from information_schema.table_privileges")) {
      return params[1] === schema
        ? (rights.tables ?? []).map(
            (held): MysqlRow => ({ table_name: held.table, privilege: held.privilege }),
          )
        : [];
    }
    if (text.includes("from information_schema.column_privileges")) {
      return params[1] === schema
        ? (rights.columns ?? []).map(
            (held): MysqlRow => ({
              table_name: held.table,
              name: held.column,
              privilege: held.privilege,
            }),
          )
        : [];
    }
    if (text.includes("facetdb_table_owners")) {
      if (owners === undefined || !text.includes(`\`${schema}\`.`)) {
        throw new Error(`Table '${schema}.facetdb_table_owners' doesn't exist`);
      }
      const rows = params.length === 0 ? owners : owners.filter((row) => row.table === params[0]);
      return rows.map(
        (row): MysqlRow => ({
          table_name: row.table,
          project_id: row.projectId,
          source_name: row.source,
        }),
      );
    }
    throw new Error(`the scripted database has no answer for: ${text}`);
  };
}
