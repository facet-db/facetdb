// The one reader of the plugin registry's index, for `facetdb add` and the studio's gallery.
export type { CheckedRegistry, RegistryDeps, RegistryRead } from "./read.ts";
export {
  checkRegistryAddress,
  DEFAULT_REGISTRY,
  MAX_INDEX_CHARS,
  mayCarryRegistry,
  plain,
  REGISTRY_TIMEOUT_MS,
  readRegistry,
  registryAddress,
} from "./read.ts";
