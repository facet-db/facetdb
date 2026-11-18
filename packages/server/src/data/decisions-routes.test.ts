import {
  type AnswerEntry,
  answerDecisions,
  explainHistory,
  type HumanEntry,
  type KeyText,
  type LogEntry,
  type QuestionSet,
} from "@facetdb/core";
import type { DecisionSearch, DecisionSearchPage, FoundDecision } from "@facetdb/postgres";
import { sourceIdOf } from "@facetdb/postgres";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import {
  createDecisionsService,
  DECISIONS_DEFAULT_LIMIT,
  type DecisionsStore,
} from "./decisions-service.ts";

/**
 * The decision history routes on a handwritten log: the filters reach the store as the caller
 * named them, the cursor walks the log without repeating or skipping a row, and the why endpoint
 * answers with the history `facetdb explain` builds, from the same core function. The SQL under
 * the log is proven on PGlite in the postgres package (decision-log.test.ts).
 */

const PROJECT = "listings-app";
const KEY = "Bearer fdb_listings";
const OTHER_KEY = "Bearer fdb_another";

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: (header) =>
    Promise.resolve(
      header === KEY
        ? { id: "key-1", projectId: PROJECT }
        : header === OTHER_KEY
          ? { id: "key-2", projectId: "another-app" }
          : undefined,
    ),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
};

const NO_CONFIG: ConfigService = {
  json: () => {
    throw new Error("these tests read no config");
  },
  validate: () => {
    throw new Error("these tests validate no draft");
  },
  preview: () => Promise.reject(new Error("these tests preview nothing")),
};

const tagged: KeyText = {
  toText: (key) => key.replace(/^oid:/, ""),
  fromText: (text) => `oid:${text}`,
  form: "the document's _id as you write it",
};

/** Version 1 and 2 word the same question differently, and 2 loosens its thresholds. */
const V1: QuestionSet = {
  questions: [{ type: "noul", name: "is_scam", instructions: "Is it a scam?", stakes: "low" }],
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};
const V2: QuestionSet = {
  ...V1,
  questions: [
    {
      type: "noul",
      name: "is_scam",
      instructions: "Does the listing look like a scam?",
      stakes: "low",
    },
  ],
  thresholds: { is_scam: { yesAbove: 0.9, noBelow: 0.1 } },
};

const at = (minute: number) => new Date(Date.UTC(2026, 10, 5, 12, minute));

const answered = (key: string, minute: number, probability: number, version = 1): AnswerEntry => ({
  kind: "answer",
  key,
  version,
  model: "jev-1.14.0",
  stateHash: `hash-${key}`,
  answers: { is_scam: { type: "noul", probability } },
  usage: { inputTokens: 100, outputTokens: 2 },
  at: at(minute),
});

const decidedBy = (
  key: string,
  minute: number,
  reviewer: string,
  value: boolean,
  version = 1,
): HumanEntry => ({
  kind: "human",
  key,
  question: "is_scam",
  value,
  reviewer,
  note: "checked the seller",
  stateHash: `hash-${key}`,
  version,
  at: at(minute),
});

/**
 * An in-memory log in the order the real one searches: newest first, rows of one instant in the
 * order they were appended, the cursor the pair (time, position). The record every call made.
 */
