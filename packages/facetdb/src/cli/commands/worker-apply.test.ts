import { FakeClock } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigFiles,
  configFileSource,
  facetdb,
  judgeDraftSource,
  noul,
  type ProjectConfig,
} from "../../config/index.ts";
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
});
