import type { PGlite } from "@electric-sql/pglite";
import type { AnswerEntry, HumanEntry, LogEntry, QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshPglite, resetPglite } from "../testing/index.ts";
import { SEARCH_SCAN_BATCH, type SearchCursor, searchStatement } from "./decision-log.ts";
import { createStore, type Store } from "./store.ts";

const SECRET = "a-long-random-secret-for-tests-only";

/** One engine for the file, emptied after every test: a boot per test cost 440 ms. */
let pglite: PGlite;
const stores: Store[] = [];

beforeAll(async () => {
  pglite = await freshPglite();
});

afterEach(async () => {
  for (const store of stores.splice(0)) {
    await store.close();
  }
  await resetPglite(pglite);
});

afterAll(async () => {
  await pglite.close();
});

async function newStore(): Promise<Store> {
  const store = await createStore({ pglite, secret: SECRET, clock: new FakeClock(0) });
  stores.push(store);
  return store;
}

const answer = (key: string, minute: number): AnswerEntry => ({
  kind: "answer",
  key,
  version: 2,
  model: "jev-1.14.0",
  stateHash: `hash-${key}`,
  answers: { scam: { type: "noul", probability: 0.25 } },
  usage: { inputTokens: 120, outputTokens: 4 },
  at: new Date(Date.UTC(2026, 9, 31, 10, minute)),
});

const human = (key: string, minute: number): HumanEntry => ({
  kind: "human",
  key,
  question: "scam",
  value: true,
  reviewer: "amara",
  note: "looked like one",
  stateHash: `hash-${key}`,
  version: 2,
  at: new Date(Date.UTC(2026, 9, 31, 10, minute)),
});

/** Reads the whole log through `page`, as the export does, and keeps the page sizes. */
async function readAll(store: Store, source: string, limit: number) {
  const entries: LogEntry[] = [];
  const sizes: number[] = [];
  let after: number | undefined;
  do {
    const page = await store.log(source).page(after, limit);
    entries.push(...page.entries);
    sizes.push(page.entries.length);
    after = page.next;
  } while (after !== undefined);
  return { entries, sizes };
}

describe("the decision log's pages", () => {
  it("walks the log oldest first, both kinds, with a cursor that continues where the page ended", async () => {
    const store = await newStore();
    const log = store.log("src");
    const appended: LogEntry[] = [
      answer("b", 0),
      answer("a", 1),
      human("a", 2),
      answer("c", 3),
      human("b", 4),
    ];
    for (const entry of appended) {
      await (entry.kind === "answer" ? log.appendAnswer(entry) : log.appendHuman(entry));
    }

    const first = await log.page(undefined, 2);
    expect(first.entries).toEqual(appended.slice(0, 2));
    expect(first.next).toBeTypeOf("number");
    const second = await log.page(first.next, 2);
    expect(second.entries).toEqual(appended.slice(2, 4));
    const third = await log.page(second.next, 2);
    expect(third.entries).toEqual(appended.slice(4));
    expect(third.next).toBeUndefined();
  });

  it("ends on a short last page, and on an empty page when the log divides evenly", async () => {
    const store = await newStore();
    const log = store.log("src");
    for (let minute = 0; minute < 6; minute += 1) {
      await log.appendAnswer(answer(`k${minute}`, minute));
    }

    const uneven = await readAll(store, "src", 4);
    expect(uneven.sizes).toEqual([4, 2]);
    expect(uneven.entries.map((entry) => entry.key)).toEqual(["k0", "k1", "k2", "k3", "k4", "k5"]);

    const even = await readAll(store, "src", 3);
    expect(even.sizes).toEqual([3, 3, 0]);
    expect(even.entries).toHaveLength(6);
  });

  it("reads a log of 1,000 rows in pages of the size asked, never in one query", async () => {
    const store = await newStore();
    const log = store.log("src");
    for (let n = 0; n < 1000; n += 1) {
      await log.appendAnswer(answer(`k${n}`, n % 60));
    }
    const all = await readAll(store, "src", 250);
    expect(all.sizes).toEqual([250, 250, 250, 250, 0]);
    expect(all.entries.map((entry) => entry.key)).toEqual(
      Array.from({ length: 1000 }, (_, n) => `k${n}`),
    );
  });

  it("counts a source's entries in one query, both kinds, and those of one version", async () => {
    const store = await newStore();
    const log = store.log("src");
    await log.appendAnswer(answer("a", 0));
    await log.appendHuman(human("a", 1));
    await log.appendAnswer({ ...answer("b", 2), version: 3 });
    await store.log("other").appendAnswer(answer("z", 3));

    expect(await log.count()).toBe(3);
    expect(await log.count(2)).toBe(2);
    expect(await log.count(3)).toBe(1);
    expect(await log.count(9)).toBe(0);
    expect(await store.log("none").count()).toBe(0);
  });

  it("is empty for a source with no log, and keeps sources apart", async () => {
    const store = await newStore();
    await store.log("one").appendAnswer(answer("a", 0));
    expect(await store.log("two").page(undefined, 10)).toEqual({ entries: [], next: undefined });
    expect((await store.log("one").page(undefined, 10)).entries).toHaveLength(1);
  });
});

