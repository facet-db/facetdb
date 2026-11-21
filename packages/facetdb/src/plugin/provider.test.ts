import type { ProviderRequest, ProviderResponse, Question } from "@facetdb/core";
import { ModelNotPinnedError, RetryableError } from "@facetdb/model";
import { describe, expect, it } from "vitest";
import { env, facetdb, noul, type ProjectConfig, pluginProviderOf } from "../config/index.ts";
import { VERSION } from "../index.ts";
import { definePlugin, type Plugin } from "./define.ts";
import { createPluginHost } from "./host.ts";
import { provider } from "./kinds.ts";
import { createPluginProvider, PluginProviderFailure } from "./provider.ts";
import { z } from "./zod.ts";

/**
 * A plugin's provider is third-party code: what it returns goes through core's own parser, the one
 * an HTTP provider's response goes through, a 429 or 529 reaches the backoff as the same
 * `RetryableError`, an alias is refused before the plugin is asked, and a plugin that holds a
 * secret never has its own words printed.
 */

const TOKEN = "acme-s3cret-token-value";

const QUESTIONS: readonly Question[] = [
  { type: "noul", name: "scam", instructions: "Is this a scam?", stakes: "high" },
  {
    type: "choice",
    name: "kind",
    instructions: "Which kind is it?",
    options: [
      { name: "spam", description: "unwanted" },
      { name: "ham", description: "wanted" },
    ],
    stakes: "low",
    storeProbabilities: false,
  },
  {
    type: "score",
    name: "urgency",
    instructions: "How urgent?",
    levels: [{ name: "low" }, { name: "mid" }, { name: "high" }],
    stakes: "low",
  },
];

const request: ProviderRequest = {
  model: "jev-1.14.0",
  state: { body: "Pay by gift card" },
  questions: QUESTIONS,
};

/** A good answer to every question; a test changes the one thing it is about. */
const GOOD = {
  model: "jev-1.14.0",
  answers: {
    scam: { type: "noul", probability: 0.9 },
    kind: { type: "choice", top: "spam", probabilities: [0.99, 0.01] },
    urgency: { type: "score", probabilities: [0.1, 0.2, 0.7], confidence: 0.7, expected: 1.6 },
  },
  usage: { inputTokens: 40, outputTokens: 0 },
};

type Reply = (request: ProviderRequest) => unknown;

/** A plugin whose one provider replies as `behave.current` says; `secret` gives it a declared secret. */
function pluginWith(name: string, behave: { current: Reply }, secret: boolean): Plugin {
  return definePlugin({
    name,
    version: "1.0.0",
    facetdb: "*",
    config: z.object(secret ? { token: z.secret() } : {}),
    providers: {
      echo: provider({
        config: z.object({}),
        ask: async (_ctx, asked) => behave.current(asked) as ProviderResponse,
      }),
    },
  });
}

async function providerOf(behave: { current: Reply }, secret = true) {
  const name = secret ? "acme" : "plain";
  const plugin = pluginWith(name, behave, secret);
  const chosen = `${name}/echo`;
  const config: ProjectConfig = facetdb({
    model: "jev-1.14.0",
    provider: chosen,
    ...(secret ? { plugins: { [name]: { token: env("ACME_TOKEN") } } } : {}),
    sources: [
      { name: "tickets", api: true, read: ["body"], questions: { urgent: noul("Urgent?") } },
    ],
  });
  const host = await createPluginHost({
    config,
    env: { ACME_TOKEN: TOKEN },
    projectDir: "/work/shop",
    coreVersion: VERSION,
    importModule: async (specifier) => {
      if (specifier === `@facetdb/${name}`) {
        return { default: plugin };
      }
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    },
    builtins: {},
  });
  const ref = pluginProviderOf(chosen);
  if (ref === undefined) {
    throw new Error("the test's provider name is not a plugin's");
  }
  return createPluginProvider({
    provider: chosen,
    ref,
    host,
    signal: new AbortController().signal,
  });
}

/** GOOD with one answer replaced. */
function withAnswer(name: string, answer: unknown): unknown {
  return { ...GOOD, answers: { ...GOOD.answers, [name]: answer } };
}

async function refusal(reply: unknown, secret = true): Promise<PluginProviderFailure> {
  const asking = await providerOf({ current: () => reply }, secret);
  const error = await asking.ask(request).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(PluginProviderFailure);
  return error as PluginProviderFailure;
}

