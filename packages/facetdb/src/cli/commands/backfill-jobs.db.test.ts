import type { Clock } from "@facetdb/core";
import {
  connectPostgres,
  createPostgresConnector,
  migrate,
  type PostgresConnector,
  type SqlClient,
} from "@facetdb/postgres";
import { createScratchDatabase, type ScratchDatabase } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
import {
  anAddedQuestionJobBesideTheLoop,
  aWholeSetJobBesideTheLoop,
  bodyOf,
  type EngineWorld,
  listingsQuestionSet,
  WORLD_KEYS,
} from "./backfill-jobs-world.ts";

/**
 * A backfill job beside a worker's loop on a real Postgres, for what the fakes and PGlite's single
 * connection cannot show: the loop's connector and the job's own, each on its own connection under
 * its own worker id, claiming from the one jobs table while the application changes a record the
 * job is asking about; and a whole set's records landing in the queue the loop claims from.
 */

const PASSWORD = "a-long-random-password-for-tests";
const LOOP_ID = "worker-of-the-loop";

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let scratch: ScratchDatabase;
let admin: SqlClient;
const open: PostgresConnector[] = [];

beforeAll(async () => {
  scratch = await createScratchDatabase();
  admin = connectPostgres(scratch.url);
  await admin.query("create table public.listings (id text primary key, body text)");
  const result = await migrate({
    adminUrl: scratch.url,
    print: () => undefined,
    plan: {
      source: { table: "listings" },
      questionSet: listingsQuestionSet(),
      project: { id: "proj_market", name: "Market" },
      workerPassword: PASSWORD,
      roleSuffix: scratch.roleSuffix,
    },
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
});

afterEach(async () => {
  for (const connector of open.splice(0)) {
    await connector.close();
  }
});

afterAll(async () => {
  await admin.close();
  await scratch.drop();
});

function connect(workerId: string): PostgresConnector {
  const connector = createPostgresConnector({
    workerUrl: scratch.as(scratch.workerRole, PASSWORD),
    source: { table: "listings", key: "id" },
    questionSet: listingsQuestionSet(),
    clock: realClock,
    pollMs: 10_000,
    workerId,
  });
  open.push(connector);
  return connector;
}

/** The table emptied and filled again, and the loop's connector with its queue settled. */
async function world(): Promise<EngineWorld> {
  await admin.query("truncate public.listings");
  await admin.query("delete from facetdb.jobs");
  for (const key of WORLD_KEYS) {
    await admin.query("insert into public.listings (id, body) values ($1, $2)", [key, bodyOf(key)]);
  }
  const loopConnector = connect(LOOP_ID);
  // The loop answered what the inserts queued.
  await loopConnector.ack(await loopConnector.claim(100));
  return {
    loopConnector,
    open: (workerId) => Promise.resolve(connect(workerId)),
    // The application's own connection, as the database's owner here.
    edit: async (key, body) => {
      await admin.query("update public.listings set body = $1 where id = $2", [body, key]);
    },
  };
}

describe("a backfill job beside the loop on a real Postgres", () => {
  it("leaves the loop's claim of a record that changed while the job asked about it, and writes no answer for the state that is gone", async () => {
    await anAddedQuestionJobBesideTheLoop(await world());
  });

  it("puts a whole set's records in the queue the loop claims from, each once", async () => {
    await aWholeSetJobBesideTheLoop(await world());
  });
});
