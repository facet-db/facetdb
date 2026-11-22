import { createBackfill, type StateValue } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, facetdb, noul, type ProjectConfig, sourceCall } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import { createPluginHost, definePlugin, type Plugin, source, z } from "../../plugin/index.ts";
import { pluginBackfillConnector, wireBackfill, wireBackfillDryRun } from "../backfill-wiring.ts";
import { processDeps } from "../main.ts";
import { EXIT_SETUP, EXIT_USAGE, runInProcess } from "../program.ts";
import { storeSourceId } from "../store-door.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  type SqlConnect,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { projectRef } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb backfill` on a plugin source, through the in-process runner and the same builder the
 * composition root wires (`pluginBackfillConnector`), over a PGlite store: the plugin source is
 * picked like a table one, its estimate says what it cost the plugin, a dry run opens no store and
 * changes nothing, a run takes every record in and queues it with the source registered as the
 * worker registers it, a refused row is said, and a plugin's failure is said in FacetDB's words
 * with where the next run resumes.
 */

const PROJECT_DIR = "/work/tracker-app";
const START = 1_700_000_000_000;
const LEAKED = "token trk_s3cret-token was refused";
const ENV = {
  TRACKER_TOKEN: "trk_s3cret-token",
  DATABASE_URL: "postgres://localhost:5432/facetdb",
};
const ID = storeSourceId(projectRef(PROJECT_DIR).id, "issues");

/** The driver the command never reaches: a plugin source is read through its plugin. */
const noDatabase: SqlConnect = () => {
  throw new Error("a plugin source's backfill reaches no database but the store");
};

type Issue = Readonly<Record<string, StateValue>>;

let issues: Map<number, Issue>;
/** Set to make the plugin's scan fail from its second page on. */
let failing: boolean;

const tracker: Plugin = definePlugin({
  name: "tracker",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret() }),
  sources: {
    issues: source({
      config: z.object({ repo: z.string().min(3) }),
      watch: async function* () {},
      read: async () => [],
      // Ten a page, newest first; a cursor is the number of the last issue of the page before.
      scan: async function* (_ctx, cursor) {
        let below = cursor === null ? Number.POSITIVE_INFINITY : Number(cursor);
        for (;;) {
          if (failing && below !== Number.POSITIVE_INFINITY) {
            throw new Error(LEAKED);
          }
          const numbers = [...issues.keys()].filter((n) => n < below).sort((a, b) => b - a);
          const page = numbers.slice(0, 10);
          const last = page.at(-1);
          const next = numbers.length > page.length && last !== undefined ? String(last) : null;
          yield {
            rows: page.map((n) => ({ key: `acme/web#${n}`, state: issues.get(n) ?? {} })),
            next,
          };
          if (next === null) {
            return;
          }
          below = Number(next);
        }
      },
    }),
  },
});

const ISSUES = {
  name: "issues",
  source: sourceCall("@facetdb/tracker", "issues", { repo: "acme/web" }),
  read: ["title", "body"],
  questions: { not_priority: noul("Would the maintainers treat this as low priority?") },
};

function project(sources: readonly unknown[] = [ISSUES]): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: { tracker: { token: env("TRACKER_TOKEN") } },
    sources: sources as never,
  });
}

let world: PgliteWorld;
let store: Store;
let clock: FakeClock;
let provider: FakeProvider;
/** The modes the command asked the composition root for, a note function as `true`. */
let modes: Record<string, unknown>[];

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  issues = new Map();
  for (let n = 1; n <= 25; n += 1) {
    issues.set(n, { title: `Issue ${n}`, body: `What issue ${n} says` });
  }
  failing = false;
  modes = [];
  clock = new FakeClock(START);
  provider = createFakeProvider({ defaults: { noul: 0.93 } });
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

