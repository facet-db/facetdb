import type {
  EngineDeps,
  EnginePlan,
  EngineTarget,
  PlanResult,
  QuestionSet,
  Refusal,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { recordingClient } from "../testing/index.ts";
import {
  answer,
  freshWorld,
  installedWorld,
  LISTINGS,
  LISTINGS_COLUMNS,
  listings,
  typed,
  type World,
} from "./catalog-world.ts";
import { createInstaller } from "./installer.ts";
import { KEPT_REASON } from "./prune.ts";
import { render } from "./render.ts";

/**
 * `migrate --prune` on SQL Server on a recording client: the columns of questions the set no longer
 * has go, with why, and nothing else; a choice's `_probabilities` column stays while its question
 * is asked; the worker's read of a state column `read` no longer lists is taken back; a source not
 * installed yet has nothing to prune.
 */

const ADMIN = "mssql://admin:an-admin-password@db.example.com:1433/listings";

const deps: EngineDeps = { clock: new FakeClock(0), allowInsecure: false, storeShared: false };

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

/** The listings example with a choice question beside is_scam. */
const withCategory = (storeProbabilities: boolean): EngineTarget => ({
  ...LISTINGS,
  questionSet: { ...listings, questions: [...listings.questions, choice(storeProbabilities)] },
});

async function planned(world: World, target: EngineTarget = LISTINGS, url: string = ADMIN) {
  const client = recordingClient({ answer: answer(world) });
  const result = await createInstaller({ connect: client.connect }).planPrune(target, url, deps);
  return { result, client };
}

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

function refusalOf(result: PlanResult): Refusal {
  if (result.ok) {
    throw new Error("planned, not refused");
  }
  return result.refusal;
}

describe("prune", () => {
  it("drops the columns of a question the set no longer has, with why, and nothing else", async () => {
    const plan = planOf((await planned(installedWorld(withCategory(true)))).result);
    expect(
      render(plan),
    ).toBe(`-- FacetDB runs this script as one transaction: if a statement fails, all of it rolls back and nothing is changed.
-- Run by hand (sqlcmd, SSMS), a check before each statement skips the rest once one failed; then run set noexec off.
set xact_abort on;
set ansi_nulls on;
set quoted_identifier on;
begin transaction;
go

if @@trancount = 0 set noexec on;
go

set lock_timeout 10000;
go

if @@trancount = 0 set noexec on;
go

alter table [dbo].[listings] drop column if exists [category];
go

if @@trancount = 0 set noexec on;
go

alter table [dbo].[listings] drop column if exists [category_confidence];
go

if @@trancount = 0 set noexec on;
go

alter table [dbo].[listings] drop column if exists [category_probabilities];
go

if @@trancount = 0 set noexec on;
go

commit transaction;
go
`);
    expect(plan.removes).toEqual(
      ["category", "category_confidence", "category_probabilities"].map((name) => ({
        kind: "column",
        name,
        of: "dbo.listings",
        scope: "source",
        reason: "no question asks it any more",
      })),
    );
    expect(plan).toMatchObject({ transactional: true, keeps: [], notes: [] });
    expect(plan.confirm).toBeUndefined();
    expect(new Set(plan.statements.map((statement) => statement.database))).toEqual(
      new Set(["source"]),
    );
  });

  it("keeps a choice's _probabilities column while its question is asked with storeProbabilities off", async () => {
    const plan = planOf(
      (await planned(installedWorld(withCategory(true)), withCategory(false))).result,
    );
    expect(plan.statements).toEqual([]);
    expect(plan.removes).toEqual([]);
    expect(plan.keeps).toEqual([
      {
        kind: "column",
        name: "category_probabilities",
        of: "dbo.listings",
        scope: "source",
        reason: KEPT_REASON,
      },
    ]);
    expect(KEPT_REASON).toBe("storeProbabilities is off");
  });

  it("drops a question's column of its old type as the one whose question changed type", async () => {
    const asChoice: EngineTarget = {
      ...LISTINGS,
      questionSet: {
        ...listings,
        questions: [{ ...choice(false), name: "is_scam" }],
      },
    };
    const plan = planOf((await planned(installedWorld(), asChoice)).result);
    expect(plan.removes).toEqual([
      {
        kind: "column",
        name: "is_scam_probability",
        of: "dbo.listings",
        scope: "source",
        reason: "its question changed type",
      },
    ]);
  });

  it("takes back the worker's read of a state column read no longer lists, and nothing it still reads", async () => {
    const titleOnly: EngineTarget = { ...LISTINGS, questionSet: { ...listings, read: ["title"] } };
    const plan = planOf((await planned(installedWorld(), titleOnly)).result);
    expect(plan.statements.map((statement) => statement.text)).toEqual([
      "set lock_timeout 10000",
      "revoke select ([description]) on [dbo].[listings] from [facetdb_worker]",
    ]);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual(["settings", "grants"]);
    expect(plan.removes).toEqual([
      {
        kind: "grant",
        name: "facetdb_worker",
        of: "description",
        scope: "source",
        reason: "read no longer lists it",
      },
    ]);
  });

  it("never takes back the key, a state column, FacetDB's own columns or created_at", async () => {
    const fresh = freshWorld();
    const installed = installedWorld(LISTINGS, {
      ...fresh,
      tables: {
        "dbo.listings": {
          columns: [...LISTINGS_COLUMNS, typed("created_at", "datetime2(7)")],
          key: ["id"],
        },
      },
    });
    // Reads of FacetDB's columns and of created_at, as a DBA may grant them for the connector.
    const read = (column: string) => ({
      schema: "dbo",
      object: "listings",
      column,
      permission: "SELECT",
    });
    const world: World = {
      ...installed,
      grants: [...installed.grants, read("created_at"), read("is_scam"), read("facetdb_status")],
    };
    const plan = planOf((await planned(world)).result);
    expect(plan.statements).toEqual([]);
    expect(plan.removes).toEqual([]);
  });

  it("finds nothing the second time, once the columns are gone", async () => {
    const plan = planOf((await planned(installedWorld())).result);
    expect(plan).toEqual({
      statements: [],
      transactional: true,
      removes: [],
      keeps: [],
      notes: [],
    });
    expect(render(plan)).toBe("");
  });

  it("has nothing to prune on a source not installed yet: an empty plan, not a refusal", async () => {
    for (const world of [freshWorld(), { ...freshWorld(), tables: {} }]) {
      const { result, client } = await planned(world);
      expect(planOf(result).statements).toEqual([]);
      expect(client.transactions.size).toBe(0);
      expect(client.openConnections()).toBe(0);
    }
  });

  it("refuses a table another project installed on", async () => {
    const other = installedWorld({ ...LISTINGS, project: { id: "proj_other", name: "Other" } });
    expect(refusalOf((await planned(other)).result)).toEqual({
      code: "another-project",
      message: "dbo.listings belongs to another project (proj_other); prune it from that project",
      fix: "run facetdb migrate --prune from the project that installed on the table",
    });
  });

  it("refuses a table that lost the single-column key FacetDB installed by", async () => {
    const world = installedWorld();
    const table = world.tables["dbo.listings"];
    const composite: World = {
      ...world,
      tables: {
        ...world.tables,
        "dbo.listings": { columns: table?.columns ?? [], key: ["id", "title"] },
      },
    };
    expect(refusalOf((await planned(composite)).result).code).toBe("primary-key");
  });

  it("refuses a plaintext admin connection string before connecting", async () => {
    const { result, client } = await planned(
      installedWorld(),
      LISTINGS,
      "mssql://admin:pw@db.example.com/app?encrypt=false",
    );
    expect(refusalOf(result).code).toBe("admin-url-tls");
    expect(client.connected).toEqual([]);
  });

  it("runs as printed, in one transaction", async () => {
    const plan = planOf((await planned(installedWorld(withCategory(false)))).result);
    const client = recordingClient();
    const result = await createInstaller({ connect: client.connect }).run(
      LISTINGS,
      plan,
      ADMIN,
      deps,
    );
    expect(result).toEqual({ ran: plan.statements, removed: plan.removes, notes: [] });
    expect(client.inTransaction(1).map((statement) => statement.text)).toEqual(
      plan.statements.map((statement) => statement.text),
    );
    expect(client.transactions.get(1)).toBe("committed");
  });
});