const SET: QuestionSet = {
  questions: [{ type: "noul", name: "scam", instructions: "Is it a scam?", stakes: "low" }],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};

/** An answer under question-set version 1 (the first `questions.record` makes), p(yes) as given. */
const asked = (key: string, minute: number, probability: number): AnswerEntry => ({
  ...answer(key, minute),
  version: 1,
  answers: { scam: { type: "noul", probability } },
});

const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 10, minute));

describe("a choice answer's option names in the log", () => {
  const insert = (answers: string) =>
    pglite.exec(`insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
      values ('src', 'k1', 'answer', 1, 'h', 'jev-1.14.0', '${answers}'::jsonb,
              '{"inputTokens":1,"outputTokens":1}'::jsonb, now())`);

  it("keeps the names an answer is logged with, and reads a row from before them without", async () => {
    const store = await newStore();
    const named: AnswerEntry = {
      ...answer("k2", 1),
      answers: {
        team: {
          type: "choice",
          top: "bug",
          probabilities: [0.3, 0.7],
          options: ["billing", "bug"],
        },
      },
    };
    await store.log("src").appendAnswer(named);
    await insert('{"team":{"type":"choice","top":"bug","probabilities":[0.3,0.7]}}');

    expect((await store.log("src").latestAnswer("k2"))?.answers).toEqual(named.answers);
    expect((await store.log("src").latestAnswer("k1"))?.answers).toEqual({
      team: { type: "choice", top: "bug", probabilities: [0.3, 0.7] },
    });
  });

  it("refuses a row whose names and numbers disagree, naming the column", async () => {
    const store = await newStore();
    await insert(
      '{"team":{"type":"choice","top":"bug","probabilities":[0.3,0.7],"options":["bug"]}}',
    );

    await expect(store.log("src").latestAnswer("k1")).rejects.toThrow(
      /facetdb.decisions.answers: the logged answers at team are not answers/,
    );
  });
});

