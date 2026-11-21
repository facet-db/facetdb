import { join } from "node:path";
import type { Answer, DatabaseEngine, ModelProvider, OpenConnector } from "@facetdb/core";
import { createFakeProvider } from "@facetdb/model";
import { type ProjectConfig, pluginProviderOf, type SourceConfig } from "../../config/index.ts";
import { embeddedParts } from "../embedded.ts";
import { stoppedError } from "../engines.ts";
import { CliError, defineCommand, EXIT_USAGE } from "../program.ts";
import { STORE_VARIABLE } from "../store-door.ts";
import { tableFacts } from "./dashboard-door.ts";
import { engineTarget, loadWorkerConfig, projectRef, splitTable } from "./database.ts";
import { readSeed, runSeed, type Seed, statementWords } from "./dev-seed.ts";
import type { DoorDatabases } from "./setup-door.ts";
import {
  DEFAULT_HOST,
  runWorkers,
  WORKER_OPTIONS,
  type WorkerOptions,
  workerStudio,
} from "./worker.ts";

/**
 * `facetdb dev`: the worker on an embedded Postgres (PGlite) kept under `.facetdb/dev/`, answered
 * by the scripted fake provider unless `--model-url` names a compatible server (Ollama, Strands
 * Decider). It opens the store there (a PGlite store is dev's alone), seeds a SQL file into it with
 * `--seed`, installs every table source whose table exists through the Postgres engine over the
 * same database, queues the seeded rows, and then runs as `facetdb worker` does, the studio's doors
 * included: Apply writes facetdb.config.ts and the worker reloads it, and Add a source runs on the
 * embedded database with dev's address as the admin connection string, every other string refused.
 * Nothing leaves the machine and no key is needed; `--reset` starts from an empty database.
 */

export const DEV_DIR = join(".facetdb", "dev");

/**
 * The store's secret when `FACETDB_SECRET` is not set: the dev database lives on this machine and
 * holds no real credential, so a fixed secret protects nothing that matters there.
 */
const DEV_SECRET = "facetdb-dev-embedded-database-local-only";

/** The worker login's password inside the embedded database, which no network reaches. */
const DEV_WORKER_PASSWORD = "facetdb-dev-worker";

/**
 * Dev's address: what `DATABASE_URL` holds for the run, so facetdb.config.ts reads the embedded
 * database, and the admin connection string the setup flow takes. The engine's client ignores it,
 * every connection being the one database.
 */
export const DEV_URL = "pglite://facetdb-dev";

/**
 * The same database as the worker login: the embedded engine runs a connection on this address as
 * `facetdb_worker` (embedded.ts), so the doctor and the connector see the install's grants as they
 * would on a server.
 */
const DEV_WORKER_URL = "pglite://facetdb_worker@facetdb-dev";

/**
 * What the fake provider says to every question offline: a certain "no", the first option, the
 * lowest level. Made up, so every record lands on `done` and the columns fill without a model.
 */
const DEV_ANSWERS = { noul: 0, choice: 0, score: 0 } as const;

/** The word that marks a record for review: the listings seed writes its scam listings with it. */
const DEFAULT_MARKER = "URGENT";

/** What the fake says to a yes-or-no question about a marked record: as unsure as an answer gets. */
const UNSURE = 0.5;

type DevOptions = Omit<WorkerOptions, "host"> & {
  readonly modelUrl?: string;
  readonly reset?: boolean;
  readonly seed?: string;
  readonly unsure?: string;
};

/**
 * The fake's answers, except for a record whose read text holds the marker (whatever its case):
 * unsure on every yes-or-no question, so under any stakes the record is left for review and the
 * Review page has cards to decide, skip and undo. Choices and scores keep the fake's own answer.
 */
