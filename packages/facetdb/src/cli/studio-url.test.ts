import {
  type AlertEvent,
  type AlertRecord,
  type AlertStore,
  type Clock,
  createAlerts,
} from "@facetdb/core";
import { createFakeProvider } from "@facetdb/model";
import { GIVE_UP_AFTER_MS, type StudioFiles } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configFileSource,
  facetdb,
  fromProjectJson,
  judgeDraftProject,
  noul,
  type ProjectConfig,
  parseProjectConfig,
  toProjectJson,
} from "../config/index.ts";
import { projectSpending, wireBackfill } from "./backfill-wiring.ts";
import { projectRef, questionSetOf } from "./commands/database.ts";
import { COMMANDS } from "./commands/index.ts";
import { alertScope, createLinks, type StudioBase, servedStudioUrl, studioUrl } from "./links.ts";
import { sharePools } from "./pools.ts";
import { type HttpHandler, runInProcess, type StudioInstall } from "./program.ts";
import { hashPassword } from "./store-door.ts";
import {
  createPgliteWorld,
  createStore,
  freshPglite,
  migrate,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  SteppedClock,
  type Store,
  TEST_SECRET,
} from "./testing.ts";

/**
 * The studio's address is the base of every link FacetDB sends: the config key and its refusals,
 * the key's JSON and file round trip, each link with a configured address, with the served one and
 * with none, the encoding of a record's key and a source's name, and the alert sites (the worker,
 * the backfill, the spending cap) building through the one module.
 */

const NO_STUDIO: StudioBase = { configured: undefined, served: () => undefined };
const DOCS = "https://docs.facetdb.dev/fix";

