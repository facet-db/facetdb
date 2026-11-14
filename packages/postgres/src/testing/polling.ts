import type { QuestionSet } from "@facetdb/core";
import { columnStatements, tableOf } from "@facetdb/sql-polling";
import { postgresDialect } from "../polling/index.ts";

/**
 * The polling install's column statements on Postgres, as they were before the connector moved to
 * `@facetdb/sql-polling`: the answer and status columns plus `facetdb_state_hash`, each marked as
 * FacetDB's, with no trigger, no jobs table and no project mark. The fixture
 * install.listings.polling.sql pins them byte for byte; the tests that lay down a polling table as
 * an install from before the mark left it build it with these. Tests only: `facetdb migrate` runs
 * the polling engine's plan (`pollingEngine(postgresDialect, …)`), with the mark and the login.
 */
export function pollingInstallSql(
  source: { readonly table: string; readonly schema?: string; readonly key: string },
  questionSet: QuestionSet,
): string[] {
  // `if not exists` adds every column whatever the table holds: nothing needs to be read first.
  return columnStatements(
    postgresDialect,
    tableOf(postgresDialect, source),
    questionSet,
    new Set(),
  ).map((statement) => statement.text);
}
