import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "../testing/index.ts";
import type { SqlQuery } from "./client.ts";
import { unlessColumn, unlessConstraint, unlessRelation } from "./ddl.ts";
import { jobsTableSql } from "./jobs.ts";

/**
 * The look-up-first DDL on PGlite: created when missing, and on a repeat run no lock on the table
 * at all, where Postgres's own `if not exists` takes one. The cross-connection wait this prevents
 * is migrate-lock-order.db.test.ts's, on a real Postgres.
 */

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterEach(async () => {
  await resetPgliteWorld(world);
});

afterAll(async () => {
  await world.close();
});

/** The modes this session holds on `relation`, inside the transaction `query` runs in. */
async function heldOn(query: SqlQuery, relation: string): Promise<readonly string[]> {
  const rows = await query(
    `select mode from pg_catalog.pg_locks
      where pid = pg_backend_pid() and relation = to_regclass($1)
      order by mode`,
    [relation],
  );
  return rows.map((row) => String(row["mode"]));
}

const QUEUE_INDEX = `create index "jobs_queue" on "facetdb"."jobs" (enqueued_at, record_key)`;

describe("unlessRelation", () => {
  it("creates the index when it is missing, and a repeat run leaves it as it is", async () => {
    await world.client.query(`create schema facetdb`);
    await world.client.query(jobsTableSql()[1] ?? "");
    const statement = unlessRelation(`"facetdb"."jobs_queue"`, QUEUE_INDEX);
    await world.client.query(statement);
    await world.client.query(statement);
    expect(
      await world.client.query(
        `select indexdef from pg_indexes where schemaname = 'facetdb' and indexname = 'jobs_queue'`,
      ),
    ).toEqual([
      {
        indexdef: "CREATE INDEX jobs_queue ON facetdb.jobs USING btree (enqueued_at, record_key)",
      },
    ]);
  });

  it("takes no lock on the queue when its index exists, where `create index if not exists` takes a share lock", async () => {
    for (const statement of jobsTableSql()) {
      await world.client.query(statement);
    }
    const held = await world.client.transaction(async (query) => {
      await query(unlessRelation(`"facetdb"."jobs_queue"`, QUEUE_INDEX));
      return heldOn(query, "facetdb.jobs");
    });
    expect(held).toEqual([]);
    const builtIn = await world.client.transaction(async (query) => {
      await query(
        `create index if not exists "jobs_queue" on "facetdb"."jobs" (enqueued_at, record_key)`,
      );
      return heldOn(query, "facetdb.jobs");
    });
    expect(builtIn).toContain("ShareLock");
  });
});

describe("unlessColumn", () => {
  it("adds the column when it is missing, and takes no lock on the table when it exists", async () => {
    await world.client.query(`create schema facetdb`);
    await world.client.query(`create table facetdb.outbox (id bigint primary key)`);
    const statement = unlessColumn(
      "facetdb.outbox",
      "claimed_by",
      `alter table facetdb.outbox add column claimed_by text`,
    );
    await world.client.query(statement);
    const held = await world.client.transaction(async (query) => {
      await query(statement);
      return heldOn(query, "facetdb.outbox");
    });
    expect(held).toEqual([]);
    expect(
      await world.client.query(
        `select column_name from information_schema.columns
          where table_schema = 'facetdb' and table_name = 'outbox' order by ordinal_position`,
      ),
    ).toEqual([{ column_name: "id" }, { column_name: "claimed_by" }]);
  });
});

describe("unlessConstraint", () => {
  it("rekeys the table when the constraint is missing, and takes no lock on it when it is there", async () => {
    await world.client.query(`create schema facetdb`);
    await world.client.query(
      `create table facetdb.claims (project text not null, kind text not null, cap bigint not null default 0, primary key (project, kind))`,
    );
    // Store migration 7's shape: the key dropped and made anew with one more column, in one statement.
    const statement = unlessConstraint(
      "facetdb.claims",
      "claims_by_cap",
      `alter table facetdb.claims drop constraint claims_pkey, add constraint claims_by_cap primary key (project, kind, cap)`,
    );
    await world.client.query(statement);
    const held = await world.client.transaction(async (query) => {
      await query(statement);
      return heldOn(query, "facetdb.claims");
    });
    expect(held).toEqual([]);
    expect(
      await world.client.query(
        `select conname, pg_get_constraintdef(oid) as def from pg_constraint
          where conrelid = 'facetdb.claims'::regclass and contype = 'p'`,
      ),
    ).toEqual([{ conname: "claims_by_cap", def: "PRIMARY KEY (project, kind, cap)" }]);
  });
});