describe("the links", () => {
  it("send each alert to the studio page where it is fixed, under the configured address", () => {
    const links = createLinks({
      configured: "https://facetdb.example.com",
      served: () => undefined,
    });

    expect({
      worker: links.worker(),
      model: links.model(),
      backfill: links.backfill(),
      access: links.access(),
      spendingCap: links.spendingCap(),
      questionSet: links.questionSet("orders"),
      record: links.record("orders", "r1"),
      list: links.list("orders", "week"),
    }).toEqual({
      worker: "https://facetdb.example.com/",
      model: "https://facetdb.example.com/",
      backfill: "https://facetdb.example.com/sources",
      access: "https://facetdb.example.com/sources",
      spendingCap: "https://facetdb.example.com/settings",
      questionSet: "https://facetdb.example.com/questions?source=orders",
      record: "https://facetdb.example.com/decisions/orders/r1",
      list: "https://facetdb.example.com/decisions?source=orders&time=week",
    });
  });

  it("use the address the process serves the studio on when the config names none", () => {
    const links = createLinks({ configured: undefined, served: () => "http://127.0.0.1:4040" });

    expect(links.worker()).toBe("http://127.0.0.1:4040/");
    expect(links.spendingCap()).toBe("http://127.0.0.1:4040/settings");
    expect(links.record("orders", "r1")).toBe("http://127.0.0.1:4040/decisions/orders/r1");
  });

  it("prefer the configured address to the served one", () => {
    const links = createLinks({
      configured: "https://facetdb.example.com",
      served: () => "http://127.0.0.1:4040",
    });

    expect(links.backfill()).toBe("https://facetdb.example.com/sources");
  });

  it("keep an alert's docs fix page with no studio, and have no record or list link", () => {
    const links = createLinks(NO_STUDIO);

    expect({
      worker: links.worker(),
      model: links.model(),
      backfill: links.backfill(),
      access: links.access(),
      spendingCap: links.spendingCap(),
      questionSet: links.questionSet("orders"),
    }).toEqual({
      worker: `${DOCS}/worker`,
      model: `${DOCS}/worker`,
      backfill: `${DOCS}/backfill`,
      access: `${DOCS}/worker-login`,
      spendingCap: `${DOCS}/spending-cap`,
      questionSet: `${DOCS}/question-set`,
    });
    expect(links.record("orders", "r1")).toBeUndefined();
    expect(links.list("orders", "week")).toBeUndefined();
  });

  it("never double a trailing slash on the base", () => {
    for (const configured of ["https://facetdb.example.com/", "https://facetdb.example.com///"]) {
      const links = createLinks({ configured, served: () => undefined });
      expect(links.worker()).toBe("https://facetdb.example.com/");
      expect(links.backfill()).toBe("https://facetdb.example.com/sources");
      expect(links.record("orders", "r1")).toBe("https://facetdb.example.com/decisions/orders/r1");
    }
  });

  it("build from the parsed address's normal form, not the text as written", () => {
    const links = createLinks({
      configured: "https://FacetDB.Example.com:443",
      served: () => undefined,
    });

    expect(links.spendingCap()).toBe("https://facetdb.example.com/settings");
    const odd = createLinks({
      configured: "http://facetdb.example.com:80/",
      served: () => undefined,
    });
    expect(odd.spendingCap()).toBe("http://facetdb.example.com/settings");
  });

  it("send an action or a webhook that gave up to the Alerts page, or to its docs page", () => {
    const studio = createLinks({
      configured: "https://facetdb.example.com",
      served: () => undefined,
    });
    const none = createLinks(NO_STUDIO);

    expect([studio.gaveUp("action"), studio.gaveUp("webhook")]).toEqual([
      "https://facetdb.example.com/alerts",
      "https://facetdb.example.com/alerts",
    ]);
    expect([none.gaveUp("action"), none.gaveUp("webhook")]).toEqual([
      `${DOCS}/actions`,
      `${DOCS}/webhooks`,
    ]);
  });

  it("serve a link base only for a bind a reader can open: not every interface", () => {
    expect(servedStudioUrl("127.0.0.1", 4040)).toBe("http://127.0.0.1:4040");
    expect(servedStudioUrl("::1", 4040)).toBe("http://[::1]:4040");
    expect(servedStudioUrl("192.168.1.20", 8080)).toBe("http://192.168.1.20:8080");
    expect(servedStudioUrl("0.0.0.0", 4040)).toBeUndefined();
    expect(servedStudioUrl("::", 4040)).toBeUndefined();
    expect(servedStudioUrl("[::]", 4040)).toBeUndefined();
    // A host name the command takes but the URL standard refuses has no link to build.
    expect(servedStudioUrl("foo.123", 4040)).toBeUndefined();
    expect(servedStudioUrl("studio.internal", 4040)).toBe("http://studio.internal:4040");
  });

  it("encode a record's key and a source's name for a URL", () => {
    const links = createLinks({
      configured: "https://facetdb.example.com",
      served: () => undefined,
    });
    const key = "a/b c?d#e%f&g=h";

    const record = links.record("my source", key);

    expect(record).toBe(
      "https://facetdb.example.com/decisions/my%20source/a%2Fb%20c%3Fd%23e%25f%26g%3Dh",
    );
    // The page reads the same two segments back: no slash, query or fragment of the key leaks out.
    const parsed = new URL(record ?? "");
    expect(parsed.search).toBe("");
    expect(parsed.hash).toBe("");
    expect(parsed.pathname.split("/").map(decodeURIComponent)).toEqual([
      "",
      "decisions",
      "my source",
      key,
    ]);
    expect(links.list("my&source", "month")).toBe(
      "https://facetdb.example.com/decisions?source=my%26source&time=month",
    );
    expect(links.questionSet("a b")).toBe("https://facetdb.example.com/questions?source=a%20b");
  });

  it("leave the time out of a list link for today, the Decisions page's own default", () => {
    const links = createLinks({
      configured: "https://facetdb.example.com",
      served: () => undefined,
    });

    expect(links.list("orders", "today")).toBe(
      "https://facetdb.example.com/decisions?source=orders",
    );
    expect(links.list("orders", "all")).toBe(
      "https://facetdb.example.com/decisions?source=orders&time=all",
    );
  });

  it("name the address the studio prints: every interface stands for this machine", () => {
    expect(studioUrl("127.0.0.1", 4040)).toBe("http://127.0.0.1:4040");
    expect(studioUrl("0.0.0.0", 4040)).toBe("http://127.0.0.1:4040");
    expect(studioUrl("::", 4040)).toBe("http://[::1]:4040");
    expect(studioUrl("192.168.1.20", 8080)).toBe("http://192.168.1.20:8080");
  });

  it("read the served address when an alert is raised, not when its scope is made", () => {
    let served: string | undefined;
    const links = createLinks({ configured: undefined, served: () => served });
    const scope = alertScope("shop", "orders", links.worker);

    expect({ ...scope }).toEqual({ project: "shop", source: "orders", link: `${DOCS}/worker` });
    served = "http://127.0.0.1:4321";
    expect({ ...scope }).toEqual({
      project: "shop",
      source: "orders",
      link: "http://127.0.0.1:4321/",
    });
  });
});

