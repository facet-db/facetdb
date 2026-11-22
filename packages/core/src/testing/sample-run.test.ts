import { describe, expect, it } from "vitest";
import type { ModelProvider, ProviderRequest, ProviderResponse } from "../contracts/index.ts";
import { contentHash, type Question } from "../questions/index.ts";
import type { Answer } from "../thresholds/index.ts";
import { type LabelledSample, runSample, sampleReport, tally } from "./index.ts";

/**
 * The labelled-sample run the packs' live tests share: each answer becomes a decision through the
 * pack's thresholds, inclusive, and "unsure" agrees with the review band alone. A handwritten
 * provider answers by the record's title.
 */

const MODEL = "jev-1.14.0";

const QUESTIONS: readonly Question[] = [
  { type: "noul", name: "broken", instructions: "Is something broken in `title`?", stakes: "low" },
  {
    type: "choice",
    name: "kind",
    instructions: "What kind of issue is `title`?",
    options: [
      { name: "bug", description: "A bug" },
      { name: "wish", description: "A wish" },
      { name: "question", description: "A question" },
    ],
    stakes: "low",
    storeProbabilities: false,
  },
  { type: "noul", name: "urgent", instructions: "Is `title` urgent?", stakes: "high" },
];

type Script = Readonly<Record<string, Readonly<Record<string, Answer>>>>;

function scripted(script: Script, model = MODEL) {
  const asked: ProviderRequest[] = [];
  const provider: ModelProvider = {
    ask(request) {
      asked.push(request);
      const title = request.state["title"];
      const answers = typeof title === "string" ? script[title] : undefined;
      if (answers === undefined) {
        return Promise.reject(new Error(`no answer scripted for ${String(title)}`));
      }
      const response: ProviderResponse = {
        model,
        answers,
        usage: { inputTokens: 100, outputTokens: 7 },
      };
      return Promise.resolve(response);
    },
  };
  return { provider, asked };
}

const noul = (probability: number): Answer => ({ type: "noul", probability });
const choice = (top: string, probabilities: number[]): Answer => ({
  type: "choice",
  top,
  probabilities,
});

const SCRIPT: Script = {
  // 0.70 is yes and 0.30 is no at low stakes, inclusive; (0.80 - 1/3) / (2/3) = 0.70 decides.
  r1: { broken: noul(0.7), kind: choice("bug", [0.8, 0.1, 0.1]), urgent: noul(0.9) },
  r2: { broken: noul(0.3), kind: choice("wish", [0.1, 0.8, 0.1]), urgent: noul(0.1) },
  // (0.40 - 1/3) / (2/3) = 0.10: review, which an unsure label agrees with.
  r3: { broken: noul(0.5), kind: choice("bug", [0.4, 0.35, 0.25]), urgent: noul(0.5) },
  r4: { broken: noul(0.69), kind: choice("question", [0.05, 0.05, 0.9]), urgent: noul(0.95) },
};

const SAMPLE: LabelledSample = {
  fields: ["title", "body"],
  records: [
    {
      id: "r1",
      title: "r1",
      body: "text",
      expected: { broken: "yes", kind: "bug", urgent: "yes" },
    },
    { id: "r2", title: "r2", body: null, expected: { broken: "no", kind: "wish", urgent: "no" } },
    {
      id: "r3",
      title: "r3",
      body: "text",
      expected: { broken: "unsure", kind: "unsure", urgent: "unsure" },
    },
    // broken: a labelled yes sent to review; kind: a wrong option; urgent: an unsure label decided.
    {
      id: "r4",
      title: "r4",
      body: "text",
      expected: { broken: "yes", kind: "bug", urgent: "unsure" },
    },
  ],
};

