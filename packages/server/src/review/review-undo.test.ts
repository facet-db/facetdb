import {
  type Answer,
  type AnswerEntry,
  configureAction,
  isWithdrawal,
  type LogEntry,
  type Question,
  type QuestionSet,
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
import { SESSION_COOKIE } from "../auth/sessions.ts";
import { createReviewEndpointService } from "./service.ts";

/**
 * Undo through the whole app: `POST /v1/review/undo` names the decision it takes back in a strict
 * body, a card another reviewer holds answers decide's 409, sign-out (`DELETE /v1/session`) leaves
 * the reviewer nothing to undo, and a second session under the same name cannot take back the first
 * one's decision once it made its own.
 */

const PROJECT = "listings-app";
const SOURCE = "listings";
const SOURCE_ID = sourceIdOf(PROJECT, SOURCE);
const START = Date.parse("2026-11-05T10:00:00Z");
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };

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

const UNSURE_SCAM: Answer = { type: "noul", probability: 0.5 };
const SURE_BILLING: Answer = { type: "choice", top: "billing", probabilities: [0.9, 0.1] };
const UNSURE_TEAM: Answer = { type: "choice", top: "billing", probabilities: [0.6, 0.4] };

/**
 * Who a request is: the OS user on this machine with no cookie; `maya` from either of two
 * sessions (two tabs or devices: the cookie is a signature of name and expiry, so two sign-ins give
 * two cookies of one name); `lee` from his; and `forged`, a cookie no account signed.
 */
const COOKIES: Readonly<Record<string, string>> = {
  "maya-laptop": "maya",
  "maya-phone": "maya",
  lee: "lee",
};
type Who = "os" | "maya-laptop" | "maya-phone" | "lee" | "forged";

const studio: StudioAccess = {
  sessions: {
    signIn: () => Promise.reject(new Error("these tests sign nobody in")),
    reviewerFor: ({ local, cookie }) => {
      if (cookie === undefined) {
        return Promise.resolve(
          local ? { kind: "reviewer", name: "os:alex" } : { kind: "sign-in", why: "no-cookie" },
        );
      }
      const name = COOKIES[cookie];
      return Promise.resolve(
        name === undefined ? { kind: "sign-in", why: "invalid" } : { kind: "reviewer", name },
      );
    },
  },
  reviewers: {
    list: () => Promise.reject(new Error("these tests list no reviewers")),
    add: () => Promise.reject(new Error("these tests add no reviewer")),
    canAdd: () => Promise.resolve(false),
  },
  projectId: PROJECT,
  operatorByAddress: true,
  log: () => undefined,
};

type Notify = { readonly to: string };

