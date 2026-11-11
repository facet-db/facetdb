import { randomUUID } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { access, mkdir, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Clock } from "@facetdb/core";
import { selectProvider } from "@facetdb/model";
import {
  connectPostgres,
  createStore,
  type PostgresConnector,
  SECRET_VARIABLE,
} from "@facetdb/postgres";
import { loadConfig, type ProjectConfig, type SourceConfig } from "../config/index.ts";
import { wireBackfill, wireBackfillDryRun } from "./backfill-wiring.ts";
import { projectRef, questionSetOf } from "./commands/database.ts";
import { COMMANDS } from "./commands/index.ts";
import { diskEmbedded } from "./embedded.ts";
import {
  type CliDeps,
  CliError,
  type CliIo,
  formatError,
  runProgram,
  type Workspace,
} from "./program.ts";
import { serveHttp } from "./serve.ts";
import { openTableConnector, workerUrlOf } from "./table-connector.ts";

/**
 * The composition root of the `facetdb` process: the only place that touches the process's
 * terminal, environment, clock, network and database driver. It wires them into `CliDeps` once,
 * runs the program, and sets the exit code the program returns (0, 1 or 2). Secrets come from the
 * environment only: `TYPESAFE_API_KEY` for the model, `FACETDB_SECRET` for the store, the
 * connection strings the config reads (`DATABASE_URL`); an admin connection string is asked for per
 * run and never kept.
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
  const deps: CliDeps = {
    io: processIo(),
    workspace: diskWorkspace(projectDir, env),
    clock,
    projectDir,
    env,
    loadConfig: async (path) =>
      (await loadConfig(path, { projectDir, env, stderr: process.stderr })).config,
    connect: connectPostgres,
    store: () => {
      const url = env["DATABASE_URL"];
      if (url === undefined || url === "") {
        return Promise.reject(
          new CliError(
            "database-url",
            "DATABASE_URL is not set, so FacetDB has no database for its store",
            "set DATABASE_URL to the connection string of the database FacetDB keeps its store in",
          ),
        );
      }
      return createStore({ url, secret: env[SECRET_VARIABLE], clock, connect: connectPostgres });
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
    random: Math.random,
    embedded: diskEmbedded,
    backfill: async (config, source, mode) => {
      if (mode.dryRun) {
        // The store's schema and rows are made on open: a dry run reads the source and nothing else.
        const connector = await sourceConnector(config, source);
        return {
          deps: wireBackfillDryRun({ config, source, connector, clock }),
          close: () => connector.close(),
        };
      }
      const store = await deps.store();
      let connector: PostgresConnector | undefined;
      try {
        connector = await sourceConnector(config, source);
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
 * The connector of a table source: the Postgres capture runtime under the worker login, so what a
 * backfill queues lands in the source's own jobs table, where `facetdb worker` claims it.
 */
function sourceConnector(config: ProjectConfig, source: SourceConfig): Promise<PostgresConnector> {
  return openTableConnector({
    source,
    url: workerUrlOf(source),
    connect: connectPostgres,
    questionSet: questionSetOf(config, source),
    clock,
    workerId: `backfill-${randomUUID()}`,
  });
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
