import { FakeClock } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { createPostgresEngine } from "@facetdb/postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigFiles,
  configFileSource,
  facetdb,
  judgeDraftSource,
  noul,
  type ProjectConfig,
} from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { sharePools } from "../pools.ts";
import { runInProcess } from "../program.ts";
import { storeSourceId } from "../store-door.ts";
import {
  createPgliteWorld,
  createStore,
  migrate,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * Apply through `facetdb worker`'s own wiring: the studio's POST /v1/apply on the served surface
 * shows the diff, writes facetdb.config.ts on confirm through the config file's door, and the
 * worker reloads it, recording the new question-set version through the store's version path and
 * opening the table again through its engine; GET /v1/config then reads the write. The table is
 * installed on PGlite as `facetdb migrate` would; the file and git are the test's own.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  LISTINGS_URL: WORKER_URL,
  TYPESAFE_API_KEY: "ts-test-key",
};

/** As the loader reads `database: process.env.LISTINGS_URL`. */
const declared = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: WORKER_URL,
      table: "listings",
      read: ["id", "title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});
const INITIAL: ProjectConfig = {
  ...declared,
  sources: declared.sources.map((source) => ({ ...source, databaseEnv: "LISTINGS_URL" })),
};

const DRAFT = {
  name: "listings",
  questions: {
    is_scam: { type: "noul", instructions: "Is this listing a scam or a fake?", stakes: "low" },
  },
};

let world: PgliteWorld;
let store: Store;
let provider: FakeProvider;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new FakeClock(0) });
  provider = createFakeProvider({ defaults: { noul: 0.01 } });
  await world.client.query("create table public.listings (id text primary key, title text)");
  const [source] = INITIAL.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  const installed = await migrate({
    adminUrl: "pglite://admin",
    connect: world.connect,
    print: () => undefined,
    plan: {
      source: { table: "listings", schema: "public", onChange: "reset", storage: "inline" },
      questionSet: questionSetOf(INITIAL, source),
      project: projectRef(PROJECT_DIR),
      workerPassword: "worker-password",
    },
  });
  if (!installed.ok) {
    throw new Error(installed.reason);
  }
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

