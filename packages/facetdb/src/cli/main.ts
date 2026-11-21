import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { accessSync, constants, existsSync } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  link,
  lstat,
  mkdir,
  open,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { userInfo } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import type { Clock, OpenConnector } from "@facetdb/core";
import {
  connectPostgres,
  createPostgresDialect,
  createPostgresEngine,
  createStore,
} from "@facetdb/postgres";
import { loadConfig, type ProjectConfig, type SourceConfig } from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  BUILTIN_PLUGINS,
  createPluginHost,
  importFromProject,
  type PluginHost,
} from "../plugin/index.ts";
import { wireBackfill, wireBackfillDryRun } from "./backfill-wiring.ts";
import { systemBrowser } from "./browser.ts";
import { engineTarget, projectRef, sourceUrlOf, splitTable } from "./commands/database.ts";
import { COMMANDS } from "./commands/index.ts";
import { diskConfigFiles, gitCommand } from "./config-files.ts";
import { diskEmbedded } from "./embedded.ts";
import { engineFor, lazyEngine, openConnector } from "./engines.ts";
import { diskExamples } from "./examples.ts";
import { type OutputWriters, quietOnClosedPipe, runEnding } from "./pipe.ts";
import { pipedAnswers } from "./piped.ts";
import { sharePools } from "./pools.ts";
import {
  type CliDeps,
  CliError,
  type CliIo,
  formatError,
  runProgram,
  type Workspace,
} from "./program.ts";
import { modelProviderOf } from "./provider-door.ts";
import { serveHttp } from "./serve.ts";
import { requireStoreSecret, requireStoreUrl, storeSharedFor } from "./store-door.ts";
import { diskStudioFiles } from "./studio-files.ts";
import { processTerminal } from "./terminal.ts";
import { quietTypelessPackageWarning } from "./warnings.ts";

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
 * and the SQL Server engine over tedious, and the MongoDB, libSQL, Oracle and CockroachDB engines
 * below; `init
 * --example` reads the package's own example projects from the disk.
 */

const clock: Clock = {
  now: () => Date.now(),
  // An abort clears the timer and resolves at once (a stop during a stopped source's wait for its
  // next try must not keep the process alive until the wait ends).
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const ended = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", ended);
        resolve();
      }, ms);
      signal?.addEventListener("abort", ended, { once: true });
    }),
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
    // readline writes the question itself. At a terminal it redraws its line from the first column
    // before it reads, which wiped a question written to stderr ahead of it: `migrate` and
    // `backfill` then waited on a blank line. The question is on screen before the echo is muted.
    const asked = lines.question(question);
    muted = options?.secret === true && terminal;
    const answer = await asked;
    if (muted) {
      process.stderr.write("\n");
    }
    return answer;
  } finally {
    lines.close();
  }
}

/** A filesystem error's code (`EEXIST`, `EPERM`), or undefined. */
function codeOf(error: unknown): unknown {
  return (error as { readonly code?: unknown } | undefined)?.code;
}

/** How much of a file `Workspace.peek` reads for its first line: a generated header fits many times. */
const PEEK_BYTES = 4096;

/** What `link` fails with on a filesystem that has no hard links (FAT, some network mounts). */
const NO_HARD_LINKS: ReadonlySet<unknown> = new Set(["EPERM", "ENOTSUP", "EXDEV"]);

