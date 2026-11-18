import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import {
  DECISIONS_DEFAULT_LIMIT,
  DECISIONS_MAX_LIMIT,
  type DecisionsService,
  parseCursor,
} from "./decisions-service.ts";

const timeText = z.iso.datetime({ offset: true }).transform((text) => new Date(text));

/** `GET /v1/decisions`: every filter by name; a name that is not one is refused, not ignored. */
const searchQuery = z.strictObject({
  source: z.string().min(1),
  key: z.string().min(1).optional(),
  question: z.string().min(1).optional(),
  status: z.enum(["decided", "needs_review"]).optional(),
  reviewer: z.string().min(1).optional(),
  from: timeText.optional(),
  to: timeText.optional(),
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(DECISIONS_MAX_LIMIT).default(DECISIONS_DEFAULT_LIMIT),
});

const SEARCH_SHAPE = `source (required), key, question, status (decided or needs_review), reviewer, from and to (ISO 8601 times such as 2026-11-05T00:00:00Z; from is included, to is not), cursor (the "next" of the previous page) and limit (1 to ${DECISIONS_MAX_LIMIT}, ${DECISIONS_DEFAULT_LIMIT} by default)`;

const unknownProject = () =>
  new ApiError(
    404,
    "unknown_project",
    "This API key belongs to a project this worker does not serve.",
    "Use a key made by `facetdb keys add` in this project's directory.",
  );

function unknownSource(source: string, known: readonly string[]): ApiError {
  return new ApiError(
    404,
    "unknown_source",
    `This project has no source called "${source}".`,
    `Use one of: ${known.join(", ")}.`,
  );
}

/**
 * `GET /v1/decisions` and `GET /v1/decisions/:source/:key`: parse, one service call, map the
 * result; the API key was checked by the middleware. The history is what `facetdb explain` builds,
 * from the same core function; nothing here reads the database.
 */
export function decisionsRoutes(service: DecisionsService): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  route.get("/decisions", async (c) => {
    const query = searchQuery.safeParse(c.req.query());
    if (!query.success) {
      throw new ApiError(
        400,
        "invalid_request",
        `The query is not valid: ${query.error.issues
          .map(
            (issue) =>
              `${issue.path.length === 0 ? "query" : issue.path.join(".")}: ${issue.message}`,
          )
          .join("; ")}.`,
        `Pass ${SEARCH_SHAPE}.`,
      );
    }
    const { cursor: cursorText, ...filters } = query.data;
    const cursor = cursorText === undefined ? undefined : parseCursor(cursorText);
    if (cursorText !== undefined && cursor === undefined) {
      throw new ApiError(
        400,
        "invalid_cursor",
        "The cursor is not one this endpoint made.",
        'Pass the "next" of the previous page unchanged, or leave cursor out for the first page.',
      );
    }
    const outcome = await service.search(c.get("projectId"), { ...filters, cursor });
    switch (outcome.kind) {
      case "ok":
        return c.json(outcome.page);
      case "unknown_project":
        throw unknownProject();
      case "unknown_source":
        throw unknownSource(filters.source, outcome.known);
    }
  });

  route.get("/decisions/:source/:key", async (c) => {
    const outcome = await service.why(
      c.get("projectId"),
      c.req.param("source"),
      c.req.param("key"),
    );
    switch (outcome.kind) {
      case "history": {
        const { kind: _kind, ...history } = outcome;
        return c.json(history);
      }
      case "unknown_project":
        throw unknownProject();
      case "unknown_source":
        throw unknownSource(c.req.param("source"), outcome.known);
      case "unknown_record":
        throw new ApiError(
          404,
          "unknown_record",
          `FacetDB has no history for record ${outcome.key} of "${outcome.source}".`,
          `Check the source and the key (it is ${outcome.form}); if the record is new, start the worker with facetdb worker, or answer existing rows with facetdb backfill.`,
        );
    }
  });

  return route;
}
