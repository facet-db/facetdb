import { describe, expect, it } from "vitest";
import { pgliteClient, type SqlClient } from "../sql/index.ts";
import { migrateStore, SCHEMA_VERSION, storeInstallStatements, storeVersion } from "./schema.ts";
import { newDb, useStoreWorld } from "./store-world.ts";

/**
 * Store migration 8: `facetdb.question_sets_in_force`, one row per source holding the whole set the
 * source's worker runs, written at every loop open, so `facetdb review` judges cards by what the
 * worker runs and not by a version's row (which keeps only what its content hash sees). PGlite
 * proves the shape, that a version-7 store's rows stay, and the idempotence of the migration's text
 * run again by the install beside a live application.
 */

useStoreWorld();

/** A store as migration 7 left it: no row of what a worker runs. */
async function version7Store(): Promise<SqlClient> {
  const client = pgliteClient(await newDb());
  await migrateStore(client);
  await client.query(`drop table facetdb.question_sets_in_force`);
  await client.query(`delete from facetdb.store_migrations where version = 8`);
  return client;
}

async function inForceShape(client: SqlClient): Promise<unknown> {
  return {
    columns: await client.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'facetdb' and table_name = 'question_sets_in_force' order by ordinal_position`,
    ),
    constraints: await client.query(
      `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint where conrelid = 'facetdb.question_sets_in_force'::regclass order by 1`,
    ),
    versions: await client.query(`select version from facetdb.store_migrations order by 1`),
  };
}

describe("store migration 8", () => {
  it("adds the set in force to a version-7 store, keeps its versions, and matches a fresh store", async () => {
    const client = await version7Store();
    expect(await storeVersion(client.query)).toEqual({ kind: "found", newest: 7, current: false });
    expect(
      await client.query(`select to_regclass('facetdb.question_sets_in_force') as present`),
    ).toEqual([{ present: null }]);
    // The versions a version-7 store holds stay as they were: the migration only adds.
    await client.query(
      `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ('p:s', 1, 'h', '{}')`,
    );

    expect(await migrateStore(client)).toEqual([]);

    expect(SCHEMA_VERSION).toBe(8);
    expect(await storeVersion(client.query)).toEqual({ kind: "found", newest: 8, current: true });
    const fresh = pgliteClient(await newDb());
    await migrateStore(fresh);
    const shape = await inForceShape(client);
    expect(shape).toEqual(await inForceShape(fresh));
    expect(shape).toMatchObject({
      columns: [
        { column_name: "source_id", data_type: "text", is_nullable: "NO" },
        { column_name: "version", data_type: "integer", is_nullable: "NO" },
        { column_name: "question_set", data_type: "jsonb", is_nullable: "NO" },
        {
          column_name: "recorded_at",
          data_type: "timestamp with time zone",
          is_nullable: "NO",
        },
      ],
      constraints: expect.arrayContaining([
        { conname: "question_sets_in_force_pkey", def: "PRIMARY KEY (source_id)" },
      ]),
    });
    // No worker has recorded what it runs yet: the table is empty, the versions untouched.
    expect(
      await client.query(`select count(*)::int as n from facetdb.question_sets_in_force`),
    ).toEqual([{ n: 0 }]);
    expect(
      await client.query(`select source_id, version from facetdb.question_set_versions`),
    ).toEqual([{ source_id: "p:s", version: 1 }]);
    await client.query(
      `insert into facetdb.question_sets_in_force (source_id, version, question_set, recorded_at)
       values ('p:s', 1, '{}', now())`,
    );

    // The install runs every migration's text again beside a live application: a repeat changes
    // nothing and keeps the worker's row.
    for (let pass = 0; pass < 2; pass += 1) {
      await client.transaction(async (query) => {
        for (const statement of storeInstallStatements()) {
          await query(statement);
        }
      });
    }
    expect(await inForceShape(client)).toEqual(shape);
    expect(
      await client.query(`select source_id, version from facetdb.question_sets_in_force`),
    ).toEqual([{ source_id: "p:s", version: 1 }]);
  });
});
