import type { AlertEvent, AlertRecord, DoctorCheck } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { sourceIdOf } from "@facetdb/postgres";
import { describe, expect, it } from "vitest";
import { createApp, type StudioAccess } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import { createDoctors, DOCTOR_FRESH_MS } from "./doctor.ts";
import type { DashboardDoor, SourceFacts, TableFacts } from "./door.ts";
import { createHomeService, type Home } from "./home.ts";
import type { CursorRow, DashboardReads, Day } from "./reads.ts";
import { createSourcesService, type SourceRow } from "./sources.ts";

/**
 * `GET /v1/home` and `GET /v1/sources` on handwritten fakes: the store's figures as a world the
 * test sets, each source's doctor as a script, and the fake clock for "today" and every age. The
 * words of each figure are pinned as the two pages show them.
 */

const PROJECT = "marketplace";
const KEY = "Bearer fdb_marketplace";
const OTHER_KEY = "Bearer fdb_another";
/** Thursday 5 November 2026, 2:10 pm UTC. */
const NOW = Date.UTC(2026, 10, 5, 14, 10);
const TODAY = Date.UTC(2026, 10, 5);
const DAY_MS = 24 * 60 * 60_000;

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: (header) =>
    Promise.resolve(
      header === KEY
        ? { id: "key-1", projectId: PROJECT }
        : header === OTHER_KEY
          ? { id: "key-2", projectId: "another" }
          : undefined,
    ),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };

/** The studio as the reviewer middleware sees it: this machine is the OS user, anyone else signs in. */
function localStudio(projectId: string): StudioAccess {
  return {
    sessions: {
      signIn: () => Promise.reject(new Error("these tests sign nobody in")),
      reviewerFor: ({ local }) =>
        Promise.resolve(
          local ? { kind: "reviewer", name: "os:alex" } : { kind: "sign-in", why: "no-cookie" },
        ),
    },
    reviewers: {
      list: () => Promise.reject(new Error("these tests list no reviewers")),
      add: () => Promise.reject(new Error("these tests add no reviewer")),
      canAdd: () => Promise.resolve(false),
    },
    projectId,
  };
}

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
};

const NO_CONFIG: ConfigService = {
  json: () => {
    throw new Error("these tests read no config");
  },
  validate: () => {
    throw new Error("these tests validate no draft");
  },
  preview: () => Promise.reject(new Error("these tests preview nothing")),
  test: () => Promise.reject(new Error("these tests test nothing")),
  diff: () => Promise.reject(new Error("these tests apply nothing")),
  apply: () => Promise.reject(new Error("these tests apply nothing")),
  reload: () => Promise.reject(new Error("these tests reload nothing")),
};

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });

const INSTALLED = "facetdb schema, jobs table, trigger and answer columns are in place";
/** The Postgres doctor's distance warning, as it words it (packages/postgres, engine/doctor.ts). */
const DISTANCE =
  "the database answers in 190 ms; run the worker in the same region for fast answers";

/** A doctor that answers its script and counts its runs. */
function scripted(checks: readonly DoctorCheck[]) {
  const doctor = {
    runs: 0,
    checks,
    run: () => {
      doctor.runs += 1;
      return Promise.resolve(doctor.checks);
    },
  };
  return doctor;
}

function table(facts: Partial<TableFacts> & Pick<TableFacts, "doctor">): TableFacts {
  return {
    database: "Postgres",
    capture: "trigger",
    pushWakeup: true,
    label: "public.listings",
    storage: "inline",
    answersIn: "columns",
    login: { kind: "user", user: "facetdb_worker", reach: "columns" },
    estimateRows: () => Promise.resolve(null),
    ...facts,
  };
}

/** The store as the test sets it; every read the routes make is answered from here. */
type World = {
  heartbeat: number | undefined;
  tokens: number;
  failing: AlertEvent[];
  history: AlertRecord[];
  answered: Map<number, number>;
  decided: { records: number; reviewers: number };
  queue: { waiting: number; oldestSince: number | undefined };
  lastChange: Map<string, number>;
  cursors: CursorRow[];
  answeredUnder: Map<string, number>;
  finishedAt: Map<string, number>;
  /** The source ids each read of the log and the queue was scoped to. */
  scopes: (readonly string[])[];
};

