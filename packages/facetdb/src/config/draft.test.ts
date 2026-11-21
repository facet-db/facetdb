import { describe, expect, it } from "vitest";
import { judgeDraftProject, judgeDraftSource } from "./draft.ts";
import { facetdb, noul, score } from "./dsl.ts";

/** A draft from the studio judged as the loader judges a file, inside the loaded project. */

const URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const ENV = { DATABASE_URL: URL };

const DECLARED = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: URL,
      table: "listings",
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

/** What the loader makes of `database: process.env.DATABASE_URL`: the value read, and the variable. */
const CONFIG = {
  ...DECLARED,
  sources: DECLARED.sources.map((source) => ({ ...source, databaseEnv: "DATABASE_URL" })),
};

describe("judging a draft source", () => {
  it("merges a draft over the source of its name and returns the question set the worker would run", () => {
    const judged = judgeDraftSource(
      CONFIG,
      { name: "listings", thresholds: { is_scam: { yesAbove: 0.8 } } },
      ENV,
    );

    expect(judged).toEqual({
      ok: true,
      questionSet: {
        questions: [
          { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "low" },
        ],
        read: ["title"],
        model: "jev-1.14.0",
        thresholds: { is_scam: { yesAbove: 0.8 } },
      },
      warnings: [],
      // The whole project with the draft in place, its connection's variable kept.
      config: {
        ...CONFIG,
        sources: [{ ...CONFIG.sources[0], thresholds: { is_scam: { yesAbove: 0.8 } } }],
      },
    });
  });

  it("returns the wording warnings in the CLI's shape, with the source named", () => {
    const judged = judgeDraftSource(
      CONFIG,
      {
        name: "listings",
        questions: {
          price: { type: "noul", instructions: "Is the price more than 500 euros?", stakes: "low" },
        },
      },
      ENV,
    );

    expect(judged.ok).toBe(true);
    expect(judged.ok && judged.warnings).toEqual([
      expect.objectContaining({ source: "listings", question: "price", code: "counting" }),
    ]);
  });

  it("returns the loader's errors at their field paths, refusing an alias and a threshold a type does not take", () => {
    const judged = judgeDraftSource(
      CONFIG,
      {
        name: "listings",
        model: "jev-latest",
        thresholds: { is_scam: { confidenceAtLeast: 0.6 } },
      },
      ENV,
    );

    expect(judged.ok).toBe(false);
    const paths = judged.ok ? [] : judged.issues.map((issue) => issue.path);
    expect(paths).toContain("sources[0].model");
    expect(paths.some((path) => path.startsWith("sources[0].thresholds"))).toBe(true);
    expect(judged.ok ? "" : judged.issues.map((issue) => issue.message).join(" ")).toContain(
      "jev-1.14.0",
    );
  });

  it("judges a new source as an added one, so one table is still exactly one source", () => {
    const judged = judgeDraftSource(
      CONFIG,
      {
        name: "listings_again",
        api: false,
        database: { env: "DATABASE_URL" },
        table: "listings",
        read: ["title"],
        questions: {
          urgency: {
            type: "score",
            instructions: "How urgent?",
            levels: [{ name: "low" }, { name: "high" }],
            stakes: "low",
          },
        },
      },
      ENV,
    );

    expect(judged).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: "sources[1].table" })],
    });
  });

  it("refuses a variable the config does not name in the same words whether it is set or not, never reading it", () => {
    const draft = {
      name: "listings",
      database: { env: "AWS_SECRET_ACCESS_KEY" },
      capture: "change-tracking",
    };
    const set = judgeDraftSource(CONFIG, draft, {
      ...ENV,
      AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI:K7MDENG",
    });
    const unset = judgeDraftSource(CONFIG, draft, ENV);

    expect(set).toEqual(unset);
    expect(set).toEqual({
      ok: false,
      issues: [
        {
          path: "database.env",
          message:
            "a draft reads only the connection variables facetdb.config.ts already names (DATABASE_URL); name one of those, or add the source to facetdb.config.ts",
        },
      ],
    });
    expect(JSON.stringify(set)).not.toContain("wJalrXUtnFEMI");
    // A new source naming it is refused alike.
    expect(judgeDraftSource(CONFIG, { ...draft, name: "orders" }, ENV)).toEqual(unset);
    // The variables the config names still work, as before.
    expect(
      judgeDraftSource(CONFIG, { name: "listings", database: { env: "DATABASE_URL" } }, ENV).ok,
    ).toBe(true);
  });

  it("leaves the loaded config as it was", () => {
    const before = JSON.stringify(CONFIG);
    judgeDraftSource(
      CONFIG,
      { name: "listings", questions: { u: score("How urgent?", ["low", "high"]) } },
      ENV,
    );
    expect(JSON.stringify(CONFIG)).toBe(before);
  });
});

describe("judging a project draft (Settings' spending section)", () => {
  it("places the cap and onCapReached into the project, every source as it was", () => {
    const judged = judgeDraftProject(
      CONFIG,
      { spendingCap: 2_000_000, onCapReached: "continue" },
      ENV,
    );
    expect(judged).toEqual({
      ok: true,
      config: { ...CONFIG, spendingCap: 2_000_000, onCapReached: "continue" },
    });
  });

  it("removes the cap on null, and keeps what the draft does not name", () => {
    const capped = { ...CONFIG, spendingCap: 5_000_000, onCapReached: "continue" as const };
    const removed = judgeDraftProject(capped, { spendingCap: null }, ENV);
    expect(removed.ok).toBe(true);
    expect(removed.ok && removed.config.spendingCap).toBeUndefined();
    expect(removed.ok && removed.config.onCapReached).toBe("continue");
    expect(judgeDraftProject(capped, { onCapReached: "pause" }, ENV)).toEqual({
      ok: true,
      config: { ...capped, onCapReached: "pause" },
    });
  });

  it("reads only the connection variables the file names", () => {
    const judged = judgeDraftProject(
      CONFIG,
      { spendingCap: 1000 },
      { DATABASE_URL: URL, OTHER: "elsewhere" },
    );
    expect(judged.ok && judged.config.sources[0]?.database).toBe(URL);
    expect(JSON.stringify(judged)).not.toContain("elsewhere");
  });

  it.each([
    ["model", "jev-1.14.0", "change a source's model on the Questions page"],
    ["modelUrl", "https://elsewhere.example", "where every record's state is sent"],
    ["alerts", { channels: ["slack:#ops"] }, "where the worker posts its alerts"],
    ["sources", [], "change a source with its own draft"],
    ["retries", 3, "changes only spendingCap and onCapReached"],
  ])("refuses %s in plain words, nothing judged", (key, value, words) => {
    const judged = judgeDraftProject(CONFIG, { spendingCap: 1000, [key]: value }, ENV);
    expect(judged).toEqual({
      ok: false,
      issues: [{ path: key, message: expect.stringContaining(words) }],
    });
    expect(!judged.ok && judged.issues[0]?.message).toContain("by hand");
  });

  it("refuses a cap the loader refuses, at the path spendingCap", () => {
    expect(judgeDraftProject(CONFIG, { spendingCap: 0 }, ENV)).toEqual({
      ok: false,
      issues: [{ path: "spendingCap", message: "spendingCap must be more than 0" }],
    });
    expect(judgeDraftProject(CONFIG, { spendingCap: 1.5 }, ENV)).toEqual({
      ok: false,
      issues: [
        {
          path: "spendingCap",
          message: "spendingCap must be a whole number of billable input tokens",
        },
      ],
    });
  });
});
