import { describe, expect, it } from "vitest";
import {
  answerColumns,
  contentHash,
  nextVersion,
  parseQuestionSet,
  type Question,
  type QuestionSet,
  type QuestionSetVersion,
} from "./index.ts";

// The support_messages example source, in the shape the config boundary receives.
function supportMessages(): Record<string, unknown> {
  return {
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
    thresholds: { urgency: { confidenceAtLeast: 0.6 } },
  };
}

type Mutation = (set: Record<string, unknown>) => void;

function questionAt(set: Record<string, unknown>, index: number): Record<string, unknown> {
  return (set["questions"] as Record<string, unknown>[])[index] as Record<string, unknown>;
}

function mutated(mutate: Mutation): Record<string, unknown> {
  const set = supportMessages();
  mutate(set);
  return set;
}

function parsed(input: Record<string, unknown> = supportMessages()): QuestionSet {
  const result = parseQuestionSet(input);
  if (!result.ok) {
    throw new Error(`expected a valid question set, got: ${result.errors.join("; ")}`);
  }
  return result.questionSet;
}

function errorsOf(input: Record<string, unknown>): readonly string[] {
  const result = parseQuestionSet(input);
  if (result.ok) {
    throw new Error("expected the question set to be refused");
  }
  return result.errors;
}

const options = (count: number) =>
  Array.from({ length: count }, (_, i) => ({ name: `option_${i}`, description: `Option ${i}` }));
const levels = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `level_${i}` }));

describe("question set validation", () => {
  it("accepts the support_messages example and fills the defaults", () => {
    const set = parsed();
    expect(set.questions.map((q) => [q.name, q.type, q.stakes])).toEqual([
      ["urgency", "score", "low"],
      ["team", "choice", "low"],
      ["wants_refund", "noul", "high"],
    ]);
    const team = set.questions[1];
    expect(team?.type === "choice" && team.storeProbabilities).toBe(false);
  });

  it("defaults thresholds to none when the config gives none", () => {
    expect(parsed(mutated((s) => delete s["thresholds"])).thresholds).toEqual({});
  });

  const accepted: [string, Mutation][] = [
    ["a one-letter name", (s) => (questionAt(s, 0)["name"] = "u")],
    ["a 40-character name", (s) => (questionAt(s, 0)["name"] = `a${"b".repeat(39)}`)],
    ["digits and underscores after the first letter", (s) => (questionAt(s, 0)["name"] = "q_2b")],
    ["choice with exactly 2 options", (s) => (questionAt(s, 1)["options"] = options(2))],
    ["choice with exactly 255 options", (s) => (questionAt(s, 1)["options"] = options(255))],
    ["score with exactly 2 levels", (s) => (questionAt(s, 0)["levels"] = levels(2))],
    ["score with exactly 10 levels", (s) => (questionAt(s, 0)["levels"] = levels(10))],
    [
      "score levels with descriptions",
      (s) =>
        (questionAt(s, 0)["levels"] = [
          { name: "low", description: "The customer mentions a minor inconvenience" },
          { name: "high", description: "The customer cannot use what they paid for" },
        ]),
    ],
    [
      "noul criteria for yes and for no",
      (s) =>
        (questionAt(s, 2)["criteria"] = {
          true: "The customer asks for a refund of a charge",
          false: "The customer asks what the refund policy is",
        }),
    ],
    ["noul criteria for yes only", (s) => (questionAt(s, 2)["criteria"] = { true: "A refund" })],
    ["storeProbabilities on a choice", (s) => (questionAt(s, 1)["storeProbabilities"] = true)],
    ["no where filter", (s) => delete s["where"]],
    ["a model family other than jev", (s) => (s["model"] = "solar2-0.3.12")],
  ];

  it.each(accepted)("accepts %s", (_, mutate) => {
    expect(parseQuestionSet(mutated(mutate)).ok).toBe(true);
  });

  const refused: [string, Mutation, string][] = [
    [
      "a name starting with a digit",
      (s) => (questionAt(s, 0)["name"] = "2fast"),
      "questions.0.name",
    ],
    ["a name starting with an underscore", (s) => (questionAt(s, 0)["name"] = "_x"), "lowercase"],
    ["an uppercase name", (s) => (questionAt(s, 0)["name"] = "Urgency"), "lowercase letters"],
    ["a name with a dash", (s) => (questionAt(s, 0)["name"] = "wants-refund"), "underscores"],
    [
      "a 41-character name",
      (s) => (questionAt(s, 0)["name"] = `a${"b".repeat(40)}`),
      "at most 40 characters",
    ],
    ["an empty name", (s) => (questionAt(s, 0)["name"] = ""), "questions.0.name"],
    [
      "two questions with one name",
      (s) => (questionAt(s, 2)["name"] = "team"),
      'questions.2.name: question name "team" appears twice',
    ],
    ["blank instructions", (s) => (questionAt(s, 2)["instructions"] = "  "), "instructions"],
    [
      "choice with 1 option",
      (s) => (questionAt(s, 1)["options"] = options(1)),
      "at least 2 options",
    ],
    [
      "choice with 256 options",
      (s) => (questionAt(s, 1)["options"] = options(256)),
      "at most 255 options",
    ],
    [
      "choice option without a description",
      (s) => (questionAt(s, 1)["options"] = [{ name: "a" }, { name: "b", description: "B" }]),
      "questions.1.options.0.description",
    ],
    [
      "choice option description over two lines",
      (s) =>
        (questionAt(s, 1)["options"] = [
          { name: "a", description: "first line\nsecond line" },
          { name: "b", description: "B" },
        ]),
      "one line",
    ],
    [
      "two options with one name",
      (s) =>
        (questionAt(s, 1)["options"] = [
          { name: "billing", description: "A" },
          { name: "billing", description: "B" },
        ]),
      'option "billing" appears twice',
    ],
    ["score with 1 level", (s) => (questionAt(s, 0)["levels"] = levels(1)), "at least 2 levels"],
    ["score with 11 levels", (s) => (questionAt(s, 0)["levels"] = levels(11)), "at most 10 levels"],
    [
      "two levels with one name",
      (s) => (questionAt(s, 0)["levels"] = [{ name: "low" }, { name: "low" }]),
      'level "low" appears twice',
    ],
    ["stakes other than low or high", (s) => (questionAt(s, 2)["stakes"] = "medium"), "stakes"],
    ["the box type", (s) => (questionAt(s, 0)["type"] = "box"), "questions.0"],
    [
      "storeProbabilities on a noul",
      (s) => (questionAt(s, 2)["storeProbabilities"] = true),
      "questions.2",
    ],
    ["no questions", (s) => (s["questions"] = []), "at least one question"],
    ["no state fields", (s) => (s["read"] = []), "at least one state field"],
    [
      "a state field named twice",
      (s) => (s["read"] = ["subject", "subject"]),
      'read.1: state field "subject" appears twice',
    ],
  ];

  it.each(refused)("refuses %s", (_, mutate, expected) => {
    expect(errorsOf(mutated(mutate)).join("\n")).toContain(expected);
  });
});

