import type { QuestionSet } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import {
  ADMIN,
  deps,
  freshServer,
  installedServer,
  listings,
  planOf,
  READS,
  refusalOf,
  runToEnd,
  target,
} from "./install-world.ts";
import { planPrune } from "./prune.ts";

/**
 * `migrate --prune` on MongoDB on the recording fake: the fields under `facetdb` of questions the
 * set no longer has go with one `$unset`, and nothing else does: never a status field, never a
 * field of a question still asked; a choice's `_probabilities` field stays after
 * `storeProbabilities` went off. A collection not installed has nothing to prune.
 */

/** The listings set, the question removed and another asked instead. */
const renamed: QuestionSet = {
  ...listings,
  questions: [
    { type: "noul", name: "is_spam", instructions: "Is this listing spam?", stakes: "low" },
  ],
};

const STATUS = ["facetdb.reviewed", "facetdb.state_hash", "facetdb.status", "facetdb.updated_at"];

describe("the prune plan", () => {
  it("unsets the fields of a question the set no longer has, and nothing else", async () => {
    const server = (await installedServer()).fields("app", "listings", [
      "facetdb.is_scam",
      "facetdb.is_scam_probability",
      "facetdb.is_spam",
      ...STATUS,
    ]);
    const plan = planOf(
      await planPrune(server.connect, target({ questionSet: renamed }), ADMIN, deps),
    );
    expect(plan.statements).toEqual([
      {
        database: "source",
        purpose: "columns",
        text: 'db.getSiblingDB("app").runCommand({ update: "listings", updates: [{ q: {}, u: { $unset: { "facetdb.is_scam": "", "facetdb.is_scam_probability": "" } }, multi: true }] })',
      },
    ]);
    expect(plan.transactional).toBe(false);
    expect(plan.removes).toEqual(
      ["facetdb.is_scam", "facetdb.is_scam_probability"].map((name) => ({
        kind: "field",
        name,
        of: "app.listings",
        scope: "source",
        reason: "no question asks it any more",
      })),
    );
    expect(plan.keeps).toEqual([]);
    expect(plan.confirm).toBeUndefined();
    expect(plan.notes).toEqual([
      "Removing these fields writes every document of app.listings that has one, an update each in the oplog: on a large collection, run it when the replica set can take the load.",
    ]);
  });

  it("runs as printed, and the next prune has nothing left to do", async () => {
    const server = (await installedServer()).fields("app", "listings", [
      "facetdb.is_scam",
      "facetdb.is_scam_probability",
      "facetdb.is_spam",
      "facetdb.is_spam_probability",
      ...STATUS,
    ]);
    const on = target({ questionSet: renamed });
    const plan = planOf(await planPrune(server.connect, on, ADMIN, deps));
    const result = await runToEnd(server, plan, on);
    expect(result.removed).toEqual(plan.removes);
    expect([...(server.database("app").fields.get("listings") ?? [])].sort()).toEqual([
      "facetdb.is_spam",
      "facetdb.is_spam_probability",
      ...STATUS,
    ]);
    expect(planOf(await planPrune(server.connect, on, ADMIN, deps)).statements).toEqual([]);
  });

  it("says which fields went because their question changed type", async () => {
    const server = (await installedServer()).fields("app", "listings", [
      "facetdb.is_scam",
      "facetdb.is_scam_probability",
      ...STATUS,
    ]);
    const scored: QuestionSet = {
      ...listings,
      questions: [
        {
          type: "score",
          name: "is_scam",
          instructions: "How likely is this listing a scam?",
          stakes: "high",
          levels: [{ name: "low" }, { name: "high" }],
        },
      ],
    };
    const plan = planOf(
      await planPrune(server.connect, target({ questionSet: scored }), ADMIN, deps),
    );
    expect(plan.removes).toEqual([
      {
        kind: "field",
        name: "facetdb.is_scam_probability",
        of: "app.listings",
        scope: "source",
        reason: "its question changed type",
      },
    ]);
  });

  it("keeps a choice's probabilities after storeProbabilities went off, saying why", async () => {
    const choice: QuestionSet = {
      ...listings,
      questions: [
        {
          type: "choice",
          name: "category",
          instructions: "Which category is this listing?",
          stakes: "low",
          options: [
            { name: "car", description: "A car" },
            { name: "home", description: "A home" },
          ],
          storeProbabilities: false,
        },
      ],
    };
    const server = (await installedServer()).fields("app", "listings", [
      "facetdb.category",
      "facetdb.category_confidence",
      "facetdb.category_probabilities",
      ...STATUS,
    ]);
    const plan = planOf(
      await planPrune(server.connect, target({ questionSet: choice }), ADMIN, deps),
    );
    expect(plan.statements).toEqual([]);
    expect(plan.removes).toEqual([]);
    expect(plan.keeps).toEqual([
      {
        kind: "field",
        name: "facetdb.category_probabilities",
        of: "app.listings",
        scope: "source",
        reason: "storeProbabilities is off",
      },
    ]);
  });

  it("has nothing to prune on a collection not installed: an empty plan, not a refusal", async () => {
    const server = freshServer().fields("app", "listings", ["facetdb.old"]);
    expect(planOf(await planPrune(server.connect, target(), ADMIN, deps))).toEqual({
      statements: [],
      transactional: false,
      removes: [],
      keeps: [],
      notes: [],
    });
  });

  it("reads and changes nothing while it plans", async () => {
    const server = (await installedServer()).fields("app", "listings", ["facetdb.old"]);
    const sent = server.commands().length;
    await planPrune(server.connect, target(), ADMIN, deps);
    expect(
      server
        .commandNames()
        .slice(sent)
        .every((command) => READS.has(command.split(" ")[0] ?? "")),
    ).toBe(true);
  });

  it("refuses another project's collection under prune's code, and a server below the driver's floor", async () => {
    const server = freshServer().marker("app", "listings", "proj_other", "listings");
    expect(refusalOf(await planPrune(server.connect, target(), ADMIN, deps))).toEqual({
      code: "prune-refused",
      message:
        "app.listings already carries FacetDB from another project (proj_other); one collection belongs to one project. Uninstall there first, or point this project at another collection.",
      fix: "change the table or the config as the message says, then run the command again; nothing was changed",
    });
    const old = freshServer().fail(
      "findOne",
      new Error(
        "Server at 127.0.0.1:27017 reports maximum wire version 8, but this version of the Node.js Driver requires at least 9 (MongoDB 4.4)",
      ),
    );
    expect(refusalOf(await planPrune(old.connect, target(), ADMIN, deps)).code).toBe(
      "server-version",
    );
  });
});