export function unsureOn(marker: string, provider: ModelProvider): ModelProvider {
  const lowered = marker.toLowerCase();
  return {
    async ask(request) {
      const response = await provider.ask(request);
      const marked = Object.values(request.state).some(
        (value) => value?.toLowerCase().includes(lowered) === true,
      );
      if (!marked) {
        return response;
      }
      const answers: Record<string, Answer> = {};
      for (const [name, answer] of Object.entries(response.answers)) {
        answers[name] = answer.type === "noul" ? { type: "noul", probability: UNSURE } : answer;
      }
      return { ...response, answers };
    },
  };
}

/** `--unsure`: a word to look for, or the default; an empty one is a bad invocation. */
function markerOf(given: string | undefined): string {
  const marker = (given ?? DEFAULT_MARKER).trim();
  if (marker === "") {
    throw new CliError(
      "unsure",
      "--unsure is a word to look for in a record's text, and an empty one is in every record",
      `pass --unsure ${DEFAULT_MARKER}, or leave it out: ${DEFAULT_MARKER} is the default`,
      EXIT_USAGE,
    );
  }
  return marker;
}

/**
 * The databases the studio's doors reach under dev (setup-door.ts `DoorDatabases`): the embedded
 * database alone, named by dev's address and served by dev's own engine, every source sharing its
 * store and the install creating the worker login with dev's password. Any other connection string
 * is refused in words naming the one to use; the string itself is in none of them.
 */
function embeddedDatabases(engine: DatabaseEngine): DoorDatabases {
  const only = (url: string): DatabaseEngine => {
    if (url.trim() !== DEV_URL) {
      throw new CliError(
        "dev-address",
        `facetdb dev reaches its embedded database alone, under the connection string ${DEV_URL}, and this connection string is another; nothing was connected`,
        `paste ${DEV_URL} as the connection string (facetdb dev prints it when it starts); to add a source on another database, run facetdb worker on that database instead`,
      );
    }
    return engine;
  };
  return {
    reads: (url) => url === DEV_URL,
    name: (url) => (url === DEV_URL ? "PGlite" : undefined),
    engine: (url) => Promise.resolve(only(url)),
    adminEngine: (_source, admin) => Promise.resolve(only(admin)),
    // Every table source lives on the embedded database whatever its string says, so a table dev
    // installed is taken under any string the file reads it from.
    same: () => true,
    storeShared: () => true,
    workerPassword: () => ({ password: DEV_WORKER_PASSWORD }),
    // Dev's address is the admin string of every call, which the setup hides from its words: the
    // address is named as the one dev printed, never spelled here.
    variableFix: (variable) =>
      `under facetdb dev every source reads the embedded database, so name ${STORE_VARIABLE}, which holds dev's address for this run; to read ${variable} instead, set it to the same address (facetdb dev prints it when it starts), restart facetdb dev, then show the SQL again`,
  };
}

