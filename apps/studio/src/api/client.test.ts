import { describe, expect, it } from "vitest";
import {
  SAMPLE_BACKFILL_IDLE,
  SAMPLE_CARD,
  SAMPLE_HOME,
  SAMPLE_PROJECT,
  SAMPLE_QUEUE,
  sampleBackfill,
} from "../testing/index.ts";
import { ApiError, createApiClient, type Fetch, needsSignIn } from "./client.ts";

/**
 * The API client over a handwritten `fetch`: the paths and bodies it sends, zod on every answer,
 * and the surface's error shape turned into an ApiError with its code and fix.
 */

function recording(answer: (path: string) => Response) {
  const sent: { readonly path: string; readonly init: RequestInit | undefined }[] = [];
  const fetch: Fetch = (path, init) => {
    sent.push({ path, init });
    return Promise.resolve(answer(path));
  };
  return { sent, fetch };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("the API client", () => {
  it("asks the surface's paths and returns the parsed answers", async () => {
    const answers: Record<string, unknown> = {
      "/v1/project": SAMPLE_PROJECT,
      "/v1/review/queue?limit=1": SAMPLE_QUEUE,
      "/v1/home": { ...SAMPLE_HOME, later: { today: 12_480 } },
    };
    const t = recording((path) => json(answers[path]));
    const api = createApiClient(t.fetch);

    expect(await api.project()).toEqual(SAMPLE_PROJECT);
    expect((await api.reviewQueue()).count).toBe(37);
    // A field the studio does not read yet is dropped, never refused.
    expect(await api.home()).toEqual(SAMPLE_HOME);
    expect(t.sent.map((one) => [one.init?.method, one.path])).toEqual([
      ["GET", "/v1/project"],
      ["GET", "/v1/review/queue?limit=1"],
      ["GET", "/v1/home"],
    ]);
  });

  it("signs in with a JSON body and signs out", async () => {
    const t = recording((path) =>
      path === "/v1/session"
        ? json({ reviewer: "maya", expiresAt: "2026-11-06T02:00:00.000Z" })
        : json({}),
    );
    const api = createApiClient(t.fetch);
    expect((await api.signIn("maya", "a long enough password")).reviewer).toBe("maya");
    const [sent] = t.sent;
    expect(sent?.init?.method).toBe("POST");
    expect(sent?.init?.body).toBe('{"name":"maya","password":"a long enough password"}');
    expect(new Headers(sent?.init?.headers).get("content-type")).toBe("application/json");

    const out = recording(() => json({ signedOut: true }));
    await createApiClient(out.fetch).signOut();
    expect(out.sent.map((one) => [one.init?.method, one.path])).toEqual([
      ["DELETE", "/v1/session"],
    ]);
    // A write with nothing to say still sends `{}` declared as JSON, which the surface asks of
    // every write; a read sends neither.
    expect(out.sent[0]?.init?.body).toBe("{}");
    expect(new Headers(out.sent[0]?.init?.headers).get("content-type")).toBe("application/json");
    const read = recording(() => json(SAMPLE_PROJECT));
    await createApiClient(read.fetch).project();
    expect(read.sent[0]?.init?.body).toBeUndefined();
    expect(new Headers(read.sent[0]?.init?.headers).get("content-type")).toBeNull();
  });

  it("turns the surface's refusal into an ApiError with its code, words and fix", async () => {
    const t = recording(() =>
      json(
        {
          error: {
            code: "sign-in",
            message: "This request is not signed in.",
            fix: "Sign in with POST /v1/session.",
          },
        },
        401,
      ),
    );
    const failure = await createApiClient(t.fetch)
      .project()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({
      status: 401,
      code: "sign-in",
      message: "This request is not signed in.",
      fix: "Sign in with POST /v1/session.",
    });
    expect(needsSignIn(failure)).toBe(true);
    expect(needsSignIn(new Error("offline"))).toBe(false);
  });

  it("refuses an answer that is not JSON, or not the shape it expects, in words", async () => {
    const html = recording(() => new Response("<!doctype html>", { status: 200 }));
    await expect(createApiClient(html.fetch).project()).rejects.toMatchObject({
      code: "unreadable",
    });
    const wrong = recording(() => json({ project: "" }));
    await expect(createApiClient(wrong.fetch).project()).rejects.toMatchObject({
      code: "unexpected-answer",
    });
    const bare = recording(() => json({ nope: true }, 500));
    await expect(createApiClient(bare.fetch).home()).rejects.toMatchObject({
      status: 500,
      code: "unreadable",
    });
  });
});

describe("the review calls", () => {
  const card = { source: "support_messages", key: "a/b 1", stateHash: "h-1" };
  const named = '{"source":"support_messages","stateHash":"h-1"}';

  it("narrows the queue and opens by filter, sending only what is set", async () => {
    const t = recording((path) =>
      path.startsWith("/v1/review/queue") ? json(SAMPLE_QUEUE) : json({ card: null }),
    );
    const api = createApiClient(t.fetch);
    await api.reviewQueue({ limit: 1, source: "listings", below: 0.6 });
    expect(await api.reviewOpen({ source: "listings", question: "is_scam" })).toEqual({
      card: null,
    });
    expect(await api.reviewOpen()).toEqual({ card: null });
    expect(t.sent.map((one) => [one.init?.method, one.path, one.init?.body])).toEqual([
      ["GET", "/v1/review/queue?limit=1&source=listings&below=0.6", undefined],
      ["POST", "/v1/review/open", '{"source":"listings","question":"is_scam"}'],
      ["POST", "/v1/review/open", "{}"],
    ]);
  });

  it("names a card by its key in the path and its source and state hash in the body", async () => {
    const answers: Record<string, unknown> = {
      renew: { lockedUntil: "2026-11-06T12:11:00.000Z" },
      decide: { status: "needs_review", open: ["q"], failedActions: [] },
      skip: { skipped: true },
      release: { released: true },
    };
    const t = recording((path) => json(answers[path.split("/").at(-1) ?? ""]));
    const api = createApiClient(t.fetch);
    await api.reviewRenew(card);
    await api.reviewDecide(card, { question: "q", value: true, note: "n" });
    await api.reviewSkip(card);
    await api.reviewRelease(card);
    expect(t.sent.map((one) => [one.path, one.init?.body])).toEqual([
      ["/v1/review/a%2Fb%201/renew", named],
      [
        "/v1/review/a%2Fb%201/decide",
        '{"source":"support_messages","stateHash":"h-1","question":"q","value":true,"note":"n"}',
      ],
      ["/v1/review/a%2Fb%201/skip", named],
      ["/v1/review/a%2Fb%201/release", named],
    ]);
    // Only the release asks the browser to finish it after the page is gone.
    expect(t.sent.map((one) => one.init?.keepalive === true)).toEqual([false, false, false, true]);
  });

  it("undoes with an empty body and refuses an answer that is not a card", async () => {
    const t = recording(() => json({ status: "needs_review", card: null, failedActions: [] }));
    expect(await createApiClient(t.fetch).reviewUndo()).toEqual({
      status: "needs_review",
      card: null,
      failedActions: [],
    });
    expect(t.sent.map((one) => [one.init?.method, one.path, one.init?.body])).toEqual([
      ["POST", "/v1/review/undo", "{}"],
    ]);
    const wrong = recording(() => json({ card: { source: "x" } }));
    await expect(createApiClient(wrong.fetch).reviewOpen()).rejects.toMatchObject({
      code: "unexpected-answer",
    });
  });

  it("reads the fleet's sources off the queue, and each question's stakes and thresholds off the card", async () => {
    const t = recording((path) =>
      path.startsWith("/v1/review/queue") ? json(SAMPLE_QUEUE) : json({ card: SAMPLE_CARD }),
    );
    const api = createApiClient(t.fetch);
    expect((await api.reviewQueue()).sources).toEqual(SAMPLE_QUEUE.sources);
    expect(await api.reviewOpen()).toEqual({ card: SAMPLE_CARD });

    // Thresholds of a kind the studio cannot word are refused, never shown as something else.
    const [first] = SAMPLE_CARD.open;
    const unknown = { ...SAMPLE_CARD, open: [{ ...first, thresholds: { kind: "always" } }] };
    const wrong = recording(() => json({ card: unknown }));
    await expect(createApiClient(wrong.fetch).reviewOpen()).rejects.toMatchObject({
      code: "unexpected-answer",
    });
    // A queue from a worker that lists no fleet is refused too: the filters are built from it.
    const { sources: _sources, ...bare } = SAMPLE_QUEUE;
    const old = recording(() => json(bare));
    await expect(createApiClient(old.fetch).reviewQueue()).rejects.toMatchObject({
      code: "unexpected-answer",
    });
  });
});

describe("the backfill calls", () => {
  it("names the source in the path, sends the questions and the token, and parses each state", async () => {
    const waiting = sampleBackfill("waiting", { token: "token-1" });
    const answers: Record<string, [unknown, number]> = {
      backfill: [SAMPLE_BACKFILL_IDLE, 200],
      // The estimate answers 202: the count runs on.
      estimate: [sampleBackfill("estimating", { surveyed: 0, estimate: null }), 202],
      start: [sampleBackfill("running"), 200],
      stop: [sampleBackfill("stopping"), 200],
    };
    const t = recording((path) => {
      const [body, status] = answers[path.split("/").at(-1) ?? ""] ?? [waiting, 200];
      return json(body, status);
    });
    const api = createApiClient(t.fetch);

    expect((await api.backfillStatus("a/b 1")).state).toBe("idle");
    expect((await api.backfillEstimate("a/b 1")).state).toBe("estimating");
    expect((await api.backfillEstimate("a/b 1", ["is_vehicle", "colour"])).surveyed).toBe(0);
    expect((await api.backfillStart("a/b 1", "token-1")).state).toBe("running");
    expect((await api.backfillStop("a/b 1")).state).toBe("stopping");
    expect(t.sent.map((one) => [one.init?.method, one.path, one.init?.body])).toEqual([
      ["GET", "/v1/sources/a%2Fb%201/backfill", undefined],
      ["POST", "/v1/sources/a%2Fb%201/backfill/estimate", "{}"],
      ["POST", "/v1/sources/a%2Fb%201/backfill/estimate", '{"questions":["is_vehicle","colour"]}'],
      ["POST", "/v1/sources/a%2Fb%201/backfill/start", '{"token":"token-1"}'],
      ["POST", "/v1/sources/a%2Fb%201/backfill/stop", "{}"],
    ]);

    // A state this studio does not know, or a figure out of range, is refused at the boundary.
    const unknown = recording(() => json({ ...SAMPLE_BACKFILL_IDLE, state: "resumed" }));
    await expect(createApiClient(unknown.fetch).backfillStatus("listings")).rejects.toMatchObject({
      code: "unexpected-answer",
    });
    const negative = recording(() => json(sampleBackfill("running", { pace: 0 })));
    await expect(createApiClient(negative.fetch).backfillStatus("listings")).rejects.toMatchObject({
      code: "unexpected-answer",
    });
  });

  it("turns the worker's refusals into the error with its code and fix", async () => {
    const t = recording(() =>
      json(
        {
          error: {
            code: "no_estimate",
            message:
              'No estimate of a backfill of "listings" is waiting to be started, so nothing was started.',
            fix: "Ask for a new estimate (POST /v1/sources/listings/backfill/estimate), look at the cost, then start it with the token it gives.",
          },
        },
        409,
      ),
    );
    const refused = createApiClient(t.fetch).backfillStart("listings", "token-9");
    await expect(refused).rejects.toBeInstanceOf(ApiError);
    await expect(refused).rejects.toMatchObject({
      status: 409,
      code: "no_estimate",
      fix: expect.stringMatching(/^Ask for a new estimate/),
    });
  });
});
