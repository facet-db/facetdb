import type { QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { pgliteClient, type SqlClient } from "../sql/index.ts";
import { migrateStore, SCHEMA_VERSION, storeVersion } from "./schema.ts";
import { sourceIdOf } from "./source-id.ts";
import { createStore } from "./store.ts";
import { newStore, SECRET, takeBackMigration11, useStoreWorld } from "./store-world.ts";

/**
 * The model a question-set version is held to (store migration 11): set once by the version's first
 * answer, the first write winning, and read with nothing written ever after. PGlite runs one
 * connection, so two first answers here are two statements in turn: it proves the statement's
 * shape, while a real Postgres re-reads a row another transaction updated before updating it, which
 * is what makes the first write win between two workers.
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

/** A store with the listings source's set recorded as its first version. */
async function recorded() {
  const { store, db } = await newStore();
  await store.ensureProject({ id: "marketplace", name: "marketplace" });
  await store.ensureSource({ projectId: "marketplace", name: "listings", kind: "api" });
  const { version } = await store.questionSets.record(ID, SET);
  return { store, client: pgliteClient(db), version };
}

/** The version's row as Postgres keeps it: `xmin` moves with every write, the same value or not. */
async function rowOf(client: SqlClient, version: number, sourceId = ID): Promise<unknown> {
  const [row] = await client.query(
    `select answered_by, xmin::text as xmin from facetdb.question_set_versions
      where source_id = $1 and version = $2`,
    [sourceId, version],
  );
  return row;
}

describe("a question-set version's model", () => {
  it("is set by the first answer, then answered with one read and nothing written", async () => {
    const { store, client, version } = await recorded();
    expect(await rowOf(client, version)).toMatchObject({ answered_by: null });

    expect(await store.questionSets.answeredBy(ID, version, HELD)).toBe(HELD);
    const held = await rowOf(client, version);
    expect(held).toMatchObject({ answered_by: HELD });

    // A response naming another model is answered the held name; the row is not touched.
    expect(await store.questionSets.answeredBy(ID, version, OTHER)).toBe(HELD);
    expect(await store.questionSets.answeredBy(ID, version, HELD)).toBe(HELD);
    expect(await rowOf(client, version)).toEqual(held);
  });

  it("of two first answers keeps the first write, and answers both its name", async () => {
    const { store, client, version } = await recorded();
    // Both read no name before either writes, so both reach the update: the second keeps the first's.
    const answers = await Promise.all([
      store.questionSets.answeredBy(ID, version, HELD),
      store.questionSets.answeredBy(ID, version, OTHER),
    ]);
    expect(answers).toEqual([HELD, HELD]);
    expect(await rowOf(client, version)).toMatchObject({ answered_by: HELD });
  });

  it("keeps versions apart: a new model starts a version that holds its own first name", async () => {
    const { store, client, version } = await recorded();
    await store.questionSets.answeredBy(ID, version, HELD);
    const before = await rowOf(client, version);

    // facetdb.config.ts names another model: a new version, which nothing has answered yet.
    const next = await store.questionSets.record(ID, { ...SET, model: OTHER });
    expect(next.version).toBe(version + 1);
    expect(await rowOf(client, next.version)).toMatchObject({ answered_by: null });
    expect(await store.questionSets.answeredBy(ID, next.version, OTHER)).toBe(OTHER);
    // The old version's name, and its row, are untouched.
    expect(await rowOf(client, version)).toEqual(before);

    // Another source's version of the same number is its own.
    await store.ensureSource({ projectId: "marketplace", name: "tickets", kind: "api" });
    const tickets = sourceIdOf("marketplace", "tickets");
    const { version: first } = await store.questionSets.record(tickets, SET);
    expect(first).toBe(version);
    expect(await store.questionSets.answeredBy(tickets, first, "jev-1.13.0")).toBe("jev-1.13.0");
    expect(await rowOf(client, version)).toEqual(before);
  });

  it("refuses a version the store does not keep", async () => {
    const { store, version } = await recorded();
    await expect(store.questionSets.answeredBy(ID, version + 8, HELD)).rejects.toThrow(
      `the FacetDB store keeps no question-set version ${version + 8} of "${ID}"`,
    );
  });
});

describe("store migration 11", () => {
  it("adds a nullable model to a version-10 store's versions, keeping every row as it was", async () => {
    const { client, version } = await recorded();
    await takeBackMigration11(client);
    expect(await storeVersion(client.query)).toEqual({ kind: "found", newest: 10, current: false });
    const kept = `select source_id, version, content_hash, question_set::text, created_at
                    from facetdb.question_set_versions order by 1, 2`;
    const before = await client.query(kept);

    expect(await migrateStore(client)).toEqual([]);

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    expect(await storeVersion(client.query)).toEqual({
      kind: "found",
      newest: SCHEMA_VERSION,
      current: true,
    });
    expect(
      await client.query(
        `select data_type, is_nullable, column_default from information_schema.columns
          where table_schema = 'facetdb' and table_name = 'question_set_versions'
            and column_name = 'answered_by'`,
      ),
    ).toEqual([{ data_type: "text", is_nullable: "YES", column_default: null }]);
    expect(await client.query(kept)).toEqual(before);
    // A version made before the migration is held by its next answer.
    expect(await rowOf(client, version)).toMatchObject({ answered_by: null });
  });

  it("keeps a worker that may not migrate off a version-10 store, so no answer meets a missing column", async () => {
    const { client } = await recorded();
    await takeBackMigration11(client);
    // PGlite's one connection is a superuser: the privilege check is answered here by the role.
    await client.query(`create role plain_login login`);
    await client.query(`grant usage on schema facetdb to plain_login`);
    await client.query(`grant select on facetdb.store_migrations to plain_login`);
    await client.query(`set role plain_login`);
    try {
      await expect(
        createStore({
          url: "postgres://plain_login@localhost/store",
          pgHost: undefined,
          connect: () => client,
          secret: SECRET,
          clock: new FakeClock(),
        }),
      ).rejects.toThrow(
        `the FacetDB store is at schema version 10, behind this FacetDB (${SCHEMA_VERSION}), and this login may not create tables`,
      );
    } finally {
      await client.query(`reset role`);
    }
  });
});
