import { type Infer, z } from "facetdb/plugin";

/**
 * One call of Telegram's Bot API, `sendMessage`, over `fetch`.
 *
 * The Bot API puts the bot token in the request's path (`/bot<token>/sendMessage`), so the URL is
 * a secret as a whole: it is built here, handed to `fetch`, and never kept anywhere else. Every
 * failure is a `TelegramDeliveryError` written from fixed words, the method's name, the status and
 * Telegram's own `description` once cleaned; nothing `fetch` threw is passed on or hung on it as a
 * `cause` (a network error's message can quote the URL), and no redirect is followed, so the token
 * never travels to another host.
 */

/** The only address a request goes to. */
export const TELEGRAM_API = "https://api.telegram.org";

/** The one method this plugin calls; the only part of the URL any words name. */
export const METHOD = "sendMessage";

/** What the plugin needs from `fetch`; the default export passes the real one, tests a fake. */
export type TelegramFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    /** A redirect is an error: the token is in the path, and a redirect would carry it elsewhere. */
    readonly redirect: "error";
    /** Aborted when the worker stops or after `TIMEOUT_MS`, whichever comes first. */
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly status: number; text(): Promise<string> }>;

/**
 * A message Telegram did not take. The words name `sendMessage`, never the URL or the token. A rate
 * limit carries `status` 429 and the wait Telegram asked for as `retryAfterMs`, the shape the
 * plugin SDK reads from what a plugin throws (`retryable` in facetdb's plugin/provider.ts).
 */
export class TelegramDeliveryError extends Error {
  /** The HTTP status Telegram (or what stood in front of it) answered; undefined when none came. */
  readonly status: number | undefined;
  /** For a 429: how long Telegram asked to wait, in milliseconds, when it said. */
  readonly retryAfterMs: number | undefined;
  /** What to do, in plain words; also the end of `message`, for a reader who prints only that. */
  readonly fix: string;

  constructor(
    what: string,
    fix: string,
    status: number | undefined,
    retryAfterMs: number | undefined = undefined,
  ) {
    super(`${what}. ${fix}`);
    this.name = "TelegramDeliveryError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.fix = fix;
  }
}

/** The longest stretch of Telegram's `description` kept in the words. */
export const DESCRIPTION_MAX = 200;

/**
 * How long one delivery may take, the answer read to its end included, as the Slack channel: the
 * worker awaits its alerts, so a Telegram that never answers must not hold it for `fetch`'s own
 * limit (minutes).
 */
export const TIMEOUT_MS = 10_000;

/**
 * The longest wait a 429 passes on, in seconds: one hour, the outbox's longest wait between two
 * attempts (`RETRY_MAX_MS`), so a rate limit never asks FacetDB to wait longer than a failure does.
 */
export const RETRY_AFTER_MAX_S = 3600;

/**
 * The shortest piece of the token's secret half whose echo makes a description unusable: Telegram
 * or a page in front of it could repeat the path, or a cut part of it.
 */
const ECHO_WINDOW = 8;

/** Format characters (bidirectional overrides, zero-width spaces and joiners): dropped. */
const FORMAT = /\p{Cf}+/gu;

/** Control characters (line breaks, tabs, escapes): each run read as one space. */
const CONTROL = /\p{Cc}+/gu;

/**
 * The Bot API's answer (https://core.telegram.org/bots/api#making-requests): `ok`, and for a refusal
 * an `error_code`, a `description` and maybe `parameters`. Only `ok` is needed to read it; a part
 * of another shape is dropped, not trusted.
 */
