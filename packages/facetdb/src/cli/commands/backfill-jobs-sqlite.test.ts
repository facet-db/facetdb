import type { EngineTarget } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import {
  BUSY_TIMEOUT_MS,
  createSqliteConnector,
  OWNERS_TABLE,
  openNodeSqlite,
  planInstall,
  run,
  type SqliteConnector,
  sharedClients,
  sqliteQuery,
} from "@facetdb/sqlite";
import { FakeRepeat, type TemporaryDatabase, temporaryDatabase } from "@facetdb/sqlite/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  anAddedQuestionJobBesideTheLoop,
  aWholeSetJobBesideTheLoop,
  bodyOf,
  type EngineWorld,
  listingsQuestionSet,
  WORLD_KEYS,
} from "./backfill-jobs-world.ts";

/**
 * A backfill job beside a worker's loop on a real SQLite file. SQLite settles a claim by the worker
 * id alone and keeps the one worker's lock on the table by it, so a job that read under the loop's
 * id released the loop's claim of a record that changed while the job asked about it, and let go of
 * the loop's lock when it closed. The job reads under an id of its own, as `facetdb backfill` does
 * from its own process.
 */

const LOOP_ID = "worker-of-the-loop";
const START = Date.parse("2026-11-10T09:00:00.000Z");

const target: EngineTarget = {
  project: { id: "proj_market", name: "Market" },
  source: "listings",
  table: "listings",
  storage: "inline",
  onChange: "keep",
  questionSet: listingsQuestionSet(),
};

let file: TemporaryDatabase | undefined;
const open: SqliteConnector[] = [];

afterEach(async () => {
  for (const connector of open.splice(0)) {
    await connector.close();
  }
  file?.remove();
  file = undefined;
});

/** The file installed, its six records inserted, and the loop's connector with its queue settled. */
async function world(): Promise<EngineWorld & { lockHolder(): unknown }> {
  const database = temporaryDatabase();
  file = database;
  const app = database.open({ timeout: BUSY_TIMEOUT_MS });
  app.exec("create table listings (id text primary key, body text)");
  const reader = database.open({ readOnly: true });
  const planned = await planInstall(target, sqliteQuery(reader));
  reader.close();
  if (!planned.ok) {
    throw new Error(planned.refusal.message);
  }
  const installed = run(target, planned.plan, database.path);
  if (installed.stopped !== undefined) {
    throw new Error(`the install stopped: ${JSON.stringify(installed.stopped)}`);
  }
  for (const key of WORLD_KEYS) {
    app.prepare("insert into listings (id, body) values (?, ?)").run(key, bodyOf(key));
  }

  const clock = new FakeClock(START);
  // Every connector's lock heartbeat: none beats unless a test moves the clock through one.
  const beats = new FakeRepeat(clock);
  // As the engine opens them: every connector of the process on one file shares one client, so
  // the loop's statements and a job's take turns instead of waiting on each other's write lock.
  const share = sharedClients(openNodeSqlite, (path) => path);
  const connect = async (workerId: string): Promise<SqliteConnector> => {
    const connector = await createSqliteConnector(target, database.path, {
      clock,
      repeat: beats.repeat,
      workerId,
      open: share,
    });
    open.push(connector);
    return connector;
  };
  const loopConnector = await connect(LOOP_ID);
  // The loop answered what the inserts queued: the claim takes the table's lock, as a pass does.
  await loopConnector.ack(await loopConnector.claim(100));

  // The application is another process, which waits for the worker's write lock. Here it shares the
  // worker's thread, where a statement that waited would keep the worker from ever letting go: it
  // tries without waiting, lets the worker go on, and tries again.
  const application = database.open({ timeout: 0 });
  const rewrite = application.prepare("update listings set body = ? where id = ?");

  return {
    loopConnector,
    open: connect,
    edit: async (key, body) => {
      for (let attempt = 0; ; attempt += 1) {
        try {
          rewrite.run(body, key);
          return;
        } catch (error) {
          if (attempt === 500 || !/locked|busy/i.test(String(error))) {
            throw error;
          }
          await new Promise((resolve) => setImmediate(resolve));
        }
      }
    },
    lockHolder: () =>
      app.prepare(`select worker_id from ${OWNERS_TABLE} where table_name = 'listings'`).get()?.[
        "worker_id"
      ],
  };
}

describe("a backfill job beside the loop on a SQLite file", () => {
  it("leaves the loop's claim of a record that changed while the job asked about it, and the loop's lock on the table", async () => {
    const t = await world();
    expect(t.lockHolder()).toBe(LOOP_ID);

    await anAddedQuestionJobBesideTheLoop(t);

    // The job's connector closed: the one worker's lock is still the loop's.
    expect(t.lockHolder()).toBe(LOOP_ID);
  });

  it("puts a whole set's records where the loop claims them, and leaves the loop's lock on the table", async () => {
    const t = await world();

    await aWholeSetJobBesideTheLoop(t);

    expect(t.lockHolder()).toBe(LOOP_ID);
  });
});
