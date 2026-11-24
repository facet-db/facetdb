import {
  type ChoiceQuestion,
  type Clock,
  decide,
  type QuestionSet,
  type RecordDecision,
  resolveThresholds,
} from "@facetdb/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate, type TableSource } from "../install/index.ts";
import { connectPostgres, type SqlClient } from "../sql/index.ts";
import { createScratchDatabase, type ScratchDatabase } from "../testing/index.ts";
import { createPostgresConnector, type PostgresConnector } from "./connector.ts";

/**
 * On a real Postgres, for what PGlite cannot prove: the worker login, with only the grants the
 * install gives it, writes `_probabilities` inline and into the side row; postgres.js binds the
 * text as jsonb without encoding it twice (client.ts: PGlite applies no serializer); and an install
 * made before the option was on refuses the write whole until `facetdb migrate` adds and grants the
 * column.
 */

const team: ChoiceQuestion = {
  type: "choice",
  name: "team",
  instructions: "Which team should handle this?",
  options: [
    { name: "sales.emea", description: "Sales in Europe" },
    { name: `O'Brien "ops"`, description: "Operations" },
    { name: "équipe ✓", description: "International" },
  ],
  stakes: "low",
  storeProbabilities: true,
};
const keyed = { "sales.emea": 0.8, [`O'Brien "ops"`]: 0.15, "équipe ✓": 0.05 };

const setWith = (question: ChoiceQuestion): QuestionSet => ({
  questions: [question],
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
});

const PASSWORD = "a-long-random-password-for-tests";
const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

let scratch: ScratchDatabase;
let admin: SqlClient;
const open: PostgresConnector[] = [];

beforeAll(async () => {
  scratch = await createScratchDatabase();
  admin = connectPostgres(scratch.url);
});

afterAll(async () => {
  for (const connector of open.splice(0)) {
    await connector.close();
  }
  await admin.close();
  await scratch.drop();
});

async function install(source: TableSource, questionSet: QuestionSet) {
  const result = await migrate({
    adminUrl: scratch.url,
    print: () => undefined,
    plan: {
      source,
      questionSet,
      project: { id: "proj_tickets", name: "Tickets" },
      workerPassword: PASSWORD,
      roleSuffix: scratch.roleSuffix,
    },
  });
  if (!result.ok) {
    throw new Error(result.reason);
  }
}

function worker(source: TableSource, questionSet: QuestionSet): PostgresConnector {
  const connector = createPostgresConnector({
    workerUrl: scratch.as(scratch.workerRole, PASSWORD),
    source,
    questionSet,
    clock: realClock,
    pollMs: 10_000,
  });
  open.push(connector);
  return connector;
}

function decided(question: ChoiceQuestion): RecordDecision {
  const answer = {
    type: "choice",
    top: "sales.emea",
    probabilities: [0.8, 0.15, 0.05],
    options: question.options.map((option) => option.name),
  } as const;
  return {
    decisions: { team: decide(question, resolveThresholds(question, undefined), answer) },
    status: "done",
  };
}

for (const storage of ["inline", "side-table"] as const) {
  const table = storage === "inline" ? "tickets" : "notes";
  const relation = storage === "inline" ? `public.${table}` : `facetdb.${table}_answers`;

  describe(`the worker login writes _probabilities (${storage})`, () => {
    it("as a jsonb object keyed by option name, with only its own grants", async () => {
      await admin.query(
        `create table public.${table} (id text primary key, title text, body text)`,
      );
      const source: TableSource = { table, key: "id", storage };
      await install(source, setWith(team));
      await admin.query(`insert into public.${table} (id, title, body) values ('k1', 'a', 'b')`);
      const w = worker(source, setWith(team));
      const hash = (await w.read(["k1"])).rows[0]?.hash ?? "";

      expect(await w.write("k1", decided(team), hash)).toEqual({ written: true });

      expect(
        await admin.query(
          `select team_probabilities as stored, jsonb_typeof(team_probabilities) as kind
             from ${relation} where id = 'k1'`,
        ),
      ).toEqual([{ stored: keyed, kind: "object" }]);

      await w.write(
        "k1",
        { decisions: { team: { kind: "needs_review" } }, status: "needs_review" },
        hash,
      );
      expect(
        await admin.query(
          `select team_probabilities as stored, team_confidence as confidence from ${relation} where id = 'k1'`,
        ),
      ).toEqual([{ stored: null, confidence: null }]);
    });
  });
}

describe("an install made before storeProbabilities was on", () => {
  it("refuses the whole write until migrate adds and grants the column, then writes it", async () => {
    await admin.query(`create table public.orders (id text primary key, title text, body text)`);
    const source: TableSource = { table: "orders", key: "id" };
    const off: ChoiceQuestion = { ...team, storeProbabilities: false };
    await install(source, setWith(off));
    await admin.query(`insert into public.orders (id, title, body) values ('o1', 'a', 'b')`);
    const before = worker(source, setWith(off));
    const hash = (await before.read(["o1"])).rows[0]?.hash ?? "";
    expect(await before.write("o1", decided(off), hash)).toEqual({ written: true });

    // The config now says storeProbabilities: true, and migrate has not run: the update names a
    // column the table lacks, and nothing of it lands (doctor says the install is behind the file).
    const ahead = worker(source, setWith(team));
    await expect(
      ahead.write("o1", { ...decided(team), status: "needs_review" }, hash),
    ).rejects.toThrow(/team_probabilities/);
    expect(await admin.query(`select facetdb_status from public.orders where id = 'o1'`)).toEqual([
      { facetdb_status: "done" },
    ]);

    await install(source, setWith(team));
    expect(await ahead.write("o1", decided(team), hash)).toEqual({ written: true });
    expect(
      await admin.query(`select team_probabilities as stored from public.orders where id = 'o1'`),
    ).toEqual([{ stored: keyed }]);
  });
});
