import {
  type Answer,
  type AnswerEntry,
  configureAction,
  type LogEntry,
  type Question,
  type QuestionSet,
  REVIEW_LOCK_MS,
  type RecordKey,
  recordAnswer,
  reviewEntryOf,
  stateHash,
} from "@facetdb/core";
import {
  FakeAction,
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { sourceIdOf } from "@facetdb/postgres";
import { describe, expect, it } from "vitest";
import { createApp, type StudioAccess } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import { SESSION_COOKIE } from "../auth/sessions.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import type { DataServices } from "../data/routes.ts";
import { createReviewEndpointService, type ReviewEndpointService } from "./service.ts";

/**
 * The review endpoints through the whole app, on the real review service of core over its
 * fakes (a table, the log, the queue, one recorded action and the fake clock): the shapes of the
 * queue and the card, every refusal in the stable error shape, and the reviewer's name from the
 * session reaching the log entry. The queue's and the service's own rules are proven in core.
 */

const PROJECT = "listings-app";
const SOURCE = "listings";
const SOURCE_ID = sourceIdOf(PROJECT, SOURCE);
const START = Date.parse("2026-11-05T10:00:00Z");
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
/** The OS user of the machine the worker runs on: the reviewer of every request from THIS_MACHINE. */
const OS_REVIEWER = "os:alex";

const scam: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this listing likely a scam?",
  stakes: "low",
};
const team: Question = {
  type: "choice",
  name: "team",
  instructions: "Which team owns this?",
  options: [
    { name: "billing", description: "Money questions" },
    { name: "tech", description: "Technical questions" },
  ],
  stakes: "low",
  storeProbabilities: false,
};
const questionSet: QuestionSet = {
  questions: [scam, team],
  read: ["body"],
  model: "jev-1.14.0",
  thresholds: {},
};
const VERSION = 3;

const UNSURE_SCAM: Answer = { type: "noul", probability: 0.5 };
const LOW_SCAM: Answer = { type: "noul", probability: 0.4 };
const SURE_BILLING: Answer = { type: "choice", top: "billing", probabilities: [0.9, 0.1] };
const UNSURE_TEAM: Answer = { type: "choice", top: "billing", probabilities: [0.6, 0.4] };

const NO_KEYS: ApiKeys = {
  create: () => Promise.reject(new Error("these tests create no key")),
  verify: () => Promise.resolve(undefined),
  revoke: () => Promise.reject(new Error("these tests revoke no key")),
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
  test: () => Promise.reject(new Error("these tests test nothing")),
};
const NO_DATA: DataServices = {
  runs: { list: () => Promise.reject(new Error("these tests read no runs")) },
  decisions: {
    search: () => Promise.reject(new Error("these tests search no decisions")),
    why: () => Promise.reject(new Error("these tests explain no record")),
  },
  home: { home: () => Promise.reject(new Error("these tests read no home")) },
  sources: { sources: () => Promise.reject(new Error("these tests read no sources")) },
};

/**
 * The reviewers of the studio: this machine is the OS user, `maya` signs in by the session cookie
 * from anywhere, and everyone else is asked to sign in.
 */
const studio: StudioAccess = {
  sessions: {
    signIn: () => Promise.reject(new Error("these tests sign nobody in")),
    reviewerFor: ({ local, cookie }) =>
      Promise.resolve(
        cookie === "maya"
          ? { kind: "reviewer", name: "maya" }
          : local
            ? { kind: "reviewer", name: OS_REVIEWER }
            : { kind: "sign-in", why: "no-cookie" },
      ),
  },
  reviewers: {
    list: () => Promise.reject(new Error("these tests list no reviewers")),
    add: () => Promise.reject(new Error("these tests add no reviewer")),
  },
  projectId: PROJECT,
};

type Notify = { readonly to: string };

