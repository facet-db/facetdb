import { createMiddleware } from "hono/factory";
import type { z } from "zod";
import type { AppEnv } from "./auth/middleware.ts";
import { ApiError } from "./errors.ts";

/** Reads a request's JSON body once (`@hono/node-server` buffers it); a body that is not JSON is a 400. */
export async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new ApiError(
      400,
      "invalid_json",
      "The request body is not JSON.",
      "Send a JSON body with the header `Content-Type: application/json`.",
    );
  }
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** The methods that read; the guard below lets them pass, since a cross-site GET writes nothing. */
const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Every write the session cookie authorizes takes only a request a page of the studio itself, or a
 * program, can send. app.ts mounts this right after `requireReviewer` for every method but GET,
 * HEAD and OPTIONS (so a stranger is told to sign in before being told about the body); sign-in
 * mounts it too, since its cookie is the prize. A page on another site carries the reviewer's
 * cookie to any request its browser makes, so the cookie alone cannot say who is asking; these
 * four rules, in this order, do:
 *  1. The body must be declared `application/json`, body-less writes included (the studio sends
 *     `{}`): a form or text/plain body is what another page can send without the preflight this
 *     server never approves. 415.
 *  2. `Sec-Fetch-Site`, when the browser sent it, decides: `same-origin` and `none` (the address
 *     bar, a bookmark) pass; `same-site` (a sibling subdomain, which the cookie's SameSite=Lax also
 *     lets through), `cross-site` and anything else are refused. 403. The browser computes it
 *     against the public address, so it holds behind a reverse proxy that rewrites `Host`; that is
 *     why it comes before Origin, and why no public-URL flag is needed.
 *  3. Else `Origin`, when present, must name this request's own host. 403.
 *  4. Neither header is a program (curl, the SDK): let through. The session's rules already
 *     said who is asking.
 */
export function requireOwnPage() {
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!READS.has(c.req.method)) {
      checkOwnPage(c.req);
    }
    await next();
  });
}

/** `requireOwnPage`'s four rules on one request. */
function checkOwnPage(request: { header(name: string): string | undefined; url: string }): void {
  const type = request.header("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new ApiError(
      415,
      "json_only",
      "A write to the studio takes a JSON body sent as application/json, which a page on another site cannot send.",
      "Send the header `Content-Type: application/json` with a JSON body, `{}` when there is nothing to send.",
    );
  }
  const site = request.header("sec-fetch-site");
  const origin = request.header("origin");
  const foreign =
    site !== undefined
      ? site !== "same-origin" && site !== "none"
      : origin !== undefined && hostOf(origin) !== hostOf(request.url);
  if (foreign) {
    throw new ApiError(
      403,
      "cross_origin",
      "This request came from a page on another site, and the studio takes a write only from its own pages or a program.",
      "Use the studio this worker serves, or a program on a machine you trust.",
    );
  }
}

/** Every problem of a body that failed its schema, by path, in one sentence. */
export function bodyProblems(error: z.ZodError): string {
  return `The request body is not valid: ${error.issues
    .map((issue) => `${issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue.message}`)
    .join("; ")}.`;
}
