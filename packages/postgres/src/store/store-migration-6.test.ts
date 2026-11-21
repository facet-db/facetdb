import type { QuestionSet } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { installSql } from "../install/index.ts";
import { pgliteClient, type SqlClient } from "../sql/index.ts";
import { migrateStore, SCHEMA_VERSION, storeInstallStatements, storeVersion } from "./schema.ts";
import { newDb, useStoreWorld } from "./store-world.ts";

/**
 * Store migration 6: the review queue, the reviewer accounts and the run log as store tables, and
 * the decision log's time index. PGlite proves the shape and the idempotence;
 * store-migration-6.db.test.ts proves the worker login's rights.
 */

useStoreWorld();

const NEW_TABLES = ["reviews", "users", "runs"] as const;
const TIME_INDEX =
  "CREATE INDEX decisions_by_time ON facetdb.decisions USING btree (source_id, at DESC, id)";

/** A store as version 5 left it: migrated to today, then migration 6's objects and row removed. */
async function version5Store(): Promise<SqlClient> {
  const client = pgliteClient(await newDb());
  await migrateStore(client);
  await client.query(`drop table facetdb.reviews, facetdb.users, facetdb.runs`);
  await client.query(`drop index facetdb.decisions_by_time`);
  await client.query(`delete from facetdb.store_migrations where version = 6`);
  return client;
}

/** Everything a rerun could change in the `facetdb` schema: columns, constraints, indexes, rows. */
async function catalog(client: SqlClient): Promise<unknown> {
  return {
    columns: await client.query(
      `select table_name, column_name, data_type, is_nullable, column_default
         from information_schema.columns where table_schema = 'facetdb' order by 1, ordinal_position`,
    ),
    constraints: await client.query(
      `select conrelid::regclass::text as on_table, conname, pg_get_constraintdef(oid) as def
         from pg_constraint where connamespace = 'facetdb'::regnamespace order by 1, 2`,
    ),
    indexes: await client.query(
      `select indexname, indexdef from pg_indexes where schemaname = 'facetdb' order by 1`,
    ),
    versions: await client.query(`select version from facetdb.store_migrations order by 1`),
    reviews: await client.query(`select record_key from facetdb.reviews order by 1`),
  };
}

async function tables(client: SqlClient): Promise<string[]> {
  const rows = await client.query(
    `select table_name from information_schema.tables
      where table_schema = 'facetdb' and table_name = any($1) order by 1`,
    [[...NEW_TABLES]],
  );
  return rows.map((row) => String(row["table_name"]));
}

async function timeIndex(client: SqlClient): Promise<unknown[]> {
  const rows = await client.query(
    `select indexdef from pg_indexes where schemaname = 'facetdb' and indexname = 'decisions_by_time'`,
  );
  return rows.map((row) => row["indexdef"]);
}

