import {
  type AnswerEntry,
  answerOutcomes,
  type CurrentDecision,
  chosenWords,
  explainHistory,
  type HumanEntry,
  isHumanDecision,
  type KeyText,
  type LogEntry,
  namedValue,
  type QuestionSet,
  WITHDRAWN,
} from "@facetdb/core";
import type {
  DecisionSearch,
  DecisionSearchPage,
  FoundAnswer,
  FoundDecision,
} from "@facetdb/postgres";
import { sourceIdOf } from "@facetdb/postgres";
import { describe, expect, it } from "vitest";
import { createApp, type StudioAccess } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import { NO_REVIEW } from "../review/no-review.ts";
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

const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };

/** The studio as the reviewer middleware sees it: this machine is the OS user, anyone else signs in. */
function localStudio(projectId: string): StudioAccess {
  return {
    sessions: {
      signIn: () => Promise.reject(new Error("these tests sign nobody in")),
      reviewerFor: ({ local }) =>
        Promise.resolve(
          local ? { kind: "reviewer", name: "os:alex" } : { kind: "sign-in", why: "no-cookie" },
        ),
    },
    reviewers: {
      list: () => Promise.reject(new Error("these tests list no reviewers")),
      add: () => Promise.reject(new Error("these tests add no reviewer")),
      canAdd: () => Promise.resolve(false),
    },
    projectId,
  };
}

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
  test: () => Promise.reject(new Error("these tests test nothing")),
  diff: () => Promise.reject(new Error("these tests apply nothing")),
  apply: () => Promise.reject(new Error("these tests apply nothing")),
  reload: () => Promise.reject(new Error("these tests reload nothing")),
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

/** What the store makes of an entry (decision-log.ts), from the same core functions. */
function foundOf(
  entry: LogEntry,
  set: QuestionSet | undefined,
): Readonly<Record<string, FoundAnswer>> {
  if (entry.kind === "human") {
    const words = isHumanDecision(entry) ? chosenWords(entry.value) : "withdrawn";
    return { [entry.question]: { words, outcome: "decided", value: words } };
  }
  const outcomes = answerOutcomes(entry, set);
  return Object.fromEntries(
    Object.entries(entry.answers).map(([name, answer]) => [
      name,
      {
        words: outcomes[name]?.words ?? "unknown",
        outcome: outcomes[name]?.outcome ?? "unknown",
        value: namedValue(
          set?.questions.find((question) => question.name === name),
          answer,
        ),
      },
    ]),
  );
}

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
        const decisions = foundOf(entry, versions[entry.version]);
        const status = Object.values(decisions).some(
          (decision) => decision.outcome === "needs_review",
        )
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
    /** The records as their source holds them now, by source and key; absent is not running or gone. */
    readonly current?: Readonly<Record<string, CurrentDecision>>;
  } = {},
) {
  const log = fakeStore(rows, options.versions ?? { 1: V1, 2: V2 });
  const currentAsked: string[] = [];
  const appFor = (studioProject: string) =>
    createApp({
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
          current: (source, key) => {
            currentAsked.push(`${source}/${key}`);
            return Promise.resolve(options.current?.[`${source}/${key}`]);
          },
        }),
        home: { home: () => Promise.reject(new Error("these tests read no home")) },
        sources: { sources: () => Promise.reject(new Error("these tests read no sources")) },
        alerts: { alerts: () => Promise.reject(new Error("these tests read no alerts")) },
        access: { access: () => Promise.reject(new Error("these tests read no studio access")) },
      },
      studio: localStudio(studioProject),
      review: NO_REVIEW,
      newRequestId: () => "req-1",
    });
  const app = appFor(PROJECT);
  // A studio wired to another project than the log's, as another project's key once was.
  const other = appFor("another-app");

  // The pages are the studio's: a call from this machine is the OS user's; `null` is a stranger
  // elsewhere with no session.
  async function get(path: string, authorization: string | null = KEY) {
    const response = await (authorization === OTHER_KEY ? other : app).request(
      path,
      { headers: authorization === null ? {} : { authorization } },
      authorization === null ? ELSEWHERE : THIS_MACHINE,
    );
    return { status: response.status, body: (await response.json()) as Reply };
  }

  return { get, searches: log.searches, currentAsked };
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
  it("needs a reviewer, as every studio endpoint under /v1 does", async () => {
    const { get } = rig(LOG);
    const response = await get("/v1/decisions?source=listings", null);
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("sign-in");
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
        answers: {
          is_scam: {
            type: "noul",
            probability: 0.5,
            decision: "needs review",
            outcome: "needs_review",
          },
        },
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
        withdrawn: false,
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
        answers: {
          is_scam: {
            type: "noul",
            probability: 0.5,
            decision: "needs review",
            outcome: "needs_review",
          },
        },
      },
    ]);
    expect(body["next"]).toBeTypeOf("string");
  });

  it("tags each answer's outcome beside its words, names the option or level, and marks an undo", async () => {
    // Options named like the other outcomes: only the tag tells a decided one from the rest.
    const triage: QuestionSet = {
      questions: [
        {
          type: "choice",
          name: "queue",
          instructions: "Which queue should take it?",
          stakes: "low",
          storeProbabilities: false,
          options: [
            { name: "needs review", description: "A person looks first." },
            { name: "withdrawn", description: "The seller took it down." },
          ],
        },
        {
          type: "score",
          name: "urgency",
          instructions: "How urgent is it?",
          stakes: "low",
          levels: [
            { name: "calm", description: "It can wait." },
            { name: "urgent", description: "Today." },
          ],
        },
      ],
      read: ["title"],
      model: "jev-1.14.0",
      thresholds: {},
    };
    const call: AnswerEntry = {
      kind: "answer",
      key: "t",
      version: 1,
      model: "jev-1.14.0",
      stateHash: "hash-t",
      answers: {
        queue: { type: "choice", top: "needs review", probabilities: [0.95, 0.05] },
        urgency: { type: "score", probabilities: [0.1, 0.9], confidence: 0.8, expected: 0.9 },
      },
      usage: { inputTokens: 100, outputTokens: 2 },
      at: at(1),
    };
    const undo: HumanEntry = { ...decidedBy("t", 2, "amara", true), value: WITHDRAWN };
    const { get } = rig([call, undo], { versions: { 1: triage } });
    const { body } = await get("/v1/decisions?source=listings");
    const [withdrawal, answer] = body["decisions"] as Record<string, unknown>[];
    expect(withdrawal).toMatchObject({ kind: "human", decision: "withdrawn", withdrawn: true });
    expect(answer?.["answers"]).toEqual({
      queue: {
        type: "choice",
        top: "needs review",
        probabilities: [0.95, 0.05],
        value: "needs review",
        decision: "needs review",
        outcome: "decided",
      },
      urgency: {
        type: "score",
        probabilities: [0.1, 0.9],
        confidence: 0.8,
        expected: 0.9,
        value: "urgent",
        decision: "urgent",
        outcome: "decided",
      },
    });
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

  it("answers 404 with the fix for a source the project does not have, and for a studio of another project", async () => {
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
      // The source holds no record "a" in this rig: the log alone speaks.
      status: null,
      reviewed: null,
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
        stateHash: "hash-a",
        answers: [
          {
            question: "is_scam",
            wording: "Is it a scam?",
            said: "90% likely yes",
            decision: "yes",
            outcome: "decided",
          },
        ],
      },
      {
        kind: "answer",
        at: "2026-11-05T12:04:00.000Z",
        model: "jev-1.14.0",
        version: 2,
        stateHash: "hash-a",
        answers: [
          {
            question: "is_scam",
            wording: "Does the listing look like a scam?",
            said: "95% likely yes",
            decision: "yes",
            outcome: "decided",
          },
        ],
      },
    ]);
    const second = await get("/v1/decisions/listings/d");
    expect(second.body["entries"][1]).toEqual({
      kind: "human",
      at: "2026-11-05T12:06:00.000Z",
      version: 2,
      stateHash: "hash-d",
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
      outcome: "unknown",
    });
  });

  it("carries the record's status now, read through the source, by the key the source holds", async () => {
    const now: CurrentDecision = {
      decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.5 } },
      status: "done",
      reviewed: true,
      updatedAt: at(6),
    };
    const { get, currentAsked } = rig([answered("oid:65f1", 0, 0.5)], {
      keyText: tagged,
      current: { "listings/oid:65f1": now },
    });
    const { body } = await get("/v1/decisions/listings/65f1");
    expect(currentAsked).toEqual(["listings/oid:65f1"]);
    expect(body).toMatchObject({ key: "65f1", status: "done", reviewed: true });
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

