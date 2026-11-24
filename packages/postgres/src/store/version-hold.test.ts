import type { QuestionSet } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { pgliteClient, type SqlClient } from "../sql/index.ts";
import { migrateStore, SCHEMA_VERSION, storeInstallStatements, storeVersion } from "./schema.ts";
import { sourceIdOf } from "./source-id.ts";
import { newStore, takeBackMigration12, useStoreWorld } from "./store-world.ts";

/**
 * A question-set version's hold (store migration 12): set by a changed answer with the probe time
 * kept while held, read by a worker as its loop opens, cleared by an answer naming the held model,
 * and its probe claimed by one statement that moves the probe time on. PGlite runs one connection,
 * so it proves each statement's shape and effect; two connections claiming at one instant are
 * version-hold.db.test.ts.
 */

useStoreWorld();

const HELD = "jev-1.14.0";
const OTHER = "strands-decider-7b";
const SET: QuestionSet = {
  questions: [{ type: "noul", name: "scam", instructions: "Is this a scam?", stakes: "low" }],
  read: ["title"],
  model: HELD,
  thresholds: {},
};
const ID = sourceIdOf("marketplace", "listings");
const T = 1_700_000_000_000;
const EVERY = 5 * 60_000;

/** A store with the listings source's set recorded as its first version, answered by `HELD`. */
async function answered() {
  const { store, db } = await newStore();
  await store.ensureProject({ id: "marketplace", name: "marketplace" });
  await store.ensureSource({ projectId: "marketplace", name: "listings", kind: "api" });
  const { version } = await store.questionSets.record(ID, SET);
  await store.questionSets.answeredBy(ID, version, HELD);
  return { store, client: pgliteClient(db), version };
}

async function rowOf(client: SqlClient, version: number): Promise<unknown> {
  const [row] = await client.query(
    `select answered_by, held_by, probe_at::text as probe_at from facetdb.question_set_versions
      where source_id = $1 and version = $2`,
    [ID, version],
  );
  return row;
}

describe("a question-set version's hold", () => {
  it("is set with the name the response gave and the probe time, read back, and cleared", async () => {
    const { store, client, version } = await answered();
    const versions = store.questionSets;
    expect(await versions.readHold(ID, version)).toBeNull();

    expect(await versions.setHold(ID, version, OTHER, T + EVERY)).toBe(T + EVERY);
    expect(await rowOf(client, version)).toEqual({
      answered_by: HELD,
      held_by: OTHER,
      probe_at: String(T + EVERY),
    });
    expect(await versions.readHold(ID, version)).toEqual({
      held: HELD,
      named: OTHER,
      probeAt: T + EVERY,
    });

    await versions.clearHold(ID, version);
    expect(await rowOf(client, version)).toEqual({
      answered_by: HELD,
      held_by: null,
      probe_at: null,
    });
    expect(await versions.readHold(ID, version)).toBeNull();
    // Clearing a version not held changes nothing, and is no error.
    await versions.clearHold(ID, version);
    expect(await versions.readHold(ID, version)).toBeNull();
  });

  it("keeps the probe time of a version already held: a second hold is answered the first's", async () => {
    const { store, client, version } = await answered();
    const versions = store.questionSets;
    expect(await versions.setHold(ID, version, OTHER, T + EVERY)).toBe(T + EVERY);
    // Another worker holds it a minute later, under the name its own response gave.
    expect(await versions.setHold(ID, version, "jev-1.15.0", T + 60_000 + EVERY)).toBe(T + EVERY);
    expect(await rowOf(client, version)).toEqual({
      answered_by: HELD,
      held_by: "jev-1.15.0",
      probe_at: String(T + EVERY),
    });
    // Once released, the next hold starts its own probe time.
    await versions.clearHold(ID, version);
    expect(await versions.setHold(ID, version, OTHER, T + 2 * EVERY)).toBe(T + 2 * EVERY);
  });

  it("lets the probe be claimed once its time has come, moving it 5 minutes on", async () => {
    const { store, client, version } = await answered();
    const versions = store.questionSets;
    await versions.setHold(ID, version, OTHER, T + EVERY);

    // Before its time: not claimed, and the time is said.
    expect(await versions.claimProbe(ID, version, T + EVERY - 1, T + 2 * EVERY - 1)).toEqual({
      kind: "taken",
      probeAt: T + EVERY,
    });
    expect(await rowOf(client, version)).toMatchObject({ probe_at: String(T + EVERY) });

    // At its time: claimed, and the next probe is the time the claim passed.
    expect(await versions.claimProbe(ID, version, T + EVERY, T + 2 * EVERY)).toEqual({
      kind: "claimed",
    });
    expect(await rowOf(client, version)).toMatchObject({
      held_by: OTHER,
      probe_at: String(T + 2 * EVERY),
    });
    // A second claim at the same instant finds the moved time.
    expect(await versions.claimProbe(ID, version, T + EVERY, T + 2 * EVERY)).toEqual({
      kind: "taken",
      probeAt: T + 2 * EVERY,
    });

    // Released meanwhile: the claim says so, and writes nothing.
    await versions.clearHold(ID, version);
    expect(await versions.claimProbe(ID, version, T + 3 * EVERY, T + 4 * EVERY)).toEqual({
      kind: "released",
    });
    expect(await rowOf(client, version)).toMatchObject({ held_by: null, probe_at: null });
  });

  it("keeps versions apart, and refuses a version the store does not keep", async () => {
    const { store, client, version } = await answered();
    const versions = store.questionSets;
    // facetdb.config.ts names another model: a new version, which no hold reaches.
    await versions.setHold(ID, version, OTHER, T + EVERY);
    const next = await versions.record(ID, { ...SET, model: OTHER });
    expect(await versions.readHold(ID, next.version)).toBeNull();
    await versions.answeredBy(ID, next.version, OTHER);
    await versions.clearHold(ID, next.version);
    expect(await rowOf(client, version)).toMatchObject({ held_by: OTHER });

    const missing = `the FacetDB store keeps no question-set version ${version + 8} of "${ID}"`;
    await expect(versions.readHold(ID, version + 8)).rejects.toThrow(missing);
    await expect(versions.setHold(ID, version + 8, OTHER, T)).rejects.toThrow(missing);
    await expect(versions.claimProbe(ID, version + 8, T, T + EVERY)).rejects.toThrow(missing);
  });
});