function emptyWorld(): World {
  return {
    heartbeat: undefined,
    tokens: 0,
    failing: [],
    history: [],
    answered: new Map(),
    decided: { records: 0, reviewers: 0 },
    queue: { waiting: 0, oldestSince: undefined },
    lastChange: new Map(),
    cursors: [],
    answeredUnder: new Map(),
    finishedAt: new Map(),
    scopes: [],
  };
}

function readsOf(world: World): DashboardReads {
  const scoped = (ids: readonly string[]) => {
    world.scopes.push(ids);
  };
  return {
    lastHeartbeat: () => Promise.resolve(world.heartbeat),
    monthTokens: (_project, month) => Promise.resolve(month === "2026-11" ? world.tokens : 0),
    modelFailing: () => Promise.resolve(world.failing),
    recentAlerts: (_project, limit) => Promise.resolve(world.history.slice(0, limit)),
    answered: (ids, day: Day) => {
      scoped(ids);
      expect(day.to - day.from).toBe(DAY_MS);
      return Promise.resolve(world.answered.get(day.from) ?? 0);
    },
    decided: (ids) => {
      scoped(ids);
      return Promise.resolve(world.decided);
    },
    queue: (ids) => {
      scoped(ids);
      return Promise.resolve(world.queue);
    },
    lastChange: (id) => Promise.resolve(world.lastChange.get(id)),
    cursors: (prefix) => Promise.resolve(world.cursors.filter((row) => row.run.startsWith(prefix))),
    answeredUnder: (id, version) =>
      Promise.resolve(world.answeredUnder.get(`${id}@${version}`) ?? 0),
    backfillFinishedAt: (_project, source) => Promise.resolve(world.finishedAt.get(source)),
  };
}

const READ = ["title", "description", "price", "seller_age_days"];

function rig(
  options: {
    readonly sources?: (doctors: ReturnType<typeof scripted>[]) => SourceFacts[];
    readonly cap?: DashboardDoor["cap"] | null;
  } = {},
) {
  const clock = new FakeClock(NOW);
  const world = emptyWorld();
  const listingsDoctor = scripted([
    ok("database", "logged in as facetdb_worker: listings on db.example.com/app (round trip 2 ms)"),
    ok("pooler", "prepared statements stay on one server session"),
    ok("install", INSTALLED),
    { name: "worker", status: "fail", detail: "the last heartbeat was 5 minutes ago" },
  ]);
  const messagesDoctor = scripted([
    ok("database", "connected to support as facetdb_worker over TLS"),
    ok(
      "install",
      "3 marked columns on support.support_messages, the jobs table and the marker row are there",
    ),
  ]);
  const sources: SourceFacts[] = options.sources?.([listingsDoctor, messagesDoctor]) ?? [
    {
      name: "listings",
      read: READ,
      questions: 2,
      version: 3,
      table: table({ doctor: listingsDoctor.run, estimateRows: () => Promise.resolve(4_137) }),
    },
    {
      name: "support_messages",
      read: ["subject", "body", "channel"],
      questions: 3,
      version: 1,
      table: table({
        database: "MySQL",
        pushWakeup: false,
        label: "support.support_messages",
        login: { kind: "user", user: "facetdb_worker", reach: "columns" },
        doctor: messagesDoctor.run,
      }),
    },
    {
      name: "support_tickets",
      read: ["subject", "body"],
      questions: 1,
      version: 2,
      table: undefined,
    },
  ];
  const door: DashboardDoor = {
    projectId: PROJECT,
    // $25 a month at $0.042 per million input tokens, pausing at the cap.
    cap:
      options.cap === null
        ? undefined
        : (options.cap ?? { inputTokens: 595_238_096, onCapReached: "pause" }),
    sources,
    stopped: [],
  };
  const deps = { door, reads: readsOf(world), doctors: createDoctors(clock), clock };
  const appFor = (studioProject: string) =>
    createApp({
      keys,
      check: NO_CHECK,
      config: NO_CONFIG,
      data: {
        runs: { list: () => Promise.reject(new Error("these tests read no runs")) },
        decisions: {
          search: () => Promise.reject(new Error("these tests search no decisions")),
          why: () => Promise.reject(new Error("these tests explain no record")),
        },
        home: createHomeService(deps),
        sources: createSourcesService(deps),
        alerts: { alerts: () => Promise.reject(new Error("these tests read no alerts")) },
        access: { access: () => Promise.reject(new Error("these tests read no studio access")) },
      },
      studio: localStudio(studioProject),
      review: NO_REVIEW,
      newRequestId: () => "req-1",
    });
  const app = appFor(PROJECT);
  // A studio wired to another project than the door's, as another project's key once was.
  const other = appFor("another");

  // The pages are the studio's: a call from this machine is the OS user's; `null` is a stranger
  // elsewhere with no session.
  async function get(path: string, authorization: string | null = KEY) {
    const response = await (authorization === OTHER_KEY ? other : app).request(
      path,
      { headers: authorization === null ? {} : { authorization } },
      authorization === null ? ELSEWHERE : THIS_MACHINE,
    );
    return { status: response.status, json: (await response.json()) as unknown };
  }
  return {
    clock,
    world,
    doctors: { listings: listingsDoctor, messages: messagesDoctor },
    get,
    home: async () => {
      const response = await get("/v1/home");
      expect(response.status).toBe(200);
      return response.json as Home;
    },
    sources: async () => {
      const response = await get("/v1/sources");
      expect(response.status).toBe(200);
      return (response.json as { readonly sources: readonly SourceRow[] }).sources;
    },
  };
}

