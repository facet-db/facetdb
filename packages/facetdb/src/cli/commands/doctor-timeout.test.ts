import { createServer, type Server, type Socket } from "node:net";
import type { Clock, DoctorCheck, DoctorDeps, EngineDeps, EngineTarget } from "@facetdb/core";
import { FakeClock, FakeEngine } from "@facetdb/core/testing";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { describe, expect, it } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { docsLink, type EngineEntry, runInProcess } from "../program.ts";
import { connectPostgres, postgresEngines, type SqlConnect, SteppedClock } from "../testing.ts";
import { DOCTOR_STEP_MS } from "./doctor.ts";
import { COMMANDS } from "./index.ts";

/**
 * Every step of `facetdb doctor` (the config, a source's engine checks, the heartbeat, the model,
 * the store) ends within 10 seconds on the injected clock. A step that runs out fails each of its
 * checks in words naming the server's host and never its connection string, the checks of the other
 * steps still run and keep what they found, and a server a step gave up on is not asked again in
 * the same run. The clock is `SteppedClock`: a step's bound ends only when the test moves it, so no
 * test waits on a real timer.
 */

const START = 10_000_000;
const PROJECT_DIR = "/work/listings-app";
const SOURCE_PASSWORD = "s3cret-worker-password";
const STORE_PASSWORD = "s3cret-store-password";
const SOURCE_URL = `postgres://facetdb_worker:${SOURCE_PASSWORD}@db.example.com:5432/app?sslmode=require`;
const STORE_URL = `postgres://facetdb_store:${STORE_PASSWORD}@store.example.com:5432/facetdb?sslmode=require`;
const SECRET = "a-long-random-secret-for-doctor-tests";
const MODEL_KEY = "tsk-s3cret-model-key";
const SECRETS = [SOURCE_PASSWORD, STORE_PASSWORD, SECRET, MODEL_KEY];

/** The Postgres engine's check names, so a source's lines read as they do on Postgres. */
const CHECKS = ["database", "pooler", "capture", "install", "worker"].map((name) => ({
  name,
  looksAt: `checks ${name}`,
}));

const OK: readonly DoctorCheck[] = [
  { name: "database", status: "ok", detail: "logged in as facetdb_worker" },
  { name: "pooler", status: "ok", detail: "prepared statements stay on one server session" },
  { name: "capture", status: "ok", detail: "the trigger is in place" },
  { name: "install", status: "ok", detail: "answer columns are in place" },
];

/** An engine whose doctor never answers: a server that took the connection and says nothing. */
class SilentEngine extends FakeEngine {
  asked = 0;
  override doctor(
    _target: EngineTarget,
    _url: string,
    _deps: EngineDeps,
  ): Promise<readonly DoctorCheck[]> {
    this.asked += 1;
    return new Promise(() => undefined);
  }
}

function silentEntry(engine: SilentEngine): EngineEntry {
  return lazyEngine("postgres", () => Promise.resolve(engine));
}

/** An engine that answers every check at once. */
function answeringEntry(): EngineEntry {
  return lazyEngine("postgres", () =>
    Promise.resolve(
      new FakeEngine({
        name: "postgres",
        schemes: ["postgres", "postgresql"],
        checks: CHECKS,
        doctor: () => OK,
      }),
    ),
  );
}

/** The store's driver, recording what each connection was opened with; its statements never answer. */
function silentStore(): {
  readonly connect: SqlConnect;
  readonly opened: unknown[];
  readonly closed: () => number;
} {
  const opened: unknown[] = [];
  let closed = 0;
  const never = () => new Promise<never>(() => undefined);
  return {
    opened,
    closed: () => closed,
    connect: (_url, options) => {
      opened.push(options);
      return {
        query: never,
        transaction: never,
        pipeline: never,
        close: () => {
          closed += 1;
          return Promise.resolve();
        },
      };
    },
  };
}

