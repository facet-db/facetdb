import type { QuestionSet } from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../install/index.ts";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";
import { sourceIdOf } from "./source-id.ts";
import {
  claimVersionProbe,
  clearVersionHold,
  readVersionHold,
  setVersionHold,
} from "./version-hold.ts";

/**
 * A version's hold (store migration 12) against a real Postgres, as the worker login writes it: the
 * install grants it update on the hold's columns, and workers on separate connections claiming the
 * probe at one instant end with exactly one probe, the others told the next time. PGlite runs one
 * connection as a superuser and proves neither.
 */

const PASSWORD = "a-long-random-password-for-tests";
const HELD = "jev-1.14.0";
const OTHER = "strands-decider-7b";
const ID = sourceIdOf("proj_listings", "listings");
const T = 1_700_000_000_000;
const EVERY = 5 * 60_000;
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
    `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set, answered_by)
     values ($1, 1, 'h1', '{}'::jsonb, $2), ($1, 2, 'h2', '{}'::jsonb, $2), ($1, 3, 'h3', '{}'::jsonb, $2)`,
    [ID, HELD],
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

type Deferred = { readonly promise: Promise<void>; resolve(): void };

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/**
 * Resolves once a session of the scratch database waits on a lock: the second worker's statement,
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
  throw new Error("the second worker's statement never waited on the first's");
}

async function probeAtOf(version: number): Promise<unknown> {
  const [row] = await admin.query(
    `select held_by, probe_at::text as probe_at from facetdb.question_set_versions
      where source_id = $1 and version = $2`,
    [ID, version],
  );
  return row;
}

describe("a version's hold, written by the worker login", () => {
  it("is set, read, claimed and cleared by the worker login", async () => {
    const worker = workerLogin();
    expect(await setVersionHold(worker.query, ID, 1, OTHER, T + EVERY)).toBe(T + EVERY);
    expect(await readVersionHold(worker.query, ID, 1)).toEqual({
      held: HELD,
      named: OTHER,
      probeAt: T + EVERY,
    });
    expect(await claimVersionProbe(worker.query, ID, 1, T + EVERY, T + 2 * EVERY)).toEqual({
      kind: "claimed",
    });
    await clearVersionHold(worker.query, ID, 1);
    expect(await probeAtOf(1)).toEqual({ held_by: null, probe_at: null });
  });

  it("lets exactly one of several workers claiming at one instant probe", async () => {
    await setVersionHold(admin.query, ID, 2, OTHER, T + EVERY);
    const workers = [workerLogin(), workerLogin(), workerLogin(), workerLogin()];
    // Each connection is open before the claims go, so they reach the server together.
    await Promise.all(workers.map((worker) => worker.query("select 1")));
    const claims = await Promise.all(
      workers.map((worker) => claimVersionProbe(worker.query, ID, 2, T + EVERY, T + 2 * EVERY)),
    );
    expect(claims.filter((claim) => claim.kind === "claimed")).toHaveLength(1);
    expect(claims.filter((claim) => claim.kind === "taken")).toHaveLength(workers.length - 1);
    expect(await probeAtOf(2)).toEqual({ held_by: OTHER, probe_at: String(T + 2 * EVERY) });
  });

  it("lets the second of two overlapping claims find the first's moved time, never a second probe", async () => {
    await setVersionHold(admin.query, ID, 3, OTHER, T + EVERY);
    const [one, two] = [workerLogin(), workerLogin()];
    const firstClaimed = deferred();
    const commitFirst = deferred();
    // The first worker claims, and holds its transaction open.
    const first = one.transaction(async (query) => {
      const claim = await claimVersionProbe(query, ID, 3, T + EVERY, T + 2 * EVERY);
      firstClaimed.resolve();
      await commitFirst.promise;
      return claim;
    });
    await firstClaimed.promise;
    // The second claims at the same instant: its update waits on the row, then finds the moved
    // time once the first commits, and claims nothing.
    const second = two.transaction((query) =>
      claimVersionProbe(query, ID, 3, T + EVERY, T + 2 * EVERY),
    );
    await waitingOnALock();
    commitFirst.resolve();

    const [won, lost] = await Promise.all([first, second]);
    expect(won).toEqual({ kind: "claimed" });
    // Its select read the row as the statement began: the time it replaced, which the worker turns
    // into 5 minutes from now.
    expect(lost).toEqual({ kind: "taken", probeAt: T + EVERY });
    expect(await probeAtOf(3)).toEqual({ held_by: OTHER, probe_at: String(T + 2 * EVERY) });
  });

  it("keeps the first of two overlapping holds' probe time", async () => {
    await clearVersionHold(admin.query, ID, 3);
    const [one, two] = [workerLogin(), workerLogin()];
    const firstHeld = deferred();
    const commitFirst = deferred();
    const first = one.transaction(async (query) => {
      const probeAt = await setVersionHold(query, ID, 3, OTHER, T + EVERY);
      firstHeld.resolve();
      await commitFirst.promise;
      return probeAt;
    });
    await firstHeld.promise;
    // The second reads no hold before the first commits; its update waits on the row and then
    // keeps the first's time, as the one statement re-reads the row it waited on.
    const second = two.transaction((query) =>
      setVersionHold(query, ID, 3, "jev-1.15.0", T + 60_000 + EVERY),
    );
    await waitingOnALock();
    commitFirst.resolve();

    expect(await Promise.all([first, second])).toEqual([T + EVERY, T + EVERY]);
    expect(await probeAtOf(3)).toEqual({ held_by: "jev-1.15.0", probe_at: String(T + EVERY) });
  });

  it("may update the hold's columns and the model's, and nothing else of the versions", async () => {
    const worker = workerLogin();
    for (const column of ["content_hash = 'x'", "question_set = '{}'::jsonb", "version = 9"]) {
      await expect(
        worker.query(`update facetdb.question_set_versions set ${column} where source_id = $1`, [
          ID,
        ]),
      ).rejects.toThrow(/permission denied/);
    }
  });
});