const event = (
  overrides: Partial<AlertEvent> & Pick<AlertEvent, "kind" | "what" | "did">,
): AlertEvent => ({
  project: PROJECT,
  source: "listings",
  question: null,
  link: "https://docs.facetdb.dev/fix/backfill",
  ...overrides,
});

/** The mockup's Home: a busy, healthy day. */
function busyDay(world: World): void {
  world.heartbeat = NOW - 2_400;
  world.answered.set(TODAY, 12_480);
  world.answered.set(TODAY - DAY_MS, 20_100);
  world.queue = { waiting: 37, oldestSince: NOW - 14 * 60_000 - 30_000 };
  world.decided = { records: 212, reviewers: 3 };
  // $3.20 of model usage.
  world.tokens = 76_190_477;
  world.history = [
    {
      at: Date.UTC(2026, 10, 5, 14, 10),
      key: "backfill_finished|marketplace|listings|",
      phase: "raised",
      severity: "information",
      event: event({
        kind: "backfill_finished",
        what: "The backfill finished: 50000 records queued for the worker, 0 answered.",
        did: "Every page was settled; the cursor is cleared.",
      }),
      delivered: true,
    },
    {
      at: Date.UTC(2026, 10, 4, 23, 9),
      key: "model_failing|marketplace|support_messages|",
      phase: "resolved",
      severity: "information",
      event: event({
        kind: "model_failing",
        source: "support_messages",
        what: "6 of 100 model calls failed in the last 5 minutes.",
        did: "Retrying with backoff; a record that cannot be answered is marked error and asked again.",
        link: "https://docs.facetdb.dev/fix/worker",
      }),
      delivered: true,
    },
  ];
}

