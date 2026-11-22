import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { sharePools } from "../pools.ts";
import { docsLink, type HttpHandler, runInProcess } from "../program.ts";
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
import { ACCESS_CHECK_EVERY_MS } from "./alert-raisers.ts";
import { projectRef, questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * Connector lost access through `facetdb worker`'s own wiring: the table source's doctor read every
 * 5 minutes on the worker's clock, beside the passes, through the Postgres engine on PGlite; a loop
 * whose database refuses the worker login raising at once; nothing of it under `--once`. The
 * database's refusals are the test's: a statement it names fails with a driver's error (its code,
 * and words that quote the source's connection string and password), which must reach no alert, no
 * history line and no printed line.
 */

const PASSWORD = "worker-password";
const WORKER_URL = `postgres://facetdb_worker:${PASSWORD}@localhost:5432/app`;
const PROJECT_DIR = "/work/listings-app";
const START = 1_700_000_000_000;
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };

const config: ProjectConfig = facetdb({
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

/** The doctor's first statement: its database check, made once per doctor run. */
const DOCTOR_LOGIN = /^select current_user::text as name$/;
/** Every statement the Postgres engine's doctor makes (engine/doctor.ts), and none of a pass's. */
const DOCTOR_STATEMENTS = [
  DOCTOR_LOGIN,
  /^select 1$/,
  /^select pg_backend_pid\(\) as pid, \$1::int as run$/,
  /^select\s+to_regnamespace\('facetdb'\)/,
  /from pg_catalog\.pg_trigger t/,
  /^select a\.attname::text as name\s+from pg_catalog\.pg_attribute a/,
  /^select at::text as at from facetdb\.heartbeats/,
];
/** The claim of a pass (sql/jobs.ts): the source's jobs table, never the outbox's. */
const CLAIM =
  /^update "?facetdb"?\."?jobs"?\s+set claimed_at[\s\S]*limit \$3\s+for update skip locked/;

/** A statement the database refuses, by its text, with the driver's error. */
type Refusal = { readonly pattern: RegExp; readonly error: () => unknown };

/** What a driver throws when the database refuses the worker login: its code, and the URL quoted. */
const loginRefused = () =>
  Object.assign(
    new Error(
      `password authentication failed for user "facetdb_worker" (connecting to ${WORKER_URL} with password ${PASSWORD})`,
    ),
    { code: "28P01" },
  );

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let provider: FakeProvider;
let refusals: Refusal[];
let statements: string[];
let served: HttpHandler[];

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  clock = new SteppedClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  provider = createFakeProvider({ defaults: { noul: 0.01 } });
  refusals = [];
  statements = [];
  served = [];
  await world.client.query("create table public.listings (id text primary key, title text)");
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
      workerPassword: PASSWORD,
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

/**
 * Every client the worker opens: its statements recorded, the test's refusals applied. PGlite's one
 * connection is a superuser's; the doctor asking who it is told the worker login, as the database
 * the connection string names would tell it.
 */
function through(client: SqlClient): SqlClient {
  return {
    ...client,
    query: (text, params) => {
      statements.push(text.trim());
      const refused = refusals.find((refusal) => refusal.pattern.test(text.trim()));
      if (refused !== undefined) {
        return Promise.reject(refused.error());
      }
      if (DOCTOR_LOGIN.test(text.trim())) {
        return Promise.resolve([{ name: "facetdb_worker" }]);
      }
      return client.query(
        text.replaceAll("clock_timestamp()", `to_timestamp(${clock.now()} / 1000.0)`),
        params,
      );
    },
  };
}

function run(argv: readonly string[], stop?: AbortSignal) {
  const connect = sharePools((url, connectOptions) => through(world.connect(url, connectOptions)));
  return runInProcess(
    argv,
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
      provider: () => provider,
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      serve: (handler, port) => {
        served.push(handler);
        return Promise.resolve({ port, close: () => Promise.resolve() });
      },
      ...(stop === undefined ? {} : { stopSignal: () => stop }),
    },
    COMMANDS,
  );
}

type Line = {
  readonly phase: string;
  readonly kind: string;
  readonly what: string;
  readonly link: string;
};

/** The alert history, oldest first; and its raw text, for the search of secrets. */
async function history(): Promise<{ readonly lines: readonly Line[]; readonly raw: string }> {
  const rows = await world.client.query(
    "select record::text as record from facetdb.alert_history order by id",
  );
  const raw = rows.map((row) => String(row["record"])).join("\n");
  return {
    raw,
    lines: rows.map((row) => {
      const record = JSON.parse(String(row["record"])) as {
        phase: string;
        event: { kind: string; what: string; link: string };
      };
      return { phase: record.phase, ...record.event };
    }),
  };
}

/** The alerts still active, as the store keeps them. */
async function activeAlerts(): Promise<string> {
  const rows = await world.client.query("select state::text as state from facetdb.alerts");
  return rows.map((row) => String(row["state"])).join("\n");
}

/** Moves the clock to the next look and waits for the worker to sleep toward the one after. */
async function nextLook(): Promise<void> {
  clock.advance(ACCESS_CHECK_EVERY_MS);
  const next = clock.now() + ACCESS_CHECK_EVERY_MS;
  await vi.waitFor(() => expect(clock.pending()).toContain(next), { timeout: 10_000 });
}

/**
 * Moves the clock to the look already on it, wherever the passes have moved the clock since: its
 * sleep is the only one minutes away when no source waits for a try (the others are seconds).
 */
async function toTheLook(): Promise<void> {
  const due = clock.pending().find((at) => at - clock.now() > 2 * 60_000);
  if (due === undefined) {
    throw new Error("the worker has its next look on the clock");
  }
  clock.advance(due - clock.now());
  await vi.waitFor(() => expect(clock.pending()).toContain(due + ACCESS_CHECK_EVERY_MS), {
    timeout: 10_000,
  });
}

/** The decision's write of a pass (capture/connector.ts): the source's own table. */
const WRITE = /^update "public"\."listings" as t set/;

/** What a driver throws when the worker login may no longer write the table. */
const writeRefused = () =>
  Object.assign(new Error(`permission denied for table listings (${WORKER_URL})`), {
    code: "42501",
  });

async function home(): Promise<{
  readonly health: {
    readonly words: string;
    readonly checks: readonly { readonly name: string; readonly words: string }[];
  };
}> {
  const response = await served[0]?.(new Request("http://127.0.0.1:4040/v1/home"), THIS_MACHINE);
  if (response === undefined) {
    throw new Error("the worker serves its surface");
  }
  return response.json() as never;
}

function expectNoSecret(...texts: readonly string[]): void {
  for (const text of texts) {
    expect(text).not.toContain(PASSWORD);
    expect(text).not.toContain(WORKER_URL);
  }
}

describe("the running worker's reading of each table source (alert-raisers)", () => {
  it("@timing reads the doctor once per table source every 5 minutes beside the passes, raises a refused login in Home's words with nothing secret, and resolves it once the source reads well", async () => {
    const stop = new AbortController();
    const running = run(["worker"], stop.signal);
    await vi.waitFor(() => expect(served).toHaveLength(1), { timeout: 10_000 });
    await vi.waitFor(() => expect(clock.pending()).toContain(START + ACCESS_CHECK_EVERY_MS), {
      timeout: 10_000,
    });

    // The passes answer a record; no doctor runs inside them, nor anywhere before the first look.
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    await vi.waitFor(
      async () => {
        clock.advance(1_000);
        const rows = await world.client.query("select facetdb_status from public.listings");
        expect(rows).toEqual([{ facetdb_status: "done" }]);
      },
      { timeout: 10_000, interval: 5 },
    );
    expect(statements.some((text) => CLAIM.test(text))).toBe(true);
    expect(statements.filter((text) => DOCTOR_LOGIN.test(text))).toEqual([]);

    // The first look: one doctor run for the one table source, at the doctor's own cost.
    clock.advance(START + ACCESS_CHECK_EVERY_MS - clock.now() - 1);
    statements.length = 0;
    clock.advance(1);
    const next = START + 2 * ACCESS_CHECK_EVERY_MS;
    await vi.waitFor(() => expect(clock.pending()).toContain(next), { timeout: 10_000 });
    const doctor = statements.filter((text) =>
      DOCTOR_STATEMENTS.some((pattern) => pattern.test(text)),
    );
    expect(doctor.filter((text) => DOCTOR_LOGIN.test(text))).toHaveLength(1);
    // The database check (current_user and three round trips), the pooler probe twice, the
    // install's three catalog reads: 9 statements. The store is another database here, so the
    // heartbeat read is not made from the source.
    expect(doctor).toHaveLength(9);
    expect((await history()).lines).toEqual([]);

    // The worker login's password rotated: the doctor's database check fails at the next look.
    refusals.push({ pattern: DOCTOR_LOGIN, error: loginRefused });
    await nextLook();
    const raised = await history();
    expect(raised.lines).toHaveLength(1);
    expect(raised.lines[0]).toMatchObject({
      phase: "raised",
      kind: "connector_lost_access",
      // With no studio served (the API alone here), the docs fix page of the worker login.
      link: docsLink("worker-login"),
    });
    const what = raised.lines[0]?.what ?? "";
    expect(what).toMatch(
      /^The worker cannot use the database of listings: its database check fails: "listings" cannot connect to \[hidden\]\/app: password authentication failed for user "\[hidden\]"/,
    );
    // Home names the same failed check, in the doctor's same words.
    const shown = await home();
    expect(shown.health.words).toBe("Connector lost access");
    const sources = shown.health.checks.find((check) => check.name === "sources");
    expect(sources?.words).toMatch(
      /^Connector lost access\. listings: "listings" cannot connect to localhost:5432\/app: password authentication failed for user "facetdb_worker"/,
    );

    // Read again 5 minutes on, and said once in 30.
    await nextLook();
    expect((await history()).lines).toHaveLength(1);

    // The password set back: the next look resolves it.
    refusals.length = 0;
    await nextLook();
    expect((await history()).lines.map((line) => line.phase)).toEqual(["raised", "resolved"]);

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    // No look is left on the clock once the worker stopped.
    expect(clock.pending()).not.toContain(clock.now() + ACCESS_CHECK_EVERY_MS);
    const all = await history();
    expectNoSecret(all.raw, await activeAlerts(), result.stdout, result.stderr);
  });

  it("@timing raises a refused login at the failure of the loop, before any look, with nothing secret in the alert, its history or the worker's lines", async () => {
    const stop = new AbortController();
    const running = run(["worker", "--no-http"], stop.signal);
    await vi.waitFor(() => expect(clock.pending()).toContain(START + ACCESS_CHECK_EVERY_MS), {
      timeout: 10_000,
    });

    // The database refuses the worker login from the next claim on: the loop stops alone.
    refusals.push({ pattern: CLAIM, error: loginRefused });
    await vi.waitFor(
      async () => {
        clock.advance(1_000);
        expect((await history()).lines).toHaveLength(1);
      },
      { timeout: 10_000, interval: 5 },
    );
    expect(clock.now()).toBeLessThan(START + ACCESS_CHECK_EVERY_MS);
    const [line] = (await history()).lines;
    expect(line).toMatchObject({
      phase: "raised",
      kind: "connector_lost_access",
      what: "The database of listings refused the worker login (code 28P01): its password, or its right to log in, changed.",
    });

    // Its tries again fail the same way within 30 minutes: still one alert.
    for (let step = 0; step < 4; step += 1) {
      clock.advance(60_000);
      await vi.waitFor(() => expect(clock.pending().length).toBeGreaterThan(0));
    }
    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("listings stopped:");
    const all = await history();
    expect(all.lines).toHaveLength(1);
    expectNoSecret(all.raw, await activeAlerts(), result.stdout, result.stderr);
  });

  it("@timing raises a revoked right to write from the passes while the loop runs on, which the doctor's pass does not resolve, and resolves it at the look after a pass went through", async () => {
    const stop = new AbortController();
    const running = run(["worker", "--no-http"], stop.signal);
    await vi.waitFor(() => expect(clock.pending()).toContain(START + ACCESS_CHECK_EVERY_MS), {
      timeout: 10_000,
    });

    // The worker login may no longer write the answer columns: every write of r1 is refused, and
    // the record goes back to the queue; the loop itself never stops.
    refusals.push({ pattern: WRITE, error: writeRefused });
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    await vi.waitFor(
      async () => {
        clock.advance(1_000);
        expect((await history()).lines).toHaveLength(1);
      },
      { timeout: 10_000, interval: 5 },
    );
    expect((await history()).lines[0]).toMatchObject({
      phase: "raised",
      kind: "connector_lost_access",
      what: "The database of listings refused the worker login a right it uses (code 42501): a grant was taken away.",
    });

    // The look 5 minutes in: PostgreSQL's doctor reads no rights and passes, and the record still
    // fails at every pass, so nothing is resolved and nothing is said again.
    await toTheLook();
    expect((await history()).lines).toHaveLength(1);

    // The grant given back: the next pass writes r1, and the look after it resolves the alert.
    refusals.length = 0;
    await vi.waitFor(
      async () => {
        clock.advance(1_000);
        const rows = await world.client.query("select facetdb_status from public.listings");
        expect(rows).toEqual([{ facetdb_status: "done" }]);
      },
      { timeout: 10_000, interval: 5 },
    );
    await toTheLook();
    expect((await history()).lines.map((line) => line.phase)).toEqual(["raised", "resolved"]);

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("listings stopped:");
    expectNoSecret((await history()).raw, await activeAlerts(), result.stdout, result.stderr);
  });

  it("--once reads no doctor and raises nothing of it, and leaves nothing on the clock", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    refusals.push({ pattern: DOCTOR_LOGIN, error: loginRefused });

    const result = await run(["worker", "--once", "--no-http"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("listings: answered r1");
    expect(statements.filter((text) => DOCTOR_LOGIN.test(text))).toEqual([]);
    expect((await history()).lines).toEqual([]);
    expect(clock.pending()).toEqual([]);
  });
});
