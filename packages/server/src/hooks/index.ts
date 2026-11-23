// A plugin source's webhook: the door the CLI builds over its plugin sources, and the route a
// sender calls with no FacetDB login, its plugin checking the signature; and the limits the HTTP
// adapter applies before it reads a body.
export type { HookDelivery, HookOutcome, HooksDoor } from "./door.ts";
export { NO_HOOKS } from "./door.ts";
export type { HookAdmission, HookLimiter, HookRequest } from "./limits.ts";
export {
  createHookLimiter,
  HOOK_ADDRESS_BURST,
  HOOK_ADDRESS_PER_SECOND,
  HOOK_BODIES_AT_ONCE,
  HOOK_BODY_DEADLINE_MS,
  HOOK_BUSY_RETRY_AFTER_SECONDS,
  HOOK_READING_PER_ADDRESS,
  HOOK_SOURCE_BURST,
  HOOK_SOURCE_PER_SECOND,
  HOOK_TRACKED_ADDRESSES,
  HOOK_TRACKED_SOURCES,
  hookBodyTooSlow,
} from "./limits.ts";
export {
  HOOK_BODY_MAX_BYTES,
  HOOK_RETRY_AFTER_SECONDS,
  HOOK_TIMEOUT_MS,
  HOOKS_PATH,
  hookBodyTooLarge,
  hooksRoutes,
  isHookUrl,
} from "./routes.ts";
