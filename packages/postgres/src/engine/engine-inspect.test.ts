import { INSPECT_MAX_VALUE } from "@facetdb/core";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { SqlConnectOptions } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld, resetPgliteWorld } from "../testing/index.ts";
import { createPostgresEngine } from "./engine.ts";
import { INSPECT_CONNECT_TIMEOUT_S, inReadOnly } from "./inspect.ts";

/**
 * `inspect` on PGlite: the tables the admin role reads, `public` first and FacetDB's and Supabase's
 * own schemas left out; for one table its columns, its key and five rows as text, newest by the key
 * first; a missing table refused in words; an insecure URL refused before a connection; one
 * connection opened with a short timeout, and closed.
 */

const ADMIN = "postgres://admin@localhost/app";

let world: PgliteWorld;
const opened: (SqlConnectOptions | undefined)[] = [];

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterEach(async () => {
  opened.length = 0;
  await resetPgliteWorld(world);
});

afterAll(async () => {
  await world.close();
});

const engine = createPostgresEngine({
  connect: (url, options) => {
    opened.push(options);
    return world.connect(url, options);
  },
  pgHost: undefined,
});

async function inspect(table?: string) {
  if (engine.inspect === undefined) {
    throw new Error("the Postgres engine has no inspect");
  }
  return engine.inspect(ADMIN, {
    allowInsecure: false,
    ...(table === undefined ? {} : { table }),
  });
}