const SOURCE = {
  name: "orders",
  api: true,
  read: ["note"],
  questions: { rude: noul("Is the note rude?") },
} as const;

function project(studioUrlText?: unknown): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    ...(studioUrlText === undefined ? {} : { studioUrl: studioUrlText as string }),
    sources: [SOURCE],
  });
}

describe("the config's studioUrl", () => {
  it("accepts an http or https address, with a port", () => {
    for (const address of [
      "https://facetdb.example.com",
      "https://facetdb.example.com/",
      "http://127.0.0.1:4040",
      "http://[::1]:4040",
    ]) {
      const result = parseProjectConfig(project(address));
      expect(result.ok && result.config.studioUrl).toBe(address);
    }
  });

  it("refuses an address that is not http or https, or is not text, saying what to write", () => {
    for (const value of [
      "ftp://facetdb.example.com",
      "facetdb.example.com",
      "https://",
      "http://a b",
      42,
    ]) {
      const result = parseProjectConfig(project(value));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues.map((issue) => issue.path)).toEqual(["studioUrl"]);
        expect(result.issues[0]?.message).toMatch(/^studioUrl (must be|is text)/);
      }
    }
  });

  it("refuses a backslash, a control, a zero-width or a direction character, and never repeats the address", () => {
    for (const address of [
      "https://facetdb.example.com\\@evil.example",
      "https://facetdb.example.com\\evil-secret.example",
      "https://facetdb.example.com\u0007",
      "https://facetdb.example.com​.evil-secret.example",
      "https://facetdb.example.com‮",
      "https://﻿facetdb.example.com",
      "https://facetdb.example.com ",
    ]) {
      const result = parseProjectConfig(project(address));
      expect(result.ok, address).toBe(false);
      if (!result.ok) {
        expect(result.issues.map((issue) => issue.path)).toEqual(["studioUrl"]);
        expect(result.issues[0]?.message).toContain("remove any backslash");
        expect(JSON.stringify(result.issues)).not.toContain("evil");
      }
    }
  });

  it("refuses a path, saying the studio is served at the root of its address", () => {
    for (const address of [
      "https://example.com/facetdb",
      "https://example.com/facetdb/",
      "https://example.com//",
    ]) {
      const result = parseProjectConfig(project(address));
      expect(result.ok, address).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]?.message).toContain("served at the root of");
        expect(JSON.stringify(result.issues)).not.toContain("example.com");
      }
    }
  });

  it("refuses a username or password and never repeats it", () => {
    const result = parseProjectConfig(project("https://ops:hunter2@facetdb.example.com"));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.path)).toEqual(["studioUrl"]);
      expect(result.issues[0]?.message).toContain("username or password");
      expect(JSON.stringify(result.issues)).not.toContain("hunter2");
      expect(JSON.stringify(result.issues)).not.toContain("ops");
    }
  });

  it("refuses a query or a fragment, and never repeats what was in it", () => {
    for (const address of [
      "https://facetdb.example.com/?token=abc123",
      "https://facetdb.example.com#abc123",
      "https://facetdb.example.com?",
    ]) {
      const result = parseProjectConfig(project(address));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]?.message).toContain("remove everything from the ? or # on");
        expect(JSON.stringify(result.issues)).not.toContain("abc123");
      }
    }
  });

  it("refuses a project draft that carries it, as the other hand-edited keys are", () => {
    const judged = judgeDraftProject(
      project("https://facetdb.example.com"),
      { studioUrl: "https://elsewhere.example.com" },
      {},
    );

    expect(judged.ok).toBe(false);
    if (!judged.ok) {
      expect(judged.issues).toEqual([
        {
          path: "studioUrl",
          message:
            "a draft cannot change studioUrl: it is the address every alert and notification link opens; edit studioUrl in facetdb.config.ts by hand",
        },
      ]);
    }
  });

  it("keeps the key through a draft of the spending cap", () => {
    const judged = judgeDraftProject(
      project("https://facetdb.example.com"),
      { spendingCap: 1000 },
      {},
    );

    expect(judged.ok && judged.config.studioUrl).toBe("https://facetdb.example.com");
  });

  it("round-trips through the JSON export and the exported config file", () => {
    const config = project("https://facetdb.example.com");

    const json = toProjectJson(config);
    expect(json.studioUrl).toBe("https://facetdb.example.com");
    expect(fromProjectJson(JSON.parse(JSON.stringify(json)))).toEqual(config);
    expect(configFileSource(config)).toContain('  studioUrl: "https://facetdb.example.com",\n');
  });

  it("leaves a config without the key exactly as it was: no key in the JSON, none in the file", () => {
    const config = project();

    expect(JSON.stringify(toProjectJson(config))).toBe(
      '{"model":"jev-1.14.0","onCapReached":"pause","sources":[{"name":"orders","api":true,"read":["note"],"storage":"inline","onChange":"reset","onOutage":"hold","questions":{"rude":{"type":"noul","instructions":"Is the note rude?","stakes":"low"}},"thresholds":{},"actions":[]}]}',
    );
    expect(configFileSource(config)).toBe(
      [
        'import { facetdb, noul } from "facetdb";',
        "",
        "export default facetdb({",
        '  model: "jev-1.14.0",',
        "  sources: [",
        "    {",
        '      name: "orders",',
        "      api: true,",
        '      read: ["note"],',
        "      questions: {",
        '        "rude": noul("Is the note rude?"),',
        "      },",
        "    },",
        "  ],",
        "});",
        "",
      ].join("\n"),
    );
    expect("studioUrl" in config).toBe(false);
  });
});