describe("a plugin provider's response goes through core's validation", () => {
  it("answers every question when the response is what core accepts", async () => {
    const asking = await providerOf({ current: () => GOOD });
    const response = await asking.ask(request);
    expect(response.model).toBe("jev-1.14.0");
    expect(response.answers["kind"]).toEqual({
      type: "choice",
      top: "spam",
      probabilities: [0.99, 0.01],
    });
    expect(response.answers["urgency"]).toMatchObject({ type: "score", expected: 1.6 });
    expect(response.usage).toEqual({ inputTokens: 40, outputTokens: 0 });
  });

  it("refuses a choice whose top is text that is not one of the options (the reported case)", async () => {
    const error = await refusal(
      withAnswer("kind", { type: "choice", top: "DROP TABLE x", probabilities: [0.99, 0.01] }),
    );
    expect(error.message).toContain("answers.kind.choice");
    // The plugin holds a secret, so its text is not echoed.
    expect(error.message).not.toContain("DROP TABLE");
  });

  it("shows what core says when the plugin holds no secret", async () => {
    const error = await refusal(
      withAnswer("kind", { type: "choice", top: "DROP TABLE x", probabilities: [0.99, 0.01] }),
      false,
    );
    expect(error.message).toContain('names "DROP TABLE x", which is not an option of kind');
  });

  it("refuses a choice whose top does not hold the highest probability (the reported case)", async () => {
    const error = await refusal(
      withAnswer("kind", { type: "choice", top: "ham", probabilities: [0.99, 0.01] }),
      false,
    );
    expect(error.message).toContain('names "ham", which does not hold the highest probability');
  });

  it("accepts a choice that ties for the highest probability, as core does", async () => {
    const asking = await providerOf({
      current: () => withAnswer("kind", { type: "choice", top: "ham", probabilities: [0.5, 0.5] }),
    });
    expect((await asking.ask(request)).answers["kind"]).toMatchObject({ top: "ham" });
  });

  it.each([
    ["a noul probability above 1", withAnswer("scam", { type: "noul", probability: 1.5 })],
    ["a negative noul probability", withAnswer("scam", { type: "noul", probability: -0.1 })],
    [
      "a choice probability out of range",
      withAnswer("kind", { type: "choice", top: "spam", probabilities: [1.5, 0.01] }),
    ],
    [
      "too few choice probabilities",
      withAnswer("kind", { type: "choice", top: "spam", probabilities: [0.99] }),
    ],
    [
      "too many choice probabilities",
      withAnswer("kind", { type: "choice", top: "spam", probabilities: [0.9, 0.05, 0.05] }),
    ],
    [
      "too few score levels",
      withAnswer("urgency", {
        type: "score",
        probabilities: [0.5, 0.5],
        confidence: 0.5,
        expected: 0.5,
      }),
    ],
    [
      "a score confidence above 1",
      withAnswer("urgency", {
        type: "score",
        probabilities: [0.1, 0.2, 0.7],
        confidence: 7,
        expected: 1.6,
      }),
    ],
    [
      "a score probability out of range",
      withAnswer("urgency", {
        type: "score",
        probabilities: [0.1, 0.2, 7],
        confidence: 0.7,
        expected: 1.6,
      }),
    ],
    ["a choice answered as a noul", withAnswer("kind", { type: "noul", probability: 0.9 })],
    [
      "a noul answered as a choice",
      withAnswer("scam", { type: "choice", top: "spam", probabilities: [0.9, 0.1] }),
    ],
    [
      "a question left unanswered",
      { ...GOOD, answers: { scam: GOOD.answers.scam, kind: GOOD.answers.kind } },
    ],
    [
      "a question that was not asked",
      { ...GOOD, answers: { ...GOOD.answers, extra: { type: "noul", probability: 0.5 } } },
    ],
    ["fractional token counts", { ...GOOD, usage: { inputTokens: 1.5, outputTokens: 0 } }],
    ["negative token counts", { ...GOOD, usage: { inputTokens: -1, outputTokens: 0 } }],
    ["no usage", { model: GOOD.model, answers: GOOD.answers }],
    ["an empty model name", { ...GOOD, model: "" }],
    ["not an object", "fine"],
  ])("refuses %s, as an error and never an answer", async (_what, reply) => {
    await refusal(reply);
  });
});

describe("a plugin provider's failures", () => {
  it.each([429, 529] as const)(
    "a %i the plugin throws reaches the backoff as a RetryableError carrying retry-after",
    async (status) => {
      const behave = {
        current: (): never => {
          throw Object.assign(new Error("slow down"), { status, retryAfterMs: 1500 });
        },
      };
      const error = await (await providerOf(behave))
        .ask(request)
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RetryableError);
      expect((error as RetryableError).status).toBe(status);
      expect((error as RetryableError).retryAfterMs).toBe(1500);
    },
  );

  it("a 429 with no retry-after has none", async () => {
    const behave = {
      current: (): never => {
        throw Object.assign(new Error("slow down"), { status: 429 });
      },
    };
    const error = await (await providerOf(behave)).ask(request).catch((caught: unknown) => caught);
    expect((error as RetryableError).retryAfterMs).toBeUndefined();
  });

  it("refuses an alias before the plugin is asked", async () => {
    let calls = 0;
    const asking = await providerOf({
      current: () => {
        calls += 1;
        return GOOD;
      },
    });
    for (const model of ["jev-latest", "jev-1.14", "Jev-1.14.0"]) {
      const error = await asking.ask({ ...request, model }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(ModelNotPinnedError);
    }
    expect(calls).toBe(0);
  });

  it("a plugin that holds a secret has none of its own words printed, in any form, and keeps a status", async () => {
    const behave = {
      current: (): never => {
        // Whole, truncated and URL-encoded: no replacement of exact values could find them all.
        throw Object.assign(
          new Error(
            `401 for ${TOKEN}, starting ${TOKEN.slice(0, 9)} or ${encodeURIComponent(`${TOKEN}/x y`)}`,
          ),
          { status: 502 },
        );
      },
    };
    const error = await (await providerOf(behave)).ask(request).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PluginProviderFailure);
    const message = (error as Error).message;
    expect(message).toBe(
      'the provider "acme/echo" failed: the plugin\'s own words are not shown, as they could quote a secret (status 502)',
    );
    for (const piece of [TOKEN, TOKEN.slice(0, 9), "401", "s3cret"]) {
      expect(message).not.toContain(piece);
    }
  });

  it("a plugin that holds no secret has its message shown as written", async () => {
    const behave = {
      current: (): never => {
        throw new Error("the model server is down");
      },
    };
    const error = await (await providerOf(behave, false))
      .ask(request)
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toBe(
      'the provider "plain/echo" failed: the model server is down',
    );
  });
});
