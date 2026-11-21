/**
 * Slack's own reason codes, from `chat.postMessage`'s `error` (an answer of 200 with `ok: false`)
 * and from the plain-text body of an incoming webhook's refusal, each with its fix in plain words.
 * `{where}` is replaced by the channel. A code not listed here is named as Slack wrote it.
 */
const FIXES: Readonly<Record<string, string>> = {
  // The channel.
  channel_not_found:
    "Slack finds no channel {where} the app can see: check the name in the address, and add the app to the channel if it is private",
  not_in_channel:
    "the app is not a member of {where}: invite it to the channel (/invite @your-app), or give it the chat:write.public scope",
  is_archived: "{where} is archived: unarchive it, or point the address at another channel",
  channel_is_archived: "{where} is archived: unarchive it, or point the address at another channel",
  restricted_action:
    "a workspace setting stops the app posting in {where}: ask a Slack admin to allow it",
  restricted_action_read_only_channel:
    "{where} is read-only for the app: ask a Slack admin to let it post, or point the address at another channel",
  posting_to_general_channel_denied:
    "only admins may post in {where}: point the address at another channel, or ask a Slack admin",
  action_prohibited:
    "a Slack admin has restricted this webhook: ask them to allow it, or create a new incoming webhook for {where}",
  user_not_found:
    "the webhook's channel or user no longer exists: create a new incoming webhook for {where}",
  // The credential.
  not_authed:
    "Slack received no token: set the variable that holds the bot token where the worker runs",
  invalid_auth:
    "Slack does not accept the bot token: set the variable to the app's Bot User OAuth Token (xoxb-…) for this workspace",
  account_inactive:
    "the token belongs to an app or user that was deactivated or uninstalled: reinstall the app and set its new token",
  token_revoked: "the token was revoked: reinstall the app to the workspace and set its new token",
  token_expired:
    "the token has expired (token rotation is on for the app): set a fresh token, or turn rotation off",
  missing_scope:
    "the token lacks the chat:write scope: add it under OAuth & Permissions, reinstall the app and set its new token",
  no_permission:
    "the token may not post here: give the app the chat:write scope and reinstall it, or ask a Slack admin",
  invalid_token:
    "Slack does not accept the incoming webhook for {where}: create a new one and set its URL in the variable",
  no_service:
    "the incoming webhook for {where} was removed or disabled: create a new one and set its URL in the variable",
  no_service_id:
    "the incoming webhook for {where} is not a working URL: copy it again from Slack and set it in the variable",
  no_team:
    "the workspace of the webhook for {where} no longer exists: create a webhook in the workspace you use",
  team_disabled:
    "the Slack workspace was disabled: create a webhook or a token in a workspace that is active",
  no_active_hooks:
    "the app's incoming webhooks are turned off: turn them on in the app's settings and create one for {where}",
  // The message, or Slack itself.
  msg_too_long: "the message is longer than Slack takes: report this to FacetDB",
  no_text: "Slack received a message with no text: report this to FacetDB",
  invalid_payload: "Slack could not read the message FacetDB sent: report this to FacetDB",
  invalid_arguments: "Slack could not read the message FacetDB sent: report this to FacetDB",
  invalid_json: "Slack could not read the message FacetDB sent: report this to FacetDB",
  ratelimited: "Slack is limiting how fast this workspace posts: wait before sending again",
  rate_limited: "Slack is limiting how fast this workspace posts: wait before sending again",
  fatal_error: "Slack failed on its side: a later delivery may go through",
  internal_error: "Slack failed on its side: a later delivery may go through",
  service_unavailable: "Slack is unavailable for now: a later delivery may go through",
  request_timeout: "Slack took too long to answer: a later delivery may go through",
};

/** Codes that mean "too fast": thrown with status 429, as an HTTP 429 is. */
export const RATE_LIMIT_CODES: ReadonlySet<string> = new Set(["ratelimited", "rate_limited"]);

/**
 * A reason code as Slack writes them: lowercase words joined by `_`. Anything else in a body is
 * not a code and is never repeated: a body is Slack's (or a proxy's) text and could quote anything.
 */
const CODE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;

export function isReasonCode(text: string): boolean {
  return text.length <= 64 && CODE.test(text);
}

/** A code listed above: the only text taken from a webhook's plain-text body. */
export function isKnownReason(text: string): boolean {
  return Object.hasOwn(FIXES, text);
}

/** The fix for a code, or words that name an unknown one as Slack wrote it. */
export function fixFor(code: string, where: string): string {
  const fix = Object.hasOwn(FIXES, code) ? FIXES[code] : undefined;
  return fix === undefined
    ? `a reason FacetDB does not know yet: look up "${code}" in Slack's API documentation for chat.postMessage or incoming webhooks`
    : fix.replaceAll("{where}", where);
}
