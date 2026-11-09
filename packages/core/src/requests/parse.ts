import type { ZodError } from "zod";
import type { Usage } from "../contracts/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import type { Answer } from "../thresholds/index.ts";
import {
  choiceAnswerSchema,
  noulAnswerSchema,
  type SystemOneResponse,
  scoreAnswerSchema,
  systemOneResponseSchema,
} from "./schema.ts";

/** The response as FacetDB reads it: the version that answered, one answer per question, the usage. */
export type ParsedResponse = {
  readonly model: string;
  readonly answers: Readonly<Record<string, Answer>>;
  readonly usage: Usage;
};

/** A response that does not match the API reference; `field` names the part that is wrong. */
export class ResponseShapeError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(`model response: ${field} ${message}`);
    this.name = "ResponseShapeError";
    this.field = field;
  }
}

/**
 * Turns the model's response into one answer per question, each in its question's own option or
 * level order, ready for the thresholds. Missing usage is an error, never zero tokens: the
 * spending cap counts what the response says it consumed. Any mismatch throws, naming the field;
 * nothing is defaulted.
 */
export function parseAnswers(questionSet: QuestionSet, response: unknown): ParsedResponse {
  const body = parseBody(response);
  const names = new Set(questionSet.questions.map((question) => question.name));
  for (const name of Object.keys(body.answers)) {
    if (!names.has(name)) {
      throw new ResponseShapeError(`answers.${name}`, "answers a question that is not in the set");
    }
  }
  const answers: Record<string, Answer> = {};
  for (const question of questionSet.questions) {
    const raw = Object.hasOwn(body.answers, question.name)
      ? body.answers[question.name]
      : undefined;
    answers[question.name] = parseAnswer(question, raw);
  }
  return {
    model: body.model,
    answers,
    usage: { inputTokens: body.usage.input_tokens, outputTokens: body.usage.output_tokens },
  };
}

function parseBody(response: unknown): SystemOneResponse {
  const parsed = systemOneResponseSchema.safeParse(response);
  if (!parsed.success) {
    throw fromZod("response", parsed.error);
  }
  return parsed.data;
}

/**
 * One question's answer, read as the type the question declares. The answer keeps the shape the
 * thresholds consume; a choice's confidence is computed from its probabilities when it is decided
 * (`choiceConfidence`), and a score's confidence and expected value are TypeSafe's own.
 */
function parseAnswer(question: Question, raw: unknown): Answer {
  const field = `answers.${question.name}`;
  switch (question.type) {
    case "noul": {
      const parsed = noulAnswerSchema.safeParse(raw);
      if (!parsed.success) {
        throw fromZod(field, parsed.error);
      }
      return { type: "noul", probability: parsed.data.noul };
    }
    case "choice": {
      const parsed = choiceAnswerSchema.safeParse(raw);
      if (!parsed.success) {
        throw fromZod(field, parsed.error);
      }
      const options = question.options.map((option) => option.name);
      if (!options.includes(parsed.data.choice)) {
        throw new ResponseShapeError(
          `${field}.choice`,
          `names "${parsed.data.choice}", which is not an option of ${question.name}`,
        );
      }
      const top = parsed.data.choice;
      const probabilities = inOrder(`${field}.probabilities`, options, parsed.data.probabilities);
      // The named top option must hold the highest probability (ties allowed): a response that
      // contradicts itself is an error, never an answer.
      if (probabilities[options.indexOf(top)] !== Math.max(...probabilities)) {
        throw new ResponseShapeError(
          `${field}.choice`,
          `names "${top}", which does not hold the highest probability`,
        );
      }
      return { type: "choice", top, probabilities };
    }
    case "score": {
      const parsed = scoreAnswerSchema.safeParse(raw);
      if (!parsed.success) {
        throw fromZod(field, parsed.error);
      }
      const levels = question.levels.map((_, index) => String(index));
      return {
        type: "score",
        probabilities: inOrder(`${field}.probabilities`, levels, parsed.data.probabilities),
        confidence: parsed.data.confidence,
        expected: parsed.data.score,
      };
    }
  }
}

/**
 * The probabilities in the question's own order. Every key must be present and no extra key may
 * appear: a missing or unknown option or level is a mismatch, never a zero.
 */
function inOrder(
  field: string,
  keys: readonly string[],
  record: Readonly<Record<string, number>>,
): number[] {
  for (const key of Object.keys(record)) {
    if (!keys.includes(key)) {
      throw new ResponseShapeError(`${field}.${key}`, "is not an option or level of this question");
    }
  }
  const probabilities: number[] = [];
  for (const key of keys) {
    const value = Object.hasOwn(record, key) ? record[key] : undefined;
    if (value === undefined) {
      throw new ResponseShapeError(`${field}.${key}`, "is missing its probability");
    }
    probabilities.push(value);
  }
  return probabilities;
}

/** The zod issue as a plain error: the path names the field, the message says what is wrong. */
function fromZod(prefix: string, error: ZodError): ResponseShapeError {
  const issue = error.issues[0];
  const path = issue === undefined || issue.path.length === 0 ? "" : `.${issue.path.join(".")}`;
  return new ResponseShapeError(`${prefix}${path}`, issue?.message ?? "does not match the API");
}
