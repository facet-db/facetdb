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

/** Every problem of a body that failed its schema, by path, in one sentence. */
export function bodyProblems(error: z.ZodError): string {
  return `The request body is not valid: ${error.issues
    .map((issue) => `${issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue.message}`)
    .join("; ")}.`;
}
