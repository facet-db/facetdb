import type { ProviderRequest, Question } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import {
  ModelUnreachableError,
  RequestRejectedError,
  RetryableError,
  UnexpectedStatusError,
} from "../errors.ts";
import { createTypeSafeProvider } from "./client.ts";

const questions: readonly Question[] = [
  {
    type: "noul",
    name: "scam",
    instructions: "Is this listing a scam?",
    criteria: { true: "asks for payment outside the platform" },
    stakes: "high",
  },
  {
    type: "choice",
    name: "category",
    instructions: "What is being sold?",
    options: [
      { name: "car", description: "a road vehicle" },
      { name: "bike", description: "a bicycle" },
    ],
    stakes: "low",
    storeProbabilities: false,
  },
  {
    type: "score",
    name: "urgency",
    instructions: "How urgent is the sale?",
    levels: [{ name: "low" }, { name: "high", description: "must sell today" }],
    stakes: "low",
  },
];

const request: ProviderRequest = {
  model: "jev-1.14.0",
  state: { title: "Cheap car", body: "Pay by gift card" },
  questions,
};

const goodBody = {
  model: "jev-1.14.0",
  answers: {
    scam: { noul: 0.93 },
    category: { choice: "car", confidence: 0.8, probabilities: { car: 0.8, bike: 0.2 } },
    urgency: {
      score: 0.7,
      confidence: 0.6,
      legend: ["low", "high"],
      probabilities: { "0": 0.3, "1": 0.7 },
    },
  },
  usage: { input_tokens: 321, output_tokens: 12 },
};

type Seen = { url: string; init: RequestInit };