/** One source behind the endpoints, the world a test sets, and the app that serves it. */
function setup() {
  const clock = new FakeClock(START);
  const db = new FakeDatabase({ fields: ["body"], clock });
  db.install();
  const connector = new FakeConnector(db);
  const log = new FakeDecisionLog();
  const queue = new FakeReviewQueue();
  const notify = new FakeAction<Notify>();
  const review: ReviewEndpointService = createReviewEndpointService({
    projectId: PROJECT,
    sources: [SOURCE],
    queue,
    log: new Map([[SOURCE_ID, log]]),
    connectors: new Map([[SOURCE_ID, connector]]),
    actions: new Map([[SOURCE_ID, [configureAction("notify", notify, { to: "#mods" })]]]),
    questionSets: new Map([[SOURCE_ID, { questionSet, version: VERSION }]]),
    clock,
  });
  const app = createApp({
    keys: NO_KEYS,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: NO_DATA,
    review,
    studio,
    newRequestId: () => "req-1",
  });

  /** As the worker leaves a record: answered, logged, written needs_review, its card queued. */
  async function seed(key: RecordKey, body: string, answers: Record<string, Answer>) {
    db.edit(key, { body });
    const hash = stateHash(["body"], { body });
    const entry: AnswerEntry = {
      kind: "answer",
      key,
      version: VERSION,
      model: "jev-1.14.0",
      stateHash: hash,
      answers,
      usage: { inputTokens: 100, outputTokens: 8 },
      at: new Date(clock.now()),
    };
    const written: Parameters<typeof reviewEntryOf>[0]["decisions"][] = [];
    await recordAnswer(entry, questionSet, log, (k, decision, expected) => {
      written.push(decision.decisions);
      return connector.write(k, decision, expected);
    });
    const [decisions] = written;
    if (decisions === undefined) {
      throw new Error("the seed's answer was not written");
    }
    await queue.upsert({
      source: SOURCE_ID,
      ...reviewEntryOf({ key, stateHash: hash, decisions, answers, since: entry.at }),
    });
    clock.advance(1_000);
    return hash;
  }

  type Peer = typeof THIS_MACHINE;
  type Sent = { readonly status: number; readonly body: unknown; readonly headers: Headers };

  /** A request as `reviewer` makes it: the OS user from this machine, or maya from elsewhere. */
  async function send(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; as?: "os" | "maya" | "nobody" } = {},
  ): Promise<Sent> {
    const as = options.as ?? "os";
    const peer: Peer = as === "os" ? THIS_MACHINE : ELSEWHERE;
    const response = await app.request(
      path,
      {
        method,
        headers: {
          ...(options.body === undefined ? {} : { "content-type": "application/json" }),
          ...(as === "maya" ? { cookie: `${SESSION_COOKIE}=maya` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      },
      peer,
    );
    return {
      status: response.status,
      body: await response.json(),
      headers: response.headers,
    };
  }

  async function history(key: RecordKey): Promise<readonly LogEntry[]> {
    return log.history(key);
  }

  return { clock, db, queue, notify, review, app, seed, send, history };
}

type World = ReturnType<typeof setup>;

const error = (code: string) => ({
  error: { code, message: expect.any(String), fix: expect.any(String) },
});

/** Opens the next card as `as` and returns it, or fails the test. */
async function openCard(t: World, as: "os" | "maya" = "os") {
  const opened = await t.send("POST", "/v1/review/open", { body: {}, as });
  const { card } = opened.body as {
    card: { key: string; stateHash: string; lockedUntil: string } | null;
  };
  if (opened.status !== 200 || card === null) {
    throw new Error(`no card opened: ${opened.status} ${JSON.stringify(opened.body)}`);
  }
  return card;
}

const cardOf = (card: { stateHash: string }) => ({ source: SOURCE, stateHash: card.stateHash });

describe("who may review", () => {
  it("answers a request from elsewhere without a session with the sign-in error, on every route", async () => {
    const t = setup();
    const target = { source: SOURCE, stateHash: "h" };
    const sent = await Promise.all([
      t.send("GET", "/v1/review/queue", { as: "nobody" }),
      t.send("POST", "/v1/review/open", { body: {}, as: "nobody" }),
      t.send("POST", "/v1/review/undo", { as: "nobody" }),
      t.send("POST", "/v1/review/r1/renew", { body: target, as: "nobody" }),
      t.send("POST", "/v1/review/r1/decide", {
        body: { ...target, question: "scam", value: true },
        as: "nobody",
      }),
      t.send("POST", "/v1/review/r1/skip", { body: target, as: "nobody" }),
      t.send("POST", "/v1/review/r1/release", { body: target, as: "nobody" }),
    ]);
    for (const response of sent) {
      expect(response.status).toBe(401);
      expect(response.body).toEqual(error("sign-in"));
    }
  });
});

describe("GET /v1/review/queue", () => {
  it("counts the cards, gives the oldest wait and the first page oldest first, with no record state", async () => {
    const t = setup();
    const h1 = await t.seed("r1", "Cheap car, wire only", {
      scam: UNSURE_SCAM,
      team: SURE_BILLING,
    });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    await t.seed("r3", "A bike", { scam: LOW_SCAM, team: SURE_BILLING });

    const queue = await t.send("GET", "/v1/review/queue?limit=2");

    expect(queue.status).toBe(200);
    expect(queue.body).toEqual({
      count: 3,
      oldestSince: new Date(START).toISOString(),
      oldestWaitMs: 3_000,
      cards: [
        {
          source: SOURCE,
          key: "r1",
          stateHash: h1,
          since: new Date(START).toISOString(),
          skipped: false,
          open: [{ name: "scam", figure: 0.5 }],
        },
        {
          source: SOURCE,
          key: "r2",
          stateHash: stateHash(["body"], { body: "A flat" }),
          since: new Date(START + 1_000).toISOString(),
          skipped: false,
          open: [
            { name: "scam", figure: 0.5 },
            { name: "team", figure: expect.closeTo(0.2, 5) },
          ],
        },
      ],
    });
    expect(JSON.stringify(queue.body)).not.toContain("Cheap car");
  });

  it("answers an empty queue with a zero count and no oldest wait", async () => {
    const t = setup();
    const queue = await t.send("GET", "/v1/review/queue");
    expect(queue.body).toEqual({ count: 0, oldestSince: null, oldestWaitMs: null, cards: [] });
  });

  it("narrows by source, question and the probability band, passed through as the queue reads them", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    await t.seed("r3", "A bike", { scam: LOW_SCAM, team: SURE_BILLING });

    const keysOf = async (query: string) => {
      const { body } = await t.send("GET", `/v1/review/queue${query}`);
      return (body as { cards: { key: string }[] }).cards.map((card) => card.key);
    };

    expect(await keysOf(`?source=${SOURCE}`)).toEqual(["r1", "r2", "r3"]);
    expect(await keysOf("?question=team")).toEqual(["r2"]);
    // Strictly under 0.45: r3's yes probability (0.4) and r2's team confidence (0.2), not r1's 0.5.
    expect(await keysOf("?below=0.45")).toEqual(["r2", "r3"]);
    // With a question, that question's figure alone: strictly under, so 0.2 is not under 0.2.
    expect(await keysOf("?question=team&below=0.25")).toEqual(["r2"]);
    expect(await keysOf("?question=team&below=0.1")).toEqual([]);
    expect(await keysOf("?question=scam&below=0.45")).toEqual(["r3"]);
  });

  it.each([
    ["0", "below"],
    ["1", "below"],
    ["1.5", "below"],
    ["-0.2", "below"],
    ["abc", "below"],
  ])("refuses below=%s with the fix", async (value) => {
    const t = setup();
    const queue = await t.send("GET", `/v1/review/queue?below=${value}`);
    expect(queue.status).toBe(400);
    expect(queue.body).toEqual(error("invalid_request"));
    expect(JSON.stringify(queue.body)).toContain("below");
  });

  it("refuses a limit out of range and a filter it does not know", async () => {
    const t = setup();
    expect((await t.send("GET", "/v1/review/queue?limit=0")).status).toBe(400);
    expect((await t.send("GET", "/v1/review/queue?limit=201")).status).toBe(400);
    const odd = await t.send("GET", "/v1/review/queue?reviewer=maya");
    expect(odd.status).toBe(400);
    expect(odd.body).toEqual(error("invalid_request"));
  });

  it("answers an unknown source or question with 404 and the names it knows", async () => {
    const t = setup();
    const source = await t.send("GET", "/v1/review/queue?source=orders");
    expect(source.status).toBe(404);
    expect(source.body).toEqual({
      error: {
        code: "unknown_source",
        message: 'This project has no source called "orders".',
        fix: "Use one of: listings.",
      },
    });
    const question = await t.send("GET", "/v1/review/queue?source=listings&question=spam");
    expect(question.status).toBe(404);
    expect(question.body).toEqual({
      error: {
        code: "unknown_question",
        message: 'The source "listings" has no question called "spam".',
        fix: "Use one of: scam, team.",
      },
    });
    expect((await t.send("GET", "/v1/review/queue?question=spam")).body).toEqual(
      error("unknown_question"),
    );
  });

  it("hides a card another reviewer holds, and lists the ones this reviewer skipped last", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const held = await openCard(t, "maya");
    expect(held.key).toBe("r1");

    const own = await t.send("GET", "/v1/review/queue");
    expect((own.body as { count: number }).count).toBe(1);
    const maya = await t.send("GET", "/v1/review/queue", { as: "maya" });
    expect((maya.body as { count: number }).count).toBe(2);

    await t.send("POST", "/v1/review/r1/skip", { body: cardOf(held), as: "maya" });
    const after = await t.send("GET", "/v1/review/queue", { as: "maya" });
    expect(
      (after.body as { cards: { key: string; skipped: boolean }[] }).cards.map((card) => [
        card.key,
        card.skipped,
      ]),
    ).toEqual([
      ["r2", false],
      ["r1", true],
    ]);
  });
});

