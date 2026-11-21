import {
  type Answer,
  type AnswerEntry,
  type HumanEntry,
  recordAnswer,
  reviewEntryOf,
  stateHash,
} from "@facetdb/core";
import { FakeClock, FakeConnector, FakeDatabase, FakeEngine } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { runInProcess, type Workspace } from "../program.ts";
import { hashPassword } from "../store-door.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  type Store,
  sourceIdOf,
  TEST_SECRET,
} from "../testing.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb review --from` against a real store on PGlite, and `facetdb export` writing the file it
 * reads: the round trip of the acceptance. The export's file lives in memory; the store, the queue,
 * the locks and the log are the real ones, so what is proved is what the studio would see: a
 * decision made from a file is in the log under the account that ran the command, the card is let
 * go of, and a file that does not describe the record it names changes nothing.
 */

const URL_OF_SOURCE = "mysql://facetdb_worker:worker-password@localhost:3306/app";
const PROJECT_DIR = "/work/acme-app";
const LOG_ID = sourceIdOf("acme-app", "listings");
const PASSWORD = "a long enough password";
const START = Date.parse("2026-11-05T10:00:00Z");

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: URL_OF_SOURCE,
      table: "listings",
      read: ["body"],
      questions: {
        scam: noul("Is this listing likely a scam?"),
        team: choice("Which team owns this?", { billing: "Money", tech: "Technical" }),
      },
    },
  ],
});

const ENV = { DATABASE_URL: "postgres://localhost:5432/app" };

let world: PgliteWorld;
let store: Store;
let clock: FakeClock;
let db: FakeDatabase;
let engine: FakeEngine;
let files: Map<string, string>;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

/** As the worker leaves a record: answered, logged, written, and queued when a person is needed. */
async function answerRecord(key: string, body: string, answers: Record<string, Answer>) {
  const [listings] = config.sources;
  if (listings === undefined) {
    throw new Error("no source");
  }
  const questionSet = questionSetOf(config, listings);
  db.edit(key, { body });
  const hash = stateHash(["body"], { body });
  const entry: AnswerEntry = {
    kind: "answer",
    key,
    version: 1,
    model: "jev-1.14.0",
    stateHash: hash,
    answers,
    usage: { inputTokens: 100, outputTokens: 8 },
    at: new Date(clock.now()),
  };
  const written: Parameters<typeof reviewEntryOf>[0]["decisions"][] = [];
  await recordAnswer(entry, questionSet, store.log(LOG_ID), (k, decision, expected) => {
    written.push(decision.decisions);
    return new FakeConnector(db).write(k, decision, expected);
  });
  const [decisions] = written;
  if (decisions === undefined) {
    throw new Error("the seed was not written");
  }
  if (Object.values(decisions).some((decision) => decision.kind === "needs_review")) {
    await store.reviews.upsert({
      source: LOG_ID,
      ...reviewEntryOf({ key, stateHash: hash, decisions, answers, since: entry.at }),
    });
  }
  clock.advance(1_000);
  return hash;
}

