import { stateHash } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { CLAIM_LEASE_MS, jobsQueries } from "../sql/index.ts";
import {
  decided,
  editMany,
  FrozenClock,
  newWorld,
  questionSet,
  recordingConnector,
  useCaptureWorld,
  withTimeout,
} from "./capture-world.ts";
import { createPostgresConnector } from "./connector.ts";
import { stateHashSql } from "./hash-sql.ts";

/**
 * The trigger-and-jobs connector on PGlite: the wake-up, the claim, the hash guard, reset against
 * keep, and the installer it never bypasses. The contract suite is capture-contract.test.ts (split
 * by subject so no file passes 10 s).
 */

useCaptureWorld();

describe("postgres connector", () => {
  it("wakes on the trigger's notification alone, with no poll at all", async () => {
    const world = await newWorld();
    const connector = world.connector({ clock: new FrozenClock() });
    await connector.install();
    const iterator = connector.watch()[Symbol.asyncIterator]();
    const first = iterator.next();
    await world.edit("r1", { title: "a", body: "b" });
    const batch = await withTimeout(first, 3000);
    expect(batch).not.toBe("quiet");
    if (batch !== "quiet") {
      expect(batch.done).toBe(false);
      expect(batch.value).toEqual(["r1"]);
    }
    await iterator.return?.();
  });

  it("refuses a write after the state changed, in the database's own hash check", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", { title: "a", body: "b" });
    const { rows } = await connector.read(["r1"]);
    const hash = rows[0]?.hash ?? "";
    await world.edit("r1", { title: "changed", body: "b" });
    expect(await connector.write("r1", decided(), hash)).toEqual({ written: false });
    expect(await world.decisionOf("r1")).toBeNull();
    const fresh = (await connector.read(["r1"])).rows[0]?.hash ?? "";
    expect(await connector.write("r1", decided(), fresh)).toEqual({ written: true });
    expect(await world.decisionOf("r1")).toEqual(decided());
  });

  it("reset puts an edited record back to pending and queues it; keep leaves the decision", async () => {
    for (const onChange of ["reset", "keep"] as const) {
      const world = await newWorld("inline", onChange);
      const connector = world.connector();
      await connector.install();
      await world.edit("r1", { title: "a", body: "b" });
      await connector.ack(await connector.claim(10));
      const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
      await connector.write("r1", decided(), hash);
      expect(await world.statusOf("r1")).toBe("done");
      await world.edit("r1", { title: "edited", body: "b" });
      expect(await world.queued()).toEqual(["t:15:public.listings:r1"]);
      expect(await world.statusOf("r1")).toBe(onChange === "reset" ? "pending" : "done");
      expect((await world.decisionOf("r1"))?.decisions).toEqual(decided().decisions);
      // The next mode starts from an empty cluster, as on a fresh engine.
      await world.close();
    }
  });

  it("an edit between a write and its ack takes the claim away, so the record is asked again", async () => {
    for (const storage of ["inline", "side-table"] as const) {
      const world = await newWorld(storage);
      const connector = world.connector();
      await connector.install();
      await world.edit("r1", { title: "a", body: "b" });
      expect(await connector.claim(10)).toEqual(["r1"]);
      const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
      expect(await connector.write("r1", decided(), hash)).toEqual({ written: true });
      // The application edits the record while the worker still holds its job.
      await world.edit("r1", { title: "edited meanwhile", body: "b" });
      await connector.ack(["r1"]);
      // The job survived the ack and is claimable again: nothing is lost.
      expect(await world.queued()).toEqual(["t:15:public.listings:r1"]);
      expect(await connector.claim(10)).toEqual(["r1"]);
      expect(await world.statusOf("r1")).toBe("pending");
      // The next storage mode starts from an empty cluster, as on a fresh engine.
      await world.close();
    }
  });

  it("an ack after the job was granted again deletes nothing: the job stays for the second batch", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", { title: "a", body: "b" });
    expect(await connector.claim(10)).toEqual(["r1"]);
    // The first batch outlives its lease; the same worker is granted the job again for a second batch.
    world.clock.advance(CLAIM_LEASE_MS + 1);
    expect(await connector.claim(10)).toEqual(["r1"]);
    await connector.ack(["r1"]);
    expect(await world.queued()).toEqual(["t:15:public.listings:r1"]);
    expect(await world.claimOf("t:15:public.listings:r1")).toBe("w1");
    // The second batch's ack finds its own claim and takes the job.
    await connector.ack(["r1"]);
    expect(await world.queued()).toEqual([]);
  });

  it("a release after the job was granted again leaves the new claim alone", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", { title: "a", body: "b" });
    expect(await connector.claim(10)).toEqual(["r1"]);
    world.clock.advance(CLAIM_LEASE_MS + 1);
    expect(await connector.claim(10)).toEqual(["r1"]);
    await connector.release(["r1"]);
    expect(await world.claimOf("t:15:public.listings:r1")).toBe("w1");
    expect(await connector.claim(10)).toEqual([]);
    await connector.release(["r1"]);
    expect(await world.claimOf("t:15:public.listings:r1")).toBeNull();
    expect(await connector.claim(10)).toEqual(["r1"]);
  });

  it("a batch ack and a batch release of 20 keys are one statement each when no row is held", async () => {
    const world = await newWorld();
    const { connector, statements } = recordingConnector(world);
    await connector.install();
    const keys = await editMany(world, 20);
    expect([...(await connector.claim(20))].sort()).toEqual(keys);
    statements.length = 0;
    await connector.release(keys);
    expect(statements).toEqual([jobsQueries.releaseBatch]);
    expect(await world.claimOf(`t:15:public.listings:${keys[0]}`)).toBeNull();
    // The released keys left the ledger: releasing them again names nothing.
    statements.length = 0;
    await connector.release(keys);
    expect(statements).toEqual([]);

    expect([...(await connector.claim(20))].sort()).toEqual(keys);
    statements.length = 0;
    await connector.ack(keys);
    expect(statements).toEqual([jobsQueries.ackBatch]);
    expect(await world.queued()).toEqual([]);
    statements.length = 0;
    await connector.ack(keys);
    expect(statements).toEqual([]);
  });

  it("a batch ack after one key was granted again deletes nothing for that key", async () => {
    const world = await newWorld();
    const { connector, statements } = recordingConnector(world);
    await connector.install();
    const keys = await editMany(world, 20);
    expect([...(await connector.claim(20))].sort()).toEqual(keys);
    // The first batch outlives its lease and one of its keys is granted again to a second batch.
    world.clock.advance(CLAIM_LEASE_MS + 1);
    const [regranted] = await connector.claim(1);
    expect(regranted).toBeDefined();
    statements.length = 0;
    await connector.ack(keys);
    // The batch skips the re-granted key; the ledger tries it alone, which finds no standing claim.
    expect(statements).toEqual([jobsQueries.ackBatch, jobsQueries.ack]);
    expect(await world.queued()).toEqual([`t:15:public.listings:${regranted}`]);
    expect(await world.claimOf(`t:15:public.listings:${regranted}`)).toBe("w1");
    // The second batch's ack finds its own claim and takes the job.
    await connector.ack([regranted ?? ""]);
    expect(await world.queued()).toEqual([]);
  });

  it("an enqueue of 60 keys is one pipeline of 60 one-key statements", async () => {
    const world = await newWorld();
    const { connector, statements } = recordingConnector(world);
    await connector.install();
    const keys = Array.from({ length: 60 }, (_, i) => `page-${String(i).padStart(2, "0")}`);
    statements.length = 0;
    await connector.enqueue(keys);
    // No transaction and no other statement: on postgres.js the pipeline is a few round trips for
    // the lot (capture.db.test.ts counts them through a relay).
    expect(statements).toEqual([`pipeline of 60 one-key runs: ${jobsQueries.enqueue}`]);
    expect(await world.queued()).toEqual(keys.map((key) => `t:15:public.listings:${key}`));
  });

  it("writes only FacetDB's own columns, named one by one", async () => {
    const world = await newWorld();
    const connector = world.connector();
    await connector.install();
    await world.edit("r1", { title: "a", body: "b" });
    const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
    await connector.write("r1", { ...decided(), reviewed: true }, hash);
    const rows = await world.pg.client.query(
      `select title, body, not_priority, not_priority_probability, facetdb_status, facetdb_reviewed from public.listings where id = 'r1'`,
    );
    expect(rows).toEqual([
      {
        title: "a",
        body: "b",
        not_priority: true,
        not_priority_probability: 0.93,
        facetdb_status: "done",
        facetdb_reviewed: true,
      },
    ]);
  });

  it("the SQL hash equals core's stateHash, quote, backslash, control and unicode text included", async () => {
    const world = await newWorld();
    await world.pg.client.query(`create table t (a text, b text)`);
    const cases: (readonly [string | null, string | null])[] = [
      ["plain", "text"],
      [null, ""],
      ['say "hi"', "back\\slash"],
      ["new\nline\ttab", "\u0001control\u001f"],
      ["é 😀 日本", "/slash/"],
    ];
    for (const [a, b] of cases) {
      await world.pg.client.query(`delete from t`);
      await world.pg.client.query(`insert into t (a, b) values ($1, $2)`, [a, b]);
      const rows = await world.pg.client.query(
        `select ${stateHashSql(["a", "b"], "t")} as h from t`,
      );
      expect(rows[0]?.["h"]).toBe(stateHash(["a", "b"], { a, b }));
    }
  });

  it("install and uninstall go through the installer, never a credential of the connector's", async () => {
    const world = await newWorld();
    const bare = createPostgresConnector({
      workerUrl: "pglite://worker",
      source: world.source,
      questionSet,
      clock: world.clock,
      connect: () => world.pg.client,
    });
    await expect(bare.install()).rejects.toThrow(/facetdb migrate/);
    await expect(bare.uninstall()).rejects.toThrow(/facetdb uninstall/);
    expect(bare.capabilities).toEqual({
      inlineColumns: true,
      pushWakeup: true,
      transactions: true,
      sideTable: true,
      multipleWorkers: true,
    });
    await bare.close();
  });

  it("current answers a key an integer column cannot hold with nothing, in both storage modes", async () => {
    for (const storage of ["inline", "side-table"] as const) {
      const world = await newWorld(storage, "reset", { keyType: "integer" });
      const connector = world.connector();
      await connector.install();
      await world.edit("7", { title: "a", body: "b" });
      const hash = (await connector.read(["7"])).rows[0]?.hash ?? "";
      expect(await connector.write("7", decided(), hash)).toEqual({ written: true });

      // `explain abc` on an integer-keyed table: no record, and no "invalid input syntax" error.
      const current = await connector.current(["7", "8", "no-such-key"]);

      expect([...current.keys()]).toEqual(["7"]);
      expect(current.get("7")?.decisions).toEqual(decided().decisions);
      // The next storage mode starts from an empty cluster, as on a fresh engine.
      await world.close();
    }
  });
});