describe("POST /v1/review/open", () => {
  it("gives the oldest card as JSON: state, open questions in words and numbers, decided ones, since, lock expiry", async () => {
    const t = setup();
    const hash = await t.seed("r1", "Cheap car, wire only", {
      scam: UNSURE_SCAM,
      team: SURE_BILLING,
    });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const opened = await t.send("POST", "/v1/review/open", { body: {} });

    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({
      card: {
        source: SOURCE,
        key: "r1",
        stateHash: hash,
        state: { body: "Cheap car, wire only" },
        open: [
          {
            name: "scam",
            type: "noul",
            instructions: "Is this listing likely a scam?",
            said: "50% likely yes",
            figure: 0.5,
            top: "yes",
            options: [
              { name: "yes", probability: 0.5 },
              { name: "no", probability: 0.5 },
            ],
          },
        ],
        decided: [
          {
            name: "team",
            type: "choice",
            instructions: "Which team owns this?",
            value: "billing",
            said: "billing",
          },
        ],
        since: new Date(START).toISOString(),
        lockedUntil: new Date(t.clock.now() + REVIEW_LOCK_MS).toISOString(),
      },
    });
  });

  it("words a choice with its options and their probabilities", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: LOW_SCAM, team: UNSURE_TEAM });
    const { card } = (await t.send("POST", "/v1/review/open", { body: { question: "team" } }))
      .body as { card: { open: unknown[] } };
    expect(card.open).toHaveLength(2);
    expect(card.open[1]).toEqual({
      name: "team",
      type: "choice",
      instructions: "Which team owns this?",
      said: "billing, 20% sure",
      figure: expect.closeTo(0.2, 5),
      top: "billing",
      options: [
        { name: "billing", description: "Money questions", probability: 0.6 },
        { name: "tech", description: "Technical questions", probability: 0.4 },
      ],
    });
  });

  it("answers an empty queue with a null card, not an error", async () => {
    const t = setup();
    const opened = await t.send("POST", "/v1/review/open", { body: {} });
    expect(opened.status).toBe(200);
    expect(opened.body).toEqual({ card: null });
  });

  it("opens under the filter, and never a card another reviewer holds", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A bike", { scam: LOW_SCAM, team: SURE_BILLING });

    const low = await t.send("POST", "/v1/review/open", { body: { below: 0.45 } });
    expect((low.body as { card: { key: string } }).card.key).toBe("r2");
    const other = await t.send("POST", "/v1/review/open", { body: {}, as: "maya" });
    expect((other.body as { card: { key: string } }).card.key).toBe("r1");
    const none = await t.send("POST", "/v1/review/open", { body: { below: 0.45 }, as: "maya" });
    expect(none.body).toEqual({ card: null });
  });

  it("opens a named card under the lock, and refuses one held by someone else with 409", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("a/b c", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const named = await t.send("POST", "/v1/review/open", {
      body: { source: SOURCE, key: "a/b c" },
    });
    expect(named.status).toBe(200);
    expect(named.body).toMatchObject({ card: { key: "a/b c", state: { body: "A flat" } } });

    const taken = await t.send("POST", "/v1/review/open", {
      body: { source: SOURCE, key: "a/b c" },
      as: "maya",
    });
    expect(taken.status).toBe(409);
    expect(taken.body).toEqual({
      error: {
        code: "card_held",
        message: expect.stringContaining(OS_REVIEWER),
        fix: expect.any(String),
      },
    });
    expect(JSON.stringify(taken.body)).not.toContain("A flat");
  });

  it("answers a named card that is not in the queue with 404", async () => {
    const t = setup();
    const missing = await t.send("POST", "/v1/review/open", {
      body: { source: SOURCE, key: "nope" },
    });
    expect(missing.status).toBe(404);
    expect(missing.body).toEqual(error("card_gone"));
  });

  it("refuses a body that is not the shape, each problem with a fix", async () => {
    const t = setup();
    const cases: unknown[] = [
      { key: "r1" },
      { source: SOURCE, key: "r1", below: 0.5 },
      { below: 0 },
      { below: "0.5" },
      { reviewer: "maya" },
      [],
    ];
    for (const body of cases) {
      const opened = await t.send("POST", "/v1/review/open", { body });
      expect(opened.status, JSON.stringify(body)).toBe(400);
      expect(opened.body).toEqual(error("invalid_request"));
    }
    const notJson = await t.app.request(
      "/v1/review/open",
      { method: "POST", body: "{" },
      THIS_MACHINE,
    );
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual(error("invalid_json"));
    expect((await t.send("POST", "/v1/review/open", { body: { source: "orders" } })).body).toEqual(
      error("unknown_source"),
    );
    expect((await t.send("POST", "/v1/review/open", { body: { question: "spam" } })).body).toEqual(
      error("unknown_question"),
    );
  });
});

