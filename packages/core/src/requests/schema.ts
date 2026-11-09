import { z } from "zod";

/**
 * The request and response of `POST /v1/systemone` as checked on 2026-10-28 against the API
 * reference. The request schema is strict: the payload carries no field the API reference does
 * not list. The response schema lists only the fields FacetDB reads; a field the API adds is
 * ignored, a field it drops or retypes is an error.
 */

const probability = z.number().min(0).max(1);

const noulRequestQuestion = z.strictObject({
  type: z.literal("noul"),
  instructions: z.string().min(1),
  criteria: z
    .strictObject({
      true: z.string().min(1).exactOptional(),
      false: z.string().min(1).exactOptional(),
    })
    .exactOptional(),
});

// One description per option, keyed by the option's name.
const choiceRequestQuestion = z.strictObject({
  type: z.literal("choice"),
  instructions: z.string().min(1),
  criteria: z.record(z.string(), z.string().min(1)),
});

// One description per level, lowest first; the position is the score.
const scoreRequestQuestion = z.strictObject({
  type: z.literal("score"),
  instructions: z.string().min(1),
  criteria: z.array(z.string().min(1)).min(1),
});

export const systemOneQuestionSchema = z.discriminatedUnion("type", [
  noulRequestQuestion,
  choiceRequestQuestion,
  scoreRequestQuestion,
]);

export const systemOneRequestSchema = z.strictObject({
  model: z.string().min(1),
  state: z.record(z.string(), z.string().nullable()),
  questions: z.record(z.string(), systemOneQuestionSchema),
});

export type SystemOneQuestion = z.infer<typeof systemOneQuestionSchema>;
export type SystemOneRequest = z.infer<typeof systemOneRequestSchema>;

// A noul answer is the probability that the statement is true.
export const noulAnswerSchema = z.object({ noul: probability });

// A choice answer names the top option and gives a probability per option, keyed by option name.
// TypeSafe's own confidence is not read: FacetDB computes choice confidence itself.
export const choiceAnswerSchema = z.object({
  choice: z.string().min(1),
  probabilities: z.record(z.string(), probability),
});

// A score answer gives the probability-weighted level, a confidence and a probability per level,
// keyed "0", "1", … in level order.
export const scoreAnswerSchema = z.object({
  score: z.number().finite(),
  confidence: probability,
  probabilities: z.record(z.string(), probability),
});

export const systemOneResponseSchema = z.object({
  model: z.string().min(1),
  answers: z.record(z.string(), z.unknown()),
  usage: z.object({
    input_tokens: z.int().nonnegative(),
    output_tokens: z.int().nonnegative(),
  }),
});

export type SystemOneResponse = z.infer<typeof systemOneResponseSchema>;
