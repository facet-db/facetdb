import { describe, expect, it } from "vitest";
import type { Workspace } from "../program.ts";
import { readSeed, seededTables, sqlStatements } from "./dev-seed.ts";

/**
 * The seed file's reading: a Postgres script split into statements the way the server reads it, so
 * a `;` inside a string, a quoted name, a comment or a dollar-quoted body ends nothing; and the
 * tables the statements fill, as their engine labels them.
 */

describe("the statements of a seed file", () => {
  it("splits on the semicolons outside strings, names, comments and dollar quotes", () => {
    const text = `-- the listings; two of them
create table "Odd;Name" (id int primary key, note text); /* a block; comment
  /* nested; */ still a comment */
insert into "Odd;Name" values (1, 'first; with a semicolon'), (2, 'it''s; quoted');
insert into "Odd;Name" values (3, E'escaped \\'; quote');
do $body$ begin perform 1; end $body$;
select 1`;
    expect(sqlStatements(text)).toEqual([
      'create table "Odd;Name" (id int primary key, note text)',
      `insert into "Odd;Name" values (1, 'first; with a semicolon'), (2, 'it''s; quoted')`,
      `insert into "Odd;Name" values (3, E'escaped \\'; quote')`,
      "do $body$ begin perform 1; end $body$",
      "select 1",
    ]);
  });

  it("drops comments, blank statements and a trailing semicolon, so a file of comments holds none", () => {
    expect(sqlStatements("-- nothing here\n/* nor here */\n;;\n")).toEqual([]);
    expect(sqlStatements("select 1;\n\n;select 2;")).toEqual(["select 1", "select 2"]);
  });
});

describe("the tables a seed fills", () => {
  it("names each table once, in its schema, folded to lowercase unless quoted", () => {
    expect(
      seededTables([
        "create table if not exists public.Listings (id serial primary key)",
        "insert into Listings (title) values ('a')",
        'create unlogged table "Sales"."Orders" (id int)',
        "insert into sellers(bio) values ('b')",
        "create temp table scratch (id int)",
        "select 1",
      ]),
    ).toEqual(["public.listings", "Sales.Orders", "public.sellers", "public.scratch"]);
  });
});

describe("the E'…' prefix", () => {
  it("is an escape string only on its own: date'…' and like'…' double their quote instead", () => {
    expect(sqlStatements("select like'a\\';\nselect 1")).toEqual(["select like'a\\'", "select 1"]);
    expect(sqlStatements("select date'2024-01-01';\nselect 2")).toEqual([
      "select date'2024-01-01'",
      "select 2",
    ]);
    expect(sqlStatements("select e'a\\';b';\nselect 3")).toEqual(["select e'a\\';b'", "select 3"]);
    expect(sqlStatements("select 1, E'x\\'';select 4")).toEqual(["select 1, E'x\\''", "select 4"]);
  });
});

/** A workspace of the files given, as `--seed` reads them; nothing else is a file. */
function filesOf(files: Readonly<Record<string, string>>): Workspace {
  const missing = () => {
    throw new Error("the seed reaches the workspace for its file alone");
  };
  return {
    exists: missing,
    write: missing,
    writeParts: missing,
    hasClaudeCommand: missing,
    peek: (path) =>
      Promise.resolve(
        files[path] === undefined
          ? { kind: "none" as const }
          : { kind: "file" as const, firstLine: "" },
      ),
    async *lines(path) {
      for (const line of (files[path] ?? "").split("\n")) {
        yield line;
      }
    },
  };
}

describe("a seed holding transaction control", () => {
  it("is refused in words, since the file runs inside dev's one transaction", async () => {
    await expect(
      readSeed(filesOf({ "tx.sql": "BEGIN;\ncreate table t (id int);\nCOMMIT;\n" }), "tx.sql"),
    ).rejects.toMatchObject({
      code: "seed-transaction",
      message:
        "statement 1 of tx.sql (BEGIN) is transaction control, and the seed runs inside one transaction of facetdb dev's own",
      fix: "take BEGIN, START TRANSACTION, COMMIT, END, ROLLBACK, SAVEPOINT and their kin out of tx.sql: all of it runs as one transaction, or nothing does",
    });
    await expect(
      readSeed(
        filesOf({ "sp.sql": "select 1;\nsavepoint a;\nrollback to savepoint a;" }),
        "sp.sql",
      ),
    ).rejects.toMatchObject({
      code: "seed-transaction",
      message: expect.stringContaining("statement 2 of sp.sql (savepoint a)"),
    });
    // A `do … end` body is one statement of its own, not transaction control.
    await expect(
      readSeed(filesOf({ "ok.sql": "do $$ begin perform 1; end $$;\nselect 1;" }), "ok.sql"),
    ).resolves.toMatchObject({ statements: ["do $$ begin perform 1; end $$", "select 1"] });
  });
});