describe("GET /v1/home", () => {
  it("says every figure in the words of the Home mockup", async () => {
    const t = rig();
    busyDay(t.world);
    const home = await t.home();

    expect(home.health).toEqual({
      status: "running",
      words: "Running",
      heartbeatAgeMs: 2_400,
      checks: [
        { name: "worker", status: "ok", words: "Worker beating, 2 s ago" },
        { name: "model", status: "ok", words: "Model healthy" },
        { name: "sources", status: "ok", words: "Three sources, reachable and installed" },
      ],
      sources: [
        { name: "listings", verdict: "healthy", words: "as installed" },
        { name: "support_messages", verdict: "healthy", words: "as installed" },
        {
          name: "support_tickets",
          verdict: "healthy",
          words: "answered through POST /v1/check, with no database to check",
        },
      ],
    });
    expect(home.answered).toEqual({
      today: 12_480,
      yesterday: 20_100,
      fraction: 12_480 / 20_100,
      words: { figure: "12,480", sub: "62% of yesterday's 20,100." },
    });
    expect(home.queue).toEqual({
      waiting: 37,
      oldestWaitMs: 14 * 60_000 + 30_000,
      decidedToday: 212,
      reviewersToday: 3,
      words: { figure: "37", sub: "Oldest 14 minutes. Three reviewers decided 212 today." },
    });
    expect(home.spending).toMatchObject({
      status: "ok",
      month: "2026-11",
      inputTokens: 76_190_477,
      cap: { inputTokens: 595_238_096, onCapReached: "pause" },
      warningAt: 0.8,
      words: {
        figure: "76.2M of 595M",
        sub: "Input tokens this month: 13% of the monthly cap, about $3.20 of $25. The project pauses at 100%.",
      },
    });
    expect(home.spending.fraction).toBeCloseTo(0.128, 3);
    expect(home.alerts).toEqual([
      {
        at: "2026-11-05T14:10:00.000Z",
        phase: "raised",
        severity: "information",
        badge: "Information",
        title: "Backfill finished",
        words:
          "listings: The backfill finished: 50000 records queued for the worker, 0 answered. Every page was settled; the cursor is cleared.",
        what: "The backfill finished: 50000 records queued for the worker, 0 answered.",
        project: PROJECT,
        source: "listings",
        question: null,
        did: "Every page was settled; the cursor is cleared.",
        link: "https://docs.facetdb.dev/fix/backfill",
      },
      expect.objectContaining({
        at: "2026-11-04T23:09:00.000Z",
        phase: "resolved",
        badge: "Resolved",
        title: "Model failing",
        source: "support_messages",
      }),
    ]);
    // The log and the queue are read for the project's own sources, by their store ids.
    const ids = ["listings", "support_messages", "support_tickets"].map((name) =>
      sourceIdOf(PROJECT, name),
    );
    expect(t.world.scopes.every((scope) => JSON.stringify(scope) === JSON.stringify(ids))).toBe(
      true,
    );
  });

  it("with no heartbeat for 2 minutes says the worker is not running, in the alert's words", async () => {
    const t = rig();
    busyDay(t.world);
    t.world.heartbeat = NOW - 2 * 60_000;
    const home = await t.home();
    expect(home.health.status).toBe("attention");
    expect(home.health.words).toBe("Worker not running");
    expect(home.health.checks[0]).toEqual({
      name: "worker",
      status: "fail",
      words:
        "Worker not running. The worker has sent no heartbeat for 2 minutes. The last beat was 2 minutes ago.",
    });
    expect(home.health.heartbeatAgeMs).toBe(2 * 60_000);

    // A second short of 2 minutes it still beats.
    t.world.heartbeat = NOW - 2 * 60_000 + 1_000;
    expect((await t.home()).health.checks[0]).toMatchObject({
      status: "ok",
      words: "Worker beating, 119 s ago",
    });
  });

  it("says the worker is not running when none has ever beat for the project", async () => {
    const t = rig();
    const home = await t.home();
    expect(home.health.words).toBe("Worker not running");
    expect(home.health.heartbeatAgeMs).toBeNull();
    expect(home.health.checks[0]?.words).toBe(
      "Worker not running. The worker has sent no heartbeat for 2 minutes. None has beat for this project yet.",
    );
  });

  it("says the model is failing while its alert is active, with the failure rate of the last 5 minutes", async () => {
    const t = rig();
    busyDay(t.world);
    t.world.failing = [
      event({
        kind: "model_failing",
        source: "support_messages",
        what: "6 of 100 model calls failed in the last 5 minutes.",
        did: "Retrying with backoff.",
      }),
    ];
    const home = await t.home();
    expect(home.health.words).toBe("Model failing");
    expect(home.health.checks[1]).toEqual({
      name: "model",
      status: "fail",
      words: "Model failing. support_messages: 6 of 100 model calls failed in the last 5 minutes.",
    });
  });

  it("says a source whose doctor fails has lost access, in doctor's words, and a warning without failing", async () => {
    const t = rig();
    busyDay(t.world);
    t.doctors.messages.checks = [
      {
        name: "database",
        status: "fail",
        detail:
          '"support_messages" cannot connect to support: Access denied for user facetdb_worker',
        fix: "check the password",
      },
      { name: "install", status: "skip", detail: "not checked: the database check did not pass" },
    ];
    t.doctors.listings.checks = [
      ok("database", "logged in"),
      { name: "distance", status: "warn", detail: DISTANCE },
    ];
    const home = await t.home();
    expect(home.health.words).toBe("Connector lost access");
    expect(home.health.checks[2]).toEqual({
      name: "sources",
      status: "fail",
      words:
        'Connector lost access. support_messages: "support_messages" cannot connect to support: Access denied for user facetdb_worker',
    });
    expect(home.health.sources.map((source) => source.verdict)).toEqual([
      "warning",
      "failing",
      "healthy",
    ]);
  });

  it("says sources that answer with one far away as reachable and installed, then the doctor's warning", async () => {
    const t = rig();
    busyDay(t.world);
    t.doctors.listings.checks = [
      ok("database", "logged in"),
      { name: "distance", status: "warn", detail: DISTANCE },
    ];
    const home = await t.home();
    expect(home.health.checks[2]).toEqual({
      name: "sources",
      status: "warn",
      words: `Three sources, reachable and installed; listings: ${DISTANCE}`,
    });
  });

  it("@timing runs each source's doctor at most once a minute, shared by Home and Sources", async () => {
    const t = rig();
    await t.home();
    await t.sources();
    expect(t.doctors.listings.runs).toBe(1);
    t.clock.advance(DOCTOR_FRESH_MS - 1);
    await t.home();
    expect(t.doctors.listings.runs).toBe(1);
    t.clock.advance(1);
    await t.home();
    expect(t.doctors.listings.runs).toBe(2);
  });

  it("says none where there is nothing to count, never a bare 0", async () => {
    const t = rig({ cap: null });
    t.world.heartbeat = NOW;
    const home = await t.home();
    expect(home.answered).toEqual({
      today: 0,
      yesterday: 0,
      fraction: null,
      words: { figure: "None", sub: "None were answered yesterday." },
    });
    expect(home.queue.words).toEqual({ figure: "None", sub: "No card is waiting." });
    expect(home.queue.oldestWaitMs).toBeNull();
    expect(home.spending).toMatchObject({
      status: "uncapped",
      cap: null,
      fraction: null,
      words: {
        figure: "0",
        sub: "Input tokens this month, $0. No monthly cap is set, so the project never pauses.",
      },
    });
    expect(home.alerts).toEqual([]);
  });

  it("words the spending cap at the warning, at the cap paused, and at the cap continuing", async () => {
    const cap = { inputTokens: 1_000_000, onCapReached: "pause" } as const;
    const warned = rig({ cap });
    warned.world.tokens = 800_000;
    expect((await warned.home()).spending).toMatchObject({
      status: "warned",
      words: {
        figure: "800k of 1M",
        sub: "Input tokens this month: 80% of the monthly cap, past the 80% warning, about $0.03 of $0.04. The project pauses at 100%.",
      },
    });
    warned.world.tokens = 799_999;
    expect((await warned.home()).spending).toMatchObject({
      status: "ok",
      words: {
        sub: "Input tokens this month: 79% of the monthly cap, about $0.03 of $0.04. The project pauses at 100%.",
      },
    });
    warned.world.tokens = 999_999;
    expect((await warned.home()).spending.words.sub).toBe(
      "Input tokens this month: 99% of the monthly cap, past the 80% warning, about $0.04 of $0.04. The project pauses at 100%.",
    );
    warned.world.tokens = 1_000_000;
    expect((await warned.home()).spending).toMatchObject({
      status: "paused",
      fraction: 1,
      words: {
        sub: "Input tokens this month: the monthly cap is reached (about $0.04), so the project is paused until the month resets or the cap changes.",
      },
    });

    const continuing = rig({ cap: { ...cap, onCapReached: "continue" } });
    continuing.world.tokens = 1_200_000;
    expect((await continuing.home()).spending).toMatchObject({
      status: "continuing",
      fraction: 1,
      // What the worker does at 100%, as it started: the Settings page compares it with the file.
      cap: { inputTokens: 1_000_000, onCapReached: "continue" },
      words: {
        sub: "Input tokens this month: the monthly cap is reached (about $0.05); the project keeps answering, as the config says.",
      },
    });
    continuing.world.tokens = 10;
    expect((await continuing.home()).spending.words).toEqual({
      figure: "10 of 1M",
      sub: "Input tokens this month: 0% of the monthly cap, less than $0.01 of $0.04. The project keeps answering past 100%.",
    });
  });

  it("answers only the project's own key, in the one error shape", async () => {
    const t = rig();
    expect(await t.get("/v1/home", OTHER_KEY)).toEqual({
      status: 404,
      json: {
        error: {
          code: "unknown_project",
          message: "This API key belongs to a project this worker does not serve.",
          fix: "Use a key made by `facetdb keys add` in this project's directory.",
        },
      },
    });
    expect(await t.get("/v1/home", null)).toMatchObject({
      status: 401,
      json: { error: { code: "sign-in" } },
    });
    expect(t.doctors.listings.runs).toBe(0);
  });
});

