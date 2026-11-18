import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Clock, OpenConnector } from "@facetdb/core";
import { selectProvider } from "@facetdb/model";
import {
  connectPostgres,
  createPostgresDialect,
  createPostgresEngine,
  createStore,
  SECRET_VARIABLE,
} from "@facetdb/postgres";
import { loadConfig, type ProjectConfig, type SourceConfig } from "../config/index.ts";
import { wireBackfill, wireBackfillDryRun } from "./backfill-wiring.ts";
import { engineTarget, projectRef, sourceUrlOf, splitTable } from "./commands/database.ts";
import { COMMANDS } from "./commands/index.ts";
import { diskEmbedded } from "./embedded.ts";
import { engineFor, lazyEngine, openConnector } from "./engines.ts";
import { sharePools } from "./pools.ts";
import {
  type CliDeps,
  CliError,
  type CliIo,
  formatError,
  runProgram,
  type Workspace,
} from "./program.ts";
import { serveHttp } from "./serve.ts";
import { requireStoreUrl, storeSharedFor } from "./store-door.ts";

/**
 * The composition root of the `facetdb` process: the only place that touches the process's
 * terminal, environment, clock, network and database driver. It wires them into `CliDeps` once,
 * runs the program, and sets the exit code the program returns (0, 1 or 2). Secrets come from the
 * environment only: `TYPESAFE_API_KEY` for the model, `FACETDB_SECRET` for the store, the
 * connection strings the config reads (`DATABASE_URL`); an admin connection string is asked for per
 * run and never kept. The database engines a source's scheme picks from are built here: the
 * Postgres engine over the same driver and pools as the store, judged with the environment's
 * `PGHOST`, and the polling engine `connector: "polling"` picks over the Postgres dialect, the same
 * driver and the same `PGHOST`, the SQLite engine over node:sqlite, the MySQL engine over mysql2
 * and the SQL Server engine over tedious; other engines append theirs.
 */

const clock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/**
 * One question on the terminal. Prompts go to stderr, so stdout stays the command's output (and
 * parses under `--json`). A secret answer is read with the echo muted.
 */
async function prompt(question: string, options?: { readonly secret?: boolean }): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) {
        process.stderr.write(chunk);
      }
      done();
    },
  });
  const terminal = process.stdin.isTTY === true;
  const lines = createInterface({ input: process.stdin, output, terminal });
  try {
    process.stderr.write(question);
    muted = options?.secret === true && terminal;
    const answer = await lines.question("");
    if (muted) {
      process.stderr.write("\n");
    }
    return answer;
  } finally {
    lines.close();
  }
}

/** The project directory on the real disk, and the `claude` command looked up on the real PATH. */
function diskWorkspace(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>>,
): Workspace {
  return {
    exists: async (path) => {
      try {
        await access(resolve(projectDir, path));
        return true;
      } catch {
        return false;
      }
    },
    write: async (path, text, { overwrite }) => {
      const file = resolve(projectDir, path);
      await mkdir(dirname(file), { recursive: true });
      // "wx" fails when the file exists, so a race cannot replace what init was told to keep.
      await writeFile(file, text, { flag: overwrite ? "w" : "wx" });
    },
    hasClaudeCommand: () =>
      (env["PATH"] ?? "")
        .split(delimiter)
        .filter((directory) => directory !== "")
        .some((directory) => {
          try {
            accessSync(join(directory, "claude"), constants.X_OK);
            return true;
          } catch {
            return false;
          }
        }),
  };
}

function processIo(): CliIo {
  return {
    stdout: (text) => {
      process.stdout.write(text);
    },
    stderr: (text) => {
      process.stderr.write(text);
    },
    prompt,
  };
}

