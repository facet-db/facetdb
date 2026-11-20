import { Hono } from "hono";
import type { ApiKeys } from "./auth/api-keys.ts";
import { type AppEnv, requireApiKey } from "./auth/middleware.ts";
import { type Reviewers, reviewersRoutes } from "./auth/reviewers.ts";
import { requireReviewer, type Sessions, sessionRoutes } from "./auth/sessions.ts";
import { checkRoute } from "./check/route.ts";
import type { CheckService } from "./check/service.ts";
import { configRoutes } from "./config/routes.ts";
import type { ConfigService } from "./config/service.ts";
import { type DataServices, dataRoutes } from "./data/routes.ts";
import { ApiError } from "./errors.ts";

/** The path prefix of every endpoint; a breaking change makes a new one beside it. */
export const API_VERSION = "v1";

/** What the studio's routes need to know who is asking. */
export type StudioAccess = {
  readonly sessions: Sessions;
  readonly reviewers: Reviewers;
  /** The one project this open-source worker serves; every reviewer request belongs to it. */
  readonly projectId: string;
};

export type AppDeps = {
  readonly keys: ApiKeys;
  readonly check: CheckService;
  /** The project JSON, a draft's validation and the live preview (the studio's config door). */
  readonly config: ConfigService;
  /** The read endpoints behind the dashboard's pages: runs, decisions and the why page, Home, Sources. */
  readonly data: DataServices;
  readonly studio: StudioAccess;
  /** Makes a request id; the composition root passes the real one, a test a counter. */
  readonly newRequestId: () => string;
};

export const REQUEST_ID_HEADER = "x-request-id";

/**
 * The middleware chain, in order: request id, JSON errors in the one shape, API-key auth on
 * everything under `/v1`. Routes are mounted by feature and receive services, never stores.
 */
export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    const requestId = deps.newRequestId();
    c.set("requestId", requestId);
    c.header(REQUEST_ID_HEADER, requestId);
    await next();
  });

  // Who may call what is decided here and nowhere else, in three groups. Registration order is
  // the contract: a request answered by an earlier group never reaches a later group's middleware.
  //  1. Public: signing in and out (the cookie is the credential, and the password is checked).
  app.route(`/${API_VERSION}/session`, sessionRoutes(deps.studio.sessions));
  //  2. A project API key (`facetdb keys add`): the SDK and other servers calling the check API.
  //     Any route a program calls with a key joins this group, with `requireApiKey` on its path.
  app.use(`/${API_VERSION}/check/*`, requireApiKey(deps.keys));
  app.route(`/${API_VERSION}/check`, checkRoute(deps.check));
  //  3. Everything else under /v1 is the studio's and needs a reviewer: the OS user on this machine's loopback address, a signed session elsewhere.
  //     A route added below is reviewer-only without any further line, so a forgotten line can
  //     only close a route, never open one. The pages' read routes (runs, decisions, the why
  //     page, Home, Sources) and the review routes are mounted on `studio`; a project key
  //     does not reach them.
  const studio = new Hono<AppEnv>();
  studio.use("*", requireReviewer(deps.studio.sessions, deps.studio.projectId));
  studio.route("/", configRoutes(deps.config));
  studio.route("/", dataRoutes(deps.data));
  studio.route("/reviewers", reviewersRoutes(deps.studio.reviewers));
  app.route(`/${API_VERSION}`, studio);

  app.notFound((c) =>
    c.json(
      new ApiError(
        404,
        "not_found",
        "There is no such endpoint.",
        "See the API reference for the endpoints under /v1.",
      ).toBody(),
      404,
    ),
  );

  app.onError((error, c) => {
    if (error instanceof ApiError) {
      return c.json(error.toBody(), error.status, { ...error.headers });
    }
    // Never echo the cause: it may carry a record's state. The request id lets the operator find it.
    console.error(
      `request ${c.get("requestId")} failed`,
      error instanceof Error ? error.name : "error",
    );
    return c.json(
      new ApiError(
        500,
        "internal_error",
        "Something went wrong on our side.",
        `Try again; if it keeps failing, report request ${c.get("requestId")}.`,
      ).toBody(),
      500,
    );
  });

  return app;
}
