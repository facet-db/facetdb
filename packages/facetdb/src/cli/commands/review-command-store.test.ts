import { type AnswerEntry, recordAnswer, reviewEntryOf, stateHash } from "@facetdb/core";
import { FakeClock, FakeConnector, FakeDatabase, FakeEngine } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { runInProcess } from "../program.ts";
import { hashPassword } from "../store-door.ts";
import type { KeyEvent, ReviewTerminal } from "../terminal.ts";
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
 * `facetdb review` against a real store on PGlite: the command opens the store of `DATABASE_URL`
 * and the source's connector through its engine, the same queue, lock and log the studio reads. A
 * card open in the terminal is not in another reviewer's list until it is decided, skipped or quit,
 * and a decision made in the terminal is in the log under `os:<name>`, or under the account whose
 * password was asked for `--user`.
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

type Step = string | (() => Promise<void>);

let world: PgliteWorld;
let store: Store;
let clock: FakeClock;
let db: FakeDatabase;
let engine: FakeEngine;

beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  clock = new FakeClock(START);
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock });
  db = new FakeDatabase({ fields: ["body"], clock });
  db.install();
  engine = new FakeEngine({ name: "mysql", schemes: ["mysql", "mariadb"], database: db });
  // What the worker leaves behind: the project, the source, its question set, one card to review.
  await store.ensureProject({ id: "acme-app", name: "acme-app" });
  await store.ensureSource({ projectId: "acme-app", name: "listings", kind: "plugin" });
  const [listings] = config.sources;
  if (listings === undefined) {
    throw new Error("no source");
  }
  const questionSet = questionSetOf(config, listings);
  await store.questionSets.record(LOG_ID, questionSet);
  db.edit("r1", { body: "Cheap car, wire only" });
  const hash = stateHash(["body"], { body: "Cheap car, wire only" });
  const answers = {
    scam: { type: "noul", probability: 0.58 },
    team: { type: "choice", top: "billing", probabilities: [0.9, 0.1] },
  } as const;
  const entry: AnswerEntry = {
    kind: "answer",
    key: "r1",
    version: 1,
    model: "jev-1.14.0",
    stateHash: hash,
    answers,
    usage: { inputTokens: 100, outputTokens: 8 },
    at: new Date(clock.now()),
  };
  const written: Parameters<typeof reviewEntryOf>[0]["decisions"][] = [];
  await recordAnswer(entry, questionSet, store.log(LOG_ID), (key, decision, expected) => {
    written.push(decision.decisions);
    return new FakeConnector(db).write(key, decision, expected);
  });
  const [decisions] = written;
  if (decisions === undefined) {
    throw new Error("the seed was not written");
  }
  await store.reviews.upsert({
    source: LOG_ID,
    ...reviewEntryOf({ key: "r1", stateHash: hash, decisions, answers, since: entry.at }),
  });
  clock.advance(1_000);
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

/** A terminal that plays the keys, running a step between two keys when it is a function. */
function terminal(steps: readonly Step[]): ReviewTerminal {
  const left = [...steps];
  return {
    interactive: () => true,
    columns: () => 80,
    color: () => false,
    open: () => ({
      next: async (): Promise<KeyEvent> => {
        let step = left.shift();
        while (typeof step === "function") {
          await step();
          step = left.shift();
        }
        return step === undefined ? { kind: "end" } : { kind: "key", key: step };
      },
      flush: () => undefined,
      line: () => Promise.resolve(undefined),
      close: () => undefined,
    }),
  };
}

function run(
  argv: readonly string[],
  steps: readonly Step[] = [],
  answers: readonly string[] = [],
  env: Record<string, string> = { DATABASE_URL: "postgres://localhost:5432/app" },
  onDisk: ProjectConfig = config,
) {
  return runInProcess(
    ["review", ...argv],
    {
      projectDir: PROJECT_DIR,
      env,
      loadConfig: () => Promise.resolve(onDisk),
      engines: [lazyEngine("mysql", () => Promise.resolve(engine))],
      connect: world.connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: () => Promise.resolve({ ...store, close: () => Promise.resolve() }),
      clock,
      osUser: () => "alex",
      stopSignal: () => new AbortController().signal,
      terminal: terminal(steps),
      answers,
    },
    COMMANDS,
  );
}

/** The keys another reviewer's queue lists right now. */
async function waitingFor(viewer: string): Promise<string[]> {
  const cards = await store.reviews.list({}, viewer, clock.now());
  return cards.map((card) => card.key);
}