export function processDeps(): CliDeps {
  const env = process.env;
  const projectDir = process.cwd();
  // One driver for the store and the Postgres engine, its pools shared by URL: the worker's store
  // pool is lent to the engine's connector of a table on the store's own database (cli/pools.ts).
  const connect = sharePools(connectPostgres);
  const deps: CliDeps = {
    io: processIo(),
    workspace: diskWorkspace(projectDir, env),
    clock,
    projectDir,
    env,
    loadConfig: async (path) =>
      (await loadConfig(path, { projectDir, env, stderr: process.stderr })).config,
    // Each engine is made on first use for a source of its key only, so a driver no source needs is
    // never imported (later engines load their package here with `import()`). Never the default
    // `postgresEngine`: without PGHOST a hostless URL with a remote PGHOST would pass the TLS
    // refusal.
    engines: [
      lazyEngine("postgres", () =>
        Promise.resolve(createPostgresEngine({ connect, pgHost: env["PGHOST"] })),
      ),
      // `connector: "polling"` on a Postgres host that forbids triggers: the polling engine over
      // the Postgres dialect, or over the CockroachDB one when the server's version() says
      // CockroachDB (both speak the Postgres wire; doctor says which it found). The hourly-scan
      // warning of a table with no column to poll by goes to stderr, beside the worker's own lines.
      lazyEngine("polling", async () => {
        const { postgresWireEngine } = await import("@facetdb/sql-polling");
        return postgresWireEngine({
          postgres: createPostgresDialect({ pgHost: env["PGHOST"] }),
          connect,
          warn: (message) => {
            process.stderr.write(`warning: ${message}\n`);
          },
        });
      }),
      // A SQLite file (sqlite:, file: or a bare .db path) through Node's own node:sqlite: the
      // worker opens the file itself, one worker per file, polling every second.
      lazyEngine("sqlite", async () => {
        const { createSqliteEngine } = await import("@facetdb/sqlite");
        return createSqliteEngine();
      }),
      // MySQL 8 and MariaDB 10.5 and later (mysql:, mariadb:) through mysql2: one admin connection
      // per plan or run, a pool under the worker login for the connector, polling the jobs table
      // every second.
      lazyEngine("mysql", async () => {
        const { createMysqlEngine } = await import("@facetdb/mysql");
        return createMysqlEngine();
      }),
      // SQL Server 2016 and later and Azure SQL (mssql:, sqlserver:) through tedious: one admin
      // connection per plan or run, a pool under the worker login for the connector, polling the
      // jobs table every second. tedious loads @azure/identity and MSAL, so only a source of these
      // schemes pays for them. A source with capture: "change-tracking" keeps the version it has
      // read up to in the store's cursors, opened as MongoDB's are: only once its `watch` (or
      // doctor's version check) needs them, closed with the connector. A lost version's warning
      // goes to stderr, beside the worker's own lines.
      lazyEngine("mssql", async () => {
        const { createMssqlEngine } = await import("@facetdb/mssql");
        return createMssqlEngine({
          cursors: async ({ allowInsecure }) => {
            const store = await deps.store({ allowInsecure });
            return { cursors: store.cursors, close: () => store.close() };
          },
          warn: (message) => {
            process.stderr.write(`warning: ${message}\n`);
          },
        });
      }),
      // MongoDB 4.4 and later and Atlas (mongodb:, mongodb+srv:) through the mongodb driver: change
      // streams on a replica set, the resume token kept in the store's cursors, which this root
      // owns: a connector opens the store only once its `watch` runs, through the same pools (the
      // worker's store pool is borrowed), and closes it with itself. A lost token's warning goes to
      // stderr, beside the worker's own lines.
      lazyEngine("mongodb", async () => {
        const { createMongoEngine } = await import("@facetdb/mongodb");
        return createMongoEngine({
          cursors: async ({ allowInsecure }) => {
            const store = await deps.store({ allowInsecure });
            return { cursors: store.cursors, close: () => store.close() };
          },
          warn: (message) => {
            process.stderr.write(`warning: ${message}\n`);
          },
        });
      }),
      // libSQL servers, Turso and sqld (libsql:, and https: or http: with turso.io or libsql in the
      // host), through @libsql/client over HTTP: the SQLite connector and one worker, the auth
      // token read from this environment only (<the source's variable>_AUTH_TOKEN, else
      // LIBSQL_AUTH_TOKEN). Its own entry point, so a SQLite file never loads the driver.
      lazyEngine("libsql", async () => {
        const { createLibsqlEngine } = await import("@facetdb/sqlite/libsql");
        return createLibsqlEngine({ env });
      }),
      // Oracle Database (oracle:) through oracledb in thin mode: the polling engine over the Oracle
      // dialect, a subpath of @facetdb/sql-polling so oracledb loads only for a source of this
      // scheme. The hourly-scan warning goes to stderr, beside the worker's own lines.
      lazyEngine("oracle", async () => {
        const { createOracleEngine } = await import("@facetdb/sql-polling/oracle");
        return createOracleEngine({
          warn: (message) => {
            process.stderr.write(`warning: ${message}\n`);
          },
        });
      }),
      // CockroachDB (cockroachdb:) through the Postgres wire with the polling dialect of
      // @facetdb/sql-polling: postgres.js with TLS from the URL's sslmode, polling every
      // 10 seconds by a last-changed column; its hourly-scan warning goes to stderr.
      lazyEngine("cockroachdb", async () => {
        const { cockroachDialect, connectCockroach, pollingEngine } = await import(
          "@facetdb/sql-polling"
        );
        return pollingEngine(cockroachDialect, connectCockroach, {
          warn: (message) => {
            process.stderr.write(`warning: ${message}\n`);
          },
        });
      }),
    ],
    connect,
    store: (options) => {
      let url: string;
      try {
        url = requireStoreUrl(env, options?.allowInsecure);
      } catch (error) {
        return Promise.reject(error);
      }
      return createStore({
        url,
        pgHost: env["PGHOST"],
        secret: env[SECRET_VARIABLE],
        clock,
        connect: options?.connect ?? connect,
        ...(options?.allowInsecure === true ? { allowInsecure: true } : {}),
      });
    },
    provider: (config) => provider(config, env),
    serve: serveHttp,
    stopSignal: () => {
      const stop = new AbortController();
      const abort = () => stop.abort();
      process.once("SIGINT", abort);
      process.once("SIGTERM", abort);
      return stop.signal;
    },
    webhookFetch: (url, init) => globalThis.fetch(url, init),
    // Unref'd by the platform: a pending timeout keeps no idle process alive.
    abortAfter: (ms) => AbortSignal.timeout(ms),
    random: Math.random,
    embedded: diskEmbedded,
    backfill: async (config, source, mode) => {
      if (mode.dryRun) {
        // The store's schema and rows are made on open: a dry run reads the source and nothing else.
        const connector = await sourceConnector(deps, config, source, mode.allowInsecure === true);
        return {
          deps: wireBackfillDryRun({ config, source, connector, clock }),
          close: () => connector.close(),
        };
      }
      const store = await deps.store({ allowInsecure: mode.allowInsecure === true });
      let connector: OpenConnector | undefined;
      try {
        connector = await sourceConnector(deps, config, source, mode.allowInsecure === true);
        const wired = await wireBackfill({
          config,
          source,
          project: projectRef(projectDir),
          store,
          connector,
          provider: provider(config, env),
          clock,
        });
        const opened = connector;
        return {
          deps: wired,
          close: async () => {
            await opened.close();
            await store.close();
          },
        };
      } catch (error) {
        await connector?.close();
        await store.close();
        throw error;
      }
    },
  };
  return deps;
}

