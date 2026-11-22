import type { EngineDeps, EnginePlan, EngineTarget, PlanResult } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { sourceIdOf } from "../store/index.ts";
import {
  decisionLog,
  everyType,
  freshWorld,
  install,
  LOG_ID,
  project,
  q,
  registerSource,
  resetPgliteWorld,
  SOURCE_ID,
  useUninstallWorld,
  world,
} from "../testing/index.ts";
import { createPostgresEngine } from "./engine.ts";

/**
 * A plugin source beside a table source in one store: the store holds the plugin source's
 * registration (`plugin-source`), its records, log, question-set versions, review card and cursor.
 * A table source's uninstall, with `--purge` or without, plans the same statements, string for
 * string, as it does with no plugin source in the store, names nothing of the plugin source, and
 * leaves all of it in place: a plugin source is store-held, never a table to uninstall, and its log
 * goes by no table's purge, as an API source's does not.
 */

useUninstallWorld();

const ADMIN = "postgres://admin@localhost/app";
const shared: EngineDeps = { clock: new FakeClock(0), allowInsecure: false, storeShared: true };
const engine = createPostgresEngine({
  connect: (url, options) => world.connect(url, options),
  pgHost: undefined,
});

const PLUGIN_SOURCE = "issues";
const PLUGIN_ID = sourceIdOf(project.id, PLUGIN_SOURCE);
const CURSOR_RUN = `plugin-source:${PLUGIN_ID}`;

function target(): EngineTarget {
  return {
    project,
    source: SOURCE_ID,
    table: "listings",
    schema: "public",
    storage: "inline",
    onChange: "reset",
    questionSet: everyType,
  };
}

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

async function planned(
  purge: boolean,
): Promise<{ readonly plan: EnginePlan; readonly script: string }> {
  const plan = planOf(
    await engine.planUninstall(target(), ADMIN, { ...shared, purge, alsoUninstalling: [] }),
  );
  return { plan, script: engine.render(plan) };
}

/** A plugin source of the same project, as the worker leaves it in the store after a few answers. */
async function pluginSource(): Promise<void> {
  await q(
    `insert into facetdb.sources (id, project_id, name, kind) values ($1, $2, $3, 'plugin-source')`,
    [PLUGIN_ID, project.id, PLUGIN_SOURCE],
  );
  await q(
    `insert into facetdb.records (source_id, record_key, state, hash, status)
     values ($1, 'k1', '{"title": "Typo in README"}', 'h1', 'needs_review')`,
    [PLUGIN_ID],
  );
  await decisionLog([[PLUGIN_ID, "k1"]]);
  await q(
    `insert into facetdb.question_set_versions (source_id, version, content_hash, question_set)
     values ($1, 1, 'h', '{}')`,
    [PLUGIN_ID],
  );
  await q(
    `insert into facetdb.reviews (source_id, record_key, state_hash, open_questions, numbers, since)
     values ($1, 'k1', 'h1', '[]', '{}', now())`,
    [PLUGIN_ID],
  );
  await q(`insert into facetdb.cursors (run, cursor, done) values ($1, '42', true)`, [CURSOR_RUN]);
}

/** What the store holds of the plugin source, table by table. */
async function pluginRows(): Promise<Record<string, unknown>> {
  const counted = async (table: string, column = "source_id", value = PLUGIN_ID) =>
    Number(
      (
        await q(`select count(*)::int as n from facetdb.${table} where ${column} = $1`, [value])
      )[0]?.["n"],
    );
  return {
    registration: await q(`select kind from facetdb.sources where id = $1`, [PLUGIN_ID]),
    records: await counted("records"),
    decisions: await counted("decisions"),
    versions: await counted("question_set_versions"),
    reviews: await counted("reviews"),
    cursor: await q(`select cursor, done from facetdb.cursors where run = $1`, [CURSOR_RUN]),
  };
}

const KEPT = {
  registration: [{ kind: "plugin-source" }],
  records: 1,
  decisions: 1,
  versions: 1,
  reviews: 1,
  cursor: [{ cursor: "42", done: true }],
};

describe("a table source's uninstall with a plugin source in the store", () => {
  for (const purge of [false, true]) {
    it(`plans the same statements as without it, names none of it, and leaves it whole (purge: ${purge})`, async () => {
      await freshWorld();
      await install();
      await registerSource();
      await decisionLog([[LOG_ID, "1"]]);
      const without = await planned(purge);

      await pluginSource();
      const beside = await planned(purge);

      // String for string: the table's script never depends on what a plugin source keeps.
      expect(beside.script).toBe(without.script);
      expect(beside.plan.statements).toEqual(without.plan.statements);
      for (const named of [PLUGIN_ID, "plugin-source", PLUGIN_SOURCE]) {
        expect(beside.script).not.toContain(named);
      }
      // Nothing the run removes is the plugin source's.
      expect(JSON.stringify(beside.plan.removes)).not.toContain(PLUGIN_SOURCE);

      await engine.run(target(), beside.plan, ADMIN, shared);
      expect(await pluginRows()).toEqual(KEPT);
      // The table source's own log goes with --purge only, as before.
      const own = await q(`select count(*)::int as n from facetdb.decisions where source_id = $1`, [
        LOG_ID,
      ]);
      expect(own[0]?.["n"]).toBe(purge ? 0 : 1);
      await resetPgliteWorld(world);
    });
  }

  it("a log-only purge never takes a plugin source of that name for the table's source", async () => {
    await freshWorld();
    await install();
    await pluginSource();
    // The table's source of the same name and project as the plugin source: its log is not found,
    // since a plugin source is no table's (its kind is plugin-source), and nothing is deleted.
    const plan = planOf(
      await engine.planUninstall({ ...target(), source: PLUGIN_SOURCE }, ADMIN, {
        ...shared,
        purge: true,
        alsoUninstalling: [],
      }),
    );
    // The id is the same (one project, one name), so the script names it for the table source's own
    // resume rows; it deletes no log under it, and the plugin source's cursor is no resume row.
    const script = engine.render(plan);
    expect(script).not.toContain("delete from facetdb.decisions");
    expect(script).not.toContain("plugin-source");
    expect(plan.notes.join("\n")).not.toContain("will delete");
    await engine.run({ ...target(), source: PLUGIN_SOURCE }, plan, ADMIN, shared);
    expect(await pluginRows()).toEqual(KEPT);
  });
});
