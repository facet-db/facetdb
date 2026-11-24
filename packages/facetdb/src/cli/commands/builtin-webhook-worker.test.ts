import { createFakeProvider } from "@facetdb/model";
import { verify, WEBHOOK_SIGNATURE_HEADER, type WebhookPayload } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type AlertChannel,
  env,
  facetdb,
  noul,
  type ProjectConfig,
  toProjectJson,
  webhook,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  BUILTIN_PLUGINS,
  createPluginHost,
  WEBHOOK_ENDPOINT_GONE,
  type WebhookAlertPayload,
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
 * `facetdb worker` and the built-in webhook, the Postgres engine and the store on PGlite: the
 * worker queues each decision of a source whose `actions` name `webhook({ url })` and each alert of
 * a `webhook:<name>` channel, delivers them from its outbox signed with the secret read from the
 * variable the config names (never a stored credential), and that secret's value reaches no line it
 * prints, no row, no alert history and no answer of the studio's endpoints. A config whose webhook
 * cannot sign is refused before anything opens.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const PROJECT_ID = projectRef(PROJECT_DIR).id;
const START = 1_700_000_000_000;
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const HOOK = "https://hooks.example.com/facetdb";
const OPS = "https://ops.example.com/alerts";
const SECRET = "whsec_0a1b2c3d4e5f6789-WORKERSIGNING";
const ENV = {
  FACETDB_SECRET: TEST_SECRET,
  DATABASE_URL: "postgres://localhost:5432/facetdb",
  TYPESAFE_API_KEY: "ts-test-key",
  FACETDB_WEBHOOK_SECRET: SECRET,
};
const FORBIDDEN = [
  SECRET,
  ...Array.from({ length: SECRET.length - 7 }, (_, at) => SECRET.slice(at, at + 8)),
];

function printsNoSecret(...texts: readonly string[]): void {
  for (const text of texts) {
    for (const piece of FORBIDDEN) {
      expect(text).not.toContain(piece);
    }
  }
}

/** A table source and an API source, each sending its decisions to HOOK, as the loader reads the file. */
function configWith(
  options: {
    readonly channels?: readonly AlertChannel[];
    readonly spendingCap?: number;
    readonly plugins?: NonNullable<ProjectConfig["plugins"]>;
  } = {},
): ProjectConfig {
  const declared = facetdb({
    model: "jev-1.14.0",
    ...(options.spendingCap === undefined ? {} : { spendingCap: options.spendingCap }),
    plugins: options.plugins ?? {
      webhook: { secret: env("FACETDB_WEBHOOK_SECRET"), endpoints: { ops: OPS } },
    },
    ...(options.channels === undefined ? {} : { alerts: { channels: options.channels } }),
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        read: ["id", "title"],
        questions: { is_scam: noul("Is this listing a scam?") },
        actions: [webhook({ url: HOOK })],
      },
      {
        name: "tickets",
        api: true,
        read: ["subject", "body"],
        questions: { urgent: noul("Is this ticket urgent?") },
        actions: [webhook({ url: HOOK })],
      },
    ],
  });
  return {
    ...declared,
    sources: declared.sources.map((source) =>
      source.table === undefined ? source : { ...source, databaseEnv: "LISTINGS_URL" },
    ),
  };
}

type Call = {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
  /** Whether the worker told the fetch this endpoint may be private. */
  readonly allowPrivate: boolean;
};

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let calls: Call[];
let served: HttpHandler[];
/** What the fake endpoint answers. */
let status: number;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  calls = [];
  served = [];
  status = 204;
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  await world.client.query("create table public.listings (id text primary key, title text)");
  const config = configWith();
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
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(
  argv: readonly string[],
  config: ProjectConfig,
  options: {
    readonly env?: Readonly<Record<string, string>>;
    /** Runs once the surface listens, the sources open and the outbox made: the HTTP calls of a run. */
    readonly listening?: (handler: HttpHandler) => Promise<void>;
  } = {},
) {
  const environment = options.env ?? ENV;
  const connect = sharePools(world.connect);
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: environment,
      setEnv: () => undefined,
      osUser: () => "alex",
      loadConfig: () => Promise.resolve(config),
      engines: postgresEngines(connect),
      connect,
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => createFakeProvider({ defaults: { noul: 0.01 } }),
      clock,
      random: () => 0.5,
      webhookFetch: (url, init) => {
        calls.push({
          url,
          headers: { ...init.headers },
          body: init.body,
          allowPrivate: init.allowPrivate,
        });
        return Promise.resolve({ status });
      },
      abortAfter: () => new AbortController().signal,
      stopSignal: () => new AbortController().signal,
      pluginHost: (loaded) =>
        createPluginHost({
          config: loaded,
          env: environment,
          projectDir: PROJECT_DIR,
          coreVersion: VERSION,
          importModule: (specifier) =>
            Promise.reject(
              Object.assign(new Error(`Cannot find package '${specifier}'`), {
                code: "ERR_MODULE_NOT_FOUND",
              }),
            ),
          builtins: BUILTIN_PLUGINS,
        }),
      serve: async (handler, port) => {
        served.push(handler);
        await options.listening?.(handler);
        return { port, close: () => Promise.resolve() };
      },
    },
    COMMANDS,
  );
}

