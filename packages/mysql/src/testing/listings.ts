import type { EngineDeps, EngineTarget, QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { ownedColumns, triggerDefinitions, triggerNames } from "../install/index.ts";
import type { ScriptedColumn, ScriptedDatabase, ScriptedTable } from "./catalog.ts";

/**
 * the listings example on MySQL, the one every engine's install fixture is made from
 * (packages/postgres/src/install/install.listings.test.ts): one high-stakes yes-or-no question
 * about a listing's title and description, in the database `app`.
 */

export const LISTINGS_QUESTIONS: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

export const LISTINGS_PROJECT = { id: "proj_listings", name: "Listings" } as const;

/** The admin's connection string: this machine, so the TLS rule asks nothing of it. */
export const ADMIN_URL = "mysql://admin:admin-secret@127.0.0.1:3306/app";

/** What every call is given: no `--allow-insecure`, and the store elsewhere, as for every MySQL source. */
export const ENGINE_DEPS: EngineDeps = {
  clock: new FakeClock(0),
  allowInsecure: false,
  storeShared: false,
};

export function listingsTarget(overrides: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: LISTINGS_PROJECT,
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: LISTINGS_QUESTIONS,
    ...overrides,
  };
}

/** The application's table before any install: an `auto_increment` key and two text columns. */
export const LISTINGS_TABLE: ScriptedTable = {
  name: "listings",
  columns: [
    { name: "id", type: "int", extra: "auto_increment" },
    {
      name: "title",
      type: "varchar(255)",
      charset: "utf8mb4",
      collation: "utf8mb4_0900_ai_ci",
    },
    { name: "description", type: "text", charset: "utf8mb4", collation: "utf8mb4_0900_ai_ci" },
  ],
  primaryKey: ["id"],
};

/** The listings table and nothing of FacetDB's: no column, no queue, no marker, no login. */
export function freshListings(): ScriptedDatabase {
  return { schema: "app", database: "app", tables: [LISTINGS_TABLE] };
}

/** `column_type` of a definition as MySQL prints it back: `boolean` is a `tinyint(1)`. */
function printedType(definition: string): string {
  const type = definition.split(" ")[0] ?? definition;
  return type === "boolean" ? "tinyint(1)" : type;
}

/** The queue as install makes it, shared by the database's tables. */
export const LISTINGS_JOBS: ScriptedTable = {
  name: "facetdb_jobs",
  columns: [
    { name: "table_name", type: "varchar(64)", charset: "utf8mb4", collation: "utf8mb4_bin" },
    { name: "record_key", type: "varbinary(1020)" },
    { name: "enqueued_at", type: "datetime(3)", extra: "DEFAULT_GENERATED" },
    { name: "claimed_by", type: "varchar(64)", charset: "utf8mb4", collation: "utf8mb4_bin" },
    { name: "claimed_at", type: "datetime(3)" },
    { name: "claim_token", type: "char(32)", charset: "utf8mb4", collation: "utf8mb4_bin" },
  ],
  primaryKey: ["table_name", "record_key"],
};

/**
 * The database as the install of `target` leaves it: FacetDB's marked columns on the table, the
 * queue, the marker's row, the two triggers as install defines them, and the worker login with
 * exactly the rights install gives it.
 */
export function installedListings(target: EngineTarget = listingsTarget()): ScriptedDatabase {
  const owned = ownedColumns(target.questionSet);
  const ownedNames = owned.map((column) => column.name);
  const columns: readonly ScriptedColumn[] = [
    ...LISTINGS_TABLE.columns,
    ...owned.map((column) => ({
      name: column.name,
      type: printedType(column.definition),
      comment: "facetdb",
    })),
  ];
  const triggers = triggerDefinitions({
    schema: "app",
    table: target.table,
    key: "id",
    state: target.questionSet.read,
    onChange: target.onChange,
  });
  return {
    schema: "app",
    database: "app",
    tables: [{ ...LISTINGS_TABLE, name: target.table, columns }, LISTINGS_JOBS],
    owners: [{ table: target.table, projectId: target.project.id, source: target.source }],
    triggers: triggers.map((trigger) => ({
      name: trigger.name,
      table: target.table,
      timing: trigger.timing.toUpperCase(),
      event: trigger.event.toUpperCase(),
      body: trigger.body,
    })),
    worker: {
      global: ["USAGE"],
      columns: [
        ...["id", ...target.questionSet.read, ...ownedNames].map((column) => ({
          table: target.table,
          column,
          privilege: "SELECT",
        })),
        ...ownedNames.map((column) => ({ table: target.table, column, privilege: "UPDATE" })),
      ],
      tables: [
        ...["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => ({
          table: "facetdb_jobs",
          privilege,
        })),
        { table: "facetdb_table_owners", privilege: "SELECT" },
      ],
    },
  };
}

/** The names of the listings table's two triggers. */
export const LISTINGS_TRIGGERS = triggerNames("listings");
