import { createMiddleware } from "hono/factory";
import { ApiError } from "../errors.ts";
import type { ApiKeys } from "./api-keys.ts";

/** What the middleware chain leaves on the context for the routes. */
export type AppEnv = {
  Variables: {
    requestId: string;
    /** The project the request's API key belongs to; set by `requireApiKey`. */
    projectId: string;
  };
};

/**
 * The key is checked against its hash before the route reads anything of the request. A missing,
 * malformed, unknown or revoked key all answer the same 401, so a caller cannot tell which.
 */
export function requireApiKey(keys: ApiKeys) {
  return createMiddleware<AppEnv>(async (c, next) => {
    const owner = await keys.verify(c.req.header("authorization"));
    if (owner === undefined) {
      throw new ApiError(
        401,
        "invalid_api_key",
        "This request has no valid API key.",
        "Send the header `Authorization: Bearer <key>` with a key made by `facetdb keys add`; a revoked key needs a new one.",
      );
    }
    c.set("projectId", owner.projectId);
    await next();
  });
}
