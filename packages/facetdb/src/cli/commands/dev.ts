import { join } from "node:path";
import { createFakeProvider } from "@facetdb/model";
import { createStore, migrate, pgliteClient, WORKER_ROLE } from "@facetdb/postgres";
import type { SourceConfig } from "../../config/index.ts";
import { defineCommand } from "../program.ts";
import { splitTable } from "../table-connector.ts";
import { loadProjectConfig, projectRef, questionSetOf } from "./database.ts";
import { runWorkers, WORKER_OPTIONS, type WorkerOptions } from "./worker.ts";

/**
 * `facetdb dev`, for offline development: the worker on an embedded Postgres (PGlite) kept under
 * `.facetdb/dev/`, answered by the scripted fake provider unless `--model-url` names a compatible
 * server (Ollama, Strands Decider). It opens the store there, installs every table source whose
 * table exists, and then runs as `facetdb worker` does. Nothing leaves the machine and no key is
 * needed; `--reset` starts from an empty database.
 */

export const DEV_DIR = join(".facetdb", "dev");

/**
 * The store's secret when `FACETDB_SECRET` is not set: the dev database lives on this machine and
 * holds no real credential, so a fixed secret protects nothing that matters there.
 */
const DEV_SECRET = "facetdb-dev-embedded-database-local-only";

/** The worker login's password inside the embedded database, which no network reaches. */
const DEV_WORKER_PASSWORD = "facetdb-dev-worker";

/** What the connectors are told to connect to: PGlite ignores it, every client is the same database. */
const DEV_URL = "pglite://facetdb-dev";

/**
 * What the fake provider says to every question offline: a certain "no", the first option, the
 * lowest level. Made up, so every record lands on `done` and the columns fill without a model.
 */
const DEV_ANSWERS = { noul: 0, choice: 0, score: 0 } as const;

type DevOptions = WorkerOptions & {
  readonly modelUrl?: string;
  readonly reset?: boolean;
};

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
  ],
  run: async (context) => {
    const { options, deps, print } = context;
    const config = await loadProjectConfig(deps, options.config);
    const dir = join(deps.projectDir, DEV_DIR);
    if (options.dryRun) {
      print(
        `Would ${options.reset === true ? `delete and recreate ${DEV_DIR}/` : `open ${DEV_DIR}/`}, install ${config.sources.map((source) => source.name).join(", ")} there and run the worker. Dry run: nothing was started.`,
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
        ? createFakeProvider({ defaults: DEV_ANSWERS })
        : deps.provider(devConfig);
    print(
      options.modelUrl === undefined
        ? "note: no --model-url, so answers come from the scripted fake provider (certain, made up, free). Pass --model-url http://localhost:11434 to ask Ollama or another compatible server."
        : `Asking the model server at ${options.modelUrl}.`,
    );
    const embedded = await deps.embedded.open(dir);
    try {
      const client = pgliteClient(embedded.pglite);
      const connect = () => client;
      const store = await createStore({
        pglite: embedded.pglite,
        secret: deps.env["FACETDB_SECRET"] ?? DEV_SECRET,
        clock: deps.clock,
      });
      try {
        const project = projectRef(deps.projectDir);
        const roleExists =
          (
            await client.query("select 1 from pg_catalog.pg_roles where rolname = $1", [
              WORKER_ROLE,
            ])
          ).length > 0;
        const installed: SourceConfig[] = [];
        for (const source of config.sources) {
          if (source.api) {
            installed.push(source);
            continue;
          }
          const target = splitTable(source.table ?? "");
          const result = await migrate({
            adminUrl: DEV_URL,
            plan: {
              source: { ...target, onChange: source.onChange, storage: source.storage },
              questionSet: questionSetOf(config, source),
              project,
              ...(roleExists ? {} : { workerPassword: DEV_WORKER_PASSWORD }),
            },
            print: () => undefined,
            connect,
          });
          if (result.ok) {
            installed.push(source);
            print(`Installed ${source.name} on ${target.schema}.${target.table} in ${DEV_DIR}/.`);
          } else {
            print(
              `skipped ${source.name}: ${result.reason}. Create ${target.schema}.${target.table} in the dev database, then run facetdb dev again.`,
            );
          }
        }
        return await runWorkers(context, {
          config: { ...devConfig, sources: installed },
          project,
          store,
          storeClient: client,
          connect,
          databaseOf: () => DEV_URL,
          provider,
        });
      } finally {
        await store.close();
      }
    } finally {
      await embedded.close();
    }
  },
});
