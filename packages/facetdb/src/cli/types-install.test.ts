import { type QuestionSet, REVIEWED_COLUMN, STATUS_COLUMN, UPDATED_AT_COLUMN } from "@facetdb/core";
import { ownedColumns as sqlServerColumns } from "@facetdb/mssql";
import {
  cockroachDialect,
  ownedColumns as polledColumns,
  type SqlDialect,
} from "@facetdb/sql-polling";
import { oracleDialect } from "@facetdb/sql-polling/oracle";
import { describe, expect, it } from "vitest";
import { ENGINE_URLS, type EngineName, onEngine } from "./commands/fixtures/engines.ts";
import { type EngineTypes, POLLED_COLUMNS, POSTGRES_TYPES, typesOf } from "./engines.ts";
import { installSql, postgresDialect } from "./testing.ts";

/**
 * The scheme table's `types` (cli/engines.ts) tied to the install code each engine runs: where an
 * install adds `facetdb_status` without `not null`, `facetdb types` must type it `| null`; where it
 * adds `facetdb_reviewed` nullable or without a default, the Prisma and Drizzle snippets must say
 * so; and the stored types the declaration's comment names are the install's own. Tied here:
 * Postgres's trigger install, the polling install on the Postgres, CockroachDB and Oracle dialects,
 * and SQL Server's install. Not tied: MySQL and SQLite/libSQL (their packages do not export the
 * column definitions) and MongoDB (no column definitions: its fields are written by the connector).
 */

function questionSetOf(engine: EngineName): QuestionSet {
  const config = onEngine(engine);
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the fixture has no source");
  }
  return {
    questions: source.questions,
    read: source.read,
    model: config.model,
    thresholds: source.thresholds,
  };
}

function typesFor(engine: EngineName): EngineTypes {
  const found = typesOf(ENGINE_URLS[engine]);
  if (found === undefined) {
    throw new Error(`the scheme table reads no ${engine} URL`);
  }
  return found.types;
}

/** A column's definition, by name, from an install's list. */
function definitionOf(columns: ReadonlyMap<string, string>, name: string): string {
  const definition = columns.get(name);
  if (definition === undefined) {
    throw new Error(`the install adds no column ${name}`);
  }
  return definition.toLowerCase();
}

/** What the scheme table must say of an install's own columns, read from their definitions. */
function expectOwnColumns(types: EngineTypes, columns: ReadonlyMap<string, string>): void {
  const status = definitionOf(columns, STATUS_COLUMN);
  const reviewed = definitionOf(columns, REVIEWED_COLUMN);
  expect(types.statusNullUntil === undefined, `${STATUS_COLUMN}: ${status}`).toBe(
    status.includes("not null"),
  );
  expect(types.reviewed.nullable, `${REVIEWED_COLUMN}: ${reviewed}`).toBe(
    !reviewed.includes("not null"),
  );
  expect(types.reviewed.defaultFalse, `${REVIEWED_COLUMN}: ${reviewed}`).toBe(
    reviewed.includes("default"),
  );
  expect(columns.has(UPDATED_AT_COLUMN)).toBe(true);
}

/** The answer columns' stored types, which the declaration's comment line names. */
function expectStoredTypes(types: EngineTypes, columns: ReadonlyMap<string, string>): void {
  expect(types.boolean.stored.startsWith(definitionOf(columns, "wants_refund"))).toBe(true);
  expect(types.real).toBe(definitionOf(columns, "wants_refund_probability"));
  expect(types.json.stored).toBe(definitionOf(columns, "team_probabilities"));
}

function pollingInstall(dialect: SqlDialect, engine: EngineName): ReadonlyMap<string, string> {
  return new Map(polledColumns(dialect, questionSetOf(engine)));
}

describe("facetdb types follows each install's columns", () => {
  it("Postgres's trigger install: the status not null with pending, reviewed not null with false", () => {
    const sql = installSql({ table: "support_messages", key: "id" }, questionSetOf("postgres"), {
      id: "proj_support",
      name: "Support",
    })
      .map((statement) => statement.text)
      .join("\n");
    const columns = new Map(
      [...sql.matchAll(/add column if not exists "([a-z_]+)" ([^,\n;]+)/g)].map(
        (match): [string, string] => [match[1] ?? "", (match[2] ?? "").trim()],
      ),
    );
    expectOwnColumns(POSTGRES_TYPES, columns);
    expectStoredTypes(POSTGRES_TYPES, columns);
  });

  it("the polling install, on every polled dialect: the status nullable, reviewed nullable with false", () => {
    const polledPostgres: EngineTypes = { ...POSTGRES_TYPES, ...POLLED_COLUMNS };
    expectOwnColumns(polledPostgres, pollingInstall(postgresDialect, "postgres"));
    for (const [engine, dialect] of [
      ["cockroachdb", cockroachDialect],
      ["oracle", oracleDialect],
    ] as const) {
      const columns = pollingInstall(dialect, engine);
      expectOwnColumns(typesFor(engine), columns);
      expectStoredTypes(typesFor(engine), columns);
    }
  });

  it("SQL Server's install: the status nullable, reviewed nullable with no default", () => {
    const columns = new Map(
      sqlServerColumns(questionSetOf("mssql")).map((column): [string, string] => [
        column.name,
        column.type,
      ]),
    );
    expectOwnColumns(typesFor("mssql"), columns);
    expectStoredTypes(typesFor("mssql"), columns);
  });
});