describe("GET /v1/sources", () => {
  function sourcesDay(world: World): void {
    world.lastChange.set(sourceIdOf(PROJECT, "listings"), NOW - 12_000);
    world.lastChange.set(sourceIdOf(PROJECT, "support_messages"), NOW - 3 * 60_000);
    world.cursors = [
      { run: `backfill:${PROJECT}:listings:all@v2`, done: true },
      { run: `backfill:${PROJECT}:listings:all@v3`, done: false },
      { run: `backfill:${PROJECT}:support_messages:all@v1`, done: true },
    ];
    world.answeredUnder.set(`${sourceIdOf(PROJECT, "listings")}@3`, 41_200);
    world.answeredUnder.set(`${sourceIdOf(PROJECT, "support_messages")}@1`, 8_900);
    world.finishedAt.set("support_messages", Date.UTC(2026, 10, 3, 9, 0));
  }

  it("says each source in the words of the Sources mockup", async () => {
    const t = rig();
    sourcesDay(t.world);
    const [listings, messages, tickets] = await t.sources();

    expect(listings).toEqual({
      name: "listings",
      kind: "table",
      connector: "Postgres, trigger",
      install: { status: "ok", words: INSTALLED },
      verdict: "healthy",
      how: {
        label: "Wakes",
        words: "Instantly, on the trigger's notification. Last change seen 12 seconds ago.",
      },
      lastChangeAt: "2026-11-05T14:09:48.000Z",
      answers: "Inline columns on public.listings. Two questions, version 3.",
      // The database's own estimate, as it gave it; the page rounds it.
      rows: 4_137,
      backfill: {
        state: "part-way",
        fraction: null,
        answered: 41_200,
        version: 3,
        finishedAt: null,
        words:
          "Part way through the whole question set, newest first: 41,200 records answered under version 3 so far. The next run resumes where this one stopped.",
      },
      login: {
        label: "Login",
        words:
          "facetdb_worker reads title, description, price and seller_age_days, and writes only FacetDB's own columns.",
      },
    });
    expect(messages).toMatchObject({
      connector: "MySQL, trigger",
      // An engine with no estimate, or a table never analysed: none is made up.
      rows: null,
      how: {
        label: "Wakes",
        words: "Within a second, on the poll of facetdb_jobs. Last change seen 3 minutes ago.",
      },
      answers: "Inline columns on support.support_messages. Three questions, version 1.",
      backfill: {
        state: "finished",
        fraction: 1,
        answered: 8_900,
        finishedAt: "2026-11-03T09:00:00.000Z",
        words: "Finished the whole question set: 8,900 records answered under version 1.",
      },
      login: {
        words:
          "facetdb_worker reads subject, body and channel, and writes only FacetDB's own columns.",
      },
    });
    expect(tickets).toEqual({
      name: "support_tickets",
      kind: "api",
      connector: "API",
      install: null,
      verdict: "healthy",
      how: {
        label: "Arrives",
        words:
          "Your code sends each record to POST /v1/check and gets the answer back in about a second. No change seen yet.",
      },
      lastChangeAt: null,
      answers: "Kept in the FacetDB store. One question, version 2. Unsure records land in Review.",
      rows: null,
      backfill: {
        state: "none",
        fraction: null,
        answered: null,
        version: null,
        finishedAt: null,
        words: "None: records arrive one by one.",
      },
      login: null,
    });
  });

  it("reports none for a table source with no backfill cursor, not 0%, and never reads another source's", async () => {
    const t = rig();
    // A source whose name extends this one's: its run key begins with listings' prefix.
    t.world.cursors = [{ run: `backfill:${PROJECT}:listings:archive:all@v1`, done: false }];
    const [listings] = await t.sources();
    expect(listings?.backfill).toEqual({
      state: "none",
      fraction: null,
      answered: null,
      version: null,
      finishedAt: null,
      words: "None: no backfill has run on this source.",
    });
    expect(JSON.stringify(listings)).not.toContain("0%");
  });

  it("names a run of added questions, and the newest version's run first", async () => {
    const t = rig();
    t.world.cursors = [
      { run: `backfill:${PROJECT}:listings:all@v2`, done: false },
      { run: `backfill:${PROJECT}:listings:only@v3:is_scam`, done: false },
    ];
    t.world.answeredUnder.set(`${sourceIdOf(PROJECT, "listings")}@3`, 12);
    const [listings] = await t.sources();
    expect(listings?.backfill).toMatchObject({
      state: "part-way",
      version: 3,
      words:
        "Part way through the added questions, newest first: 12 records answered under version 3 so far. The next run resumes where this one stopped.",
    });
  });

  it("words each engine's change capture and the reach of its login", async () => {
    const doctor = () => Promise.resolve([] as readonly DoctorCheck[]);
    const t = rig({
      sources: () => [
        {
          name: "orders",
          read: ["note"],
          questions: 1,
          version: 1,
          table: table({
            database: "SQL Server",
            capture: "change-tracking",
            pushWakeup: false,
            label: "dbo.orders",
            storage: "side-table",
            doctor,
          }),
        },
        {
          name: "reviews",
          read: ["text"],
          questions: 1,
          version: 1,
          table: table({
            database: "MongoDB",
            capture: "change-stream",
            label: "app.reviews",
            answersIn: "fields",
            login: { kind: "user", user: "facetdb_worker", reach: "table" },
            doctor,
          }),
        },
        {
          name: "tickets",
          read: ["body"],
          questions: 1,
          version: 1,
          table: table({
            database: "Oracle",
            capture: "polling",
            pushWakeup: false,
            label: "APP.TICKETS",
            login: { kind: "user", user: "FACETDB_WORKER", reach: "reads-table" },
            doctor,
          }),
        },
        {
          name: "notes",
          read: ["body"],
          questions: 1,
          version: 1,
          table: table({
            database: "SQLite",
            pushWakeup: false,
            label: "notes",
            login: { kind: "file" },
            doctor,
          }),
        },
        {
          name: "posts",
          read: ["body"],
          questions: 1,
          version: 1,
          table: table({
            database: "libSQL",
            pushWakeup: false,
            label: "posts",
            login: { kind: "token", variable: "POSTS_URL_AUTH_TOKEN" },
            doctor,
          }),
        },
      ],
    });
    const rows = await t.sources();
    expect(
      rows.map((row) => [row.connector, row.how.words, row.answers, row.login?.words, row.install]),
    ).toEqual([
      [
        "SQL Server, Change Tracking",
        "Within a second, on the poll of SQL Server's Change Tracking. No change seen yet.",
        "In a side table beside dbo.orders. One question, version 1.",
        "facetdb_worker reads note, and writes only its side table.",
        null,
      ],
      [
        "MongoDB, change stream",
        "Instantly, on the collection's change stream. No change seen yet.",
        "Inline fields on app.reviews. One question, version 1.",
        "facetdb_worker may read and update every field of app.reviews, as the database grants no narrower right; FacetDB writes only its own fields.",
        null,
      ],
      [
        "Oracle, polling",
        "Within 10 seconds, on a poll for rows whose state changed. No change seen yet.",
        "Inline columns on APP.TICKETS. One question, version 1.",
        "FACETDB_WORKER reads every column of APP.TICKETS, and writes only FacetDB's own columns.",
        null,
      ],
      [
        "SQLite, trigger",
        "Within a second, on the poll of facetdb_jobs. No change seen yet.",
        "Inline columns on notes. One question, version 1.",
        "No login: the worker opens the database file, so this machine's permissions on the file are the limit.",
        null,
      ],
      [
        "libSQL, trigger",
        "Within a second, on the poll of facetdb_jobs. No change seen yet.",
        "Inline columns on posts. One question, version 1.",
        "No login: the worker connects with the auth token in POSTS_URL_AUTH_TOKEN, which reaches the whole database.",
        null,
      ],
    ]);
  });

  it("answers only the project's own key", async () => {
    const t = rig();
    expect(await t.get("/v1/sources", OTHER_KEY)).toMatchObject({
      status: 404,
      json: { error: { code: "unknown_project" } },
    });
  });
});
