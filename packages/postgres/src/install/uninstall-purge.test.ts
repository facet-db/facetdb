import { describe, expect, it } from "vitest";
import { sourceIdOf } from "../store/index.ts";
import {
  APP_COLUMNS,
  columns,
  count,
  decisionLog,
  everyType,
  freshWorld,
  install,
  LOG_ID,
  logOf,
  pollingInstallSql,
  project,
  q,
  recording,
  registerSource,
  runUninstall,
  SOURCE_ID,
  snapshot,
  useUninstallWorld,
  world,
} from "../testing/index.ts";
import { type ProjectRef, renderSql } from "./sql.ts";
import { uninstall } from "./uninstall.ts";

/**
 * `uninstall --purge` on PGlite: which decision log a purge deletes, found by the source's id, and
 * never another's. These statements destroy data on purpose, so every test reads the catalog before
 * and after. The plain uninstall is uninstall.test.ts.
 */

useUninstallWorld();

describe("uninstall --purge is tied to the table it uninstalls", () => {
  async function purgeWith(sourceId: string, options: { readonly dryRun?: boolean } = {}) {
    const printed: string[] = [];
    const result = await uninstall({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "listings", name: sourceId, projectId: project.id },
      purge: true,
      ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
      print: (sql) => printed.push(sql),
      confirm: async () => "Listings",
    });
    return { result, printed };
  }

  const logRows = async () =>
    q(`select source_id, record_key from facetdb.decisions order by 1, 2`);

  it("a made-up id deletes nothing, and the output says so", async () => {
    await freshWorld();
    await install();
    await decisionLog([
      [LOG_ID, "1"],
      ["src_other", "7"],
    ]);
    const { result } = await purgeWith("src_made_up");
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.notes).toContain(
      `purge: no decisions were ever logged for source "src_made_up", nothing to purge.`,
    );
    expect(await logRows()).toEqual([
      { source_id: LOG_ID, record_key: "1" },
      { source_id: "src_other", record_key: "7" },
    ]);
    // The table itself is uninstalled all the same.
    expect(await columns()).toEqual(APP_COLUMNS);
  });

  it("another source's id is not deleted through this table, even one that exists in the log", async () => {
    await freshWorld();
    await install();
    await decisionLog([["src_other", "7"]]);
    const { result } = await purgeWith("src_other");
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "7" }]);
  });

  const API_ID = logOf("prod_listings");

  it.each(["prod_listings", API_ID])(
    "a live API source of the same project is not purged through this table, named by %s",
    async (given) => {
      await freshWorld();
      await install();
      await q(
        `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, 'prod_listings', 'api')`,
        [API_ID, project.id],
      );
      await q(
        `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ($1, 1, 'h', '{}')`,
        [API_ID],
      );
      await decisionLog([
        [API_ID, "1"],
        [API_ID, "2"],
        [LOG_ID, "3"],
      ]);
      const { result } = await purgeWith(given);
      expect(result).toMatchObject({ ok: true, applied: true });
      // The API source's name keys log rows (they are not this table's); its id, taken for a name, none.
      expect(result.ok && result.notes.join("\n")).toContain(
        given === "prod_listings"
          ? `no source named "prod_listings" belongs to this table or its project, so no decision was deleted`
          : `no decisions were ever logged for source "${API_ID}", nothing to purge`,
      );
      expect(await logRows()).toEqual([
        { source_id: LOG_ID, record_key: "3" },
        { source_id: API_ID, record_key: "1" },
        { source_id: API_ID, record_key: "2" },
      ]);
      expect(await count(`select 1 from facetdb.question_set_versions`)).toBe(1);
    },
  );

  it("does not purge a live store source (one holding records) of the source's name", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await q(
      `insert into facetdb.records (source_id, record_key, state, hash, status) values ($1, 'r1', '{}', 'h', 'queued')`,
      [LOG_ID],
    );
    await decisionLog([[LOG_ID, "1"]]);
    const { result } = await purgeWith(SOURCE_ID);
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(result.ok && result.notes.join("\n")).toContain("so no decision was deleted");
    expect(await logRows()).toEqual([{ source_id: LOG_ID, record_key: "1" }]);
  });

  it("does not take a store source of another project for this table's", async () => {
    await freshWorld();
    await install();
    await q(`insert into facetdb.projects (id, name) values ('proj_x', 'X')`);
    await q(
      `insert into facetdb.sources (id, project_id, name, kind) values ($1, 'proj_x', 'xs', 'plugin')`,
      [sourceIdOf("proj_x", "xs")],
    );
    await decisionLog([[sourceIdOf("proj_x", "xs"), "1"]]);
    const { result } = await purgeWith("xs");
    expect(result).toMatchObject({ ok: true, applied: true });
    expect(await logRows()).toEqual([{ source_id: sourceIdOf("proj_x", "xs"), record_key: "1" }]);
  });

  it("a dry run says what the purge will delete and deletes nothing", async () => {
    await freshWorld();
    await install();
    await registerSource();
    await decisionLog([[LOG_ID, "1"]]);
    const { result } = await purgeWith(SOURCE_ID, { dryRun: true });
    expect(result).toMatchObject({ ok: true, applied: false });
    expect(result.ok && result.notes.join("\n")).toContain(
      `will delete 1 decision(s) and 0 question-set version(s) of source "${SOURCE_ID}"`,
    );
    expect(await logRows()).toHaveLength(1);
  });

  describe("after an uninstall without purge (the owner row is gone)", () => {
    it("a log-only purge deletes the matching source's log and says what it deleted", async () => {
      await freshWorld();
      await install();
      await registerSource();
      await decisionLog([
        [LOG_ID, "1"],
        [LOG_ID, "2"],
        ["src_other", "7"],
      ]);
      expect((await runUninstall()).result).toMatchObject({ ok: true, applied: true });
      expect(await runUninstall({ purge: true, typed: "listings" })).toMatchObject({
        result: { ok: true },
      });
      // Not installed any more, so the second run was the log-only purge.
      expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "7" }]);
    });

    it("prints a script that only touches the log, asks for the source's name, and reports the count", async () => {
      await freshWorld();
      await install();
      await registerSource();
      await decisionLog([
        [LOG_ID, "1"],
        ["src_other", "7"],
      ]);
      await runUninstall();
      const { connect, executed } = recording();
      const asked: string[] = [];
      const printed: string[] = [];
      const result = await uninstall({
        adminUrl: "postgres://admin@unused/app",
        connect,
        source: { table: "listings", name: SOURCE_ID, projectId: project.id },
        purge: true,
        print: (sql) => printed.push(sql),
        confirm: async ({ project: asking }) => {
          asked.push(asking.name);
          return "listings";
        },
      });
      expect(asked).toEqual(["listings"]);
      expect(result).toMatchObject({ ok: true, applied: true });
      expect(result.ok && result.notes).toEqual([
        "public.listings has no FacetDB install left; only the decision log was purged.",
        `purge: deleted 1 decision(s) and 0 question-set version(s) of source "${SOURCE_ID}".`,
      ]);
      expect(printed).toEqual([renderSql(executed)]);
      // Nothing of the table's: what it may drop besides the log is the store's, once unused.
      expect(printed[0]).not.toMatch(
        /alter table|drop trigger|drop column|delete from "facetdb"\."jobs"|listings_answers/,
      );
      expect(await columns()).toEqual(APP_COLUMNS);
      expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "7" }]);
    });

    it("a made-up name refuses and changes nothing; a wrong confirmation runs nothing", async () => {
      await freshWorld();
      await install();
      await registerSource();
      await decisionLog([[LOG_ID, "1"]]);
      await runUninstall();
      const before = await snapshot();

      const { connect, executed } = recording();
      const madeUp = await runUninstall({ purge: true, connect, sourceId: "nope" });
      expect(madeUp.result).toMatchObject({ ok: false });
      expect(madeUp.events).toEqual([]);
      const wrong = await runUninstall({ purge: true, connect, typed: "other" });
      expect(wrong.result).toMatchObject({ ok: false });
      expect(wrong.events).toEqual(["print", "confirm listings"]);
      expect(executed).toEqual([]);
      expect(await snapshot()).toEqual(before);
    });

    it("never reaches the log of a source that is still live (a typo'd table, a store source)", async () => {
      await freshWorld(["listings", "listing"]);
      await install();
      await registerSource();
      await decisionLog([[LOG_ID, "1"]]);
      // `listing` has no owner row; the live `listings` source carries the log. The store does not
      // record which table a source reads, so any installed table of its project makes it
      // possibly live.
      const typo = await runUninstall({ purge: true, table: "listing", sourceId: "listings" });
      expect(typo.result).toMatchObject({ ok: false });
      expect(typo.result.ok === false && typo.result.reason).toBe(
        `the decision log of source "listings" may be shared with public.listings (project ${project.id}), which is still installed; uninstall that table first, or keep the log. Nothing was changed.`,
      );
      expect(typo.events).toEqual([]);
      expect(await logRows()).toEqual([{ source_id: LOG_ID, record_key: "1" }]);

      // A store source (plugin or API) of that name is live too, whatever the table argument.
      await q(
        `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, 'listing', 'api')`,
        [logOf("listing"), project.id],
      );
      await decisionLog([[logOf("listing"), "9"]]);
      const live = await runUninstall({ purge: true, table: "listing", sourceId: "listing" });
      expect(live.result).toMatchObject({ ok: false });
      expect(await logRows()).toHaveLength(2);
    });

    it("without purge the table stays refused", async () => {
      await freshWorld();
      await install();
      await runUninstall();
      const { result } = await runUninstall();
      expect(result).toMatchObject({ ok: false });
      expect(result.ok === false && result.reason).toContain("facetdb.table_owners has no row");
    });

    it("the schema goes with the last log row", async () => {
      await freshWorld();
      await install();
      await registerSource();
      await decisionLog([[LOG_ID, "1"]]);
      await runUninstall();
      const { result } = await runUninstall({ purge: true, typed: "listings" });
      expect(result).toMatchObject({ ok: true, applied: true });
      expect((await q(`select to_regnamespace('facetdb') is null as gone`))[0]?.["gone"]).toBe(
        true,
      );
    });
  });
});