async function humanEntries() {
  return (await store.log(LOG_ID).history("r1")).filter((entry) => entry.kind === "human");
}

describe("facetdb review against the store", () => {
  it("locks the card it shows: another reviewer's queue loses it until it is decided, and the decision is logged under os:<name>", async () => {
    expect(await waitingFor("maya")).toEqual(["r1"]);
    let whileOpen: string[] = [];

    const result = await run(
      [],
      [
        async () => {
          whileOpen = await waitingFor("maya");
        },
        "y",
      ],
    );

    expect(result.code, result.stderr).toBe(0);
    expect(whileOpen).toEqual([]);
    expect(result.stdout).toContain("scam: yes. Written to the record and logged for os:alex.");
    expect(await humanEntries()).toMatchObject([
      { question: "scam", value: true, reviewer: "os:alex", version: 1 },
    ]);
    expect(await waitingFor("maya")).toEqual([]);
    expect((await new FakeConnector(db).current(["r1"])).get("r1")).toMatchObject({
      status: "done",
    });
  });

  it("gives the card back when the reviewer quits or skips", async () => {
    await run([], ["q"]);
    expect(await waitingFor("maya")).toEqual(["r1"]);
    await run([], ["s"]);
    expect(await waitingFor("maya")).toEqual(["r1"]);
    // Skipping is for the skipper: the card stays in alex's list, behind the others.
    expect(await waitingFor("alex")).toEqual(["r1"]);
  });

  it("prints the queue with --json without locking anything", async () => {
    const result = await run(["--json"]);

    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      reviewer: "os:alex",
      count: 1,
      cards: [
        { source: "listings", key: "r1", open: [{ question: "scam", says: "58% likely yes" }] },
      ],
    });
    expect(await waitingFor("maya")).toEqual(["r1"]);
  });

  it("asks the account's password for --user, and logs the decision under that name", async () => {
    await store.users.add("maya", await hashPassword(PASSWORD));

    const result = await run(["--user", "maya"], ["n"], [PASSWORD]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual(["Password for maya: "]);
    expect(result.stdout).toContain("logged for maya.");
    expect(await humanEntries()).toMatchObject([{ reviewer: "maya", value: false }]);
    expect(`${result.stdout}${result.stderr}`).not.toContain(PASSWORD);
  });

  it("refuses a wrong password, taking and deciding nothing", async () => {
    await store.users.add("maya", await hashPassword(PASSWORD));

    const result = await run(["--user", "maya"], ["y"], ["not the password"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('that is not the password of the reviewer account "maya"');
    expect(result.stderr).toContain("fix: ");
    expect(await humanEntries()).toEqual([]);
    expect(await waitingFor("bob")).toEqual(["r1"]);
  });

  it("asks no password under --json, but the name must be an account", async () => {
    await store.users.add("maya", await hashPassword(PASSWORD));

    const known = await run(["--user", "maya", "--json"]);
    expect(known.code, known.stderr).toBe(0);
    expect(known.prompts).toEqual([]);
    expect(JSON.parse(known.stdout)).toMatchObject({ reviewer: "maya" });

    const unknown = await run(["--user", "nobody", "--json"]);
    expect(unknown.code).toBe(1);
    expect(JSON.parse(unknown.stdout)).toMatchObject({
      ok: false,
      error: { code: "no-such-user" },
    });
  });

  describe("a config file that is not what the worker runs", () => {
    /** The listings source of the test config, changed as the file on disk might have been. */
    function drafted(change: Partial<Parameters<typeof facetdb>[0]["sources"][number]>) {
      const [listings] = config.sources;
      if (listings === undefined) {
        throw new Error("no source");
      }
      return facetdb({
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
            ...change,
          },
        ],
      });
    }

    const drafts = {
      "a question added": {
        change: {
          questions: {
            scam: noul("Is this listing likely a scam?"),
            team: choice("Which team owns this?", { billing: "Money", tech: "Technical" }),
            urgent: noul("Is this urgent?"),
          },
        },
        says: "the questions",
        code: "config-differs",
      },
      "a threshold changed": {
        change: { thresholds: { scam: { yesAbove: 0.5 } } },
        says: "the thresholds",
        code: "config-may-differ",
      },
      "a field read added": {
        change: { read: ["body", "title"] },
        says: "the fields it reads",
        code: "config-differs",
      },
      "the questions put in another order": {
        change: {
          questions: {
            team: choice("Which team owns this?", { billing: "Money", tech: "Technical" }),
            scam: noul("Is this listing likely a scam?"),
          },
        },
        says: "the stakes or the order of the questions",
        code: "config-may-differ",
      },
      "a question reworded": {
        change: {
          questions: {
            scam: noul("Does this listing look like a scam?"),
            team: choice("Which team owns this?", { billing: "Money", tech: "Technical" }),
          },
        },
        says: "the questions",
        code: "config-differs",
      },
      "a where filter added": {
        change: { where: "body is not null" },
        says: "the where filter",
        code: "config-may-differ",
      },
    } as const;

    /** Every table the review could have written, as it stands. */
    async function stored(): Promise<string> {
      const rows = [];
      for (const table of [
        "question_set_versions",
        "reviews",
        "decisions",
        "sources",
        "projects",
      ]) {
        rows.push(await world.client.query(`select * from facetdb.${table} order by 1, 2`));
      }
      return JSON.stringify(rows);
    }

    it.each(Object.entries(drafts))(
      "%s: stops with the fix, locks and writes nothing",
      async (_name, draft) => {
        const before = await stored();
        const file = drafted(draft.change);

        const result = await run([], ["y"], [], undefined, file);

        expect(result.code).toBe(1);
        expect(result.stderr).toContain("runs version 1");
        expect(result.stderr).toContain(draft.says);
        if (draft.code === "config-differs") {
          // The hash sees it: a worker restarted with the file would record a new version.
          expect(result.stderr).toContain("the worker is not running what facetdb.config.ts says");
          expect(result.stderr).toContain(
            "fix: restart facetdb worker with this file so it runs these changes, or review in the studio, which judges by what the worker runs",
          );
        } else {
          // The store keeps these as they were when version 1 was made: a restart proves nothing,
          // and neither does putting the file back, so neither is suggested.
          expect(result.stderr).toContain(
            "error: this check cannot tell whether the worker already runs facetdb.config.ts",
          );
          expect(result.stderr).toContain(
            "because the store keeps those values as they were when that version was made",
          );
          expect(result.stderr).toContain(
            "fix: review in the studio, which judges cards by what the worker runs",
          );
          expect(result.stderr).not.toMatch(/restart|edit|put the file back|change the file/i);
        }
        expect(await stored()).toBe(before);
        expect(await waitingFor("maya")).toEqual(["r1"]);
        expect(await humanEntries()).toEqual([]);
      },
    );

    it.each(Object.entries(drafts))("%s: --json stops the same way", async (_name, draft) => {
      const before = await stored();

      const result = await run(["--json"], [], [], undefined, drafted(draft.change));

      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        ok: false,
        error: { code: draft.code },
      });
      expect(await stored()).toBe(before);
    });

    it("judges by the version in force: the decision carries it, whatever the version table says later", async () => {
      // The file is the same as the worker's, so the review goes on and writes only its decision.
      const before = JSON.parse(await stored()) as unknown[][];

      const result = await run([], ["y"]);

      expect(result.code, result.stderr).toBe(0);
      const after = JSON.parse(await stored()) as unknown[][];
      // question_set_versions, sources and projects are untouched; reviews and decisions moved.
      expect(after[0]).toEqual(before[0]);
      expect(after[3]).toEqual(before[3]);
      expect(after[4]).toEqual(before[4]);
      expect(await humanEntries()).toMatchObject([{ version: 1 }]);
    });

    it("says a source that never ran a worker has no cards, and reviews the others", async () => {
      const both = facetdb({
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
          {
            name: "tickets",
            database: URL_OF_SOURCE,
            table: "tickets",
            read: ["body"],
            questions: { urgent: noul("Is this urgent?") },
          },
        ],
      });
      const before = await stored();

      const result = await run(["--json"], [], [], undefined, both);

      expect(result.code, result.stderr).toBe(0);
      expect(result.stderr).toContain(
        "tickets has never run a worker, so it has no cards to review; run facetdb worker, then review it.",
      );
      expect(JSON.parse(result.stdout)).toMatchObject({ count: 1, cards: [{ key: "r1" }] });
      expect(await stored()).toBe(before);

      const only = await run(["--json", "--source", "tickets"], [], [], undefined, both);
      expect(only.code).toBe(1);
      expect(JSON.parse(only.stdout)).toMatchObject({ error: { code: "no-worker-yet" } });
      expect(await stored()).toBe(before);
    });
  });

  it("says what to set when DATABASE_URL is missing", async () => {
    const result = await run([], [], [], {});
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("DATABASE_URL is not set");
  });
});