/** A driver no test may reach: the step that would use it is proven not to. */
const unreachable: SqlConnect = (url) => {
  throw new Error(`a connection was opened to ${url}`);
};

function project(): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: SOURCE_URL,
        table: "listings",
        read: ["title"],
        questions: { is_scam: noul("Is this listing a scam?") },
      },
    ],
  });
}

type Setup = {
  readonly clock: Clock;
  readonly engines: readonly EngineEntry[];
  readonly connect: SqlConnect;
  readonly env: Readonly<Record<string, string>>;
  readonly loadConfig?: () => Promise<ProjectConfig>;
  readonly argv?: readonly string[];
  readonly provider?: FakeProvider;
  readonly doctorBounds?: { readonly stepMs: number; readonly connectTimeoutSeconds: number };
};

function doctor(setup: Setup) {
  const provider = setup.provider ?? createFakeProvider({ defaults: { noul: 0.9 } });
  return runInProcess(
    ["doctor", ...(setup.argv ?? [])],
    {
      projectDir: PROJECT_DIR,
      env: setup.env,
      loadConfig: setup.loadConfig ?? (() => Promise.resolve(project())),
      engines: setup.engines,
      connect: setup.connect,
      provider: () => provider,
      clock: setup.clock,
      // The backoff's jitter after a 429, exact.
      random: () => 0.5,
      ...(setup.doctorBounds === undefined ? {} : { doctorBounds: setup.doctorBounds }),
    },
    COMMANDS,
  );
}