describe("POST /v1/review/:key/renew", () => {
  it("extends the lock from the server's clock", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    t.clock.advance(60_000);

    const renewed = await t.send("POST", "/v1/review/r1/renew", { body: cardOf(card) });

    expect(renewed.status).toBe(200);
    expect(renewed.body).toEqual({
      lockedUntil: new Date(t.clock.now() + REVIEW_LOCK_MS).toISOString(),
    });
    expect(Date.parse((renewed.body as { lockedUntil: string }).lockedUntil)).toBeGreaterThan(
      Date.parse(card.lockedUntil),
    );
  });

  it("takes no time from the request", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    const forged = await t.send("POST", "/v1/review/r1/renew", {
      body: { ...cardOf(card), nowMs: 0, until: "2099-01-01T00:00:00Z" },
    });
    expect(forged.status).toBe(400);
    expect(forged.body).toEqual(error("invalid_request"));
  });

  it("refuses a card another reviewer holds, and a lock that is gone", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);

    const held = await t.send("POST", "/v1/review/r1/renew", { body: cardOf(card), as: "maya" });
    expect(held.status).toBe(409);
    expect(held.body).toEqual(error("card_held"));

    await t.send("POST", "/v1/review/r1/release", { body: cardOf(card) });
    const lost = await t.send("POST", "/v1/review/r1/renew", { body: cardOf(card) });
    expect(lost.status).toBe(409);
    expect(lost.body).toEqual(error("lock_lost"));

    const gone = await t.send("POST", "/v1/review/zzz/renew", { body: cardOf(card) });
    expect(gone.status).toBe(404);
    expect(gone.body).toEqual(error("card_gone"));
  });

  it("refuses a body without the card's source and state hash", async () => {
    const t = setup();
    const renewed = await t.send("POST", "/v1/review/r1/renew", { body: { source: SOURCE } });
    expect(renewed.status).toBe(400);
    expect(renewed.body).toEqual(error("invalid_request"));
    const unknown = await t.send("POST", "/v1/review/r1/renew", {
      body: { source: "orders", stateHash: "h" },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body).toEqual(error("unknown_source"));
  });
});

