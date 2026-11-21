import type { ChannelMessage } from "@facetdb/core";
import { createFakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AlertChannel, env, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  channel,
  createPluginHost,
  definePlugin,
  deliveryFailedWords,
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
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "../testing.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb worker` delivers its system alerts to the channels `alerts.channels` names, the Postgres
 * engine on PGlite and fixture channel plugins: each alert goes to the channels whose `sends` takes
 * its severity, a channel that fails is a printed line and a line of the alert's history in fixed
 * words, never a stopped pass, and `GET /v1/alerts` answers each channel with what it sends and its
 * newest delivery, with nothing of a plugin's settings. A channel that cannot be bound stops the
 * worker, studio, dev and doctor at load, in words that never quote a secret.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const START = 1_700_000_000_000;
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const PAGER_TOKEN = "pgr_7e6d5c4b3a2910-PAGERSECRETVALUE";
const PAGER_URL = "https://events.pager.example/v2/enqueue/s3cretRoutingKeyValue";
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
  PAGER_TOKEN,
  PAGER_URL,
};
const FORBIDDEN = [PAGER_TOKEN, PAGER_URL.slice("https://".length), "s3cret", "PAGERSECRET"];

let heard: { readonly where: string; readonly message: ChannelMessage }[];

const pager: Plugin = definePlugin({
  name: "pager",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret(), url: z.secret() }),
  channels: {
    pager: channel({
      config: z.object({ where: z.string().min(1) }),
      check: (ctx, settings: { where: string }) =>
        settings.where === "refuse"
          ? `the service at ${ctx.secrets["url"]} has no such route`
          : undefined,
      deliver: async (ctx, message, settings: { where: string }) => {
        heard.push({ where: settings.where, message });
        if (settings.where === "broken") {
          throw Object.assign(new Error(`POST ${PAGER_URL} with ${ctx.secrets["token"]}: 403`), {
            cause: new Error(PAGER_TOKEN),
            token: PAGER_TOKEN,
          });
        }
      },
    }),
  },
});

const PAGER_SETTINGS = { pager: { token: env("PAGER_TOKEN"), url: env("PAGER_URL") } };

/** The config as the loader reads the file, with a cap of one token so the first answer alerts. */
function configWith(channels: readonly AlertChannel[] | undefined): ProjectConfig {
  const declared = facetdb({
    model: "jev-1.14.0",
    spendingCap: 1,
    plugins: PAGER_SETTINGS,
    ...(channels === undefined ? {} : { alerts: { channels } }),
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
  return {
    ...declared,
    sources: declared.sources.map((source) => ({ ...source, databaseEnv: "LISTINGS_URL" })),
  };
}

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let served: HttpHandler[];

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  heard = [];
  served = [];
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  await world.client.query("create table public.listings (id text primary key, title text)");
  const config = configWith(undefined);
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
      project: projectRef(PROJECT_DIR),
      workerPassword: "worker-password",
    },
  });
  if (!installed.ok) {
    throw new Error(installed.reason);
  }
  await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(argv: readonly string[], config: ProjectConfig) {
  const connect = sharePools(world.connect);
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      setEnv: () => undefined,
      osUser: () => "alex",
      loadConfig: () => Promise.resolve(config),
      engines: postgresEngines(connect),
      connect,
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      abortAfter: () => new AbortController().signal,
      stopSignal: () => new AbortController().signal,
      pluginHost: (loaded) =>
        createPluginHost({
          config: loaded,
          env: ENV,
          projectDir: PROJECT_DIR,
          coreVersion: VERSION,
          importModule: (specifier) =>
            specifier === "facetdb-plugin-pager"
              ? Promise.resolve({ default: pager })
              : Promise.reject(
                  Object.assign(new Error(`Cannot find package '${specifier}'`), {
                    code: "ERR_MODULE_NOT_FOUND",
                  }),
                ),
          builtins: {},
        }),
      serve: (handler, port) => {
        served.push(handler);
        return Promise.resolve({ port, close: () => Promise.resolve() });
      },
    },
    COMMANDS,
  );
}

function printsNoSecret(...texts: readonly string[]) {
  for (const text of texts) {
    for (const fragment of FORBIDDEN) {
      expect(text).not.toContain(fragment);
    }
  }
}

async function historyText(): Promise<string> {
  const rows = await world.client.query(
    "select record::text as record from facetdb.alert_history order by id",
  );
  return rows.map((row) => String(row["record"])).join("\n");
}

