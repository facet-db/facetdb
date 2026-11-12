import { afterEach, describe, expect, it } from "vitest";
import { createPgliteWorld, type PgliteWorld } from "../testing/index.ts";
import type { SqlClient, SqlQuery } from "./client.ts";
import {
  CLAIM_LEASE_MS,
  createClaimLedger,
  enqueueJobs,
  jobsQueries,
  jobsTableSql,
} from "./jobs.ts";

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

  it("over a batch, match each key's own claim and skip a row another transaction holds", () => {
    for (const statement of [jobsQueries.ackBatch, jobsQueries.releaseBatch]) {
      expect(statement).toContain("unnest($2::text[], $3::double precision[]) as c(key, at)");
      expect(statement).toContain("j.claimed_by = $1 and j.claimed_at = to_timestamp(c.at / 1000)");
      expect(statement).toContain("for update of j skip locked");
      expect(statement).toContain("returning record_key");
    }
  });

  it("a batch ack takes the claims that stand and leaves a key granted again since", async () => {
    const w = await queue();
    await put(w, "a", "k");
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    await w.client.query(
      `update facetdb.jobs set claimed_at = to_timestamp($1::double precision / 1000) where record_key = 'k'`,
      [T2],
    );
    const rows = await w.client.query(jobsQueries.ackBatch, ["w1", ["a", "k"], [T1, T1]]);
    expect(rows).toEqual([{ record_key: "a" }]);
    expect(await claimedBy(w, "a")).toBe("gone");
    expect(await claimedBy(w, "k")).toBe("w1");
    expect(await w.client.query(jobsQueries.ackBatch, ["w2", ["k"], [T2]])).toEqual([]);
    expect(await w.client.query(jobsQueries.ackBatch, ["w1", ["k"], [T2]])).toEqual([
      { record_key: "k" },
    ]);
  });

  it("a batch release gives back the claims that stand and leaves a new claim alone", async () => {
    const w = await queue();
    await put(w, "a", "k");
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    await w.client.query(
      `update facetdb.jobs set claimed_at = to_timestamp($1::double precision / 1000) where record_key = 'k'`,
      [T2],
    );
    const rows = await w.client.query(jobsQueries.releaseBatch, ["w1", ["a", "k"], [T1, T1]]);
    expect(rows).toEqual([{ record_key: "a" }]);
    expect(await claimedBy(w, "a")).toBeNull();
    expect(await claimedBy(w, "k")).toBe("w1");
  });

  it("an ack with the time of an earlier claim deletes nothing", async () => {
    const w = await queue();
    await put(w, "k");
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
    await put(w, "k");
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T2, CLAIM_LEASE_MS]);
    await w.client.query(jobsQueries.release, ["w1", "k", T1]);
    expect(await claimedBy(w, "k")).toBe("w1");
    await w.client.query(jobsQueries.release, ["w1", "k", T2]);
    expect(await claimedBy(w, "k")).toBeNull();
  });
});