describe("POST /v1/review/:key/decide", () => {
  it("writes the decision and logs it under the reviewer's name from the session, with the note", async () => {
    const t = setup();
    const hash = await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const here = await openCard(t);
    const there = await openCard(t, "maya");

    const first = await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(here), question: "scam", value: true, note: "wire only" },
    });
    const second = await t.send("POST", "/v1/review/r2/decide", {
      body: { ...cardOf(there), question: "scam", value: false },
      as: "maya",
    });

    expect(first.status).toBe(200);
    expect(first.body).toEqual({ status: "done", open: [], failedActions: [] });
    expect(second.body).toEqual({ status: "done", open: [], failedActions: [] });
    const human = (await t.history("r1")).at(-1);
    expect(human).toMatchObject({
      kind: "human",
      key: "r1",
      question: "scam",
      value: true,
      reviewer: OS_REVIEWER,
      note: "wire only",
      stateHash: hash,
      version: VERSION,
    });
    expect((await t.history("r2")).at(-1)).toMatchObject({ reviewer: "maya", value: false });
    expect(t.db.decisionOf("r1")?.status).toBe("done");
    expect(t.db.decisionOf("r1")?.reviewed).toBe(true);
    // The actions ran again after the decision, once for each.
    expect(t.notify.calls.map((call) => call.record.key)).toEqual(["r1", "r2"]);
    const queue = await t.send("GET", "/v1/review/queue");
    expect((queue.body as { count: number }).count).toBe(0);
  });

  it("lists the questions still open and keeps the card the reviewer's", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const card = await openCard(t);

    const decided = await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: false },
    });

    expect(decided.body).toEqual({ status: "needs_review", open: ["team"], failedActions: [] });
    const rest = await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "team", value: "tech" },
    });
    expect(rest.body).toEqual({ status: "done", open: [], failedActions: [] });
  });

  it("names an action that failed and keeps the decision, without echoing the failure", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    t.notify.failNextWith(new Error("smtp down while sending Cheap car"));

    const decided = await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: true },
    });

    expect(decided.status).toBe(200);
    expect(decided.body).toEqual({ status: "done", open: [], failedActions: ["notify"] });
    expect(t.db.decisionOf("r1")?.status).toBe("done");
  });

  it("refuses a record changed since the card was opened with 409, logs nothing, and drops the card", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    t.db.edit("r1", { body: "Cheap car, edited" });

    const decided = await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: true },
    });

    expect(decided.status).toBe(409);
    expect(decided.body).toEqual(error("card_stale"));
    expect(JSON.stringify(decided.body)).not.toContain("Cheap car");
    expect((await t.history("r1")).filter((entry) => entry.kind === "human")).toEqual([]);
    const queue = await t.send("GET", "/v1/review/queue");
    expect((queue.body as { count: number }).count).toBe(0);
  });

  it("refuses a state hash the card was not opened at", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await openCard(t);
    const decided = await t.send("POST", "/v1/review/r1/decide", {
      body: { source: SOURCE, stateHash: "an-older-hash", question: "scam", value: true },
    });
    expect(decided.status).toBe(409);
    expect(decided.body).toEqual(error("card_stale"));
    expect((await t.history("r1")).filter((entry) => entry.kind === "human")).toEqual([]);
  });

  it("answers an unknown question with 404 and the questions of the source", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);

    const decided = await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "spam", value: true },
    });

    expect(decided.status).toBe(404);
    expect(decided.body).toEqual({
      error: {
        code: "unknown_question",
        message: 'The source "listings" has no question called "spam".',
        fix: "Use one of: scam, team.",
      },
    });
  });

  it("refuses a value the question does not take, and a question already decided, with 422", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);

    for (const body of [
      { question: "scam", value: "maybe" },
      // Decided by the thresholds already: not open on this card.
      { question: "team", value: "tech" },
    ]) {
      const decided = await t.send("POST", "/v1/review/r1/decide", {
        body: { ...cardOf(card), ...body },
      });
      expect(decided.status, JSON.stringify(body)).toBe(422);
      expect(decided.body).toEqual(error("decision_refused"));
    }
    expect((await t.history("r1")).filter((entry) => entry.kind === "human")).toEqual([]);
  });

  it("refuses a card another reviewer holds, and a card the reviewer no longer holds", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);

    const held = await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: true },
      as: "maya",
    });
    expect(held.status).toBe(409);
    expect(held.body).toEqual(error("card_held"));
    expect(JSON.stringify(held.body)).not.toContain("Cheap car");

    await t.send("POST", "/v1/review/r1/skip", { body: cardOf(card) });
    const lost = await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: true },
    });
    expect(lost.status).toBe(409);
    expect(lost.body).toEqual(error("lock_lost"));
    expect((await t.history("r1")).filter((entry) => entry.kind === "human")).toEqual([]);
  });

  it("lets a lock end on the server's clock, so another reviewer takes the card over", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    t.clock.advance(REVIEW_LOCK_MS + 1_000);
    const taken = await openCard(t, "maya");
    expect(taken.key).toBe("r1");

    const decided = await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: true },
    });
    expect(decided.status).toBe(409);
    expect(decided.body).toEqual(error("card_held"));
  });

  it("reaches the card by a key with characters a path needs escaped", async () => {
    const t = setup();
    await t.seed("a/b c", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);

    const decided = await t.send("POST", `/v1/review/${encodeURIComponent("a/b c")}/decide`, {
      body: { ...cardOf(card), question: "scam", value: true },
    });

    expect(decided.status).toBe(200);
    expect((await t.history("a/b c")).at(-1)).toMatchObject({
      key: "a/b c",
      reviewer: OS_REVIEWER,
    });
  });

  it("refuses a body that is not the shape, each with the fix", async () => {
    const t = setup();
    const base = { source: SOURCE, stateHash: "h", question: "scam", value: true };
    const cases: unknown[] = [
      {},
      { ...base, value: undefined },
      { ...base, value: 1 },
      { ...base, value: "" },
      { ...base, question: "" },
      { ...base, note: 5 },
      { ...base, reviewer: "maya" },
      { source: SOURCE, question: "scam", value: true },
    ];
    for (const body of cases) {
      const decided = await t.send("POST", "/v1/review/r1/decide", { body });
      expect(decided.status, JSON.stringify(body)).toBe(400);
      expect(decided.body).toEqual(error("invalid_request"));
    }
  });

  it("takes an empty note as no note", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: true, note: "  " },
    });
    const human = (await t.history("r1")).at(-1);
    expect(human).toMatchObject({ kind: "human", reviewer: OS_REVIEWER });
    expect(human).not.toHaveProperty("note");
  });
});

