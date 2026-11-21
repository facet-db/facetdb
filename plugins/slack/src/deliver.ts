import { type Infer, type PluginContext, z } from "facetdb/plugin";
import { type ChannelMessage, messageText } from "./message.ts";
import { fixFor, isKnownReason, isReasonCode, RATE_LIMIT_CODES } from "./reasons.ts";
import {
  type ChannelSettings,
  noRouteWords,
  type Route,
  routeFor,
  type SlackConfig,
} from "./settings.ts";

/** The only Web API method the plugin calls; the other host it reaches is a configured webhook's. */
export const POST_MESSAGE_URL = "https://slack.com/api/chat.postMessage";

/** A delivery that hangs past this is stopped, so one slow Slack never holds the worker's pass. */
const TIMEOUT_MS = 10_000;

/** The `fetch` the plugin is given: the global one in the process, a handwritten fake in tests. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

/** What went wrong with one delivery, in words that never quote a secret or Slack's body. */
type Failure = {
  /** What happened: `Slack answered channel_not_found`, `Slack answered HTTP 502`. */
  readonly reason: string;
  readonly fix: string;
  /** Slack's own reason code, when it gave one FacetDB can read. */
  readonly slackCode?: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
};

/**
 * A message Slack did not take. A 429 (or Slack's `ratelimited`) carries `status` 429 and the wait
 * `retry-after` asked for as `retryAfterMs`, the shape the plugin SDK reads from what a plugin
 * throws (plugin/provider.ts). It carries no `cause`: what `fetch` threw, the request and Slack's
 * body can hold the token or the webhook URL, and none of them is kept.
 */
export class SlackDeliveryError extends Error {
  /** Slack's own reason code (`channel_not_found`), when it gave one. */
  readonly slackCode: string | undefined;
  readonly fix: string;
  /** The HTTP status Slack answered, or 429 for its `ratelimited`. */
  readonly status: number | undefined;
  /** The wait Slack asked for before the next post, in milliseconds. */
  readonly retryAfterMs: number | undefined;

  constructor(where: string, failure: Failure) {
    super(`slack:${where} was not delivered: ${failure.reason}; ${failure.fix}`);
    this.name = "SlackDeliveryError";
    this.slackCode = failure.slackCode;
    this.fix = failure.fix;
    this.status = failure.status;
    this.retryAfterMs = failure.retryAfterMs;
  }
}

/** `retry-after` in whole seconds, as Slack sends it; anything else is read as absent. */
function retryAfterMs(header: string | null): number | undefined {
  return header !== null && /^\d{1,9}$/.test(header.trim())
    ? Number(header.trim()) * 1000
    : undefined;
}

/** The Web API's answer: only the two fields read here, judged before either is used. */
const apiAnswer = z.object({ ok: z.boolean(), error: z.string().optional() });

