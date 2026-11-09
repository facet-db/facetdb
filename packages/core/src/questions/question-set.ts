import { z } from "zod";
import { resolveThresholds, type ThresholdOverride } from "../thresholds/index.ts";
import { QUESTION_NAME_PATTERN, QUESTION_NAME_RULE, RESERVED_QUESTION_NAME } from "./names.ts";
import type { Question } from "./types.ts";

/**
 * The `model` line is pinned, never an alias. A pinned version is a lowercase family, a dash and
 * a three-part version (`jev-1.14.0`).
 */
export const MODEL_VERSION_PATTERN = /^[a-z][a-z0-9]*-\d+\.\d+\.\d+$/;

const PINNED_EXAMPLE = "jev-1.14.0";
const MOVING_ALIAS = /^[a-z][a-z0-9]*-(latest|preview)$/;

// A choice takes 2 to 255 options, a score 2 to 10 levels.
const choiceOptionLimits = { min: 2, max: 255 } as const;
const scoreLevelLimits = { min: 2, max: 10 } as const;

export type { ThresholdOverride };

export type QuestionSet = {
  readonly questions: readonly Question[];
  /** The state fields, in config order: only what the questions need. */
  readonly read: readonly string[];
  readonly model: string;
  /**
   * Keyed by question name; a question without an entry keeps its stakes defaults, and a key that
   * names no question is refused (a typo would otherwise keep the defaults silently).
   */
  readonly thresholds: Readonly<Record<string, ThresholdOverride>>;
  /** A filter on state fields; records outside it are skipped. */
  readonly where?: string;
};

export type QuestionSetParseResult =
  | { readonly ok: true; readonly questionSet: QuestionSet }
  | { readonly ok: false; readonly errors: readonly string[] };

function modelError(model: string): string {
  if (MOVING_ALIAS.test(model)) {
    return `model must be an exact version such as ${PINNED_EXAMPLE}; ${model} moves when TypeSafe ships a release`;
  }
  return `model must be an exact version such as ${PINNED_EXAMPLE}, not "${model}"`;
}

const nonBlank = (what: string) =>
  z.string().refine((text) => text.trim().length > 0, `${what} must not be empty`);

const oneLine = (what: string) =>
  nonBlank(what).refine((text) => !/[\r\n]/.test(text), `${what} must fit on one line`);

/** Adds an issue for every name that appears twice, pointing at the second occurrence. */
function rejectDuplicates(
  names: readonly string[],
  what: string,
  ctx: z.RefinementCtx,
  pathOf: (index: number) => (string | number)[],
): void {
  const seen = new Set<string>();
  names.forEach((name, index) => {
    if (seen.has(name)) {
      ctx.addIssue({
        code: "custom",
        message: `${what} "${name}" appears twice`,
        path: pathOf(index),
      });
    }
    seen.add(name);
  });
}

const questionName = z
  .string()
  .regex(QUESTION_NAME_PATTERN, {
    error: (issue) => `question name "${String(issue.input)}" must use ${QUESTION_NAME_RULE}`,
  })
  .refine((name) => !RESERVED_QUESTION_NAME.test(name), {
    error: (issue) =>
      `question name "${String(issue.input)}" must not be facetdb or start with facetdb_; FacetDB keeps that prefix for its own columns`,
  });

// The branches stay inferred so the union can read their `type` literal; the annotation on
// `question` below is what ties them to the declared types in `types.ts`.
const stakes = z.enum(["low", "high"], { error: 'stakes must be "low" or "high"' }).default("low");

const noulQuestion = z.strictObject({
  type: z.literal("noul"),
  name: questionName,
  instructions: nonBlank("instructions"),
  criteria: z
    .strictObject({
      true: nonBlank("the yes criterion").exactOptional(),
      false: nonBlank("the no criterion").exactOptional(),
    })
    .exactOptional(),
  stakes,
});

const choiceQuestion = z.strictObject({
  type: z.literal("choice"),
  name: questionName,
  instructions: nonBlank("instructions"),
  options: z
    .array(
      z.strictObject({
        name: oneLine("an option name"),
        description: oneLine("an option description"),
      }),
    )
    .min(
      choiceOptionLimits.min,
      `a choice question needs at least ${choiceOptionLimits.min} options`,
    )
    .max(
      choiceOptionLimits.max,
      `a choice question takes at most ${choiceOptionLimits.max} options`,
    )
    .superRefine((options, ctx) => {
      rejectDuplicates(
        options.map((option) => option.name),
        "option",
        ctx,
        (index) => [index, "name"],
      );
    }),
  stakes,
  storeProbabilities: z.boolean().default(false),
});