/** The plugin host of a loaded config, the fixture plugin installed. */
function hostOf(loaded: ProjectConfig) {
  return createPluginHost({
    config: loaded,
    env: ENV,
    projectDir: PROJECT_DIR,
    coreVersion: VERSION,
    importModule: (specifier) =>
      specifier === "@facetdb/tracker"
        ? Promise.resolve({ default: tracker })
        : Promise.reject(Object.assign(new Error("no"), { code: "ERR_MODULE_NOT_FOUND" })),
    builtins: {},
  });
}

function run(
  argv: readonly string[],
  options: { readonly config?: ProjectConfig; readonly answers?: readonly string[] } = {},
) {
  const config = options.config ?? project();
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      loadConfig: () => Promise.resolve(config),
      connect: noDatabase,
      pluginHost: hostOf,
      // As the composition root wires it (main.ts, whose own dry-run branch the last case runs):
      // the plugin's scan over the store's queue of the source, no store at all for a dry run.
      backfill: async (loaded, chosen, mode) => {
        modes.push({ ...mode, plugins: mode.plugins !== undefined, note: mode.note !== undefined });
        if (mode.plugins === undefined) {
          throw new Error("a plugin source's backfill needs its plugin host");
        }
        const connector = pluginBackfillConnector({
          config: loaded,
          source: chosen,
          project: projectRef(PROJECT_DIR),
          host: mode.plugins,
          env: ENV,
          clock,
          workerId: "backfill-1",
          store: mode.dryRun ? undefined : store,
          note: mode.note ?? (() => undefined),
        });
        return {
          deps: mode.dryRun
            ? wireBackfillDryRun({
                config: loaded,
                source: chosen,
                project: projectRef(PROJECT_DIR),
                connector,
                clock,
              })
            : await wireBackfill({
                config: loaded,
                source: chosen,
                project: projectRef(PROJECT_DIR),
                store,
                connector,
                provider,
                clock,
                channels: [],
                report: () => undefined,
              }),
          close: () => connector.close(),
        };
      },
      ...(options.answers === undefined ? {} : { answers: options.answers }),
    },
    COMMANDS,
  );
}

async function count(table: "records" | "jobs"): Promise<number> {
  const rows = await world.client.query(`select count(*)::int as n from facetdb.${table}`);
  return Number(rows[0]?.["n"]);
}

