import { BACKFILL_RUN_PREFIX, backfillRun } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { pgliteClient } from "../sql/index.ts";
import { readStoreLog, storePurgeRefusal, storePurgeStatements } from "./purge.ts";
import {
  deleteCursorsSql,
  NOT_A_RESUME_ROW,
  RESUME_RUN_PREFIXES,
  readResumeRows,
  resumeRowsStatements,
} from "./resume-rows.ts";
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
    // The source's review cards go with its log; another source's stay.
    for (const owner of [ID, other]) {
      await client.query(
        `insert into facetdb.reviews (source_id, record_key, state_hash, open_questions, numbers, since)
         values ($1, '1', 'h', '["scam"]', '{"scam": 0.5}', now())`,
        [owner],
      );
    }

    await runAll(client, storePurgeStatements(source));

    expect(await readStoreLog(client.query, ID)).toEqual({ decisions: 0, versions: 0, records: 0 });
    expect(await client.query("select id from facetdb.sources")).toEqual([]);
    expect(await client.query("select source_id from facetdb.question_set_versions")).toEqual([
      { source_id: other },
    ]);
    expect(await client.query("select source_id from facetdb.reviews")).toEqual([
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

describe("a source's resume rows in the store's cursors", () => {
  /** The keys each writer makes: core's backfill, the MongoDB stream, SQL Server Change Tracking. */
  const OWN = [
    backfillRun(PROJECT, "listings", 1, undefined),
    backfillRun(PROJECT, "listings", 3, ["spam", "category"]),
    `ct:${ID}`,
    `mongo:${ID}`,
  ];
  /** Another source of the project, another project, a project whose id holds a colon, an old key. */
  const OTHERS = [
    backfillRun(PROJECT, "orders", 1, undefined),
    backfillRun("another-project", "listings", 1, undefined),
    backfillRun(`${PROJECT}:listings`, "all", 1, undefined),
    // Project `listings-market:listings:all@v2`'s source `x`: its key begins with this source's
    // `backfill:<id>:all@v`.
    backfillRun(`${PROJECT}:listings:all@v2`, "x", 1, undefined),
    `mongo:${ID}_old`,
    "all@v1",
  ];

  it("never takes the key of a project whose id holds `:all@v`, which begins with the source's own", async () => {
    const { db } = await newStore();
    const client = pgliteClient(db);
    // Project `p` source `a`, and project `p:a:all@v2` source `x`: the pair the review named.
    const mine = backfillRun("p", "a", 2, undefined);
    const theirs = backfillRun("p:a:all@v2", "x", 1, undefined);
    expect(theirs).toBe("backfill:p:a:all@v2:x:all@v1");
    expect(theirs.startsWith(mine)).toBe(true);
    for (const run of [mine, theirs]) {
      await client.query(
        `insert into facetdb.cursors (run, cursor, done) values ($1, 'k', false)`,
        [run],
      );
    }
    expect(await readResumeRows(client.query, sourceIdOf("p", "a"))).toEqual([mine]);
    expect(deleteCursorsSql(await readResumeRows(client.query, sourceIdOf("p", "a")))).toBe(
      `delete from facetdb.cursors where run in ('${mine}');`,
    );
    await runAll(client, resumeRowsStatements(sourceIdOf("p", "a")));
    expect(await client.query("select run from facetdb.cursors")).toEqual([{ run: theirs }]);
    // And the other way round: uninstalling theirs leaves mine.
    await client.query(`insert into facetdb.cursors (run, cursor, done) values ($1, 'k', false)`, [
      mine,
    ]);
    await runAll(client, resumeRowsStatements(sourceIdOf("p:a:all@v2", "x")));
    expect(await client.query("select run from facetdb.cursors")).toEqual([{ run: mine }]);
  });

  it("reads and deletes exactly the source's rows, through a setting, as printed", async () => {
    const { db } = await newStore();
    const client = pgliteClient(db);
    for (const run of [...OWN, ...OTHERS]) {
      await client.query(
        `insert into facetdb.cursors (run, cursor, done) values ($1, 'k', false)`,
        [run],
      );
    }
    expect([...(await readResumeRows(client.query, ID))].sort()).toEqual([...OWN].sort());
    const statements = resumeRowsStatements(ID);
    expect(statements[0]).toBe(`select set_config('facetdb.resume_source', '${ID}', true)`);
    expect(statements[1]).not.toContain(ID);
    await runAll(client, statements);
    expect(
      (await client.query("select run from facetdb.cursors"))
        .map((row) => String(row["run"]))
        .sort(),
    ).toEqual([...OTHERS].sort());
    expect(await readResumeRows(client.query, ID)).toEqual([]);
    // A second run finds nothing and changes nothing.
    await runAll(client, statements);
    expect(await client.query("select count(*)::int as n from facetdb.cursors")).toEqual([
      { n: OTHERS.length },
    ]);
  });

  it("tells every resume row from an old backfill's, the only kind still unfinished for uninstall", async () => {
    const { db } = await newStore();
    const client = pgliteClient(db);
    for (const run of [...OWN, ...OTHERS]) {
      await client.query(
        `insert into facetdb.cursors (run, cursor, done) values ($1, 'k', false)`,
        [run],
      );
    }
    expect(RESUME_RUN_PREFIXES).toEqual([BACKFILL_RUN_PREFIX, "mongo:", "ct:"]);
    expect(await client.query(`select run from facetdb.cursors where ${NOT_A_RESUME_ROW}`)).toEqual(
      [{ run: "all@v1" }],
    );
  });

  it("reads a store with no cursors as none, and deletes from it as from an empty one", async () => {
    const db = await newDb();
    const client = pgliteClient(db);
    await client.query("create schema facetdb");
    expect(await readResumeRows(client.query, ID)).toEqual([]);
    await runAll(client, resumeRowsStatements(ID));
  });

  it("writes the source's id through the setting, so a quote in it is data, not SQL", () => {
    const [setting, remove] = resumeRowsStatements("it's:a'b");
    expect(setting).toBe("select set_config('facetdb.resume_source', 'it''s:a''b', true)");
    expect(remove).not.toContain("it''s");
    expect(deleteCursorsSql(["mongo:it's:a"])).toBe(
      "delete from facetdb.cursors where run in ('mongo:it''s:a');",
    );
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