describe("searching the log", () => {
  async function seeded() {
    const store = await newStore();
    await store.questionSets.record("src", SET);
    const log = store.log("src");
    await log.appendAnswer(asked("a", 0, 0.9));
    await log.appendAnswer(asked("b", 1, 0.5));
    await log.appendAnswer(asked("a", 2, 0.1));
    await log.appendHuman({ ...human("b", 3), version: 1, reviewer: "amara" });
    await log.appendHuman({ ...human("c", 4), version: 1, reviewer: "sam", value: false });
    await log.appendAnswer({
      ...asked("d", 5, 0.5),
      answers: { tone: { type: "noul", probability: 0.5 } },
    });
    await store.log("other").appendAnswer(asked("z", 6, 0.9));
    return store;
  }

  const keysOf = (page: { found: readonly { entry: { key: string } }[] }) =>
    page.found.map(({ entry }) => entry.key);

  it("returns the log newest first with the decision each answer led to, in explain's words", async () => {
    const store = await seeded();
    const page = await store.searchDecisions({ source: "src", limit: 10 });
    expect(keysOf(page)).toEqual(["d", "c", "b", "a", "b", "a"]);
    expect(page.next).toBeUndefined();
    const byKey = page.found.map(({ entry, decisions }) => [entry.kind, entry.key, decisions]);
    // A noul names no option or level: its value is empty, its answer is the probability.
    const decided = (words: string) => ({ words, outcome: "decided", value: "" });
    expect(byKey).toEqual([
      // "tone" is not a question of version 1, so there are no thresholds to read it by.
      ["answer", "d", { tone: { words: "unknown", outcome: "unknown", value: "" } }],
      ["human", "c", { scam: { words: "no", outcome: "decided", value: "no" } }],
      ["human", "b", { scam: { words: "yes", outcome: "decided", value: "yes" } }],
      ["answer", "a", { scam: decided("no") }],
      ["answer", "b", { scam: { words: "needs review", outcome: "needs_review", value: "" } }],
      ["answer", "a", { scam: decided("yes") }],
    ]);
    // The rows are the export's: the same entries `page` reads, with the cursor besides.
    const { entries } = await store.log("src").page(undefined, 10);
    expect(page.found.map((found) => found.entry)).toEqual([...entries].reverse());
  });

  it("filters by record key, question, reviewer and status, and keeps sources apart", async () => {
    const store = await seeded();
    const search = (filters: object) =>
      store.searchDecisions({ source: "src", limit: 10, ...filters });

    expect(keysOf(await search({ key: "a" }))).toEqual(["a", "a"]);
    expect(keysOf(await search({ question: "scam" }))).toEqual(["c", "b", "a", "b", "a"]);
    expect(keysOf(await search({ question: "tone" }))).toEqual(["d"]);
    expect(keysOf(await search({ reviewer: "amara" }))).toEqual(["b"]);
    expect(keysOf(await search({ reviewer: "nobody" }))).toEqual([]);
    expect(keysOf(await search({ key: "b", question: "scam", reviewer: "amara" }))).toEqual(["b"]);
    // A human decision always stands; an answer needs review while any of its questions does.
    expect(keysOf(await search({ status: "needs_review" }))).toEqual(["b"]);
    expect(keysOf(await search({ status: "decided" }))).toEqual(["d", "c", "b", "a", "a"]);
    expect(keysOf(await store.searchDecisions({ source: "other", limit: 10 }))).toEqual(["z"]);
    expect(keysOf(await store.searchDecisions({ source: "nobody", limit: 10 }))).toEqual([]);
  });

  it("files by the tag, never the words, and names a score's level by its version's levels", async () => {
    const store = await newStore();
    // Option and level names are any one-line text, the other outcomes' words included.
    await store.questionSets.record("triage", {
      questions: [
        {
          type: "choice",
          name: "queue",
          instructions: "Which queue should take it?",
          options: [
            { name: "needs review", description: "A person looks first" },
            { name: "withdrawn", description: "The seller took it down" },
          ],
          stakes: "low",
          storeProbabilities: false,
        },
        {
          type: "score",
          name: "urgency",
          instructions: "How urgent is it?",
          levels: [{ name: "calm" }, { name: "urgent" }, { name: "unknown" }],
          stakes: "low",
        },
      ],
      read: ["body"],
      model: "jev-1.14.0",
      thresholds: {},
    });
    await store.log("triage").appendAnswer({
      ...answer("t", 0),
      version: 1,
      answers: {
        queue: { type: "choice", top: "needs review", probabilities: [0.95, 0.05] },
        urgency: { type: "score", probabilities: [0.1, 0.8, 0.1], confidence: 0.7, expected: 1 },
      },
    });
    const search = (filters: object) =>
      store.searchDecisions({ source: "triage", limit: 10, ...filters });

    // The model decided the option "needs review": that is a decision, not a wait for a person.
    expect(keysOf(await search({ status: "needs_review" }))).toEqual([]);
    const [found] = (await search({ status: "decided" })).found;
    expect(found?.decisions).toEqual({
      queue: { words: "needs review", outcome: "decided", value: "needs review" },
      urgency: { words: "urgent", outcome: "decided", value: "urgent" },
    });
  });

  it("takes a time range, from inclusive and to exclusive", async () => {
    const store = await seeded();
    const search = (filters: object) =>
      store.searchDecisions({ source: "src", limit: 10, ...filters });
    expect(keysOf(await search({ from: at(2), to: at(4) }))).toEqual(["b", "a"]);
    expect(keysOf(await search({ from: at(4) }))).toEqual(["d", "c"]);
    expect(keysOf(await search({ to: at(1) }))).toEqual(["a"]);
    expect(keysOf(await search({ from: at(10) }))).toEqual([]);
  });

  it("continues from the cursor without repeating or skipping a row, ties and out-of-order times included", async () => {
    const store = await newStore();
    await store.questionSets.record("src", SET);
    const log = store.log("src");
    // Five rows share a minute and others are appended with an earlier time than the one before:
    // id order and time order disagree, so only the (at, id) pair orders them.
    const minutes = [5, 3, 3, 3, 4, 1, 3, 2, 3];
    for (const [index, minute] of minutes.entries()) {
      await log.appendAnswer(asked(`k${index}`, minute, 0.9));
    }
    const everything = await store.searchDecisions({ source: "src", limit: 100 });
    expect(everything.found).toHaveLength(minutes.length);

    for (const limit of [1, 2, 3, 4, 9, 10]) {
      const walked: string[] = [];
      let before: SearchCursor | undefined;
      do {
        const page = await store.searchDecisions({
          source: "src",
          limit,
          ...(before === undefined ? {} : { before }),
        });
        walked.push(...keysOf(page));
        before = page.next;
      } while (before !== undefined);
      expect(walked, `limit ${limit}`).toEqual(keysOf(everything));
    }
    expect(keysOf(everything)).toEqual(["k0", "k4", "k1", "k2", "k3", "k6", "k8", "k7", "k5"]);
  });

  it("looks past rows of another status until the page is full, or hands back a cursor after a long scan", async () => {
    const store = await newStore();
    await store.questionSets.record("src", SET);
    const log = store.log("src");
    // A review row every 7th row, 0..N: the status is decided after the read.
    const total = SEARCH_SCAN_BATCH * 2 + 30;
    for (let n = 0; n < total; n += 1) {
      await log.appendAnswer(asked(`k${n}`, n % 60, n % 7 === 0 ? 0.5 : 0.9));
    }
    const walked: string[] = [];
    let before: SearchCursor | undefined;
    let pages = 0;
    do {
      const page = await store.searchDecisions({
        source: "src",
        status: "needs_review",
        limit: 20,
        ...(before === undefined ? {} : { before }),
      });
      walked.push(...keysOf(page));
      before = page.next;
      pages += 1;
    } while (before !== undefined);
    const expected = Array.from({ length: total }, (_, n) => n).filter((n) => n % 7 === 0);
    expect(new Set(walked).size).toBe(walked.length);
    expect(walked.map((key) => Number(key.slice(1))).sort((a, b) => a - b)).toEqual(expected);
    expect(pages).toBe(Math.ceil(expected.length / 20));
  });
});

