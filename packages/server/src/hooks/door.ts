/**
 * The CLI's door for a plugin source's webhook: the worker runs the plugin sources, so only the
 * `facetdb` package can hand a delivery to the one a URL names. The route (routes.ts) reads the
 * delivery and maps the outcome; the door finds the source, runs its plugin's `receive` and takes
 * the keys it names into the store's queue.
 */

/**
 * A delivery as the route took it, before anything of it was parsed: the exact bytes of its body,
 * which a plugin checks a signature over, and its headers (FacetDB's own session cookie left out:
 * no plugin is handed a reviewer's credential).
 */
export type HookDelivery = {
  /** The request's URL as this surface received it: some senders sign it with the body. */
  readonly url: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
};

/**
 * What became of a delivery:
 *  - `answered`: the source's plugin read it and answered `status` (its receipt's, never its words);
 *    `queued` records went back to pending, a record whose state did not change is not counted;
 *  - `unknown`: no source of the config is a plugin source by that plugin and name;
 *  - `not_running`: the source is in the config but its loop does not run now (it stopped and is
 *    tried again, or it waits for a restart); the sender may try again after `retryAfterSeconds`;
 *  - `failed`: the plugin failed reading the event or the records it named; the worker said which,
 *    in its own words, and nothing of the plugin's or the request's reaches the answer;
 *  - `timed_out`: the plugin had not taken it within `HOOK_TIMEOUT_MS` (routes.ts); its work was
 *    abandoned through its signal, and the worker said where it was.
 */
export type HookOutcome =
  | { readonly kind: "answered"; readonly status: number; readonly queued: number }
  | { readonly kind: "unknown" }
  | { readonly kind: "not_running"; readonly retryAfterSeconds: number }
  | { readonly kind: "failed" }
  | { readonly kind: "timed_out" };

export type HooksDoor = {
  /** `plugin` is the plugin's short name (`github`), `source` the source's name in the config. */
  receive(plugin: string, source: string, delivery: HookDelivery): Promise<HookOutcome>;
};

/** A surface that runs no plugin source (every test that leaves it out): every hook is unknown. */
export const NO_HOOKS: HooksDoor = {
  receive: () => Promise.resolve({ kind: "unknown" }),
};
