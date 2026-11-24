import type { EngineDeps, EnginePlan, EngineTarget, PlanResult, QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { type PruneResult, prune } from "../install/index.ts";
import {
  columns,
  everyType,
  freshWorld,
  install,
  project,
  q,
  SOURCE_ID,
  useUninstallWorld,
  withoutCategory,
  world,
} from "../testing/index.ts";
import { createPostgresEngine } from "./engine.ts";

/**
 * The engine's prune plans on PGlite, as install/uninstall-prune.test.ts and prune.test.ts read
 * `PruneResult`: the dropped columns with the connector's reason, the read the worker loses,
 * another role's grant that stays, the column kept while its question stays, the empty plan of a
 * source not installed yet, and the script's own refusal when a revoke took nothing.
 */

useUninstallWorld();

const ADMIN = "postgres://admin@localhost/app";
const deps: EngineDeps = { clock: new FakeClock(0), allowInsecure: false, storeShared: true };
const engine = createPostgresEngine({
  connect: (url, options) => world.connect(url, options),
  pgHost: undefined,
});
const FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";
const NOTHING: EnginePlan = {
  statements: [],
  transactional: true,
  removes: [],
  keeps: [],
  notes: [],
  // Nothing to prune locks nothing.
  locks: { listed: [] },
};

function target(questionSet: QuestionSet, overrides: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project,
    source: SOURCE_ID,
    table: "listings",
    schema: "public",
    storage: "inline",
    onChange: "reset",
    questionSet,
    ...overrides,
  };
}

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

/** Today's dry run of the same prune, from the same database. */
async function oldPrune(questionSet: QuestionSet): Promise<PruneResult & { readonly ok: true }> {
  const result = await prune({
    adminUrl: ADMIN,
    connect: world.connect,
    source: { table: "listings" },
    questionSet,
    project,
    print: () => undefined,
    dryRun: true,
  });
  if (!result.ok) {
    throw new Error(`refused: ${result.reason}`);
  }
  return result;
}

const choice = (storeProbabilities: boolean): QuestionSet["questions"][number] => ({
  type: "choice",
  name: "category",
  instructions: "Which category?",
  options: [
    { name: "car", description: "A car" },
    { name: "flat", description: "A flat" },
  ],
  stakes: "low",
  storeProbabilities,
});

/** Two state columns and a choice that stores its probabilities. */
const withProbabilities: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Scam?", stakes: "low" },
    choice(true),
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};
/** The same, reading the title alone, the choice no longer storing its probabilities. */
const titleOnlyNoProbabilities: QuestionSet = {
  ...withProbabilities,
  questions: [withProbabilities.questions[0] as QuestionSet["questions"][number], choice(false)],
  read: ["title"],
};

