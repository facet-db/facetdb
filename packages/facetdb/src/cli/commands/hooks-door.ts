import type { Clock } from "@facetdb/core";
import { HOOK_TIMEOUT_MS, HOOKS_PATH, type HooksDoor } from "@facetdb/server";
import type { ProjectConfig, SourceCall } from "../../config/index.ts";
import {
  type PluginHost,
  PluginSourceFailed,
  SourceAccessLost,
  shortName,
} from "../../plugin/index.ts";
import { type Fleet, RETRY_FIRST_MS } from "./config-reload.ts";

/**
 * The worker's door for a plugin source's webhook: the delivery `POST /v1/hooks/:plugin/:source`
 * took is handed to the loop in force of the source of that name, when it is a plugin source of
 * that plugin (by its short name: `github` for `@facetdb/github`), whose plugin's `receive` checks
 * it and names its keys, taken into the store's queue (source-connector.ts). The whole of it has
 * `HOOK_TIMEOUT_MS` on the worker's clock: past it the plugin's work is abandoned through its
 * signal and the sender is answered. The door never reads the delivery; the only lines it prints
 * name the source and say, in FacetDB's own words, what of its plugin failed or was slow.
 */

export type HooksDoorDeps = {
  /** The sources the worker runs now, the file as it loads now, and the stopped ones' next tries. */
  readonly fleet: Pick<Fleet, "config" | "loop" | "stopped">;
  /** The plugins this worker loaded when it started: whether a stopped source takes webhooks. */
  readonly plugins: PluginHost;
  readonly clock: Pick<Clock, "now" | "sleep">;
  readonly print: (line: string) => void;
};

/**
 * Whether the plugin source a config writes takes webhooks, its plugin's source having `receive`;
 * undefined when this worker did not load its plugin, which only a restart can tell.
 */
function takesWebhooks(host: PluginHost, call: SourceCall): boolean | undefined {
  const hosted = host.plugin(call.plugin);
  if (hosted === undefined) {
    return undefined;
  }
  return (
    Object.hasOwn(hosted.plugin.sources, call.source) &&
    hosted.plugin.sources[call.source]?.receive !== undefined
  );
}

/** What a delivery's race resolves to when its time ran out first. */
const EXPIRED = Symbol("expired");

export function createHooksDoor(deps: HooksDoorDeps): HooksDoor {
  /**
   * The seconds until the fleet tries the stopped source again; for a source with no try planned
   * (refused until a restart or Check again, or not started yet), the fleet's first wait.
   */
  function retryAfterSeconds(name: string): number {
    const retryAt = deps.fleet.stopped().find((entry) => entry.source === name)?.retryAt;
    if (retryAt === undefined || retryAt === null) {
      return Math.ceil(RETRY_FIRST_MS / 1000);
    }
    return Math.max(1, Math.ceil((Date.parse(retryAt) - deps.clock.now()) / 1000));
  }

  return {
    async receive(plugin, name, delivery) {
      const loop = deps.fleet.loop(name);
      if (loop === undefined) {
        // In the file but not running (stopped and tried again, or waiting for a restart): the
        // sender may try again, and the source's own poll finds the change meanwhile too. A
        // source whose plugin takes no webhook is unknown here, as it is while it runs.
        const call = deps.fleet.config().sources.find((source) => source.name === name)?.source;
        return call !== undefined &&
          shortName(call.plugin) === plugin &&
          takesWebhooks(deps.plugins, call) !== false
          ? { kind: "not_running", retryAfterSeconds: retryAfterSeconds(name) }
          : { kind: "unknown" };
      }
      if (
        loop.plugin === undefined ||
        loop.receive === undefined ||
        shortName(loop.plugin.packageName) !== plugin
      ) {
        return { kind: "unknown" };
      }
      // The plugin's contract is the standard Request, its body unread: the exact bytes received.
      const request = new Request(delivery.url, {
        method: "POST",
        headers: delivery.headers,
        body: delivery.body,
      });
      // The plugin's own signal, aborted when the time runs out; and the timer's, cleared once the
      // race below is decided (its sleep then ends at once, and nobody reads it any more).
      const giveUp = new AbortController();
      const settled = new AbortController();
      const expired = deps.clock
        .sleep(HOOK_TIMEOUT_MS, settled.signal)
        .then((): typeof EXPIRED => EXPIRED);
      const receiving = loop.receive(request, giveUp.signal);
      // Once the time ran out nobody waits for it: its failure then is dropped, never unhandled.
      receiving.catch(() => undefined);
      try {
        const outcome = await Promise.race([receiving, expired]);
        if (outcome === EXPIRED) {
          giveUp.abort();
          deps.print(
            `${name}: a webhook delivery was given up after ${HOOK_TIMEOUT_MS / 1000} seconds: the plugin ${loop.plugin.packageName} had not taken it by then, so its work on it is abandoned`,
          );
          return { kind: "timed_out" };
        }
        return { kind: "answered", status: outcome.status, queued: outcome.intake.queued.length };
      } catch (error) {
        // The adapter words every failure of a plugin itself (its own words are never kept);
        // anything else is the store's, and the surface answers it as any failure, by request id.
        if (error instanceof PluginSourceFailed || error instanceof SourceAccessLost) {
          deps.print(`${name}: a webhook delivery was not taken in: ${error.message}`);
          return { kind: "failed" };
        }
        throw error;
      } finally {
        settled.abort();
      }
    },
  };
}

/**
 * Under `--no-http` (a worker-only replica): a line for each plugin source whose plugin takes
 * webhooks, since this worker serves no route for them; what changed reaches it by the plugin's
 * own poll, or through a worker that serves HTTP into the store's one queue.
 */
export function hooklessNotes(config: ProjectConfig, host: PluginHost): readonly string[] {
  return config.sources.flatMap((source) => {
    const call = source.source;
    const hosted = call === undefined ? undefined : host.plugin(call.plugin);
    if (call === undefined || hosted === undefined || takesWebhooks(host, call) !== true) {
      return [];
    }
    return [
      `${source.name}: this worker serves no HTTP (--no-http), so it takes no webhook for this source; its changes reach it by the plugin's own poll, or through a worker that serves POST ${HOOKS_PATH}/${hosted.name}/${source.name}`,
    ];
  });
}