describe("GET /v1/decisions/history?source=&key=", () => {
  it("answers a key of . or .. that no path can hold, with the same body as the path form", async () => {
    const dots = [answered(".", 0, 0.9), answered("..", 1, 0.2), ...LOG];
    const { get } = rig(dots);
    // The path form cannot reach these records: the URL standard resolves the dot segments,
    // percent-encoded or not, before the request is made.
    for (const path of ["/v1/decisions/listings/%2E", "/v1/decisions/listings/%2E%2E"]) {
      const { status, body } = await get(path);
      expect(status, path).not.toBe(200);
      expect(body["key"], path).toBeUndefined();
    }
    for (const key of [".", ".."]) {
      const { status, body } = await get(
        `/v1/decisions/history?source=listings&key=${encodeURIComponent(key)}`,
      );
      expect(status, key).toBe(200);
      expect(body["key"]).toBe(key);
      expect(body["entries"]).toHaveLength(1);
    }
    const byQuery = await get("/v1/decisions/history?source=listings&key=a%2Fb");
    expect(byQuery.status).toBe(404);
    expect(byQuery.body["error"].code).toBe("unknown_record");
    expect((await get("/v1/decisions/history?source=listings&key=a")).body).toEqual(
      (await get("/v1/decisions/listings/a")).body,
    );
  });

  it("asks the same login and refuses a query it cannot read, the same way the path form fails", async () => {
    const { get } = rig(LOG);
    const at = "/v1/decisions/history?source=listings&key=a";
    expect((await get(at, null)).status).toBe(401);
    expect((await get(at, OTHER_KEY)).body["error"].code).toBe("unknown_project");
    const source = await get("/v1/decisions/history?source=orders&key=a");
    expect(source.status).toBe(404);
    expect(source.body["error"].code).toBe("unknown_source");
    for (const query of [
      "source=listings",
      "key=a",
      "source=listings&key=",
      "source=listings&key=a&q=a",
    ]) {
      const { status, body } = await get(`/v1/decisions/history?${query}`);
      expect(status, query).toBe(400);
      expect(body["error"].code).toBe("invalid_request");
      expect(body["error"].fix).toBe("Pass source and key, the record's key as the log shows it.");
    }
  });
});