describe("skip and release", () => {
  it("skip puts the card behind the rest for this reviewer and frees it for the others", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    expect(card.key).toBe("r1");

    const skipped = await t.send("POST", "/v1/review/r1/skip", { body: cardOf(card) });

    expect(skipped.status).toBe(200);
    expect(skipped.body).toEqual({ skipped: true });
    expect((await openCard(t)).key).toBe("r2");
    expect((await openCard(t, "maya")).key).toBe("r1");
  });

  it("release lets another reviewer open the card at once", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    expect((await t.send("POST", "/v1/review/open", { body: {}, as: "maya" })).body).toEqual({
      card: null,
    });

    const released = await t.send("POST", "/v1/review/r1/release", { body: cardOf(card) });

    expect(released.status).toBe(200);
    expect(released.body).toEqual({ released: true });
    expect((await openCard(t, "maya")).key).toBe("r1");
  });

  it("refuses an unknown source and a body of the wrong shape", async () => {
    const t = setup();
    for (const action of ["skip", "release"]) {
      const unknown = await t.send("POST", `/v1/review/r1/${action}`, {
        body: { source: "orders", stateHash: "h" },
      });
      expect(unknown.status).toBe(404);
      expect(unknown.body).toEqual(error("unknown_source"));
      const odd = await t.send("POST", `/v1/review/r1/${action}`, { body: { source: SOURCE } });
      expect(odd.status).toBe(400);
      expect(odd.body).toEqual(error("invalid_request"));
    }
  });
});

