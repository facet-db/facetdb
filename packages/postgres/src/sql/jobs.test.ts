import { afterEach, describe, expect, it } from "vitest";
import { createPgliteWorld, type PgliteWorld } from "../testing/index.ts";
import { CLAIM_LEASE_MS, createClaimLedger, jobsQueries, jobsTableSql } from "./jobs.ts";

/** The queue's SQL on PGlite: what each statement does to the rows, and how many it names. */

let world: PgliteWorld | undefined;
afterEach(async () => {
  await world?.close();
  world = undefined;
});

async function queue(): Promise<PgliteWorld> {
  world = await createPgliteWorld();
  for (const statement of jobsTableSql()) {
    await world.client.query(statement);
  }
  return world;
}

const T1 = 1_700_000_000_000;
const T2 = T1 + CLAIM_LEASE_MS + 1;

async function claimedBy(w: PgliteWorld, key: string): Promise<string | null | "gone"> {
  const rows = await w.client.query(`select claimed_by from facetdb.jobs where record_key = $1`, [
    key,
  ]);
  return rows[0] === undefined ? "gone" : (rows[0]["claimed_by"] as string | null);
}

describe("ack and release", () => {
  it("name one key and the claim's time, so no statement spans several job rows", () => {
    for (const statement of [jobsQueries.ack, jobsQueries.release]) {
      expect(statement).toContain("record_key = $2::text");
      expect(statement).toContain("claimed_at = to_timestamp($3::double precision / 1000)");
      expect(statement).not.toContain("any(");
    }
  });

  it("an ack with the time of an earlier claim deletes nothing", async () => {
    const w = await queue();
    await w.client.query(jobsQueries.enqueue, [["k"]]);
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T2, CLAIM_LEASE_MS]);
    await w.client.query(jobsQueries.ack, ["w1", "k", T1]);
    expect(await claimedBy(w, "k")).toBe("w1");
    await w.client.query(jobsQueries.ack, ["w2", "k", T2]);
    expect(await claimedBy(w, "k")).toBe("w1");
    await w.client.query(jobsQueries.ack, ["w1", "k", T2]);
    expect(await claimedBy(w, "k")).toBe("gone");
  });

  it("a release with the time of an earlier claim leaves the new claim alone", async () => {
    const w = await queue();
    await w.client.query(jobsQueries.enqueue, [["k"]]);
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T2, CLAIM_LEASE_MS]);
    await w.client.query(jobsQueries.release, ["w1", "k", T1]);
    expect(await claimedBy(w, "k")).toBe("w1");
    await w.client.query(jobsQueries.release, ["w1", "k", T2]);
    expect(await claimedBy(w, "k")).toBeNull();
  });
});

describe("the claim ledger", () => {
  it("runs one statement per key and none for a key it never saw claimed", async () => {
    const w = await queue();
    const statements: unknown[][] = [];
    const ledger = createClaimLedger((text, params) => {
      statements.push([text, ...params]);
      return w.client.query(text, params);
    }, "w1");
    await w.client.query(jobsQueries.enqueue, [["a", "b"]]);
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    ledger.held(["a", "b"], T1);
    await ledger.ack(["a", "b", "never-claimed"]);
    expect(statements).toEqual([
      [jobsQueries.ack, "w1", "a", T1],
      [jobsQueries.ack, "w1", "b", T1],
    ]);
    expect(await claimedBy(w, "a")).toBe("gone");
    expect(await claimedBy(w, "b")).toBe("gone");
  });

  it("settles the oldest claim of a key first, so a stale settle changes nothing", async () => {
    const w = await queue();
    const ledger = createClaimLedger(w.client.query, "w1");
    await w.client.query(jobsQueries.enqueue, [["k"]]);
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    ledger.held(["k"], T1);
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T2, CLAIM_LEASE_MS]);
    ledger.held(["k"], T2);
    await ledger.ack(["k"]);
    expect(await claimedBy(w, "k")).toBe("w1");
    await ledger.ack(["k"]);
    expect(await claimedBy(w, "k")).toBe("gone");
  });
});
