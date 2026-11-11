import { readFile, writeFile } from "node:fs/promises";
import type { QuestionSet, ScanCursor } from "@facetdb/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  installSql,
  type MigratePlan,
  type MigrateResult,
  migrate,
  renderSql,
} from "../install/index.ts";
import type { SqlQuery } from "../sql/index.ts";
import { createPgliteWorld, type PgliteWorld } from "../testing/index.ts";
import { createScan, type ScanOptions } from "./scan.ts";
import { answerTarget, sideTableName, sideViewName } from "./side-table.ts";

/**
 * The listings example of the install fixture, in side-table mode: its complete install script is
 * the committed fixture install.listings.side-table.sql, compared byte for byte with the generator's
 * output (`UPDATE_FIXTURES=1` rewrites it on purpose, and the diff is reviewed). It sits beside
 * install/install.listings.sql, and the two differ only in what the storage mode changes.
 */
const FIXTURE = new URL("./install.listings.side-table.sql", import.meta.url);
const INLINE_FIXTURE = new URL("../install/install.listings.sql", import.meta.url);

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

const project = { id: "proj_listings", name: "Listings" };

const worlds: PgliteWorld[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    await w.close();
  }
});

async function world(): Promise<PgliteWorld> {
  const w = await createPgliteWorld();
  worlds.push(w);
  return w;
}

async function migrateOn(
  w: PgliteWorld,
  overrides: {
    readonly source?: MigratePlan["source"];
    readonly project?: MigratePlan["project"];
    /** The worker login exists already (a later install): no password is given. */
    readonly reuseWorker?: boolean;
  } = {},
): Promise<MigrateResult> {
  return migrate({
    adminUrl: "postgres://admin@unused/listings",
    connect: w.connect,
    print: () => undefined,
    plan: {
      source: overrides.source ?? { table: "listings", storage: "side-table" },
      questionSet: listings,
      project: overrides.project ?? project,
      ...(overrides.reuseWorker === true ? {} : { workerPassword: "a-long-random-password" }),
    },
  });
}

/** Seeds `count` listings with ids 1..count; created_at runs against the ids when `reversed`. */
async function seed(
  w: PgliteWorld,
  count: number,
  options: { readonly createdAt?: "none" | "with-id" | "against-id" } = {},
): Promise<void> {
  const mode = options.createdAt ?? "none";
  await w.client.query(
    `create table public.listings (id integer primary key, title text, description text${
      mode === "none" ? "" : ", created_at timestamptz"
    })`,
  );
  const stamp =
    mode === "none"
      ? ""
      : mode === "with-id"
        ? ", timestamptz '2026-01-01 00:00:00+00' + (g || ' minutes')::interval"
        : ", timestamptz '2026-01-01 00:00:00+00' + ((100000 - g) || ' minutes')::interval";
  await w.client.query(
    `insert into public.listings (id, title, description${mode === "none" ? "" : ", created_at"})
     select g, 'title ' || g, 'description ' || g${stamp} from generate_series(1, ${count}) g`,
  );
}

async function pages(
  scan: (cursor: ScanCursor | null) => Promise<{
    readonly rows: readonly { readonly key: string }[];
    readonly next: ScanCursor | null;
  }>,
  from: ScanCursor | null = null,
): Promise<{ keys: string[][]; cursors: ScanCursor[] }> {
  const keys: string[][] = [];
  const cursors: ScanCursor[] = [];
  let cursor = from;
  do {
    const page = await scan(cursor);
    keys.push(page.rows.map((row) => row.key));
    cursor = page.next;
    if (cursor !== null) {
      cursors.push(cursor);
    }
  } while (cursor !== null);
  return { keys, cursors };
}

function scanner(w: PgliteWorld, extra: Partial<ScanOptions> = {}) {
  return createScan({
    query: w.client.query,
    source: { table: "listings", key: "id" },
    questionSet: listings,
    ...extra,
  });
}

