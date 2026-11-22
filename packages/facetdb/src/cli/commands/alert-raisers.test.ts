import {
  type AlertRecord,
  type AlertStore,
  createAlerts,
  type DatabaseEngine,
  type DoctorCheck,
  EngineRefusal,
  eventKey,
  type PassReport,
} from "@facetdb/core";
import { FakeAlertStore } from "@facetdb/core/testing";
import { doctorVerdict, hideSecrets, losesAccess, secretParts } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { facetdb, noul, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import { SourceAccessLost } from "../../plugin/index.ts";
import {
  createPgliteWorld,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type SqlConnect,
  SteppedClock,
} from "../testing.ts";
import {
  ACCESS_CHECK_EVERY_MS,
  CHANGES_MAX,
  changesWords,
  createAlertRaisers,
  refusalOf,
  type WatchedSource,
} from "./alert-raisers.ts";
import { engineTarget, projectRef, questionSetOf } from "./database.ts";

/**
 * The two raisers of the running worker on the stepped clock, over core's alerts and an alert store
 * in memory: Connector lost access from each running table source's doctor every 5 minutes and from
 * a loop's refused login or credential, resolved when the source reads well again; Question set
 * changed when a source opens under a higher version, naming who changed what. A dropped or
 * disabled trigger is read by the Postgres engine's own doctor on PGlite. The worker's own wiring
 * is proven by the alert-raisers-*.test.ts files beside it.
 */

const START = 1_700_000_000_000;
const MINUTE = 60_000;
const PROJECT = "proj-listings";
const PASSWORD = "s3cret-worker-pass";
const SOURCE_URL = `postgres://facetdb_worker:${PASSWORD}@db.internal:5432/app`;
const ACCESS_LINK = "https://studio.example.com/sources";

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: SOURCE_URL,
      table: "listings",
      read: ["id", "title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

function sourceOf(project: ProjectConfig, name = "listings"): SourceConfig {
  const found = project.sources.find((source) => source.name === name);
  if (found === undefined) {
    throw new Error(`the test config has a source ${name}`);
  }
  return found;
}

const LISTINGS = sourceOf(config);

/** The project with the listings source's questions replaced. */
function withQuestions(questions: SourceConfig["questions"]): ProjectConfig {
  return { ...config, sources: [{ ...LISTINGS, questions }] };
}

/** The listings source's question set with these questions, as its loop would run it. */
function setOf(questions: SourceConfig["questions"]) {
  const project = withQuestions(questions);
  return questionSetOf(project, sourceOf(project));
}

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });

const HEALTHY: readonly DoctorCheck[] = [
  ok("database", "logged in as facetdb_worker: listings on db.internal/app (round trip 3 ms)"),
  {
    name: "pooler",
    status: "skip",
    detail: "not checked from the worker, whose own pool is open on this database",
  },
  ok("capture", "facetdb schema, jobs table and trigger are in place, the trigger enabled"),
  ok(
    "install",
    "answer columns are in place, and the trigger watches the columns the questions read",
  ),
  { name: "worker", status: "skip", detail: "not checked here" },
];

/** A right the install granted, taken away (the doctor of an engine that reads the grants). */
const REVOKED: readonly DoctorCheck[] = [
  ok("database", "logged in as facetdb_worker: listings on db.internal/app (round trip 3 ms)"),
  {
    name: "grants",
    status: "fail",
    detail: "facetdb_worker may no longer update the answer column is_scam of listings",
    fix: "run facetdb migrate: it grants the worker login its rights again",
  },
  ok("install", "facetdb schema, jobs table, trigger and answer columns are in place"),
];

/** The password rotated: the doctor's own words quote the driver's, and the driver quoted the URL. */
const ROTATED: readonly DoctorCheck[] = [
  {
    name: "database",
    status: "fail",
    detail: `"listings" cannot connect to db.internal:5432/app: password authentication failed for user "facetdb_worker" (${SOURCE_URL})`,
    fix: "check the host, port, user and password in LISTINGS_URL",
    unreachable: true,
  },
  { name: "install", status: "skip", detail: "not checked: the database check did not pass" },
  { name: "worker", status: "fail", detail: "the store could not be read" },
];

/** The install behind the file: a question added and not migrated yet. */
const BEHIND: readonly DoctorCheck[] = [
  ok("database", "logged in as facetdb_worker: listings on db.internal/app (round trip 3 ms)"),
  {
    name: "install",
    status: "fail",
    detail: "listings: public.listings lacks the answer columns urgency",
    fix: "run facetdb migrate",
  },
];

/** The store's alert lines, with a switch that makes every read and write of it fail. */
class FlakyAlertStore extends FakeAlertStore {
  down = false;
  /** How many times an active alert was read: what a raise or a resolve costs the store first. */
  reads = 0;
  override getActive(key: string) {
    this.reads += 1;
    return this.down
      ? Promise.reject(new Error(`the store at ${SOURCE_URL} is unreachable`))
      : super.getActive(key);
  }
  override append(record: AlertRecord) {
    return this.down
      ? Promise.reject(new Error(`the store at ${SOURCE_URL} is unreachable`))
      : super.append(record);
  }
}

/**
 * One worker's raisers over its own alerts module; `shared` gives two workers the one store and
 * clock of their project, as two processes on one store share them.
 */