const answerSchema = z.object({
  ok: z.boolean(),
  description: z.string().optional().catch(undefined),
  parameters: z
    .object({
      // Judged by `retryAfterSeconds`: a negative or endless value is read as absent there.
      retry_after: z.number().optional().catch(undefined),
      migrate_to_chat_id: z.number().int().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

type Answer = Infer<typeof answerSchema>;

/** The forms of the token a description, an error or a log could carry. */
function tokenForms(token: string): readonly string[] {
  const secretHalf = token.slice(token.indexOf(":") + 1);
  return [token, encodeURIComponent(token), pathSegment(token), secretHalf].filter(
    (form) => form.length > 0,
  );
}

/**
 * The token as one segment of the request's path: every character a path gives a meaning to is
 * escaped (`/`, `?`, `#`, `%`, `@`, spaces), so the host and the method stay what they are. The
 * colon a real token holds is legal in a segment and is kept as written: Telegram reads the token
 * from the path as it was typed. The settings' schema allows nothing that would need escaping.
 */
export function pathSegment(token: string): string {
  return encodeURIComponent(token).replaceAll("%3A", ":");
}

/** True when `text` repeats the token, a piece of its secret half, or a Bot API path. */
function echoesToken(text: string, token: string): boolean {
  const lower = text.toLowerCase();
  if (
    lower.includes("/bot") ||
    tokenForms(token).some((form) => lower.includes(form.toLowerCase()))
  ) {
    return true;
  }
  const secretHalf = token.slice(token.indexOf(":") + 1).toLowerCase();
  for (let at = 0; at + ECHO_WINDOW <= secretHalf.length; at += 1) {
    if (lower.includes(secretHalf.slice(at, at + ECHO_WINDOW))) {
      return true;
    }
  }
  return false;
}

/**
 * Telegram's description as the words may quote it: invisible characters gone, spaces collapsed,
 * held to `DESCRIPTION_MAX`; undefined when there is none, or when it repeats the token or a path
 * (the whole description is dropped, never redacted in place, so no form of it survives).
 */
export function cleanDescription(
  description: string | undefined,
  token: string,
): string | undefined {
  if (description === undefined) {
    return undefined;
  }
  const clean = description.replace(FORMAT, "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  // Read again with every space gone too: a token never holds one, so a token spread out with
  // spaces or line breaks between its pieces is still found.
  if (clean === "" || echoesToken(clean, token) || echoesToken(clean.replace(/\s/g, ""), token)) {
    return undefined;
  }
  return clean.length <= DESCRIPTION_MAX
    ? clean
    : `${Array.from(clean.slice(0, DESCRIPTION_MAX)).slice(0, -1).join("")}…`;
}

/** The fix for a refusal, by the words Telegram uses for it; the general advice when none matches. */
function fixFor(description: string | undefined, status: number, answer: Answer): string {
  const words = (description ?? "").toLowerCase();
  const migrated = answer.parameters?.migrate_to_chat_id;
  if (migrated !== undefined) {
    return `the group became a supergroup with a new chat id: write the address as telegram:${migrated}`;
  }
  if (words.includes("chat not found")) {
    return "no chat with this id is open to the bot: check the chat id in the address (a number, negative for a group or a channel, or a public @channel name), and add the bot to that group or channel";
  }
  // A token Telegram does not know is answered 401, and one it cannot even read as a token 404.
  if (status === 401 || status === 404 || words.includes("unauthorized")) {
    return "Telegram does not know this bot token: copy the token @BotFather gave the bot into the variable plugins.telegram.token names, or create a new one with /token";
  }
  if (words.includes("can't initiate") || words.includes("blocked by the user")) {
    return "a bot cannot write to a person first: that person must open the bot in Telegram and send it /start (and unblock it, if they blocked it)";
  }
  if (
    words.includes("not a member") ||
    words.includes("kicked") ||
    words.includes("not enough rights") ||
    words.includes("have no rights")
  ) {
    return "the bot is not in the chat or may not post there: add the bot to the group, or to the channel as an administrator allowed to post messages";
  }
  return "check that the bot is in the chat (an administrator of a channel), that a person has sent it /start for a private chat, and that the chat id in the address is right";
}

/** A short, safe code from what `fetch` threw (`ENOTFOUND`), or undefined: never its message. */
function networkCode(error: unknown, token: string): string | undefined {
  for (const candidate of [error, (error as { cause?: unknown } | null)?.cause]) {
    const code = (candidate as { code?: unknown } | null)?.code;
    // A token's secret half can look like a code (`AAHDQTCV…` in capitals): one that echoes it is
    // dropped as a description is.
    if (
      typeof code === "string" &&
      /^[A-Z][A-Z0-9_]{1,39}$/.test(code) &&
      !echoesToken(code, token)
    ) {
      return code;
    }
  }
  return undefined;
}

/**
 * How long Telegram asked to wait, in seconds, as the error carries it: a negative, non-finite or
 * absent `retry_after` is absent, and a longer one is held to `RETRY_AFTER_MAX_S`.
 */
function retryAfterSeconds(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw) || raw < 0) {
    return undefined;
  }
  return Math.min(raw, RETRY_AFTER_MAX_S);
}

/** Thrown by `untilStopped` when its signal fires first; never leaves this module. */
class Stopped extends Error {}

/**
 * `work`, or a `Stopped` rejection as soon as `signal` fires, whichever comes first: a `fetch` that
 * ignores its signal cannot hold the delivery past it. The listener is removed once either settles.
 */
async function untilStopped<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    // `work` may still settle; its outcome is not wanted.
    work.catch(() => undefined);
    throw new Stopped();
  }
  let onAbort: (() => void) | undefined;
  const stopped = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Stopped());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([work, stopped]);
  } finally {
    signal.removeEventListener("abort", onAbort as () => void);
    work.catch(() => undefined);
  }
}

/** A request the worker stopped, or that outlived `TIMEOUT_MS`, in fixed words. */
function stoppedError(worker: AbortSignal, status: number | undefined): TelegramDeliveryError {
  if (worker.aborted) {
    return new TelegramDeliveryError(
      `${METHOD} was stopped before Telegram answered`,
      "the worker is stopping; the message was not confirmed as sent",
      status,
    );
  }
  return new TelegramDeliveryError(
    status === undefined
      ? `${METHOD} got no answer from Telegram within ${TIMEOUT_MS / 1000} seconds`
      : `Telegram's answer to ${METHOD} (status ${status}) did not finish within ${TIMEOUT_MS / 1000} seconds`,
    "Telegram or the way to it is not answering: the message may or may not have been sent; check that the worker can reach api.telegram.org over HTTPS",
    status,
  );
}

