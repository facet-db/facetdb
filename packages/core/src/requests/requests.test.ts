import { describe, expect, it } from "vitest";
import { parseQuestionSet, type QuestionSet } from "../questions/index.ts";
import { buildRequest } from "./build.ts";
import { parseAnswers, ResponseShapeError } from "./parse.ts";
import { systemOneRequestSchema } from "./schema.ts";
import { checkStateSize, estimateTokens, STATE_REFUSE_TOKENS, STATE_WARN_TOKENS } from "./size.ts";

// The support_messages example source, in the shape the config boundary receives.
function supportMessages(): QuestionSet {
  const parsed = parseQuestionSet({
    model: "jev-1.14.0",
    read: ["subject", "body", "channel"],
    where: "channel <> 'internal'",
    questions: [
      {
        type: "score",
        name: "urgency",
        instructions: "How urgent is this message?",
        levels: [{ name: "low" }, { name: "medium" }, { name: "high" }],
      },
      {
        type: "choice",
        name: "team",
        instructions: "Which team should handle it?",
        options: [
          { name: "billing", description: "Charges, payments, invoices" },
          { name: "shipping", description: "Delivery times, tracking, countries" },
          { name: "returns", description: "Damaged items, exchanges, refunds" },
        ],
      },
      {
        type: "noul",
        name: "wants_refund",
        instructions: "Is the customer asking for their money back?",
        stakes: "high",
      },
    ],
  });
  if (!parsed.ok) {
    throw new Error(`the example set must parse: ${parsed.errors.join("; ")}`);
  }
  return parsed.questionSet;
}

const state = {
  subject: "Where is my parcel?",
  body: "It said delivered on Monday and nothing arrived.",
  channel: "email",
};

// A response as TypeSafe returns it for the example: choice probabilities keyed by option name in
// a different order from the options, score probabilities keyed "0" to "2".
// `answers` replaces the answer for each name it gives; every other answer stays as TypeSafe sent it.
function supportResponse(answers: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    model: "jev-1.14.0",
    answers: {
      urgency: {
        score: 1.8,
        confidence: 0.61,
        legend: { "0": "low", "1": "medium", "2": "high" },
        probabilities: { "2": 0.2, "1": 0.5, "0": 0.3 },
      },
      team: {
        choice: "shipping",
        confidence: 0.4,
        probabilities: { returns: 0.2, shipping: 0.6, billing: 0.2 },
      },
      wants_refund: { noul: 0.83 },
      ...answers,
    },
    usage: { input_tokens: 412, output_tokens: 9 },
  };
}

describe("buildRequest", () => {
  it("builds the support-messages payload: the read state, every question, the pinned model", () => {
    const payload = buildRequest(supportMessages(), state);
    expect(payload).toMatchInlineSnapshot(`
      {
        "model": "jev-1.14.0",
        "questions": {
          "team": {
            "criteria": {
              "billing": "Charges, payments, invoices",
              "returns": "Damaged items, exchanges, refunds",
              "shipping": "Delivery times, tracking, countries",
            },
            "instructions": "Which team should handle it?",
            "type": "choice",
          },
          "urgency": {
            "criteria": [
              "low",
              "medium",
              "high",
            ],
            "instructions": "How urgent is this message?",
            "type": "score",
          },
          "wants_refund": {
            "instructions": "Is the customer asking for their money back?",
            "type": "noul",
          },
        },
        "state": {
          "body": "It said delivered on Monday and nothing arrived.",
          "channel": "email",
          "subject": "Where is my parcel?",
        },
      }
    `);
  });

  it("sends a payload that the API reference's request shape accepts, with no extra field", () => {
    const payload = buildRequest(supportMessages(), state);
    expect(systemOneRequestSchema.safeParse(payload).success).toBe(true);
  });

  it("sends only the state fields the set reads, in config order", () => {
    const payload = buildRequest(supportMessages(), {
      ...state,
      internal_note: "never sent",
      facetdb_status: "pending",
    });
    expect(Object.keys(payload.state)).toEqual(["subject", "body", "channel"]);
  });

  it("sends a null state field as null and omits the criteria of a noul that has none", () => {
    const payload = buildRequest(supportMessages(), { ...state, channel: null });
    expect(payload.state).toMatchObject({ channel: null });
    expect(payload.questions).toMatchObject({ wants_refund: { type: "noul" } });
    expect(payload.questions["wants_refund"]).not.toHaveProperty("criteria");
  });

  it("refuses to build when a read state field is missing from the row", () => {
    const { subject: _subject, ...withoutSubject } = state;
    expect(() => buildRequest(supportMessages(), withoutSubject)).toThrow(
      'state field "subject" is missing from the row',
    );
  });
});

