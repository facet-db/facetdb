import type { z } from "zod";
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

/**
 * A route that writes on the operator's machine takes a request only a page of the studio itself,
 * or a program, can send: a JSON body declared as such, which a page on another site cannot send
 * without a preflight this server never approves, and no `Origin` or `Sec-Fetch-Site` of another
 * site. The session's own rules still decide who is asking. `what` names the route in the refusal
 * ("Apply", "The setup"); `does` says what it writes.
 */
export function requireOwnPage(
  request: { header(name: string): string | undefined; url: string },
  words: { readonly what: string; readonly does: string; readonly from: string },
): void {
  const type = request.header("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type)) {
    throw new ApiError(
      415,
      "json_only",
      `${words.what} takes a JSON body sent as application/json, which a page on another site cannot send.`,
      "Send the header `Content-Type: application/json` with the body.",
    );
  }
  const origin = request.header("origin");
  const site = request.header("sec-fetch-site");
  if (
    (origin !== undefined && hostOf(origin) !== hostOf(request.url)) ||
    (site !== undefined && site !== "same-origin" && site !== "none")
  ) {
    throw new ApiError(
      403,
      "cross_origin",
      `This request came from a page on another site, and ${words.does}.`,
      words.from,
    );
  }
}

/** Every problem of a body that failed its schema, by path, in one sentence. */
export function bodyProblems(error: z.ZodError): string {
  return `The request body is not valid: ${error.issues
    .map((issue) => `${issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue.message}`)
    .join("; ")}.`;
}
