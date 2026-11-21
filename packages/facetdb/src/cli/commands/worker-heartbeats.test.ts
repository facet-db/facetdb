import { createAlerts, createWorkerWatch, type ModelProvider } from "@facetdb/core";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { sharePools } from "../pools.ts";
import { docsLink, runInProcess } from "../program.ts";
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
 * A worker's own heartbeat row through `facetdb worker`'s wiring: saved at the start and every 15
 * seconds, by a `--once` run too for as long as it answers, taken by another worker once it is 2
 * minutes old, removed on a clean stop and at the end of `--once` and left behind by a worker that
 * dies with an error, with no timer left on the clock, and a failure of it a line on the terminal,
 * scrubbed, that stops nothing. PGlite, the stepped clock and the fake provider.
 *
 * The rows' times are the database's clock. PGlite's is the machine's, so the commands' clients
 * read the test's stepped clock where the SQL asks for `clock_timestamp()`: the database's clock
 * is the test's own, as the test's other time sources are.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const PROJECT_DIR = "/work/listings-app";
const START = 1_700_000_000_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const PROJECT = projectRef(PROJECT_DIR).id;

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

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let provider: FakeProvider;

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

/** A statement that fails, by its text: the database refusing it with `message`. */
type Refusal = { readonly pattern: RegExp; readonly message: string };

/** The test's clock as the database's, and the refusals the test asks for, over one client. */
function throughTheTest(
  client: SqlClient,
  record: string[] | undefined,
  refusals: readonly Refusal[],
): SqlClient {
  return {
    ...client,
    query: (text, params) => {
      record?.push(text);
      const refused = refusals.find((refusal) => refusal.pattern.test(text));
      if (refused !== undefined) {
        return Promise.reject(new Error(refused.message));
      }
      return client.query(
        text.replaceAll("clock_timestamp()", `to_timestamp(${clock.now()} / 1000.0)`),
        params,
      );
    },
  };
}

/** Every client a command or a peer opens: the database's clock is the test's. */
function connection(record?: string[], refusals: readonly Refusal[] = []) {
  return sharePools((url, connectOptions) =>
    throughTheTest(world.connect(url, connectOptions), record, refusals),
  );
}

function run(
  argv: readonly string[],
  options: {
    readonly stop?: AbortSignal;
    readonly record?: string[];
    readonly refusals?: readonly Refusal[];
    readonly provider?: ModelProvider;
    readonly config?: ProjectConfig;
  } = {},
) {
  const connect = connection(options.record, options.refusals);
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
      loadConfig: () => Promise.resolve(options.config ?? config),
      engines: postgresEngines(connect),
      connect,
      // The store is opened over the client the command hands it, as `facetdb worker` opens it,
      // so its statements are the ones recorded and read the database's clock as the test has it.
      store: (storeOptions) =>
        storeOptions?.connect === undefined
          ? Promise.resolve({ ...store, close: () => Promise.resolve() })
          : createStore({
              url: "postgres://localhost:5432/facetdb",
              pgHost: undefined,
              connect: storeOptions.connect,
              secret: TEST_SECRET,
              clock,
            }),
      provider: () => options.provider ?? provider,
      clock,
      random: () => 0.5,
      webhookFetch: () => Promise.reject(new Error("no webhook is queued in these tests")),
      serve: (_handler, port) => Promise.resolve({ port, close: () => Promise.resolve() }),
      ...(options.stop === undefined ? {} : { stopSignal: () => options.stop as AbortSignal }),
    },
    COMMANDS,
  );
}

type Row = { readonly worker: string; readonly at: number };

async function rows(): Promise<readonly Row[]> {
  const found = await world.client.query(
    "select worker, at::text as at from facetdb.worker_heartbeats where project = $1 order by worker",
    [PROJECT],
  );
  return found.map((row) => ({ worker: String(row["worker"]), at: Number(row["at"]) }));
}

/** A row another worker left, at a time on the test's clock. */
async function seed(worker: string, at: number, project = PROJECT): Promise<void> {
  await world.client.query(
    "insert into facetdb.worker_heartbeats (project, worker, at) values ($1, $2, $3)",
    [project, worker, at],
  );
}

async function alertLines(): Promise<
  readonly { readonly phase: string; readonly text: string; readonly link: string }[]
> {
  const found = await world.client.query(
    "select record::text as record from facetdb.alert_history",
  );
  return found.map((row) => {
    const record = JSON.parse(String(row["record"])) as {
      phase: string;
      event: { what: string; worker?: string; link: string };
    };
    return { phase: record.phase, text: record.event.what, link: record.event.link };
  });
}

/** Moves the clock one beat on (15 seconds) and waits for the worker's loop to be asleep again. */
async function tick(): Promise<void> {
  clock.advance(15 * SECOND);
  const next = clock.now() + 15 * SECOND;
  await vi.waitFor(() => expect(clock.pending()).toContain(next), { timeout: 10_000 });
}

