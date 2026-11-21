import { describe, expect, it } from "vitest";
import { pgliteClient, type SqlClient } from "../sql/index.ts";
import { migrateStore, SCHEMA_VERSION, storeInstallStatements, storeVersion } from "./schema.ts";
import { newDb, takeBackMigration9, useStoreWorld } from "./store-world.ts";

/**
 * Store migration 7: the cap joins a spending alert's claim, so a cap changed mid-month is a new
 * claim and a cap raised and reached again raises the alert again. PGlite proves the shape, what a
 * version-6 store's claims become, and the idempotence of the migration's text run again by the
 * install beside a live application.
 */

useStoreWorld();

/** A store as migration 6 left it: the claim keyed by project, month and kind alone. */
async function version6Store(): Promise<SqlClient> {
  const client = pgliteClient(await newDb());
  await migrateStore(client);
  // Migrations 9 and 8 taken back first (each proved on its own in its store-migration-N.test.ts).
  await takeBackMigration9(client);
  await client.query(`drop table facetdb.question_sets_in_force`);
  await client.query(`alter table facetdb.usage_alerts drop constraint usage_alerts_by_cap`);
  await client.query(`alter table facetdb.usage_alerts drop column cap`);
  await client.query(
    `alter table facetdb.usage_alerts add constraint usage_alerts_pkey primary key (project_id, month, kind)`,
  );
  await client.query(`delete from facetdb.store_migrations where version in (7, 8, 9)`);
  return client;
}

async function alertsShape(client: SqlClient): Promise<unknown> {
  return {
    columns: await client.query(
      `select column_name, data_type, is_nullable, column_default
         from information_schema.columns
        where table_schema = 'facetdb' and table_name = 'usage_alerts' order by ordinal_position`,
    ),
    constraints: await client.query(
      `select conname, pg_get_constraintdef(oid) as def
         from pg_constraint where conrelid = 'facetdb.usage_alerts'::regclass order by 1`,
    ),
    versions: await client.query(`select version from facetdb.store_migrations order by 1`),
  };
}

describe("store migration 7", () => {
  it("adds the cap to a usage alert's claim on a version-6 store, keeps the claims it holds, and matches a fresh store", async () => {
    const client = await version6Store();
    expect(await storeVersion(client.query)).toEqual({ kind: "found", newest: 6, current: false });
    await client.query(
      `insert into facetdb.usage_alerts (project_id, month, kind) values ('p', '2026-11', 'spending_paused')`,
    );

    expect(await migrateStore(client)).toEqual([]);

    // The migrations after 7 run too: the version-6 store lands current, whatever the newest is.
    expect(await storeVersion(client.query)).toEqual({
      kind: "found",
      newest: SCHEMA_VERSION,
      current: true,
    });
    const fresh = pgliteClient(await newDb());
    await migrateStore(fresh);
    const shape = await alertsShape(client);
    expect(shape).toEqual(await alertsShape(fresh));
    // Among the not-null constraints the catalog lists on its own, the key is the one with the cap.
    expect(shape).toMatchObject({
      constraints: expect.arrayContaining([
        { conname: "usage_alerts_by_cap", def: "PRIMARY KEY (project_id, month, kind, cap)" },
      ]),
    });
    // A claim a version-6 store held reads as one under cap 0, which no config sets: the first
    // reading under the real cap raises afresh, and another cap is another claim.
    expect(
      await client.query(
        `select project_id, month, kind, cap::int as cap from facetdb.usage_alerts`,
      ),
    ).toEqual([{ project_id: "p", month: "2026-11", kind: "spending_paused", cap: 0 }]);
    await client.query(
      `insert into facetdb.usage_alerts (project_id, month, kind, cap) values ('p', '2026-11', 'spending_paused', 1000000)`,
    );

    // The install runs every migration's text again beside a live application: a repeat changes
    // nothing and keeps every claim.
    for (let pass = 0; pass < 2; pass += 1) {
      await client.transaction(async (query) => {
        for (const statement of storeInstallStatements()) {
          await query(statement);
        }
      });
    }
    expect(await alertsShape(client)).toEqual(shape);
    expect(await client.query(`select count(*)::int as n from facetdb.usage_alerts`)).toEqual([
      { n: 2 },
    ]);
  });
});