function setup(
  sources: readonly WatchedSource[] = [],
  shared?: { readonly clock: SteppedClock; readonly store: FlakyAlertStore },
) {
  const clock = shared?.clock ?? new SteppedClock(START);
  const store = shared?.store ?? new FlakyAlertStore(clock);
  const alerts = createAlerts({ store: store satisfies AlertStore, clock, channels: [] });
  const lines: string[] = [];
  const state = { sources: [...sources] };
  const raisers = createAlertRaisers({
    alerts,
    active: (key) => store.getActive(key),
    clock,
    project: PROJECT,
    links: {
      access: () => ACCESS_LINK,
      questionSet: (source) => `https://studio.example.com/questions?source=${source}`,
    },
    sources: () => state.sources,
    hide: (text) => hideSecrets(text, secretParts(SOURCE_URL)),
    print: (line) => lines.push(line),
    configPath: "/work/listings-app/facetdb.config.ts",
  });
  return { clock, store, raisers, lines, state };
}

/**
 * A pass as core reports it: when it began, how many records it answered, skipped and wrote again,
 * and what failed.
 */
function pass(
  began: number,
  options: {
    readonly wrote?: number;
    readonly skipped?: number;
    readonly again?: number;
    readonly failures?: PassReport["failures"];
  } = {},
): Pick<PassReport, "startedAt" | "failures" | "written" | "skipped" | "alreadyAnswered"> {
  const keys = (count = 0, prefix = "r") =>
    Array.from({ length: count }, (_, index) => `${prefix}${index}`);
  return {
    startedAt: began,
    failures: options.failures ?? [],
    written: keys(options.wrote),
    skipped: keys(options.skipped, "blank"),
    alreadyAnswered: keys(options.again, "again"),
  };
}

/** A table source whose doctor answers `checks()`, counting its runs. */
function table(checks: () => readonly DoctorCheck[]) {
  const runs = { count: 0 };
  const source: WatchedSource = {
    kind: "table",
    name: "listings",
    doctor: () => {
      runs.count += 1;
      return Promise.resolve(checks());
    },
  };
  return { source, runs };
}

/** Moves the clock to the next look and waits for the run to sleep toward the one after. */
async function tick(clock: SteppedClock): Promise<void> {
  clock.advance(ACCESS_CHECK_EVERY_MS);
  const next = clock.now() + ACCESS_CHECK_EVERY_MS;
  await vi.waitFor(() => expect(clock.pending()).toContain(next), { timeout: 5_000 });
}

const lostKey = eventKey({
  kind: "connector_lost_access",
  project: PROJECT,
  source: "listings",
  question: null,
});

/** Every secret the tests plant, searched in whatever an alert or a line carries. */
function expectNoSecret(text: string): void {
  for (const secret of [PASSWORD, SOURCE_URL, "facetdb_worker:", "db.internal"]) {
    expect(text).not.toContain(secret);
  }
}

describe("Connector lost access from the worker's own reading every 5 minutes", () => {
  it("@timing raises a revoked right once and not again inside 30 minutes, again after 30, and the fix resolves it", async () => {
    let checks = HEALTHY;
    const { source, runs } = table(() => checks);
    const t = setup([source]);
    const stop = new AbortController();
    const running = t.raisers.run(stop.signal);

    // Nothing is read before the first 5 minutes: the start's own checks are the loop's.
    await vi.waitFor(() => expect(t.clock.pending()).toEqual([START + ACCESS_CHECK_EVERY_MS]));
    expect(runs.count).toBe(0);
    await tick(t.clock);
    expect(runs.count).toBe(1);
    expect(t.store.history).toEqual([]);

    checks = REVOKED;
    await tick(t.clock);
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised"]);
    const [raised] = t.store.history;
    expect(raised?.severity).toBe("critical");
    expect(raised?.event).toMatchObject({
      kind: "connector_lost_access",
      project: PROJECT,
      source: "listings",
      question: null,
      link: ACCESS_LINK,
    });
    // The doctor's words, the login the connection string names hidden as every part of it is.
    expect(raised?.event.what).toBe(
      "The worker cannot use the database of listings: its grants check fails: [hidden] may no longer update the answer column is_scam of listings.",
    );
    expect(raised?.event.did).toContain("the other sources keep running");
    const raisedAt = t.clock.now();

    // Read at every look, said once per 30 minutes: 25 minutes on, still the one line.
    for (let look = 0; look < 5; look += 1) {
      await tick(t.clock);
    }
    expect(t.clock.now() - raisedAt).toBe(25 * MINUTE);
    expect(t.store.history).toHaveLength(1);
    await tick(t.clock);
    expect(t.clock.now() - raisedAt).toBe(30 * MINUTE);
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "raised"]);

    // The grant given back: the next look resolves it, once.
    checks = HEALTHY;
    await tick(t.clock);
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "raised", "resolved"]);
    expect(t.store.active.has(lostKey)).toBe(false);
    await tick(t.clock);
    expect(t.store.history).toHaveLength(3);
    // One doctor run per look, never more.
    expect(runs.count).toBe(10);

    stop.abort();
    await running;
    expect(t.clock.pending()).toEqual([]);
    expect(t.lines).toEqual([]);
  });

  it("names the failed check in the words Home shows, with the connection string hidden", async () => {
    const { source } = table(() => ROTATED);
    const t = setup([source]);

    await t.raisers.look();

    const [raised] = t.store.history;
    // Home's verdict of the same checks: the same failed check, its words the same once hidden.
    const home = doctorVerdict(ROTATED);
    expect(home.failedCheck).toBe("database");
    expect(raised?.event.what).toContain("its database check fails: ");
    expect(raised?.event.what).toContain(
      hideSecrets(home.words, secretParts(SOURCE_URL)).replace(/\.$/, ""),
    );
    expect(raised?.event.what).toContain("password authentication failed for user");
    // The heartbeat check is Home's own line, never the source's verdict.
    expect(raised?.event.what).not.toContain("store could not be read");
    expectNoSecret(JSON.stringify(t.store.history));
    expectNoSecret(JSON.stringify(t.store.active.get(lostKey)));
  });

  it("stays silent for an install behind the file, and resolves lost access once the database answers again with its install behind", async () => {
    let checks = BEHIND;
    const { source } = table(() => checks);
    const t = setup([source]);

    await t.raisers.look();
    expect(t.store.history).toEqual([]);

    checks = ROTATED;
    await t.raisers.look();
    checks = BEHIND;
    await t.raisers.look();
    // The login works again: what is missing now is migrate's, and nothing is raised for it.
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
    await t.raisers.look();
    expect(t.store.history).toHaveLength(2);
  });

  it("reads table sources only: an API source has no doctor, and a plugin source none to read", async () => {
    const { source, runs } = table(() => REVOKED);
    const t = setup([source, { kind: "plugin", name: "issues" }]);
    await t.raisers.look();
    expect(runs.count).toBe(1);
    expect(t.store.history.map((line) => line.event.source)).toEqual(["listings"]);
  });

  it("says a look it cannot record, hidden, stops nothing, and the next look records", async () => {
    const { source } = table(() => REVOKED);
    const t = setup([source]);
    t.store.down = true;

    await t.raisers.look();

    expect(t.lines).toHaveLength(1);
    expect(t.lines[0]).toContain(
      "listings: the worker's check of its access could not be made or recorded: the store at [hidden] is unreachable",
    );
    expectNoSecret(t.lines.join("\n"));
    t.store.down = false;
    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised"]);
  });
});

