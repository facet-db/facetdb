import type { DatabaseSync } from "node:sqlite";
import type { Clock } from "@facetdb/core";
import { createFakeProvider, type FakeProvider } from "@facetdb/model";
import { POLL_MS } from "@facetdb/sqlite";
import { type TemporaryDatabase, temporaryDatabase } from "@facetdb/sqlite/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { facetdb, noul, type ProjectConfig } from "../config/index.ts";
import { engineTarget, projectRef, splitTable } from "./commands/database.ts";
import { COMMANDS } from "./commands/index.ts";
import { engineFor } from "./engines.ts";
import { processDeps } from "./main.ts";
import { runInProcess } from "./program.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  type Store,
  TEST_SECRET,
} from "./testing.ts";

/**
 * `facetdb worker` on a SQLite file, through the SQLite engine exactly as main.ts registers it: the
 * file is installed by the engine's own plan, the application inserts a row from a handle of its
 * own, and the worker, polling the file every second, answers it within two polls with the fake
 * provider, then lets go of its lock when stopped. The store is PGlite: a SQLite source keeps its
 * log in the Postgres store.
 */

const PROJECT_DIR = "/work/listings-app";
const START = 1_700_000_000_000;

/** A clock whose sleeps end only when the test moves time past them: one step, one poll. */
class SteppedClock implements Clock {
  #time: number;
  #sleepers: { readonly due: number; readonly wake: () => void }[] = [];
  constructor(start: number) {
    this.#time = start;
  }
  now(): number {
    return this.#time;
  }
  sleep(ms: number): Promise<void> {
    return new Promise((wake) => {
      this.#sleepers.push({ due: this.#time + ms, wake });
    });
  }
  advance(ms: number): void {
    this.#time += ms;
    const due = this.#sleepers.filter((sleeper) => sleeper.due <= this.#time);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.due > this.#time);
    for (const sleeper of due) {
      sleeper.wake();
    }
  }
}

let world: PgliteWorld;
let store: Store;
let clock: SteppedClock;
let provider: FakeProvider;
let file: TemporaryDatabase;
let app: DatabaseSync;
let config: ProjectConfig;

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
  file = temporaryDatabase();
  app = file.open({ timeout: 5_000 });
  app.exec("create table listings (id integer primary key, title text)");
  config = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        // A bare path ending in .db: the SQLite engine's.
        database: file.path,
        table: "listings",
        read: ["title"],
        questions: { is_scam: noul("Is this listing a scam?") },
      },
    ],
  });
  // `facetdb migrate`'s plan and run, through the engine main.ts registers.
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  const engine = await engineFor(processDeps().engines, file.path);
  const target = engineTarget(
    config,
    { source, ...splitTable("listings") },
    projectRef(PROJECT_DIR),
  );
  const deps = { clock, allowInsecure: false, storeShared: false };
  const planned = await engine.planInstall(target, file.path, deps);
  if (!planned.ok) {
    throw new Error(planned.refusal.message);
  }
  const ran = await engine.run(target, planned.plan, file.path, deps);
  if (ran.stopped !== undefined) {
    throw new Error(`the install stopped: ${JSON.stringify(ran.stopped)}`);
  }
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
  file.remove();
});

function runWorker(stop: AbortSignal) {
  return runInProcess(
    ["worker", "--no-http"],
    {
      projectDir: PROJECT_DIR,
      env: {
        DATABASE_URL: "postgres://localhost:5432/facetdb",
        FACETDB_SECRET: TEST_SECRET,
        TYPESAFE_API_KEY: "ts-test-key",
      },
      loadConfig: () => Promise.resolve(config),
      // The composition root's own registration: the SQLite engine is loaded for the .db path.
      engines: processDeps().engines,
      connect: world.connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      provider: () => provider,
      clock,
      random: () => 0.5,
      stopSignal: () => stop,
    },
    COMMANDS,
  );
}

function listing(id: number): Record<string, unknown> | undefined {
  return app
    .prepare("select is_scam, is_scam_probability, facetdb_status from listings where id = ?")
    .get(id);
}

function lock(): Record<string, unknown> | undefined {
  return app
    .prepare("select worker_id, heartbeat_at from facetdb_table_owners where table_name = ?")
    .get("listings");
}

describe("facetdb worker on a SQLite file", () => {
  it("@timing answers a row the application inserts within two polls, and lets go of its lock when stopped", async () => {
    const stop = new AbortController();
    const running = runWorker(stop.signal);

    // Started: the first poll took the file's one worker lock, and the heartbeat is in the store.
    await vi.waitFor(
      async () => {
        expect(lock()?.["worker_id"]).toMatch(/^worker-/);
        expect(await store.alerts.lastHeartbeat(projectRef(PROJECT_DIR).id)).toBe(START);
      },
      { timeout: 10_000 },
    );

    app.prepare("insert into listings (id, title) values (?, ?)").run(1, "A red car");
    expect(listing(1)).toMatchObject({ facetdb_status: "pending", is_scam: null });

    // Two polls of the file at most; the worker is asleep on the clock until it moves.
    for (let poll = 1; poll <= 2 && listing(1)?.["facetdb_status"] !== "done"; poll += 1) {
      clock.advance(POLL_MS);
      await vi
        .waitFor(() => expect(listing(1)).toMatchObject({ facetdb_status: "done" }), {
          timeout: 2_000,
        })
        .catch(() => undefined);
    }
    expect(listing(1)).toEqual({ is_scam: 0, is_scam_probability: 0.01, facetdb_status: "done" });
    expect(provider.callCount).toBe(1);
    expect(app.prepare("select count(*) as n from facetdb_jobs").get()).toEqual({ n: 0 });

    stop.abort();
    const result = await running;
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Worker running for listings.");
    expect(result.stdout).toContain("listings: answered 1");
    expect(result.stdout).toContain("Stopped: every claim was settled.");
    expect(lock()).toEqual({ worker_id: null, heartbeat_at: null });
  });

  it("a second worker on the same file is refused while the first one runs", async () => {
    const stop = new AbortController();
    const first = runWorker(stop.signal);
    await vi.waitFor(() => expect(lock()?.["worker_id"]).toMatch(/^worker-/), {
      timeout: 10_000,
    });

    const second = await runWorker(new AbortController().signal);
    expect(second.code).toBe(1);
    expect(second.stderr).toMatch(
      /error: SQLite allows one worker, and worker worker-\S+ holds the lock on listings in /,
    );
    expect(second.stderr).toContain(
      `it last renewed it at ${new Date(START).toISOString()}, and the lock frees at ${new Date(START + 2 * 60_000).toISOString()}`,
    );

    stop.abort();
    expect((await first).code).toBe(0);
  });
});