function fakeStore(rows: readonly LogEntry[], versions: Readonly<Record<number, QuestionSet>>) {
  const searches: DecisionSearch[] = [];
  const store: DecisionsStore = {
    search(search) {
      searches.push(search);
      const indexed = rows.map((entry, index) => ({ entry, id: index + 1 }));
      const ordered = indexed
        .filter(() => sourceIdOf(PROJECT, "listings") === search.source)
        .filter(({ entry }) => search.key === undefined || entry.key === search.key)
        .filter(
          ({ entry }) =>
            search.question === undefined ||
            (entry.kind === "answer"
              ? search.question in entry.answers
              : entry.question === search.question),
        )
        .filter(
          ({ entry }) =>
            search.reviewer === undefined ||
            (entry.kind === "human" && entry.reviewer === search.reviewer),
        )
        .filter(({ entry }) => search.from === undefined || entry.at >= search.from)
        .filter(({ entry }) => search.to === undefined || entry.at < search.to)
        .sort((a, b) => {
          const byTime = b.entry.at.getTime() - a.entry.at.getTime();
          return byTime === 0 ? a.id - b.id : byTime;
        });
      const found: FoundDecision[] = [];
      let next: DecisionSearchPage["next"];
      const after = search.before;
      for (const { entry, id } of ordered) {
        const time = entry.at.getTime();
        if (after !== undefined && !(time < after.atMs || (time === after.atMs && id > after.id))) {
          continue;
        }
        const decisions =
          entry.kind === "answer"
            ? answerDecisions(entry, versions[entry.version])
            : { [entry.question]: entry.value === true ? "yes" : "no" };
        const status = Object.values(decisions).includes("needs review")
          ? "needs_review"
          : "decided";
        if (search.status !== undefined && status !== search.status) {
          continue;
        }
        if (found.length === search.limit) {
          const last = found[found.length - 1];
          next = last?.cursor;
          break;
        }
        found.push({ cursor: { atMs: time, id }, entry, decisions });
      }
      return Promise.resolve({ found, next });
    },
    history: (sourceId, key) =>
      Promise.resolve(
        sourceId === sourceIdOf(PROJECT, "listings")
          ? rows.filter((entry) => entry.key === key)
          : [],
      ),
    questionSets: (_sourceId, wanted) =>
      Promise.resolve(
        new Map(wanted.flatMap((v) => (versions[v] === undefined ? [] : [[v, versions[v]]]))),
      ),
  };
  return { store, searches };
}

/** What the endpoints answer with, every field assumed present: each test reads only what it asked for. */
type Reply = {
  readonly decisions: { readonly record_key: string; readonly time: string }[];
  readonly next: string | null;
  readonly key: string;
  readonly error: { readonly code: string; readonly message: string; readonly fix: string };
  readonly entries: { readonly answers: Record<string, unknown>[] }[];
};

function rig(
  rows: readonly LogEntry[],
  options: {
    readonly keyText?: KeyText;
    readonly versions?: Readonly<Record<number, QuestionSet>>;
  } = {},
) {
  const log = fakeStore(rows, options.versions ?? { 1: V1, 2: V2 });
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: {
      runs: { list: () => Promise.reject(new Error("these tests read no runs")) },
      decisions: createDecisionsService({
        store: log.store,
        projectId: PROJECT,
        sources: ["listings", "support_messages"],
        keyText: (source) => (source === "listings" ? options.keyText : undefined),
      }),
    },
    newRequestId: () => "req-1",
  });

  async function get(path: string, authorization: string | null = KEY) {
    const response = await app.request(path, {
      headers: authorization === null ? {} : { authorization },
    });
    return { status: response.status, body: (await response.json()) as Reply };
  }

  return { get, searches: log.searches };
}

/** A log of eight rows: six model calls and two people, over ten minutes, under two versions. */
const LOG: readonly LogEntry[] = [
  answered("a", 0, 0.9),
  answered("b", 1, 0.5),
  answered("c", 2, 0.1),
  decidedBy("b", 3, "amara", true),
  answered("a", 4, 0.95, 2),
  answered("d", 5, 0.5, 2),
  decidedBy("d", 6, "sam", false, 2),
  answered("e", 7, 0.5),
];

