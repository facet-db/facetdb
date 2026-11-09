import { afterEach, describe, expect, it } from "vitest";
import type { Connector, RecordDecision, RecordKey } from "../contracts/index.ts";
import type { StateValue } from "../records/index.ts";
import type { Decision } from "../thresholds/index.ts";

/**
 * What a connector under test is given. The suite never sees a database handle: the factory that
 * builds the fixture knows the database, and every write the application makes goes through `edit`.
 */
export type ContractFixture = {
  /** A worker on a fresh database whose state fields are `fields`. The database may be empty. */
  readonly connector: Connector;
  /**
   * A second worker on the same database. Required when `capabilities.multipleWorkers` is true,
   * because the claim-exclusivity case needs two workers competing for one queue.
   */
  readonly peer?: Connector;
  /** The application's own write: inserts the row or updates its state fields. */
  readonly edit: (key: RecordKey, state: Readonly<Record<string, StateValue>>) => Promise<void>;
  /** The state fields the connector hashes, in config order. */
  readonly fields: readonly string[];
  /** The decision stored for a key, or null. */
  readonly decisionOf: (key: RecordKey) => Promise<RecordDecision | null>;
  /** Releases what the factory opened. */
  readonly close?: () => Promise<void>;
};

export type ContractOptions = {
  /** How long a watch may take to deliver a change before the case fails. Defaults to 5 seconds. */
  readonly watchTimeoutMs?: number;
};

const SEED_COUNT = 25;

/**
 * The connector contract, as one vitest suite. Each case builds a fresh fixture, so no case
 * depends on another. Every connector package runs this with its own factory; no connector copies
 * these cases.
 */