const recorded = (version: number) =>
  `insert into facetdb.store_migrations (version) values (${version}) on conflict (version) do nothing`;

/** Migration 12's statements as the install prints them: between version 11's row and its own. */
function migration12(): string[] {
  const statements = storeInstallStatements();
  return statements.slice(statements.indexOf(recorded(11)) + 1, statements.indexOf(recorded(12)));
}

describe("store migration 12", () => {
  it("adds the hold's two nullable columns to a version-11 store, rewriting no row", async () => {
    const { client, version } = await answered();
    await takeBackMigration12(client);
    expect(await storeVersion(client.query)).toEqual({ kind: "found", newest: 11, current: false });
    // `xmin` moves with every write of a row: equal before and after, no row was rewritten.
    const kept = `select source_id, version, content_hash, question_set::text, created_at, answered_by,
                         xmin::text as xmin
                    from facetdb.question_set_versions order by 1, 2`;
    const before = await client.query(kept);

    expect(await migrateStore(client)).toEqual([]);

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    expect(await storeVersion(client.query)).toEqual({
      kind: "found",
      newest: SCHEMA_VERSION,
      current: true,
    });
    expect(
      await client.query(
        `select column_name, data_type, is_nullable, column_default from information_schema.columns
          where table_schema = 'facetdb' and table_name = 'question_set_versions'
            and column_name in ('held_by', 'probe_at')
          order by column_name`,
      ),
    ).toEqual([
      { column_name: "held_by", data_type: "text", is_nullable: "YES", column_default: null },
      { column_name: "probe_at", data_type: "bigint", is_nullable: "YES", column_default: null },
    ]);
    expect(await client.query(kept)).toEqual(before);
    // A version made before the migration is not held.
    expect(await rowOf(client, version)).toMatchObject({ held_by: null, probe_at: null });
  });

  it("changes nothing and takes no lock on the versions when it runs again over its own columns", async () => {
    const { store, client, version } = await answered();
    // A hold survives the migration run again, as `facetdb migrate` runs every migration's text.
    await store.questionSets.setHold(ID, version, OTHER, T + EVERY);
    const before = await rowOf(client, version);

    const held = await client.transaction(async (query) => {
      for (const statement of migration12()) {
        await query(statement);
      }
      const rows = await query(
        `select mode from pg_catalog.pg_locks
          where pid = pg_backend_pid() and relation = to_regclass('facetdb.question_set_versions')`,
      );
      return rows.map((row) => String(row["mode"]));
    });
    expect(held).toEqual([]);
    expect(migration12()).toHaveLength(2);

    await client.query(`delete from facetdb.store_migrations where version = 12`);
    expect(await migrateStore(client)).toEqual([]);
    expect(await rowOf(client, version)).toEqual(before);
  });
});