async function outboxText(): Promise<string> {
  const rows = await world.client.query("select * from facetdb.webhook_outbox order by id");
  return JSON.stringify(rows);
}

async function historyText(): Promise<string> {
  const rows = await world.client.query(
    "select record::text as record from facetdb.alert_history order by id",
  );
  return rows.map((row) => String(row["record"])).join("\n");
}

async function get(handler: HttpHandler | undefined, path: string): Promise<string> {
  const response = await handler?.(new Request(`http://127.0.0.1:4040${path}`), THIS_MACHINE);
  expect(response?.status, path).toBe(200);
  return (await response?.text()) ?? "";
}

describe("facetdb worker sends what the built-in webhook queues (builtin-webhook)", () => {
  it("a decision of an API source goes out once, signed with the secret its variable holds", async () => {
    const { secret: apiKey } = await store.apiKeys.create(PROJECT_ID, "test");
    let answered: unknown;
    const config = configWith();

    const result = await run(["worker", "--once"], config, {
      listening: async (handler) => {
        const response = await handler(
          new Request("http://127.0.0.1:4040/v1/check", {
            method: "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
            body: JSON.stringify({
              source: "tickets",
              id: "T-1042",
              record: { subject: "Charged twice", body: "Please fix this today" },
            }),
          }),
          THIS_MACHINE,
        );
        answered = await response.json();
      },
    });

    expect(result.code, result.stderr).toBe(0);
    expect(answered).toMatchObject({ id: "T-1042", status: "done" });
    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(HOOK);
    expect(
      verify(SECRET, call?.headers[WEBHOOK_SIGNATURE_HEADER], call?.body ?? "", START),
    ).toEqual({ ok: true });
    expect(JSON.parse(call?.body ?? "null")).toEqual({
      event: "record.decided",
      delivery: String(call?.headers["facetdb-delivery"]),
      source: "tickets",
      id: "T-1042",
      status: "done",
      decidedAt: new Date(START).toISOString(),
      answers: { urgent: { value: false, probability: 0.01 } },
    } satisfies WebhookPayload);

    // A second run sends nothing more: the decision was delivered once.
    const again = await run(["worker", "--once", "--no-http"], config);
    expect(again.code, again.stderr).toBe(0);
    expect(calls).toHaveLength(1);

    // Its value is nowhere: the lines printed, the outbox, the project's JSON export, the Plugins page.
    const [handler] = served;
    const exported = await get(handler, "/v1/config");
    expect(exported).toContain('"secret":{"env":"FACETDB_WEBHOOK_SECRET"}');
    expect(JSON.stringify(toProjectJson(config))).toContain(
      '"secret":{"env":"FACETDB_WEBHOOK_SECRET"}',
    );
    printsNoSecret(
      result.stdout,
      result.stderr,
      again.stdout,
      again.stderr,
      await outboxText(),
      exported,
      await get(handler, "/v1/plugins"),
      JSON.stringify(toProjectJson(config)),
    );
  });

  it("a decision of a table source goes out signed too, and a record queued again adds no second delivery", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const config = configWith();

    const first = await run(["worker", "--once", "--no-http"], config);
    expect(first.code, first.stderr).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([HOOK]);
    expect(JSON.parse(calls[0]?.body ?? "null")).toMatchObject({
      source: "listings",
      id: "r1",
      status: "done",
    });

    // The app writes the same value again: queued at the same state, answered from the log with
    // no model call, its actions run again, and the decision is the delivery it already has.
    await world.client.query("update public.listings set title = 'A red car' where id = 'r1'");
    clock.advance(60_000);
    const second = await run(["worker", "--once", "--no-http"], config);
    expect(second.code, second.stderr).toBe(0);
    expect(second.stdout).toContain("listings: already answered r1 at this state");
    expect(calls).toHaveLength(1);
    const rows = await world.client.query(
      "select count(*)::int as n from facetdb.webhook_outbox where record_key = 'r1'",
    );
    expect(rows[0]?.["n"]).toBe(1);
  });

  it("tells the send an endpoint may be private only when the config in force writes allowPrivate: true beside it", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const withActions = (actions: ProjectConfig["sources"][number]["actions"]): ProjectConfig => {
      const base = configWith();
      return {
        ...base,
        sources: base.sources.map((source) => ({ ...source, actions })),
      };
    };

    // A public endpoint: no allowance. The send fails, so the row waits for its retry.
    status = 500;
    const first = await run(
      ["worker", "--once", "--no-http"],
      withActions([webhook({ url: HOOK })]),
    );
    expect(first.code, first.stderr).toBe(0);
    expect(calls.map((call) => [call.url, call.allowPrivate])).toEqual([[HOOK, false]]);

    // The row's address now named with the flag: its retry is sent with the allowance.
    status = 204;
    clock.advance(60_000);
    const allowed = await run(
      ["worker", "--once", "--no-http"],
      withActions([webhook({ url: HOOK, allowPrivate: true })]),
    );
    expect(allowed.code, allowed.stderr).toBe(0);
    expect(calls.map((call) => [call.url, call.allowPrivate])).toEqual([
      [HOOK, false],
      [HOOK, true],
    ]);
  });

  it("closes unsent a waiting delivery whose endpoint the config no longer names", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    status = 500; // the first send fails, so the row waits for its retry
    const first = await run(["worker", "--once", "--no-http"], configWith());
    expect(first.code, first.stderr).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([HOOK]);

    // The file now sends the source's decisions elsewhere; the retry comes due.
    status = 204;
    clock.advance(60_000);
    const moved = configWith();
    const second = await run(["worker", "--once", "--no-http"], {
      ...moved,
      sources: moved.sources.map((source) => ({
        ...source,
        actions: [webhook({ url: "https://new.example.com/facetdb" })],
      })),
    });

    expect(second.code, second.stderr).toBe(0);
    expect(calls.map((call) => call.url)).toEqual([HOOK]);
    const rows = await world.client.query(
      "select endpoint, delivered_at, gave_up_at::text as gave_up_at, last_error from facetdb.webhook_outbox",
    );
    expect(rows).toEqual([
      {
        endpoint: HOOK,
        delivered_at: null,
        gave_up_at: String(START + 60_000),
        last_error: WEBHOOK_ENDPOINT_GONE,
      },
    ]);
    printsNoSecret(first.stdout, first.stderr, second.stdout, second.stderr);
  });

  it("an alert through webhook:ops arrives signed, and its history says it was delivered", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");

    const result = await run(
      ["worker", "--once"],
      configWith({ channels: ["webhook:ops"], spendingCap: 1 }),
    );

    expect(result.code, result.stderr).toBe(0);
    const alerts = calls.filter((call) => call.url === OPS);
    // The cap of one token: the warning at 80% and the critical one at the cap.
    expect(
      alerts.map((call) => (JSON.parse(call.body) as WebhookAlertPayload).severity).toSorted(),
    ).toEqual(["critical", "warning"]);
    for (const call of alerts) {
      expect(verify(SECRET, call.headers[WEBHOOK_SIGNATURE_HEADER], call.body, START)).toEqual({
        ok: true,
      });
      const body = JSON.parse(call.body) as WebhookAlertPayload;
      expect(body).toMatchObject({ event: "alert", delivery: call.headers["facetdb-delivery"] });
      expect(body.text.length).toBeGreaterThan(0);
    }
    const history = await historyText();
    expect(history).toContain('{"ok": true, "channel": "webhook:ops"}');
    const [handler] = served;
    printsNoSecret(
      result.stdout,
      result.stderr,
      history,
      await outboxText(),
      await get(handler, "/v1/alerts"),
    );
  });

  it("refuses to start, naming the variable, when the secret is not set or not written", async () => {
    const { FACETDB_WEBHOOK_SECRET: _set, ...unset } = ENV;
    const missing = await run(["worker", "--dry-run"], configWith(), { env: unset });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain(
      'the plugin "@facetdb/webhook" cannot start: FACETDB_WEBHOOK_SECRET is not set (plugins.webhook.secret reads it)',
    );
    expect(missing.stderr).toContain("set FACETDB_WEBHOOK_SECRET where the worker runs");

    const unwritten = await run(["worker", "--dry-run"], configWith({ plugins: {} }));
    expect(unwritten.code).toBe(1);
    expect(unwritten.stderr).toContain(
      'plugins.webhook.secret: the webhook\'s signing secret is read from an environment variable: write secret: env("FACETDB_WEBHOOK_SECRET") under plugins.webhook',
    );

    const unknown = await run(["worker", "--dry-run"], configWith({ channels: ["webhook:pager"] }));
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain(
      'alerts.channels[0] (webhook:pager) cannot be delivered to: plugins.webhook.endpoints has no endpoint named pager: add pager: "https://…" to it, or name one of ops',
    );
    printsNoSecret(missing.stdout, missing.stderr, unwritten.stderr, unknown.stderr);
  });
});
