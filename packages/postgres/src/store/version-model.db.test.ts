import type { QuestionSet } from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../install/index.ts";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";
import { answerVersionModel } from "./question-sets.ts";
import { sourceIdOf } from "./source-id.ts";

/**
 * A version's model (store migration 11) against a real Postgres, as the worker login sets it: the
 * install grants it update on `answered_by` alone, and two workers' first answers on two
 * connections end with the first write, both answered its name. PGlite runs one connection as a
 * superuser and proves neither.
 */

const PASSWORD = "a-long-random-password-for-tests";
const HELD = "jev-1.14.0";
const OTHER = "strands-decider-7b";
const ID = sourceIdOf("proj_listings", "listings");
const listings: QuestionSet = {
  questions: [{ type: "noul", name: "is_scam", instructions: "A scam?", stakes: "high" }],
  read: ["title"],
  model: HELD,
  thresholds: {},
};

let scratch: ScratchDatabase;
const open: SqlClient[] = [];
let admin: SqlClient;

function workerLogin(): SqlClient {
  const client = connectPostgres(scratch.as(scratch.workerRole, PASSWORD));
  open.push(client);
  return client;
}

beforeAll(async () => {
  scratch = await createScratchDatabase();
  admin = connectPostgres(scratch.url);
  open.push(admin);
  await admin.query(`create table public.listings (id serial primary key, title text)`);
  const result = await migrate({
    adminUrl: scratch.url,
    print: () => undefined,
    plan: {
      source: { table: "listings" },
      questionSet: listings,
      project: { id: "proj_listings", name: "Listings" },
      roleSuffix: scratch.roleSuffix,
      workerPassword: PASSWORD,
    },
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
  await admin.query(
    `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set)
     values ($1, 1, 'h1', '{}'::jsonb), ($1, 2, 'h2', '{}'::jsonb)`,
    [ID],
  );
});

afterAll(async () => {
  const errors: unknown[] = [];
  for (const client of open.splice(0).reverse()) {
    await client.close().catch((error: unknown) => errors.push(error));
  }
  await scratch.drop().catch((error: unknown) => errors.push(error));
  if (errors.length > 0) {
    throw errors[0];
  }
});

async function rowOf(version: number): Promise<unknown> {
  const [row] = await admin.query(
    `select answered_by, xmin::text as xmin from facetdb.question_set_versions
      where source_id = $1 and version = $2`,
    [ID, version],
  );
  return row;
}

type Deferred = { readonly promise: Promise<void>; resolve(): void };

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Resolves once a session of the scratch database waits on a lock: the second worker's write,
 * queued behind the first's open transaction. A barrier on the server's own state, not a timing.
 */
async function waitingOnALock(): Promise<void> {
  for (let look = 0; look < 400; look += 1) {
    const [row] = await admin.query(
      `select count(*)::int as waiting from pg_stat_activity
        where datname = $1 and wait_event_type = 'Lock'`,
      [scratch.name],
    );
    if (row?.["waiting"] === 1) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the second worker's write never waited on the first's");
}

describe("a version's model, set by the worker login", () => {
  it("is set once by the first answer, then answered with nothing written", async () => {
    const worker = workerLogin();
    expect(await answerVersionModel(worker.query, ID, 1, HELD)).toBe(HELD);
    const held = await rowOf(1);
    expect(held).toMatchObject({ answered_by: HELD });
    expect(await answerVersionModel(worker.query, ID, 1, OTHER)).toBe(HELD);
    expect(await rowOf(1)).toEqual(held);
  });

  it("keeps the first of two overlapping first answers, and answers both its name", async () => {
    const [one, two] = [workerLogin(), workerLogin()];
    const firstWrote = deferred();
    const commitFirst = deferred();
    // The first worker reads no name, writes its own, and holds its transaction open.
    const first = one.transaction(async (query) => {
      const name = await answerVersionModel(query, ID, 2, HELD);
      firstWrote.resolve();
      await commitFirst.promise;
      return name;
    });
    await firstWrote.promise;
    // The second reads no name either, since the first has not committed, and its write waits on
    // the row: without `coalesce` it would overwrite the first's name once that commits.
    const second = two.transaction((query) => answerVersionModel(query, ID, 2, OTHER));
    await waitingOnALock();
    commitFirst.resolve();

    expect(await Promise.all([first, second])).toEqual([HELD, HELD]);
    expect(await rowOf(2)).toMatchObject({ answered_by: HELD });
  });

  it("may update that column and nothing else of the versions", async () => {
    const worker = workerLogin();
    for (const column of ["content_hash = 'x'", "question_set = '{}'::jsonb"]) {
      await expect(
        worker.query(`update facetdb.question_set_versions set ${column} where source_id = $1`, [
          ID,
        ]),
      ).rejects.toThrow(/permission denied/);
    }
    await expect(
      worker.query(`delete from facetdb.question_set_versions where source_id = $1`, [ID]),
    ).rejects.toThrow(/permission denied/);
  });
});