/** An alert store that keeps the history in memory: what a channel would have been told. */
function recordingAlertStore(): AlertStore & { readonly history: AlertRecord[] } {
  const history: AlertRecord[] = [];
  return {
    history,
    getActive: () => Promise.resolve(undefined),
    setActive: () => Promise.resolve(),
    clearActive: () => Promise.resolve(),
    append: (record) => {
      history.push(record);
      return Promise.resolve();
    },
    lastHeartbeat: () => Promise.resolve(undefined),
    saveHeartbeat: () => Promise.resolve(),
  };
}

const eventOf = (record: AlertRecord | undefined): AlertEvent => {
  if (record === undefined) {
    throw new Error("no alert was recorded");
  }
  return record.event;
};

describe("the alerts of a command that serves no studio", () => {
  const clock: Clock = {
    now: () => Date.UTC(2026, 10, 13, 9, 0, 0),
    sleep: () => Promise.resolve(),
  };
  let pglite: Awaited<ReturnType<typeof freshPglite>>;
  let store: Store;

  beforeAll(async () => {
    pglite = await freshPglite();
  });

  afterAll(async () => {
    await pglite.close();
  });

  beforeEach(async () => {
    store = await createStore({ pglite, secret: TEST_SECRET, clock });
  });

  afterEach(async () => {
    await store.close();
  });

  async function backfillLink(config: ProjectConfig): Promise<string> {
    const [source] = config.sources;
    if (source === undefined) {
      throw new Error("the test config has a source");
    }
    const alertStore = recordingAlertStore();
    const deps = await wireBackfill({
      config,
      source,
      project: { id: "shop", name: "shop" },
      store: { ...store, alerts: alertStore },
      connector: {} as never,
      provider: { ask: () => Promise.reject(new Error("never asked")) },
      clock,
    });
    await deps.alerts?.backfillFinished({ answered: 3, queued: 0, question: null });
    return eventOf(alertStore.history[0]).link;
  }

  it("facetdb backfill keeps the docs fix page with no studioUrl", async () => {
    expect(await backfillLink(project())).toBe(`${DOCS}/backfill`);
  });

  it("facetdb backfill links to the Sources page of the configured studioUrl", async () => {
    expect(await backfillLink(project("https://facetdb.example.com/"))).toBe(
      "https://facetdb.example.com/sources",
    );
  });

  async function capLink(config: ProjectConfig, projectId: string): Promise<string> {
    const alertStore = recordingAlertStore();
    const alerts = createAlerts({ store: alertStore, clock, channels: [] });
    // A project of its own: the month's count is the store's, and the engine outlives a test.
    const gate = projectSpending({ ...config, spendingCap: 100 }, store, alerts, clock, projectId);
    await gate.record(85);
    const event = eventOf(alertStore.history[0]);
    expect(event.kind).toBe("spending_80");
    return event.link;
  }

  it("the spending cap alert keeps its docs fix page with no studioUrl", async () => {
    expect(await capLink(project(), "no-studio")).toBe(`${DOCS}/spending-cap`);
  });

  it("the spending cap alert links to Settings under the configured studioUrl", async () => {
    expect(await capLink(project("https://facetdb.example.com"), "with-studio")).toBe(
      "https://facetdb.example.com/settings",
    );
  });
});

