import type { Clock } from "@facetdb/core";
import { createFakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { env, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import { action, createPluginHost, definePlugin, pack, z } from "../../plugin/index.ts";
import type { HttpHandler } from "../program.ts";
import { runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { COMMANDS } from "./index.ts";

/**
 * The Plugins page's endpoints through `facetdb worker`'s own wiring: the plugin host the config
 * loaded reaches `GET /v1/plugins` and `GET /v1/packs`, and the registry is read through the
 * command's `fetch` at the address `FACETDB_REGISTRY` names. The worker is the one of the studio
 * tests (an API source on PGlite, stopped as it starts); the network is a handwritten fake.
 */

const PROJECT_DIR = "/work/marketplace";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const TOKEN = "ghp_s3cret-github-token";
const REGISTRY = "https://registry.example.com/index.json";

const github = definePlugin({
  name: "github",
  version: "1.2.0",
  facetdb: "*",
  config: z.object({ repo: z.string(), auth: z.object({ token: z.secret() }) }),
  actions: {
    label: action({
      config: z.object({}),
      run: () => Promise.resolve(),
    }),
  },
  packs: { triage: pack({ questions: { is_bug: noul("Does the issue report a bug?") } }) },
});

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  plugins: { github: { repo: "acme/web", auth: { token: env("GITHUB_TOKEN") } } },
  sources: [
    {
      name: "tickets",
      api: true,
      read: ["subject"],
      questions: { urgent: noul("Is this ticket urgent?") },
    },
  ],
});

const clock: Clock = { now: () => 1_700_000_000_000, sleep: () => new Promise(() => undefined) };

const INDEX = JSON.stringify({
  format: 1,
  generatedAt: "2026-11-13T09:00:00.000Z",
  plugins: [
    {
      name: "github",
      package: "@facetdb/github",
      description: "Read GitHub issues.",
      kinds: ["action"],
      facetdb: "*",
      verified: true,
      downloads: 7,
    },
  ],
});

let world: PgliteWorld;
let store: Store;
let served: { readonly handler: HttpHandler }[];
let fetched: string[];

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  served = [];
  fetched = [];
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(environment: Readonly<Record<string, string | undefined>>) {
  const stop = new AbortController();
  stop.abort();
  return runInProcess(
    ["worker"],
    {
      projectDir: PROJECT_DIR,
      env: environment,
      osUser: () => "alex",
      setEnv: () => undefined,
      loadConfig: () => Promise.resolve(config),
      connect: (url, options) => world.connect(url, options),
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      fetch: (url) => {
        fetched.push(url);
        return Promise.resolve(new Response(INDEX));
      },
      abortAfter: () => new AbortController().signal,
      serve: (handler, port) => {
        served.push({ handler });
        return Promise.resolve({ port, close: () => Promise.resolve() });
      },
      stopSignal: () => stop.signal,
      pluginHost: (loaded) =>
        createPluginHost({
          config: loaded,
          env: environment,
          projectDir: PROJECT_DIR,
          coreVersion: VERSION,
          importModule: (specifier) =>
            specifier === "@facetdb/github"
              ? Promise.resolve({ default: github })
              : Promise.reject(
                  Object.assign(new Error(`Cannot find package '${specifier}'`), {
                    code: "ERR_MODULE_NOT_FOUND",
                  }),
                ),
          builtins: {},
        }),
    },
    COMMANDS,
  );
}

async function get(path: string): Promise<{ status: number; text: string; json: unknown }> {
  const [listener] = served;
  if (listener === undefined) {
    throw new Error("the command bound no HTTP surface");
  }
  const response = await listener.handler(
    new Request(`http://127.0.0.1:4040${path}`),
    THIS_MACHINE,
  );
  const text = await response.text();
  return { status: response.status, text, json: JSON.parse(text) as unknown };
}

describe("the Plugins page's endpoints on facetdb worker", () => {
  const environment = {
    FACETDB_SECRET: TEST_SECRET,
    DATABASE_URL: "postgres://localhost:5432/facetdb",
    TYPESAFE_API_KEY: "ts-test-key",
    GITHUB_TOKEN: TOKEN,
    FACETDB_REGISTRY: REGISTRY,
  };

  it("serves the hosted plugin with its variable's name and state, and its pack, and never a value", async () => {
    const result = await run(environment);
    expect(result.code, result.stderr).toBe(0);

    const plugins = await get("/v1/plugins");
    expect(plugins).toMatchObject({
      status: 200,
      json: {
        plugins: [
          {
            name: "github",
            package: "@facetdb/github",
            version: "1.2.0",
            provides: { action: ["label"], pack: ["triage"] },
            settings: {
              values: { repo: "acme/web", auth: { token: { env: "GITHUB_TOKEN" } } },
              variables: [
                { path: "auth.token", variable: "GITHUB_TOKEN", secret: true, set: true },
              ],
            },
          },
        ],
      },
    });
    const packs = await get("/v1/packs");
    expect(packs).toMatchObject({
      status: 200,
      json: { packs: [{ plugin: "github", name: "triage", questions: { is_bug: {} } }] },
    });
    expect(plugins.text).not.toContain(TOKEN);
    expect(packs.text).not.toContain(TOKEN);
  });

  it("reads the registry through the command's fetch at the address FACETDB_REGISTRY names", async () => {
    await run(environment);

    const gallery = await get("/v1/plugins/gallery?q=github");
    expect(gallery).toMatchObject({
      status: 200,
      json: {
        reachable: true,
        address: REGISTRY,
        plugins: [{ name: "github", installed: true, command: "facetdb add github" }],
      },
    });
    expect(fetched).toEqual([REGISTRY]);
  });

  it("falls back to the default registry when FACETDB_REGISTRY is not set", async () => {
    await run({ ...environment, FACETDB_REGISTRY: undefined });

    await get("/v1/plugins/gallery");
    expect(fetched).toEqual(["https://registry.facetdb.dev/index.json"]);
  });
});
