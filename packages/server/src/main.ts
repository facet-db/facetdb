import { randomUUID } from "node:crypto";
import type { Clock } from "@facetdb/core";
import type { ApiKeyStore } from "@facetdb/postgres";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { createApiKeys } from "./auth/api-keys.ts";
import type { AppEnv } from "./auth/middleware.ts";
import { type CheckStore, type CheckWorkers, createCheckService } from "./check/service.ts";

export type ServerDeps = {
  /** The API keys and the API sources' records and queues, from the FacetDB store. */
  readonly store: CheckStore & { readonly apiKeys: ApiKeyStore };
  /** The workers that answer each API source's queue. */
  readonly worker: CheckWorkers;
  readonly clock: Clock;
};

/**
 * The HTTP surface's composition root: every dependency of the app is wired here and nowhere else.
 * `facetdb worker` serves the returned app (`@hono/node-server`) next to its loop.
 */
export function createServer(deps: ServerDeps): Hono<AppEnv> {
  return createApp({
    keys: createApiKeys(deps.store.apiKeys),
    check: createCheckService({ store: deps.store, worker: deps.worker, clock: deps.clock }),
    newRequestId: randomUUID,
  });
}
