import { Hono } from "hono";
import { API_VERSION } from "./api-version.ts";
import type { ApiKeys } from "./auth/api-keys.ts";
import { type AppEnv, requireApiKey } from "./auth/middleware.ts";
import { addressCheck } from "./auth/operator.ts";
import { type Reviewers, reviewersRoutes } from "./auth/reviewers.ts";
import { requireReviewer, type Sessions, sessionRoutes } from "./auth/sessions.ts";
import { checkRoute } from "./check/route.ts";
import type { CheckService } from "./check/service.ts";
import { configRoutes } from "./config/routes.ts";
import type { ConfigService } from "./config/service.ts";
import { type DataServices, dataRoutes } from "./data/routes.ts";
import { ApiError } from "./errors.ts";
import { HOOKS_PATH, type HooksDoor, hooksRoutes, NO_HOOKS } from "./hooks/index.ts";
import { NO_PLUGINS, type PluginsDoor, pluginsRoutes } from "./plugins/index.ts";
import { requireOwnPage } from "./request.ts";
import { reviewRoutes } from "./review/routes.ts";
import type { ReviewEndpointService } from "./review/service.ts";
import { type BackfillJobsDoor, NO_BACKFILL_JOBS } from "./sources/backfill-door.ts";
import { backfillRoutes } from "./sources/backfill-routes.ts";
import { setupRoutes } from "./sources/routes.ts";
import { NO_SETUP, type SetupService } from "./sources/service.ts";
import type { StudioBuild } from "./studio/build.ts";
import { projectRoutes, studioAppRoutes } from "./studio/routes.ts";

/** What the studio's routes need to know who is asking. */
export type StudioAccess = {
  readonly sessions: Sessions;
  readonly reviewers: Reviewers;
  /** The one project this open-source worker serves; every reviewer request belongs to it. */
  readonly projectId: string;
  /**
   * Whether a request from this machine is the operator, who needs no sign-in: false when the
   * config's `studioUrl` names another host (`operatorKnownByAddress`), and then every request
   * signs in and none may add a source or install a question from the studio.
   */
  readonly operatorByAddress: boolean;
  /** The worker's log: the one line about a proxy in front with no forwarding header. */
  readonly log: (line: string) => void;
};

export type AppDeps = {
  readonly keys: ApiKeys;
  readonly check: CheckService;
  /** The project JSON, a draft's validation and the live preview (the studio's config door). */
  readonly config: ConfigService;
  /** The read endpoints behind the dashboard's pages: runs, decisions and the why page, Home, Sources. */
  readonly data: DataServices;
  /** The review screen's and the terminal's door: the queue, a card under its lock, a decision, an undo. */
  readonly review: ReviewEndpointService;
  /**
   * Adding a source from the studio: inspect, preview, plan and install with the admin connection
   * string, the operator's on this machine alone. Absent, the page is told it cannot be done here.
   */
  readonly setup?: SetupService;
  /** The worker's backfill jobs; absent, every backfill route says this worker runs none. */
  readonly backfill?: BackfillJobsDoor;
  /** The hosted plugins, the registry's gallery and the packs; absent, every list is empty. */
  readonly plugins?: PluginsDoor;
  /** The plugin sources' webhooks; absent, every hook is unknown (404). */
  readonly hooks?: HooksDoor;
  readonly studio: StudioAccess;
  /**
   * The studio's built app, served after every `/v1` route; absent, no file is served (a worker
   * whose studio is not built, and every test that leaves it out).
   */
  readonly studioApp?: StudioBuild;
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
  // Who a request is by its address (`byAddress`): one instance, so the proxy line it may print is
  // printed once, run first in the two groups that read it (1 and 4).
  const byAddress = addressCheck({
    operatorByAddress: deps.studio.operatorByAddress,
    log: deps.studio.log,
  });

  // Who may call what is decided here and nowhere else, in four groups. Registration order is
  // the contract: a request answered by an earlier group never reaches a later group's middleware.
  //  1. Public: signing in and out (the cookie is the credential, and the password is checked).
  app.use(`/${API_VERSION}/session/*`, byAddress);
  // A sign-out ends the reviewer's undo too: the review service forgets their last decision.
  app.route(
    `/${API_VERSION}/session`,
    sessionRoutes(deps.studio.sessions, (reviewer) => {
      deps.review.forget(reviewer);
    }),
  );
  //  2. A project API key (`facetdb keys add`): the SDK and other servers calling the check API.
  //     Any route a program calls with a key joins this group, with `requireApiKey` on its path.
  app.use(`/${API_VERSION}/check/*`, requireApiKey(deps.keys));
  app.route(`/${API_VERSION}/check`, checkRoute(deps.check));
  //  3. Public, and checked by a plugin alone: `POST /v1/hooks/:plugin/:source`, a
  //     plugin source's webhook, whose plugin checks the sender's signature over the exact bytes
  //     received. Only that one method and shape is answered here; anything else under /v1/hooks
  //     falls through to the studio's group below like any other path.
  app.route(HOOKS_PATH, hooksRoutes(deps.hooks ?? NO_HOOKS));
  //  4. Everything else under /v1 is the studio's and needs a reviewer: the OS user on this machine's loopback address, a signed session elsewhere.
  //     A route added below is reviewer-only without any further line, so a forgotten line can
  //     only close a route, never open one. The pages' read routes (runs, decisions, the why
  //     page, Home, Sources) and the review routes are mounted on `studio`; a project key
  //     does not reach them. Every write among them (any method but GET, HEAD and OPTIONS) then
  //     takes only the studio's own page or a program (`requireOwnPage`): the cookie rides along
  //     with a request from any page open in the reviewer's browser, so a page of another site
  //     must not be able to decide a card, make an account or spend model budget with it. The
  //     reviewer check comes first, so a stranger is told to sign in, not about the body.
  const studio = new Hono<AppEnv>();
  studio.use("*", byAddress);
  studio.use("*", requireReviewer(deps.studio.sessions, deps.studio.projectId));
  studio.use("*", requireOwnPage());
  studio.route("/", configRoutes(deps.config));
  studio.route("/", dataRoutes(deps.data));
  // The setup flow; its writing routes add the operator-only check of their own.
  studio.route("/", setupRoutes(deps.setup ?? NO_SETUP));
  // The backfill jobs.
  studio.route("/", backfillRoutes(deps.backfill ?? NO_BACKFILL_JOBS));
  // The plugins, the gallery and the packs.
  studio.route("/", pluginsRoutes(deps.plugins ?? NO_PLUGINS));
  studio.route("/", reviewRoutes(deps.review));
  studio.route("/reviewers", reviewersRoutes(deps.studio.reviewers));
  studio.route("/", projectRoutes());
  app.route(`/${API_VERSION}`, studio);
  //  5. Last, and public: the built app's files and its pages. The sign-in page must
  //     load before anyone has signed in, and the files hold the build alone; never a path under
  //     /v1, which the groups above answer or leave to the JSON 404 below.
  if (deps.studioApp !== undefined) {
    app.route("/", studioAppRoutes(deps.studioApp, `/${API_VERSION}`));
  }

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
