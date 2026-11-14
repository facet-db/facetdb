import { join } from "node:path";
import { createFakeProvider } from "@facetdb/model";
import type { SourceConfig } from "../../config/index.ts";
import { embeddedParts } from "../embedded.ts";
import { stoppedError } from "../engines.ts";
import { defineCommand } from "../program.ts";
import {
  engineTarget,
  loadProjectConfig,
  projectRef,
  splitTable,
  type TableTarget,
} from "./database.ts";
import { runWorkers, WORKER_OPTIONS, type WorkerOptions } from "./worker.ts";

/**
 * `facetdb dev`: the worker on an embedded Postgres (PGlite) kept under `.facetdb/dev/`, answered
 * by the scripted fake provider unless `--model-url` names a compatible server (Ollama, Strands
 * Decider). It opens the store there (a PGlite store is dev's alone), installs every table source
 * whose table exists through the Postgres engine over the same database, and then runs as `facetdb
 * worker` does. Nothing leaves the machine and no key is needed; `--reset` starts from an empty
 * database.
 */

export const DEV_DIR = join(".facetdb", "dev");

/**
 * The store's secret when `FACETDB_SECRET` is not set: the dev database lives on this machine and
 * holds no real credential, so a fixed secret protects nothing that matters there.
 */
const DEV_SECRET = "facetdb-dev-embedded-database-local-only";

/** The worker login's password inside the embedded database, which no network reaches. */
const DEV_WORKER_PASSWORD = "facetdb-dev-worker";

/** What the engine is told to connect to: its client ignores it, every client is the same database. */
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
      const { store, client, engine } = await embeddedParts(embedded, {
        secret: deps.env["FACETDB_SECRET"] ?? DEV_SECRET,
        clock: deps.clock,
      });
      try {
        const project = projectRef(deps.projectDir);
        // The store and every source share the one embedded database; nothing crosses a network.
        const engineDeps = { clock: deps.clock, allowInsecure: true, storeShared: true };
        const targetOf = (table: TableTarget) => engineTarget(devConfig, table, project);
        const installed: SourceConfig[] = [];
        for (const source of config.sources) {
          if (source.api) {
            installed.push(source);
            continue;
          }
          const table = { source, ...splitTable(source.table ?? "") };
          // The engine sets the password only on a login it creates: an existing one keeps its own.
          const options = { ...engineDeps, workerPassword: DEV_WORKER_PASSWORD };
          const skipped = (reason: string) =>
            print(
              `skipped ${source.name}: ${reason}. Create ${table.schema}.${table.table} in the dev database, then run facetdb dev again.`,
            );
          const planned = await engine.planInstall(targetOf(table), DEV_URL, options);
          if (!planned.ok) {
            skipped(planned.refusal.message);
            continue;
          }
          const ran = await engine.run(targetOf(table), planned.plan, DEV_URL, options);
          if (ran.stopped !== undefined && "refusal" in ran.stopped) {
            skipped(ran.stopped.refusal.message);
            continue;
          }
          if (ran.stopped !== undefined) {
            throw stoppedError(ran.stopped);
          }
          installed.push(source);
          print(`Installed ${source.name} on ${table.schema}.${table.table} in ${DEV_DIR}/.`);
        }
        return await runWorkers(context, {
          config: { ...devConfig, sources: installed },
          project,
          store,
          storeClient: client,
          openTable: (source, open) =>
            engine.open(targetOf({ source, ...splitTable(source.table ?? "") }), DEV_URL, {
              ...engineDeps,
              ...open,
            }),
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
