import type { RecordStatus } from "@facetdb/core";
import type { CheckedAnswer } from "@facetdb/server";
import { API_VERSION } from "@facetdb/server";
import { z } from "zod";

/**
 * One API source as the client sees it: the fields of `record` (text, or null for a blank one) and
 * the answers by question name. A project writes it once beside its config:
 *
 * ```ts
 * type Sources = {
 *   support_tickets: {
 *     record: { subject: string; body: string | null };
 *     answers: { urgency: { value: string; confidence: number } };
 *   };
 * };
 * const facetdb = createClient<Sources>({ url, apiKey, fetch });
 * ```
 */
export type SourceTypes = {
  readonly record: Readonly<Record<string, string | null>>;
  readonly answers: Readonly<Record<string, CheckedAnswer>>;
};

/** Without a type argument any source name and any record are accepted. */
export type AnySources = Readonly<Record<string, SourceTypes>>;

/** What `check` returns: `status` is `done` or `needs_review` once answered. */
export type CheckResponse<Answers> = {
  readonly id: string;
  readonly status: RecordStatus;
  /** Decided questions only: a question left to a person has no answer here yet. */
  readonly answers: Partial<Answers>;
};

export type ClientOptions = {
  /** The base URL of the FacetDB server, e.g. `https://facetdb.example.com`. */
  readonly url: string;
  /** A project key made by `facetdb keys add`; read it from `FACETDB_API_KEY`, never from a file. */
  readonly apiKey: string;
  /** The HTTP client: the platform's `fetch`, or a test's fake. */
  readonly fetch: typeof fetch;
};

export type FacetdbClient<Sources extends AnySources> = {
  check<Name extends keyof Sources & string>(
    source: Name,
    input: { readonly id: string; readonly record: Sources[Name]["record"] },
  ): Promise<CheckResponse<Sources[Name]["answers"]>>;
};

/** The server refused the call or answered something the client cannot use. `fix` says what to do. */
export class FacetdbApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fix: string;
  readonly requestId: string | undefined;

  constructor(
    status: number,
    code: string,
    message: string,
    fix: string,
    requestId?: string | undefined,
  ) {
    super(`${message} ${fix}`);
    this.name = "FacetdbApiError";
    this.status = status;
    this.code = code;
    this.fix = fix;
    this.requestId = requestId;
  }
}

/**
 * The 503 of the check API: the model could not be asked (or the answer is not ready yet). The
 * record is stored and queued, and the answer arrives by webhook. `retryAfterMs` is the server's
 * `retry-after` header in milliseconds, or undefined when the server sent none.
 */
export class ModelUnavailableError extends FacetdbApiError {
  readonly retryAfterMs: number | undefined;

  constructor(
    code: string,
    message: string,
    fix: string,
    retryAfterMs: number | undefined,
    requestId?: string | undefined,
  ) {
    super(503, code, message, fix, requestId);
    this.name = "ModelUnavailableError";
    this.retryAfterMs = retryAfterMs;
  }
}

// The HTTP bodies are the boundary: nothing past these schemas trusts the server's JSON.
const answerBody = z.union([
  z.object({ value: z.boolean(), probability: z.number() }),
  z.object({ value: z.string(), confidence: z.number(), expected: z.number().optional() }),
]);

const successBody = z.object({
  id: z.string(),
  status: z.enum(["pending", "done", "needs_review", "error", "unchecked", "skipped"]),
  answers: z.record(z.string(), answerBody),
});

const errorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), fix: z.string() }),
});

export function createClient<Sources extends AnySources = AnySources>(
  options: ClientOptions,
): FacetdbClient<Sources> {
  requireSecureUrl(options.url);
  const endpoint = `${options.url.replace(/\/+$/, "")}/${API_VERSION}/check`;

  return {
    async check(source, input) {
      const response = await options.fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({ source, id: input.id, record: input.record }),
      });
      const requestId = response.headers.get("x-request-id") ?? undefined;
      const body: unknown = await response.json().catch(() => undefined);

      if (response.ok) {
        const parsed = successBody.safeParse(body);
        if (!parsed.success) {
          throw new FacetdbApiError(
            response.status,
            "unexpected_response",
            "The server's answer is not in the shape this client knows.",
            "Update the facetdb package to the version of your server, then try again.",
            requestId,
          );
        }
        return parsed.data as CheckResponse<Sources[typeof source]["answers"]>;
      }

      const failure = errorBody.safeParse(body);
      const { code, message, fix } = failure.success
        ? failure.data.error
        : {
            code: "unexpected_response",
            message: `The server answered ${response.status} without an error body.`,
            fix: "Check that the url you gave createClient points at a FacetDB server.",
          };
      if (response.status === 503) {
        throw new ModelUnavailableError(
          code,
          message,
          fix,
          retryAfterMs(response.headers.get("retry-after")),
          requestId,
        );
      }
      throw new FacetdbApiError(response.status, code, message, fix, requestId);
    },
  };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The bearer key travels on every call, so cleartext `http://` is for this machine only. */
function requireSecureUrl(url: string): void {
  const parsed = URL.parse(url);
  if (parsed === null || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    throw new TypeError(
      `The url "${url}" is not a web address. Give createClient the address of your FacetDB server, such as https://facetdb.example.com.`,
    );
  }
  if (parsed.protocol === "http:" && !LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new TypeError(
      `The url "${url}" is plain http://, and the API key would cross the network in cleartext. Use https:// (http:// is accepted only for localhost, 127.0.0.1 and [::1]).`,
    );
  }
}

/** `retry-after` in seconds, as the server sends it; anything else is treated as absent. */
function retryAfterMs(header: string | null): number | undefined {
  return header !== null && /^\d{1,9}$/.test(header) ? Number(header) * 1000 : undefined;
}