beforeEach(async () => {
  clock = new FakeClock(START);
  files = new Map();
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  db = new FakeDatabase({ fields: ["body"], clock });
  db.install();
  engine = new FakeEngine({ name: "mysql", schemes: ["mysql", "mariadb"], database: db });
  // What the worker leaves behind: the project, the source, its question set, three records.
  await store.ensureProject({ id: "acme-app", name: "acme-app" });
  await store.ensureSource({ projectId: "acme-app", name: "listings", kind: "plugin" });
  const [listings] = config.sources;
  if (listings === undefined) {
    throw new Error("no source");
  }
  // As the worker's loop open does since store migration 8: the version, then the set it runs.
  const questionSet = questionSetOf(config, listings);
  const recorded = await store.questionSets.record(LOG_ID, questionSet);
  await store.questionSets.run(LOG_ID, recorded.version, questionSet);
  // r1 waits for a person on scam; r2 was decided by the thresholds; r3 waits on both questions.
  await answerRecord("r1", "Cheap car, wire only", {
    scam: { type: "noul", probability: 0.58 },
    team: { type: "choice", top: "billing", probabilities: [0.9, 0.1] },
  });
  await answerRecord("r2", "Family sedan", {
    scam: { type: "noul", probability: 0.95 },
    team: { type: "choice", top: "billing", probabilities: [0.9, 0.1] },
  });
  await answerRecord("r3", "Bike, no photos", {
    scam: { type: "noul", probability: 0.5 },
    team: { type: "choice", top: "tech", probabilities: [0.6, 0.4] },
  });
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

/** The project's files: `export` writes them in parts, `review --from` reads them by line. */
function workspace(): Workspace {
  const unused = () => Promise.reject(new Error("this test uses no other file"));
  return {
    exists: (path) => Promise.resolve(files.has(path)),
    write: unused,
    writeParts: async (path, parts) => {
      let text = "";
      for await (const part of parts) {
        text += part;
      }
      files.set(path, text);
      return "written";
    },
    peek: (path) => {
      const text = files.get(path);
      return Promise.resolve(
        text === undefined
          ? { kind: "none" }
          : { kind: "file", firstLine: text.split("\n")[0] ?? "" },
      );
    },
    lines: (path) => {
      const text = files.get(path) ?? "";
      return (async function* () {
        for (const line of text.split("\n")) {
          yield line;
        }
      })();
    },
    hasClaudeCommand: () => false,
  };
}

function run(
  argv: readonly string[],
  look: {
    answers?: readonly string[];
    interactive?: boolean;
    onDisk?: ProjectConfig;
    osUser?: string;
  } = {},
) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      loadConfig: () => Promise.resolve(look.onDisk ?? config),
      engines: [lazyEngine("mysql", () => Promise.resolve(engine))],
      connect: world.connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      workspace: workspace(),
      clock,
      osUser: () => look.osUser ?? "alex",
      stopSignal: () => new AbortController().signal,
      ...(look.answers === undefined ? {} : { answers: look.answers }),
      ...(look.interactive === undefined ? {} : { interactive: look.interactive }),
    },
    COMMANDS,
  );
}

const exportLog = () => run(["export", "--source", "listings", "--out", "decisions.jsonl"]);