describe("searching 100,000 log rows", () => {
  const ROWS = 100_000;
  // 20,000 distinct seconds, five rows to each, in an order unrelated to the ids.
  const BASE_MS = Date.UTC(2026, 9, 1);
  const seed = `insert into facetdb.decisions (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
    select case when n % 4 = 0 then 'other' else 'src' end, 'k' || (n % 5000), 'answer', 1, 'h',
           'jev-1.14.0', '{"scam":{"type":"noul","probability":0.25}}'::jsonb,
           '{"inputTokens":1,"outputTokens":1}'::jsonb,
           to_timestamp((${BASE_MS} + ((n * 7919) % 20000) * 1000)::double precision / 1000)
      from generate_series(1, ${ROWS}) n`;
  const from = new Date(BASE_MS + 6_000 * 1000);
  const to = new Date(BASE_MS + 9_000 * 1000);

  async function seeded100k() {
    const store = await newStore();
    await pglite.exec(seed);
    await pglite.exec("analyze facetdb.decisions");
    return store;
  }

  it("reads a time range of one source over the time index, never sorting the log, and pages it whole", async () => {
    const store = await seeded100k();
    const { sql, params } = searchStatement({ source: "src", from, to }, 51);
    const plan = (await pglite.query<{ "QUERY PLAN": string }>(`explain ${sql}`, [...params])).rows
      .map((row) => row["QUERY PLAN"])
      .join("\n");
    expect(plan).toContain("decisions_by_time");
    expect(plan).not.toMatch(/\bSort\b/);
    // With a cursor and a question on the statement, the index still orders the rows. (A record
    // key is selective enough that the planner rightly reads `decisions_by_record` instead.)
    const filtered = searchStatement(
      {
        source: "src",
        from,
        to,
        question: "scam",
        before: { atMs: from.getTime() + 1_000_000, id: 5 },
      },
      51,
    );
    const filteredPlan = (
      await pglite.query<{ "QUERY PLAN": string }>(`explain ${filtered.sql}`, [...filtered.params])
    ).rows
      .map((row) => row["QUERY PLAN"])
      .join("\n");
    expect(filteredPlan).toContain("decisions_by_time");
    expect(filteredPlan).not.toMatch(/\bSort\b/);

    // And a page never repeats or skips a row of the range across the cursor.
    const expected = (
      await pglite.query<{ row_id: string }>(
        `select id::text as row_id from facetdb.decisions
          where source_id = 'src' and at >= to_timestamp(${from.getTime()}::double precision / 1000)
            and at < to_timestamp(${to.getTime()}::double precision / 1000)
          order by at desc, id`,
      )
    ).rows.map((row) => Number(row.row_id));
    expect(expected.length).toBeGreaterThan(10_000);

    const walked: number[] = [];
    let before: SearchCursor | undefined;
    do {
      const page = await store.searchDecisions({
        source: "src",
        from,
        to,
        limit: 997,
        ...(before === undefined ? {} : { before }),
      });
      walked.push(...page.found.map(({ cursor }) => cursor.id));
      before = page.next;
    } while (before !== undefined);
    expect(walked).toEqual(expected);
  });
});
