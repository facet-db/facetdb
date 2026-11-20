import { describe, expect, it } from "vitest";
import { SAMPLE_HOME, SAMPLE_PROJECT, SAMPLE_QUEUE } from "../testing/index.ts";
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
});