/** The exported file's lines, each as an object. */
function exported(): Record<string, unknown>[] {
  return (files.get("decisions.jsonl") ?? "")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The export, with a record's question decided differently in its answer row. */
function edit(key: string, question: string, decision: string) {
  const lines = exported().map((line) => {
    if (line["kind"] === "answer" && line["record_key"] === key) {
      const answers = line["answers"] as Record<string, Record<string, unknown>>;
      return { ...line, answers: { ...answers, [question]: { ...answers[question], decision } } };
    }
    return line;
  });
  files.set("decisions.jsonl", `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
}

async function humanEntries(key?: string): Promise<HumanEntry[]> {
  const keys = key === undefined ? ["r1", "r2", "r3"] : [key];
  const entries: HumanEntry[] = [];
  for (const each of keys) {
    for (const entry of await store.log(LOG_ID).history(each)) {
      if (entry.kind === "human") {
        entries.push(entry);
      }
    }
  }
  return entries;
}

async function waitingFor(viewer: string): Promise<string[]> {
  const cards = await store.reviews.list({}, viewer, clock.now());
  return cards.map((card) => card.key);
}

const statusOf = async (key: string) =>
  (await new FakeConnector(db).current([key])).get(key)?.status;

/** Every table a review could write, as it stands. */
async function stored(): Promise<string> {
  const rows = [];
  for (const table of [
    "question_set_versions",
    "question_sets_in_force",
    "reviews",
    "decisions",
    "sources",
    "projects",
  ]) {
    rows.push(await world.client.query(`select * from facetdb.${table} order by 1, 2`));
  }
  return JSON.stringify(rows);
}

describe("facetdb export, an edited row, facetdb review --from", () => {
  it("applies exactly the edited row and refuses none: the unedited rows are left as they are", async () => {
    const exportResult = await exportLog();
    expect(exportResult.code, exportResult.stderr).toBe(0);
    // The export is the whole log: three answers, no decision of a person yet.
    expect(exported().map((line) => line["kind"])).toEqual(["answer", "answer", "answer"]);
    edit("r1", "scam", "yes");

    const result = await run(["review", "--from", "decisions.jsonl", "--yes", "--json"]);

    expect(result.code, result.stderr).toBe(0);
    const document = JSON.parse(result.stdout);
    expect(document).toMatchObject({
      ok: true,
      reviewer: "os:alex",
      counts: { lines: 3, applied: 1, refused: 0, alreadyDecided: 0, notApplied: 0, left: 2 },
      malformed: [],
      rows: [{ line: 1, source: "listings", key: "r1", question: "scam", outcome: "applied" }],
    });
    expect(result.stderr).toContain("Will apply 1 decision as os:alex:");
    expect(result.stderr).not.toContain("refused");

    expect(await humanEntries()).toMatchObject([
      { key: "r1", question: "scam", value: true, reviewer: "os:alex", version: 1 },
    ]);
    // r1's other question was decided by the thresholds, so the record is done and its card is gone.
    expect(await statusOf("r1")).toBe("done");
    // The other records are as they were, and no card is left locked (another reviewer's list
    // would not show one).
    expect(await waitingFor("maya")).toEqual(["r3"]);
    expect(await statusOf("r3")).toBe("needs_review");
  });

  it("lets go of the card of a record it only partly decides", async () => {
    files.set(
      "decisions.jsonl",
      `${JSON.stringify({ source: "listings", key: "r3", question: "scam", value: "no" })}\n`,
    );

    const result = await run(["review", "--from", "decisions.jsonl", "--yes"]);

    expect(result.code, result.stderr).toBe(0);
    expect(await humanEntries("r3")).toMatchObject([{ question: "scam", value: false }]);
    // Still waiting on team, and open to any other reviewer.
    expect(await statusOf("r3")).toBe("needs_review");
    expect((await waitingFor("maya")).sort()).toEqual(["r1", "r3"]);
  });

  it("applies nothing from an export nobody edited, and refuses nothing either", async () => {
    await exportLog();
    const before = await stored();

    const result = await run(["review", "--from", "decisions.jsonl", "--json"]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      counts: { lines: 3, applied: 0, refused: 0, left: 3 },
      rows: [],
    });
    expect(result.prompts).toEqual([]);
    expect(await stored()).toBe(before);
  });

  it("run again, says the decision was made, by you, and writes nothing more", async () => {
    await exportLog();
    edit("r1", "scam", "yes");
    await run(["review", "--from", "decisions.jsonl", "--yes"]);
    const before = await stored();

    const result = await run(["review", "--from", "decisions.jsonl", "--yes", "--json"]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      counts: { applied: 0, alreadyDecided: 1, refused: 0 },
      rows: [{ outcome: "already-decided", by: "os:alex" }],
    });
    expect(result.stderr).toContain("already decided as yes by you (os:alex)");
    expect(await stored()).toBe(before);
  });

  it("refuses an edit of a record answered again since the export, and applies it to nothing", async () => {
    await exportLog();
    edit("r1", "scam", "yes");
    // The record was edited and the worker asked again after the export.
    await answerRecord("r1", "Cheap car, wire only (now with a phone number)", {
      scam: { type: "noul", probability: 0.55 },
      team: { type: "choice", top: "billing", probabilities: [0.9, 0.1] },
    });

    const result = await run(["review", "--from", "decisions.jsonl", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("1 row is refused and skipped:");
    expect(result.stdout).toContain("the record changed since this row was made");
    expect(result.stdout).toContain("No decision to apply.");
    expect(await humanEntries()).toEqual([]);
    expect((await waitingFor("maya")).sort()).toEqual(["r1", "r3"]);
  });

  it("refuses an edited row for a question a person decided, naming them, and keeps their decision", async () => {
    await store.users.add("maya", await hashPassword(PASSWORD));
    files.set(
      "decisions.jsonl",
      `${JSON.stringify({ source: "listings", key: "r1", question: "scam", value: "no" })}\n`,
    );
    const maya = await run(["review", "--from", "decisions.jsonl", "--user", "maya", "--yes"], {
      answers: [PASSWORD],
    });
    expect(maya.code, maya.stderr).toBe(0);
    expect(await humanEntries()).toMatchObject([{ reviewer: "maya", value: false }]);

    // Now an export, with the decision edited the other way.
    files.delete("decisions.jsonl");
    await exportLog();
    const lines = exported();
    expect(lines.map((line) => line["kind"])).toContain("human");
    files.set(
      "decisions.jsonl",
      `${lines
        .filter((line) => line["kind"] === "human")
        .map((line) => JSON.stringify({ ...line, value: "yes", decision: "yes" }))
        .join("\n")}\n`,
    );

    const result = await run(["review", "--from", "decisions.jsonl", "--yes"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "was already decided as no by maya on 2026-11-05 10:00 UTC; a decision a person made is never overwritten",
    );
    expect(await humanEntries()).toMatchObject([{ reviewer: "maya", value: false }]);
  });

  it("refuses edits of questions the thresholds decided, or a card another reviewer holds, never leaving them", async () => {
    await exportLog();
    // r2's thresholds-decided team changed to tech; r1's scam edited, but maya has r1's card open.
    edit("r2", "team", "tech");
    edit("r1", "scam", "yes");
    await store.reviews.lock(LOG_ID, "r1", "maya", clock.now());

    const result = await run(["review", "--from", "decisions.jsonl", "--yes", "--json"]);

    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: false,
      error: { code: "rows-refused" },
      details: { counts: { applied: 0, refused: 2 } },
    });
    expect(result.stderr).toContain(
      '"team" is not waiting for a person on this record: the thresholds decided it',
    );
    expect(result.stderr).toContain("another reviewer has it open");
    expect(await humanEntries()).toEqual([]);
  });

  it("is a dry run that locks, logs and asks nothing", async () => {
    await exportLog();
    edit("r1", "scam", "yes");
    const before = await stored();

    const result = await run(["review", "--from", "decisions.jsonl", "--dry-run"]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Would apply 1 decision as os:alex:");
    expect(result.stdout).toContain("Dry run: nothing was locked, decided or logged.");
    expect(result.prompts).toEqual([]);
    expect(await stored()).toBe(before);
  });
});

describe("facetdb review --from: whose name a decision carries", () => {
  const row = (extra: Record<string, unknown> = {}) =>
    `${JSON.stringify({ source: "listings", key: "r1", question: "scam", value: "yes", ...extra })}\n`;

  it("asks the account's password for --user (echo off, before the plan) and logs the decision under it", async () => {
    await store.users.add("maya", await hashPassword(PASSWORD));
    files.set("decisions.jsonl", row({ note: "checked the seller" }));

    const result = await run(["review", "--from", "decisions.jsonl", "--user", "maya"], {
      answers: [PASSWORD, "yes"],
    });

    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([
      "Password for maya: ",
      "Apply 1 decision as maya? Type yes to continue: ",
    ]);
    expect(await humanEntries()).toMatchObject([
      { reviewer: "maya", value: true, note: "checked the seller" },
    ]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(PASSWORD);
  });

  it("refuses a wrong password before the plan, locking and deciding nothing", async () => {
    await store.users.add("maya", await hashPassword(PASSWORD));
    files.set("decisions.jsonl", row());
    const before = await stored();

    const result = await run(["review", "--from", "decisions.jsonl", "--user", "maya", "--yes"], {
      answers: ["not the password"],
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('that is not the password of the reviewer account "maya"');
    expect(result.stdout).not.toContain("Will apply");
    expect(await stored()).toBe(before);
  });

  it("with no terminal takes the password from the first piped line, and with none says how", async () => {
    await store.users.add("maya", await hashPassword(PASSWORD));
    files.set("decisions.jsonl", row());

    const none = await run(["review", "--from", "decisions.jsonl", "--user", "maya", "--yes"], {
      interactive: false,
    });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain("needs the account's password");
    expect(none.stderr).toContain("pipe the password as the first line of standard input");
    expect(await humanEntries()).toEqual([]);

    const piped = await run(["review", "--from", "decisions.jsonl", "--user", "maya", "--yes"], {
      interactive: false,
      answers: [PASSWORD],
    });
    expect(piped.code, piped.stderr).toBe(0);
    expect(await humanEntries()).toMatchObject([{ reviewer: "maya" }]);
  });

  it("without --user decides as os:<name> and asks no password", async () => {
    files.set("decisions.jsonl", row());
    const result = await run(["review", "--from", "decisions.jsonl", "--yes"], { osUser: "sam" });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(await humanEntries()).toMatchObject([{ reviewer: "os:sam" }]);
  });

  it("a dry run with --user asks no password, and the name must still be an account", async () => {
    files.set("decisions.jsonl", row());
    const unknown = await run([
      "review",
      "--from",
      "decisions.jsonl",
      "--user",
      "nobody",
      "--dry-run",
    ]);
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('there is no reviewer account named "nobody"');

    await store.users.add("maya", await hashPassword(PASSWORD));
    const known = await run(["review", "--from", "decisions.jsonl", "--user", "maya", "--dry-run"]);
    expect(known.code, known.stderr).toBe(0);
    expect(known.prompts).toEqual([]);
    expect(await humanEntries()).toEqual([]);
  });
});

describe("facetdb review --from: a config file that is not what the worker runs", () => {
  function drafted(questions: Parameters<typeof facetdb>[0]["sources"][number]["questions"]) {
    return facetdb({
      model: "jev-1.14.0",
      sources: [
        { name: "listings", database: URL_OF_SOURCE, table: "listings", read: ["body"], questions },
      ],
    });
  }

  const drafts = {
    "a question reworded": {
      file: drafted({
        scam: noul("Does this listing look like a scam?"),
        team: choice("Which team owns this?", { billing: "Money", tech: "Technical" }),
      }),
      fallback: "config-differs",
    },
    "a threshold changed": {
      file: facetdb({
        model: "jev-1.14.0",
        sources: [
          {
            name: "listings",
            database: URL_OF_SOURCE,
            table: "listings",
            read: ["body"],
            questions: {
              scam: noul("Is this listing likely a scam?"),
              team: choice("Which team owns this?", { billing: "Money", tech: "Technical" }),
            },
            thresholds: { scam: { yesAbove: 0.5 } },
          },
        ],
      }),
      fallback: "config-may-differ",
    },
  } as const;

  // Against the worker's row of what it runs (store migration 8) every change is `config-differs`;
  // a store whose worker has not started since that migration judges by the version's row, which
  // cannot see a threshold (`fallback`).
  const cases = Object.entries(drafts).flatMap(([name, draft]) => [
    { name, file: draft.file, inForce: true, code: "config-differs" },
    { name, file: draft.file, inForce: false, code: draft.fallback },
  ]);

  it.each(cases)(
    "$name (the worker's row recorded: $inForce): stops before the password, a lock or a write, as the card does",
    async (draft) => {
      if (!draft.inForce) {
        await world.client.query("delete from facetdb.question_sets_in_force");
      }
      await store.users.add("maya", await hashPassword(PASSWORD));
      files.set(
        "decisions.jsonl",
        `${JSON.stringify({ source: "listings", key: "r1", question: "scam", value: "yes" })}\n`,
      );
      const before = await stored();

      for (const extra of [["--yes"], ["--dry-run"]]) {
        const result = await run(
          ["review", "--from", "decisions.jsonl", "--user", "maya", ...extra],
          { onDisk: draft.file },
        );

        expect(result.code).toBe(1);
        expect(result.prompts).toEqual([]);
        expect(result.stderr).toContain("runs version 1");
        expect(result.stderr).toContain(`see: https://docs.facetdb.dev/fix/${draft.code}`);
        expect(await stored()).toBe(before);
      }
    },
  );
});