function setup(respond: () => Response | Promise<Response>, clock = new FakeClock(0)) {
  const seen: Seen[] = [];
  const fetchFake = ((url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return Promise.resolve(respond());
  }) as typeof fetch;
  const provider = createTypeSafeProvider({ apiKey: "sk-test-key", fetch: fetchFake, clock });
  return { provider, seen, clock };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

describe("typesafe client", () => {
  it("posts once to /v1/systemone with the bearer key and the exact payload", async () => {
    const { provider, seen } = setup(() => json(200, goodBody));
    await provider.ask(request);
    expect(seen).toHaveLength(1);
    const call = seen[0];
    expect(call?.url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.headers).toEqual({
      authorization: "Bearer sk-test-key",
      "content-type": "application/json",
    });
    expect(JSON.parse(String(call?.init.body))).toEqual({
      model: "jev-1.14.0",
      state: { title: "Cheap car", body: "Pay by gift card" },
      questions: {
        scam: {
          type: "noul",
          instructions: "Is this listing a scam?",
          criteria: { true: "asks for payment outside the platform" },
        },
        category: {
          type: "choice",
          instructions: "What is being sold?",
          criteria: { car: "a road vehicle", bike: "a bicycle" },
        },
        urgency: {
          type: "score",
          instructions: "How urgent is the sale?",
          criteria: ["low", "must sell today"],
        },
      },
    });
  });

  it("uses another base URL when given one", async () => {
    const seen: string[] = [];
    const provider = createTypeSafeProvider({
      apiKey: "k",
      baseUrl: "http://localhost:11434/",
      clock: new FakeClock(0),
      fetch: ((url: string | URL | Request) => {
        seen.push(String(url));
        return Promise.resolve(json(200, goodBody));
      }) as typeof fetch,
    });
    await provider.ask(request);
    expect(seen).toEqual(["http://localhost:11434/v1/systemone"]);
  });

  it("returns the parsed answers and the tokens the call used", async () => {
    const { provider } = setup(() => json(200, goodBody));
    const response = await provider.ask(request);
    expect(response.usage).toEqual({ inputTokens: 321, outputTokens: 12 });
    expect(response.answers).toEqual({
      scam: { type: "noul", probability: 0.93 },
      category: { type: "choice", top: "car", probabilities: [0.8, 0.2] },
      urgency: { type: "score", probabilities: [0.3, 0.7], confidence: 0.6, expected: 0.7 },
    });
  });

  it("refuses a response that does not match the API instead of defaulting", async () => {
    const { provider } = setup(() => json(200, { ...goodBody, usage: undefined }));
    await expect(provider.ask(request)).rejects.toThrow(/usage/);
    const bad = setup(() => json(200, { ...goodBody, answers: { ...goodBody.answers, scam: {} } }));
    await expect(bad.provider.ask(request)).rejects.toThrow(/answers\.scam/);
  });

  it.each([400, 401, 413, 415, 422])(
    "maps %i to a rejection that is not retried",
    async (status) => {
      const { provider, seen } = setup(() => json(status, { detail: "nope" }));
      const error = await provider.ask(request).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(RequestRejectedError);
      expect((error as RequestRejectedError).status).toBe(status);
      expect(seen).toHaveLength(1);
    },
  );

  it("carries the offending field from a 422 detail", async () => {
    const { provider } = setup(() =>
      json(422, { detail: [{ loc: ["body", "questions", "scam", "criteria"], msg: "too long" }] }),
    );
    const error = (await provider.ask(request).catch((e: unknown) => e)) as RequestRejectedError;
    expect(error).toBeInstanceOf(RequestRejectedError);
    expect(error.field).toBe("questions.scam.criteria");
    expect(error.message).toContain("too long");
  });

  it("keeps a plain-text rejection body as the message", async () => {
    const { provider } = setup(() => new Response("bad bytes", { status: 415 }));
    const error = (await provider.ask(request).catch((e: unknown) => e)) as RequestRejectedError;
    expect(error.message).toBe("bad bytes");
    expect(error.field).toBeUndefined();
  });

  it("maps 429 with retry-after: 2 to RetryableError with 2000 ms", async () => {
    const { provider, seen } = setup(() => json(429, {}, { "retry-after": "2" }));
    const error = (await provider.ask(request).catch((e: unknown) => e)) as RetryableError;
    expect(error).toBeInstanceOf(RetryableError);
    expect(error.status).toBe(429);
    expect(error.retryAfterMs).toBe(2000);
    expect(seen).toHaveLength(1);
  });

  it("maps 529 without retry-after to RetryableError with no wait", async () => {
    const { provider, seen } = setup(() => json(529, {}));
    const error = (await provider.ask(request).catch((e: unknown) => e)) as RetryableError;
    expect(error).toBeInstanceOf(RetryableError);
    expect(error.status).toBe(529);
    expect(error.retryAfterMs).toBeUndefined();
    expect(seen).toHaveLength(1);
  });

  it("measures an HTTP-date retry-after against the injected clock", async () => {
    const clock = new FakeClock(Date.parse("2026-10-31T10:00:00Z"));
    const { provider } = setup(
      () => json(429, {}, { "retry-after": "Sat, 31 Oct 2026 10:00:05 GMT" }),
      clock,
    );
    const error = (await provider.ask(request).catch((e: unknown) => e)) as RetryableError;
    expect(error.retryAfterMs).toBe(5000);
  });

  it("does not retry, wait or sleep inside the client", async () => {
    const { provider, seen, clock } = setup(() => json(429, {}, { "retry-after": "2" }));
    await provider.ask(request).catch(() => undefined);
    expect(seen).toHaveLength(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("maps any other status to an unexpected-status error, never an answer", async () => {
    const { provider } = setup(() => json(503, {}));
    const error = await provider.ask(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnexpectedStatusError);
    expect((error as UnexpectedStatusError).status).toBe(503);
  });

  it("maps a failed connection to an unreachable error", async () => {
    const { provider } = setup(() => {
      throw new TypeError("fetch failed");
    });
    const error = await provider.ask(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ModelUnreachableError);
  });

  it("never puts the key in an error message", async () => {
    for (const status of [401, 429, 503]) {
      const { provider } = setup(() => json(status, { detail: "denied" }));
      const error = (await provider.ask(request).catch((e: unknown) => e)) as Error;
      expect(error.message).not.toContain("sk-test-key");
    }
  });
});