describe("POST /v1/review/undo", () => {
  it("takes back the reviewer's last decision as a logged withdrawal and gives the card back under the lock", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: true },
    });
    expect(t.db.decisionOf("r1")?.status).toBe("done");

    const undone = await t.send("POST", "/v1/review/undo");

    expect(undone.status).toBe(200);
    expect(undone.body).toMatchObject({
      status: "needs_review",
      failedActions: [],
      card: {
        source: SOURCE,
        key: "r1",
        state: { body: "Cheap car" },
        open: [{ name: "scam" }],
      },
    });
    expect(t.db.decisionOf("r1")?.status).toBe("needs_review");
    expect((await t.history("r1")).at(-1)).toMatchObject({
      kind: "human",
      reviewer: OS_REVIEWER,
      value: { withdrawn: true },
    });
    // The actions ran again with the reopened record.
    expect(t.notify.calls.at(-1)?.record.status).toBe("needs_review");
    // Only the last decision, once.
    const again = await t.send("POST", "/v1/review/undo");
    expect(again.status).toBe(409);
    expect(again.body).toEqual(error("nothing_to_undo"));
  });

  it("has nothing to undo for a reviewer who decided nothing, whoever else did", async () => {
    const t = setup();
    expect(await t.send("POST", "/v1/review/undo")).toMatchObject({
      status: 409,
      body: error("nothing_to_undo"),
    });
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: true },
    });

    const maya = await t.send("POST", "/v1/review/undo", { as: "maya" });

    expect(maya.status).toBe(409);
    expect(maya.body).toEqual(error("nothing_to_undo"));
    expect(t.db.decisionOf("r1")?.status).toBe("done");
  });

  it("refuses when the record changed since, and says the decision stands", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    await t.send("POST", "/v1/review/r1/decide", {
      body: { ...cardOf(card), question: "scam", value: true },
    });
    t.db.edit("r1", { body: "Cheap car, edited" });

    const undone = await t.send("POST", "/v1/review/undo");

    expect(undone.status).toBe(409);
    expect(undone.body).toEqual(error("cannot_undo"));
    expect(JSON.stringify(undone.body)).not.toContain("Cheap car");
  });
});