describe("the Postgres engine's inspect", () => {
  it("lists the tables, public first, without FacetDB's or Supabase's own schemas", async () => {
    const q = world.client.query;
    await q("create schema sales");
    await q("create schema auth");
    await q("create schema facetdb");
    await q("create table sales.orders (id int primary key)");
    await q("create table public.listings (id int primary key)");
    await q("create table public.sellers (id int primary key)");
    await q("create table auth.users (id int primary key)");
    await q("create table facetdb.jobs (record_key text primary key)");
    await q("create view public.cheap as select * from public.listings");

    const result = await inspect();

    expect(result).toEqual({
      ok: true,
      inspection: { tables: ["listings", "sellers", "sales.orders"] },
    });
    // One connection, with a short timeout to open it.
    expect(opened).toEqual([{ max: 1, connectTimeoutSeconds: INSPECT_CONNECT_TIMEOUT_S }]);
  });

  it("reads a table's columns, its key and five rows as text, newest by the key first", async () => {
    const q = world.client.query;
    await q(
      "create table public.listings (id serial primary key, title text, price numeric, facetdb_status text, seen timestamptz)",
    );
    for (let n = 1; n <= 7; n += 1) {
      await q("insert into public.listings (title, price) values ($1, $2)", [`item ${n}`, n * 10]);
    }
    await q("update public.listings set title = $1 where id = 7", [
      "x".repeat(INSPECT_MAX_VALUE + 40),
    ]);

    const result = await inspect("listings");

    if (!result.ok || result.inspection.table === undefined) {
      throw new Error("expected an inspection of listings");
    }
    const { table } = result.inspection;
    expect(table.name).toBe("listings");
    expect(table.key).toBe("id");
    expect(table.columns).toEqual([
      { name: "id", type: "integer" },
      { name: "title", type: "text" },
      { name: "price", type: "numeric" },
      { name: "seen", type: "timestamp with time zone" },
    ]);
    expect(table.rows.map((row) => row["id"])).toEqual(["7", "6", "5", "4", "3"]);
    expect(table.rows[1]).toEqual({ id: "6", title: "item 6", price: "60", seen: null });
    expect(table.rows[0]?.["title"]).toHaveLength(INSPECT_MAX_VALUE);
  });

  it("says a table has no single-column key, and still shows its rows", async () => {
    await world.client.query("create table public.events (kind text, at int)");
    await world.client.query("insert into public.events values ('a', 1)");

    const result = await inspect("events");

    expect(result.ok && result.inspection.table?.key).toBeNull();
    expect(result.ok && result.inspection.table?.rows).toEqual([{ kind: "a", at: "1" }]);
  });

  it("refuses a table that is not there, in words", async () => {
    const result = await inspect("public.nowhere");

    expect(result).toEqual({
      ok: false,
      refusal: expect.objectContaining({
        code: "no-table",
        message: "there is no table public.nowhere this connection can read",
      }),
    });
  });

  it("sets nothing on the session, and reads inside a transaction that refuses a write", async () => {
    await world.client.query("create table public.listings (id int primary key, title text)");
    const before = await world.client.query("show statement_timeout");
    await inspect("listings");
    // The timeout was the transaction's own: the session's is what it was.
    expect(await world.client.query("show statement_timeout")).toEqual(before);
    const client = world.connect(ADMIN, { max: 1 });
    await expect(
      inReadOnly(client, (query) => query("insert into public.listings values (1, 'x')")),
    ).rejects.toThrow(/read-only transaction/);
    expect(await world.client.query("select count(*)::int as n from public.listings")).toEqual([
      { n: 0 },
    ]);
    // And it rolls back what it read, so a transaction that wrote would have kept nothing either.
    expect(await world.client.query("show transaction_read_only")).toEqual([
      { transaction_read_only: "off" },
    ]);
  });

  it("reads a draft source's newest rows as scan does, its where filter judged, and the table's estimated size", async () => {
    const q = world.client.query;
    await q("create table public.listings (id int primary key, title text, price int)");
    for (let n = 1; n <= 4; n += 1) {
      await q("insert into public.listings values ($1, $2, $3)", [n, `item ${n}`, n * 10]);
    }
    if (engine.readRows === undefined) {
      throw new Error("the Postgres engine has no readRows");
    }
    const target = {
      project: { id: "p", name: "p" },
      source: "listings",
      table: "listings",
      storage: "inline" as const,
      onChange: "reset" as const,
      questionSet: {
        questions: [],
        read: ["title"],
        model: "jev-1.14.0",
        thresholds: {},
        where: "price > 25",
      },
    };
    // Never analysed: the database has no estimate, and none is made up (never a zero-row price).
    const unanalysed = await engine.readRows(target, ADMIN, { allowInsecure: false, limit: 3 });
    expect(unanalysed.ok && unanalysed.estimatedRows).toBeNull();
    await q("analyze public.listings");
    const before = await q("show statement_timeout");
    const result = await engine.readRows(
      {
        project: { id: "p", name: "p" },
        source: "listings",
        table: "listings",
        storage: "inline",
        onChange: "reset",
        questionSet: {
          questions: [],
          read: ["title"],
          model: "jev-1.14.0",
          thresholds: {},
          where: "price > 25",
        },
      },
      ADMIN,
      { allowInsecure: false, limit: 3 },
    );
    if (!result.ok) {
      throw new Error(result.refusal.message);
    }
    expect(result.rows.map((row) => [row.key, row.state["title"], row.excluded])).toEqual([
      ["4", "item 4", false],
      ["3", "item 3", false],
      ["2", "item 2", true],
    ]);
    expect(result.estimatedRows).toBe(4);
    expect(await q("show statement_timeout")).toEqual(before);
    // One connection for each read, the one before the analyse and this one.
    expect(opened).toEqual([
      { max: 1, connectTimeoutSeconds: INSPECT_CONNECT_TIMEOUT_S },
      { max: 1, connectTimeoutSeconds: INSPECT_CONNECT_TIMEOUT_S },
    ]);
  });

  it("refuses a plaintext admin URL to another machine before it connects", async () => {
    if (engine.inspect === undefined) {
      throw new Error("the Postgres engine has no inspect");
    }
    const result = await engine.inspect("postgres://admin:pw@db.example.com/app", {
      allowInsecure: false,
    });

    expect(result.ok).toBe(false);
    expect(opened).toEqual([]);
  });
});
