import {
  type Answer,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  type Question,
  ResponseShapeError,
  type Usage,
} from "@facetdb/core";
import { ModelUnreachableError, RetryableError, UnexpectedStatusError } from "../errors.ts";

/** One scripted failure, thrown as the error the real client would throw for it. */
export type FakeFailure =
  | { readonly kind: "429"; readonly retryAfterMs?: number }
  | { readonly kind: "529"; readonly retryAfterMs?: number }
  | { readonly kind: "503" }
  | { readonly kind: "timeout" }
  | { readonly kind: "malformed" };

/**
 * What the fake answers with. Nothing is random: the same script and the same calls give the same
 * answers and failures.
 */
export type FakeScript = {
  /** Answers by record key, then by question name. */
  readonly answers?: Readonly<Record<string, Readonly<Record<string, Answer>>>>;
  /** The state field that holds the record key; required when `answers` is given. */
  readonly keyField?: string;
  /**
   * A certain answer per question type, for records the fixture does not name: a noul's
   * probability, the index of a choice's top option, the index of a score's level.
   */
  readonly defaults?: {
    readonly noul?: number;
    readonly choice?: number;
    readonly score?: number;
  };
  /** Failures by call index, counting from 0 over every `ask`, failed or not. */
  readonly failures?: Readonly<Record<number, FakeFailure>>;
  /** Tokens every successful call reports; default 100 in, 0 out. */
  readonly usage?: Usage;
};

/** The provider plus what a test asserts on: how many calls, and exactly what was sent. */
export type FakeProvider = ModelProvider & {
  /** Every `ask`, failed ones included. */
  readonly callCount: number;
  /** The payloads, in call order. */
  readonly requests: readonly ProviderRequest[];
};

const DEFAULT_USAGE: Usage = { inputTokens: 100, outputTokens: 0 };

export function createFakeProvider(script: FakeScript = {}): FakeProvider {
  if (script.answers !== undefined && script.keyField === undefined) {
    throw new Error("a fake provider with answers by record key needs a keyField");
  }
  const requests: ProviderRequest[] = [];
  return {
    get callCount() {
      return requests.length;
    },
    requests,
    ask(request: ProviderRequest): Promise<ProviderResponse> {
      const index = requests.length;
      requests.push(request);
      try {
        const failure = Object.hasOwn(script.failures ?? {}, index)
          ? script.failures?.[index]
          : undefined;
        if (failure !== undefined) {
          throw failureError(failure);
        }
        return Promise.resolve({
          model: request.model,
          answers: answersFor(script, request),
          usage: script.usage ?? DEFAULT_USAGE,
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}

function failureError(failure: FakeFailure): Error {
  switch (failure.kind) {
    case "429":
      return new RetryableError(429, failure.retryAfterMs);
    case "529":
      return new RetryableError(529, failure.retryAfterMs);
    case "503":
      return new UnexpectedStatusError(503);
    case "timeout":
      return new ModelUnreachableError("the request timed out");
    case "malformed":
      return new ResponseShapeError("response.answers", "is not an object of answers");
  }
}

function answersFor(script: FakeScript, request: ProviderRequest): Record<string, Answer> {
  const fixture = fixtureFor(script, request);
  const answers: Record<string, Answer> = {};
  for (const question of request.questions) {
    const scripted =
      fixture !== undefined && Object.hasOwn(fixture, question.name)
        ? fixture[question.name]
        : undefined;
    const answer = scripted ?? defaultAnswer(script, question);
    if (answer.type !== question.type) {
      throw new Error(
        `the fake script answers ${question.name} as a ${answer.type}, but it is a ${question.type}`,
      );
    }
    answers[question.name] = answer;
  }
  return answers;
}

function fixtureFor(
  script: FakeScript,
  request: ProviderRequest,
): Readonly<Record<string, Answer>> | undefined {
  if (script.answers === undefined || script.keyField === undefined) {
    return undefined;
  }
  const key = request.state[script.keyField];
  if (typeof key !== "string") {
    throw new Error(
      `the fake script reads the record key from state.${script.keyField}, which is not a string`,
    );
  }
  return Object.hasOwn(script.answers, key) ? script.answers[key] : undefined;
}

function defaultAnswer(script: FakeScript, question: Question): Answer {
  const defaults = script.defaults ?? {};
  switch (question.type) {
    case "noul":
      if (defaults.noul === undefined) {
        break;
      }
      return { type: "noul", probability: defaults.noul };
    case "choice": {
      if (defaults.choice === undefined) {
        break;
      }
      const top = question.options[defaults.choice];
      if (top === undefined) {
        throw new Error(
          `the fake script's default choice ${defaults.choice} is not an option of ${question.name}`,
        );
      }
      return {
        type: "choice",
        top: top.name,
        probabilities: question.options.map((_, i) => (i === defaults.choice ? 1 : 0)),
      };
    }
    case "score":
      if (defaults.score === undefined) {
        break;
      }
      if (question.levels[defaults.score] === undefined) {
        throw new Error(
          `the fake script's default level ${defaults.score} is not a level of ${question.name}`,
        );
      }
      return {
        type: "score",
        probabilities: question.levels.map((_, i) => (i === defaults.score ? 1 : 0)),
        confidence: 1,
        expected: defaults.score,
      };
  }
  throw new Error(
    `the fake script has no answer for ${question.name} (a ${question.type}): add it to answers or defaults`,
  );
}