function provider(config: ProjectConfig, env: Readonly<Record<string, string | undefined>>) {
  return selectProvider({
    modelUrl: config.modelUrl,
    apiKey: env["TYPESAFE_API_KEY"],
    fetch: globalThis.fetch,
    clock,
  });
}

/**
 * The connector of a table source from its engine, under the worker login, so what a backfill
 * queues lands in the source's own queue, where `facetdb worker` claims it.
 */
async function sourceConnector(
  deps: CliDeps,
  config: ProjectConfig,
  source: SourceConfig,
  allowInsecure: boolean,
): Promise<OpenConnector> {
  const url = sourceUrlOf(source, "the worker login's connection string");
  return openConnector(
    await engineFor(deps.engines, url, source.connector),
    engineTarget(
      config,
      { source, ...splitTable(source.table ?? "") },
      projectRef(deps.projectDir),
    ),
    url,
    {
      clock,
      allowInsecure,
      storeShared: storeSharedFor(deps.env, source),
      workerId: `backfill-${randomUUID()}`,
    },
  );
}

async function main(): Promise<void> {
  const deps = processDeps();
  try {
    process.exitCode = await runProgram(process.argv.slice(2), deps, COMMANDS);
  } catch (error) {
    // The program reports every command's errors itself; this is a failure of the program.
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      formatError(
        new CliError(
          "unexpected",
          message,
          "open an issue on the FacetDB repository with this message",
        ),
      ),
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