describe("pinned model versions", () => {
  it.each(["jev-1.14.0", "jev-1.13.2", "jev-10.0.0"])("accepts %s", (model) => {
    expect(parseQuestionSet(mutated((s) => (s["model"] = model))).ok).toBe(true);
  });

  it.each(["jev-latest", "jev-preview"])(
    "refuses the alias %s, naming the pinned form",
    (model) => {
      expect(errorsOf(mutated((s) => (s["model"] = model)))).toEqual([
        `model: model must be an exact version such as jev-1.14.0; ${model} moves when TypeSafe ships a release`,
      ]);
    },
  );

  it.each(["jev", "jev-1.14", "jev-1.14.0-rc1", "Jev-1.14.0", "jev-v1.14.0", "1.14.0", ""])(
    "refuses %j as not an exact version",
    (model) => {
      expect(errorsOf(mutated((s) => (s["model"] = model)))).toEqual([
        `model: model must be an exact version such as jev-1.14.0, not "${model}"`,
      ]);
    },
  );
});

describe("answer columns FacetDB stores on the record", () => {
  const byName = (name: string): Question => {
    const question = parsed().questions.find((q) => q.name === name);
    if (question === undefined) throw new Error(`no question ${name} in the fixture`);
    return question;
  };
  const columns = (question: Question) =>
    answerColumns(question).map((c) => `${c.role}:${c.name}:${c.kind}`);

  it("noul stores a boolean and its probability", () => {
    expect(columns(byName("wants_refund"))).toEqual([
      "value:wants_refund:boolean",
      "probability:wants_refund_probability:real",
    ]);
  });

  it("choice stores the option and its confidence", () => {
    expect(columns(byName("team"))).toEqual(["value:team:text", "confidence:team_confidence:real"]);
  });

  it("choice adds the probabilities JSON only when storeProbabilities is set", () => {
    const team = parsed(mutated((s) => (questionAt(s, 1)["storeProbabilities"] = true)))
      .questions[1];
    if (team === undefined) throw new Error("fixture lost its choice question");
    expect(columns(team)).toEqual([
      "value:team:text",
      "confidence:team_confidence:real",
      "probabilities:team_probabilities:json",
    ]);
  });

  it("score stores the level, its confidence and the expected value", () => {
    expect(columns(byName("urgency"))).toEqual([
      "value:urgency:text",
      "confidence:urgency_confidence:real",
      "expected:urgency_expected:real",
    ]);
  });

  it("the longest name with the longest suffix fits Postgres's 63-character identifiers", () => {
    const longest = parsed(
      mutated((s) => {
        questionAt(s, 1)["name"] = `a${"b".repeat(39)}`;
        questionAt(s, 1)["storeProbabilities"] = true;
      }),
    ).questions[1];
    if (longest === undefined) throw new Error("fixture lost its choice question");
    for (const column of answerColumns(longest)) {
      expect(column.name.length).toBeLessThanOrEqual(63);
    }
  });
});