describe("GET /v1/decisions", () => {
  it("needs an API key, as every endpoint under /v1 does", async () => {
    const { get } = rig(LOG);
    const response = await get("/v1/decisions?source=listings", null);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("invalid_api_key");
  });

  it("lists a source's log newest first in the export's shape, each answer with its decision", async () => {
    const { get } = rig(LOG);
    const { status, body } = await get("/v1/decisions?source=listings&limit=3");
    expect(status).toBe(200);
    expect(body["decisions"]).toEqual([
      {
        time: "2026-11-05T12:07:00.000Z",
        kind: "answer",
        record_key: "e",
        version: 1,
        state_hash: "hash-e",
        model: "jev-1.14.0",
        answers: { is_scam: { type: "noul", probability: 0.5, decision: "needs review" } },
      },
      {
        time: "2026-11-05T12:06:00.000Z",
        kind: "human",
        record_key: "d",
        version: 2,
        state_hash: "hash-d",
        question: "is_scam",
        value: "no",
        decision: "no",
        decided_by: "sam",
        note: "checked the seller",
      },
      {
        time: "2026-11-05T12:05:00.000Z",
        kind: "answer",
        record_key: "d",
        version: 2,
        state_hash: "hash-d",
        model: "jev-1.14.0",
        // Version 2 asks for 90% before it says yes and 10% before it says no: 50% is review.
        answers: { is_scam: { type: "noul", probability: 0.5, decision: "needs review" } },
      },
    ]);
    expect(body["next"]).toBeTypeOf("string");
  });

  it("passes each filter to the log as the caller named it, under the project's source id", async () => {
    const { get, searches } = rig(LOG);
    await get(
      "/v1/decisions?source=listings&key=b&question=is_scam&status=needs_review&reviewer=amara" +
        "&from=2026-11-05T12:01:00Z&to=2026-11-05T14:00:00%2B02:00&limit=7",
    );
    expect(searches).toEqual([
      {
        source: sourceIdOf(PROJECT, "listings"),
        key: "b",
        question: "is_scam",
        status: "needs_review",
        reviewer: "amara",
        from: new Date("2026-11-05T12:01:00Z"),
        to: new Date("2026-11-05T12:00:00Z"),
        limit: 7,
      },
    ]);
    await get("/v1/decisions?source=listings");
    expect(searches[1]).toEqual({
      source: sourceIdOf(PROJECT, "listings"),
      limit: DECISIONS_DEFAULT_LIMIT,
    });
  });

  it("narrows by record, question, reviewer, status and time", async () => {
    const { get } = rig(LOG);
    const keysOf = async (query: string) =>
      (
        (await get(`/v1/decisions?source=listings&${query}`)).body["decisions"] as {
          record_key: string;
        }[]
      ).map((row) => row.record_key);
    expect(await keysOf("key=a")).toEqual(["a", "a"]);
    expect(await keysOf("reviewer=amara")).toEqual(["b"]);
    expect(await keysOf("status=needs_review")).toEqual(["e", "d", "b"]);
    expect(await keysOf("status=decided")).toEqual(["d", "a", "b", "c", "a"]);
    expect(await keysOf("from=2026-11-05T12:02:00Z&to=2026-11-05T12:05:00Z")).toEqual([
      "a",
      "b",
      "c",
    ]);
    expect(await keysOf("question=nothing_of_the_sort")).toEqual([]);
  });

  it("walks the log by the cursor without repeating or skipping a row, whatever the page size", async () => {
    const { get } = rig([...LOG, answered("f", 7, 0.9), answered("g", 7, 0.9)]);
    const everything = (await get("/v1/decisions?source=listings&limit=200")).body;
    expect(everything["next"]).toBeNull();
    const all = everything["decisions"] as { time: string; record_key: string }[];
    expect(all).toHaveLength(10);

    for (const limit of [1, 2, 3, 4, 7, 10]) {
      const walked: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page: { body: Reply } = await get(
          `/v1/decisions?source=listings&limit=${limit}${cursor === null ? "" : `&cursor=${cursor}`}`,
        );
        walked.push(...page.body["decisions"]);
        cursor = page.body["next"];
      } while (cursor !== null);
      expect(walked, `limit ${limit}`).toEqual(all);
    }
  });

  it("writes and reads keys as the user writes them where the engine tags them", async () => {
    const { get, searches } = rig([answered("oid:65f1", 0, 0.9)], { keyText: tagged });
    const { body } = await get("/v1/decisions?source=listings&key=65f1");
    expect(searches[0]?.key).toBe("oid:65f1");
    expect((body["decisions"] as { record_key: string }[]).map((row) => row.record_key)).toEqual([
      "65f1",
    ]);
  });

  it("refuses what it cannot parse with the fix, and ignores nothing", async () => {
    const { get, searches } = rig(LOG);
    const refused = async (query: string) => {
      const { status, body } = await get(`/v1/decisions?${query}`);
      expect(status, query).toBe(400);
      expect(Object.keys(body["error"]).sort()).toEqual(["code", "fix", "message"]);
      return body["error"] as { code: string; message: string; fix: string };
    };
    expect((await refused("")).message).toContain("source");
    expect((await refused("source=listings&status=done")).code).toBe("invalid_request");
    expect((await refused("source=listings&from=yesterday")).message).toContain("from");
    expect((await refused("source=listings&limit=0")).code).toBe("invalid_request");
    expect((await refused("source=listings&limit=201")).code).toBe("invalid_request");
    expect((await refused("source=listings&reviewr=amara")).message).toContain("reviewr");
    expect((await refused("source=listings&cursor=banana")).code).toBe("invalid_cursor");
    expect((await refused("source=listings&cursor=banana")).fix).toContain("next");
    expect(searches).toEqual([]);
  });

  it("answers 404 with the fix for a source the project does not have, and for another project's key", async () => {
    const { get } = rig(LOG);
    const unknown = await get("/v1/decisions?source=orders");
    expect(unknown.status).toBe(404);
    expect(unknown.body["error"].code).toBe("unknown_source");
    expect(unknown.body["error"].fix).toBe("Use one of: listings, support_messages.");
    const other = await get("/v1/decisions?source=listings", OTHER_KEY);
    expect(other.status).toBe(404);
    expect(other.body["error"].code).toBe("unknown_project");
  });
});

