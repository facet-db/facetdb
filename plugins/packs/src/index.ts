/**
 * @facetdb/packs: FacetDB's question packs ("ready-made question sets with
 * tested wording and thresholds for one job"). Two packs: `marketplace`, marketplace trust and
 * safety (scams, banned items, payment outside the platform, counterfeits), and `support`, support
 * inbox triage (the topic of a customer's message, its urgency, a refund request, an intent to
 * cancel).
 *
 * A pack is copied into a project as ordinary questions: the studio's "Start from a pack" reads it
 * through `GET /v1/packs` once the config names the plugin.
 *
 * ```ts
 * // facetdb.config.ts
 * plugins: { packs: {} },
 * ```
 */
import { definePlugin, z } from "facetdb/plugin";
import { marketplace } from "./marketplace.ts";
import { support } from "./support.ts";

export { marketplace } from "./marketplace.ts";
export { support } from "./support.ts";

/** The plugin the worker loads: packs only, and no settings of its own. */
export default definePlugin({
  name: "packs",
  version: "0.0.0",
  facetdb: ">=0.0.0 <1.0.0",
  config: z.strictObject({}),
  packs: { marketplace, support },
});