/** Yields to the event loop until `ready` holds: what the test waits on is the run, not a timer. */
async function until(ready: () => boolean): Promise<void> {
  for (let turn = 0; !ready(); turn += 1) {
    if (turn > 1_000) {
      throw new Error("the run never reached the step the test waits on");
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Once the run is in the step that never ends (`hung`), moves the clock past that step's bound,
 * the one timer then on the clock.
 */
async function runOutTheStep(clock: SteppedClock, hung: () => boolean): Promise<void> {
  await until(hung);
  expect(clock.pending()).toEqual([clock.now() + DOCTOR_STEP_MS]);
  clock.advance(DOCTOR_STEP_MS);
}

/** The printed line of a check, by its label. */
function lineOf(stdout: string, label: string): string {
  const found = stdout.split("\n").find((text) => text.slice(6).startsWith(`${label}:`));
  if (found === undefined) {
    throw new Error(`no line for ${label} in:\n${stdout}`);
  }
  return found;
}

function expectNoSecret(text: string): void {
  for (const secret of SECRETS) {
    expect(text).not.toContain(secret);
  }
}

const NOT_ANSWERED_FIX =
  "check the host and port in DATABASE_URL, and that the database accepts connections from this machine (a firewall or an allow-list)";

describe("a source whose server never answers (doctor-timeout)", () => {
  it("@timing fails each of the source's checks in its words after 10 seconds, and the model and secret checks still pass", async () => {
    const clock = new SteppedClock(START);
    const engine = new SilentEngine({ name: "postgres", schemes: ["postgres"], checks: CHECKS });
    const running = doctor({
      clock,
      engines: [silentEntry(engine)],
      // The store is the source's own database: the engine reads the heartbeat there, and the store
      // door is never asked, since the server already gave no answer.
      connect: unreachable,
      env: { DATABASE_URL: SOURCE_URL, FACETDB_SECRET: SECRET, TYPESAFE_API_KEY: MODEL_KEY },
    });
    await runOutTheStep(clock, () => engine.asked > 0);
    const result = await running;

    const words = `"listings": the server at db.example.com:5432 did not answer within 10 seconds`;
    for (const label of ["database", "pooler", "capture", "install", "worker heartbeat"]) {
      expect(lineOf(result.stdout, label)).toBe(
        `FAIL  ${label}: ${words} Fix: ${NOT_ANSWERED_FIX}. See ${docsLink(`doctor-${label === "worker heartbeat" ? "worker" : label}`)}`,
      );
    }
    // The checks of the other steps answered, and say what they found.
    expect(lineOf(result.stdout, "config")).toMatch(/^ok {4}config:/);
    expect(lineOf(result.stdout, "model key")).toMatch(/^ok {4}model key:/);
    expect(lineOf(result.stdout, "model reachable")).toBe(
      "ok    model reachable: jev-1.14.0 answered a test question",
    );
    expect(lineOf(result.stdout, "FACETDB_SECRET")).toMatch(/^ok {4}FACETDB_SECRET:/);
    // The model's note about the store does not ask the server again: it says why at once.
    expect(lineOf(result.stdout, "model name")).toBe(
      "warn  model name: the store could not be read, so no source's model was compared with the one its version is held to: the server at db.example.com:5432 did not answer within 10 seconds",
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`the database check failed: ${words}`);
    // One step ran out, once; the engine was asked once; no timer is left on the clock.
    expect(clock.now()).toBe(START + DOCTOR_STEP_MS);
    expect(engine.asked).toBe(1);
    expect(clock.pending()).toEqual([]);
    expectNoSecret(result.stdout + result.stderr);
  });

  it("@timing says the same in --json, where only the source's checks failed", async () => {
    const clock = new SteppedClock(START);
    const engine = new SilentEngine({ name: "postgres", schemes: ["postgres"], checks: CHECKS });
    const running = doctor({
      clock,
      engines: [silentEntry(engine)],
      connect: unreachable,
      env: { DATABASE_URL: SOURCE_URL, FACETDB_SECRET: SECRET, TYPESAFE_API_KEY: MODEL_KEY },
      argv: ["--offline", "--json"],
    });
    await runOutTheStep(clock, () => engine.asked > 0);
    const result = await running;
    const body = JSON.parse(result.stdout) as {
      details: { checks: { id: string; status: string }[] };
    };
    expect(body.details.checks.map(({ id, status }) => `${id} ${status}`)).toEqual([
      "config ok",
      "database fail",
      "pooler fail",
      "capture fail",
      "install fail",
      "worker fail",
      "model-key ok",
      "model-reachable skip",
      "secret ok",
    ]);
    expect(clock.pending()).toEqual([]);
    expectNoSecret(result.stdout + result.stderr);
  });
});

describe("a store whose server never answers (doctor-timeout)", () => {
  it("@timing fails the store's checks in its words after 10 seconds, asks the silent server nothing more, and the source, model and secret checks pass", async () => {
    const clock = new SteppedClock(START);
    const store = silentStore();
    const running = doctor({
      clock,
      engines: [answeringEntry()],
      connect: store.connect,
      env: { DATABASE_URL: STORE_URL, FACETDB_SECRET: SECRET, TYPESAFE_API_KEY: MODEL_KEY },
      argv: ["--offline"],
    });
    await runOutTheStep(clock, () => store.opened.length > 0);
    const result = await running;

    const words =
      "the FacetDB store: the server at store.example.com:5432 did not answer within 10 seconds";
    const lines = result.stdout.split("\n").filter((text) => text !== "");
    expect(lines.slice(lines.indexOf("store:"))).toEqual([
      "store:",
      `FAIL  store: ${words} Fix: ${NOT_ANSWERED_FIX}. See ${docsLink("doctor-store")}`,
      `FAIL  pooler: ${words} Fix: ${NOT_ANSWERED_FIX}. See ${docsLink("doctor-pooler")}`,
      `FAIL  worker heartbeat: ${words} Fix: ${NOT_ANSWERED_FIX}. See ${docsLink("doctor-worker")}`,
      "ok    FACETDB_SECRET: FACETDB_SECRET is set",
      "3 of 11 checks failed.",
    ]);
    // The source's own database answered: its checks keep what they found.
    for (const label of ["database", "pooler", "capture", "install"]) {
      expect(lines.filter((text) => text.slice(6).startsWith(`${label}:`))[0]).toMatch(/^ok /);
    }
    expect(lineOf(result.stdout, "model key")).toMatch(/^ok {4}model key:/);
    // One connection to the store, opened with the 10-second connect timeout; the heartbeat step
    // found the server already silent and opened none.
    expect(store.opened).toEqual([{ connectTimeoutSeconds: 10 }]);
    // The step given up on ended the connection it opened: nothing of it holds the process.
    expect(store.closed()).toBe(1);
    expect(clock.now()).toBe(START + DOCTOR_STEP_MS);
    expect(clock.pending()).toEqual([]);
    expectNoSecret(result.stdout + result.stderr);
  });

  it("@timing gives up on the model's look at the store first when it runs online, and the store's checks then fail at once", async () => {
    const clock = new SteppedClock(START);
    const store = silentStore();
    const running = doctor({
      clock,
      engines: [answeringEntry()],
      connect: store.connect,
      env: { DATABASE_URL: STORE_URL, FACETDB_SECRET: SECRET, TYPESAFE_API_KEY: MODEL_KEY },
    });
    await runOutTheStep(clock, () => store.opened.length > 0);
    const result = await running;
    expect(lineOf(result.stdout, "model reachable")).toMatch(/^ok {4}model reachable:/);
    expect(lineOf(result.stdout, "model name")).toBe(
      "warn  model name: the store could not be read, so no source's model was compared with the one its version is held to: the server at store.example.com:5432 did not answer within 10 seconds",
    );
    expect(lineOf(result.stdout, "store")).toMatch(
      /^FAIL {2}store: the FacetDB store: the server at store\.example\.com:5432 did not answer within 10 seconds/,
    );
    expect(store.opened).toHaveLength(1);
    expect(clock.now()).toBe(START + DOCTOR_STEP_MS);
    expect(clock.pending()).toEqual([]);
    expectNoSecret(result.stdout + result.stderr);
  });

  it("says a store connection that timed out in plain words, never the driver's", async () => {
    const clock = new SteppedClock(START);
    const opened: unknown[] = [];
    // What postgres.js throws when connect_timeout passes (a boundary: read by its code alone).
    const timedOut = Object.assign(new Error("write CONNECT_TIMEOUT store.example.com:5432"), {
      code: "CONNECT_TIMEOUT",
    });
    const connect: SqlConnect = (_url, options) => {
      opened.push(options);
      return {
        query: () => Promise.reject(timedOut),
        transaction: () => Promise.reject(timedOut),
        pipeline: () => Promise.reject(timedOut),
        close: () => Promise.resolve(),
      };
    };
    const result = await doctor({
      clock,
      engines: [answeringEntry()],
      connect,
      env: { DATABASE_URL: STORE_URL, FACETDB_SECRET: SECRET, TYPESAFE_API_KEY: MODEL_KEY },
      argv: ["--offline"],
    });
    expect(lineOf(result.stdout, "store")).toBe(
      `FAIL  store: the FacetDB store on store.example.com:5432/facetdb could not be read: the server at store.example.com:5432 did not answer within 10 seconds Fix: check the host, port, user and password in DATABASE_URL, and that the database accepts connections from this machine (a firewall or an allow-list). See ${docsLink("doctor-store")}`,
    );
    // The driver's own connect timeout makes the server silent too: the heartbeat opens nothing.
    expect(lineOf(result.stdout, "worker heartbeat")).toContain(
      "the FacetDB store: the server at store.example.com:5432 did not answer within 10 seconds",
    );
    expect(result.stdout).not.toContain("CONNECT_TIMEOUT");
    expect(opened).toEqual([{ connectTimeoutSeconds: 10 }]);
    expect(clock.pending()).toEqual([]);
  });
});

describe("a config that never loads (doctor-timeout)", () => {
  it("@timing fails the config check in its words after 10 seconds, and the secret check still runs", async () => {
    const clock = new SteppedClock(START);
    let loading = false;
    const running = doctor({
      clock,
      engines: [],
      connect: unreachable,
      env: { FACETDB_SECRET: SECRET },
      loadConfig: () => {
        loading = true;
        return new Promise(() => undefined);
      },
    });
    await runOutTheStep(clock, () => loading);
    const result = await running;
    expect(lineOf(result.stdout, "config")).toBe(
      `FAIL  config: facetdb.config.ts did not load within 10 seconds Fix: check that facetdb.config.ts and the plugins it names load without waiting on the network, then run facetdb doctor again. See ${docsLink("doctor-config")}`,
    );
    expect(lineOf(result.stdout, "database")).toBe(
      "skip  database: not checked: the config did not load",
    );
    expect(lineOf(result.stdout, "FACETDB_SECRET")).toMatch(/^ok {4}FACETDB_SECRET:/);
    expect(clock.pending()).toEqual([]);
  });
});

describe("a run where every step answers (doctor-timeout)", () => {
  it("@timing waits on nothing: every step's timer is cleared as it ends, and the clock never moves", async () => {
    const clock = new SteppedClock(START);
    const result = await doctor({
      clock,
      engines: [answeringEntry()],
      connect: unreachable,
      // No store: the heartbeat fails at once in its words, and nothing waits.
      env: { FACETDB_SECRET: SECRET, TYPESAFE_API_KEY: MODEL_KEY },
    });
    expect(lineOf(result.stdout, "database")).toBe("ok    database: logged in as facetdb_worker");
    expect(clock.now()).toBe(START);
    expect(clock.pending()).toEqual([]);
  });
});

/**
 * An engine that reports each check as it ends, as the Postgres engine does: for a database
 * `hangs` calls `never` it ends nothing; `after-database` answers the `database` check and then
 * never ends the next one; `no` answers every check.
 */
class SlowEngine extends FakeEngine {
  readonly asked: string[] = [];
  readonly #hangs: (url: string) => "never" | "after-database" | "no";
  constructor(hangs: (url: string) => "never" | "after-database" | "no") {
    super({ name: "postgres", schemes: ["postgres"], checks: CHECKS });
    this.#hangs = hangs;
  }
  override doctor(
    _target: EngineTarget,
    url: string,
    deps: DoctorDeps,
  ): Promise<readonly DoctorCheck[]> {
    this.asked.push(url);
    const how = this.#hangs(url);
    if (how === "never") {
      return new Promise(() => undefined);
    }
    if (how === "after-database") {
      const [database] = OK;
      if (database !== undefined) {
        deps.onCheck?.(database);
      }
      return new Promise(() => undefined);
    }
    for (const check of OK) {
      deps.onCheck?.(check);
    }
    return Promise.resolve(OK);
  }
}

const SLOW_FIX =
  "the database answered but this check was slow: run facetdb doctor again, and if it repeats, look at the server's load";

describe("a source whose database answers and whose later check never ends (doctor-timeout)", () => {
  it("@timing keeps the database line, says the rest did not finish, and still asks the store on the same host", async () => {
    const clock = new SteppedClock(START);
    const engine = new SlowEngine(() => "after-database");
    // The store: another database on the same host, which answers (with a refusal) at once.
    const storeOnSameHost = `postgres://facetdb_store:${STORE_PASSWORD}@db.example.com:5432/facetdb?sslmode=require`;
    const opened: string[] = [];
    const connect: SqlConnect = (url) => {
      opened.push(url);
      const refused = () => Promise.reject(new Error("the store said no"));
      return {
        query: refused,
        transaction: refused,
        pipeline: refused,
        close: () => Promise.resolve(),
      };
    };
    const running = doctor({
      clock,
      engines: [lazyEngine("postgres", () => Promise.resolve(engine))],
      connect,
      env: { DATABASE_URL: storeOnSameHost, FACETDB_SECRET: SECRET, TYPESAFE_API_KEY: MODEL_KEY },
      argv: ["--offline"],
    });
    await runOutTheStep(clock, () => engine.asked.length > 0);
    const result = await running;
    const lines = result.stdout.split("\n");
    expect(lines.filter((text) => text.slice(6).startsWith("database:"))).toEqual([
      "ok    database: logged in as facetdb_worker",
    ]);
    for (const label of ["pooler", "capture", "install"]) {
      expect(lines.find((text) => text.startsWith(`FAIL  ${label}: "listings"`))).toBe(
        `FAIL  ${label}: "listings": the ${label} check did not finish within 10 seconds Fix: ${SLOW_FIX}. See ${docsLink(`doctor-${label}`)}`,
      );
    }
    expect(result.stdout).not.toContain("did not answer");
    // The host answered: the store on it was asked (its check and the heartbeat), not failed unasked.
    expect(lineOf(result.stdout, "store")).toContain("could not be read: the store said no");
    expect(opened).toEqual([storeOnSameHost, storeOnSameHost]);
    expect(clock.now()).toBe(START + DOCTOR_STEP_MS);
    expect(clock.pending()).toEqual([]);
    expectNoSecret(result.stdout + result.stderr);
  });

  it("@timing fails a silent database on a shared pooler host without failing another database on it", async () => {
    const clock = new SteppedClock(START);
    const one = `postgres://facetdb_worker:${SOURCE_PASSWORD}@pool.example.com:6432/app_one?sslmode=require`;
    const two = `postgres://facetdb_worker:${SOURCE_PASSWORD}@pool.example.com:6432/app_two?sslmode=require`;
    const engine = new SlowEngine((url) => (url === one ? "never" : "no"));
    const source = (name: string, database: string) => ({
      name,
      database,
      table: name,
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    });
    const running = doctor({
      clock,
      engines: [lazyEngine("postgres", () => Promise.resolve(engine))],
      connect: unreachable,
      env: { FACETDB_SECRET: SECRET, TYPESAFE_API_KEY: MODEL_KEY },
      loadConfig: () =>
        Promise.resolve(
          facetdb({ model: "jev-1.14.0", sources: [source("one", one), source("two", two)] }),
        ),
      argv: ["--offline"],
    });
    await runOutTheStep(clock, () => engine.asked.length > 0);
    const result = await running;
    const lines = result.stdout.split("\n");
    const group = (name: string) => {
      const start = lines.indexOf(`source ${name}:`);
      return lines.slice(start + 2, start + 6);
    };
    for (const text of group("one")) {
      expect(text).toMatch(
        /^FAIL {2}[a-z]+: "one": the server at pool\.example\.com:6432 did not answer within 10 seconds/,
      );
    }
    for (const text of group("two")) {
      expect(text).toMatch(/^ok /);
    }
    expect(engine.asked).toEqual([one, two]);
    expect(clock.now()).toBe(START + DOCTOR_STEP_MS);
  });
});

describe("a model that answers with a rate limit (doctor-timeout)", () => {
  it("@timing says the model answered that it is rate limiting, not that it did not answer", async () => {
    const clock = new SteppedClock(START);
    const provider = createFakeProvider({
      defaults: { noul: 0.9 },
      failures: { 0: { kind: "429", retryAfterMs: 60_000 } },
    });
    const running = doctor({
      clock,
      engines: [answeringEntry()],
      connect: unreachable,
      env: { FACETDB_SECRET: SECRET, TYPESAFE_API_KEY: MODEL_KEY },
      provider,
    });
    // The step's bound and the wait the 429's retry-after asked for.
    await until(() => clock.pending().length === 2);
    expect(provider.callCount).toBe(1);
    clock.advance(DOCTOR_STEP_MS);
    const result = await running;
    expect(lineOf(result.stdout, "model reachable")).toBe(
      `FAIL  model reachable: the model answered that it is rate limiting this project (429), and the test question did not get through within 10 seconds Fix: wait a minute and run facetdb doctor again; a worker running now may be using the project's whole rate limit. See ${docsLink("doctor-model-reachable")}`,
    );
    // The backoff's own wait is all that is left: the process's ending ends it (main.ts).
    expect(clock.pending()).toEqual([START + 60_000]);
  });
});

describe("a doctor run handed a clock whose waits end at once (doctor-timeout)", () => {
  const WIRING = "doctor's clock ended a 10 seconds wait without that time passing on it";

  it("fails loudly for core's FakeClock, which moves time as it sleeps", async () => {
    const result = await doctor({
      clock: new FakeClock(START),
      engines: [answeringEntry()],
      connect: unreachable,
      env: { FACETDB_SECRET: SECRET },
      argv: ["--offline"],
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(WIRING);
    expect(result.stdout).not.toContain("did not answer");
  });

  it("fails loudly for a clock whose sleep resolves while its time stands still", async () => {
    const result = await doctor({
      clock: { now: () => START, sleep: () => Promise.resolve() },
      engines: [answeringEntry()],
      connect: unreachable,
      env: { FACETDB_SECRET: SECRET },
      argv: ["--offline"],
    });
    expect(result.code).not.toBe(0);
    expect(result.stdout + result.stderr).toContain(WIRING);
  });
});

/** How many sockets the server holds open now. */
function openSockets(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.getConnections((error, count) => {
      if (error === null) {
        resolve(count);
      } else {
        reject(error);
      }
    });
  });
}

describe("a real socket that accepts and never answers (doctor-timeout)", () => {
  it("@timing ends with the database check failed in its words once postgres.js gives up, leaving nothing connected", async () => {
    // A server that takes every connection and never writes a byte. It reads and drops what the
    // driver sends, so it sees the driver end the connection.
    const sockets = new Set<Socket>();
    const ended: Promise<void>[] = [];
    const server = createServer((socket) => {
      sockets.add(socket);
      ended.push(
        new Promise((resolve) => {
          socket.once("close", () => {
            sockets.delete(socket);
            resolve();
          });
        }),
      );
      socket.resume();
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("the test server has no port");
    }
    const host = `127.0.0.1:${address.port}`;
    const url = `postgres://facetdb_worker:${SOURCE_PASSWORD}@${host}/app`;
    const clock = new SteppedClock(START);
    try {
      const result = await doctor({
        clock,
        engines: postgresEngines(connectPostgres),
        connect: connectPostgres,
        env: { DATABASE_URL: url, FACETDB_SECRET: SECRET },
        loadConfig: () =>
          Promise.resolve(
            facetdb({
              model: "jev-1.14.0",
              sources: [
                {
                  name: "listings",
                  database: url,
                  table: "listings",
                  read: ["title"],
                  questions: { is_scam: noul("Is this listing a scam?") },
                },
              ],
            }),
          ),
        argv: ["--offline"],
        // The step's bound is on the stepped clock, which never moves here: only the driver's
        // half-second connect timeout can end the step, so the option must have reached it.
        doctorBounds: { stepMs: 1_000, connectTimeoutSeconds: 0.5 },
      });
      expect(lineOf(result.stdout, "database")).toBe(
        `FAIL  database: "listings": the server at ${host} did not answer within 0.5 seconds Fix: check the host, port, user and password in DATABASE_URL, and that the database accepts connections from this machine (a firewall or an allow-list). See ${docsLink("doctor-database")}`,
      );
      expect(lineOf(result.stdout, "pooler")).toBe(
        "skip  pooler: not checked: the database check did not pass",
      );
      expect(lineOf(result.stdout, "worker heartbeat")).toContain(
        `the store is in the same database: the server at ${host} did not answer within 0.5 seconds`,
      );
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain("CONNECT_TIMEOUT");
      expectNoSecret(result.stdout + result.stderr);
      // One socket, opened once, and the driver ended it (else the test's limit fails it):
      // nothing the run opened is left connected.
      expect(ended).toHaveLength(1);
      await Promise.all(ended);
      expect(await openSockets(server)).toBe(0);
      expect(clock.now()).toBe(START);
      expect(clock.pending()).toEqual([]);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    expect(server.listening).toBe(false);
  }, 5_000);
});