function setup() {
  const clock = new FakeClock(START);
  const db = new FakeDatabase({ fields: ["body"], clock });
  db.install();
  const connector = new FakeConnector(db);
  const log = new FakeDecisionLog();
  const queue = new FakeReviewQueue();
  const notify = new FakeAction<Notify>();
  const review = createReviewEndpointService({
    projectId: PROJECT,
    sources: () => [SOURCE],
    queue,
    log: new Map([[SOURCE_ID, log]]),
    connectors: new Map([[SOURCE_ID, connector]]),
    actions: new Map([[SOURCE_ID, [configureAction("notify", notify, { to: "#mods" })]]]),
    questionSets: new Map([[SOURCE_ID, { questionSet, version: 3 }]]),
    clock,
  });
  const unused = (what: string) => () => Promise.reject(new Error(`these tests ${what}`));
  const app = createApp({
    keys: {
      create: unused("create no key"),
      verify: () => Promise.resolve(undefined),
      revoke: unused("revoke no key"),
    },
    check: { check: unused("make no check call") },
    config: {
      json: () => {
        throw new Error("these tests read no config");
      },
      validate: () => {
        throw new Error("these tests validate no draft");
      },
      preview: unused("preview nothing"),
      test: unused("test nothing"),
      diff: unused("apply nothing"),
      apply: unused("apply nothing"),
      reload: unused("reload nothing"),
    },
    data: {
      runs: { list: unused("read no runs") },
      decisions: { search: unused("search no decisions"), why: unused("explain no record") },
      home: { home: unused("read no home") },
      sources: { sources: unused("read no sources") },
      alerts: { alerts: unused("read no alerts") },
      access: { access: unused("read no studio access") },
    },
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
      version: 3,
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

  /** A request as `who` makes it, from the studio's own page: the OS user here, a session elsewhere. */
  async function send(
    method: "POST" | "DELETE",
    path: string,
    who: Who,
    body?: unknown,
  ): Promise<{ readonly status: number; readonly body: unknown }> {
    const response = await app.request(
      path,
      {
        method,
        headers: {
          "content-type": "application/json",
          ...(who === "os" ? {} : { cookie: `${SESSION_COOKIE}=${who}` }),
        },
        body: JSON.stringify(body ?? {}),
      },
      who === "os" ? THIS_MACHINE : ELSEWHERE,
    );
    return { status: response.status, body: await response.json() };
  }

  /** Opens the card of `key` as `who`, or fails the test. */
  async function open(who: Who, key: RecordKey) {
    const opened = await send("POST", "/v1/review/open", who, { source: SOURCE, key });
    const { card } = opened.body as { card: { key: string; stateHash: string } | null };
    if (opened.status !== 200 || card === null) {
      throw new Error(`no card opened: ${opened.status} ${JSON.stringify(opened.body)}`);
    }
    return card;
  }

  const decide = (who: Who, card: { key: string; stateHash: string }, question: string) =>
    send("POST", `/v1/review/${card.key}/decide`, who, {
      source: SOURCE,
      stateHash: card.stateHash,
      question,
      value: question === "scam" ? true : "tech",
    });

  const undo = (who: Who, card: { key: string; stateHash: string }, question: string) =>
    send("POST", "/v1/review/undo", who, {
      source: SOURCE,
      key: card.key,
      stateHash: card.stateHash,
      question,
    });

  async function withdrawals(key: RecordKey): Promise<number> {
    const history: readonly LogEntry[] = await log.history(key);
    return history.filter((entry) => entry.kind === "human" && isWithdrawal(entry.value)).length;
  }

  return { db, notify, seed, send, open, decide, undo, withdrawals };
}

const error = (code: string) => ({
  error: { code, message: expect.any(String), fix: expect.any(String) },
});

describe("POST /v1/review/undo: the body names the decision", () => {
  it("refuses a body that does not name a card and a question, and shows the shape in the fix", async () => {
    const t = setup();
    const hash = await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const named = { source: SOURCE, key: "r1", stateHash: hash, question: "scam" };
    const { question: _question, ...noQuestion } = named;

    for (const body of [{}, noQuestion, { ...named, key: "" }, { ...named, value: true }]) {
      const refused = await t.send("POST", "/v1/review/undo", "os", body);
      expect(refused, JSON.stringify(body)).toMatchObject({
        status: 400,
        body: {
          error: {
            code: "invalid_request",
            fix: 'Send {"source", "key", "stateHash", "question"}: the card and the question of your last decision, as the card said them.',
          },
        },
      });
    }
    expect(await t.send("POST", "/v1/review/undo", "os", { ...named, source: "orders" })).toEqual({
      status: 404,
      body: error("unknown_source"),
    });
  });
});

describe("a card another reviewer holds", () => {
  it("answers the 409 decide answers for a held card, writes nothing, and the undo lands once they let go", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const card = await t.open("os", "r1");
    expect(await t.decide("os", card, "scam")).toMatchObject({ status: 200 });
    await t.send("POST", "/v1/review/r1/release", "os", {
      source: SOURCE,
      stateHash: card.stateHash,
    });
    await t.open("lee", "r1");
    const notified = t.notify.calls.length;

    const undone = await t.undo("os", card, "scam");
    const decided = await t.decide("os", card, "team");

    expect(undone).toEqual({ status: 409, body: error("card_held") });
    // The same words as decide's for a held card.
    expect(undone.body).toEqual(decided.body);
    expect(JSON.stringify(undone.body)).toContain("lee is reviewing this card");
    expect(await t.withdrawals("r1")).toBe(0);
    expect(t.db.decisionOf("r1")?.decisions["scam"]).toMatchObject({ value: true });
    expect(t.notify.calls).toHaveLength(notified);

    await t.send("POST", "/v1/review/r1/release", "lee", {
      source: SOURCE,
      stateHash: card.stateHash,
    });
    expect(await t.undo("os", card, "scam")).toMatchObject({
      status: 200,
      body: { status: "needs_review", card: { key: "r1" } },
    });
    expect(await t.withdrawals("r1")).toBe(1);
  });
});

describe("DELETE /v1/session", () => {
  it("leaves the reviewer it signs out nothing to undo, from any of their sessions", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const card = await t.open("maya-laptop", "r1");
    expect(await t.decide("maya-laptop", card, "scam")).toMatchObject({ status: 200 });

    expect(await t.send("DELETE", "/v1/session", "maya-laptop")).toEqual({
      status: 200,
      body: { signedOut: true },
    });

    // The cookie is a signature that cannot be taken back, so the other session still gets in; it
    // finds nothing to undo, and neither would the laptop after signing in again.
    expect(await t.undo("maya-phone", card, "scam")).toEqual({
      status: 409,
      body: error("nothing_to_undo"),
    });
    expect(t.db.decisionOf("r1")?.status).toBe("done");
    expect(await t.withdrawals("r1")).toBe(0);
  });

  it("forgets nobody's for a request with no session or a session that does not hold", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const oss = await t.open("os", "r1");
    const mayas = await t.open("maya-laptop", "r2");
    await t.decide("os", oss, "scam");
    await t.decide("maya-laptop", mayas, "scam");

    // The OS user on this machine has no session to end; a cookie nobody signed names nobody.
    expect(await t.send("DELETE", "/v1/session", "os")).toMatchObject({ status: 200 });
    expect(await t.send("DELETE", "/v1/session", "forged")).toMatchObject({ status: 200 });

    expect(await t.undo("os", oss, "scam")).toMatchObject({ status: 200 });
    expect(await t.undo("maya-laptop", mayas, "scam")).toMatchObject({ status: 200 });
  });
});

describe("a second session under the same name", () => {
  it("cannot take back the first one's decision once it made its own", async () => {
    const t = setup();
    await t.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await t.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const laptops = await t.open("maya-laptop", "r1");
    await t.decide("maya-laptop", laptops, "scam");
    const phones = await t.open("maya-phone", "r2");
    await t.decide("maya-phone", phones, "scam");

    const laptop = await t.undo("maya-laptop", laptops, "scam");

    expect(laptop).toEqual({ status: 409, body: error("cannot_undo") });
    expect(JSON.stringify(laptop.body)).toContain(
      "Nothing was undone: that decision is not your last one",
    );
    expect(t.db.decisionOf("r1")?.status).toBe("done");
    expect(await t.withdrawals("r1")).toBe(0);
    // The phone's own decision is still its to take back: the refusal spent nothing.
    expect(await t.undo("maya-phone", phones, "scam")).toMatchObject({ status: 200 });
    expect(t.db.decisionOf("r2")?.status).toBe("needs_review");
  });
});