describe("the claim ledger", () => {
  it("settles a batch in one statement, naming no key it never saw claimed", async () => {
    const w = await queue();
    const statements: unknown[][] = [];
    const ledger = createClaimLedger(recording(w.client.query, statements), "w1");
    await put(w, "a", "b");
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    ledger.held(["a", "b"], T1);
    await ledger.ack(["a", "b", "never-claimed"]);
    expect(statements).toEqual([[jobsQueries.ackBatch, "w1", ["a", "b"], [T1, T1]]]);
    expect(await claimedBy(w, "a")).toBe("gone");
    expect(await claimedBy(w, "b")).toBe("gone");
    // Settled keys left the ledger: acking them again names nothing.
    statements.length = 0;
    await ledger.ack(["a", "b"]);
    expect(statements).toEqual([]);
  });

  it("settles each key the batch did not return in a statement of its own", async () => {
    const w = await queue();
    const statements: unknown[][] = [];
    const ledger = createClaimLedger(recording(w.client.query, statements), "w1");
    await put(w, "a", "k");
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    ledger.held(["a", "k"], T1);
    // `k` is granted again before the first batch settles: the batch and the one-key release both
    // find a claim that no longer stands, and the job stays for the batch that holds it now.
    await w.client.query(jobsQueries.release, ["w1", "k", T1]);
    await w.client.query(jobsQueries.claimOne, ["k", "w1", T2, CLAIM_LEASE_MS]);
    ledger.held(["k"], T2);
    await ledger.release(["a", "k"]);
    expect(statements).toEqual([
      [jobsQueries.releaseBatch, "w1", ["a", "k"], [T1, T1]],
      [jobsQueries.release, "w1", "k", T1],
    ]);
    expect(await claimedBy(w, "a")).toBeNull();
    expect(await claimedBy(w, "k")).toBe("w1");
    statements.length = 0;
    await ledger.ack(["k"]);
    expect(statements).toEqual([[jobsQueries.ackBatch, "w1", ["k"], [T2]]]);
    expect(await claimedBy(w, "k")).toBe("gone");
  });

  it("forgets the claims of a settle that threw, so the next batch's settle names its own claim", async () => {
    const w = await queue();
    let failNext = true;
    const statements: unknown[][] = [];
    const ledger = createClaimLedger((text, params = []) => {
      statements.push([text, ...params]);
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("connection lost"));
      }
      return w.client.query(text, params);
    }, "w1");
    await put(w, "k");
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    ledger.held(["k"], T1);
    await expect(ledger.ack(["k"])).rejects.toThrow(/connection lost/);
    // Nothing retries that settle; the lease gives the job back and a second batch takes it. Its
    // settle must name T2: a T1 kept at the head would pair it with the dead claim, and the job
    // would stay claimed until another lease ran out.
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T2, CLAIM_LEASE_MS]);
    ledger.held(["k"], T2);
    await ledger.ack(["k"]);
    expect(statements).toEqual([
      [jobsQueries.ackBatch, "w1", ["k"], [T1]],
      [jobsQueries.ackBatch, "w1", ["k"], [T2]],
    ]);
    expect(await claimedBy(w, "k")).toBe("gone");
  });

  it("settles the oldest claim of a key first, so a stale settle changes nothing", async () => {
    const w = await queue();
    const ledger = createClaimLedger(w.client.query, "w1");
    await put(w, "k");
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

/** Queues `keys` as setup, one statement each. */
async function put(w: PgliteWorld, ...keys: string[]): Promise<void> {
  for (const key of keys) {
    await w.client.query(jobsQueries.enqueue, [key]);
  }
}

/** A query that records each statement with its parameters before running it. */
function recording(query: SqlQuery, statements: unknown[][]): SqlQuery {
  return (text, params = []) => {
    statements.push([text, ...params]);
    return query(text, params);
  };
}

async function queuedKeys(w: PgliteWorld): Promise<string[]> {
  const rows = await w.client.query(`select record_key from facetdb.jobs order by 1`);
  return rows.map((row) => String(row["record_key"]));
}

/** A client over PGlite that records each pipeline it is handed: the text and its parameter sets. */
function recordingPipelines(
  w: PgliteWorld,
  fail?: Error,
): { client: Pick<SqlClient, "pipeline">; pipelines: [string, unknown[][]][] } {
  const pipelines: [string, unknown[][]][] = [];
  return {
    pipelines,
    client: {
      pipeline: (text, paramSets) => {
        pipelines.push([text, paramSets.map((params) => [...params])]);
        return fail === undefined ? w.client.pipeline(text, paramSets) : Promise.reject(fail);
      },
    },
  };
}

describe("enqueueJobs", () => {
  const keys = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `k${String(i).padStart(4, "0")}`);

  it("sends a page as one pipeline of one-key statements, each key once", async () => {
    const w = await queue();
    const { client, pipelines } = recordingPipelines(w);
    // The client bursts it (100 at a time on postgres.js); a duplicate is sent once.
    const wanted = keys(250);
    await enqueueJobs(client, [...wanted, ...wanted.slice(0, 10)]);
    expect(pipelines).toEqual([[jobsQueries.enqueue, wanted.map((key) => [key])]]);
    expect(await queuedKeys(w)).toEqual(wanted);
  });

  it("sends nothing for no keys", async () => {
    const w = await queue();
    const { client, pipelines } = recordingPipelines(w);
    await enqueueJobs(client, []);
    expect(pipelines).toEqual([]);
  });

  it("queues a key already queued as one entry", async () => {
    const w = await queue();
    await put(w, "a");
    await enqueueJobs(w.client, ["a", "b"]);
    expect(await queuedKeys(w)).toEqual(["a", "b"]);
  });

  it("passes a failed pipeline on", async () => {
    const w = await queue();
    const { client } = recordingPipelines(w, new Error("permission denied"));
    await expect(enqueueJobs(client, keys(3))).rejects.toThrow(/permission denied/);
  });
});

describe("a pipeline on PGlite", () => {
  it("runs each parameter set as its own statement, in order, and stops at the first failure", async () => {
    const w = await queue();
    await put(w, "b");
    // No `on conflict`: the set for b fails on the primary key; a committed on its own before it,
    // and c, after the failure, is never run (each run is its own burst on one connection).
    await expect(
      w.client.pipeline(`insert into facetdb.jobs (record_key) values ($1::text)`, [
        ["a"],
        ["b"],
        ["c"],
      ]),
    ).rejects.toThrow(/duplicate key/);
    expect(await queuedKeys(w)).toEqual(["a", "b"]);
  });
});
