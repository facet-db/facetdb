import { Hono } from "hono";
import { z } from "zod";
import { API_VERSION } from "../api-version.ts";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import type { HookOutcome, HooksDoor } from "./door.ts";

/**
 * `POST /v1/hooks/:plugin/:source`: a plugin source's webhook, the first route a stranger on the
 * internet can call. FacetDB checks no login of its own here; the source's plugin checks the
 * sender's signature, over the exact bytes received, in its `receive`. So, in this order:
 *  1. the path's two names are judged by shape alone (an address of no such shape is unknown);
 *  2. the body is read as bytes, at most `HOOK_BODY_MAX_BYTES` (a declared length above it is
 *     refused unread, a body that grows past it as it does), and nothing of it is parsed: not as
 *     JSON, not as text, not by content type;
 *  3. the door hands those bytes and the headers to the plugin, and takes in the keys it names;
 *  4. its answer is mapped to fixed words: a plugin's own text (its receipt's `reason`, an error it
 *     threw) is never returned, and nothing of a header or the body is ever said or logged here.
 * app.ts mounts this before the studio's group, so every other method or path under `/v1/hooks`
 * falls through to the reviewer's check like any other studio route.
 */

/** The largest body a webhook may carry: 5 MB (5 MiB), refused before it is held whole (cli/serve.ts too). */
export const HOOK_BODY_MAX_BYTES = 5 * 1024 * 1024;

/** Where app.ts mounts the hooks; cli/serve.ts caps a body under it before the app sees it. */
export const HOOKS_PATH = `/${API_VERSION}/hooks`;

/**
 * `retry-after` of a 503 the plugin itself answered (its source cannot take events now): half a
 * minute, as long as the worker waits before it first tries a stopped source again.
 */
export const HOOK_RETRY_AFTER_SECONDS = 30;

/**
 * How long a delivery's plugin has to take it, its `receive` and the reads of the keys it names
 * together, on the worker's clock: 10 seconds, as long as GitHub waits for an answer before it
 * counts a delivery failed. Past it the plugin's work is abandoned through its signal, and the
 * request, its body and its socket are let go with a 504.
 */
export const HOOK_TIMEOUT_MS = 10_000;

/**
 * A plugin's short name (`github`) and a source's name in the config (`issues`), loosely and at
 * any length the config allows: lowercase letters, digits, `_` and `-`. The door looks each up
 * exactly; this only keeps any other text from reaching it. The request line that carries them is
 * bounded by the HTTP server's header limit (16 KiB in Node), not here, so no source the config
 * accepts is unreachable.
 */
const NAME = /^[a-z][a-z0-9_-]*$/;

const hookParams = z.object({ plugin: z.string().regex(NAME), source: z.string().regex(NAME) });

/** The one 413 of a body past the cap, said by this route and by the HTTP adapter alike. */
export function hookBodyTooLarge(): ApiError {
  return new ApiError(
    413,
    "body_too_large",
    `The delivery's body is larger than the ${HOOK_BODY_MAX_BYTES} bytes (5 MB) a webhook may carry here.`,
    "Send events that name what changed: the source's plugin reads each record itself.",
  );
}

/**
 * Whether a request's URL may reach a hook: its path, each percent escape decoded and in any case,
 * under `/v1/hooks/`. Wider than the router, never narrower, so the HTTP adapter caps every body
 * that could reach this route, whatever escapes or case a sender tries. A URL that does not parse
 * reaches no route.
 */
export function isHookUrl(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return false;
  }
  const decoded = path.replace(/%[0-9A-Fa-f]{2}/g, (escaped) =>
    String.fromCharCode(Number.parseInt(escaped.slice(1), 16)),
  );
  return decoded.toLowerCase().startsWith(`${HOOKS_PATH}/`);
}

/** A delivery's body as bytes, at most `HOOK_BODY_MAX_BYTES`; read once, never decoded. */
async function bodyOf(request: Request): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > HOOK_BODY_MAX_BYTES) {
    throw hookBodyTooLarge();
  }
  const stream = request.body;
  if (stream === null) {
    return new Uint8Array(0);
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      size += value.byteLength;
      if (size > HOOK_BODY_MAX_BYTES) {
        throw hookBodyTooLarge();
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }
    throw new ApiError(
      400,
      "unreadable_body",
      "The delivery's body could not be read to its end.",
      "Send the delivery again.",
    );
  } finally {
    reader.cancel().catch(() => undefined);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) {
    body.set(chunk, at);
    at += chunk.byteLength;
  }
  return body;
}