/** The Web API's answer, judged by its shape, or undefined for a body that is not one. */
function apiAnswerIn(body: string | undefined): Infer<typeof apiAnswer> | undefined {
  try {
    const parsed = apiAnswer.safeParse(JSON.parse(body ?? ""));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The reason code in a refusal's body, or undefined; any other text is never repeated. The Web
 * API's JSON `error` is taken when it has a code's shape (an unknown one is named as Slack wrote
 * it). A webhook answers in plain text, which could be anything (`true`, `null`, a proxy's word),
 * so only a code FacetDB knows is taken from it.
 */
function codeIn(body: string | undefined, route: Route): string | undefined {
  if (route.kind === "webhook") {
    const text = (body ?? "").trim();
    return isKnownReason(text) ? text : undefined;
  }
  const error = apiAnswerIn(body)?.error;
  return error !== undefined && isReasonCode(error) ? error : undefined;
}

/**
 * Lets go of a body the delivery does not read, so its connection is freed now rather than at
 * garbage collection. A failure to cancel changes nothing about the delivery and is not kept.
 */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body could not be cancelled: the connection is freed when the response is collected.
  }
}

/** Slack's reason code as a failure; its `ratelimited` is a 429 like the HTTP one. */
function refused(code: string, where: string, status?: number): Failure {
  const kept = RATE_LIMIT_CODES.has(code) ? 429 : status;
  return {
    reason: `Slack answered ${code}`,
    fix: fixFor(code, where),
    slackCode: code,
    ...(kept === undefined ? {} : { status: kept }),
  };
}

async function bodyOf(response: Response): Promise<string | undefined> {
  try {
    return await response.text();
  } catch {
    return undefined;
  }
}

/** Why Slack did not take the message, or undefined when it did. */
async function judged(
  response: Response,
  route: Route,
  where: string,
): Promise<Failure | undefined> {
  const { status } = response;
  if (status === 429) {
    const wait = retryAfterMs(response.headers.get("retry-after"));
    await discard(response);
    return {
      reason: "Slack answered HTTP 429",
      fix: fixFor("ratelimited", where),
      status,
      ...(wait === undefined ? {} : { retryAfterMs: wait }),
    };
  }
  const ok = status >= 200 && status < 300;
  if (ok && route.kind === "webhook") {
    // Deliberate: a webhook's 2xx is a delivery, and its body (Slack writes "ok") is not read. A
    // webhook that answered 200 with an error text would pass silently; Slack answers its
    // refusals with a 4xx and a reason, which the lines below read.
    await discard(response);
    return undefined;
  }
  const body = await bodyOf(response);
  if (!ok) {
    const code = codeIn(body, route);
    return code === undefined
      ? {
          reason: `Slack answered HTTP ${status}`,
          fix:
            status >= 500
              ? "Slack failed on its side: a later delivery may go through"
              : "Slack refused the request without a reason FacetDB can read: check the plugin's token or the channel's webhook",
          status,
        }
      : refused(code, where, status);
  }
  const answer = apiAnswerIn(body);
  if (answer === undefined) {
    return {
      reason: "Slack's answer was not one FacetDB can read",
      fix: "the message may not have been posted: check the channel, and a later delivery may go through",
      status,
    };
  }
  if (answer.ok) {
    return undefined;
  }
  const code = answer.error !== undefined && isReasonCode(answer.error) ? answer.error : undefined;
  return code === undefined
    ? {
        reason: "Slack refused the message without a reason FacetDB can read",
        fix: "check the plugin's bot token and that the app is in the channel",
      }
    : refused(code, where);
}

/** The request for one route: the Web API names the channel, a webhook already is one. */
function requestFor(route: Route, where: string, text: string) {
  // Plain text: no names turned into mentions, no previews fetched of the studio's links.
  const plain = {
    text,
    parse: "none",
    link_names: false,
    unfurl_links: false,
    unfurl_media: false,
  };
  return route.kind === "api"
    ? {
        url: POST_MESSAGE_URL,
        headers: {
          authorization: `Bearer ${route.token}`,
          "content-type": "application/json; charset=utf-8",
        },
        body: JSON.stringify({ channel: where, ...plain }),
      }
    : {
        url: route.url,
        headers: { "content-type": "application/json; charset=utf-8" },
        body: JSON.stringify(plain),
      };
}

/** What `fetch` threw, in fixed words: its message and cause can quote the URL or the token. */
function unreached(error: unknown): Failure {
  const name = error instanceof Error ? error.name : "";
  return name === "AbortError" || name === "TimeoutError"
    ? {
        reason: `the request to Slack was stopped (it took longer than ${TIMEOUT_MS / 1000} seconds, or the worker is stopping)`,
        fix: "a later delivery may go through; if it keeps happening, check the worker's network",
      }
    : {
        reason:
          "FacetDB could not reach Slack (the network failed, or Slack answered with a redirect, which is never followed)",
        fix: "check that the worker's machine reaches slack.com and hooks.slack.com; a later delivery may go through",
      };
}

/** Why `slack:<where>` can never deliver with these settings, or undefined when it can. */
export function checkChannel(config: SlackConfig, settings: ChannelSettings): string | undefined {
  return routeFor(config, settings.where) === undefined ? noRouteWords(settings.where) : undefined;
}

/**
 * Posts one message to one channel: with the token through `chat.postMessage`, else to the
 * channel's incoming webhook. Each call posts once (the alert's 30-minute rule and the outbox
 * decide what is sent again); any failure throws a `SlackDeliveryError`.
 */
export async function deliverMessage(
  fetch: Fetch,
  ctx: PluginContext<SlackConfig>,
  message: ChannelMessage,
  settings: ChannelSettings,
): Promise<void> {
  const { where } = settings;
  const route = routeFor(ctx.config, where);
  if (route === undefined) {
    throw new SlackDeliveryError(where, {
      reason: "the plugin has neither a bot token nor a webhook for this channel",
      fix: noRouteWords(where),
    });
  }
  const request = requestFor(route, where, messageText(message));
  let response: Response;
  try {
    response = await fetch(request.url, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      // A redirect would carry the token or the message on to a host that is not Slack's.
      redirect: "error",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(TIMEOUT_MS)]),
    });
  } catch (error) {
    throw new SlackDeliveryError(where, unreached(error));
  }
  const failure = await judged(response, route, where);
  if (failure !== undefined) {
    throw new SlackDeliveryError(where, failure);
  }
}
