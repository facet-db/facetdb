import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ChannelMessage, DEFAULT_WORKER_LIMITS } from "@facetdb/core";
import { createFakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AlertChannel,
  actionCall,
  type ConfigFiles,
  configFileSource,
  env,
  facetdb,
  loadConfig,
  noul,
  type ProjectConfig,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  action,
  BUILTIN_PLUGINS,
  channel,
  createPluginHost,
  definePlugin,
  type Plugin,
  z,
} from "../../plugin/index.ts";
import { sharePools } from "../pools.ts";
import { type HttpHandler, runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  migrate,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type SqlClient,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * The running worker takes a change to its alert channels and to a plugin's settings with no
 * restart, through `facetdb worker`'s own wiring, the Postgres engine on PGlite and a fixture
 * plugin with a channel and an action: a channel added from a studio draft (Apply, the diff first)
 * is sent the next alert; a changed plugin setting restarts the sources that use the plugin and no
 * other, and its action runs with the new setting; a file whose channels or settings cannot be put
 * in force leaves the ones in force as they were, and the reload says why. The file is on disk and
 * the worker reloads it through the real loader.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const START = 1_700_000_000_000;
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const PAGER_TOKEN = "pgr_7e6d5c4b3a2910-PAGERSECRETVALUE";
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
  LISTINGS_URL: WORKER_URL,
  PAGER_TOKEN,
};
const FORBIDDEN = [PAGER_TOKEN, "PAGERSECRET", "worker-password"];

let heard: { readonly where: string; readonly message: ChannelMessage }[];
/** The region each run of the pager's action was handed in its plugin's settings. */
let paged: string[];

const pager: Plugin = definePlugin({
  name: "pager",
  version: "1.0.0",
  facetdb: "*",
  // The region moves no credential and no data: the plugin marks it as the studio's to change.
  config: z.object({ token: z.secret(), region: z.editable(z.enum(["eu", "us"])) }),
  channels: {
    pager: channel({
      config: z.object({ where: z.string().min(1) }),
      deliver: async (_ctx, message, settings: { where: string }) => {
        heard.push({ where: settings.where, message });
      },
    }),
  },
  actions: {
    page: action({
      config: z.object({}),
      run: async (ctx) => {
        paged.push((ctx.config as { readonly region: string }).region);
      },
    }),
  },
});

const QUESTIONS = { is_scam: noul("Is this listing a scam?") };

/** The file's config: a table source that pages, and an API source that uses no plugin. */
function configWith(options: {
  readonly channels?: readonly AlertChannel[];
  readonly region?: string;
  readonly cap?: number;
}): ProjectConfig {
  const declared = facetdb({
    model: "jev-1.14.0",
    ...(options.cap === undefined ? {} : { spendingCap: options.cap }),
    ...(options.channels === undefined ? {} : { alerts: { channels: options.channels } }),
    plugins: { pager: { token: env("PAGER_TOKEN"), region: options.region ?? "eu" } },
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: ["id", "title"],
        questions: QUESTIONS,
        actions: [actionCall("facetdb-plugin-pager", "page")],
      },
      { name: "tickets", api: true, read: ["body"], questions: QUESTIONS },
    ],
  });
  return {
    ...declared,
    sources: declared.sources.map((source) =>
      source.api ? source : { ...source, databaseEnv: "LISTINGS_URL" },
    ),
  };
}

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let served: HttpHandler[];
let scratch: string;
let projectDir: string;
let configPath: string;
/** Every answer the surface gave: none may hold a secret. */
let texts: string[];

beforeAll(async () => {
  world = await createPgliteWorld();
  scratch = await mkdtemp(join(tmpdir(), "facetdb-reload-channels-"));
  projectDir = join(scratch, "listings-app");
  await mkdir(join(projectDir, "node_modules"), { recursive: true });
  await symlink(PACKAGE_DIR, join(projectDir, "node_modules", "facetdb"));
  configPath = join(projectDir, "facetdb.config.ts");
});

afterAll(async () => {
  await world.close();
  await rm(scratch, { recursive: true, force: true });
});