/** The headers a plugin is handed: all of them but FacetDB's own session cookie. */
function headersOf(request: Request): Headers {
  const headers = new Headers(request.headers);
  headers.delete("cookie");
  return headers;
}

const UNKNOWN_HOOK = new ApiError(
  404,
  "unknown_hook",
  "No plugin source here takes webhooks at this address.",
  "Use /v1/hooks/<plugin>/<source>: the plugin's short name (github) and the source's name in facetdb.config.ts, for a source whose plugin takes webhooks.",
);

function notRunning(retryAfterSeconds: number): ApiError {
  return new ApiError(
    503,
    "source_not_running",
    "The source this address names does not run in this worker just now, so it takes no event.",
    `Send the delivery again after ${retryAfterSeconds} seconds; the source's own poll also finds what changed meanwhile.`,
    { "retry-after": String(retryAfterSeconds) },
  );
}

function failed(requestId: string): ApiError {
  return new ApiError(
    500,
    "hook_failed",
    "The source's plugin could not take this delivery.",
    `Send it again; the worker's output says which plugin failed and where. If it keeps failing, report request ${requestId}.`,
  );
}

/**
 * A plugin's status in FacetDB's words. Any 2xx is a delivery taken; the 4xx a plugin answers
 * (GitHub's 400, 401, 413 and 422 among them) each keep their meaning, any other 4xx is a 400 that
 * says the plugin refused it; a 503 is a source that cannot take events now; anything else is the
 * plugin failing.
 */
function answered(status: number, requestId: string): ApiError | undefined {
  if (status >= 200 && status < 300) {
    return undefined;
  }
  switch (status) {
    case 400:
      return new ApiError(
        400,
        "bad_event",
        "The source's plugin could not read this event.",
        "Send this address only the deliveries of the service the source reads, as it sends them.",
      );
    case 401:
      return new ApiError(
        401,
        "bad_signature",
        "The source's plugin refused this delivery: it carries no signature, or its signature does not hold for its body.",
        "Set the same webhook secret in the sending service and in the variable the plugin's settings name, then restart the worker.",
      );
    case 404:
      return UNKNOWN_HOOK;
    case 413:
      return new ApiError(
        413,
        "body_too_large",
        "The delivery's body is larger than the source's plugin reads.",
        "Send events that name what changed: the source's plugin reads each record itself.",
      );
    case 422:
      return new ApiError(
        422,
        "not_this_source",
        "The source's plugin read this event and refused it: it is not about what this source reads (for GitHub, another repository's).",
        "Send this address only the events of what the source reads; give anything else a source of its own.",
      );
    case 503:
      return notRunning(HOOK_RETRY_AFTER_SECONDS);
    default:
      return status >= 400 && status < 500
        ? new ApiError(
            400,
            "event_refused",
            "The source's plugin refused this delivery.",
            "Check the webhook's settings in the sending service against the plugin's documentation.",
          )
        : failed(requestId);
  }
}

/**
 * A 504, not a 503: the source runs, and it is its plugin (or the service the plugin asks) that
 * was slow, so no `retry-after` can say when it will be faster.
 */
const TIMED_OUT = new ApiError(
  504,
  "hook_timeout",
  `The source's plugin had not taken this delivery after ${HOOK_TIMEOUT_MS / 1000} seconds, so it was given up.`,
  "Send it again: a record it already queued is not queued twice, and the worker's output says which plugin was slow and where.",
);

function errorOf(outcome: HookOutcome, requestId: string): ApiError | undefined {
  switch (outcome.kind) {
    case "answered":
      return answered(outcome.status, requestId);
    case "unknown":
      return UNKNOWN_HOOK;
    case "not_running":
      return notRunning(outcome.retryAfterSeconds);
    case "failed":
      return failed(requestId);
    case "timed_out":
      return TIMED_OUT;
  }
}

export function hooksRoutes(door: HooksDoor): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.post("/:plugin/:source", async (c) => {
    const params = hookParams.safeParse(c.req.param());
    if (!params.success) {
      throw UNKNOWN_HOOK;
    }
    const body = await bodyOf(c.req.raw);
    const outcome = await door.receive(params.data.plugin, params.data.source, {
      url: c.req.url,
      headers: headersOf(c.req.raw),
      body,
    });
    const error = errorOf(outcome, c.get("requestId"));
    if (error !== undefined) {
      throw error;
    }
    // Only a count: the keys are the plugin's reading of the delivery, and an answer says nothing of it.
    return c.json({ queued: outcome.kind === "answered" ? outcome.queued : 0 }, 202);
  });

  return route;
}
