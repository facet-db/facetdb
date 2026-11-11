import type { QuestionSet, ScanCursor } from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";
import { createScan } from "./scan.ts";

/**
 * The scan on a real Postgres through postgres.js, the client production uses (the unit tests run
 * it on PGlite, whose parameter typing differs). The table that showed the bug: 2,000 rows inserted
 * by one statement, so every `created_at` is the same instant and the keyset cursor has to break
 * the tie on the key for every page after the first (2026-11-01: the Supabase backfill saw 500
 * rows).
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

let scratch: ScratchDatabase;
let client: SqlClient;
const open: SqlClient[] = [];

beforeAll(async () => {
  scratch = await createScratchDatabase();
  client = connectPostgres(scratch.url);
  open.push(client);
  await client.query(
    `create table public.listings (
       id serial primary key, title text not null, description text,
       created_at timestamptz not null default now())`,
  );
  await client.query(
    `insert into public.listings (title, description)
     select 'title ' || g, 'description ' || g from generate_series(1, 2000) g`,
  );
});

afterAll(async () => {
  for (const connection of open.splice(0).reverse()) {
    await connection.close();
  }
  await scratch.drop();
});

describe("scan on a real Postgres", () => {
  it("sends a timestamp parameter with its microseconds, as the text it was given", async () => {
    // The cause behind the paging failure: postgres.js's default serializer for timestamptz goes
    // through a JavaScript Date and keeps milliseconds only, so the cursor's marker never equalled
    // the row's.
    const rows = await client.query(
      `select created_at = $1::timestamp with time zone as same
         from public.listings where id = 1`,
      ["2026-01-01T00:00:00.123456+00:00"],
    );
    await client.query(
      `update public.listings set created_at = '2026-01-01T00:00:00.123456+00:00' where id = 1`,
    );
    const after = await client.query(
      `select created_at = $1::timestamp with time zone as same
         from public.listings where id = 1`,
      ["2026-01-01T00:00:00.123456+00:00"],
    );
    expect(rows[0]?.["same"]).toBe(false);
    expect(after[0]?.["same"]).toBe(true);
    // Back to the instant the other rows share, so the paging case sees one tie across the table.
    await client.query(
      `update public.listings set created_at = (select created_at from public.listings where id = 2) where id = 1`,
    );
  });

  it("pages through 2,000 rows that share one created_at without stopping after the first page", async () => {
    const scan = createScan({
      query: client.query,
      source: { table: "listings", key: "id" },
      questionSet: listings,
    });
    const keys: string[] = [];
    let cursor: ScanCursor | null = null;
    let pages = 0;
    do {
      const page = await scan(cursor);
      pages += 1;
      keys.push(...page.rows.map((row) => row.key));
      cursor = page.next;
    } while (cursor !== null);
    expect(pages).toBe(4);
    expect(keys).toHaveLength(2000);
    expect(new Set(keys).size).toBe(2000);
    expect(keys[0]).toBe("2000");
    expect(keys.at(-1)).toBe("1");
  });
});