describe("Apply on a running facetdb worker", () => {
  it("shows the diff, writes on confirm, records one new version, asks nothing, and GET /v1/config reads the write", async () => {
    const judged = judgeDraftSource(INITIAL, DRAFT, ENV);
    if (!judged.ok) {
      throw new Error("the draft is valid");
    }
    const written = judged.config;
    // The file and what the loader makes of it: the exporter's text names its config.
    const file = { text: configFileSource(INITIAL), writes: 0 };
    const configs = [INITIAL, written];
    const files: ConfigFiles = {
      read: () => Promise.resolve({ kind: "file", text: file.text }),
      replace: (_path, text) => {
        file.text = text;
        file.writes += 1;
        return Promise.resolve();
      },
      gitState: () => Promise.resolve({ kind: "clean" }),
    };
    const loadConfig = () => {
      const found = configs.find((config) => configFileSource(config) === file.text);
      return found === undefined
        ? Promise.reject(new Error("the test's file holds no known config"))
        : Promise.resolve(found);
    };

    const stop = new AbortController();
    const answers: Record<string, unknown> = {};
    const connect = sharePools(world.connect);
    const clock = new FakeClock(1_700_000_000_000);
    const result = await runInProcess(
      ["worker"],
      {
        projectDir: PROJECT_DIR,
        env: ENV,
        osUser: () => "alex",
        loadConfig,
        configFiles: files,
        engines: postgresEngines(connect),
        connect,
        store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
        provider: () => provider,
        clock,
        random: () => 0.5,
        stopSignal: () => stop.signal,
        webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
        serve: async (handler, port) => {
          const post = async (body: unknown, headers: Record<string, string> = {}) => {
            const response = await handler(
              new Request("http://127.0.0.1:4040/v1/apply", {
                method: "POST",
                headers: { "content-type": "application/json", ...headers },
                body: JSON.stringify(body),
              }),
              THIS_MACHINE,
            );
            return {
              status: response.status,
              body: (await response.json()) as Record<string, unknown>,
            };
          };
          answers["crossSite"] = await post(
            { source: DRAFT },
            { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
          );
          const dry = await post({ source: DRAFT });
          answers["dry"] = dry;
          answers["writesAfterDry"] = file.writes;
          answers["confirmed"] = await post({ source: DRAFT, confirm: dry.body["plan"] });
          const config = await handler(
            new Request("http://127.0.0.1:4040/v1/config"),
            THIS_MACHINE,
          );
          answers["config"] = await config.json();
          stop.abort();
          return { port, close: () => Promise.resolve() };
        },
      },
      COMMANDS,
    );

    expect(result.code, result.stderr).toBe(0);
    // A page on another site is no one on this machine, so it never reaches Apply.
    expect(answers["crossSite"]).toMatchObject({
      status: 401,
      body: { error: { code: "sign-in" } },
    });
    expect(answers["dry"]).toMatchObject({
      status: 200,
      body: {
        written: false,
        path: "facetdb.config.ts",
        changed: true,
        uncommitted: null,
        diff: expect.stringContaining(
          '-        "is_scam": noul("Is this listing a scam?"),\n+        "is_scam": noul("Is this listing a scam or a fake?"),',
        ),
      },
    });
    // Nothing was written by the dry run; one write on confirm, of the exporter's text.
    expect(answers["writesAfterDry"]).toBe(0);
    expect(file.writes).toBe(1);
    expect(file.text).toBe(configFileSource(written));
    expect(answers["confirmed"]).toMatchObject({
      status: 200,
      body: {
        written: true,
        reload: {
          loaded: true,
          sources: [{ source: "listings", outcome: "restarted", version: 2 }],
          notes: [],
        },
      },
    });
    expect(answers["config"]).toMatchObject({
      sources: [
        {
          name: "listings",
          database: { env: "LISTINGS_URL" },
          questions: { is_scam: { instructions: "Is this listing a scam or a fake?" } },
        },
      ],
      // The version history from the store: the write made version 2, now in force.
      versions: {
        listings: {
          inForce: 2,
          earlier: false,
          versions: [
            { version: 2, changes: "The wording of is_scam" },
            { version: 1, changes: "Created, with is_scam" },
          ],
        },
      },
    });
    // One new version row, through the store's version path; the model was never asked.
    const sourceId = storeSourceId(projectRef(PROJECT_DIR).id, "listings");
    expect((await store.questionSets.latest(sourceId))?.version).toBe(2);
    expect(provider.callCount).toBe(0);
    expect(result.stdout).toContain(
      "listings: the question set changed: it finishes the batch in hand, then answers with version 2; nothing already answered is asked again.",
    );
  });

  it("writes Settings' spending cap into the file on confirm, and the worker enforces it at once: Home shows the new cap, with no restart note", async () => {
    const started: ProjectConfig = { ...INITIAL, spendingCap: 1_000_000 };
    const written: ProjectConfig = { ...started, spendingCap: 3_000_000, onCapReached: "continue" };
    const file = { text: configFileSource(started), writes: 0 };
    const configs = [started, written];
    const files: ConfigFiles = {
      read: () => Promise.resolve({ kind: "file", text: file.text }),
      replace: (_path, text) => {
        file.text = text;
        file.writes += 1;
        return Promise.resolve();
      },
      gitState: () => Promise.resolve({ kind: "clean" }),
    };
    const loadConfig = () => {
      const found = configs.find((config) => configFileSource(config) === file.text);
      return found === undefined
        ? Promise.reject(new Error("the test's file holds no known config"))
        : Promise.resolve(found);
    };
    const project = { spendingCap: 3_000_000, onCapReached: "continue" };

    const stop = new AbortController();
    const answers: Record<string, unknown> = {};
    const connect = sharePools(world.connect);
    const result = await runInProcess(
      ["worker"],
      {
        projectDir: PROJECT_DIR,
        env: ENV,
        osUser: () => "alex",
        loadConfig,
        configFiles: files,
        engines: postgresEngines(connect),
        connect,
        store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
        provider: () => provider,
        clock: new FakeClock(1_700_000_000_000),
        random: () => 0.5,
        stopSignal: () => stop.signal,
        webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
        serve: async (handler, port) => {
          const ask = async (path: string, body?: unknown) => {
            const response = await handler(
              new Request(
                `http://127.0.0.1:4040${path}`,
                body === undefined
                  ? {}
                  : {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify(body),
                    },
              ),
              THIS_MACHINE,
            );
            return {
              status: response.status,
              body: (await response.json()) as Record<string, unknown>,
            };
          };
          const dry = await ask("/v1/apply", { project });
          answers["dry"] = dry;
          answers["writesAfterDry"] = file.writes;
          answers["confirmed"] = await ask("/v1/apply", { project, confirm: dry.body["plan"] });
          answers["home"] = (await ask("/v1/home")).body;
          answers["config"] = (await ask("/v1/config")).body;
          stop.abort();
          return { port, close: () => Promise.resolve() };
        },
      },
      COMMANDS,
    );

    expect(result.code, result.stderr).toBe(0);
    expect(answers["dry"]).toMatchObject({
      status: 200,
      body: {
        written: false,
        changed: true,
        warnings: [],
        diff: expect.stringContaining(
          '-  spendingCap: 1000000,\n+  spendingCap: 3000000,\n+  onCapReached: "continue",',
        ),
      },
    });
    expect(answers["writesAfterDry"]).toBe(0);
    expect(file.writes).toBe(1);
    expect(file.text).toBe(configFileSource(written));
    expect(answers["confirmed"]).toMatchObject({
      status: 200,
      body: {
        written: true,
        reload: {
          loaded: true,
          sources: [{ source: "listings", outcome: "unchanged" }],
          notes: [],
        },
      },
    });
    // Home reads the cap in force, which the reload replaced.
    expect(answers["home"]).toMatchObject({
      spending: { cap: { inputTokens: 3_000_000, onCapReached: "continue" } },
    });
    expect(answers["config"]).toMatchObject({ spendingCap: 3_000_000, onCapReached: "continue" });
    expect(provider.callCount).toBe(0);
  });

  it("writes the set in force at its start, again on a threshold-only Apply, and keeps it when the new loop does not open", async () => {
    // Two threshold changes: neither makes a new version (the content hash does not see them), and
    // only the set in force (store migration 8) says which one the worker runs.
    const judge = (yesAbove: number) => {
      const judged = judgeDraftSource(
        INITIAL,
        { name: "listings", thresholds: { is_scam: { yesAbove } } },
        ENV,
      );
      if (!judged.ok) {
        throw new Error("the draft is valid");
      }
      return judged.config;
    };
    const stricter = judge(0.9);
    const strictest = judge(0.95);
    const file = { text: configFileSource(INITIAL) };
    const configs = [INITIAL, stricter, strictest];
    const files: ConfigFiles = {
      read: () => Promise.resolve({ kind: "file", text: file.text }),
      replace: (_path, text) => {
        file.text = text;
        return Promise.resolve();
      },
      gitState: () => Promise.resolve({ kind: "clean" }),
    };
    const loadConfig = () => {
      const found = configs.find((config) => configFileSource(config) === file.text);
      return found === undefined
        ? Promise.reject(new Error("the test's file holds no known config"))
        : Promise.resolve(found);
    };
    // The table's key type is the open's last read before the set in force: failing it fails the
    // open after the version is recorded, where the row was written before.
    const keyText = { fail: false };
    const connect = sharePools(world.connect);
    const engine = createPostgresEngine({ connect, pgHost: undefined });
    const engines = [
      lazyEngine("postgres", () =>
        Promise.resolve({
          ...engine,
          keyTextOf: () =>
            keyText.fail
              ? Promise.reject(new Error("the key type could not be read"))
              : Promise.resolve({
                  toText: (key: string) => key,
                  fromText: (text: string) => text,
                  form: "the key as stored",
                }),
        }),
      ),
    ];
    const [source] = INITIAL.sources;
    if (source === undefined) {
      throw new Error("the test config has a source");
    }
    const sourceId = storeSourceId(projectRef(PROJECT_DIR).id, "listings");
    const stop = new AbortController();
    const seen: Record<string, unknown> = {};
    const result = await runInProcess(
      ["worker"],
      {
        projectDir: PROJECT_DIR,
        env: ENV,
        osUser: () => "alex",
        loadConfig,
        configFiles: files,
        engines,
        connect,
        store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
        provider: () => provider,
        clock: new FakeClock(1_700_000_000_000),
        random: () => 0.5,
        stopSignal: () => stop.signal,
        webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
        serve: async (handler, port) => {
          const apply = async (config: ProjectConfig) => {
            const draft = { name: "listings", thresholds: config.sources[0]?.thresholds };
            const post = async (body: unknown) => {
              const response = await handler(
                new Request("http://127.0.0.1:4040/v1/apply", {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(body),
                }),
                THIS_MACHINE,
              );
              return (await response.json()) as Record<string, unknown>;
            };
            const dry = await post({ source: draft });
            return post({ source: draft, confirm: dry["plan"] });
          };
          seen["started"] = await store.questionSets.inForce(sourceId);
          seen["stricter"] = await apply(stricter);
          seen["afterStricter"] = await store.questionSets.inForce(sourceId);
          keyText.fail = true;
          seen["strictest"] = await apply(strictest);
          seen["afterStrictest"] = await store.questionSets.inForce(sourceId);
          stop.abort();
          return { port, close: () => Promise.resolve() };
        },
      },
      COMMANDS,
    );

    expect(result.code, result.stderr).toBe(0);
    // The start writes the set it runs.
    expect(seen["started"]).toMatchObject({
      version: 1,
      questionSet: questionSetOf(INITIAL, source),
    });
    // A threshold-only Apply restarts the loop under the same version, and the row follows it.
    expect(seen["stricter"]).toMatchObject({
      written: true,
      reload: { sources: [{ source: "listings", outcome: "restarted", version: 1 }] },
    });
    expect(seen["afterStricter"]).toMatchObject({
      version: 1,
      questionSet: { thresholds: { is_scam: { yesAbove: 0.9 } } },
    });
    expect(seen["afterStricter"]).toMatchObject({ questionSet: questionSetOf(stricter, source) });
    // The next Apply's loop fails to open after its version was recorded: the old loop runs on,
    // and the row still says what it runs, so facetdb review judges by that set and not the file.
    expect(seen["strictest"]).toMatchObject({
      written: true,
      reload: { sources: [{ source: "listings", outcome: "failed", version: 1 }] },
    });
    expect(seen["afterStrictest"]).toEqual(seen["afterStricter"]);
    expect(provider.callCount).toBe(0);
  });
});