describe("GET /v1/decisions/:source/:key", () => {
  it("returns the history facetdb explain builds, from the same core function", async () => {
    const { get } = rig(LOG);
    const { status, body } = await get("/v1/decisions/listings/a");
    expect(status).toBe(200);
    const history = LOG.filter((entry) => entry.key === "a");
    expect(body).toEqual({
      source: "listings",
      key: "a",
      entries: JSON.parse(
        JSON.stringify(
          explainHistory(
            history,
            new Map([
              [1, V1],
              [2, V2],
            ]),
          ),
        ),
      ),
    });
  });

  it("words each entry under the version in force at the time, oldest first", async () => {
    const { get } = rig(LOG);
    const { body } = await get("/v1/decisions/listings/a");
    expect(body["entries"]).toEqual([
      {
        kind: "answer",
        at: "2026-11-05T12:00:00.000Z",
        model: "jev-1.14.0",
        version: 1,
        answers: [
          {
            question: "is_scam",
            wording: "Is it a scam?",
            said: "90% likely yes",
            decision: "yes",
          },
        ],
      },
      {
        kind: "answer",
        at: "2026-11-05T12:04:00.000Z",
        model: "jev-1.14.0",
        version: 2,
        answers: [
          {
            question: "is_scam",
            wording: "Does the listing look like a scam?",
            said: "95% likely yes",
            decision: "yes",
          },
        ],
      },
    ]);
    const second = await get("/v1/decisions/listings/d");
    expect(second.body["entries"][1]).toEqual({
      kind: "human",
      at: "2026-11-05T12:06:00.000Z",
      version: 2,
      question: "is_scam",
      wording: "Does the listing look like a scam?",
      decided: "no",
      reviewer: "sam",
      note: "checked the seller",
    });
  });

  it("falls back to the question's name for a version the store no longer keeps", async () => {
    const { get } = rig(LOG, { versions: { 1: V1 } });
    const { body } = await get("/v1/decisions/listings/d");
    expect(body["entries"][0]?.answers[0]).toEqual({
      question: "is_scam",
      wording: "is_scam",
      said: "50% likely yes",
      decision: "unknown",
    });
  });

  it("answers 404 with the fix for a record with no history, and for a source it does not have", async () => {
    const { get } = rig(LOG);
    const record = await get("/v1/decisions/listings/zzz");
    expect(record.status).toBe(404);
    expect(record.body["error"]).toEqual({
      code: "unknown_record",
      message: 'FacetDB has no history for record zzz of "listings".',
      fix: "Check the source and the key (it is the table's primary key, as text); if the record is new, start the worker with facetdb worker, or answer existing rows with facetdb backfill.",
    });
    const source = await get("/v1/decisions/orders/a");
    expect(source.status).toBe(404);
    expect(source.body["error"].code).toBe("unknown_source");
    expect((await get("/v1/decisions/listings/a", OTHER_KEY)).status).toBe(404);
    expect((await get("/v1/decisions/listings/a", null)).status).toBe(401);
  });

  it("takes a key with a slash percent-encoded, and a tagged key as the user writes it", async () => {
    const slashed = rig([answered("a/b", 0, 0.9)]);
    expect((await slashed.get("/v1/decisions/listings/a%2Fb")).body["key"]).toBe("a/b");

    const mongo = rig([answered("oid:65f1", 0, 0.9)], { keyText: tagged });
    const { status, body } = await mongo.get("/v1/decisions/listings/65f1");
    expect(status).toBe(200);
    expect(body["key"]).toBe("65f1");
    const missing = await mongo.get("/v1/decisions/listings/0000");
    expect(missing.body["error"].fix).toContain("the document's _id as you write it");
  });
});