describe("uninstall --purge finds the log by the source's id", () => {
  const logRows = async () =>
    q(`select source_id, record_key from facetdb.decisions order by 1, 2`);

  async function versions(sourceId: string): Promise<void> {
    await q(
      `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set) values ($1, 1, 'h', '{}')`,
      [sourceId],
    );
  }

  it.each(["t_listings", "listings_renamed"])(
    "a purge of source %s on table listings deletes exactly that source's log",
    async (name) => {
      const renamed = name === "listings_renamed";
      await freshWorld();
      await install();
      await registerSource(name);
      if (renamed) {
        // The source was `listings` before the rename: the worker registered that row then, and
        // registers the new name after; the old log stays under the old id.
        await registerSource(SOURCE_ID);
      }
      await versions(logOf(name));
      await versions("src_other");
      await decisionLog([
        [logOf(name), "1"],
        [logOf(name), "2"],
        [LOG_ID, "3"],
        ["src_other", "4"],
      ]);
      const { connect, executed } = recording();
      const { result, printed } = await runUninstall({ purge: true, sourceId: name, connect });
      expect(result).toMatchObject({ ok: true, applied: true });
      expect(result.ok && result.plan.log).toEqual({
        status: "found",
        given: name,
        sourceId: logOf(name),
        decisions: 2,
        versions: 1,
      });
      expect(result.ok && result.notes).toContain(
        `purge: deleted 2 decision(s) and 1 question-set version(s) of source "${name}".`,
      );
      expect(result.ok && result.plan.otherSourceLogs).toEqual(
        renamed ? [{ source: SOURCE_ID, decisions: 1 }] : [],
      );
      const oldName = `left in place: the decision log of source "${SOURCE_ID}" (1 decision(s)), another source of this project in the FacetDB store; if it was this table's source under an earlier name, delete it with: facetdb uninstall --purge --source ${SOURCE_ID}`;
      expect(result.ok && result.notes.includes(oldName)).toBe(renamed);
      expect(await logRows()).toEqual([
        { source_id: LOG_ID, record_key: "3" },
        { source_id: "src_other", record_key: "4" },
      ]);
      expect(await q(`select source_id from facetdb.question_set_versions`)).toEqual([
        { source_id: "src_other" },
      ]);
      expect(printed).toEqual([renderSql(executed)]);
      expect(printed[0]).not.toContain("source_id = ''");
      if (renamed) {
        // The note's command: the old name's log, now that no table is installed.
        const old = await runUninstall({ purge: true, sourceId: SOURCE_ID, typed: SOURCE_ID });
        expect(old.result).toMatchObject({ ok: true, applied: true, plan: { mode: "log-only" } });
        expect(await logRows()).toEqual([{ source_id: "src_other", record_key: "4" }]);
      }
    },
  );

  it("an unresolved purge prints no delete, says why and names the sources it found", async () => {
    await freshWorld();
    await install();
    await registerSource("orders_src");
    await registerSource("t_listings");
    // Rows under the given name that no registration of the project claims: never purged here.
    await decisionLog([
      [logOf("t_listings"), "1"],
      [logOf("nope"), "2"],
    ]);
    for (const dryRun of [true, false]) {
      const { result, printed } = await runUninstall({ purge: true, sourceId: "nope", dryRun });
      expect(result).toMatchObject({ ok: true, applied: !dryRun });
      expect(result.ok && result.plan.log).toEqual({
        status: "not-found",
        given: "nope",
        found: ["orders_src", "t_listings"],
        logged: 1,
      });
      expect(result.ok && result.notes.join("\n")).toContain(
        `no source named "nope" belongs to this table or its project, so no decision was deleted (the script has no delete of the log). The project's sources in the FacetDB store: orders_src, t_listings.`,
      );
      expect(printed[0]).not.toContain("delete from facetdb.decisions");
      expect(printed[0]).not.toContain("source_id = ''");
      expect(printed[0]).not.toContain("facetdb.uninstall_source");
    }
    expect(await logRows()).toEqual([
      { source_id: logOf("nope"), record_key: "2" },
      { source_id: logOf("t_listings"), record_key: "1" },
    ]);
  });

  it("a plain uninstall names the log it leaves and the command that purges it later", async () => {
    await freshWorld();
    await install();
    await registerSource("t_listings");
    await decisionLog([[logOf("t_listings"), "1"]]);
    const { result } = await runUninstall({ sourceId: "t_listings" });
    expect(result).toMatchObject({ ok: true, applied: true });
    const command = "facetdb uninstall --purge --source t_listings";
    expect(result.ok && result.plan).toMatchObject({
      mode: "table",
      confirmName: "Listings",
      purge: false,
      logTablesDropped: false,
      log: { status: "found", sourceId: logOf("t_listings"), decisions: 1, versions: 0 },
      logOnlyPurge: { source: "t_listings", command },
      // The source's registration keeps the store in use until the log is purged.
      projectKeptBy: ["store-in-use"],
      sharedTablesDropped: false,
    });
    expect(result.ok && result.notes).toEqual([
      `the decision log of source "t_listings" stays (1 decision(s), 0 question-set version(s)); to delete it later: ${command}`,
    ]);

    const later = await runUninstall({ purge: true, sourceId: "t_listings", typed: "t_listings" });
    expect(later.result).toMatchObject({ ok: true, applied: true, plan: { mode: "log-only" } });
    expect(later.result.ok && later.result.plan).toMatchObject({
      confirmName: "t_listings",
      log: { status: "found", sourceId: logOf("t_listings"), decisions: 1 },
      logTablesDropped: true,
      projectKeptBy: [],
      sharedTablesDropped: true,
    });
    // The log went with its last row, and nothing is left using the store: the project, the shared
    // tables and the schema go too.
    expect((await q(`select to_regnamespace('facetdb') is null as gone`))[0]?.["gone"]).toBe(true);
  });

  describe("two projects whose sources share a name keep two logs", () => {
    const bee: ProjectRef = { id: "proj_b", name: "Bee" };
    const BEE_LOG = sourceIdOf(bee.id, SOURCE_ID);

    /**
     * A on public.listings, B on staging.listings, both sources named `listings`: the worker
     * registers each under `<project>:listings`, so each writes its own log.
     */
    async function twoProjects() {
      await freshWorld(["listings", "orders"]);
      await q(`create schema staging`);
      await q(
        `create table staging.listings (id serial primary key, title text, description text, secret text)`,
      );
      await install();
      await install({ table: "listings", schema: "staging" }, everyType, bee);
      await registerSource(SOURCE_ID, project.id);
      await registerSource(SOURCE_ID, bee.id);
      await versions(LOG_ID);
      await versions(BEE_LOG);
      await decisionLog([
        [LOG_ID, "a1"],
        [BEE_LOG, "b1"],
        ["src_other", "7"],
      ]);
    }

    const beeColumns = async () =>
      (
        await q(
          `select column_name from information_schema.columns where table_schema = 'staging' and table_name = 'listings' order by ordinal_position`,
        )
      ).map((row) => String(row["column_name"]));

    const versionRows = async () =>
      q(`select source_id from facetdb.question_set_versions order by 1`);

    it("A's purge with B installed in the same database runs and deletes only A's rows", async () => {
      await twoProjects();
      const before = await beeColumns();
      expect(before).toContain("is_scam");
      // Each source's review cards; A's go with A's log.
      for (const owner of [LOG_ID, BEE_LOG]) {
        await q(
          `insert into facetdb.reviews (source_id, record_key, state_hash, open_questions, numbers, since)
           values ($1, '1', 'h', '["is_scam"]', '{"is_scam": 0.5}', now())`,
          [owner],
        );
      }
      const { result, events } = await runUninstall({ purge: true });
      expect(result).toMatchObject({ ok: true, applied: true });
      expect(events).toEqual(["print", "confirm Listings"]);
      expect(result.ok && result.plan.log).toEqual({
        status: "found",
        given: SOURCE_ID,
        sourceId: LOG_ID,
        decisions: 1,
        versions: 1,
      });
      expect(await logRows()).toEqual([
        { source_id: BEE_LOG, record_key: "b1" },
        { source_id: "src_other", record_key: "7" },
      ]);
      expect(await versionRows()).toEqual([{ source_id: BEE_LOG }]);
      expect(await q(`select id from facetdb.sources order by 1`)).toEqual([{ id: BEE_LOG }]);
      expect(await q(`select source_id from facetdb.reviews order by 1`)).toEqual([
        { source_id: BEE_LOG },
      ]);
      // B's table and its install are untouched.
      expect(await beeColumns()).toEqual(before);
      expect(
        await count(
          `select 1 from facetdb.table_owners where table_schema = 'staging' and project_id = 'proj_b'`,
        ),
      ).toBe(1);
    });

    it("a log-only purge of A after A's plain uninstall, with B installed, deletes only A's log", async () => {
      await twoProjects();
      const plain = await runUninstall();
      expect(plain.result).toMatchObject({ ok: true, applied: true });
      // B is another project's table: it never holds A's log, so the later purge is offered.
      expect(plain.result.ok && plain.result.plan.logOnlyPurge).toEqual({
        source: SOURCE_ID,
        command: `facetdb uninstall --purge --source ${SOURCE_ID}`,
      });
      const { result, events } = await runUninstall({ purge: true, typed: SOURCE_ID });
      expect(result).toMatchObject({ ok: true, applied: true, plan: { mode: "log-only" } });
      expect(events).toEqual(["print", `confirm ${SOURCE_ID}`]);
      expect(await logRows()).toEqual([
        { source_id: BEE_LOG, record_key: "b1" },
        { source_id: "src_other", record_key: "7" },
      ]);
      expect(await versionRows()).toEqual([{ source_id: BEE_LOG }]);
      expect(await beeColumns()).toContain("is_scam");
    });

    it("a plain uninstall of A with another table of A installed says the log waits for it", async () => {
      await twoProjects();
      await install({ table: "orders" });
      const plain = await runUninstall({ dryRun: true });
      expect(plain.result.ok && plain.result.plan.logOnlyPurge).toBeUndefined();
      expect(plain.result.ok && plain.result.notes).toContain(
        `the decision log of source "${SOURCE_ID}" stays (1 decision(s), 1 question-set version(s)); it can be purged once no other table of its project is installed in this database (facetdb uninstall --purge --source ${SOURCE_ID}).`,
      );
    });

    it("re-checks inside the transaction: another table of A installed after the checks stops A's log-only purge", async () => {
      await twoProjects();
      expect((await runUninstall()).result).toMatchObject({ ok: true, applied: true });
      const result = await uninstall({
        adminUrl: "postgres://admin@unused/app",
        connect: world.connect,
        source: { table: "listings", name: SOURCE_ID, projectId: project.id },
        purge: true,
        print: () => undefined,
        confirm: async () => {
          await install({ table: "orders" });
          return SOURCE_ID;
        },
      });
      expect(result).toEqual({
        ok: false,
        reason: `the decision log of source "${SOURCE_ID}" may be shared with public.orders (project ${project.id}), which is still installed; uninstall that table first, or keep the log. Nothing was changed.`,
      });
      expect(await logRows()).toEqual([
        { source_id: BEE_LOG, record_key: "b1" },
        { source_id: LOG_ID, record_key: "a1" },
        { source_id: "src_other", record_key: "7" },
      ]);
    });
  });

  it("refuses --purge on a polling-mode table (no owner row) with the plain refusal", async () => {
    await freshWorld(["listings", "orders"]);
    await install({ table: "orders" }, everyType, { id: "proj_orders", name: "Orders" });
    // A polling-mode source: FacetDB's marked columns on the table, no trigger, no owner row.
    for (const statement of pollingInstallSql({ table: "listings", key: "id" }, everyType)) {
      await q(statement);
    }
    await q(`insert into facetdb.projects (id, name) values ('proj_polling', 'Polling')`);
    await registerSource(SOURCE_ID, "proj_polling");
    await decisionLog([[sourceIdOf("proj_polling", SOURCE_ID), "1"]]);
    const before = await snapshot();
    const { result, events } = await runUninstall({ purge: true });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain("facetdb.table_owners has no row");
    expect(result.ok === false && result.reason).not.toContain("only the decision log");
    expect(events).toEqual([]);
    expect(await snapshot()).toEqual(before);
  });

  it("re-checks inside the transaction: an install that lands after the checks is never purged", async () => {
    await freshWorld();
    await install();
    await registerSource("t_listings");
    await decisionLog([[logOf("t_listings"), "1"]]);
    await runUninstall({ sourceId: "t_listings" });

    const result = await uninstall({
      adminUrl: "postgres://admin@unused/app",
      connect: world.connect,
      source: { table: "listings", name: "t_listings", projectId: project.id },
      purge: true,
      print: () => undefined,
      // Between the checks and the transaction, the table is installed again for its project.
      confirm: async () => {
        await install();
        return "t_listings";
      },
    });
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.reason).toContain(
      `the decision log of source "${logOf("t_listings")}" is live again: public.listings is now installed for its project; nothing was changed`,
    );
    expect(await logRows()).toEqual([{ source_id: logOf("t_listings"), record_key: "1" }]);
    expect(await columns()).toContain("is_scam");
  });
});
