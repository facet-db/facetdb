import { randomUUID } from "node:crypto";
import type { Clock } from "@facetdb/core";
import type { ApiKeyStore } from "@facetdb/postgres";
import type { Hono } from "hono";
import { createApp } from "./app.ts";
import { createApiKeys } from "./auth/api-keys.ts";
import type { AppEnv } from "./auth/middleware.ts";
import { type CheckStore, type CheckWorkers, createCheckService } from "./check/service.ts";
import {
  createConfigService,
  type PreviewSource,
  type ProjectConfigDoor,
} from "./config/service.ts";

export type ServerDeps = {
  /** The API keys and the API sources' records and queues, from the FacetDB store. */
  readonly store: CheckStore & { readonly apiKeys: ApiKeyStore };
  /** The workers that answer each API source's queue. */
  readonly worker: CheckWorkers;
  readonly clock: Clock;
  /**
   * `retry-after` of a 503 when the model is unreachable, in whole seconds. The caller passes the
   * model package's backoff ceiling (`DEFAULT_MAX_MS`, `@facetdb/model`): this package does not
   * depend on the model package, so the number has one owner and no copy here.
   */
  readonly retryAfterSeconds: number;
  /**
   * The project's configuration as only the CLI has it: the loader's JSON export and its judgement
   * of a draft (this package never imports the `facetdb` package).
   */
  readonly config: ProjectConfigDoor;
  /** The preview over a running source of the worker, or undefined when it runs none by that name. */
  readonly preview: (source: string) => PreviewSource | undefined;
};

/**
 * The HTTP surface's composition root: every dependency of the app is wired here and nowhere else.
 * `facetdb worker` serves the returned app (`@hono/node-server`) next to its loop.
 */
export function createServer(deps: ServerDeps): Hono<AppEnv> {
  return createApp({
    keys: createApiKeys(deps.store.apiKeys),
    check: createCheckService({
      store: deps.store,
      worker: deps.worker,
      clock: deps.clock,
      retryAfterSeconds: deps.retryAfterSeconds,
    }),
    config: createConfigService({ config: deps.config, preview: deps.preview }),
    newRequestId: randomUUID,
  });
}
