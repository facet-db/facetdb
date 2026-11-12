import { afterEach, describe, expect, it } from "vitest";
import { createPgliteWorld, type PgliteWorld } from "../testing/index.ts";
import type { SqlClient, SqlQuery } from "./client.ts";
import {
  CLAIM_LEASE_MS,
  createClaimLedger,
  ENQUEUE_KEYS_PER_STATEMENT,
  ENQUEUE_STATEMENT_TIMEOUT_SQL,
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
    await w.client.query(jobsQueries.enqueue, [["a", "k"]]);
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
    await w.client.query(jobsQueries.enqueue, [["a", "k"]]);
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
  it("settles a batch in one statement, naming no key it never saw claimed", async () => {
    const w = await queue();
    const statements: unknown[][] = [];
    const ledger = createClaimLedger(recording(w.client.query, statements), "w1");
    await w.client.query(jobsQueries.enqueue, [["a", "b"]]);
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
    await w.client.query(jobsQueries.enqueue, [["a", "k"]]);
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

  it("keeps the claims of a batch whose statement threw, so a later settle still names them", async () => {
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
    await w.client.query(jobsQueries.enqueue, [["a", "b"]]);
    await w.client.query(jobsQueries.claim, ["", "w1", 10, T1, CLAIM_LEASE_MS]);
    ledger.held(["a", "b"], T1);
    await expect(ledger.ack(["a", "b"])).rejects.toThrow(/connection lost/);
    expect(await claimedBy(w, "a")).toBe("w1");
    await ledger.ack(["a", "b"]);
    expect(statements).toEqual([
      [jobsQueries.ackBatch, "w1", ["a", "b"], [T1, T1]],
      [jobsQueries.ackBatch, "w1", ["a", "b"], [T1, T1]],
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

/** A query that records each statement with its parameters before running it. */
function recording(query: SqlQuery, statements: unknown[][]): SqlQuery {
  return (text, params = []) => {
    statements.push([text, ...params]);
    return query(text, params);
  };
}

/**
 * A client over PGlite that records what runs outside a transaction and what runs inside each one.
 * `failInside` makes a statement inside a transaction fail as the driver would, so the transaction
 * rolls back on the real engine.
 */
function recordingClient(
  inner: SqlClient,
  failInside?: (text: string) => Error | undefined,
): { client: SqlClient; outside: unknown[][]; transactions: unknown[][][] } {
  const outside: unknown[][] = [];
  const transactions: unknown[][][] = [];
  const client: SqlClient = {
    ...inner,
    query: recording(inner.query, outside),
    transaction: (work) => {
      const statements: unknown[][] = [];
      transactions.push(statements);
      return inner.transaction((query) =>
        work(async (text, params = []) => {
          statements.push([text, ...params]);
          const failure = failInside?.(text);
          if (failure !== undefined) {
            throw failure;
          }
          return query(text, params);
        }),
      );
    },
  };
  return { client, outside, transactions };
}

const sqlError = (code: string, message: string): Error =>
  Object.assign(new Error(message), { code });

async function queuedKeys(w: PgliteWorld): Promise<string[]> {
  const rows = await w.client.query(`select record_key from facetdb.jobs order by 1`);
  return rows.map((row) => String(row["record_key"]));
}

const TIMEOUT = ENQUEUE_STATEMENT_TIMEOUT_SQL;

describe("enqueueJobs", () => {
  const keys = (count: number): string[] =>
    Array.from({ length: count }, (_, i) => `k${String(i).padStart(4, "0")}`);

  it("bounds the batch statement to half the server's deadlock_timeout, for that transaction only", async () => {
    const w = await queue();
    const seen = await w.client.transaction(async (query) => {
      await query(`set local deadlock_timeout = '300ms'`);
      await query(ENQUEUE_STATEMENT_TIMEOUT_SQL);
      return query(`select current_setting('statement_timeout') as t`);
    });
    expect(seen).toEqual([{ t: "150ms" }]);
    expect(await w.client.query(`select current_setting('statement_timeout') as t`)).toEqual([
      { t: "0" },
    ]);
  });

  it(`queues ${ENQUEUE_KEYS_PER_STATEMENT} keys per statement, each chunk in a transaction under a statement timeout`, async () => {
    const w = await queue();
    const { client, outside, transactions } = recordingClient(w.client);
    const wanted = keys(1200);
    await enqueueJobs(client, [...wanted, ...wanted.slice(0, 10)]);
    expect(outside).toEqual([]);
    expect(transactions).toEqual([
      [[TIMEOUT], [jobsQueries.enqueue, wanted.slice(0, 500)]],
      [[TIMEOUT], [jobsQueries.enqueue, wanted.slice(500, 1000)]],
      [[TIMEOUT], [jobsQueries.enqueue, wanted.slice(1000)]],
    ]);
    expect(await queuedKeys(w)).toEqual(wanted);
  });

  it("queues a single key in one statement, with no transaction", async () => {
    const w = await queue();
    const { client, outside, transactions } = recordingClient(w.client);
    await enqueueJobs(client, ["only"]);
    expect(outside).toEqual([[jobsQueries.enqueue, ["only"]]]);
    expect(transactions).toEqual([]);
    expect(await queuedKeys(w)).toEqual(["only"]);
  });

  // The fake failure is thrown before the insert reaches PGlite, so these cases prove the path
  // taken after a cancel, not the rollback itself: a real lock wait, its cancel and the rollback are
  // capture.db.test.ts ("a page enqueue meeting a job row…", "…caught between two application
  // transactions…"), where the keys before the held one show up only once the fallback commits them.
  it("queues the chunk one key per statement when its statement was cancelled by the timeout", async () => {
    const w = await queue();
    const { client, outside, transactions } = recordingClient(w.client, (text) =>
      text === jobsQueries.enqueue
        ? sqlError("57014", "canceling statement due to statement timeout")
        : undefined,
    );
    await enqueueJobs(client, ["a", "b", "c"]);
    expect(transactions).toEqual([[[TIMEOUT], [jobsQueries.enqueue, ["a", "b", "c"]]]]);
    expect(outside).toEqual([
      [jobsQueries.enqueue, ["a"]],
      [jobsQueries.enqueue, ["b"]],
      [jobsQueries.enqueue, ["c"]],
    ]);
    expect(await queuedKeys(w)).toEqual(["a", "b", "c"]);
  });

  it.each([
    ["55P03", "canceling statement due to lock timeout"],
    ["40P01", "deadlock detected"],
  ])(
    "falls back the same way on %s, its own transaction ended by a wait",
    async (code, message) => {
      const w = await queue();
      const { client, outside } = recordingClient(w.client, (text) =>
        text === jobsQueries.enqueue ? sqlError(code, message) : undefined,
      );
      await enqueueJobs(client, ["a", "b"]);
      expect(outside).toHaveLength(2);
      expect(await queuedKeys(w)).toEqual(["a", "b"]);
    },
  );

  it("passes any other failure on, queuing nothing", async () => {
    const w = await queue();
    const { client, outside } = recordingClient(w.client, (text) =>
      text === jobsQueries.enqueue
        ? sqlError("42501", "permission denied for table jobs")
        : undefined,
    );
    await expect(enqueueJobs(client, ["a", "b"])).rejects.toThrow(/permission denied/);
    expect(outside).toEqual([]);
    expect(await queuedKeys(w)).toEqual([]);
  });
});
