/**
 * What a failed model call looks like to the caller. A failed call is an error, never an answer:
 * the retry policy and the worker's outage policy decide what to do with each of these; nothing
 * here retries.
 */

/** TypeSafe refused the request as written (400, 401, 413, 415, 422): retrying the same request cannot help. */
export class RequestRejectedError extends Error {
  readonly status: number;
  /** The offending request field, when TypeSafe named one in `detail` (a dotted path such as `questions.scam`). */
  readonly field: string | undefined;

  constructor(status: number, message: string, field: string | undefined) {
    super(field === undefined ? message : `${message} (field: ${field})`);
    this.name = "RequestRejectedError";
    this.status = status;
    this.field = field;
  }
}

/** 429 (rate limit) or 529 (overloaded): worth retrying later, with backoff. */
export class RetryableError extends Error {
  readonly status: 429 | 529;
  /** The wait `retry-after` asked for, in milliseconds; absent when the header was absent. */
  readonly retryAfterMs: number | undefined;

  constructor(status: 429 | 529, retryAfterMs: number | undefined) {
    super(
      status === 429
        ? "the model is rate limiting this project (429)"
        : "the model is overloaded (529)",
    );
    this.name = "RetryableError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Any other non-2xx status (a gateway's 502 or 503, say): not an answer, not a rule of the API. */
export class UnexpectedStatusError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`the model answered with status ${status}, which the API reference does not list`);
    this.name = "UnexpectedStatusError";
    this.status = status;
  }
}

/** The request never got a response (connection refused, DNS, timeout). */
export class ModelUnreachableError extends Error {
  constructor(reason: string, options?: { cause: unknown }) {
    super(`the model could not be reached: ${reason}`, options);
    this.name = "ModelUnreachableError";
  }
}
