// A plugin source's webhook: the door the CLI builds over its plugin sources, and the route a
// sender calls with no FacetDB login, its plugin checking the signature.
export type { HookDelivery, HookOutcome, HooksDoor } from "./door.ts";
export { NO_HOOKS } from "./door.ts";
export {
  HOOK_BODY_MAX_BYTES,
  HOOK_RETRY_AFTER_SECONDS,
  HOOK_TIMEOUT_MS,
  HOOKS_PATH,
  hookBodyTooLarge,
  hooksRoutes,
  isHookUrl,
} from "./routes.ts";