describe("parseAnswers", () => {
  it("parses all three types in the question's own order and reads the usage", () => {
    const parsed = parseAnswers(supportMessages(), supportResponse());
    expect(parsed).toEqual({
      model: "jev-1.14.0",
      answers: {
        urgency: {
          type: "score",
          probabilities: [0.3, 0.5, 0.2],
          confidence: 0.61,
          expected: 1.8,
        },
        team: { type: "choice", top: "shipping", probabilities: [0.2, 0.6, 0.2] },
        wants_refund: { type: "noul", probability: 0.83 },
      },
      usage: { inputTokens: 412, outputTokens: 9 },
    });
  });

  it("refuses a response without usage: it is never defaulted to zero tokens", () => {
    const { usage: _usage, ...response } = supportResponse();
    expect(() => parseAnswers(supportMessages(), response)).toThrow(ResponseShapeError);
    expect(() => parseAnswers(supportMessages(), response)).toThrow(/usage/);
  });

  it("refuses a usage without its input count", () => {
    const response = { ...supportResponse(), usage: { output_tokens: 9 } };
    expect(() => parseAnswers(supportMessages(), response)).toThrow(/usage\.input_tokens/);
  });

  it("refuses a 422-shaped body, naming the field it reports", () => {
    const body = {
      error: {
        type: "validation_error",
        message: "questions.urgency.levels: at most 10 levels",
        field: "questions.urgency",
      },
    };
    expect(() => parseAnswers(supportMessages(), body)).toThrow(ResponseShapeError);
  });

  it("refuses an answer for a question that is not in the set", () => {
    const response = supportResponse({ ghost: { noul: 0.5 } });
    expect(() => parseAnswers(supportMessages(), response)).toThrow(/answers\.ghost/);
  });

  it("refuses a type mismatch and names the field", () => {
    const response = supportResponse({
      wants_refund: { choice: "billing", probabilities: { billing: 1 } },
    });
    expect(() => parseAnswers(supportMessages(), response)).toThrow(/answers\.wants_refund/);
  });

  it("refuses a choice that names an option the question does not have", () => {
    const response = supportResponse({
      team: { choice: "sales", probabilities: { billing: 0.4, shipping: 0.3, returns: 0.3 } },
    });
    expect(() => parseAnswers(supportMessages(), response)).toThrow(/answers\.team\.choice/);
  });

  it("refuses a choice whose named option does not hold the highest probability", () => {
    const response = supportResponse({
      team: { choice: "billing", probabilities: { billing: 0.2, shipping: 0.6, returns: 0.2 } },
    });
    expect(() => parseAnswers(supportMessages(), response)).toThrow(
      /answers\.team\.choice names "billing", which does not hold the highest probability/,
    );
  });

  it("keeps the option the model named on a tie, not the first listed", () => {
    const response = supportResponse({
      team: { choice: "returns", probabilities: { billing: 0.4, shipping: 0.2, returns: 0.4 } },
    });
    expect(parseAnswers(supportMessages(), response).answers["team"]).toEqual({
      type: "choice",
      top: "returns",
      probabilities: [0.4, 0.2, 0.4],
    });
  });

  it("refuses a missing probability and names the level or option", () => {
    const response = supportResponse({
      team: { choice: "shipping", probabilities: { billing: 0.5, shipping: 0.5 } },
    });
    expect(() => parseAnswers(supportMessages(), response)).toThrow(
      /answers\.team\.probabilities\.returns/,
    );
  });

  it("refuses a missing answer for a question whose name is a prototype key", () => {
    const parsed = parseQuestionSet({
      model: "jev-1.14.0",
      read: ["body"],
      questions: [{ type: "noul", name: "constructor", instructions: "Is it spam?" }],
    });
    if (!parsed.ok) {
      throw new Error(parsed.errors.join("; "));
    }
    expect(() => parseAnswers(parsed.questionSet, { ...supportResponse(), answers: {} })).toThrow(
      /answers\.constructor/,
    );
  });

  it("refuses a probability outside [0, 1]", () => {
    const response = supportResponse({ wants_refund: { noul: 1.2 } });
    expect(() => parseAnswers(supportMessages(), response)).toThrow(/answers\.wants_refund/);
  });
});

describe("state size guards", () => {
  it("estimates 4 characters per token, rounding up", () => {
    // {"body":"…"} is 11 characters around the value, so a 21-character value is 32 characters.
    expect(estimateTokens({ body: "x".repeat(21) })).toBe(8);
    expect(estimateTokens({ body: "x".repeat(22) })).toBe(9);
  });

  it("counts an emoji as one character, not its two UTF-16 units", () => {
    // {"body":"😀"} is 12 characters (13 UTF-16 units): 12 / 4 = 3 tokens, not 13 / 4 rounded up.
    expect(estimateTokens({ body: "😀" })).toBe(3);
  });

  it("is ok at exactly 8,000 tokens and warns above it", () => {
    expect(checkStateSize(STATE_WARN_TOKENS).kind).toBe("ok");
    expect(checkStateSize(STATE_WARN_TOKENS + 1)).toEqual({
      kind: "warn",
      estimate: 8001,
      warnAbove: 8000,
    });
  });

  it("warns, and does not refuse, at exactly 32,000 tokens and refuses above it", () => {
    expect(checkStateSize(STATE_REFUSE_TOKENS).kind).toBe("warn");
    expect(checkStateSize(STATE_REFUSE_TOKENS + 1)).toEqual({
      kind: "refuse",
      estimate: 32001,
      refuseAbove: 32000,
    });
  });

  it("refuses above the source's own maxStateTokens and allows exactly that limit", () => {
    expect(checkStateSize(4_000, 4_000).kind).toBe("ok");
    expect(checkStateSize(4_001, 4_000)).toEqual({
      kind: "refuse",
      estimate: 4001,
      refuseAbove: 4000,
    });
  });

  it("allows a larger state when the source raises maxStateTokens, still warning above 8,000", () => {
    expect(checkStateSize(40_000, 50_000).kind).toBe("warn");
  });
});
