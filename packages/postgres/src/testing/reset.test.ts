import type { QuestionSet } from "@facetdb/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "../install/index.ts";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "./pglite.ts";

/**
 * The reset that lets one PGlite serve a whole test file: after it the engine is the empty
 * cluster it booted as, whatever the test before it installed, created, granted or listened to.
 */

const listings: QuestionSet = {
  questions: [
    {
      type: "noul",
      name: "is_scam",
      instructions: "Is this listing likely a scam?",
      stakes: "high",
    },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

let world: PgliteWorld;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

type Rows = readonly Readonly<Record<string, unknown>>[];

async function rows(text: string): Promise<Rows> {
  return world.client.query(text);
}

type Catalog = {
  readonly schemas: Rows;
  readonly roles: Rows;
  readonly tables: Rows;
  readonly listening: Rows;
  readonly user: Rows;
};

/** What the template holds and a reset must restore: names and grants only (oids differ). */
async function catalog(): Promise<Catalog> {
  return {
    schemas: await rows(
      `select nspname, nspowner::regrole::text as owner, nspacl::text as acl,
              obj_description(oid, 'pg_namespace') as comment
         from pg_namespace order by nspname`,
    ),
    roles: await rows(`select rolname from pg_roles where oid >= 16384`),
    tables: await rows(
      `select relname from pg_class where relnamespace not in
         ('pg_catalog'::regnamespace, 'information_schema'::regnamespace, 'pg_toast'::regnamespace)`,
    ),
    listening: await rows(`select pg_listening_channels() as channel`),
    user: await rows(`select current_user::text as name`),
  };
}

async function install(): Promise<void> {
  await world.client.query(
    `create table public.listings (id serial primary key, title text, description text)`,
  );
  await migrate({
    adminUrl: "postgres://admin@unused/listings",
    connect: world.connect,
    print: () => {},
    plan: {
      source: { table: "listings" },
      questionSet: listings,
      project: { id: "proj_listings", name: "Listings" },
      workerPassword: "a-long-random-password",
    },
  });
}

describe("resetPgliteWorld", () => {
  let booted: Catalog;

  beforeAll(async () => {
    booted = await catalog();
  });

  afterEach(async () => {
    await resetPgliteWorld(world);
  });

  it("leaves the catalog as the engine booted: public alone, no user role, table or listener", async () => {
    expect(booted.roles).toEqual([]);
    expect(booted.tables).toEqual([]);
    expect(booted.listening).toEqual([]);

    await install();
    await world.client.query(`create schema tenant`);
    await world.client.query(`create table tenant.notes (id serial primary key)`);
    await world.client.query(`create role app_role`);
    await world.client.query(`grant usage on schema tenant to app_role`);
    await world.client.query(`grant create on database postgres to app_role`);
    let woken = 0;
    const listen = world.client.listen;
    if (listen === undefined) throw new Error("the PGlite client listens");
    await listen("facetdb_reset_probe", () => {
      woken += 1;
    });
    await world.client.query(`set role app_role`);
    expect((await catalog()).roles).not.toEqual([]);
    expect((await catalog()).listening).toEqual([{ channel: "facetdb_reset_probe" }]);

    await resetPgliteWorld(world);

    expect(await catalog()).toEqual(booted);
    await world.client.query(`notify facetdb_reset_probe`);
    expect(woken).toBe(0);
  });

  it("is idempotent: a reset of an empty engine changes nothing", async () => {
    await resetPgliteWorld(world);
    await resetPgliteWorld(world);
    expect(await catalog()).toEqual(booted);
  });

  it("lets an install run again, with sequences starting at 1", async () => {
    await install();
    await world.client.query(`insert into public.listings (title) values ('a'), ('b')`);
    await resetPgliteWorld(world);

    await install();
    const [first] = await rows(`insert into public.listings (title) values ('c') returning id`);
    expect(first).toEqual({ id: 1 });
    const workers = await rows(`select rolname from pg_roles where rolname = 'facetdb_worker'`);
    expect(workers).toHaveLength(1);
  });

  it("works after a transaction that failed mid-way", async () => {
    await world.client.query(`create table public.half (id integer primary key)`);
    await expect(
      world.client.transaction(async (query) => {
        await query(`insert into public.half values (1)`);
        await query(`insert into public.half values (1)`);
      }),
    ).rejects.toThrow();
    // And one a test opened by hand and left aborted, with a listener still open: the reset rolls
    // back before it unlistens, which an aborted transaction would refuse.
    const listen = world.client.listen;
    if (listen === undefined) throw new Error("the PGlite client listens");
    await listen("facetdb_reset_probe", () => undefined);
    await world.db.exec(`begin`);
    await expect(world.db.exec(`select 1 / 0`)).rejects.toThrow();

    await resetPgliteWorld(world);

    expect(await catalog()).toEqual(booted);
    await install();
  });
});
