import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import type { CheckService } from "./service.ts";

/** The body of `facetdb.check(source, { id, record })`. Values are text, or null for blank. */
const checkBody = z.strictObject({
  source: z.string().min(1),
  id: z.string().min(1),
  record: z.record(z.string(), z.string().nullable()),
});

/**
 * `POST /v1/check`: parse, one service call, map the result (the key was already checked by the
 * middleware). No SQL and no model call lives here.
 */
export function checkRoute(service: CheckService): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.post("/", async (c) => {
    const body = checkBody.safeParse(await readJson(c.req));
    if (!body.success) {
      throw new ApiError(
        400,
        "invalid_request",
        `The request body is not valid: ${body.error.issues
          .map(
            (issue) =>
              `${issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue.message}`,
          )
          .join("; ")}.`,
        'Send {"source": "<source name>", "id": "<record id>", "record": {"<field>": "<text or null>"}}.',
      );
    }

    const result = await service.check(c.get("projectId"), body.data);
    switch (result.kind) {
      case "answered":
        return c.json({ id: result.id, status: result.status, answers: result.answers });
      case "unknown_source":
        throw new ApiError(
          404,
          "unknown_source",
          `This project has no API source called "${result.source}".`,
          "Use the name of a source with `api: true` in facetdb.config.ts.",
        );
      case "invalid_record":
        throw new ApiError(
          400,
          "invalid_record",
          `The record does not match the source: ${result.problems.join("; ")}.`,
          "Send exactly the fields the source reads (`read` in facetdb.config.ts); use null for a blank one.",
        );
      case "unanswered":
        if (result.reason === "waiting") {
          throw new ApiError(
            503,
            "answer_pending",
            "The record is stored, but its answer is not ready yet.",
            "Send the same call again in a minute; an unchanged record is not asked twice.",
          );
        }
        // Past the retry window an `error` record is retried every 5 minutes and an `unchecked` one
        // is answered when the model returns, so its answer can still reach the webhook; the next
        // call meanwhile is a 200 carrying that status.
        throw new ApiError(
          503,
          "model_unavailable",
          result.queued
            ? "The model could not be asked just now. The record is stored and stays queued."
            : "The model could not be asked just now. The record is stored but not queued: the retry window is spent, so its status is now error or unchecked (the source's `onOutage`). An error record is retried every 5 minutes and an unchecked one is answered when the model returns, so a webhook may still arrive with its answer.",
          result.queued
            ? `Send the same call again after ${result.retryAfterSeconds} seconds (an unchanged record is not asked twice), or wait for the answer on your webhook.`
            : `Send the same call again after ${result.retryAfterSeconds} seconds: until the model answers, the answer is a 200 that carries the record's status (error or unchecked), and the answer itself may also arrive on your webhook.`,
          { "retry-after": String(result.retryAfterSeconds) },
        );
    }
  });

  return route;
}

async function readJson(request: { json(): Promise<unknown> }): Promise<unknown> {
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
