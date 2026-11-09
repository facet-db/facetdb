import { type ProviderRequest, type Question, ResponseShapeError } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { ModelUnreachableError, RetryableError, UnexpectedStatusError } from "../errors.ts";
import { createFakeProvider } from "./fake-provider.ts";

const questions: readonly Question[] = [
  { type: "noul", name: "scam", instructions: "Is it a scam?", stakes: "high" },
  {
    type: "choice",
    name: "category",
    instructions: "What is it?",
    options: [
      { name: "car", description: "a car" },
      { name: "bike", description: "a bike" },
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

const ask = (id: string): ProviderRequest => ({
  model: "jev-1.14.0",
  state: { id, title: `listing ${id}` },
  questions,
});

describe("fake provider", () => {
  it("answers from the fixture by record key", async () => {
    const fake = createFakeProvider({
      keyField: "id",
      answers: {
        a: {
          scam: { type: "noul", probability: 0.97 },
          category: { type: "choice", top: "bike", probabilities: [0.1, 0.9] },
          urgency: {
            type: "score",
            probabilities: [0.1, 0.2, 0.7],
            confidence: 0.7,
            expected: 1.6,
          },
        },
      },
    });
    const response = await fake.ask(ask("a"));
    expect(response.answers).toEqual({
      scam: { type: "noul", probability: 0.97 },
      category: { type: "choice", top: "bike", probabilities: [0.1, 0.9] },
      urgency: { type: "score", probabilities: [0.1, 0.2, 0.7], confidence: 0.7, expected: 1.6 },
    });
    expect(response.usage).toEqual({ inputTokens: 100, outputTokens: 0 });
  });

  it("falls back to a default per question type for other records", async () => {
    const fake = createFakeProvider({
      keyField: "id",
      answers: { a: { scam: { type: "noul", probability: 0.1 } } },
      defaults: { noul: 0.5, choice: 1, score: 2 },
      usage: { inputTokens: 7, outputTokens: 1 },
    });
    const response = await fake.ask(ask("zzz"));
    expect(response.answers).toEqual({
      scam: { type: "noul", probability: 0.5 },
      category: { type: "choice", top: "bike", probabilities: [0, 1] },
      urgency: { type: "score", probabilities: [0, 0, 1], confidence: 1, expected: 2 },
    });
    expect(response.usage).toEqual({ inputTokens: 7, outputTokens: 1 });
    // A scripted question wins over the default, the rest still default.
    const partial = await fake.ask(ask("a"));
    expect(partial.answers["scam"]).toEqual({ type: "noul", probability: 0.1 });
    expect(partial.answers["category"]).toEqual({
      type: "choice",
      top: "bike",
      probabilities: [0, 1],
    });
  });

  it("refuses to invent an answer the script does not have", async () => {
    const fake = createFakeProvider({ defaults: { noul: 0.5 } });
    await expect(fake.ask(ask("a"))).rejects.toThrow(/no answer for category/);
  });

  it("refuses an answer of the wrong type for its question", async () => {
    const fake = createFakeProvider({
      keyField: "id",
      answers: { a: { scam: { type: "choice", top: "x", probabilities: [1] } } },
      defaults: { noul: 0.5, choice: 0, score: 0 },
    });
    await expect(fake.ask(ask("a"))).rejects.toThrow(/answers scam as a choice/);
  });

  it("needs a keyField to read answers by record key", () => {
    expect(() => createFakeProvider({ answers: { a: {} } })).toThrow(/keyField/);
  });

  it("counts every call and records the payloads, failed ones included", async () => {
    const fake = createFakeProvider({
      defaults: { noul: 0.5, choice: 0, score: 0 },
      failures: { 1: { kind: "529" } },
    });
    await fake.ask(ask("a"));
    await fake.ask(ask("b")).catch(() => undefined);
    await fake.ask(ask("c"));
    expect(fake.callCount).toBe(3);
    expect(fake.requests.map((r) => r.state["id"])).toEqual(["a", "b", "c"]);
    expect(fake.requests[0]).toEqual(ask("a"));
  });

  it("replays failures by call index with the errors the real client throws", async () => {
    const fake = createFakeProvider({
      defaults: { noul: 0.5, choice: 0, score: 0 },
      failures: {
        0: { kind: "429", retryAfterMs: 2000 },
        1: { kind: "529" },
        2: { kind: "503" },
        3: { kind: "timeout" },
        4: { kind: "malformed" },
      },
    });
    const errors: unknown[] = [];
    for (let i = 0; i < 6; i++) {
      errors.push(await fake.ask(ask("a")).catch((e: unknown) => e));
    }
    expect(errors[0]).toBeInstanceOf(RetryableError);
    expect(errors[0]).toMatchObject({ status: 429, retryAfterMs: 2000 });
    expect(errors[1]).toMatchObject({ status: 529, retryAfterMs: undefined });
    expect(errors[2]).toBeInstanceOf(UnexpectedStatusError);
    expect(errors[3]).toBeInstanceOf(ModelUnreachableError);
    expect(errors[4]).toBeInstanceOf(ResponseShapeError);
    expect(errors[5]).toMatchObject({ answers: expect.anything() });
  });

  it("replays the same script identically on a second provider", async () => {
    const script = {
      keyField: "id",
      answers: { a: { scam: { type: "noul", probability: 0.2 } as const } },
      defaults: { noul: 0.5, choice: 0, score: 1 },
      failures: { 1: { kind: "429" } as const },
    };
    const run = async () => {
      const fake = createFakeProvider(script);
      const out: unknown[] = [];
      for (const id of ["a", "b", "a"]) {
        out.push(await fake.ask(ask(id)).catch((e: unknown) => (e as Error).message));
      }
      return out;
    };
    expect(await run()).toEqual(await run());
  });
});