/**
 * The request and its answer read to the end, under `stop` (the worker's signal or the deadline):
 * the status and the body as text, or a `TelegramDeliveryError` in fixed words.
 */
async function exchange(
  fetch: TelegramFetch,
  token: string,
  body: { readonly chatId: string; readonly text: string },
  worker: AbortSignal,
  stop: AbortSignal,
): Promise<{ readonly status: number; readonly raw: string }> {
  let response: Awaited<ReturnType<TelegramFetch>>;
  try {
    // Whatever the token holds, it is one segment: the host and the method stay these.
    const sent = fetch(`${TELEGRAM_API}/bot${pathSegment(token)}/${METHOD}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Plain text, no `parse_mode`: a record's words cannot become Markdown or HTML.
      body: JSON.stringify({
        chat_id: body.chatId,
        text: body.text,
        link_preview_options: { is_disabled: true },
      }),
      redirect: "error",
      signal: stop,
    });
    response = await untilStopped(sent, stop);
  } catch (error) {
    // What `fetch` threw is dropped whole: its message or its cause may quote the URL.
    if (stop.aborted) {
      throw stoppedError(worker, undefined);
    }
    const code = networkCode(error, token);
    throw new TelegramDeliveryError(
      `Telegram could not be reached for ${METHOD}${code === undefined ? "" : ` (${code})`}: no answer came back (the name did not resolve, the connection failed or was refused, or a redirect was refused)`,
      "check that the worker can reach api.telegram.org over HTTPS, through any proxy it uses",
      undefined,
    );
  }

  const { status } = response;
  try {
    return { status, raw: await untilStopped(response.text(), stop) };
  } catch {
    if (stop.aborted) {
      throw stoppedError(worker, status);
    }
    throw new TelegramDeliveryError(
      `Telegram's answer to ${METHOD} (status ${status}) could not be read to its end`,
      "the connection broke while Telegram answered; the message may or may not have been sent",
      status,
    );
  }
}

/**
 * Sends one message; resolves when Telegram took it, rejects with a `TelegramDeliveryError`. The
 * delivery ends after `TIMEOUT_MS` or when the worker's `signal` fires, whichever comes first, and
 * its timer is cleared as soon as the answer is in.
 */
export async function sendMessage(
  fetch: TelegramFetch,
  token: string,
  body: { readonly chatId: string; readonly text: string },
  signal: AbortSignal,
): Promise<void> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), TIMEOUT_MS);
  let answered: { readonly status: number; readonly raw: string };
  try {
    answered = await exchange(
      fetch,
      token,
      body,
      signal,
      AbortSignal.any([signal, deadline.signal]),
    );
  } finally {
    clearTimeout(timer);
  }
  readAnswer(answered.status, answered.raw, token);
}

/** Telegram's answer judged: returns when it took the message, throws what it said otherwise. */
function readAnswer(status: number, raw: string, token: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new TelegramDeliveryError(
      `${METHOD} was answered with status ${status} and a body that is not the Bot API's JSON (a proxy's or a gateway's page)`,
      "check that the worker reaches api.telegram.org directly or through a proxy that passes its answers on",
      status,
    );
  }
  const shaped = answerSchema.safeParse(parsed);
  if (!shaped.success) {
    throw new TelegramDeliveryError(
      `${METHOD} was answered with status ${status} and JSON that is not the Bot API's answer`,
      "check that the worker reaches api.telegram.org directly or through a proxy that passes its answers on",
      status,
    );
  }
  const answer = shaped.data;
  if (answer.ok && status >= 200 && status < 300) {
    return;
  }

  const description = cleanDescription(answer.description, token);
  const said = description === undefined ? "" : `: "${description}"`;
  if (status === 429) {
    const seconds = retryAfterSeconds(answer.parameters?.retry_after);
    throw new TelegramDeliveryError(
      `Telegram is rate limiting the bot (${METHOD} answered 429${seconds === undefined ? "" : `, retry after ${seconds} s`})`,
      seconds === undefined
        ? "FacetDB sends it again later"
        : `FacetDB sends it again after ${seconds} seconds`,
      429,
      seconds === undefined ? undefined : Math.ceil(seconds * 1000),
    );
  }
  if (status >= 500) {
    // Telegram's own trouble: nothing in the settings or the chat would change the answer.
    throw new TelegramDeliveryError(
      `Telegram failed on its side answering ${METHOD} (status ${status})${said}`,
      "the trouble is Telegram's, not the settings' or the chat's: the delivery is tried again later",
      status,
    );
  }
  throw new TelegramDeliveryError(
    `Telegram refused ${METHOD} (status ${status})${said}`,
    fixFor(description, status, answer),
    status,
  );
}