describe("store migration 6", () => {
  it("brings a version-5 store to 6 with the queue, the accounts, the run log and the time index", async () => {
    const client = await version5Store();
    expect(await storeVersion(client.query)).toEqual({ kind: "found", newest: 5, current: false });
    expect(await tables(client)).toEqual([]);
    // The log a version-5 store already holds stays as it was: the migration only adds.
    await client.query(
      `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
       values ('p:s', '1', 'answer', 1, 'h', 'jev-1.14.0', '{}', '{}', now())`,
    );

    expect(await migrateStore(client)).toEqual([]);

    expect(SCHEMA_VERSION).toBe(6);
    expect(await storeVersion(client.query)).toEqual({ kind: "found", newest: 6, current: true });
    expect(await tables(client)).toEqual(["reviews", "runs", "users"]);
    expect(await timeIndex(client)).toEqual([TIME_INDEX]);
    expect(await client.query(`select count(*)::int as n from facetdb.decisions`)).toEqual([
      { n: 1 },
    ]);
    expect(
      await client.query(
        `select table_name, column_name, data_type, is_nullable
           from information_schema.columns
          where table_schema = 'facetdb' and table_name = any($1)
          order by table_name, ordinal_position`,
        [[...NEW_TABLES]],
      ),
    ).toEqual(
      [
        ["reviews", "source_id", "text", "NO"],
        ["reviews", "record_key", "text", "NO"],
        ["reviews", "state_hash", "text", "NO"],
        ["reviews", "open_questions", "jsonb", "NO"],
        ["reviews", "numbers", "jsonb", "NO"],
        ["reviews", "since", "timestamp with time zone", "NO"],
        ["reviews", "locked_by", "text", "YES"],
        ["reviews", "locked_until", "timestamp with time zone", "YES"],
        ["reviews", "skipped_by", "jsonb", "NO"],
        ["runs", "id", "bigint", "NO"],
        ["runs", "source_id", "text", "NO"],
        ["runs", "started_at", "timestamp with time zone", "NO"],
        ["runs", "ended_at", "timestamp with time zone", "NO"],
        ["runs", "claimed", "integer", "NO"],
        ["runs", "answered", "integer", "NO"],
        ["runs", "to_review", "integer", "NO"],
        ["runs", "errors", "integer", "NO"],
        ["runs", "discarded", "integer", "NO"],
        ["runs", "tokens", "bigint", "NO"],
        ["users", "name", "text", "NO"],
        ["users", "password_hash", "text", "NO"],
        ["users", "created_at", "timestamp with time zone", "NO"],
      ].map(([table_name, column_name, data_type, is_nullable]) => ({
        table_name,
        column_name,
        data_type,
        is_nullable,
      })),
    );
    // One card per record of a source (the primary key), and a lock is a holder with its lease.
    await client.query(
      `insert into facetdb.reviews (source_id, record_key, state_hash, open_questions, numbers, since)
       values ('p:s', '1', 'h', '["is_scam"]', '{"is_scam": 0.58}', now())`,
    );
    expect(await client.query(`select skipped_by from facetdb.reviews`)).toEqual([
      { skipped_by: [] },
    ]);
    await expect(
      client.query(
        `insert into facetdb.reviews (source_id, record_key, state_hash, open_questions, numbers, since)
         values ('p:s', '1', 'h2', '[]', '{}', now())`,
      ),
    ).rejects.toThrow(/duplicate key/);
    await expect(
      client.query(`update facetdb.reviews set locked_by = 'ana' where record_key = '1'`),
    ).rejects.toThrow(/check constraint/);
  });

  it("changes nothing when it runs again, by a store opening or by the printed script", async () => {
    const client = await version5Store();
    await migrateStore(client);
    await client.query(
      `insert into facetdb.reviews (source_id, record_key, state_hash, open_questions, numbers, since)
       values ('p:s', '1', 'h', '["is_scam"]', '{"is_scam": 0.58}', now())`,
    );
    const before = await catalog(client);

    expect(await migrateStore(client)).toEqual([]);
    expect(await catalog(client)).toEqual(before);

    // The printed install script, twice: every statement is `if not exists` or `on conflict`.
    for (let pass = 0; pass < 2; pass += 1) {
      await client.transaction(async (query) => {
        for (const statement of storeInstallStatements()) {
          await query(statement);
        }
      });
    }
    expect(await catalog(client)).toEqual(before);

    // Migration 6 run again over its own tables (its row lost): the card a reviewer sees stays.
    await client.query(`delete from facetdb.store_migrations where version = 6`);
    await migrateStore(client);
    expect(await catalog(client)).toEqual(before);
    expect(await storeVersion(client.query)).toEqual({ kind: "found", newest: 6, current: true });
  });

  it("prints migration 6 as three create table statements and one index, under the store's part", () => {
    const statements = storeInstallStatements();
    const from = statements.indexOf(
      "insert into facetdb.store_migrations (version) values (5) on conflict (version) do nothing",
    );
    const to = statements.indexOf(
      "insert into facetdb.store_migrations (version) values (6) on conflict (version) do nothing",
    );
    const migration6 = statements.slice(from + 1, to);
    // The index is looked up first and created only when missing (sql/ddl.ts): its `create` line is
    // the one inside the `do` block.
    const creation = (text: string) =>
      text
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("create "))
        ?.split(" (")[0];
    expect(migration6.map(creation)).toEqual([
      "create table if not exists facetdb.reviews",
      "create table if not exists facetdb.users",
      "create table if not exists facetdb.runs",
      "create index decisions_by_time on facetdb.decisions",
    ]);
    expect(migration6[3]).toContain("if to_regclass('facetdb.decisions_by_time') is null then");

    // In the install script, they and the worker's grants on them are the store's, not the source's.
    const listings: QuestionSet = {
      questions: [
        { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
      ],
      read: ["title", "description"],
      model: "jev-1.14.0",
      thresholds: {},
    };
    const script = installSql({ table: "listings", key: "id" }, listings, {
      id: "proj_listings",
      name: "Listings",
    });
    const databaseOf = (text: string) =>
      script.filter((statement) => statement.text === text).map((statement) => statement.database);
    for (const text of migration6) {
      expect(databaseOf(text)).toEqual(["store"]);
    }
    const grants = script
      .filter((statement) =>
        /^(grant|revoke) .* "facetdb"\."(reviews|users|runs)(_id_seq)?"/.test(statement.text),
      )
      .map((statement) => [statement.text, statement.database]);
    expect(grants).toEqual([
      ['grant select, insert, update, delete on "facetdb"."reviews" to "facetdb_worker"', "store"],
      ['grant select on "facetdb"."users" to "facetdb_worker"', "store"],
      ['grant select, insert, update, delete on "facetdb"."runs" to "facetdb_worker"', "store"],
      ['grant usage, select on sequence "facetdb"."runs_id_seq" to "facetdb_worker"', "store"],
    ]);
  });
});