const PROJECT_DIR = "/work/listings-app";
const BUILD_DIR = "/install/apps/studio/dist";
const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const START = 1_700_000_000_000;

function listings(studioUrlText?: string, spendingCap?: number): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    ...(studioUrlText === undefined ? {} : { studioUrl: studioUrlText }),
    ...(spendingCap === undefined ? {} : { spendingCap }),
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
}

/** An install whose studio is built, or (`built` false) one with no studio package at all. */
function install(built: boolean): StudioInstall {
  const files: Readonly<Record<string, string>> = {
    [`${BUILD_DIR}/index.html`]:
      '<!doctype html><title>FacetDB studio</title><div id="root"></div>',
    [`${BUILD_DIR}/routes.json`]: JSON.stringify({ routes: ["/"] }),
  };
  return {
    defaultDir: built ? BUILD_DIR : undefined,
    files: (dir): StudioFiles => ({
      read: (names) => {
        const text = files[[dir, ...names].join("/")];
        return Promise.resolve(text === undefined ? undefined : new TextEncoder().encode(text));
      },
    }),
  };
}

describe("the worker's alerts", () => {
  let world: PgliteWorld;
  let store: Store;
  let clock: SteppedClock;

  beforeAll(async () => {
    world = await createPgliteWorld();
  });

  afterAll(async () => {
    await world.close();
  });

  beforeEach(async () => {
    clock = new SteppedClock(START);
    store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
    await world.client.query("create table public.listings (id text primary key, title text)");
    const config = listings();
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

  /** The worker as `facetdb worker` runs it, over the test's PGlite, with the options a test sets. */
  function worker(
    config: ProjectConfig,
    argv: readonly string[],
    options: {
      readonly studio?: StudioInstall;
      /** The first model call fails (the `model_failing` alert); otherwise every call answers. */
      readonly failFirstCall?: boolean;
      readonly stop?: AbortSignal;
      readonly onServe?: (handler: HttpHandler) => void;
    } = {},
  ) {
    const connect = sharePools((url, connectOptions) => world.connect(url, connectOptions));
    return runInProcess(
      ["worker", ...argv],
      {
        projectDir: PROJECT_DIR,
        env: {
          FACETDB_SECRET: TEST_SECRET,
          DATABASE_URL: "postgres://localhost:5432/facetdb",
          TYPESAFE_API_KEY: "ts-test-key",
        },
        osUser: () => "alex",
        loadConfig: () => Promise.resolve(config),
        engines: postgresEngines(connect),
        connect,
        store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
        provider: () =>
          createFakeProvider({
            defaults: { noul: 0.01 },
            ...(options.failFirstCall === true ? { failures: { 0: { kind: "malformed" } } } : {}),
          }),
        clock,
        random: () => 0.5,
        webhookFetch: () => Promise.reject(new Error("the receiver is down")),
        // No timeout ever fires: the receiver's refusal, not a deadline, ends each attempt.
        abortAfter: () => new AbortController().signal,
        serve: (handler, port) => {
          options.onServe?.(handler);
          return Promise.resolve({ port, close: () => Promise.resolve() });
        },
        studio: options.studio ?? install(true),
        ...(options.stop === undefined ? {} : { stopSignal: () => options.stop as AbortSignal }),
      },
      COMMANDS,
    );
  }

  async function alertsRaised(): Promise<AlertEvent[]> {
    const rows = await world.client.query("select record from facetdb.alert_history order by id");
    return rows.map((row) => (row["record"] as AlertRecord).event);
  }

  async function linkOf(kind: AlertEvent["kind"] | `${string}_`): Promise<string> {
    const events = await alertsRaised();
    const found = events.find((event) =>
      kind.endsWith("_") ? event.kind.startsWith(kind) : event.kind === kind,
    );
    if (found === undefined) {
      throw new Error(
        `no ${kind} alert was raised: ${events.map((event) => event.kind).join(", ")}`,
      );
    }
    return found.link;
  }

  /** One pass whose first model call fails: the `model_failing` alert's link as it was sent. */
  async function modelFailingLink(
    config: ProjectConfig,
    argv: readonly string[],
    studio: StudioInstall,
  ): Promise<string> {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const result = await worker(config, ["--once", ...argv], { studio, failFirstCall: true });
    expect(result.code, result.stderr).toBe(0);
    return linkOf("model_failing");
  }

  it("with --no-http and no studioUrl keep the docs fix page", async () => {
    expect(await modelFailingLink(listings(), ["--no-http"], install(true))).toBe(`${DOCS}/worker`);
  });

  it("with no studio build to serve keep the docs fix page: the API alone has no page to link", async () => {
    expect(await modelFailingLink(listings(), ["--port", "4321"], install(false))).toBe(
      `${DOCS}/worker`,
    );
  });

  it("with no studioUrl link to Home on the address the worker serves the studio on", async () => {
    expect(await modelFailingLink(listings(), ["--port", "4321"], install(true))).toBe(
      "http://127.0.0.1:4321/",
    );
  });

  it("bound to every interface with no studioUrl keep the docs fix page: a reader cannot open 0.0.0.0", async () => {
    await store.users.add("maya", await hashPassword("a long enough password"));

    expect(
      await modelFailingLink(listings(), ["--port", "4321", "--host", "0.0.0.0"], install(true)),
    ).toBe(`${DOCS}/worker`);
  });

  it("bound to a host name the URL standard refuses keep the docs fix page, and still raise the alert", async () => {
    await store.users.add("maya", await hashPassword("a long enough password"));

    expect(
      await modelFailingLink(listings(), ["--port", "4321", "--host", "foo.123"], install(true)),
    ).toBe(`${DOCS}/worker`);
  });

  it("link to the configured studioUrl, served or not, with no doubled slash", async () => {
    const config = listings("https://facetdb.example.com/");

    expect(await modelFailingLink(config, ["--no-http"], install(true))).toBe(
      "https://facetdb.example.com/",
    );
  });

  it("link to the configured studioUrl even where a studio is served, not to the served address", async () => {
    const config = listings("https://facetdb.example.com");

    expect(await modelFailingLink(config, ["--port", "4321"], install(true))).toBe(
      "https://facetdb.example.com/",
    );
  });

  it("the spending cap's alert links to Settings on the served studio, and to the docs without one", async () => {
    // The fake provider counts 100 input tokens a call: 100 of 120 is past the 80% line.
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const served = await worker(listings(undefined, 120), ["--once", "--port", "4321"]);
    expect(served.code, served.stderr).toBe(0);
    expect(await linkOf("spending_80")).toBe("http://127.0.0.1:4321/settings");
  });

  it("the spending cap's alert keeps its docs page when the worker serves no studio", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const bare = await worker(listings(undefined, 120), ["--once", "--no-http"]);
    expect(bare.code, bare.stderr).toBe(0);
    expect(await linkOf("spending_80")).toBe(`${DOCS}/spending-cap`);
  });

  // The action kind's link is proven by `links.gaveUp("action")` above and by the outbox's own test:
  // the worker wires no `runAction` yet ("None are wired yet"), so it never claims an action row and
  // an action cannot give up in a worker run. A row for a plugin action is left for the loop that
  // has a runner; when plugin actions are wired, a worker test for the action kind belongs here.
  it("a webhook that gave up links to the Alerts page of the served studio", async () => {
    await world.client.query(
      `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at)
       values ($2, 'https://hooks.example.com/facetdb', '{}', $1::bigint, $1::bigint)`,
      [START - GIVE_UP_AFTER_MS, projectRef(PROJECT_DIR).id],
    );

    const result = await worker(listings(), ["--once", "--port", "4321"]);

    expect(result.code, result.stderr).toBe(0);
    expect(await linkOf("action_gave_up")).toBe("http://127.0.0.1:4321/alerts");
  });

  it("a webhook that gave up keeps its docs page with no studio", async () => {
    await world.client.query(
      `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at)
       values ($2, 'https://hooks.example.com/facetdb', '{}', $1::bigint, $1::bigint)`,
      [START - GIVE_UP_AFTER_MS, projectRef(PROJECT_DIR).id],
    );

    const result = await worker(listings(), ["--once", "--no-http"]);

    expect(result.code, result.stderr).toBe(0);
    expect(await linkOf("action_gave_up")).toBe(`${DOCS}/webhooks`);
  });

  /** The studio's own HTTP door on this machine, as a browser's request arrives. */
  async function call(
    handler: HttpHandler,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly json: Record<string, unknown> }> {
    const response = await handler(
      new Request(`http://localhost${path}`, {
        method,
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
      { remoteAddress: "127.0.0.1" },
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  /** A whole-set backfill asked for over HTTP while the worker runs, until its alert is recorded. */
  async function backfillFinishedLink(config: ProjectConfig): Promise<string> {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const stop = new AbortController();
    let handler: HttpHandler | undefined;
    const running = worker(config, ["--port", "4321"], {
      stop: stop.signal,
      onServe: (served) => {
        handler = served;
      },
    });
    try {
      await vi.waitFor(() => expect(handler).toBeDefined(), { timeout: 10_000 });
      const door = handler as HttpHandler;
      expect((await call(door, "POST", "/v1/sources/listings/backfill/estimate", {})).status).toBe(
        202,
      );
      let token: string | null = null;
      await vi.waitFor(
        async () => {
          const status = await call(door, "GET", "/v1/sources/listings/backfill");
          token = status.json["token"] as string | null;
          expect(token).not.toBeNull();
        },
        { timeout: 10_000 },
      );
      const started = await call(door, "POST", "/v1/sources/listings/backfill/start", { token });
      expect(started.status, JSON.stringify(started.json)).toBe(200);
      await vi.waitFor(
        async () =>
          expect((await alertsRaised()).map((event) => event.kind)).toContain("backfill_finished"),
        { timeout: 20_000 },
      );
      return await linkOf("backfill_finished");
    } finally {
      stop.abort();
      await running;
    }
  }

  it("a backfill the studio started links to Sources on the served studio", async () => {
    expect(await backfillFinishedLink(listings())).toBe("http://127.0.0.1:4321/sources");
  });

  it("a backfill the studio started links to Sources of the configured studioUrl", async () => {
    expect(await backfillFinishedLink(listings("https://facetdb.example.com"))).toBe(
      "https://facetdb.example.com/sources",
    );
  });
});
