import type { Clock } from "@facetdb/core";
import {
  createPostgresEngine,
  postgresDialect,
  SCHEMA_VERSION,
  type SqlConnect,
  type SqlQuery,
} from "@facetdb/postgres";
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
  // postgres.js itself: doctor's test on a real socket proves its connect timeout reaches it.
  connectPostgres,
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
  // The store's step as migrate prints and runs it: migrate.test.ts compares with it.
  storeScript,
  storeStepStatements,
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
 * A clock whose sleeps end only when the test moves time past them: one step, one poll, so a
 * worker's loops wait between passes instead of spinning (core's `FakeClock` resolves a sleep at
 * once). For a test that runs loops on PGlite's one connection, or proves a heartbeat gap.
 */
export class SteppedClock implements Clock {
  #time: number;
  #sleepers: { readonly due: number; readonly wake: () => void }[] = [];
  constructor(start: number) {
    this.#time = start;
  }
  now(): number {
    return this.#time;
  }
  /** An abort takes the sleeper off the clock and wakes it, as the real clock clears its timer. */
  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((wake) => {
      if (signal?.aborted === true) {
        wake();
        return;
      }
      const sleeper = { due: this.#time + ms, wake };
      this.#sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.#sleepers = this.#sleepers.filter((other) => other !== sleeper);
          wake();
        },
        { once: true },
      );
    });
  }

  /** When each sleep still on the clock ends, soonest first: what a stop must not leave behind. */
  pending(): readonly number[] {
    return this.#sleepers.map((sleeper) => sleeper.due).sort((a, b) => a - b);
  }
  advance(ms: number): void {
    this.#time += ms;
    const due = this.#sleepers.filter((sleeper) => sleeper.due <= this.#time);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.due > this.#time);
    for (const sleeper of due) {
      sleeper.wake();
    }
  }
}

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

/** Every store version this FacetDB knows: a current store's version table. */
export const CURRENT_STORE: readonly number[] = Array.from(
  { length: SCHEMA_VERSION },
  (_, index) => index + 1,
);

/**
 * A store that is its version table alone, holding `versions`: the studio's doors read where a
 * store on the source's own database stands through it, beside core's fake engine, which has no
 * database. It answers the reads of the store's step and nothing else, so a door that ran anything
 * there fails its test.
 */
export function storeAtVersions(
  versions: readonly number[],
  options: { readonly mayCreate?: boolean } = {},
): SqlConnect {
  const query: SqlQuery = (text) => {
    if (text.includes("to_regclass('facetdb.store_migrations')")) {
      return Promise.resolve([{ present: true }]);
    }
    if (text.startsWith("select version::text as version from facetdb.store_migrations")) {
      return Promise.resolve(versions.map((version) => ({ version: String(version) })));
    }
    if (text.includes("has_database_privilege(current_database(), 'create')")) {
      return Promise.resolve([{ may: options.mayCreate ?? true }]);
    }
    if (text.includes("to_regclass('facetdb.sources')")) {
      return Promise.resolve([{ present: false }]);
    }
    // The lock list's reads of a store behind: it holds every table already, and none of the step's
    // conditions (an index, a column missing) holds, so its step locks nothing.
    if (text.startsWith("do $fdb_lock_condition$")) {
      return Promise.resolve([]);
    }
    if (text === "select pg_catalog.current_setting('facetdb.lock_condition') as runs") {
      return Promise.resolve([{ runs: "false" }]);
    }
    if (text.startsWith("select c.oid is not null as present")) {
      return Promise.resolve([{ present: true, rows: 0, never: false }]);
    }
    return Promise.reject(new Error(`the fake store only reads its version, not: ${text}`));
  };
  // The lock list reads in a read-only transaction, its literal rules and a short lock timeout
  // pinned: those statements pass, and every other one meets `query`'s refusal.
  const READ_ONLY_FRAME =
    /^(set transaction read only|set local standard_conforming_strings = on|set local lock_timeout = '\d+m?s')$/;
  const reading: SqlQuery = (text, params) =>
    READ_ONLY_FRAME.test(text) ? Promise.resolve([]) : query(text, params);
  const refused = () => Promise.reject(new Error("the fake store runs nothing"));
  return () => ({
    query,
    transaction: (work) => work(reading),
    pipeline: refused,
    close: () => Promise.resolve(),
  });
}