describe("Connector lost access from a dropped or disabled trigger, as the Postgres engine's doctor reads it", () => {
  /** On this machine, so the doctor connects without TLS as a worker would to a local database. */
  const LOCAL_URL = `postgres://facetdb_worker:${PASSWORD}@localhost:5432/app`;
  const ADMIN_URL = "postgres://admin@localhost:5432/app";
  const PROJECT_DIR = "/work/listings-app";

  /** Two table sources on one database, so a raise is seen to be the broken one's alone. */
  const twoSources = (
    questions: Readonly<Record<string, ReturnType<typeof noul>>>,
  ): ProjectConfig =>
    facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database: LOCAL_URL,
          table: "listings",
          read: ["id", "title"],
          questions,
        },
        {
          name: "offers",
          database: LOCAL_URL,
          table: "offers",
          read: ["id", "title"],
          questions: { is_spam: noul("Is this offer spam?") },
        },
      ],
    });
  const AS_INSTALLED = twoSources({ is_scam: noul("Is this listing a scam?") });
  /** A question added to listings in the file and not migrated yet: an install behind the file. */
  const ADDED = twoSources({
    is_scam: noul("Is this listing a scam?"),
    is_urgent: noul("Is this listing urgent?"),
  });

  let world: PgliteWorld;

  beforeAll(async () => {
    world = await createPgliteWorld();
  });

  afterEach(async () => {
    await resetPgliteWorld(world);
  });

  afterAll(async () => {
    await world.close();
  });

  /**
   * PGlite's one connection is a superuser's: the doctor asking who it is is told the worker login,
   * as the database the connection string names would tell it; every other statement runs as is.
   */
  const asWorkerLogin: SqlConnect = (url, options) => {
    const client = world.connect(url, options);
    return {
      ...client,
      query: (text, params) =>
        /^\s*select current_user::text as name\s*$/.test(text)
          ? Promise.resolve([{ name: "facetdb_worker" }])
          : client.query(text, params),
    };
  };

  async function postgres(): Promise<DatabaseEngine> {
    const [entry] = postgresEngines(asWorkerLogin);
    if (entry === undefined) {
      throw new Error("the test registers the Postgres engine");
    }
    return entry.load();
  }

  const targetOf = (project: ProjectConfig, name: string) =>
    engineTarget(
      project,
      { source: sourceOf(project, name), schema: "public", table: name },
      projectRef(PROJECT_DIR),
    );

  /** `facetdb migrate` of every source as the file holds it, by the admin (PGlite's superuser). */
  async function migrateAll(engine: DatabaseEngine, project: ProjectConfig, clock: SteppedClock) {
    const deps = {
      clock,
      allowInsecure: false,
      storeShared: false,
      workerPassword: "a-long-random-password",
    };
    for (const source of project.sources) {
      const target = targetOf(project, source.name);
      const plan = await engine.planInstall(target, ADMIN_URL, deps);
      if (!plan.ok) {
        throw new Error(`refused: ${plan.refusal.message}`);
      }
      expect((await engine.run(target, plan.plan, ADMIN_URL, deps)).stopped).toBeUndefined();
    }
  }

  /**
   * Both sources as the look reads them: the engine's doctor under the worker login, for the file
   * as `file()` holds it now, each run counted.
   */
  function watched(engine: DatabaseEngine, file: () => ProjectConfig, clock: SteppedClock) {
    const runs: string[] = [];
    const sources = ["listings", "offers"].map(
      (name): WatchedSource => ({
        kind: "table",
        name,
        doctor: () => {
          runs.push(name);
          return engine.doctor(targetOf(file(), name), LOCAL_URL, {
            clock,
            allowInsecure: false,
            storeShared: false,
          });
        },
      }),
    );
    return { sources, runs };
  }

  async function installedWorld() {
    await world.client.query("create table public.listings (id text primary key, title text)");
    await world.client.query("create table public.offers (id text primary key, title text)");
    const engine = await postgres();
    const clock = new SteppedClock(START);
    await migrateAll(engine, AS_INSTALLED, clock);
    return { engine, clock };
  }

  const phases = (t: ReturnType<typeof setup>) =>
    t.store.history.map((line) => `${line.phase} ${line.event.source}`);

  it("raises a dropped trigger once at the look, for that source alone, in the capture check's words, and resolves after migrate", async () => {
    const { engine, clock } = await installedWorld();
    const file = { config: AS_INSTALLED };
    const { sources, runs } = watched(engine, () => file.config, clock);
    const t = setup(sources, { clock, store: new FlakyAlertStore(clock) });

    await t.raisers.look();
    expect(t.store.history).toEqual([]);

    await world.client.query("drop trigger facetdb_listings on public.listings");
    await t.raisers.look();
    expect(phases(t)).toEqual(["raised listings"]);
    const [raised] = t.store.history;
    expect(raised?.severity).toBe("critical");
    expect(raised?.event).toMatchObject({
      kind: "connector_lost_access",
      source: "listings",
      cause: "doctor",
      link: ACCESS_LINK,
    });
    // The moved fact in its own words, under the check's new name.
    expect(raised?.event.what).toBe(
      "The worker cannot use the database of listings: its capture check fails: listings: public.listings has no trigger facetdb_listings, so changes are not queued.",
    );
    // Read again at the next look, said once: the 30-minute rule is the alerts module's.
    await t.raisers.look();
    expect(t.store.history).toHaveLength(1);

    // facetdb migrate makes the trigger again: the next look resolves the alert, once.
    await migrateAll(engine, AS_INSTALLED, clock);
    await t.raisers.look();
    expect(phases(t)).toEqual(["raised listings", "resolved listings"]);
    await t.raisers.look();
    expect(t.store.history).toHaveLength(2);
    // One doctor run per source per look, five looks.
    expect(runs).toEqual(Array.from({ length: 5 }, () => ["listings", "offers"]).flat());
  });

  it("raises a disabled trigger as it does a dropped one, and resolves after migrate", async () => {
    const { engine, clock } = await installedWorld();
    const { sources } = watched(engine, () => AS_INSTALLED, clock);
    const t = setup(sources, { clock, store: new FlakyAlertStore(clock) });

    await world.client.query("alter table public.offers disable trigger facetdb_offers");
    await t.raisers.look();
    expect(phases(t)).toEqual(["raised offers"]);
    expect(t.store.history[0]?.event.what).toBe(
      "The worker cannot use the database of offers: its capture check fails: offers: the trigger facetdb_offers on public.offers is disabled.",
    );

    await migrateAll(engine, AS_INSTALLED, clock);
    await t.raisers.look();
    expect(phases(t)).toEqual(["raised offers", "resolved offers"]);
  });

  it("stays silent for an install behind the file, and raises a dropped trigger on it all the same", async () => {
    const { engine, clock } = await installedWorld();
    const file = { config: ADDED };
    const { sources } = watched(engine, () => file.config, clock);
    const t = setup(sources, { clock, store: new FlakyAlertStore(clock) });

    // A question added in the file and not migrated yet: the install check fails, and only it.
    const behind = doctorVerdict(
      await engine.doctor(targetOf(ADDED, "listings"), LOCAL_URL, {
        clock,
        allowInsecure: false,
        storeShared: false,
      }),
    );
    expect(behind).toMatchObject({ verdict: "failing", failedCheck: "install" });
    expect(behind.words).toBe(
      "listings: public.listings lacks the answer columns is_urgent, is_urgent_probability",
    );
    expect(losesAccess(behind)).toBe(false);
    await t.raisers.look();
    await t.raisers.look();
    expect(t.store.history).toEqual([]);

    // The trigger dropped on top: the capture fails first, so the source has lost access.
    await world.client.query("drop trigger facetdb_listings on public.listings");
    await t.raisers.look();
    expect(phases(t)).toEqual(["raised listings"]);
    expect(t.store.history[0]?.event.what).toContain("its capture check fails:");

    // The migrate that installs the added question makes the trigger again: resolved, then silent.
    await migrateAll(engine, ADDED, clock);
    await t.raisers.look();
    await t.raisers.look();
    expect(phases(t)).toEqual(["raised listings", "resolved listings"]);
  });
});

