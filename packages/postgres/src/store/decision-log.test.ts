import type { PGlite } from "@electric-sql/pglite";
import type { AnswerEntry, HumanEntry, LogEntry } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { freshPglite, resetPglite } from "../testing/index.ts";
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

  it("is empty for a source with no log, and keeps sources apart", async () => {
    const store = await newStore();
    await store.log("one").appendAnswer(answer("a", 0));
    expect(await store.log("two").page(undefined, 10)).toEqual({ entries: [], next: undefined });
    expect((await store.log("one").page(undefined, 10)).entries).toHaveLength(1);
  });
});