beforeEach(async () => {
  heard = [];
  paged = [];
  served = [];
  texts = [];
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  await world.client.query("create table public.listings (id text primary key, title text)");
  const config = configWith({});
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  const installed = await migrate({
    adminUrl: "pglite://admin",
    connect: world.connect,
    print: () => undefined,
    plan: {
      source: { table: "listings", schema: "public", onChange: "reset", storage: "inline" },
      questionSet: questionSetOf(config, source),
      project: projectRef(projectDir),
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

/** PGlite's one connection is a superuser's: the doctor asking who it is is told the worker login. */
function asWorkerLogin(client: SqlClient): SqlClient {
  return {
    ...client,
    query: (text, params) =>
      /^\s*select current_user::text as name\s*$/.test(text)
        ? Promise.resolve([{ name: "facetdb_worker" }])
        : client.query(text, params),
  };
}

/** The file on disk: Apply reads and replaces it there, and the worker's reload loads it. */
const files: ConfigFiles = {
  read: async () => ({ kind: "file", text: await readFile(configPath, "utf8") }),
  replace: async (_path, text) => {
    await writeFile(configPath, text);
  },
  gitState: () => Promise.resolve({ kind: "clean" }),
};

/** `facetdb worker` on the file as it is on disk, until `stop` aborts. */
async function runWorker(file: ProjectConfig, stop: AbortSignal) {
  await writeFile(configPath, configFileSource(file));
  const connect = sharePools((url, options) => asWorkerLogin(world.connect(url, options)));
  return runInProcess(
    ["worker"],
    {
      projectDir,
      env: ENV,
      setEnv: () => undefined,
      osUser: () => "alex",
      loadConfig: async (path, options) =>
        (
          await loadConfig(path, {
            projectDir,
            env: ENV,
            stderr: { write: () => true },
            ...(options?.quiet === undefined ? {} : { quiet: options.quiet }),
          })
        ).config,
      configFiles: files,
      engines: postgresEngines(connect),
      connect,
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      abortAfter: () => new AbortController().signal,
      stopSignal: () => stop,
      pluginHost: (loaded) =>
        createPluginHost({
          config: loaded,
          env: ENV,
          projectDir,
          coreVersion: VERSION,
          importModule: (specifier) =>
            specifier === "facetdb-plugin-pager"
              ? Promise.resolve({ default: pager })
              : Promise.reject(
                  Object.assign(new Error(`Cannot find package '${specifier}'`), {
                    code: "ERR_MODULE_NOT_FOUND",
                  }),
                ),
          builtins: BUILTIN_PLUGINS,
        }),
      serve: (handler, port) => {
        served.push(handler);
        return Promise.resolve({ port, close: () => Promise.resolve() });
      },
    },
    COMMANDS,
  );
}

/** A request to the surface the worker served, from this machine; a body makes it a POST. */
async function ask(path: string, body?: unknown) {
  const [handler] = served;
  if (handler === undefined) {
    throw new Error("the worker serves no surface yet");
  }
  const response = await handler(
    new Request(`http://127.0.0.1:4040/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    THIS_MACHINE,
  );
  const text = await response.text();
  texts.push(text);
  return { status: response.status, json: JSON.parse(text) as Record<string, unknown> };
}

/** Apply as the studio sends it: the diff first, then the plan it answered with. */
async function applied(project: Record<string, unknown>) {
  const shown = await ask("apply", { project });
  expect(shown).toMatchObject({ status: 200, json: { written: false, changed: true } });
  const confirmed = await ask("apply", { project, confirm: shown.json["plan"] });
  expect(confirmed).toMatchObject({ status: 200, json: { written: true } });
  return { diff: String(shown.json["diff"]), reload: confirmed.json["reload"] };
}

/** The addresses of the channels in force, and whether the file names others. */
async function channelsInForce() {
  const { json } = await ask("alerts");
  const channels = json["channels"] as readonly { readonly address: string }[];
  return {
    addresses: channels.map((channel) => channel.address),
    differ: json["fileChannelsDiffer"],
  };
}

const heardBy = (where: string) =>
  heard.filter((entry) => entry.where === where).map((entry) => entry.message.severity);

async function answered(id: string) {
  await world.client.query("insert into public.listings (id, title) values ($1, 'A red car')", [
    id,
  ]);
}

function printsNoSecret(...more: readonly string[]) {
  for (const text of [...texts, ...more]) {
    for (const fragment of FORBIDDEN) {
      expect(text).not.toContain(fragment);
    }
  }
}

describe("a reload puts the file's channels and plugin settings in force with no restart", () => {
  it("@timing sends the next alert to a channel a studio draft added, and the Alerts page lists it", async () => {
    const stop = new AbortController();
    const running = runWorker(configWith({ channels: ["pager:ops"], cap: 1 }), stop.signal);
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });
    expect(await ask("alerts/test", { channel: "pager:data" })).toMatchObject({ status: 404 });

    const channels = ["pager:ops", { to: "pager:data", sends: "critical" }];
    const { diff, reload } = await applied({ alerts: { channels } });
    expect(diff).toContain(`+  alerts: ${JSON.stringify({ channels })},`);
    expect(reload).toMatchObject({
      loaded: true,
      sources: [
        { source: "listings", outcome: "unchanged" },
        { source: "tickets", outcome: "unchanged" },
      ],
      notes: [
        "The alert channels facetdb.config.ts names are in force now, with no restart: each alert from now on goes to the 2 channels it names.",
      ],
    });
    // Settings no longer says the file differs: the channels in force are the file's.
    expect(await channelsInForce()).toEqual({
      addresses: ["pager:ops", "pager:data"],
      differ: false,
    });

    // The first answer passes the cap of one token: a warning at 80%, and the critical pause.
    await answered("r1");
    await vi.waitFor(
      () => {
        clock.advance(DEFAULT_WORKER_LIMITS.pollIntervalMs);
        expect(heardBy("data")).toEqual(["critical"]);
        expect(heardBy("ops").sort()).toEqual(["critical", "warning"]);
      },
      { timeout: 10_000 },
    );
    expect(await ask("alerts/test", { channel: "pager:data" })).toMatchObject({
      status: 200,
      json: { sent: true },
    });

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("The alert channels facetdb.config.ts names are in force now");
    printsNoSecret(result.stdout, result.stderr);
  });

  it("@timing restarts only the sources that use a plugin whose settings a draft changed, and runs its action with them", async () => {
    const stop = new AbortController();
    const running = runWorker(configWith({ region: "eu" }), stop.signal);
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });
    await answered("r1");
    await vi.waitFor(
      () => {
        clock.advance(2_000);
        expect(paged).toEqual(["eu"]);
      },
      { timeout: 10_000 },
    );

    const { diff, reload } = await applied({
      plugins: { pager: { token: env("PAGER_TOKEN"), region: "us" } },
    });
    expect(diff).toContain('+    "pager": { "token": env("PAGER_TOKEN"), "region": "us" },');
    expect(reload).toMatchObject({
      loaded: true,
      sources: [
        {
          source: "listings",
          outcome: "restarted",
          message: expect.stringContaining(
            "the settings of the plugin facetdb-plugin-pager it uses changed: it finishes the batch in hand",
          ) as string,
        },
        { source: "tickets", outcome: "unchanged" },
      ],
      notes: [
        "The settings of the plugin facetdb-plugin-pager in facetdb.config.ts are in force now, with no restart: each action and notification run from now on is handed them, and each source that uses it finishes the batch in hand with the settings it began with, then restarts on them.",
      ],
    });

    await answered("r2");
    await vi.waitFor(
      () => {
        clock.advance(2_000);
        expect(paged).toEqual(["eu", "us"]);
      },
      { timeout: 10_000 },
    );
    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    printsNoSecret(result.stdout, result.stderr);
  });

  it("keeps the channels and settings in force when the file's cannot be bound, says why, and refuses such a draft before any diff", async () => {
    const stop = new AbortController();
    const running = runWorker(configWith({ channels: ["pager:ops"] }), stop.signal);
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });

    // By hand: a channel whose plugin this worker never loaded, beside a reworded question. Nothing
    // of the file is put in force: the worker runs on the config it had, as for a file that does
    // not load, so its actions, webhooks and the studio read that config beside its plugins.
    const reworded = configWith({ channels: ["pager:ops", "slack:#ops"] });
    await writeFile(
      configPath,
      configFileSource({
        ...reworded,
        sources: reworded.sources.map((source) => ({
          ...source,
          questions: source.questions.map((question) => ({
            ...question,
            instructions: "Is this listing a scam or a fake?",
          })),
        })),
      }),
    );
    const unbound = await ask("reload", {});
    expect(unbound).toMatchObject({
      status: 200,
      json: {
        loaded: false,
        message:
          'facetdb.config.ts loads, but the alert channels it names cannot be put in force: alerts.channels[1] (slack:#ops) names the channel "slack", and no plugin of that name was loaded when this worker started, so the worker keeps running on the config it had.',
        fix: "Restart facetdb worker to load it (if it is not installed, run facetdb add slack in the project first), or take slack:#ops out of alerts.channels; then apply again, or Check again.",
      },
    });
    expect(await channelsInForce()).toEqual({ addresses: ["pager:ops"], differ: false });
    const inForce = await ask("config");
    expect(inForce.json["alerts"]).toEqual({ channels: ["pager:ops"] });
    expect(JSON.stringify(inForce.json)).not.toContain("or a fake");

    // By hand: a channel that binds, beside settings the plugin's schema refuses: both are kept.
    await writeFile(
      configPath,
      configFileSource(configWith({ channels: ["pager:ops", "pager:data"], region: "mars" })),
    );
    const refused = await ask("reload", {});
    expect(refused.json).toMatchObject({ loaded: false });
    expect(String(refused.json["message"])).toMatch(
      /^facetdb\.config\.ts loads, but the alert channels and plugin settings it names cannot be put in force: the settings of the plugin "facetdb-plugin-pager" are refused by its schema/,
    );
    expect(await channelsInForce()).toEqual({ addresses: ["pager:ops"], differ: false });
    // The channel in force still delivers.
    expect(await ask("alerts/test", { channel: "pager:ops" })).toMatchObject({
      status: 200,
      json: { sent: true },
    });

    // From the studio, the same channel is the loader's refusal before any diff: nothing written.
    const file = configFileSource(configWith({ channels: ["pager:ops"] }));
    await writeFile(configPath, file);
    expect(await ask("reload", {})).toMatchObject({ status: 200, json: { notes: [] } });
    const draft = await ask("apply", {
      project: { alerts: { channels: ["pager:ops", "slack:#ops"] } },
    });
    expect(draft).toMatchObject({ status: 400, json: { error: { code: "invalid_draft" } } });
    expect(JSON.stringify(draft.json)).toContain(
      'alerts.channels[1] (slack:#ops) names the channel \\"slack\\", and no plugin of that name was loaded when this worker started',
    );
    expect(await readFile(configPath, "utf8")).toBe(file);

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    printsNoSecret(result.stdout, result.stderr);
  });
});