describe("the worker delivers its alerts to the configured channels (channel-host)", () => {
  it("sends each alert to the channels that take its severity, keeps a failure in fixed words, and answers it on GET /v1/alerts", async () => {
    const result = await run(
      ["worker", "--once"],
      configWith([
        { to: "pager:critical-only", sends: "critical" },
        "pager:everything",
        { to: "pager:broken", quiet: { from: "22:00", to: "07:00", zone: "Europe/Berlin" } },
      ]),
    );

    expect(result.code, result.stderr).toBe(0);
    // The cap of one token: the warning at 80% and the critical one at the cap.
    const severities = (where: string) =>
      heard.filter((entry) => entry.where === where).map((entry) => entry.message.severity);
    expect(severities("everything").sort()).toEqual(["critical", "warning"]);
    expect(severities("critical-only")).toEqual(["critical"]);
    expect(severities("broken").sort()).toEqual(["critical", "warning"]);

    // The broken channel: a printed line in fixed words, the pass not stopped, the record answered.
    const words = deliveryFailedWords("facetdb-plugin-pager");
    expect(result.stdout).toContain(`alert channel pager:broken: ${words}.`);
    const answered = await world.client.query("select facetdb_status from public.listings");
    expect(answered[0]?.["facetdb_status"]).toBe("done");

    const history = await historyText();
    expect(history).toContain(`{"ok": false, "error": "${words}", "channel": "pager:broken"}`);
    printsNoSecret(result.stdout, result.stderr, history);

    const [handler] = served;
    const response = await handler?.(new Request("http://127.0.0.1:4040/v1/alerts"), THIS_MACHINE);
    const text = (await response?.text()) ?? "";
    expect(response?.status).toBe(200);
    printsNoSecret(text);
    const body = JSON.parse(text) as {
      channels: {
        address: string;
        sends: string;
        quiet: unknown;
        bound: boolean;
        delivering: boolean;
        last: { ok: boolean; error: string | null; title: string };
      }[];
    };
    expect(
      body.channels.map(({ address, sends, quiet, bound, delivering }) => ({
        address,
        sends,
        quiet,
        bound,
        delivering,
      })),
    ).toEqual([
      {
        address: "pager:critical-only",
        sends: "critical",
        quiet: null,
        bound: true,
        delivering: true,
      },
      {
        address: "pager:everything",
        sends: "everything",
        quiet: null,
        bound: true,
        delivering: true,
      },
      {
        address: "pager:broken",
        sends: "everything",
        quiet: { from: "22:00", to: "07:00", zone: "Europe/Berlin" },
        bound: true,
        delivering: false,
      },
    ]);
    expect(body.channels[2]?.last).toMatchObject({ ok: false, error: words });
  });

  it("refuses to start on a channel its plugin's check refuses, never quoting the secret it named", async () => {
    const result = await run(["worker", "--once", "--no-http"], configWith(["pager:refuse"]));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "error: alerts.channels[0] (pager:refuse) cannot be delivered to: the pager plugin's reason is not shown, as it repeats a value its settings read from the environment",
    );
    printsNoSecret(result.stdout, result.stderr);
    expect(heard).toEqual([]);
    expect(await historyText()).toBe("");
  });

  for (const command of ["studio", "dev"]) {
    it(`facetdb ${command} --dry-run refuses a channel that cannot be bound, as the worker does`, async () => {
      const result = await run([command, "--dry-run"], configWith(["pager:refuse"]));
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("(pager:refuse) cannot be delivered to");
      printsNoSecret(result.stdout, result.stderr);
    });
  }

  it("doctor's config line fails on a channel that cannot be bound, with no secret", async () => {
    const result = await run(["doctor", "--offline", "--json"], configWith(["pager:refuse"]));
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("(pager:refuse) cannot be delivered to");
    printsNoSecret(result.stdout, result.stderr);
  });

  it("with no alerts in the config, records every alert as reached, with no deliveries", async () => {
    const result = await run(["worker", "--once", "--no-http"], configWith(undefined));
    expect(result.code, result.stderr).toBe(0);
    const rows = await world.client.query(
      "select (record->>'delivered')::boolean as delivered, record ? 'deliveries' as listed from facetdb.alert_history",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row["delivered"] === true && row["listed"] === false)).toBe(true);
  });
});