const scoreQuestion = z.strictObject({
  type: z.literal("score"),
  name: questionName,
  instructions: nonBlank("instructions"),
  levels: z
    .array(
      z.strictObject({
        name: oneLine("a level name"),
        description: nonBlank("a level description").exactOptional(),
      }),
    )
    .min(scoreLevelLimits.min, `a score question needs at least ${scoreLevelLimits.min} levels`)
    .max(scoreLevelLimits.max, `a score question takes at most ${scoreLevelLimits.max} levels`)
    .superRefine((levels, ctx) => {
      rejectDuplicates(
        levels.map((level) => level.name),
        "level",
        ctx,
        (index) => [index, "name"],
      );
    }),
  stakes,
});

const question: z.ZodType<Question> = z.discriminatedUnion("type", [
  noulQuestion,
  choiceQuestion,
  scoreQuestion,
]);

// A probability or confidence, so every threshold value lies in [0, 1].
const unitInterval = (what: string) =>
  z
    .number({ error: `${what} must be a number` })
    .min(0, `${what} must be at least 0`)
    .max(1, `${what} must be at most 1`);

const thresholdOverride: z.ZodType<ThresholdOverride> = z.strictObject({
  yesAbove: unitInterval("yesAbove").exactOptional(),
  noBelow: unitInterval("noBelow").exactOptional(),
  confidenceAtLeast: unitInterval("confidenceAtLeast").exactOptional(),
});

export const questionSetSchema: z.ZodType<QuestionSet> = z
  .strictObject({
    questions: z.array(question).min(1, "a question set needs at least one question"),
    read: z
      .array(nonBlank("a state field"))
      .min(1, "read must name at least one state field")
      .superRefine((fields, ctx) => {
        rejectDuplicates(fields, "state field", ctx, (index) => [index]);
      }),
    model: z.string().refine((model) => MODEL_VERSION_PATTERN.test(model), {
      error: (issue) => modelError(String(issue.input)),
    }),
    thresholds: z.record(z.string(), thresholdOverride).default({}),
    where: nonBlank("where").exactOptional(),
  })
  .superRefine((set, ctx) => {
    rejectDuplicates(
      set.questions.map((question) => question.name),
      "question name",
      ctx,
      (index) => ["questions", index, "name"],
    );
    for (const [name, override] of Object.entries(set.thresholds)) {
      const question = set.questions.find((candidate) => candidate.name === name);
      if (question === undefined) {
        const names = set.questions.map((candidate) => candidate.name).join(", ");
        ctx.addIssue({
          code: "custom",
          message: `no question is named "${name}"; thresholds are keyed by question name (${names})`,
          path: ["thresholds", name],
        });
        continue;
      }
      for (const message of thresholdProblems(question, override)) {
        ctx.addIssue({ code: "custom", message, path: ["thresholds", name] });
      }
    }
  });

/**
 * A noul takes `yesAbove` and `noBelow`, a choice or score takes `confidenceAtLeast`, and the
 * noul pair must keep `noBelow` lower than `yesAbove` once the stakes defaults fill the gaps.
 */
function thresholdProblems(question: Question, override: ThresholdOverride): string[] {
  if (question.type === "noul") {
    if (override.confidenceAtLeast !== undefined) {
      return ["a noul question takes yesAbove and noBelow, not confidenceAtLeast"];
    }
    const thresholds = resolveThresholds(question, override);
    if (thresholds.kind === "yes-no" && thresholds.noBelow >= thresholds.yesAbove) {
      return [
        `noBelow (${thresholds.noBelow}) must be lower than yesAbove (${thresholds.yesAbove})`,
      ];
    }
    return [];
  }
  if (override.yesAbove !== undefined || override.noBelow !== undefined) {
    return [`a ${question.type} question takes confidenceAtLeast, not yesAbove or noBelow`];
  }
  return [];
}

/** The config boundary: unknown input in, a question set or every problem in plain words out. */
export function parseQuestionSet(input: unknown): QuestionSetParseResult {
  const result = questionSetSchema.safeParse(input);
  if (result.success) {
    return { ok: true, questionSet: result.data };
  }
  return {
    ok: false,
    errors: result.error.issues.map((issue) =>
      issue.path.length === 0 ? issue.message : `${issue.path.join(".")}: ${issue.message}`,
    ),
  };
}
