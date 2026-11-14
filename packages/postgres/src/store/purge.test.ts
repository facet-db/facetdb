import { describe, expect, it } from "vitest";
import { pgliteClient } from "../sql/index.ts";
import { readStoreLog, storePurgeRefusal, storePurgeStatements } from "./purge.ts";
import { SCHEMA_VERSION, storeVersion } from "./schema.ts";
import { sourceIdOf } from "./source-id.ts";
import { newDb, newStore, useStoreWorld } from "./store-world.ts";

/**
 * The store's side of a purge with the store in another database, and the read-only version check
 * `facetdb doctor` makes of it: the CLI's store door prints these statements and runs them as
 * printed, after the engine's run on the source.
 */

useStoreWorld();

const PROJECT = "listings-market";
const ID = sourceIdOf(PROJECT, "listings");
const source = { id: ID, name: "listings", projectId: PROJECT };

async function seed(query: ReturnType<typeof pgliteClient>["query"]): Promise<void> {
  await query("insert into facetdb.projects (id, name) values ($1, $1)", [PROJECT]);
  await query(
    `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, 'listings', 'plugin')`,
    [ID, PROJECT],
  );
  for (const key of ["1", "2"]) {
    await query(
      `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
       values ($1, $2, 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now())`,
      [ID, key],
    );
  }
  await query(
    `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ($1, 1, 'h', '{}')`,
    [ID],
  );
}

async function runAll(
  client: ReturnType<typeof pgliteClient>,
  statements: readonly string[],
): Promise<void> {
  await client.transaction(async (query) => {
    for (const statement of statements) {
      await query(statement);
    }
  });
}

describe("the store's purge of one source's log", () => {
  it("counts the log, then deletes its rows, versions and registration, and nothing else", async () => {
    const { db } = await newStore();
    const client = pgliteClient(db);
    await seed(client.query);
    const other = sourceIdOf("another-project", "listings");
    await client.query(
      `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ($1, 1, 'h', '{}')`,
      [other],
    );
    expect(await readStoreLog(client.query, ID)).toEqual({ decisions: 2, versions: 1, records: 0 });

    await runAll(client, storePurgeStatements(source));

    expect(await readStoreLog(client.query, ID)).toEqual({ decisions: 0, versions: 0, records: 0 });
    expect(await client.query("select id from facetdb.sources")).toEqual([]);
    expect(await client.query("select source_id from facetdb.question_set_versions")).toEqual([
      { source_id: other },
    ]);
  });

  it("refuses inside its transaction while a live store source writes the same log", async () => {
    const { db } = await newStore();
    const client = pgliteClient(db);
    await seed(client.query);
    await client.query(
      `insert into facetdb.records (source_id, record_key, state, hash, status)
       values ($1, 'r1', '{}', 'h', 'pending')`,
      [ID],
    );
    const refused = await runAll(client, storePurgeStatements(source)).catch(
      (error: unknown) => error,
    );
    expect(storePurgeRefusal(refused)).toBe(
      `the decision log of source "listings" is shared with the store source "listings" of project ${PROJECT}, which holds records and is live; nothing was changed.`,
    );
    expect(await readStoreLog(client.query, ID)).toEqual({ decisions: 2, versions: 1, records: 1 });
    expect(storePurgeRefusal(new Error("connection lost"))).toBeUndefined();
  });

  it("writes every value through a setting, so a quote in a name is data, not SQL", () => {
    const statements = storePurgeStatements({ ...source, projectId: "it's-mine" });
    expect(statements[0]).toContain("'it''s-mine'");
    expect(statements.slice(1).join("\n")).not.toContain("it's-mine");
  });

  it("reads a store with no log tables as an empty log, and purges it as one", async () => {
    const client = pgliteClient(await newDb());
    expect(await readStoreLog(client.query, ID)).toEqual({ decisions: 0, versions: 0, records: 0 });
    // Every delete is guarded by its table's presence: no facetdb.decisions is no error.
    await runAll(client, storePurgeStatements(source));
    await client.query("create schema facetdb");
    await runAll(client, storePurgeStatements(source));
    expect(await readStoreLog(client.query, ID)).toEqual({ decisions: 0, versions: 0, records: 0 });
  });
});

describe("the store's version, read only", () => {
  it("is absent before the first migration, and current after the store opens", async () => {
    const client = pgliteClient(await newDb());
    expect(await storeVersion(client.query)).toEqual({ kind: "absent" });
    await newStore();
    expect(await storeVersion(client.query)).toEqual({
      kind: "found",
      newest: SCHEMA_VERSION,
      current: true,
    });
    await client.query("delete from facetdb.store_migrations where version = $1", [SCHEMA_VERSION]);
    expect(await storeVersion(client.query)).toEqual({
      kind: "found",
      newest: SCHEMA_VERSION - 1,
      current: false,
    });
  });
});