describe("scan", () => {
  it("pages of 500, newest first by the primary key when the table has no creation marker", async () => {
    const w = await world();
    await seed(w, 1100);
    const { keys } = await pages(scanner(w));
    expect(keys.map((page) => page.length)).toEqual([500, 500, 100]);
    const all = keys.flat().map(Number);
    expect(all[0]).toBe(1100);
    expect(all).toEqual([...all].sort((a, b) => b - a));
    expect(new Set(all).size).toBe(1100);
  });

  it("orders by created_at when the table has one, newest first, whatever the keys say", async () => {
    const w = await world();
    await seed(w, 25, { createdAt: "against-id" });
    const { keys } = await pages(scanner(w, { pageSize: 10 }));
    expect(keys.map((page) => page.length)).toEqual([10, 10, 5]);
    // created_at is latest for the smallest id, so the scan starts at id 1.
    expect(keys.flat().map(Number)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it("breaks ties on the marker by key and puts null markers last, without skipping any", async () => {
    const w = await world();
    await w.client.query(
      `create table public.listings (id integer primary key, title text, description text, created_at timestamptz)`,
    );
    await w.client.query(
      `insert into public.listings (id, title, description, created_at) values
         (1, 'a', 'a', '2026-01-01 00:00:00+00'), (2, 'b', 'b', '2026-01-01 00:00:00+00'),
         (3, 'c', 'c', '2026-01-01 00:00:00+00'), (4, 'd', 'd', null), (5, 'e', 'e', null),
         (6, 'f', 'f', '2026-02-01 00:00:00+00'), (7, 'g', 'g', null)`,
    );
    const { keys } = await pages(scanner(w, { pageSize: 2 }));
    expect(keys.flat()).toEqual(["6", "3", "2", "1", "7", "5", "4"]);
  });

  it("restarts from the persisted cursor without skipping or repeating a record", async () => {
    const w = await world();
    await seed(w, 47, { createdAt: "with-id" });
    const everything = (await pages(scanner(w, { pageSize: 10 }))).keys.flat();
    expect(everything).toHaveLength(47);

    // Two pages in one "process", the cursor stored as text, the rest in a new one.
    const first = scanner(w, { pageSize: 10 });
    const one = await first(null);
    const two = await first(one.next);
    const saved: string = JSON.parse(JSON.stringify(two.next));
    const restarted = await pages(scanner(w, { pageSize: 10 }), saved);
    const seen = [...one.rows, ...two.rows].map((row) => row.key).concat(restarted.keys.flat());
    expect(seen).toEqual(everything);
    expect(new Set(seen).size).toBe(47);
  });

  it("restarts the same way on a table without a creation marker", async () => {
    const w = await world();
    await seed(w, 33);
    const everything = (await pages(scanner(w, { pageSize: 10 }))).keys.flat();
    const first = await scanner(w, { pageSize: 10 })(null);
    const rest = await pages(scanner(w, { pageSize: 10 }), first.next);
    expect([...first.rows.map((row) => row.key), ...rest.keys.flat()]).toEqual(everything);
  });

  it("never shifts a page when rows arrive or get answered between pages", async () => {
    const w = await world();
    await seed(w, 30);
    const scan = scanner(w, { pageSize: 10 });
    const one = await scan(null);
    await w.client.query(
      `insert into public.listings (id, title, description) values (31, 'new', 'new')`,
    );
    await w.client.query(`delete from public.listings where id = 19`);
    const rest = await pages(scan, one.next);
    const seen = [...one.rows.map((row) => row.key), ...rest.keys.flat()].map(Number);
    expect(seen).toEqual([
      30, 29, 28, 27, 26, 25, 24, 23, 22, 21, 20, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5,
      4, 3, 2, 1,
    ]);
  });

  it("returns the state fields, their hash and the where filter's verdict", async () => {
    const w = await world();
    await seed(w, 3);
    const scan = scanner(w, {
      questionSet: { ...listings, where: "id <> 2" },
    });
    const { rows } = await scan(null);
    expect(rows.map((row) => [row.key, row.excluded])).toEqual([
      ["3", false],
      ["2", true],
      ["1", false],
    ]);
    expect(rows[0]?.state).toEqual({ title: "title 3", description: "description 3" });
    expect(rows[0]?.hash).toMatch(/^[0-9a-f]+$/);
    expect(rows[0]?.hash).not.toBe(rows[2]?.hash);
  });

  it("refuses a cursor it did not hand out, or one from the other ordering", async () => {
    const w = await world();
    await seed(w, 5);
    await expect(scanner(w)("not json")).rejects.toThrow("not one this scan handed out");
    await expect(scanner(w)('{"nope":1}')).rejects.toThrow("not one this scan handed out");
    await expect(scanner(w)('{"key":"3","created":"2026-01-01"}')).rejects.toThrow(
      "start the backfill again",
    );
  });

  it.each(["inline", "side-table"] as const)(
    "runs as the worker login and still orders by created_at (%s)",
    async (storage) => {
      const w = await world();
      await seed(w, 25, { createdAt: "against-id" });
      expect((await migrateOn(w, { source: { table: "listings", storage } })).ok).toBe(true);
      await w.client.query(`set role facetdb_worker`);
      try {
        const { keys } = await pages(scanner(w, { pageSize: 10 }));
        // created_at is latest for the smallest id: the order is not the key's.
        expect(keys.flat().map(Number)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
      } finally {
        await w.client.query(`reset role`);
      }
    },
  );

  describe("records already done for the current question-set version", () => {
    async function logged(w: PgliteWorld): Promise<void> {
      await seed(w, 6);
      await migrateOn(w, { source: { table: "listings" } });
      await w.client.query(
        `create table facetdb.decisions (source_id text not null, record_key text not null, kind text not null, version integer not null)`,
      );
      // 6 and 5: done at v2. 4: done at v1 (an older version). 3: logged at v2 but pending again
      // (its state changed). 2 and 1: never answered.
      await w.client.query(
        `update public.listings set facetdb_status = 'done' where id in (4, 5, 6)`,
      );
      await w.client.query(
        `insert into facetdb.decisions (source_id, record_key, kind, version) values
           ('src', '6', 'answer', 2), ('src', '5', 'answer', 2), ('src', '4', 'answer', 1),
           ('src', '3', 'answer', 2), ('other', '2', 'answer', 2), ('src', '1', 'human', 2)`,
      );
    }

    it("are left out by the query, not in memory", async () => {
      const w = await world();
      await logged(w);
      const statements: string[] = [];
      const query: SqlQuery = (text, params) => {
        statements.push(text);
        return w.client.query(text, params);
      };
      const scan = createScan({
        query,
        source: { table: "listings", key: "id" },
        questionSet: listings,
        skipDone: { sourceId: "src", version: 2 },
        pageSize: 2,
      });
      const { keys } = await pages(scan);
      expect(keys.flat()).toEqual(["4", "3", "2", "1"]);
      // Pages stay full because the filter is in the query: 2 + 2 rows, not 6 rows minus two.
      expect(keys.map((page) => page.length)).toEqual([2, 2]);
      const selects = statements.filter((text) => text.includes('from "public"."listings"'));
      expect(selects.every((text) => text.includes("facetdb.decisions"))).toBe(true);
    });

    it("leave nothing out in a database with no decision log yet", async () => {
      const w = await world();
      await seed(w, 4);
      await migrateOn(w, { source: { table: "listings" } });
      await w.client.query(`update public.listings set facetdb_status = 'done'`);
      const scan = scanner(w, { skipDone: { sourceId: "src", version: 1 } });
      expect((await scan(null)).rows).toHaveLength(4);
    });
  });
});

describe("side-table install", () => {
  const source = {
    table: "listings",
    key: "id",
    storage: "side-table",
    keyType: "integer",
  } as const;

  it("matches the fixture byte for byte", async () => {
    const sql = renderSql(
      installSql(source, listings, project, { workerPassword: "a-long-random-password" }),
    );
    if (process.env["UPDATE_FIXTURES"] === "1") {
      await writeFile(FIXTURE, sql);
    }
    expect(sql).toBe(await readFile(FIXTURE, "utf8"));
  });

  it("differs from the inline fixture only in the target", async () => {
    // Both scripts, statement by statement; the lines that differ are the target's and nothing else.
    const side = (await readFile(FIXTURE, "utf8")).split("\n\n");
    const inline = (await readFile(INLINE_FIXTURE, "utf8")).split("\n\n");
    const only = (a: string[], b: string[]) => a.filter((statement) => !b.includes(statement));
    const touched = (statements: string[]) => statements.join("\n");
    const inlineOnly = touched(only(inline, side));
    const sideOnly = touched(only(side, inline));
    // Inline alters the application's table and marks the columns; nothing else is unique to it
    // except the grants and the policies that depend on where the columns live.
    expect(inlineOnly).toContain('alter table "public"."listings"');
    expect(inlineOnly).toContain("comment on column");
    expect(inlineOnly).not.toContain("create table");
    expect(inlineOnly).not.toContain("create view");
    expect(sideOnly).toContain('create table if not exists "facetdb"."listings_answers"');
    expect(sideOnly).toContain(
      'create view "public"."listings_with_answers" with (security_invoker = true)',
    );
    expect(sideOnly).toContain("on delete cascade");
    expect(sideOnly).not.toContain("comment on column");
  });

  it("carries exactly the columns inline mode adds, plus the key", async () => {
    const w = await world();
    await seed(w, 1);
    expect((await migrateOn(w)).ok).toBe(true);
    const columns = async (schema: string, table: string) =>
      w.client.query(
        `select column_name, data_type, is_nullable, column_default from information_schema.columns
          where table_schema = $1 and table_name = $2 order by ordinal_position`,
        [schema, table],
      );
    // The same question set on a table installed inline: the columns it adds.
    await w.client.query(
      `create table public.inline (id integer primary key, title text, description text)`,
    );
    const inline = await migrateOn(w, {
      source: { table: "inline" },
      project: { id: "p3", name: "P3" },
      reuseWorker: true,
    });
    expect(inline.ok).toBe(true);
    const added = (await columns("public", "inline")).filter(
      (row) => !["id", "title", "description"].includes(String(row["column_name"])),
    );
    const side = (await columns("facetdb", "listings_answers")).filter(
      (row) => row["column_name"] !== "id",
    );
    expect(side).toEqual(added);
    expect((await columns("facetdb", "listings_answers"))[0]).toMatchObject({
      column_name: "id",
      data_type: "integer",
      is_nullable: "NO",
    });
  });

  it("leaves the application's table untouched and the view returns the joined row", async () => {
    const w = await world();
    await seed(w, 3);
    const before = await w.client.query(
      `select column_name from information_schema.columns where table_name = 'listings' and table_schema = 'public' order by ordinal_position`,
    );
    const result = await migrateOn(w);
    expect(result).toMatchObject({ ok: true, applied: true, changed: true });
    expect(
      await w.client.query(
        `select column_name from information_schema.columns where table_name = 'listings' and table_schema = 'public' order by ordinal_position`,
      ),
    ).toEqual(before);

    // No side row yet: the view reads the defaults inline mode gives a fresh row.
    expect(
      await w.client.query(
        `select id, title, is_scam, facetdb_status, facetdb_reviewed from public.listings_with_answers where id = 2`,
      ),
    ).toEqual([
      {
        id: 2,
        title: "title 2",
        is_scam: null,
        facetdb_status: "pending",
        facetdb_reviewed: false,
      },
    ]);

    const target = answerTarget({ table: "listings", key: "id", storage: "side-table" });
    expect(target).toEqual({ schema: "facetdb", table: "listings_answers", keyColumn: "id" });
    await w.client.query(
      `insert into facetdb.listings_answers (id, is_scam, is_scam_probability, facetdb_status) values (2, false, 0.03, 'done')`,
    );
    expect(
      await w.client.query(
        `select id, title, is_scam, is_scam_probability, facetdb_status from public.listings_with_answers order by id`,
      ),
    ).toEqual([
      {
        id: 1,
        title: "title 1",
        is_scam: null,
        is_scam_probability: null,
        facetdb_status: "pending",
      },
      {
        id: 2,
        title: "title 2",
        is_scam: false,
        is_scam_probability: 0.03,
        facetdb_status: "done",
      },
      {
        id: 3,
        title: "title 3",
        is_scam: null,
        is_scam_probability: null,
        facetdb_status: "pending",
      },
    ]);
  });

  it("installs twice with nothing changed", async () => {
    const w = await world();
    await seed(w, 1);
    await migrateOn(w);
    const catalog = async () =>
      w.client.query(
        `select 'column' as kind, table_name || '.' || column_name as name from information_schema.columns where table_schema in ('facetdb', 'public')
         union all select 'view', viewname || ': ' || definition from pg_views where schemaname = 'public'
         union all select 'trigger', pg_get_triggerdef(oid) from pg_trigger where not tgisinternal
         union all select 'function', proname || ':' || proowner::regrole::text from pg_proc where pronamespace = 'facetdb'::regnamespace
         order by 1, 2`,
      );
    const first = await catalog();
    const second = await migrateOn(w, { reuseWorker: true });
    expect(second).toMatchObject({ ok: true, changed: false });
    expect(await catalog()).toEqual(first);
  });

  it("keeps the trigger on the source table: a change queues the key and puts the side row back to pending", async () => {
    const w = await world();
    await seed(w, 2);
    await migrateOn(w);
    const jobs = async () =>
      (await w.client.query(`select record_key from facetdb.jobs order by 1`)).map(
        (r) => r["record_key"],
      );
    expect(await jobs()).toEqual([]);
    await w.client.query(
      `insert into facetdb.listings_answers (id, is_scam, facetdb_status) values (1, false, 'done'), (2, true, 'done')`,
    );
    await w.client.query(`update public.listings set title = 'changed' where id = 1`);
    expect(await jobs()).toEqual(["15:public.listings:1"]);
    expect(
      await w.client.query(
        `select id, facetdb_status, is_scam from facetdb.listings_answers order by id`,
      ),
    ).toEqual([
      { id: 1, facetdb_status: "pending", is_scam: false },
      { id: 2, facetdb_status: "done", is_scam: true },
    ]);
    await w.client.query(
      `insert into public.listings (id, title, description) values (9, 'x', 'y')`,
    );
    expect(await jobs()).toEqual(["15:public.listings:1", "15:public.listings:9"]);
  });

  it("onChange keep leaves the stored status in place", async () => {
    const w = await world();
    await seed(w, 1);
    await migrateOn(w, { source: { table: "listings", storage: "side-table", onChange: "keep" } });
    await w.client.query(
      `insert into facetdb.listings_answers (id, is_scam, facetdb_status) values (1, false, 'done')`,
    );
    await w.client.query(`update public.listings set title = 'changed' where id = 1`);
    expect(await w.client.query(`select facetdb_status from facetdb.listings_answers`)).toEqual([
      { facetdb_status: "done" },
    ]);
    expect(await w.client.query(`select record_key from facetdb.jobs`)).toEqual([
      { record_key: "15:public.listings:1" },
    ]);
  });

  it("gives the trigger functions only the rights they need on the side table", async () => {
    const w = await world();
    await seed(w, 1);
    await migrateOn(w);
    const grants = await w.client.query(
      `select grantee, column_name, privilege_type from information_schema.column_privileges
        where table_schema = 'facetdb' and table_name = 'listings_answers' and grantee in ('facetdb_enqueue', 'facetdb_worker')
        order by grantee, privilege_type, column_name`,
    );
    const by = (grantee: string) =>
      grants
        .filter((g) => g["grantee"] === grantee)
        .map((g) => `${g["privilege_type"]} ${g["column_name"]}`);
    expect(by("facetdb_enqueue")).toEqual([
      "SELECT facetdb_status",
      "SELECT id",
      "UPDATE facetdb_status",
    ]);
    // The worker may not touch the application's table beyond reading its key and state.
    const onSource = await w.client.query(
      `select privilege_type, column_name from information_schema.column_privileges
        where table_schema = 'public' and table_name = 'listings' and grantee = 'facetdb_worker' order by 1, 2`,
    );
    expect(onSource).toEqual([
      { privilege_type: "SELECT", column_name: "description" },
      { privilege_type: "SELECT", column_name: "id" },
      { privilege_type: "SELECT", column_name: "title" },
    ]);
    expect(by("facetdb_worker")).toContain("UPDATE is_scam");
    expect(by("facetdb_worker")).not.toContain("UPDATE id");
  });

  it("scans the source and reads the done test from the side table", async () => {
    const w = await world();
    await seed(w, 4);
    await migrateOn(w);
    await w.client.query(
      `create table facetdb.decisions (source_id text not null, record_key text not null, kind text not null, version integer not null)`,
    );
    await w.client.query(
      `insert into facetdb.listings_answers (id, is_scam, facetdb_status) values (4, false, 'done'), (3, false, 'done'), (2, false, 'pending')`,
    );
    await w.client.query(
      `insert into facetdb.decisions (source_id, record_key, kind, version) values ('src', '4', 'answer', 3), ('src', '3', 'answer', 2), ('src', '2', 'answer', 3)`,
    );
    const scan = createScan({
      query: w.client.query,
      source: { table: "listings", key: "id", storage: "side-table" },
      questionSet: listings,
      skipDone: { sourceId: "src", version: 3 },
    });
    // 4 is done at v3; 3 is done but at v2; 2 is logged at v3 but its status went back to pending.
    expect((await scan(null)).rows.map((row) => row.key)).toEqual(["3", "2", "1"]);
  });

  it("gives the view the caller's rights and marks both relations as FacetDB's", async () => {
    const w = await world();
    await seed(w, 1);
    expect(await migrateOn(w)).toMatchObject({ ok: true });
    const view = await w.client.query(
      `select c.reloptions::text as options, obj_description(c.oid, 'pg_class') as mark
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = 'listings_with_answers'`,
    );
    expect(view).toEqual([{ options: "{security_invoker=true}", mark: "facetdb" }]);
    const table = await w.client.query(
      `select obj_description('facetdb.listings_answers'::regclass, 'pg_class') as mark`,
    );
    expect(table).toEqual([{ mark: "facetdb" }]);
  });

  it("refuses to replace a relation of the view's name that is not FacetDB's", async () => {
    const w = await world();
    await seed(w, 1);
    await w.client.query(
      `create view public.listings_with_answers as select id from public.listings`,
    );
    const result = await migrateOn(w);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("listings_with_answers");
    }
    const kept = await w.client.query(
      `select pg_get_viewdef('public.listings_with_answers'::regclass) as def`,
    );
    expect(String(kept[0]?.["def"])).not.toContain("listings_answers");
  });

  it("a deleted record takes its side row with it, so a re-insert starts fresh", async () => {
    const w = await world();
    await seed(w, 2);
    await migrateOn(w);
    await w.client.query(
      `insert into facetdb.listings_answers (id, is_scam, is_scam_probability, facetdb_status, facetdb_reviewed)
       values (1, true, 0.9, 'done', true)`,
    );
    await w.client.query(`delete from public.listings where id = 1`);
    expect(await w.client.query(`select id from facetdb.listings_answers`)).toEqual([]);
    await w.client.query(`insert into public.listings (id, title) values (1, 'again')`);
    expect(
      await w.client.query(
        `select is_scam, facetdb_status, facetdb_reviewed from public.listings_with_answers where id = 1`,
      ),
    ).toEqual([{ is_scam: null, facetdb_status: "pending", facetdb_reviewed: false }]);
  });

  it("keeps the customer's grants on the view across a re-run", async () => {
    const w = await world();
    await seed(w, 1);
    await migrateOn(w);
    await w.client.query(`create role app_reader`);
    await w.client.query(`grant select on public.listings_with_answers to app_reader`);
    await w.client.query(`grant select on public.listings_with_answers to public`);
    expect(await migrateOn(w, { reuseWorker: true })).toMatchObject({ ok: true });
    expect(
      await w.client.query(
        `select has_table_privilege('app_reader', 'public.listings_with_answers', 'select') as reader,
                has_table_privilege('facetdb_worker', 'public.listings_with_answers', 'select') as everyone`,
      ),
    ).toEqual([{ reader: true, everyone: true }]);
  });

  it("gives the source table's readers the side table too, and adds the foreign key once", async () => {
    const w = await world();
    await seed(w, 1);
    await w.client.query(`create role app_role`);
    await w.client.query(`grant select on public.listings to app_role`);
    await migrateOn(w);
    expect(
      await w.client.query(
        `select has_table_privilege('app_role', 'facetdb.listings_answers', 'select') as side,
                has_schema_privilege('app_role', 'facetdb', 'usage') as schema`,
      ),
    ).toEqual([{ side: true, schema: true }]);
    await w.client.query(`set role app_role`);
    try {
      expect(
        await w.client.query(
          `select facetdb_status from public.listings_with_answers where id = 1`,
        ),
      ).toEqual([{ facetdb_status: "pending" }]);
    } finally {
      await w.client.query(`reset role`);
    }
    const oid = await w.client.query(
      `select oid from pg_constraint where conname = 'listings_answers_key_fkey'`,
    );
    await migrateOn(w, { reuseWorker: true });
    expect(
      await w.client.query(
        `select oid from pg_constraint where conname = 'listings_answers_key_fkey'`,
      ),
    ).toEqual(oid);
  });

  it("refuses, rather than throws, a table name too long for the side table's, and a dependent view", async () => {
    const w = await world();
    const long = "a".repeat(60);
    await w.client.query(`create table public."${long}" (id integer primary key, title text)`);
    const tooLong = await migrateOn(w, { source: { table: long, storage: "side-table" } });
    expect(tooLong).toMatchObject({ ok: false });
    if (!tooLong.ok) {
      expect(tooLong.reason).toContain("63");
    }

    await seed(w, 1);
    await migrateOn(w);
    await w.client.query(`create view public.mine as select id from public.listings_with_answers`);
    const dependent = await migrateOn(w, { reuseWorker: true });
    expect(dependent).toMatchObject({ ok: false });
    if (!dependent.ok) {
      expect(dependent.reason).toContain("depend");
    }
  });

  it("keeps a reader limited by the source's row-level security to those rows' answers", async () => {
    const w = await world();
    await seed(w, 3);
    await w.client.query(`create role tenant`);
    await w.client.query(`grant select on public.listings to tenant`);
    await w.client.query(`alter table public.listings enable row level security`);
    await w.client.query(
      `create policy tenant_rows on public.listings for select to tenant using (id = 2)`,
    );
    await migrateOn(w);
    await w.client.query(
      `insert into facetdb.listings_answers (id, is_scam, facetdb_status) values (1, true, 'done'), (2, false, 'done'), (3, true, 'done')`,
    );
    await w.client.query(`set role tenant`);
    try {
      expect(
        await w.client.query(`select id, is_scam from facetdb.listings_answers order by id`),
      ).toEqual([{ id: 2, is_scam: false }]);
      expect(
        await w.client.query(`select id, is_scam from public.listings_with_answers order by id`),
      ).toEqual([{ id: 2, is_scam: false }]);
    } finally {
      await w.client.query(`reset role`);
    }
    // The worker still sees and writes every row.
    await w.client.query(`set role facetdb_worker`);
    try {
      expect(
        (await w.client.query(`select count(*)::int as n from facetdb.listings_answers`))[0]?.["n"],
      ).toBe(3);
      await w.client.query(`update facetdb.listings_answers set is_scam = false where id = 1`);
    } finally {
      await w.client.query(`reset role`);
    }
  });

  it("migrates again after the application added a column, and the view shows it", async () => {
    const w = await world();
    await seed(w, 1);
    await migrateOn(w);
    await w.client.query(`alter table public.listings add column price_cents integer default 100`);
    expect(await migrateOn(w, { reuseWorker: true })).toMatchObject({ ok: true, applied: true });
    expect(
      await w.client.query(`select price_cents from public.listings_with_answers where id = 1`),
    ).toEqual([{ price_cents: 100 }]);
  });

  it("refuses what would leave two copies or a clash", async () => {
    const w = await world();
    await seed(w, 1);
    await migrateOn(w, { source: { table: "listings" } });
    const side = await migrateOn(w);
    expect(side).toMatchObject({ ok: false });
    if (!side.ok) {
      expect(side.reason).toContain("inline install");
    }

    const w2 = await world();
    await seed(w2, 1);
    await migrateOn(w2);
    const inline = await migrateOn(w2, { source: { table: "listings" }, reuseWorker: true });
    expect(inline).toMatchObject({ ok: false });
    if (!inline.ok) {
      expect(inline.reason).toContain("side-table mode");
    }

    const w3 = await world();
    await seed(w3, 1);
    await w3.client.query(`create schema facetdb`);
    await w3.client.query(`create table facetdb.listings_answers (id integer)`);
    const clash = await migrateOn(w3);
    expect(clash).toMatchObject({ ok: false });
    if (!clash.ok) {
      expect(clash.reason).toContain("listings_answers");
    }
  });

  it("names the table and the view from the source, and refuses a name Postgres would truncate", () => {
    expect(sideTableName("listings")).toBe("listings_answers");
    expect(sideViewName("listings")).toBe("listings_with_answers");
    expect(() => sideViewName("a".repeat(51))).toThrow("63-byte");
    expect(() =>
      installSql({ table: "listings", key: "id", storage: "side-table" }, listings, project),
    ).toThrow("type of listings's key");
  });
});