/** A file's permission bits, or undefined when there is no file. */
async function modeOf(file: string): Promise<number | undefined> {
  try {
    return (await stat(file)).mode & 0o7777;
  } catch (error) {
    if (codeOf(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * A file's lines, read as the consumer asks for them (`review --from`), so a large export is never
 * held whole. Never through a symbolic link, as `peek` reads none; a byte order mark that a Windows
 * editor put first is dropped.
 */
async function* linesOf(file: string): AsyncGenerator<string> {
  // O_NOFOLLOW, as `peek`: a link put there since the check is refused, never read through.
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  const input = handle.createReadStream({ encoding: "utf8" });
  try {
    let first = true;
    for await (const line of createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY })) {
      yield first ? line.replace(/^﻿/, "") : line;
      first = false;
    }
  } finally {
    input.destroy();
  }
}

/**
 * The project directory on the real disk, and the `claude` command looked up on the real PATH.
 * `files.link` is the disk's own unless a test hands in one that refuses, as a filesystem without
 * hard links does.
 */
export function diskWorkspace(
  projectDir: string,
  env: Readonly<Record<string, string | undefined>>,
  files: { readonly link: (existing: string, made: string) => Promise<void> } = { link },
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
    writeParts: async (path, parts, { overwrite }) => {
      const file = resolve(projectDir, path);
      await mkdir(dirname(file), { recursive: true });
      // Beside the file, so the last step is a rename or a link within one directory.
      const partial = join(dirname(file), `.${basename(file)}.${randomUUID()}.partial`);
      try {
        const handle = await open(partial, "wx");
        try {
          for await (const part of parts) {
            await handle.writeFile(part);
          }
        } finally {
          await handle.close();
        }
        if (overwrite) {
          // The replaced file's mode carries over (a 0600 export stays 0600), then a rename
          // replaces it whole: a reader sees the old one or the new one.
          const mode = await modeOf(file);
          if (mode !== undefined) {
            await chmod(partial, mode);
          }
          await rename(partial, file);
          return "written";
        }
        // A link fails when the name is taken, so a file that appeared meanwhile is never replaced.
        // A filesystem without hard links gets an exclusive copy instead, which fails the same way.
        try {
          try {
            await files.link(partial, file);
          } catch (error) {
            if (!NO_HARD_LINKS.has(codeOf(error))) {
              throw error;
            }
            await copyFile(partial, file, constants.COPYFILE_EXCL);
          }
        } catch (error) {
          if (codeOf(error) === "EEXIST") {
            return "exists";
          }
          throw error;
        }
        return "written";
      } finally {
        // Gone already after a rename; after a link, or a failure, the temporary name goes.
        await rm(partial, { force: true });
      }
    },
    lines: (path) => linesOf(resolve(projectDir, path)),
    peek: async (path) => {
      const file = resolve(projectDir, path);
      try {
        if (!(await lstat(file)).isFile()) {
          return { kind: "other" };
        }
        // O_NOFOLLOW: a link put there since the lstat is refused, never read through.
        const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const head = Buffer.alloc(PEEK_BYTES);
          const { bytesRead } = await handle.read(head, 0, PEEK_BYTES, 0);
          return {
            kind: "file",
            firstLine: head.toString("utf8", 0, bytesRead).split("\n")[0] ?? "",
          };
        } finally {
          await handle.close();
        }
      } catch (error) {
        if (codeOf(error) === "ENOENT") {
          return { kind: "none" };
        }
        if (codeOf(error) === "ELOOP") {
          return { kind: "other" };
        }
        throw error;
      }
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

/**
 * Questions with no terminal: each takes the next line of standard input, in the order a terminal
 * would ask (`printf 'url\ntable\nyes\n' | facetdb init`); the question still goes to stderr, so a
 * log shows what each line answered. An input that ends before an answer is an error that says
 * which flag answers it instead.
 */
function pipedIo(): Pick<CliIo, "prompt" | "answerable"> {
  const piped = pipedAnswers(process.stdin);
  return {
    prompt: async (question) => {
      process.stderr.write(question);
      const answer = await piped.next();
      if (answer === undefined) {
        process.stderr.write("\n");
        throw new CliError(
          "no-answer",
          `standard input ended before an answer to: ${question.trim()}`,
          "give the answer as a flag (facetdb <command> --help lists them), add a line for it to what you pipe in, or run the command at a terminal",
        );
      }
      process.stderr.write("\n");
      return answer;
    },
    answerable: () => piped.left(),
  };
}

function processIo(output: OutputWriters): CliIo {
  return {
    stdout: output.stdout,
    stderr: output.stderr,
    ...(process.stdin.isTTY === true
      ? { prompt, answerable: () => Promise.resolve(true) }
      : pipedIo()),
  };
}

/** The process's streams written as they are, for a caller that installed no closed-pipe guard. */
const DIRECT_OUTPUT: OutputWriters = {
  stdout: (text) => {
    process.stdout.write(text);
  },
  stderr: (text) => {
    process.stderr.write(text);
  },
};

/** The config file a project directory holds, by the name every command defaults to. */
const PROJECT_CONFIG = "facetdb.config.ts";

/**
 * The project directory. `pnpm facetdb` runs the script in the directory of the package.json that
 * defines it, a parent of the caller's, and says where it was called from in `INIT_CWD`; so the
 * nearest directory holding `facetdb.config.ts` from `INIT_CWD` up to and including the working
 * directory, and when none holds one, `INIT_CWD` itself. `pnpm run worker` from a subfolder of the
 * user's own project finds the config at its root, as before; `pnpm facetdb init` where no config
 * is yet writes one where the user stood. A script that changes directory deeper (`cd db && facetdb
 * migrate`) still carries the outer `INIT_CWD`, which is then outside the working directory and
 * ignored.
 */
export function projectDirOf(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
  hasConfig: (directory: string) => boolean,
): string {
  const called = env["INIT_CWD"];
  if (called === undefined || called === "") {
    return cwd;
  }
  const inside = relative(cwd, resolve(called));
  // `..` exactly as the first step leaves the working directory; `..foo` is a name inside it.
  if (inside.split(sep)[0] === ".." || isAbsolute(inside)) {
    return cwd;
  }
  const root = resolve(cwd);
  // Every directory from INIT_CWD up to the working directory (depth 0); `inside` is empty when
  // INIT_CWD is the working directory.
  const steps = inside === "" ? [] : inside.split(sep);
  for (let depth = steps.length; depth >= 0; depth -= 1) {
    const directory = join(root, ...steps.slice(0, depth));
    if (hasConfig(directory)) {
      return directory;
    }
  }
  return resolve(called);
}

/** Aborts on SIGINT and SIGTERM, once each: Ctrl+C, or the service manager's stop. */
function onStopSignals(abort: () => void): void {
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
}

/** A stop signal on the process's own stop signals alone, for a caller with no closed-pipe guard. */
function signalStop(): AbortSignal {
  const stop = new AbortController();
  onStopSignals(() => stop.abort());
  return stop.signal;
}

export function processDeps(
  run: { readonly output: OutputWriters; readonly stopSignal: () => AbortSignal } = {
    output: DIRECT_OUTPUT,
    stopSignal: signalStop,
  },
): CliDeps {
  const { output } = run;
  const env = process.env;
  const projectDir = projectDirOf(env, process.cwd(), (directory) =>
    existsSync(join(directory, PROJECT_CONFIG)),
  );
  // One driver for the store and the Postgres engine, its pools shared by URL: the worker's store
  // pool is lent to the engine's connector of a table on the store's own database (cli/pools.ts).
  const connect = sharePools(connectPostgres);
  const workspace = diskWorkspace(projectDir, env);
  const deps: CliDeps = {
    io: processIo(output),
    workspace,
    clock,
    projectDir,
    env,
    // `env` is the process's own, so a variable set here is read back by `env` and by the config
    // file's `process.env` when the loader imports it (`facetdb dev`).
    setEnv: (name, value) => {
      process.env[name] = value;
    },
    loadConfig: async (path, options) =>
      (
        await loadConfig(path, {
          projectDir,
          env,
          stderr: process.stderr,
          ...(options?.quiet === true ? { quiet: true } : {}),
        })
      ).config,
    // Apply's door to facetdb.config.ts: read without following a link, replaced aside and renamed
    // into place, judged by the git on this PATH.
    configFiles: diskConfigFiles(projectDir, workspace, gitCommand(env)),
    // A plugin is the project's dependency: resolved beside the config file, never from this
    // package's own node_modules; a built-in from facetdb itself.
    pluginHost: (config, path) =>
      createPluginHost({
        config,
        env,
        projectDir,
        coreVersion: VERSION,
        importModule: importFromProject(resolve(projectDir, path)),
        builtins: BUILTIN_PLUGINS,
      }),
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
      let secret: string;
      try {
        url = requireStoreUrl(env, options?.allowInsecure);
        // An unset FACETDB_SECRET is refused in words with its fix, before anything connects.
        secret = requireStoreSecret(env);
      } catch (error) {
        return Promise.reject(error);
      }
      return createStore({
        url,
        pgHost: env["PGHOST"],
        secret,
        clock,
        connect: options?.connect ?? connect,
        ...(options?.allowInsecure === true ? { allowInsecure: true } : {}),
        ...(options?.warn === undefined ? {} : { warn: options.warn }),
      });
    },
    provider: (config, plugins) => provider(config, env, run.stopSignal, plugins),
    serve: serveHttp,
    osUser: () => {
      try {
        return userInfo().username;
      } catch {
        // The OS has no entry for this uid (a container run as an arbitrary user): the review
        // log still needs a name, and says plainly that it does not know it.
        return "unknown";
      }
    },
    stopSignal: run.stopSignal,
    webhookFetch: (url, init) => globalThis.fetch(url, init),
    fetch: (url, init) => globalThis.fetch(url, init),
    // Unref'd by the platform: a pending timeout keeps no idle process alive.
    abortAfter: (ms) => AbortSignal.timeout(ms),
    random: Math.random,
    embedded: diskEmbedded,
    examples: diskExamples,
    terminal: processTerminal({ input: process.stdin, output: process.stdout, env }),
    // The studio's build: @facetdb/studio's dist/, read through the disk door.
    studio: { defaultDir: studioDistDir(), files: diskStudioFiles },
    openBrowser: systemBrowser(process.platform, spawn),
    backfill: async (config, source, mode) => {
      if (mode.dryRun) {
        // The store's schema and rows are made on open: a dry run reads the source and nothing else.
        const connector = await sourceConnector(deps, config, source, mode.allowInsecure === true);
        return {
          deps: wireBackfillDryRun({
            config,
            source,
            project: projectRef(projectDir),
            connector,
            clock,
          }),
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
          provider: provider(config, env, run.stopSignal, mode.plugins),
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

/**
 * Where `pnpm build` writes the studio: the dist/ beside `@facetdb/studio`'s package.json, a
 * workspace dependency of this package (a published package bundles the build into it). Undefined
 * when the package is not installed, and `facetdb studio` then says how to get a build.
 */
function studioDistDir(): string | undefined {
  try {
    return join(
      dirname(fileURLToPath(import.meta.resolve("@facetdb/studio/package.json"))),
      "dist",
    );
  } catch {
    return undefined;
  }
}

function provider(
  config: ProjectConfig,
  env: Readonly<Record<string, string | undefined>>,
  stopSignal: () => AbortSignal,
  plugins: PluginHost | undefined,
) {
  return modelProviderOf({ config, env, fetch: globalThis.fetch, clock, stopSignal, plugins });
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
  // Installed once, before anything is loaded: the config file's typeless-package warning never
  // reaches Node's printer, which prints every other warning as it always does (cli/warnings.ts).
  quietTypelessPackageWarning(process);
  // A reader that has gone (`facetdb worker | head -1`) ends the run quietly with 0: the worker
  // first stops as on Ctrl+C, releasing what it holds; any other command at once (cli/pipe.ts).
  const ending = runEnding({
    exit: () => {
      process.exit(0);
    },
    listen: onStopSignals,
  });
  const output = quietOnClosedPipe({ stdout: process.stdout, stderr: process.stderr }, ending.end);
  const deps = processDeps({ output, stopSignal: ending.stopSignal });
  try {
    const code = await runProgram(process.argv.slice(2), deps, COMMANDS);
    process.exitCode = ending.pipeClosed() ? 0 : code;
  } catch (error) {
    // The program reports every command's errors itself; this is a failure of the program.
    const message = error instanceof Error ? error.message : String(error);
    output.stderr(
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
