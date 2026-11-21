// The Plugins page's door and routes: the hosted plugins, the registry's gallery and the question
// packs, as only the CLI can build them.
export type {
  Gallery,
  GalleryEntry,
  InstalledPlugin,
  JsonObject,
  PackView,
  PluginsDoor,
  PluginVariableView,
} from "./door.ts";
export { NO_PLUGINS } from "./door.ts";
export { pluginsRoutes } from "./routes.ts";
