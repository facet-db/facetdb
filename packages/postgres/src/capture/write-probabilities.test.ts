import { type ChoiceQuestion, decide, humanDecision, resolveThresholds } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { installSql } from "../install/index.ts";
import { newWorld, recordingConnector, useCaptureWorld, type World } from "./capture-world.ts";

/**
 * On PGlite: what the contract case (capture-contract.test.ts) does not check on Postgres. The
 * column is `jsonb` and holds an object keyed by the question's option names, every option there
 * with the number the model gave; inline it sits on the record, in side-table mode on the side row
 * (the source table has no such column); a question without `storeProbabilities` has no column and
 * the write names none. PGlite applies no driver serializer and runs as a superuser, so the worker
 * login and postgres.js's jsonb binding are write-probabilities.db.test.ts's.
 */

useCaptureWorld();

const team: ChoiceQuestion = {
  type: "choice",
  name: "team",
  instructions: "Which team should handle this?",
  options: [
    { name: "sales.emea", description: "Sales in Europe" },
    { name: `O'Brien "ops"`, description: "Operations" },
    { name: "équipe ✓", description: "International" },
    { name: "__proto__", description: "A name that is a JavaScript accessor" },
  ],
  stakes: "low",
  storeProbabilities: true,
};

// Confidence (0.7 - 1/4) / (1 - 1/4) = 0.6: decided at the low-stakes 0.50. Numbers a float prints
// with many digits and a tiny one, to show they come back as the model gave them.
const probabilities = [0.7, 0.29999989, 1e-7, 0];
const keyed = Object.fromEntries([
  ["sales.emea", 0.7],
  [`O'Brien "ops"`, 0.29999989],
  ["équipe ✓", 1e-7],
  ["__proto__", 0],
]);
const answer = {
  type: "choice",
  top: "sales.emea",
  probabilities,
  options: team.options.map((option) => option.name),
} as const;

async function written(world: World, relation: string) {
  const rows = await world.pg.client.query(
    `select team_probabilities as stored, jsonb_typeof(team_probabilities) as kind,
            team_confidence as confidence from ${relation} where id = 'r1'`,
  );
  return rows[0];
}

async function columnType(world: World, schema: string, table: string, column: string) {
  const rows = await world.pg.client.query(
    `select data_type from information_schema.columns
      where table_schema = $1 and table_name = $2 and column_name = $3`,
    [schema, table, column],
  );
  return rows[0]?.["data_type"] ?? null;
}

for (const storage of ["inline", "side-table"] as const) {
  const relation = storage === "inline" ? "public.listings" : "facetdb.listings_answers";
  describe(`a choice's _probabilities on Postgres (${storage})`, () => {
    it("is a jsonb object keyed by option name, every option with the model's number", async () => {
      const world = await newWorld(storage, "keep", { questions: [team] });
      const connector = world.connector();
      await connector.install();
      await world.edit("r1", { title: "a", body: "b" });
      const [row] = (await connector.read(["r1"])).rows;
      const decision = decide(team, resolveThresholds(team, undefined), answer);

      const result = await connector.write(
        "r1",
        { decisions: { team: decision }, status: "done" },
        row?.hash ?? "",
      );

      expect(result).toEqual({ written: true });
      const stored = await written(world, relation);
      expect(stored?.["kind"]).toBe("object");
      expect(stored?.["stored"]).toEqual(keyed);
      expect(Object.keys(stored?.["stored"] as object).sort()).toEqual(Object.keys(keyed).sort());
      expect(stored?.["confidence"]).toBeCloseTo(0.6, 6);
      expect(await columnType(world, "facetdb", "listings_answers", "team_probabilities")).toBe(
        storage === "side-table" ? "jsonb" : null,
      );
      expect(await columnType(world, "public", "listings", "team_probabilities")).toBe(
        storage === "inline" ? "jsonb" : null,
      );
    });

    it("keeps the model's list under a person's value, and goes NULL with _confidence in review", async () => {
      const world = await newWorld(storage, "keep", { questions: [team] });
      const connector = world.connector();
      await connector.install();
      await world.edit("r1", { title: "a", body: "b" });
      const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";

      await connector.write(
        "r1",
        { decisions: { team: { kind: "needs_review" } }, status: "needs_review" },
        hash,
      );
      expect(await written(world, relation)).toMatchObject({ stored: null, confidence: null });

      const byPerson = humanDecision(team, "équipe ✓", answer);
      await connector.write(
        "r1",
        { decisions: { team: byPerson }, status: "done", reviewed: true },
        hash,
      );
      expect((await written(world, relation))?.["stored"]).toEqual(keyed);
    });
  });
}

describe("a choice without storeProbabilities", () => {
  it("has no _probabilities column, and the write names none", async () => {
    const plain: ChoiceQuestion = { ...team, storeProbabilities: false };
    const world = await newWorld("inline", "keep", { questions: [plain] });
    const { connector, statements } = recordingConnector(world);
    await connector.install();
    await world.edit("r1", { title: "a", body: "b" });
    const hash = (await connector.read(["r1"])).rows[0]?.hash ?? "";
    const decision = decide(plain, resolveThresholds(plain, undefined), answer);

    expect(
      await connector.write("r1", { decisions: { team: decision }, status: "done" }, hash),
    ).toEqual({ written: true });

    expect(await columnType(world, "public", "listings", "team_probabilities")).toBeNull();
    const update = statements.find((text) => text.startsWith("update"));
    expect(update).toContain('"team_confidence"');
    expect(update).not.toContain("_probabilities");
  });
});

describe("the worker login may write the column", () => {
  it("is granted update on it inline, and on the side table in side-table mode", () => {
    for (const storage of ["inline", "side-table"] as const) {
      const statements = installSql(
        { table: "listings", key: "id", keyType: "text", storage },
        { questions: [team], read: ["title", "body"], model: "jev-1.14.0", thresholds: {} },
        { id: "proj_listings", name: "Listings" },
      );
      const grants = statements.filter((statement) => statement.purpose === "grants");
      expect(
        grants.some(
          (statement) =>
            /grant update \(/.test(statement.text) &&
            statement.text.includes('"team_probabilities"'),
        ),
        storage,
      ).toBe(true);
    }
  });
});
