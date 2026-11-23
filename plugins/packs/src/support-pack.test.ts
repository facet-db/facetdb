import { facetdb, judgeDraftSource, noul, VERSION, wordingWarnings } from "facetdb";
import { loadPlugin, type PackDefinition, type Plugin } from "facetdb/plugin";
import { describe, expect, it } from "vitest";
import plugin, { marketplace, support } from "./index.ts";
import {
  contactProblems,
  readSample,
  type SampleRecord,
  shapeProblems,
  sharedWording,
  textOf,
  wordingOf,
  wordRuns,
} from "./testing/index.ts";

/**
 * The support inbox triage pack: it parses through the SDK's own checks with no wording warning,
 * its stakes and thresholds are the documented ones, it reads `subject` and `body` alone, its
 * option and level names describe content, its sample holds 50 complete labelled messages spread
 * over every answer with the refund and cancellation cases apart, and the plugin loads with both
 * packs. Nothing here calls a model: the live run is not built yet.
 */

const QUESTIONS = [
  ["topic", "choice"],
  ["urgency", "score"],
  ["wants_refund", "noul"],
  ["cancel_intent", "noul"],
] as const;
const TOPICS = [
  "billing",
  "account_access",
  "product_fault",
  "how_to",
  "feature_request",
  "something_else",
] as const;
const LEVELS = ["low", "medium", "high"] as const;
const HIGH_STAKES = { yesAbove: 0.9, noBelow: 0.1 } as const;

/** A name that says where an option sits rather than what it means (the `typesafe-ai` skill). */
const POSITIONAL =
  /^(?:[a-z]|\d+|(?:option|choice|answer|level)_?\d+|first|second|third|fourth|fifth|last|left|right|top|bottom|middle)$/;

/** The fewest messages per label: the spread the sample is held to. */
const AT_LEAST_TOPIC = 5;
const AT_LEAST_LEVEL = 8;
const AT_LEAST_NOUL: Readonly<Record<string, Readonly<Record<"yes" | "unsure", number>>>> = {
  wants_refund: { yes: 12, unsure: 5 },
  cancel_intent: { yes: 10, unsure: 5 },
};

/**
 * Questions about the refund policy, labelled no on wants_refund: the case its no side names. Each
 * asks what would happen, in its own words, and none asks for a payment back.
 */
const REFUND_POLICY_QUESTIONS = ["s07", "s19", "s33"] as const;

/** Charges the customer asks to have explained, labelled no on wants_refund: its no side's other case. */
const CHARGES_TO_EXPLAIN = ["s10", "s31"] as const;

/** The names in backticks in a text: the state fields a question or a description refers to. */
function contentNames(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

function questionOf(name: string): PackDefinition["questions"][number] {
  const question = support.questions.find((candidate) => candidate.name === name);
  if (question === undefined) {
    throw new Error(`the support pack has no question ${name}`);
  }
  return question;
}

/** The pack applied as the studio's "Start from a pack" applies it: a source draft over its fields. */
function applied(pack: PackDefinition) {
  const config = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "support_messages",
        api: true,
        read: ["subject", "body"],
        questions: { placeholder: noul("Is this a message?") },
      },
    ],
  });
  const questions = Object.fromEntries(
    pack.questions.map(({ name, ...question }) => [name, question]),
  );
  return judgeDraftSource(
    config,
    { name: "support_messages", questions, thresholds: pack.thresholds },
    {},
  );
}