describe("planPrune, as `PruneResult` read it", () => {
  it("drops the columns of a removed question with the connector's reason, and a second plan is empty", async () => {
    await freshWorld();
    await install();
    const old = await oldPrune(withoutCategory);
    const plan = planOf(await engine.planPrune(target(withoutCategory), ADMIN, deps));
    expect(engine.render(plan)).toBe(old.sql);
    const gone = ["category", "category_confidence", "category_probabilities"];
    // The worker held a column select on each answer column, so today's prune revokes those too.
    expect(old).toMatchObject({ dropped: gone.map((column) => ({ column })), revoked: gone });
    expect(plan.removes).toEqual([
      ...old.dropped.map(({ column, reason }) => ({
        kind: "column",
        name: column,
        of: "public.listings",
        scope: "source",
        reason,
      })),
      ...old.revoked.map((column) => ({
        kind: "grant",
        name: "facetdb_worker",
        of: column,
        scope: "source",
        reason: "read no longer lists it",
      })),
    ]);
    expect(
      plan.removes
        .filter((object) => object.kind === "column")
        .every((object) => object.reason === "no question asks it any more"),
    ).toBe(true);
    expect(plan).toMatchObject({ keeps: [], notes: [], transactional: true });
    expect(plan.confirm).toBeUndefined();

    expect(await engine.run(target(withoutCategory), plan, ADMIN, deps)).toEqual({
      ran: plan.statements,
      removed: plan.removes,
      notes: [],
    });
    expect(await columns()).not.toContain("category");
    expect(planOf(await engine.planPrune(target(withoutCategory), ADMIN, deps))).toEqual(NOTHING);
  });

  it("revokes a read `read` no longer lists, names the column kept while its question stays", async () => {
    await freshWorld();
    await install({ table: "listings" }, withProbabilities);
    const old = await oldPrune(titleOnlyNoProbabilities);
    const plan = planOf(await engine.planPrune(target(titleOnlyNoProbabilities), ADMIN, deps));
    expect(engine.render(plan)).toBe(old.sql);
    expect(old).toMatchObject({
      dropped: [],
      revoked: ["description"],
      kept: ["category_probabilities: kept (storeProbabilities is off)"],
    });
    expect(plan.removes).toEqual([
      {
        kind: "grant",
        name: "facetdb_worker",
        of: "description",
        scope: "source",
        reason: "read no longer lists it",
      },
    ]);
    expect(plan.keeps).toEqual([
      {
        kind: "column",
        name: "category_probabilities",
        of: "public.listings",
        scope: "source",
        reason: "storeProbabilities is off",
      },
    ]);
    expect(plan.notes).toEqual([]);
  });

  it("names another role's grant that stays, in the revoke's words and in a note", async () => {
    await freshWorld();
    await install({ table: "listings" }, withProbabilities);
    await q(`create role table_dba`);
    await q(`grant select (description) on public.listings to table_dba with grant option`);
    await q(`set role table_dba`);
    try {
      await q(`grant select (description) on public.listings to facetdb_worker`);
    } finally {
      await q(`reset role`);
    }
    const old = await oldPrune(titleOnlyNoProbabilities);
    const plan = planOf(await engine.planPrune(target(titleOnlyNoProbabilities), ADMIN, deps));
    expect(old.foreignGrants).toEqual([{ column: "description", grantor: "table_dba" }]);
    expect(plan.removes).toEqual([
      {
        kind: "grant",
        name: "facetdb_worker",
        of: "description",
        scope: "source",
        reason: "a grant by table_dba remains, see note",
      },
    ]);
    expect(plan.notes).toEqual(old.notes);
    expect(plan.notes).toEqual([
      "description: a grant by table_dba remains; only that role can revoke it",
    ]);
  });

  it("has nothing to prune on a source not installed yet, and refuses another project's table", async () => {
    await freshWorld(["listings", "orders"]);
    expect(await engine.planPrune(target(withoutCategory), ADMIN, deps)).toEqual({
      ok: true,
      plan: NOTHING,
    });
    await install();
    expect(
      await engine.planPrune(target(withoutCategory, { table: "orders" }), ADMIN, deps),
    ).toEqual({ ok: true, plan: NOTHING });
    expect(
      await engine.planPrune(target(withoutCategory, { table: "missing" }), ADMIN, deps),
    ).toEqual({ ok: true, plan: NOTHING });
    expect(
      await engine.planPrune(
        target(withoutCategory, { project: { id: "proj_other", name: "Other" } }),
        ADMIN,
        deps,
      ),
    ).toEqual({
      ok: false,
      refusal: {
        code: "prune-refused",
        message: `public.listings belongs to another project (${project.id}); prune it from that project.`,
        fix: FIX,
      },
    });
    expect(await columns()).toEqual(expect.arrayContaining(everyType.questions.map((x) => x.name)));
  });

  it("stops with the script's own refusal when its revoke took nothing back", async () => {
    await freshWorld();
    await install({ table: "listings" }, withProbabilities);
    const plan = planOf(await engine.planPrune(target(titleOnlyNoProbabilities), ADMIN, deps));
    // An admin who may read the table but does not own it: Postgres runs its revoke with a
    // warning and takes back nothing, and the script's check stops the whole transaction.
    await q(`create role other_admin`);
    await q(`grant select on public.listings to other_admin`);
    await q(`set role other_admin`);
    let result: Awaited<ReturnType<typeof engine.run>>;
    try {
      result = await engine.run(target(titleOnlyNoProbabilities), plan, ADMIN, deps);
    } finally {
      await q(`reset role`);
    }
    expect(result).toEqual({
      ran: [],
      stopped: {
        at: plan.statements.findIndex((statement) =>
          statement.text.includes("the worker login still reads %s after the revoke"),
        ),
        refusal: {
          code: "prune-refused",
          message:
            "public.listings: the worker login still reads description after the revoke; Postgres takes back only grants made by the role that runs it, and install's grants are the table owner's. Run migrate --prune as the table's owner or a member of its role; nothing was changed.",
          fix: FIX,
        },
      },
      removed: [],
      notes: [],
    });
  });
});
