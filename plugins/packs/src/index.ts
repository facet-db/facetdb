/**
 * @facetdb/packs: FacetDB's question packs ("ready-made question sets with
 * tested wording and thresholds for one job"). Today one pack, `marketplace`: marketplace trust and
 * safety (scams, banned items, payment outside the platform, counterfeits).
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

export { marketplace } from "./marketplace.ts";

/** The plugin the worker loads: packs only, and no settings of its own. */
export default definePlugin({
  name: "packs",
  version: "0.0.0",
  facetdb: ">=0.0.0 <1.0.0",
  config: z.strictObject({}),
  packs: { marketplace },
});
