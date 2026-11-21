import { type QuestionSet, stateHash } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { PollingRow } from "../dialect/index.ts";
import { plainDialect, type RecordingClient, recordingClient } from "../testing/index.ts";
import { createPollingConnector, type PollingTarget } from "./index.ts";

/**
 * A polling source's queue survives a worker stop: the stored `facetdb_state_hash` is the queue's
 * durable half, so `enqueue` marks it (the old hash written in capitals, still readable) and the
 * next worker's first poll re-finds the record as it re-finds a changed row, telling one merely
 * queued from one edited meanwhile. On the recording client of polling.test.ts, answering from a
 * table of its own, so two connectors share one "database".
 */

const questionSet: QuestionSet = {
  questions: [
    { type: "noul", name: "not_priority", instructions: "Is this not a priority?", stakes: "low" },
  ],
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const target: PollingTarget = {
  project: { id: "proj_tickets", name: "Tickets" },
  table: "tickets",
  key: "id",
  onChange: "keep",
  questionSet,
};

type Row = { title: string; body: string; hash: string | null; status: string | null };

/** The hash of the state every answered row of these tests holds, as the loop's write stores it. */
const sameHash = stateHash(questionSet.read, { title: "same", body: "body" });

const CLEAR = `update "main"."tickets" set "facetdb_state_hash" = upper("facetdb_state_hash") where "id" in `;
const MARK = `update "main"."tickets" set "facetdb_status" = 'pending' where "id" in `;

/** A table the recording client answers from: the poll's select, the hash's clearing, the marking. */
function database() {
  const rows = new Map<string, Row>();
  const client: RecordingClient = recordingClient((text, params) => {
    if (text.startsWith("select ")) {
      return [...rows]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(
          ([key, row]): PollingRow => ({
            k: key,
            s0: row.title,
            s1: row.body,
            h: row.hash,
            x: false,
          }),
        );
    }
    const keys = params.map(String);
    if (text.startsWith(CLEAR)) {
      for (const key of keys) {
        const row = rows.get(key);
        if (row !== undefined && row.hash !== null) {
          row.hash = row.hash.toUpperCase();
        }
      }
      return [];
    }
    if (text.startsWith(MARK)) {
      // `reset` marks any record not pending; `keep` only one FacetDB never decided.
      const reset = text.endsWith(`("facetdb_status" is null or "facetdb_status" <> 'pending')`);
      for (const key of keys) {
        const row = rows.get(key);
        if (row !== undefined && (row.status === null || (reset && row.status !== "pending"))) {
          row.status = "pending";
        }
      }
      return [];
    }
    return undefined;
  });
  /** A row as the loop's write leaves it: answered at its state, its hash stored. */
  const answered = (key: string, title: string): void => {
    rows.set(key, {
      title,
      body: "body",
      hash: stateHash(questionSet.read, { title, body: "body" }),
      status: "done",
    });
  };
  return { client, rows, answered };
}

/** A worker over `client`, polling the whole table (no last-changed column). */
function worker(client: RecordingClient, onChange: PollingTarget["onChange"] = target.onChange) {
  return createPollingConnector(
    plainDialect,
    client,
    { ...target, onChange },
    {
      fullScanChosen: true,
      clock: new FakeClock(),
      warn: () => undefined,
    },
  );
}

/** The statements that cleared a stored hash, with their keys. */
function clears(client: RecordingClient) {
  return client.statements.filter((statement) => statement.text.startsWith(CLEAR));
}

describe("a polling source's queue survives a worker stop", () => {
  it.each(["keep", "reset"] as const)(
    "re-finds a record enqueued on one connector at the first poll of the next, and claims it there, its answers and status untouched (onChange %s)",
    async (onChange) => {
      const db = database();
      db.answered("7", "same");
      db.answered("8", "same");
      const first = worker(db.client, onChange);
      await first.enqueue(["7"]);
      // The worker stops before it asks: its memory goes with it.
      await first.close();

      expect(clears(db.client)).toEqual([
        { text: `${CLEAR}(:1)`, params: ["7"], inTransaction: true },
      ]);
      expect(db.rows.get("7")).toEqual({
        title: "same",
        body: "body",
        hash: sameHash.toUpperCase(),
        status: "done",
      });

      const next = worker(db.client, onChange);
      expect(await next.claim(10)).toEqual([]);
      const watch = next.watch()[Symbol.asyncIterator]();
      // Only the enqueued record: "8" was answered at its state and is not asked again.
      expect(await watch.next()).toEqual({ done: false, value: ["7"] });
      await watch.return?.();
      expect(await next.claim(10)).toEqual(["7"]);
      // Not a state change: even `reset` leaves the decided record's status as it was.
      expect(db.rows.get("7")).toEqual({
        title: "same",
        body: "body",
        hash: sameHash.toUpperCase(),
        status: "done",
      });
    },
  );

  it.each(["keep", "reset"] as const)(
    "tells a queued record the application edited before the next poll from one merely queued (onChange %s)",
    async (onChange) => {
      const db = database();
      db.answered("7", "same");
      const first = worker(db.client, onChange);
      await first.enqueue(["7"]);
      await first.close();
      // The application rewrites the record while no worker runs: the marked old hash stays.
      db.rows.set("7", {
        title: "edited",
        body: "body",
        hash: sameHash.toUpperCase(),
        status: "done",
      });

      const next = worker(db.client, onChange);
      const watch = next.watch()[Symbol.asyncIterator]();
      expect(await watch.next()).toEqual({ done: false, value: ["7"] });
      await watch.return?.();
      // A change, as the old hash still says: `reset` resets it, `keep` keeps the decision shown.
      expect(db.rows.get("7")?.status).toBe(onChange === "reset" ? "pending" : "done");
      expect(await next.claim(10)).toEqual(["7"]);
    },
  );

  it("under `reset` still marks a changed decided record pending, and a never-decided one", async () => {
    const db = database();
    db.answered("7", "before");
    const before = db.rows.get("7")?.hash ?? null;
    db.rows.set("7", { title: "after", body: "body", hash: before, status: "done" });
    db.rows.set("8", { title: "new", body: "body", hash: null, status: null });
    const connector = worker(db.client, "reset");
    const watch = connector.watch()[Symbol.asyncIterator]();
    expect(await watch.next()).toEqual({ done: false, value: ["7", "8"] });
    await watch.return?.();
    expect(db.rows.get("7")?.status).toBe("pending");
    expect(db.rows.get("8")?.status).toBe("pending");
  });

  it("leaves a key the connector holds in `claimed` whole: neither marked nor queued", async () => {
    const db = database();
    db.answered("7", "same");
    db.answered("9", "same");
    const connector = worker(db.client);
    expect(await connector.claimKey("7")).toBe(true);

    await connector.enqueue(["7", "9"]);

    expect(clears(db.client).map((statement) => statement.params)).toEqual([["9"]]);
    expect(db.rows.get("7")?.hash).toBe(
      stateHash(questionSet.read, { title: "same", body: "body" }),
    );
    expect(await connector.claim(10)).toEqual(["9"]);

    // Every key held: no statement at all.
    await connector.enqueue(["7", "9"]);
    expect(clears(db.client)).toHaveLength(1);
  });

  it("queues a key whose row is gone as before, marking nothing", async () => {
    const db = database();
    db.answered("7", "same");
    const connector = worker(db.client);

    await connector.enqueue(["gone"]);

    expect(clears(db.client).map((statement) => statement.params)).toEqual([["gone"]]);
    expect(db.rows.get("7")?.hash).not.toBeNull();
    expect(await connector.claim(10)).toEqual(["gone"]);
  });

  it("rejects an enqueue whose update fails, leaving `waiting` as it was", async () => {
    const db = database();
    db.answered("7", "same");
    db.answered("8", "same");
    const connector = worker(db.client);
    await connector.enqueue(["7"]);

    db.client.failNext(new Error("permission denied for table tickets"));
    await expect(connector.enqueue(["8"])).rejects.toThrow("permission denied for table tickets");

    expect(db.client.transactions).toEqual({ committed: 1, rolledBack: 1 });
    expect(db.rows.get("8")?.hash).not.toBeNull();
    expect(await connector.claim(10)).toEqual(["7"]);
  });

  it("marks the hash in lists the dialect allows, one transaction each", async () => {
    const db = database();
    const connector = worker(db.client);
    const keys = Array.from({ length: plainDialect.maxInList + 1 }, (_, index) => `k${index}`);

    await connector.enqueue(keys);

    expect(clears(db.client).map((statement) => statement.params.length)).toEqual([
      plainDialect.maxInList,
      1,
    ]);
    expect(db.client.transactions).toEqual({ committed: 2, rolledBack: 0 });
    expect(await connector.claim(keys.length)).toHaveLength(keys.length);
  });
});
