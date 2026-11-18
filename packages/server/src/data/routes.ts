import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../auth/middleware.ts";
import { ApiError } from "../errors.ts";
import { decisionsRoutes } from "./decisions.ts";
import type { DecisionsService } from "./decisions-service.ts";
import { type HomeService, homeRoutes } from "./home.ts";
import { RUNS_PER_PAGE, type RunsService } from "./runs.ts";
import { type SourcesService, sourcesRoutes } from "./sources.ts";

/**
 * The read endpoints behind the dashboard's pages: each is parse, one service call, map; the API
 * key was checked by the middleware. One service per page's data.
 */
export type DataServices = {
  readonly runs: RunsService;
  /** The decision log searched, and one record's history (the Decisions page and the why page). */
  readonly decisions: DecisionsService;
  /** The dashboard's Home and Sources figures. */
  readonly home: HomeService;
  readonly sources: SourcesService;
};

/** A source as the config names one; anything else could never match, so it is refused plainly. */
const sourceName = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "a source name is lowercase letters, digits and underscores");

const runsQuery = z.strictObject({
  source: sourceName.optional(),
  // The largest page whose offset is still a whole number JavaScript holds exactly.
  page: z.coerce
    .number()
    .int()
    .min(1)
    .max(Math.floor(Number.MAX_SAFE_INTEGER / RUNS_PER_PAGE))
    .default(1),
});

function parsedQuery<Schema extends z.ZodType>(
  schema: Schema,
  query: Record<string, string>,
  fix: string,
): z.output<Schema> {
  const parsed = schema.safeParse(query);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "invalid_request",
      `The query is not valid: ${parsed.error.issues
        .map(
          (issue) =>
            `${issue.path.length === 0 ? "query" : issue.path.join(".")}: ${issue.message}`,
        )
        .join("; ")}.`,
      fix,
    );
  }
  return parsed.data;
}

export function dataRoutes(services: DataServices): Hono<AppEnv> {
  const route = new Hono<AppEnv>();

  // The run log, newest first, 50 a page.
  route.get("/runs", async (c) => {
    const query = parsedQuery(
      runsQuery,
      c.req.query(),
      `Ask GET /v1/runs, with ?source=<source name> for one source and ?page=2 (from 1) for older runs, ${RUNS_PER_PAGE} a page.`,
    );
    return c.json(await services.runs.list(c.get("projectId"), query.source, query.page));
  });

  // The decision log and the why page, in their own file.
  route.route("/", decisionsRoutes(services.decisions));
  // Home and Sources.
  route.route("/", homeRoutes(services.home));
  route.route("/", sourcesRoutes(services.sources));

  return route;
}