describe("no state for a card the reviewer does not hold", () => {
  it("carries a record's body in no response but the card the reviewer holds", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car, wire only", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await openCard(t);
    const secret = "wire only";

    const others = [
      await t.send("GET", "/v1/review/queue", { as: "maya" }),
      await t.send("POST", "/v1/review/open", { body: {}, as: "maya" }),
      await t.send("POST", "/v1/review/open", { body: { source: SOURCE, key: "r1" }, as: "maya" }),
      await t.send("POST", "/v1/review/r1/renew", { body: cardOf(card), as: "maya" }),
      await t.send("POST", "/v1/review/r1/decide", {
        body: { ...cardOf(card), question: "scam", value: true },
        as: "maya",
      }),
      await t.send("POST", "/v1/review/r1/skip", { body: cardOf(card), as: "maya" }),
      await t.send("POST", "/v1/review/r1/release", { body: cardOf(card), as: "maya" }),
      await t.send("POST", "/v1/review/undo", { as: "maya" }),
      // The holder's own calls that are not the card: the queue lists it without its state, and
      // a decision answers the status alone.
      await t.send("GET", "/v1/review/queue"),
      await t.send("POST", "/v1/review/r1/renew", { body: cardOf(card) }),
      await t.send("POST", "/v1/review/r1/decide", {
        body: { ...cardOf(card), question: "scam", value: true },
      }),
    ];

    for (const response of others) {
      expect(JSON.stringify(response.body)).not.toContain(secret);
    }
    // The decision by maya, who never held the card, changed nothing; the owner's decision did.
    expect((await t.history("r1")).filter((entry) => entry.kind === "human")).toHaveLength(1);
  });
});