describe("runSample", () => {
  it("decides each answer by the thresholds, inclusively, and compares it with the label", async () => {
    const { provider, asked } = scripted(SCRIPT);
    const run = await runSample({
      provider,
      model: MODEL,
      questions: QUESTIONS,
      thresholds: {},
      sample: SAMPLE,
    });
    expect(asked).toHaveLength(4);
    // The state is the sample's fields alone, null kept; the id and the labels never reach the model.
    expect(asked[1]?.state).toEqual({ title: "r2", body: null });
    expect(asked[0]?.model).toBe(MODEL);
    expect(run.models).toEqual([MODEL]);
    expect([run.calls, run.inputTokens, run.outputTokens]).toEqual([4, 400, 28]);
    expect(
      run.results.map((result) => `${result.record}.${result.question}:${result.outcome}`),
    ).toEqual([
      "r1.broken:agrees",
      "r1.kind:agrees",
      "r1.urgent:agrees",
      "r2.broken:agrees",
      "r2.kind:agrees",
      "r2.urgent:agrees",
      "r3.broken:agrees",
      "r3.kind:agrees",
      "r3.urgent:agrees",
      "r4.broken:review",
      "r4.kind:wrong",
      "r4.urgent:automatic",
    ]);
    expect(tally(run.results)).toEqual({
      total: 12,
      agrees: 9,
      wrong: 1,
      review: 1,
      automatic: 1,
      sentToReview: 4,
    });
  });

  it("applies a pack's own thresholds over the stakes defaults", async () => {
    const { provider } = scripted(SCRIPT);
    const run = await runSample({
      provider,
      model: MODEL,
      questions: QUESTIONS,
      thresholds: { broken: { yesAbove: 0.8, noBelow: 0.2 } },
      sample: SAMPLE,
    });
    const broken = run.results.filter((result) => result.question === "broken");
    expect(broken.map((result) => result.outcome)).toEqual([
      "review",
      "review",
      "agrees",
      "review",
    ]);
  });

  it("names the question set it asked by core's content hash: a choice's option order changes it, thresholds do not", async () => {
    const base = { model: MODEL, questions: QUESTIONS, sample: SAMPLE };
    const run = await runSample({ ...base, provider: scripted(SCRIPT).provider, thresholds: {} });
    expect(run.questionSet).toBe(
      contentHash({ questions: QUESTIONS, read: ["title", "body"], model: MODEL, thresholds: {} }),
    );
    const stricter = await runSample({
      ...base,
      provider: scripted(SCRIPT).provider,
      thresholds: { broken: { yesAbove: 0.8 } },
    });
    expect(stricter.questionSet).toBe(run.questionSet);
    // kind's options last to first, the reversed-order check: another question set. The scripted
    // probabilities are given in option order, so they are reversed with the options.
    const reversed = QUESTIONS.map((question) =>
      question.type === "choice"
        ? { ...question, options: [...question.options].reverse() }
        : question,
    );
    const flipped: Script = Object.fromEntries(
      Object.entries(SCRIPT).map(([title, answers]) => [
        title,
        Object.fromEntries(
          Object.entries(answers).map(([name, answer]) => [
            name,
            answer.type === "choice"
              ? { ...answer, probabilities: [...answer.probabilities].reverse() }
              : answer,
          ]),
        ),
      ]),
    );
    const backwards = await runSample({
      ...base,
      questions: reversed,
      provider: scripted(flipped).provider,
      thresholds: {},
    });
    expect(backwards.questionSet).not.toBe(run.questionSet);
    expect(backwards.results.map((result) => result.outcome)).toEqual(
      run.results.map((result) => result.outcome),
    );
  });

  it("refuses a label the question does not take, or a field that is not text, before any call", async () => {
    const { provider, asked } = scripted(SCRIPT);
    const [first, ...rest] = SAMPLE.records;
    if (first === undefined) {
      throw new Error("the sample is empty");
    }
    const typo = {
      ...SAMPLE,
      records: [{ ...first, expected: { ...first.expected, kind: "bugs" } }, ...rest],
    };
    const base = { provider, model: MODEL, questions: QUESTIONS, thresholds: {} };
    await expect(runSample({ ...base, sample: typo })).rejects.toThrow(
      'record r1: the label for kind is "bugs", not one of bug, wish, question, unsure',
    );
    const number = { ...SAMPLE, records: [{ ...first, body: 3 }, ...rest] };
    await expect(runSample({ ...base, sample: number })).rejects.toThrow(
      'record r1: the field "body" is neither text nor null',
    );
    expect(asked).toHaveLength(0);
  });

  it("rejects the run when a call fails, and names every model the responses named", async () => {
    const { r4: _left, ...three } = SCRIPT;
    const failing = scripted(three);
    const base = { model: MODEL, questions: QUESTIONS, thresholds: {}, sample: SAMPLE };
    await expect(runSample({ ...base, provider: failing.provider })).rejects.toThrow(
      "no answer scripted for r4",
    );
    const other = scripted(SCRIPT, "jev-1.13.0");
    const run = await runSample({ ...base, provider: other.provider });
    expect(run.models).toEqual(["jev-1.13.0"]);
  });
});

describe("sampleReport", () => {
  it("prints the question set, the cost, the records in review, each question's agreement and its bar, the subsets, the unsure labels per stakes and every disagreement", async () => {
    const { provider } = scripted(SCRIPT);
    const run = await runSample({
      provider,
      model: MODEL,
      questions: QUESTIONS,
      thresholds: {},
      sample: SAMPLE,
    });
    const lines = sampleReport(run, {
      pack: "demo",
      questions: QUESTIONS,
      thresholds: {},
      bar: 4,
      subsets: [{ name: "the bug reports", question: "broken", records: new Set(["r1", "r4"]) }],
    });
    expect(lines.slice(0, 3)).toEqual([
      `demo: question set ${run.questionSet}`,
      `demo: 4 records, 4 calls, answered by ${MODEL}; 400 input tokens ($0.0000 at $0.042 per million), 28 output tokens`,
      // r3 has every answer in review and r4 one of three; one is enough.
      "records sent to review (any answer in review): 2 of 4",
    ]);
    expect(lines).toContain(
      "broken (noul, low stakes, yes at 0.70 or above, no at 0.30 or below): 3 of 4 agree; 0 wrong, 1 sent to review on a labelled record, 0 decided on an unsure record; 2 of 4 sent to review  BELOW 4 of 4",
    );
    expect(lines).toContain("  per label: yes 1/2 · no 1/1 · unsure 1/1");
    expect(lines).toContain(
      "  on the bug reports: 1 of 2 agree; 0 wrong, 1 sent to review on a labelled record, 0 decided on an unsure record; 1 of 2 sent to review",
    );
    expect(lines).toContain("unsure labels at high stakes (urgent): 1 of 2 sent to review");
    expect(lines).toContain("unsure labels at low stakes (broken, kind): 2 of 2 sent to review");
    expect(lines).toContain(
      "  r4 WRONG: labelled bug, kind question at confidence 0.85 [bug 0.05, wish 0.05, question 0.90] -> question",
    );
    expect(lines.filter((line) => /^ {2}r\d /.test(line))).toHaveLength(3 + 4);
  });
});