describe("a worker's own heartbeat row", () => {
  it("@timing is saved at the start and every 15 seconds, and a clean stop removes it and leaves no timer", async () => {
    const stop = new AbortController();
    const running = run(["worker", "--no-http"], { stop: stop.signal });

    await vi.waitFor(async () => expect(await rows()).toHaveLength(1), { timeout: 10_000 });
    const [first] = await rows();
    expect(first?.worker).toMatch(/^worker-/);
    expect(first?.at).toBe(START);
    await vi.waitFor(() => expect(clock.pending()).toContain(START + 15 * SECOND), {
      timeout: 10_000,
    });

    await tick();
    await vi.waitFor(async () => expect(await rows()).toEqual([{ ...first, at: START + 15_000 }]), {
      timeout: 10_000,
    });
    await tick();
    await vi.waitFor(async () => expect((await rows())[0]?.at).toBe(START + 30_000), {
      timeout: 10_000,
    });
    // The watch sleeps until its next beat, 15 seconds on from the one just saved.
    await vi.waitFor(() => expect(clock.pending()).toContain(START + 45 * SECOND), {
      timeout: 10_000,
    });
    stop.abort();
    const result = await running;

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Stopped: every claim was settled.");
    expect(await rows()).toEqual([]);
    // No sleep of the watch's is left on the clock to hold the process open: the stop ended it.
    expect(clock.pending()).not.toContain(START + 45 * SECOND);
    expect(await alertLines()).toEqual([]);
  });

  it("--once saves its row at the start and removes it when it has finished, with nothing on the clock", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    const statements: string[] = [];

    const result = await run(["worker", "--once", "--no-http"], { record: statements });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("listings: answered r1");
    const mine = statements
      .filter((text) => text.includes("facetdb.worker_heartbeats"))
      .map((text) => text.trim().split(/\s+/).slice(0, 3).join(" "));
    // The sweep of the dead rows, the first beat, and the removal at the end: a run this short
    // is over before its first 15 seconds.
    expect(mine).toEqual([
      "with cut as",
      "insert into facetdb.worker_heartbeats",
      "delete from facetdb.worker_heartbeats",
    ]);
    expect(await rows()).toEqual([]);
    expect(clock.pending()).toEqual([]);
  });

  it("@timing --once beats every 15 seconds for as long as it answers: a run past 2 minutes is not taken for a death", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");
    // A second worker, which looks at the rows as the loops do, started before this run.
    const peerStore = await createStore({
      url: "postgres://localhost:5432/facetdb",
      pgHost: undefined,
      connect: connection(),
      secret: TEST_SECRET,
      clock,
    });
    const peer = createWorkerWatch({
      store: peerStore.alerts,
      alerts: createAlerts({ store: peerStore.alerts, clock, channels: [] }),
      clock,
      project: PROJECT,
      worker: "worker-peer",
      link: () => "https://docs.facetdb.dev/fix/worker",
      report: (error) => {
        throw error;
      },
    });
    await peer.start();
    clock.advance(SECOND);

    // The model is slow: the run answers its one record for more than 2 minutes.
    let asked = false;
    let answer: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      answer = resolve;
    });
    const slow: ModelProvider = {
      ask: async (request) => {
        asked = true;
        await gate;
        return provider.ask(request);
      },
    };
    const running = run(["worker", "--once", "--no-http"], { provider: slow });
    await vi.waitFor(() => expect(asked).toBe(true), { timeout: 10_000 });
    expect((await rows()).map((row) => row.worker)).toContain("worker-peer");
    const began = clock.now();

    for (let beat = 1; beat <= 12; beat += 1) {
      await tick();
      await peer.beat();
      await peer.check();
      const mine = (await rows()).find((row) => row.worker !== "worker-peer");
      // Its own row is as new as the last beat, and the peer has taken nothing.
      expect(mine?.at).toBe(clock.now());
    }
    expect(clock.now() - began).toBe(3 * MINUTE);
    expect(await alertLines()).toEqual([]);

    answer();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("listings: answered r1");
    // The run is over: its row and its timers are gone, and the peer's row stays its own.
    expect((await rows()).map((row) => row.worker)).toEqual(["worker-peer"]);
    expect(clock.pending()).not.toContain(clock.now() + 15 * SECOND);
    await peerStore.close();
    expect(await alertLines()).toEqual([]);
  });

  it("@timing leaves its row when it dies with an error, for the others to find", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");

    // The run answers its record, then fails delivering the outbox: the command ends in an error.
    const result = await run(["worker", "--once", "--no-http"], {
      refusals: [{ pattern: /webhook_outbox/, message: "the outbox is unreachable" }],
    });

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("the outbox is unreachable");
    expect((await rows()).map((row) => row.worker)).toHaveLength(1);
    // And the timers ended all the same: nothing of the watch's is left on the clock.
    expect(clock.pending()).toEqual([]);
  });

  it("@timing a start sweeps the rows of workers 2 minutes old or more without an alert, and keeps the newer ones", async () => {
    await seed("worker-long-dead", START - 10 * MINUTE);
    await seed("worker-just-dead", START - 2 * MINUTE);
    await seed("worker-recent", START - 119 * SECOND);
    await seed("worker-elsewhere", START - 10 * MINUTE, "another-project");

    const result = await run(["worker", "--once", "--no-http"]);

    expect(result.code, result.stderr).toBe(0);
    expect((await rows()).map((row) => row.worker)).toEqual(["worker-recent"]);
    const elsewhere = await world.client.query(
      "select worker from facetdb.worker_heartbeats where project = 'another-project'",
    );
    expect(elsewhere).toEqual([{ worker: "worker-elsewhere" }]);
    expect(await alertLines()).toEqual([]);
  });

  it("@timing raises Worker not running once for a worker that beat after this one began and then stopped", async () => {
    const stop = new AbortController();
    const running = run(["worker", "--no-http"], { stop: stop.signal });
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1), { timeout: 10_000 });
    // The other worker's last beat is one millisecond after this one began.
    await seed("worker-other", START + 1);

    // At 2 minutes less a beat its row is not 2 minutes old; the looks are at 30, 60, 90, 120.
    for (let beat = 1; beat <= 8; beat += 1) {
      await tick();
    }
    expect(await alertLines()).toEqual([]);

    // The look at 150 seconds takes it: one alert, naming it and who still beats.
    await tick();
    await tick();
    await vi.waitFor(async () => expect(await alertLines()).toHaveLength(1), { timeout: 10_000 });
    const [alert] = await alertLines();
    expect(alert?.phase).toBe("raised");
    expect(alert?.text).toContain("Worker worker-other has sent no heartbeat for 2 minutes");
    expect(alert?.text).toContain("its last beat was 2023-11-14 22:13 UTC");
    expect(alert?.text).toContain("1 worker of the project still beats");
    // With no studio (--no-http) the alert keeps its docs fix page.
    expect(alert?.link).toBe(docsLink("worker"));
    expect((await rows()).map((row) => row.worker)).not.toContain("worker-other");

    // And it does not repeat while the worker runs on.
    for (let beat = 0; beat < 8; beat += 1) {
      await tick();
    }
    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(await alertLines()).toHaveLength(1);
    expect(await rows()).toEqual([]);
  });

  it("@timing links the alert to the studio's Home when the worker has a studio", async () => {
    const stop = new AbortController();
    const withStudio: ProjectConfig = { ...config, studioUrl: "https://studio.example.com" };
    const running = run(["worker", "--no-http"], { stop: stop.signal, config: withStudio });
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1), { timeout: 10_000 });
    await seed("worker-other", START + 1);

    for (let beat = 1; beat <= 10; beat += 1) {
      await tick();
    }
    await vi.waitFor(async () => expect(await alertLines()).toHaveLength(1), { timeout: 10_000 });

    expect((await alertLines())[0]?.link).toBe("https://studio.example.com/");
    stop.abort();
    await running;
  });

  it("a row that has not beaten since this worker began is dropped without an alert once it is 2 minutes old", async () => {
    const stop = new AbortController();
    const running = run(["worker", "--no-http"], { stop: stop.signal });
    await vi.waitFor(async () => expect(await rows()).toHaveLength(1), { timeout: 10_000 });
    // A predecessor's row, 30 seconds old when this one began (its last beat is before the start).
    await seed("worker-predecessor", START - 30 * SECOND);

    for (let beat = 1; beat <= 12; beat += 1) {
      await tick();
    }

    expect(await alertLines()).toEqual([]);
    expect((await rows()).map((row) => row.worker)).not.toContain("worker-predecessor");
    stop.abort();
    await running;
  });

  it("a heartbeat that cannot be saved or removed is a line on the terminal with the connection string hidden, and the worker answers all the same", async () => {
    await world.client.query("insert into public.listings (id, title) values ('r1', 'A red car')");

    const result = await run(["worker", "--once", "--no-http"], {
      refusals: [
        {
          pattern: /^\s*insert into facetdb\.worker_heartbeats/,
          message: `could not connect to ${WORKER_URL}: the disk is full`,
        },
        {
          pattern:
            /^\s*delete from facetdb\.worker_heartbeats where project = \$1 and worker = \$2/,
          message: "the connection was reset",
        },
      ],
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("listings: answered r1");
    expect(result.stdout).toMatch(
      /worker heartbeat: this worker's row could not be saved: could not connect to \S*\[hidden\]\S*: the disk is full/,
    );
    for (const secret of ["worker-password", "facetdb_worker", "localhost:5432"]) {
      expect(result.stdout).not.toContain(secret);
    }
    expect(result.stdout).toContain(
      "worker heartbeat: this worker's row could not be removed: the connection was reset",
    );
    expect(result.stdout).not.toContain("worker-password");
    expect(result.stderr).not.toContain("worker-password");
  });
});
