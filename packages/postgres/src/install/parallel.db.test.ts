import type { Clock, QuestionSet } from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresConnector, type PostgresConnector } from "../capture/index.ts";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";
import { migrate } from "./migrate.ts";
import { uninstall } from "./uninstall.ts";

/**
 * Two installs on one server, each with its own role suffix, as the parallel `*.db.test.ts` files
 * and two `test:db` runs side by side make them. Before the suffix, every suite created and dropped
 * the one cluster-wide `facetdb_worker`, so a file's cleanup broke another's login mid-test. Here
 * one install's uninstall and the drop of its roles run while the other's worker claims, reads,
 * writes and acks, and neither notices the other.
 */

const questionSet: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

const PASSWORD = "a-long-random-password-for-tests";
const ROUNDS = 20;

const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** The two scratch databases still to drop (one is dropped by the test itself). */
const scratches: ScratchDatabase[] = [];
const clients: SqlClient[] = [];
const connectors: PostgresConnector[] = [];

function install(scratch: ScratchDatabase) {
  return migrate({
    adminUrl: scratch.url,
    print: () => undefined,
    plan: {
      source: { table: "listings" },
      questionSet,
      project: { id: "proj_listings", name: "Listings" },
      workerPassword: PASSWORD,
      roleSuffix: scratch.roleSuffix,
    },
  });
}

let a: ScratchDatabase;
let b: ScratchDatabase;
let adminA: SqlClient;

/** Which of these roles exist on the server (roles are cluster-wide: any database shows them). */
async function rolesPresent(names: readonly string[]): Promise<readonly string[]> {
  const rows = await adminA.query(
    `select rolname from pg_catalog.pg_roles where rolname = any($1::text[]) order by 1`,
    [names],
  );
  return rows.map((row) => String(row["rolname"]));
}

beforeAll(async () => {
  [a, b] = await Promise.all([createScratchDatabase(), createScratchDatabase()]);
  scratches.push(a, b);
  adminA = connectPostgres(a.url);
  clients.push(adminA);
  for (const scratch of [a, b]) {
    const admin = connectPostgres(scratch.url);
    try {
      await admin.query(`create table public.listings (id text primary key, title text)`);
    } finally {
      await admin.close();
    }
  }
});

afterAll(async () => {
  for (const connector of connectors.splice(0)) {
    await connector.close();
  }
  for (const client of clients.splice(0)) {
    await client.close();
  }
  for (const scratch of scratches.splice(0)) {
    await scratch.drop();
  }
});

describe("two installs with their own role suffixes on one server", () => {
  it("install at once, each creating its own two roles", async () => {
    expect(a.roleSuffix).not.toBe(b.roleSuffix);
    const [installedA, installedB] = await Promise.all([install(a), install(b)]);
    expect(installedA).toMatchObject({ ok: true, applied: true, workerPasswordApplied: true });
    expect(installedB).toMatchObject({ ok: true, applied: true, workerPasswordApplied: true });
    const names = [a.workerRole, a.enqueueRole, b.workerRole, b.enqueueRole];
    expect(await rolesPresent(names)).toEqual([...names].sort());
  });

  it("one uninstalls and drops its roles while the other's worker claims, reads, writes and acks", async () => {
    const workerA = createPostgresConnector({
      workerUrl: a.as(a.workerRole, PASSWORD),
      source: { table: "listings", key: "id" },
      questionSet,
      clock: realClock,
      workerId: "a",
    });
    connectors.push(workerA);
    const work = async (): Promise<number> => {
      let written = 0;
      for (let round = 0; round < ROUNDS; round++) {
        const key = `r${round}`;
        await adminA.query(`insert into public.listings (id, title) values ($1, $2)`, [key, key]);
        expect(await workerA.claim(5)).toEqual([key]);
        const { rows } = await workerA.read([key]);
        const outcome = await workerA.write(
          key,
          {
            decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.1 } },
            status: "done",
          },
          rows[0]?.hash ?? "",
        );
        written += outcome.written ? 1 : 0;
        await workerA.ack([key]);
      }
      return written;
    };
    const removeB = async () => {
      const removed = await uninstall({
        adminUrl: b.url,
        source: { table: "listings", name: "listings", projectId: "proj_listings" },
        print: () => undefined,
        confirm: () => Promise.resolve("Listings"),
        roleSuffix: b.roleSuffix,
      });
      await b.drop();
      scratches.splice(scratches.indexOf(b), 1);
      return removed;
    };
    const [written, removed] = await Promise.all([work(), removeB()]);
    expect(removed).toMatchObject({ ok: true, applied: true });
    expect(written).toBe(ROUNDS);
    expect(
      await adminA.query(
        `select count(*)::int as n from public.listings where facetdb_status = 'done' and is_scam = false`,
      ),
    ).toEqual([{ n: ROUNDS }]);
    // B's roles went with its database; A's are untouched and its login still works.
    expect(await rolesPresent([a.workerRole, a.enqueueRole, b.workerRole, b.enqueueRole])).toEqual(
      [a.enqueueRole, a.workerRole].sort(),
    );
    expect(await workerA.read(["r0"])).toMatchObject({ missing: [] });
  });
});