export const devCommand = defineCommand<DevOptions>("dev", {
  description:
    "Runs the worker on an embedded Postgres under .facetdb/dev/ with the fake model (or --model-url), offline",
  options: [
    ...WORKER_OPTIONS,
    {
      flags: "--model-url <url>",
      description:
        "a compatible model server (Ollama, Strands Decider) instead of the fake provider",
    },
    { flags: "--reset", description: "delete .facetdb/dev/ and start from an empty database" },
    {
      flags: "--seed <file>",
      description:
        "a SQL file to run into the dev database before the install, in one transaction (the listings example's seed.sql); its rows are queued for answering, and a second run without --reset seeds them again",
    },
    {
      flags: "--unsure <word>",
      description: `the word (in any case) that marks a record the fake provider answers unsure, so it waits for review; ${DEFAULT_MARKER} by default`,
    },
  ],
  run: async (context) => {
    const { options, deps, print } = context;
    // Dev's one address, set before the file loads: facetdb.config.ts reads it as
    // process.env.DATABASE_URL, the loader names the variable by it, the setup's step five finds it
    // set, and the file Apply writes reads it back. Said always, and whether a value the shell had
    // was replaced (never the value), since the file reads the address from now on.
    const had = deps.env[STORE_VARIABLE];
    deps.setEnv(STORE_VARIABLE, DEV_URL);
    print(
      `${STORE_VARIABLE} holds ${DEV_URL} for this run${had === undefined || had === "" ? "" : ", in place of the value the shell had"}, so facetdb.config.ts reads the embedded database.`,
    );
    // The worker's own start: the plugins the config names are loaded and checked, as it does.
    const { config, plugins } = await loadWorkerConfig(deps, options.config);
    if (
      options.modelUrl !== undefined &&
      config.provider !== undefined &&
      pluginProviderOf(config.provider) !== undefined
    ) {
      throw new CliError(
        "model-provider",
        `--model-url cannot be used with the plugin's provider ${config.provider}: the plugin names its own address, so the flag would be ignored`,
        "run facetdb dev without --model-url to answer with the scripted fake provider, or take provider out of the config to ask the server at --model-url",
        EXIT_USAGE,
      );
    }
    const marker = markerOf(options.unsure);
    const seed: Seed | undefined =
      options.seed === undefined ? undefined : await readSeed(deps.workspace, options.seed);
    const dir = join(deps.projectDir, DEV_DIR);
    // The same studio the worker serves: --studio-dir's build, else the install's own; looked for
    // before a dry run too, which then says whether it would be served.
    const studio = await workerStudio(deps, options, print);
    if (options.dryRun) {
      print(
        `Would ${options.reset === true ? `delete and recreate ${DEV_DIR}/` : `open ${DEV_DIR}/`}, ${seed === undefined ? "" : `run the ${statementWords(seed.statements.length)} of ${seed.path} into it, `}install ${config.sources.map((source) => source.name).join(", ")} there and run the worker${studio === undefined ? "" : `, serving the studio from ${studio.dir}`}. Dry run: nothing was started.`,
      );
      return { ok: true, dryRun: true };
    }
    if (options.reset === true) {
      await deps.embedded.wipe(dir);
      print(`Deleted ${DEV_DIR}/: starting from an empty database.`);
    }
    const devConfig =
      options.modelUrl === undefined ? config : { ...config, modelUrl: options.modelUrl };
    const provider =
      options.modelUrl === undefined
        ? unsureOn(marker, createFakeProvider({ defaults: DEV_ANSWERS }))
        : deps.provider(devConfig, plugins);
    if (options.modelUrl === undefined) {
      print(
        `note: no --model-url, so answers come from the scripted fake provider (certain, made up, free): a certain no to every question, except that a record whose text holds ${marker} is answered unsure (50%) on every yes-or-no question and waits for review. Pass --model-url http://localhost:11434 to ask Ollama or another compatible server.`,
      );
    } else {
      print(`Asking the model server at ${options.modelUrl}.`);
      if (options.unsure !== undefined) {
        deps.io.stderr(
          `note: --unsure ${options.unsure} is unused with --model-url, whose server gives the answers\n`,
        );
      }
    }
    const embedded = await deps.embedded.open(dir);
    try {
      const secret = deps.env["FACETDB_SECRET"] ?? DEV_SECRET;
      const { store, client, engine } = await embeddedParts(embedded, {
        secret,
        clock: deps.clock,
      });
      try {
        const project = projectRef(deps.projectDir);
        // The store and every source share the one embedded database; nothing crosses a network.
        const engineDeps = { clock: deps.clock, allowInsecure: true, storeShared: true };
        // A source as the embedded engine sees it, under the question set of the project it is read
        // from (the file's after a reload).
        const targetOf = (from: ProjectConfig, source: SourceConfig) =>
          engineTarget(from, { source, ...splitTable(source.table ?? "") }, project);
        // Before the install, so the tables it makes are there to install on.
        const seeded = seed === undefined ? [] : await runSeed(client, seed, print);
        const installed: SourceConfig[] = [];
        for (const source of config.sources) {
          if (source.api) {
            installed.push(source);
            continue;
          }
          const target = targetOf(devConfig, source);
          // The embedded Postgres engine's name for it, `public` for a bare one.
          const named = engine.label(target, DEV_URL);
          // The engine sets the password only on a login it creates: an existing one keeps its own.
          const options = { ...engineDeps, workerPassword: DEV_WORKER_PASSWORD };
          const skipped = (reason: string) =>
            print(
              `skipped ${source.name}: ${reason}. Create ${named} in the dev database, or pass --seed <file> with the SQL that creates it, then run facetdb dev again.`,
            );
          const planned = await engine.planInstall(target, DEV_URL, options);
          if (!planned.ok) {
            skipped(planned.refusal.message);
            continue;
          }
          const ran = await engine.run(target, planned.plan, DEV_URL, options);
          if (ran.stopped !== undefined && "refusal" in ran.stopped) {
            skipped(ran.stopped.refusal.message);
            continue;
          }
          if (ran.stopped !== undefined) {
            throw stoppedError(ran.stopped);
          }
          installed.push(source);
          print(`Installed ${source.name} on ${named} in ${DEV_DIR}/.`);
          if (seeded.includes(named)) {
            // The rows were there before the trigger: queued as a backfill queues them, every one,
            // so the worker answers them from its own queue.
            const connector = await engine.open(target, DEV_WORKER_URL, {
              ...engineDeps,
              workerId: "dev-seed",
            });
            try {
              const queued = await enqueueAll(connector);
              print(
                `Queued the ${queued} ${queued === 1 ? "row" : "rows"} of ${named} for answering.`,
              );
            } finally {
              await connector.close();
            }
          }
        }
        if (options.http && !options.once) {
          print(`Add a source in the studio with the connection string ${DEV_URL}.`);
        }
        // Offline and on this machine only: no --host, because the secret above may be the
        // constant this file publishes, and a cookie signed under it would be forgeable.
        return await runWorkers(
          { ...context, options: { ...context.options, host: DEFAULT_HOST } },
          {
            config: { ...devConfig, sources: installed },
            project,
            store,
            storeClient: client,
            // The embedded database as the dashboard shows it: PGlite, reached as the worker login.
            tableFacts: (source, from) =>
              Promise.resolve({
                ...tableFacts({
                  engine,
                  target: targetOf(from, source),
                  url: DEV_WORKER_URL,
                  source,
                  deps: engineDeps,
                }),
                database: "PGlite",
              }),
            openTable: (source, open, from) =>
              engine.open(targetOf(from, source), DEV_WORKER_URL, { ...engineDeps, ...open }),
            // The config file as `facetdb worker` gives it: Apply writes it and the worker reloads
            // it; the setup and migrate doors stand on the embedded database.
            configFile: {
              path: options.config,
              // The file as dev reads it: with --model-url's server in place of the file's, as the
              // start read it, so a reload compares like with like and says nothing of modelUrl.
              load: async (load) => {
                const loaded = await deps.loadConfig(options.config, load);
                return options.modelUrl === undefined
                  ? loaded
                  : { ...loaded, modelUrl: options.modelUrl };
              },
              files: deps.configFiles,
            },
            databases: embeddedDatabases(engine),
            provider,
            sessionSecret: secret,
            plugins,
            ...(studio === undefined ? {} : { studio: studio.build }),
          },
        );
      } finally {
        await store.close();
      }
    } finally {
      await embedded.close();
    }
  },
});

/** Every row of the table, newest first, into the worker's queue; how many were queued. */
async function enqueueAll(connector: OpenConnector): Promise<number> {
  let queued = 0;
  let cursor: string | null = null;
  do {
    const page = await connector.scan(cursor);
    const keys = page.rows.map((row) => row.key);
    if (keys.length > 0) {
      await connector.enqueue(keys);
      queued += keys.length;
    }
    cursor = page.next;
  } while (cursor !== null);
  return queued;
}
