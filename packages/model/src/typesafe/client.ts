import {
  buildRequest,
  type Clock,
  type ModelProvider,
  type ProviderRequest,
  type ProviderResponse,
  parseAnswers,
  type QuestionSet,
} from "@facetdb/core";
import {
  ModelUnreachableError,
  RequestRejectedError,
  RetryableError,
  UnexpectedStatusError,
} from "../errors.ts";
import { SYSTEMONE_PATH } from "../paths.ts";
import { rejectionFrom } from "./detail.ts";
import { retryAfterMs } from "./retry-after.ts";

export const TYPESAFE_BASE_URL = "https://api.typesafe.ai";

export type TypeSafeProviderOptions = {
  /** The key, read from `TYPESAFE_API_KEY` by the composition root; it is never logged. */
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch: typeof fetch;
  /** Measures an HTTP-date `retry-after` against now. */
  readonly clock: Clock;
};

const REJECTED = new Set([400, 401, 413, 415, 422]);

/**
 * The TypeSafe System One client: `ask` is exactly one `POST /v1/systemone`. It validates the
 * response, returns the tokens the call consumed, and maps failures to typed errors. It never
 * retries (the retry policy wraps it) and never turns a failure into an answer.
 */
export function createTypeSafeProvider(options: TypeSafeProviderOptions): ModelProvider {
  const url = `${(options.baseUrl ?? TYPESAFE_BASE_URL).replace(/\/+$/, "")}${SYSTEMONE_PATH}`;
  return {
    async ask(request: ProviderRequest): Promise<ProviderResponse> {
      // The request already carries only the state the questions read.
      const questionSet: QuestionSet = {
        questions: request.questions,
        read: Object.keys(request.state),
        model: request.model,
        thresholds: {},
      };
      const body = JSON.stringify(buildRequest(questionSet, request.state));
      let response: Response;
      try {
        response = await options.fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${options.apiKey}`,
            "content-type": "application/json",
          },
          body,
        });
      } catch (cause) {
        throw new ModelUnreachableError(
          cause instanceof Error ? cause.message : "the request failed",
          { cause },
        );
      }
      if (response.status === 429 || response.status === 529) {
        throw new RetryableError(
          response.status,
          retryAfterMs(response.headers.get("retry-after"), options.clock.now()),
        );
      }
      if (REJECTED.has(response.status)) {
        const rejection = rejectionFrom(await response.text());
        throw new RequestRejectedError(response.status, rejection.message, rejection.field);
      }
      if (!response.ok) {
        throw new UnexpectedStatusError(response.status);
      }
      const parsed = parseAnswers(questionSet, await response.json());
      return { answers: parsed.answers, usage: parsed.usage };
    },
  };
}
