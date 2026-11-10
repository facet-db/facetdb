import { Hono } from "hono";
import type { ApiKeys } from "./auth/api-keys.ts";
import { type AppEnv, requireApiKey } from "./auth/middleware.ts";
import { checkRoute } from "./check/route.ts";
import type { CheckService } from "./check/service.ts";
import { ApiError } from "./errors.ts";

/** The path prefix of every endpoint; a breaking change makes a new one beside it. */
export const API_VERSION = "v1";

export type AppDeps = {
  readonly keys: ApiKeys;
  readonly check: CheckService;
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

  app.use(`/${API_VERSION}/*`, requireApiKey(deps.keys));
  app.route(`/${API_VERSION}/check`, checkRoute(deps.check));

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
      return c.json(error.toBody(), error.status);
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