describe("Connector lost access at the failure of a loop", () => {
  /** A driver's refusal: the database's code, and words that quote the URL and the login. */
  const refused = (code: string) =>
    Object.assign(
      new Error(
        `password authentication failed for user "facetdb_worker" connecting to ${SOURCE_URL}`,
      ),
      { code },
    );

  it("raises a refused login at once, in fixed words with the database's code, never the driver's", async () => {
    const t = setup();

    t.raisers.stopped(LISTINGS, refused("28P01"));
    await t.raisers.settled();

    expect(t.store.history.map((line) => line.event.what)).toEqual([
      "The database of listings refused the worker login (code 28P01): its password, or its right to log in, changed.",
    ]);
    expect(t.store.history[0]?.event).toMatchObject({
      kind: "connector_lost_access",
      link: ACCESS_LINK,
      did: "Stopped listings alone: its records wait in its queue, the other sources keep running, and the worker tries it again after a wait.",
    });
    expectNoSecret(JSON.stringify(t.store.history));

    // The same source failing again within 30 minutes is the same alert.
    t.raisers.stopped(LISTINGS, refused("42501"));
    await t.raisers.settled();
    expect(t.store.history).toHaveLength(1);
  });

  it.each([
    ["PostgreSQL's invalid password", { code: "28P01" }, "login", "28P01"],
    ["PostgreSQL's role that may not log in", { code: "28000" }, "login", "28000"],
    ["PostgreSQL's revoked right", { code: "42501" }, "right", "42501"],
    [
      "MySQL's access denied",
      { code: "ER_ACCESS_DENIED_ERROR" },
      "login",
      "ER_ACCESS_DENIED_ERROR",
    ],
    [
      "MySQL's table right",
      { code: "ER_TABLEACCESS_DENIED_ERROR" },
      "right",
      "ER_TABLEACCESS_DENIED_ERROR",
    ],
    ["SQL Server's failed login", { code: "ELOGIN" }, "login", "ELOGIN"],
    ["SQL Server's denied permission", { code: "EREQUEST", number: 229 }, "right", "229"],
    [
      "MongoDB's failed authentication",
      { code: 18, codeName: "AuthenticationFailed" },
      "login",
      "AuthenticationFailed",
    ],
    ["MongoDB's unauthorized", { code: 13, codeName: "Unauthorized" }, "right", "Unauthorized"],
    ["Oracle's insufficient privileges", { code: "ORA-01031" }, "right", "ORA-01031"],
  ])("reads %s from its code", (_name, fields, kind, code) => {
    expect(refusalOf(Object.assign(new Error("words never read"), fields))).toEqual({
      kind,
      code,
    });
  });

  it("reads Oracle's refused login as the engine's own refusal, which is not tried again on a wait", async () => {
    const t = setup();
    const oracle = new EngineRefusal({
      code: "database-login",
      message: `Oracle refused the login of facetdb_worker on db.internal:1521/app (ORA-01017)`,
      fix: "check the user and the password",
    });
    expect(refusalOf(oracle)).toEqual({ kind: "login", code: "ORA-01017" });

    t.raisers.stopped(LISTINGS, oracle);
    await t.raisers.settled();
    expect(t.store.history[0]?.event.did).toContain(
      "the worker tries it again on Check again or a restart",
    );
    expectNoSecret(JSON.stringify(t.store.history));
  });

  it("raises nothing for a loop that failed for another reason", async () => {
    const t = setup();
    for (const error of [
      Object.assign(new Error("connection reset"), { code: "ECONNRESET" }),
      Object.assign(new Error("relation does not exist"), { code: "42P01" }),
      new EngineRefusal({ code: "one-worker", message: "another worker holds it", fix: "stop it" }),
      new Error(`the model is down at ${SOURCE_URL}`),
      "a string thrown",
      { code: "a code with spaces and 28P01" },
    ]) {
      t.raisers.stopped(LISTINGS, error);
    }
    await t.raisers.settled();
    expect(t.store.history).toEqual([]);
  });

  it("raises a plugin's refused credential in the source connector's words, and a SourceAccessLost in other words not at all", async () => {
    const t = setup();
    const issues: SourceConfig = { ...LISTINGS, name: "issues" };
    // What the plugin source's connector throws: FacetDB's words, naming the variable only.
    t.raisers.stopped(
      issues,
      new SourceAccessLost(
        "the plugin @facetdb/tracker (source issues of issues) lost access: the service it reads refused its credential in watch; check the variable TRACKER_TOKEN and the rights granted to it",
      ),
    );
    // One that reached the worker some other way, its message the plugin's own.
    const orders: SourceConfig = { ...LISTINGS, name: "orders" };
    t.raisers.stopped(orders, new SourceAccessLost("token trk_s3cret-token revoked"));
    await t.raisers.settled();

    expect(t.store.history.map((line) => line.event.what)).toEqual([
      "The plugin @facetdb/tracker (source issues of issues) lost access: the service it reads refused its credential in watch; check the variable TRACKER_TOKEN and the rights granted to it.",
      "The plugin that reads orders lost access: the service it reads refused its credential.",
    ]);
    expect(JSON.stringify(t.store.history)).not.toContain("trk_s3cret");
  });

  it("says a raise it could not record, hidden, and stops nothing", async () => {
    const t = setup();
    t.store.down = true;
    t.raisers.stopped(LISTINGS, refused("28P01"));
    await t.raisers.settled();
    expect(t.lines).toEqual([
      "listings: the Connector lost access alert could not be raised: the store at [hidden] is unreachable",
    ]);
  });

  it("keeps the cause on the stored alert, and is not resolved by a doctor that reads no rights, nor by a pass that wrote nothing, until a pass writes", async () => {
    const { source } = table(() => HEALTHY);
    const t = setup([source]);
    // PostgreSQL's doctor reads no rights: the loop's refused claim is what says one was revoked.
    t.raisers.stopped(LISTINGS, refused("42501"));
    await t.raisers.settled();
    expect(t.store.active.get(lostKey)?.event.cause).toBe("refusal");

    await t.raisers.look();
    expect(t.store.active.has(lostKey)).toBe(true);

    // The loop started again; its passes claim nothing: no proof.
    t.clock.advance(MINUTE);
    t.raisers.passed(LISTINGS, pass(t.clock.now()));
    await t.raisers.look();
    expect(t.store.active.has(lostKey)).toBe(true);

    // A pass of blank records only: their skip writes the status column alone, which says nothing
    // of a right on an answer column. No proof.
    t.raisers.passed(LISTINGS, pass(t.clock.now(), { skipped: 3 }));
    await t.raisers.look();
    expect(t.store.active.has(lostKey)).toBe(true);

    // A pass that wrote a record through the source: the next look resolves it.
    t.raisers.passed(LISTINGS, pass(t.clock.now(), { wrote: 1 }));
    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
  });

  it("takes a logged answer written again for proof, as it writes the answer columns", async () => {
    const { source } = table(() => HEALTHY);
    const t = setup([source]);
    t.raisers.stopped(LISTINGS, refused("42501"));
    await t.raisers.settled();
    t.clock.advance(MINUTE);
    t.raisers.passed(LISTINGS, pass(t.clock.now(), { again: 1 }));
    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
  });

  it("takes no pass that began before the alert for proof, though it was reported after", async () => {
    const { source } = table(() => HEALTHY);
    const t = setup([source]);
    const began = t.clock.now();
    t.clock.advance(MINUTE);
    // Another worker meets the refusal while this one's pass, begun a minute earlier, still runs.
    const other = setup([], { clock: t.clock, store: t.store });
    other.raisers.stopped(LISTINGS, refused("42501"));
    await other.raisers.settled();
    t.clock.advance(MINUTE);
    t.raisers.passed(LISTINGS, pass(began, { wrote: 1 }));
    await t.raisers.look();
    expect(t.store.active.has(lostKey)).toBe(true);
    // Its next pass began after the alert did: that one is proof.
    t.raisers.passed(LISTINGS, pass(t.clock.now(), { wrote: 1 }));
    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
  });

  it("takes no write made before the alert began for proof", async () => {
    const { source } = table(() => HEALTHY);
    const t = setup([source]);
    t.raisers.passed(LISTINGS, pass(t.clock.now(), { wrote: 1 }));
    t.clock.advance(MINUTE);
    // Another worker meets the refusal, a minute after this one's last write.
    const other = setup([], { clock: t.clock, store: t.store });
    other.raisers.passed(
      LISTINGS,
      pass(t.clock.now(), {
        failures: [{ key: "r1", stage: "record", error: refused("42501") }],
      }),
    );
    await other.raisers.settled();

    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised"]);
  });

  it("@timing raises once and resolves nothing in 30 minutes when one worker's writes are refused and another's passes are empty", async () => {
    // Two workers of one project on one store: the record the refused write released is claimed by
    // whichever polls first, so here one of them meets the refusal and the other claims nothing.
    const refusedWorker = setup([table(() => HEALTHY).source]);
    const shared = { clock: refusedWorker.clock, store: refusedWorker.store };
    const emptyWorker = setup([table(() => HEALTHY).source], shared);
    const failing = (began: number) =>
      pass(began, { failures: [{ key: "r1", stage: "record", error: refused("42501") }] });
    const stop = new AbortController();
    const running = [refusedWorker.raisers.run(stop.signal), emptyWorker.raisers.run(stop.signal)];
    const raisedAt = shared.clock.now();
    refusedWorker.raisers.passed(LISTINGS, failing(raisedAt));
    await refusedWorker.raisers.settled();

    // Passes every 2 seconds for 29 minutes, both workers' looks every 5 minutes among them.
    for (let second = 2; second < 29 * 60; second += 2) {
      const began = shared.clock.now();
      shared.clock.advance(2_000);
      refusedWorker.raisers.passed(LISTINGS, failing(began));
      emptyWorker.raisers.passed(LISTINGS, pass(began));
      if (second % 300 === 0) {
        await vi.waitFor(() =>
          expect(shared.clock.pending().filter((at) => at > shared.clock.now())).toHaveLength(2),
        );
        await refusedWorker.raisers.settled();
      }
    }
    expect(shared.clock.now() - raisedAt).toBeLessThan(30 * MINUTE);
    expect(shared.store.history.map((line) => line.phase)).toEqual(["raised"]);
    expect(shared.store.active.get(lostKey)?.event.cause).toBe("refusal");

    stop.abort();
    await Promise.all(running);
    expect(shared.clock.pending()).toEqual([]);
  });

  it("resolves a doctor's alert at the doctor's pass, whatever the passes did", async () => {
    let checks = ROTATED;
    const { source } = table(() => checks);
    const t = setup([source]);
    await t.raisers.look();
    expect(t.store.active.get(lostKey)?.event.cause).toBe("doctor");
    checks = HEALTHY;
    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
  });

  it("keeps a refusal's cause when the doctor raises the alert again past 30 minutes, so the doctor's pass does not resolve it", async () => {
    let checks = HEALTHY;
    const { source } = table(() => checks);
    const t = setup([source]);
    t.raisers.stopped(LISTINGS, refused("42501"));
    await t.raisers.settled();

    // 31 minutes on the doctor fails too (the database unreachable a while): its raise is sent,
    // the refusal it cannot see still stands, and the cause stays the refusal's.
    t.clock.advance(31 * MINUTE);
    checks = ROTATED;
    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "raised"]);
    expect(t.store.active.get(lostKey)?.event.cause).toBe("refusal");

    checks = HEALTHY;
    await t.raisers.look();
    expect(t.store.active.has(lostKey)).toBe(true);
    expect(t.store.history).toHaveLength(2);
  });

  it("raises a record's refused write from its pass, asks the store at most once per 5 minutes, and resolves after a pass that wrote", async () => {
    const { source } = table(() => HEALTHY);
    const t = setup([source]);
    const failing = () =>
      pass(t.clock.now(), {
        failures: [{ key: "r1", stage: "record", error: refused("42501") }],
      });

    t.raisers.passed(LISTINGS, failing());
    await t.raisers.settled();
    expect(t.store.history.map((line) => line.event.what)).toEqual([
      "The database of listings refused the worker login a right it uses (code 42501): a grant was taken away.",
    ]);
    expect(t.store.history[0]?.event.did).toBe(
      "Its records that failed go back to its queue and are tried again, and the other sources keep running; the worker checks again every 5 minutes.",
    );
    expectNoSecret(JSON.stringify(t.store.history));

    // The record fails again at every pass: this process asks the store no more than every 5 minutes.
    const before = t.store.reads;
    for (let pass = 0; pass < 20; pass += 1) {
      t.clock.advance(2_000);
      t.raisers.passed(LISTINGS, failing());
    }
    await t.raisers.settled();
    expect(t.store.reads).toBe(before);
    t.clock.advance(5 * MINUTE);
    t.raisers.passed(LISTINGS, failing());
    await t.raisers.settled();
    expect(t.store.reads).toBe(before + 1);
    // Still inside 30 minutes of the first: the same alert, said once.
    expect(t.store.history).toHaveLength(1);

    // The doctor passes, yet the write is still refused: nothing is resolved.
    await t.raisers.look();
    expect(t.store.active.has(lostKey)).toBe(true);
    // A pass whose only failure is a model that did not answer never reached the write: no proof.
    t.raisers.passed(
      LISTINGS,
      pass(t.clock.now(), {
        failures: [{ key: "r1", stage: "ask", error: new Error("the model timed out") }],
      }),
    );
    await t.raisers.look();
    expect(t.store.active.has(lostKey)).toBe(true);
    // The write goes through: the next look resolves it.
    t.raisers.passed(LISTINGS, pass(t.clock.now(), { wrote: 1 }));
    await t.raisers.look();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
  });

  it("raises nothing for an API source, whose database is the store no look reads", async () => {
    const t = setup();
    const { table: _table, ...rest } = LISTINGS;
    const support: SourceConfig = { ...rest, name: "support", api: true };
    t.raisers.stopped(support, refused("28P01"));
    t.raisers.passed(
      support,
      pass(t.clock.now(), { failures: [{ key: "k", stage: "record", error: refused("42501") }] }),
    );
    await t.raisers.settled();
    expect(t.store.history).toEqual([]);
  });

  it("resolves the alert of a source taken out of the file, and raises nothing for it after", async () => {
    const t = setup();
    t.raisers.loaded(config);
    t.raisers.stopped(LISTINGS, refused("28P01"));
    await t.raisers.settled();
    expect(t.store.active.has(lostKey)).toBe(true);

    t.raisers.loaded({ ...config, sources: [] });
    await t.raisers.settled();
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
    // Its last pass and its stop, after the file let it go.
    t.clock.advance(31 * MINUTE);
    t.raisers.passed(
      LISTINGS,
      pass(t.clock.now(), {
        failures: [{ key: "r1", stage: "record", error: refused("42501") }],
      }),
    );
    t.raisers.stopped(LISTINGS, refused("28P01"));
    await t.raisers.settled();
    expect(t.store.history).toHaveLength(2);
    expect(t.store.active.has(lostKey)).toBe(false);
  });

  it("raises nothing from a doctor that was still running when the reload took the source out of the file", async () => {
    let asked = false;
    let answer: (checks: readonly DoctorCheck[]) => void = () => undefined;
    const doctoring: WatchedSource = {
      kind: "table",
      name: "listings",
      doctor: () =>
        new Promise((resolve) => {
          asked = true;
          answer = resolve;
        }),
    };
    const t = setup([doctoring]);
    t.raisers.loaded(config);

    const looking = t.raisers.look();
    await vi.waitFor(() => expect(asked).toBe(true));
    // The reload that removes it loads while the doctor runs; then the doctor answers lost access.
    t.raisers.loaded({ ...config, sources: [] });
    answer(ROTATED);
    await looking;
    await t.raisers.settled();

    expect(t.store.history).toEqual([]);
    expect(t.store.active.has(lostKey)).toBe(false);
  });

  it("ends a look at a stop between two sources, leaving the doctors of the rest unrun", async () => {
    const stop = new AbortController();
    const first = table(() => {
      stop.abort();
      return HEALTHY;
    });
    const second = table(() => HEALTHY);
    const t = setup([first.source, { ...second.source, name: "orders" }]);
    await t.raisers.look(stop.signal);
    expect(first.runs.count).toBe(1);
    expect(second.runs.count).toBe(0);
  });
});

