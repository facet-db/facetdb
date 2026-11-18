import { createPostgresEngine, postgresDialect, type SqlConnect } from "@facetdb/postgres";
import { pollingEngine } from "@facetdb/sql-polling";
import type { ProjectConfig } from "../config/index.ts";
import { lazyEngine } from "./engines.ts";
import type { EngineEntry } from "./program.ts";

/**
 * The CLI's tests' one door to the Postgres package. A command reaches a source's database through
 * its engine and the store through the store door, so no file under `cli/commands/` imports
 * `@facetdb/postgres`; their tests register the same Postgres engine over PGlite here, as main.ts
 * registers it over postgres.js, and take the store's and PGlite's helpers from here. Nothing here
 * runs in production.
 */

// `migrate` is the deprecated pre-058 path: the oracle the CLI's one-database script is compared
// with, byte for byte (migrate.test.ts).
export {
  createStore,
  // The trigger install's statements and the polling dialect: `facetdb types` ties its column
  // nullability to them (types-install.test.ts).
  installSql,
  migrate,
  pgliteClient,
  postgresDialect,
  type SqlClient,
  type SqlConnect,
  type Store,
  sourceIdOf,
  WORKER_ROLE,
} from "@facetdb/postgres";
export {
  createPgliteWorld,
  freshPglite,
  type PgliteWorld,
  pollingInstallSql,
  resetPglite,
  resetPgliteWorld,
  TEST_SECRET,
} from "@facetdb/postgres/testing";

/**
 * What the loader makes of `database: process.env.DATABASE_URL` (config/load.ts records the
 * variable a connection string came from): every source that names a database without a variable
 * reads the store's, so the store is its own database, as a test of today's one-database setup
 * means.
 */
export function readingDatabaseUrl(config: ProjectConfig): ProjectConfig {
  return {
    ...config,
    sources: config.sources.map((source) =>
      source.database === undefined || source.databaseEnv !== undefined
        ? source
        : { ...source, databaseEnv: "DATABASE_URL" },
    ),
  };
}

/**
 * The engines a test registers (`CliDeps.engines`): the Postgres engine over the test's driver,
 * with no `PGHOST`, loaded on first use as the composition root registers it over postgres.js with
 * the environment's.
 */
export function postgresEngines(connect: SqlConnect): readonly EngineEntry[] {
  return [
    lazyEngine("postgres", () =>
      Promise.resolve(createPostgresEngine({ connect, pgHost: undefined })),
    ),
  ];
}

/**
 * The same engines with the polling one beside them, over the Postgres dialect and the test's
 * driver, as main.ts registers it for `connector: "polling"`; its warnings go to `warn`.
 */
export function pollingEngines(
  connect: SqlConnect,
  warn: (message: string) => void = () => undefined,
): readonly EngineEntry[] {
  return [
    ...postgresEngines(connect),
    lazyEngine("polling", () => Promise.resolve(pollingEngine(postgresDialect, connect, { warn }))),
  ];
}
