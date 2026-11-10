import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The one error shape of the HTTP surface: a stable `code`, a plain `message`, and the `fix`, the
 * sentence the CLI would print.
 */
export type ErrorBody = {
  readonly error: { readonly code: string; readonly message: string; readonly fix: string };
};

/** A failure the caller can act on. Anything else that reaches the app is a bug and answers 500. */
export class ApiError extends Error {
  readonly status: ContentfulStatusCode;
  readonly code: string;
  readonly fix: string;

  constructor(status: ContentfulStatusCode, code: string, message: string, fix: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fix = fix;
  }

  toBody(): ErrorBody {
    return { error: { code: this.code, message: this.message, fix: this.fix } };
  }
}