describe("question-set versions", () => {
  const base = parsed();
  const t0 = new Date("2026-10-31T09:00:00Z");
  const t1 = new Date("2026-10-31T10:00:00Z");
  const clockAt = (now: Date) => ({ now: () => now });
  const first: QuestionSetVersion = nextVersion(undefined, base, clockAt(t0));

  it("the first version is 1, created at the clock's time, with a SHA-256 content hash", () => {
    expect(first).toEqual({ version: 1, contentHash: contentHash(base), createdAt: t0 });
    expect(first.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the hash is stable across parses of the same config", () => {
    expect(contentHash(parsed())).toBe(contentHash(parsed()));
  });

  const newVersion: [string, Mutation][] = [
    [
      "rewording a question",
      (s) => (questionAt(s, 2)["instructions"] = "Does the customer want a refund?"),
    ],
    [
      "adding noul criteria",
      (s) => (questionAt(s, 2)["criteria"] = { false: "Asks about the policy" }),
    ],
    [
      "changing an option's description",
      (s) =>
        (questionAt(s, 1)["options"] = [
          { name: "billing", description: "Charges and invoices" },
          { name: "shipping", description: "Delivery times, tracking, countries" },
          { name: "returns", description: "Damaged items, exchanges, refunds" },
        ]),
    ],
    [
      "reordering a choice's options (Jev leans toward the first)",
      (s) =>
        (questionAt(s, 1)["options"] = [
          { name: "returns", description: "Damaged items, exchanges, refunds" },
          { name: "billing", description: "Charges, payments, invoices" },
          { name: "shipping", description: "Delivery times, tracking, countries" },
        ]),
    ],
    [
      "describing a score level",
      (s) =>
        (questionAt(s, 0)["levels"] = [
          { name: "low", description: "Can wait" },
          { name: "medium" },
          { name: "high" },
        ]),
    ],
    ["adding a state field", (s) => (s["read"] = ["subject", "body", "channel", "customer_tier"])],
    ["reordering the state fields", (s) => (s["read"] = ["body", "subject", "channel"])],
    ["a new model version", (s) => (s["model"] = "jev-1.15.0")],
    ["renaming a question", (s) => (questionAt(s, 0)["name"] = "priority")],
    [
      "adding a question",
      (s) =>
        (s["questions"] as unknown[]).push({
          type: "noul",
          name: "is_spam",
          instructions: "Is this message spam?",
        }),
    ],
    ["removing a question", (s) => (s["questions"] as unknown[]).pop()],
  ];

  it.each(newVersion)("%s creates the next version", (_, mutate) => {
    const next = nextVersion(first, parsed(mutated(mutate)), clockAt(t1));
    expect(next.version).toBe(2);
    expect(next.createdAt).toEqual(t1);
    expect(next.contentHash).not.toBe(first.contentHash);
  });

  const sameVersion: [string, Mutation][] = [
    [
      "changing a threshold only",
      (s) => (s["thresholds"] = { urgency: { confidenceAtLeast: 0.8 } }),
    ],
    [
      "adding a threshold override",
      (s) => (s["thresholds"] = { wants_refund: { yesAbove: 0.95, noBelow: 0.05 } }),
    ],
    [
      "changing stakes (it only picks default thresholds)",
      (s) => (questionAt(s, 2)["stakes"] = "low"),
    ],
    [
      "turning on storeProbabilities (a column, not an answer)",
      (s) => (questionAt(s, 1)["storeProbabilities"] = true),
    ],
    [
      "changing the where filter (which records, not what is asked)",
      (s) => (s["where"] = "channel = 'email'"),
    ],
    [
      "reordering the questions (each is answered on its own)",
      (s) => (s["questions"] as unknown[]).reverse(),
    ],
  ];

  it.each(sameVersion)("%s keeps the version and its creation time", (_, mutate) => {
    expect(nextVersion(first, parsed(mutated(mutate)), clockAt(t1))).toBe(first);
  });

  it("a later change counts from the previous version", () => {
    const second = nextVersion(
      first,
      parsed(mutated((s) => (s["model"] = "jev-1.15.0"))),
      clockAt(t1),
    );
    const third = nextVersion(second, base, clockAt(t1));
    expect(third.version).toBe(3);
  });
});
