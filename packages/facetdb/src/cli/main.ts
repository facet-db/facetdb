import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { Clock } from "@facetdb/core";
import { selectProvider } from "@facetdb/model";
import { connectPostgres, createStore, SECRET_VARIABLE } from "@facetdb/postgres";
import { loadConfig } from "../config/index.ts";
import { COMMANDS } from "./commands/index.ts";
import { type CliDeps, CliError, type CliIo, formatError, runProgram } from "./program.ts";

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
  return {
    io: processIo(),
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
    provider: (config) =>
      selectProvider({
        modelUrl: config.modelUrl,
        apiKey: env["TYPESAFE_API_KEY"],
        fetch: globalThis.fetch,
        clock,
      }),
  };
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