describe("a plugin source's lost access, resolved by its own reads", () => {
  const ISSUES: SourceConfig = { ...LISTINGS, name: "issues" };
  const lost = () =>
    new SourceAccessLost(
      "the plugin @facetdb/tracker (source issues of issues) lost access: the service it reads refused its credential in read; check the variable TRACKER_TOKEN and the rights granted to it",
    );
  const issuesKey = eventKey({
    kind: "connector_lost_access",
    project: PROJECT,
    source: "issues",
    question: null,
  });

  it("@timing is resolved at the first look after a read through the plugin answered", async () => {
    const t = setup([{ kind: "plugin", name: "issues" }]);
    const stop = new AbortController();
    const running = t.raisers.run(stop.signal);
    await vi.waitFor(() => expect(t.clock.pending()).toEqual([START + ACCESS_CHECK_EVERY_MS]));

    t.raisers.stopped(ISSUES, lost());
    await t.raisers.settled();
    await tick(t.clock);
    expect(t.store.active.has(issuesKey)).toBe(true);

    t.raisers.proven("issues");
    await tick(t.clock);
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);
    expect(t.store.active.has(issuesKey)).toBe(false);

    stop.abort();
    await running;
    expect(t.clock.pending()).toEqual([]);
  });

  it("@timing keeps it open, raised once and never again, while a source that came back has nothing to read", async () => {
    const t = setup([{ kind: "plugin", name: "issues" }]);
    const stop = new AbortController();
    const running = t.raisers.run(stop.signal);
    await vi.waitFor(() => expect(t.clock.pending()).toEqual([START + ACCESS_CHECK_EVERY_MS]));
    // A read that answered before the credential was refused proves nothing after it.
    t.raisers.proven("issues");
    t.raisers.stopped(ISSUES, lost());
    await t.raisers.settled();

    // An hour on, the source runs again and nothing changed in the service: no read, no proof.
    for (let look = 0; look < 12; look += 1) {
      await tick(t.clock);
    }
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised"]);
    expect(t.store.active.has(issuesKey)).toBe(true);

    // The first change read through the plugin is the proof: resolved at the next look.
    t.raisers.proven("issues");
    await tick(t.clock);
    expect(t.store.history.map((line) => line.phase)).toEqual(["raised", "resolved"]);

    stop.abort();
    await running;
  });
});