export function runConnectorContract(
  makeFixture: () => Promise<ContractFixture>,
  options: ContractOptions = {},
): void {
  const watchTimeoutMs = options.watchTimeoutMs ?? 5000;
  const opened: ContractFixture[] = [];

  async function open(): Promise<ContractFixture> {
    const fixture = await makeFixture();
    opened.push(fixture);
    return fixture;
  }

  afterEach(async () => {
    for (const fixture of opened.splice(0)) {
      await fixture.close?.();
    }
  });

  describe("connector contract", () => {
    it("install is idempotent: a second install changes nothing, and uninstall twice is harmless", async () => {
      const fx = await open();
      await fx.connector.install();
      await seed(fx, SEED_COUNT);
      const keys = seedKeys(SEED_COUNT);
      const decided = await fx.connector.read([keys[0] ?? ""]);
      const hash = decided.rows[0]?.hash ?? "";
      await fx.connector.write(keys[0] ?? "", aDecision(), hash);

      const before = await fx.connector.read(keys);
      await fx.connector.install();
      expect(await fx.connector.read(keys)).toEqual(before);
      expect(await fx.decisionOf(keys[0] ?? "")).toEqual(aDecision());

      await fx.connector.uninstall();
      await fx.connector.uninstall();
    });

    it("watch delivers a key written after install, without waiting for a restart", async () => {
      const fx = await open();
      await fx.connector.install();
      await seed(fx, 1);
      const [key] = seedKeys(1);
      const iterator = fx.connector.watch()[Symbol.asyncIterator]();
      const pending = iterator.next();

      await fx.edit(key ?? "", stateFor(fx.fields, "changed"));
      const batch = await withTimeout(pending, watchTimeoutMs, "watch delivered nothing");
      await iterator.return?.();

      expect(batch.done).toBe(false);
      expect(batch.value).toContain(key);
    });

    it("read returns state and a hash that moves only when a state field moves", async () => {
      const fx = await open();
      await fx.connector.install();
      await seed(fx, 3);
      const keys = seedKeys(3);
      const first = await fx.connector.read(keys);
      const again = await fx.connector.read(keys);
      expect(again.rows.map((row) => row.hash)).toEqual(first.rows.map((row) => row.hash));

      await fx.edit(keys[1] ?? "", stateFor(fx.fields, "moved"));
      const after = await fx.connector.read(keys);
      expect(after.rows[1]?.hash).not.toEqual(first.rows[1]?.hash);
      expect(after.rows[0]?.hash).toEqual(first.rows[0]?.hash);

      const withMissing = await fx.connector.read(["no-such-key", keys[0] ?? ""]);
      expect(withMissing.missing).toEqual(["no-such-key"]);
      expect(withMissing.rows.map((row) => row.key)).toEqual([keys[0]]);
    });

    it("a decision hash does not move when only the decision is written", async () => {
      const fx = await open();
      await fx.connector.install();
      await seed(fx, 1);
      const [key] = seedKeys(1);
      const before = await fx.connector.read([key ?? ""]);
      await fx.connector.write(key ?? "", aDecision(), before.rows[0]?.hash ?? "");
      const after = await fx.connector.read([key ?? ""]);
      expect(after.rows[0]?.hash).toEqual(before.rows[0]?.hash);
    });

    it("write stores the decision only while the state hash still matches", async () => {
      const fx = await open();
      await fx.connector.install();
      await seed(fx, 1);
      const [key] = seedKeys(1);
      const k = key ?? "";
      const hash = (await fx.connector.read([k])).rows[0]?.hash ?? "";

      expect(await fx.connector.write(k, aDecision(), "stale-hash")).toEqual({ written: false });
      expect(await fx.decisionOf(k)).toBeNull();

      expect(await fx.connector.write(k, aDecision(), hash)).toEqual({ written: true });
      expect(await fx.decisionOf(k)).toEqual(aDecision());

      await fx.edit(k, stateFor(fx.fields, "changed-after-read"));
      const next = { ...aDecision(), status: "pending" as const };
      expect(await fx.connector.write(k, next, hash)).toEqual({ written: false });
      expect(await fx.decisionOf(k)).toEqual(aDecision());
    });

    it("keeps facetdb_reviewed once set: a later write without it never clears it", async () => {
      const fx = await open();
      await fx.connector.install();
      await seed(fx, 1);
      const [key] = seedKeys(1);
      const k = key ?? "";
      const hash = (await fx.connector.read([k])).rows[0]?.hash ?? "";

      await fx.connector.write(k, { ...aDecision(), reviewed: true }, hash);
      await fx.connector.write(k, { ...aDecision(), status: "needs_review" }, hash);

      expect((await fx.decisionOf(k))?.reviewed).toBe(true);
      expect((await fx.decisionOf(k))?.status).toBe("needs_review");
    });

    it("enqueue keeps one entry per record, and claimKey holds only a key nobody queued", async () => {
      const fx = await open();
      await fx.connector.install();
      await fx.connector.enqueue(["q1", "q1", "q2"]);

      expect(await fx.connector.claimKey("q1")).toBe(false);
      expect(await fx.connector.claimKey("q3")).toBe(true);
      // q3 is held by this worker, so a claim hands out only the two queued keys, once each.
      const claimed = await fx.connector.claim(10);
      expect([...claimed].sort()).toEqual(["q1", "q2"]);
      await fx.connector.ack([...claimed, "q3"]);
      expect(await fx.connector.claim(10)).toEqual([]);
    });

    it("scan visits every record exactly once, even when rows arrive between pages", async () => {
      const fx = await open();
      await fx.connector.install();
      await seed(fx, SEED_COUNT);
      const expected = new Set(seedKeys(SEED_COUNT));

      const seen: RecordKey[] = [];
      let cursor: string | null = null;
      let added = false;
      do {
        const page = await fx.connector.scan(cursor);
        seen.push(...page.rows.map((row) => row.key));
        cursor = page.next;
        if (!added && cursor !== null) {
          await fx.edit("arrived-mid-scan", stateFor(fx.fields, "late"));
          added = true;
        }
      } while (cursor !== null);

      const original = seen.filter((key) => expected.has(key));
      expect(new Set(original)).toEqual(expected);
      expect(original).toHaveLength(SEED_COUNT);
      expect(new Set(seen).size).toBe(seen.length);
    });

    it("scan resumes from a cursor: the same cursor gives the same next page", async () => {
      const fx = await open();
      await fx.connector.install();
      await seed(fx, SEED_COUNT);
      const first = await fx.connector.scan(null);
      expect(first.next).not.toBeNull();
      const cursor = first.next;
      const once = await fx.connector.scan(cursor);
      const twice = await fx.connector.scan(cursor);
      expect(twice).toEqual(once);
    });

    it("claim hands each queued key to one worker only", async (ctx) => {
      const fx = await open();
      if (!fx.connector.capabilities.multipleWorkers) {
        ctx.skip();
        return;
      }
      if (!fx.peer) {
        throw new Error("the fixture must supply a peer worker for the claim cases");
      }
      await fx.connector.install();
      await seed(fx, SEED_COUNT);

      const [a, b] = await Promise.all([fx.connector.claim(10), fx.peer.claim(10)]);
      expect(a.length).toBeGreaterThan(0);
      expect(b.length).toBeGreaterThan(0);
      const overlap = a.filter((key) => b.includes(key));
      expect(overlap).toEqual([]);
    });

    it("release returns claimed keys to the queue for any worker", async (ctx) => {
      const fx = await open();
      if (!fx.connector.capabilities.multipleWorkers) {
        ctx.skip();
        return;
      }
      if (!fx.peer) {
        throw new Error("the fixture must supply a peer worker for the claim cases");
      }
      await fx.connector.install();
      await seed(fx, 4);
      const claimed = await fx.connector.claim(4);
      expect(claimed).toHaveLength(4);
      await fx.connector.release(claimed);
      const reclaimed = await fx.peer.claim(4);
      expect([...reclaimed].sort()).toEqual([...claimed].sort());
    });
  });

  /** Seeds `count` rows through the application's own writes, after install so the trigger queues them. */
  async function seed(fx: ContractFixture, count: number): Promise<void> {
    for (const key of seedKeys(count)) {
      await fx.edit(key, stateFor(fx.fields, `v-${key}`));
    }
  }
}

function seedKeys(count: number): RecordKey[] {
  return Array.from({ length: count }, (_, index) => `record-${String(index).padStart(3, "0")}`);
}

function stateFor(fields: readonly string[], value: string): Record<string, StateValue> {
  return Object.fromEntries(fields.map((field) => [field, `${field}:${value}`]));
}

function aDecision(): RecordDecision {
  const decision: Decision = {
    kind: "decided",
    value: true,
    probabilityOrConfidence: 0.93,
  };
  return { decisions: { not_priority: decision }, status: "done" };
}

async function withTimeout<T>(pending: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(message));
    }, ms);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