function installed(found: Plugin) {
  return async (specifier: string): Promise<unknown> => {
    if (specifier === "@facetdb/packs") {
      return { default: found };
    }
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
}

function sample() {
  return readSample(new URL("./support.sample.json", import.meta.url));
}

function labelled(records: readonly SampleRecord[], question: string, label: string) {
  return records.filter((record) => record.expected[question] === label);
}

describe("the support pack's questions", () => {
  it("are a topic choice, an urgency score and two yes-or-no questions, and parse as a source's question set with no wording warning", () => {
    expect(support.questions.map((question) => [question.name, question.type])).toEqual(
      QUESTIONS.map(([name, type]) => [name, type]),
    );
    const topic = questionOf("topic");
    expect(topic.type === "choice" && topic.options.map((option) => option.name)).toEqual([
      ...TOPICS,
    ]);
    const urgency = questionOf("urgency");
    expect(urgency.type === "score" && urgency.levels.map((level) => level.name)).toEqual([
      ...LEVELS,
    ]);
    const judged = applied(support);
    if (!judged.ok) {
      throw new Error(
        `the pack does not parse as a source's questions: ${JSON.stringify(judged.issues)}`,
      );
    }
    expect(judged.questionSet.questions.map((question) => question.name)).toEqual(
      QUESTIONS.map(([name]) => name),
    );
    // The real check the loader and the studio run, never a copy of its rules.
    expect(judged.warnings).toEqual([]);
    expect(wordingWarnings(judged.questionSet, 0)).toEqual([]);
  });

  it("would be warned on by that same check had one of them a double negative", () => {
    // The check above is live: the same path flags a question written the way the pack avoids.
    const judged = applied({
      ...support,
      questions: support.questions.map((question) =>
        question.name === "wants_refund"
          ? {
              ...question,
              instructions:
                "Is it not true that the customer in `subject` and `body` wants no money back?",
            }
          : question,
      ),
    });
    expect(judged.ok && judged.warnings.map((warning) => warning.code)).toEqual([
      "double-negative",
    ]);
  });

  it("put wants_refund alone at high stakes, keeping its thresholds or stricter ones, and set none of their own", () => {
    const stakes = Object.fromEntries(
      support.questions.map((question) => [question.name, question.stakes]),
    );
    expect(stakes).toEqual({
      topic: "low",
      urgency: "low",
      wants_refund: "high",
      cancel_intent: "low",
    });
    // Thresholds follow from the stakes, as the description says: the pack sets none of its own.
    expect(support.thresholds).toEqual({});
    const own = support.thresholds["wants_refund"] ?? {};
    expect(own.yesAbove ?? HIGH_STAKES.yesAbove).toBeGreaterThanOrEqual(HIGH_STAKES.yesAbove);
    expect(own.noBelow ?? HIGH_STAKES.noBelow).toBeLessThanOrEqual(HIGH_STAKES.noBelow);
  });

  it("read `subject` and `body`, the fields the description and every question name", () => {
    const description = support.description ?? "";
    expect(support.reads).toEqual(["subject", "body"]);
    expect([...new Set(contentNames(description))]).toEqual(["subject", "body"]);
    // The description says how the thresholds follow from the stakes, with the figures, and what a
    // project edits first.
    for (const words of [
      "first thing a project edits",
      "high stakes",
      "0.90",
      "0.10",
      "0.70",
      "0.30",
      "0.50",
    ]) {
      expect(description, words).toContain(words);
    }
    for (const question of support.questions) {
      expect(new Set(contentNames(wordingOf(question).join("\n"))), question.name).toEqual(
        new Set(["subject", "body"]),
      );
    }
  });

  it("name every option and level by what it means, never by where it sits", () => {
    const topic = questionOf("topic");
    const urgency = questionOf("urgency");
    if (topic.type !== "choice" || urgency.type !== "score") {
      throw new Error("topic is a choice and urgency a score");
    }
    for (const name of [
      ...topic.options.map((option) => option.name),
      ...urgency.levels.map((level) => level.name),
    ]) {
      expect(name, name).not.toMatch(POSITIONAL);
    }
    // An option's name is the content its own description describes, word for word.
    for (const option of topic.options) {
      const words = option.description.toLowerCase().match(/[a-z]+/g) ?? [];
      for (const part of option.name.split("_")) {
        expect(words, `${option.name}: ${part}`).toContain(part);
      }
    }
    // Wording two options or two levels share pulls probability between them: no run of three
    // words with a content word in it appears in two descriptions.
    const runsOf = (text: string) =>
      new Set(wordRuns(text, 3).filter((run) => run.split(" ").some((word) => word.length >= 5)));
    for (const descriptions of [
      topic.options.map((option) => option.description),
      urgency.levels.map((level) => level.description ?? ""),
    ]) {
      descriptions.forEach((description, index) => {
        for (const other of descriptions.slice(index + 1)) {
          const otherRuns = runsOf(other);
          expect([...runsOf(description)].filter((run) => otherRuns.has(run))).toEqual([]);
        }
      });
    }
  });
});

describe("the support pack's sample", () => {
  it("holds 50 complete messages, each with its own id and an allowed label for every question", async () => {
    const messages = await sample();
    expect(messages.pack).toBe("support");
    expect(messages.fields).toEqual(["subject", "body"]);
    expect(messages.records).toHaveLength(50);
    expect(new Set(messages.records.map((record) => record.id)).size).toBe(50);
    expect(shapeProblems(support, messages)).toEqual([]);
  });

  it("is refused by that same check when a message lacks a label", async () => {
    // The check above is live: a message with no urgency label, or with a label no question takes.
    const messages = await sample();
    const [first, second, ...rest] = messages.records;
    if (first === undefined || second === undefined) {
      throw new Error("the sample holds fewer than two messages");
    }
    const { urgency: _dropped, ...unlabelled } = first.expected;
    const broken = {
      ...messages,
      records: [
        { ...first, expected: unlabelled },
        { ...second, expected: { ...second.expected, topic: "shipping" } },
        ...rest,
      ],
    };
    expect(shapeProblems(support, broken)).toEqual([
      `${first.id}: the label for urgency is missing, not one of low, medium, high, unsure`,
      `${second.id}: the label for topic is "shipping", not one of ${[...TOPICS, "unsure"].join(", ")}`,
    ]);
  });

  it("spreads every question over its answers: each topic, each urgency level, and yes and unsure on each yes-or-no question", async () => {
    const { records } = await sample();
    for (const topic of TOPICS) {
      expect(labelled(records, "topic", topic).length, topic).toBeGreaterThanOrEqual(
        AT_LEAST_TOPIC,
      );
    }
    for (const level of LEVELS) {
      expect(labelled(records, "urgency", level).length, level).toBeGreaterThanOrEqual(
        AT_LEAST_LEVEL,
      );
    }
    for (const [question, least] of Object.entries(AT_LEAST_NOUL)) {
      for (const [answer, count] of Object.entries(least)) {
        expect(
          labelled(records, question, answer).length,
          `${question}: ${answer}`,
        ).toBeGreaterThanOrEqual(count);
      }
    }
  });

  it("holds refund-policy questions and charges to explain labelled no, and refunds and cancellations apart from each other", async () => {
    // The confusions wants_refund's no side names, and the two intents a message can carry alone:
    // a refund label always beside a cancellation could not show which one the model reads.
    const { records } = await sample();
    const named = (ids: readonly string[], pattern: RegExp) => {
      for (const id of ids) {
        const record = records.find((candidate) => candidate.id === id);
        if (record === undefined) {
          throw new Error(`the sample has no message ${id}`);
        }
        expect(textOf(record, ["subject", "body"]), id).toMatch(pattern);
        expect(record.expected["wants_refund"], id).toBe("no");
      }
    };
    named(REFUND_POLICY_QUESTIONS, /refund|money/i);
    named(CHARGES_TO_EXPLAIN, /charge|invoice/i);
    const refundsAlone = records.filter(
      (record) =>
        record.expected["wants_refund"] === "yes" && record.expected["cancel_intent"] === "no",
    );
    expect(refundsAlone.length).toBeGreaterThanOrEqual(3);
    const cancellationsAlone = records.filter(
      (record) =>
        record.expected["cancel_intent"] === "yes" && record.expected["wants_refund"] === "no",
    );
    expect(cancellationsAlone.length).toBeGreaterThanOrEqual(3);
  });

  it("shares no quoted phrase and no run of four words with any question's wording", async () => {
    // Criteria that repeat the sample's own hard cases would test the sample against itself.
    expect(sharedWording(support, await sample())).toEqual([]);
  });

  it("holds only invented contacts: .example addresses and 555-01xx numbers", async () => {
    expect(contactProblems(support, await sample())).toEqual([]);
  });

  it("would be refused by those two checks had a message borrowed the wording or a real contact", async () => {
    // Both checks are live, and both read the pack's fields: a sample whose own `fields` drifted
    // is scanned all the same, and a pack that reads nothing is a problem, never a pass.
    const messages = await sample();
    const [first, ...rest] = messages.records;
    if (first === undefined) {
      throw new Error("the sample holds no message");
    }
    const broken = {
      ...messages,
      fields: [],
      records: [
        {
          ...first,
          body: "Hello, the customer asks for a payment back. Write to dana@mail.com or call 555-2368.",
        },
        ...rest,
      ],
    };
    expect(sharedWording(support, broken)).toContain(`${first.id} shares "asks for a payment"`);
    expect(contactProblems(support, broken)).toEqual([
      `${first.id}: mail.com is outside .example`,
      `${first.id}: 555-2368 is outside 555-0100 to 555-0199`,
    ]);
    const blind = { ...support, reads: [] };
    expect(sharedWording(blind, messages)).toEqual([
      "the pack reads no field, so no record text was checked",
    ]);
    expect(contactProblems(blind, messages)).toEqual([
      "the pack reads no field, so no record text was checked",
    ]);
  });
});

describe("the packs plugin with the support pack", () => {
  it("passes loadPlugin's checks and provides both packs", async () => {
    const loaded = await loadPlugin("packs", {
      coreVersion: VERSION,
      importModule: installed(plugin),
    });
    expect(loaded.manifest.kinds).toEqual(["pack"]);
    expect(Object.keys(loaded.packs)).toEqual(["marketplace", "support"]);
    expect(loaded.packs["marketplace"]).toBe(marketplace);
    expect(loaded.packs["support"]).toBe(support);
  });
});