describe("facetdb backfill on a plugin source", () => {
  it("--dry-run pages through the plugin's scan, says what it cost, and opens no store", async () => {
    const result = await run(["backfill", "--dry-run"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Backfill of @facetdb/tracker issues (source issues), newest records first:",
    );
    expect(result.stdout).toContain("25 records to answer");
    expect(result.stdout).toContain(
      "Counting them paged once through the plugin's scan, one call to the plugin per page.",
    );
    expect(result.stdout).toContain(
      "The estimate counts every record the plugin's scan returns: a dry run does not open FacetDB's store, so it cannot see a saved resume point or records already answered.",
    );
    expect(result.stdout).toContain("Dry run: nothing was asked and nothing was changed.");
    expect(modes).toEqual([{ dryRun: true, plugins: true, note: true }]);
    expect(provider.callCount).toBe(0);
    expect(await count("records")).toBe(0);
  });

  it("--yes takes every record in, newest first, queues it for the worker and registers the source as the worker does", async () => {
    const result = await run(["backfill", "--source", "issues", "--yes"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Counting them paged once through the plugin's scan from the saved place, one call to the plugin per page, and stored and queued nothing. The run pages through it again, each page once, and takes each record into FacetDB's store as it queues it.",
    );
    // A plugin's cursor is its own text: the resume point is said, never printed.
    expect(result.stdout).toContain("10 records done. Resume point saved.\n");
    expect(result.stdout).toContain("25 records done. That was the last page.");
    expect(result.stdout).toContain(
      "Done: 25 records queued for the worker, 0 already answered. Run facetdb worker to answer the queue.",
    );
    expect(provider.callCount).toBe(0);
    expect(await count("records")).toBe(25);
    expect(await count("jobs")).toBe(25);
    const registered = await world.client.query("select kind from facetdb.sources where id = $1", [
      ID,
    ]);
    expect(registered).toEqual([{ kind: "plugin-source" }]);

    // Run again before the worker answered: the same records, queued once each.
    const again = await run(["backfill", "--yes", "--json"]);
    expect(again.code, again.stderr).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ ok: true, status: "completed", queued: 25 });
    expect(await count("jobs")).toBe(25);
  });

  it("says a row the store does not take, and goes on with the others", async () => {
    issues.set(26, { title: "No body" });

    const result = await run(["backfill", "--yes"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "the plugin @facetdb/tracker (source issues of issues) returned the record acme/web#26 from scan in a shape the store does not take (its state lacks the field body, which the source reads (a field with no value is null)), so it is left out of the backfill",
    );
    expect(result.stdout).toContain("25 records to answer");
    expect(await count("records")).toBe(25);
  });

  it("says a plugin's failure in FacetDB's words, with where the next run resumes", async () => {
    failing = true;

    const result = await run(["backfill", "--yes"]);

    expect(result.code).toBe(EXIT_SETUP);
    expect(result.stderr).toContain(
      "the plugin @facetdb/tracker (source issues of issues) failed in scan (its own words are not shown, as they could quote a secret it was handed), so the backfill stopped; the pages queued before it are saved",
    );
    expect(result.stderr).toContain("run facetdb backfill again: it resumes from the saved place");
    expect(`${result.stdout}${result.stderr}`).not.toContain("trk_s3cret");
    expect(await count("jobs")).toBe(0);
  });

  it("asks which source beside a table, and refuses settings the plugin's schema refuses", async () => {
    const table = {
      name: "listings",
      database: "postgres://facetdb_worker:pw@localhost:5432/app",
      table: "listings",
      read: ["title"],
      questions: { is_scam: noul("Is this a scam?") },
    };
    const both = await run(["backfill", "--dry-run"], { config: project([table, ISSUES]) });
    expect(both.code).toBe(EXIT_USAGE);
    expect(both.stderr).toContain(
      "the config has 2 sources a backfill can page through (a table, or a plugin's scan), and this command works on one",
    );
    expect(both.stderr).toContain("pass --source with one of: listings, issues");

    const refused = await run(["backfill", "--dry-run"], {
      config: project([
        { ...ISSUES, source: sourceCall("@facetdb/tracker", "issues", { repo: "a" }) },
      ]),
    });
    expect(refused.code).not.toBe(0);
    expect(refused.stderr).toContain("sources[0].source.settings.repo:");
    expect(modes).toEqual([]);
  });

  it("main.ts's own door: a dry run pages through the plugin's scan over no store, and none runs without its plugin host", async () => {
    const config = project();
    const [issues] = config.sources;
    if (issues === undefined) {
      throw new Error("the test config has a source");
    }
    const door = processDeps().backfill;
    const notes: string[] = [];
    const setup = await door(config, issues, {
      dryRun: true,
      plugins: await hostOf(config),
      note: (line) => notes.push(line),
    });
    try {
      const report = await createBackfill(setup.deps).run({ onEstimate: () => false });
      expect(report).toMatchObject({ status: "declined", estimate: { records: 25 } });
      // The dry run's wiring, over a store that is never opened: nothing can be saved or queued.
      expect(() => setup.deps.cursorStore.save("run", { cursor: null, done: true })).toThrow(
        "a dry run never saves a place",
      );
      await expect(setup.deps.connector.enqueue(["acme/web#1"])).rejects.toThrow(
        "a dry run never reads the store",
      );
    } finally {
      await setup.close();
    }
    expect(notes).toEqual([]);
    await expect(door(config, issues, { dryRun: true })).rejects.toThrow(
      "a plugin source's backfill needs its plugin host",
    );
  });
});