describe("Question set changed when a source opens under a higher version", () => {
  const v1 = questionSetOf(config, LISTINGS);
  const reworded = withQuestions([
    {
      type: "noul",
      name: "is_scam",
      instructions: "Is this listing a scam or a fake?",
      stakes: "low",
    },
  ]);
  const v2 = questionSetOf(reworded, sourceOf(reworded));

  it("raises nothing for a source's first version, nor for a start under the version it ran", async () => {
    const t = setup();
    t.raisers.started(LISTINGS, v1, 1, null);
    t.raisers.started(LISTINGS, v1, 1, { version: 1, questionSet: v1 });
    await t.raisers.settled();
    expect(t.store.history).toEqual([]);
  });

  it("names the file when no Apply wrote the set, says what changed, and links to the Questions page", async () => {
    const t = setup();
    t.raisers.loaded(reworded);
    t.raisers.started(sourceOf(reworded), v2, 2, { version: 1, questionSet: v1 });
    await t.raisers.settled();

    const [line] = t.store.history;
    expect(line?.severity).toBe("information");
    expect(line?.event).toEqual({
      kind: "question_set_changed",
      what: "The question set of listings changed from version 1 to version 2, by a change to facetdb.config.ts: the wording of is_scam.",
      project: PROJECT,
      source: "listings",
      question: null,
      did: "Answers listings with version 2 from now on; records already answered are not asked again.",
      link: "https://studio.example.com/questions?source=listings",
      version: 2,
    });
    // The question's wording itself is never quoted.
    expect(line?.event.what).not.toContain("scam or a fake");
  });

  it("names the reviewer of the Apply that wrote the set, at its reload and at a later start of the same set", async () => {
    const t = setup();
    // The Apply's own reload loads the file it wrote.
    t.raisers.loaded(reworded, { by: "maya", source: "listings" });
    // The switch comes at a later reload (the added question's install from the studio, say), or
    // a Check again: neither is the Apply, and neither changes who wrote the set.
    t.raisers.loaded(reworded);
    t.raisers.started(sourceOf(reworded), v2, 2, { version: 1, questionSet: v1 });
    await t.raisers.settled();
    expect(t.store.history[0]?.event.what).toBe(
      "The question set of listings changed from version 1 to version 2, by maya, through Apply in the studio: the wording of is_scam.",
    );

    // A hand edit since: the set that starts is not the one the Apply wrote.
    const edited = withQuestions([
      { type: "noul", name: "is_scam", instructions: "Is this a scam?", stakes: "low" },
    ]);
    t.raisers.started(sourceOf(edited), questionSetOf(edited, sourceOf(edited)), 3, {
      version: 2,
      questionSet: v2,
    });
    await t.raisers.settled();
    expect(t.store.history[1]?.event.what).toContain("by a change to facetdb.config.ts");
  });

  it("names the file for a set no Apply of this source wrote: another source's, or the spending settings'", async () => {
    const t = setup();
    for (const applied of [
      { by: "maya", source: "orders" },
      { by: "maya", source: null },
    ]) {
      t.raisers.loaded(reworded, applied);
    }
    t.raisers.started(sourceOf(reworded), v2, 2, { version: 1, questionSet: v1 });
    await t.raisers.settled();
    expect(t.store.history[0]?.event.what).toContain("by a change to facetdb.config.ts");
  });

  it("raises each new version once: the same version again is the same alert, the next one its own", async () => {
    const t = setup();
    const before = { version: 1, questionSet: v1 };
    t.raisers.started(sourceOf(reworded), v2, 2, before);
    await t.raisers.settled();
    t.raisers.started(sourceOf(reworded), v2, 2, before);
    await t.raisers.settled();
    expect(t.store.history).toHaveLength(1);
    t.clock.advance(MINUTE);
    t.raisers.started(LISTINGS, v1, 3, { version: 2, questionSet: v2 });
    await t.raisers.settled();
    expect(t.store.history.map((line) => line.event.version)).toEqual([2, 3]);
  });

  it("says questions added, removed and reworded and thresholds moved, without a question's wording", () => {
    const before = setOf([
      { type: "noul", name: "is_scam", instructions: "Is this a scam?", stakes: "low" },
      { type: "noul", name: "is_spam", instructions: "Is this spam?", stakes: "low" },
      { type: "noul", name: "is_rude", instructions: "Is this rude?", stakes: "low" },
    ]);
    const after = {
      ...setOf([
        { type: "noul", name: "is_scam", instructions: "Is this a fraud?", stakes: "low" },
        { type: "noul", name: "is_spam", instructions: "Is this spam?", stakes: "high" },
        { type: "noul", name: "urgency", instructions: "Is this urgent?", stakes: "low" },
      ]),
      thresholds: { is_scam: { yesAbove: 0.8 } },
    };
    expect(changesWords(before, after)).toBe(
      "the wording of is_scam; urgency added; is_rude removed; the thresholds of is_scam; the thresholds of is_spam",
    );
  });

  it("holds what changed to its length, saying how many more changes the Questions page lists", () => {
    const many = Array.from({ length: 40 }, (_, index) => ({
      type: "noul" as const,
      name: `question_with_a_long_name_${String(index).padStart(2, "0")}`,
      instructions: "Is it so?",
      stakes: "low" as const,
    }));
    const words = changesWords(questionSetOf(config, LISTINGS), setOf(many));
    expect(words.length).toBeLessThanOrEqual(CHANGES_MAX);
    expect(words).toMatch(
      /^question_with_a_long_name_00 added; .*; and \d+ more changes, listed on the Questions page$/,
    );
  });

  it("says what changed cannot be said when the set it ran before cannot be read", async () => {
    const t = setup();
    t.raisers.started(sourceOf(reworded), v2, 2, { version: 1, questionSet: null });
    await t.raisers.settled();
    expect(t.store.history[0]?.event.what).toBe(
      "The question set of listings changed from version 1 to version 2, by a change to facetdb.config.ts: what changed cannot be said, as version 1 is kept in a form this worker cannot read.",
    );
  });
});
