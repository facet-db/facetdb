import { createHash } from "node:crypto";
import type { Clock } from "@facetdb/core";
import { isLoopbackAddress, PROXY_HEADERS } from "../auth/loopback.ts";
import { ApiError } from "../errors.ts";
import { HOOKS_PATH } from "./routes.ts";

/**
 * The limits of a plugin source's webhook: the route takes requests from anyone, so the HTTP
 * adapter (cli/serve.ts), which holds the socket, asks here before it reads a byte of a body, and
 * refuses what is past a limit whole and at once. Three limits, all or nothing (a refused request
 * takes no token and no slot, so a sender whose requests are all refused adds nothing to what is
 * remembered):
 *  - per sender's address, a token bucket, an IPv6 address keyed by its /64 (one host holds a whole
 *    /64); skipped behind a proxy on this machine, whose socket is every visitor's;
 *  - per source (the path's plugin and source names), a token bucket, whatever the address;
 *  - the bodies being read at once, and of them those of one address, each freed on its end, its
 *    refusal, its deadline or its socket closing; and the body's deadline, so a sender that stops
 *    mid-body holds its slot for a bounded time, and one address cannot hold every slot.
 * The buckets read the injected clock; the remembered keys are bounded, the least recently admitted
 * forgotten first, as the sign-in failures are (auth/sessions.ts).
 */

/** A sender's address: 10 deliveries a second once its burst is spent. */
export const HOOK_ADDRESS_PER_SECOND = 10;
/** A sender's address: 100 deliveries back to back (a service replaying what it missed). */
export const HOOK_ADDRESS_BURST = 100;
/** A source: 20 deliveries a second once its burst is spent, from every address together. */
export const HOOK_SOURCE_PER_SECOND = 20;
/** A source: 200 deliveries back to back. */
export const HOOK_SOURCE_BURST = 200;
/** Hook bodies read at once; one more is refused until one of them ends. */
export const HOOK_BODIES_AT_ONCE = 8;
/**
 * Of those, the bodies one address's requests may hold at once (an IPv6 address by its /64), so a
 * sender that sends headers and stops cannot hold every slot and refuse every other sender's
 * deliveries. Behind a proxy on this machine the sender's address is not known, so there only
 * `HOOK_BODIES_AT_ONCE` applies.
 */
export const HOOK_READING_PER_ADDRESS = 2;
/** From a hook request's headers to its body's last byte: 10 seconds, then 408. */
export const HOOK_BODY_DEADLINE_MS = 10_000;
/** Addresses remembered; the least recently admitted is forgotten past this. */
export const HOOK_TRACKED_ADDRESSES = 10_000;
/** Sources remembered (any names a sender puts in a path); the least recently admitted is forgotten past this. */
export const HOOK_TRACKED_SOURCES = 1_000;
/**
 * `retry-after` when every body slot is taken: no token says when one is free, and a body is
 * usually whole in well under a second.
 */
export const HOOK_BUSY_RETRY_AFTER_SECONDS = 1;

/** What the adapter knows of a hook request on its headers alone. */
export type HookRequest = {
  /** The request's URL as the router routes it (`isHookUrl` is true of it). */
  readonly url: string;
  /** The socket's other end, as `node:http` reports it. */
  readonly remoteAddress: string | undefined;
  /** The request's headers by lowercase name, as `node:http` holds them. */
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
};

export type HookAdmission =
  /** `release` frees the body's slot; once is enough, and a second call does nothing. */
  | { readonly kind: "admitted"; readonly release: () => void }
  | { readonly kind: "refused"; readonly error: ApiError };

export type HookLimiter = {
  admit(request: HookRequest): HookAdmission;
  /**
   * How many addresses and sources are remembered, bodies read now, and addresses whose bodies are
   * read now (a key is held only while it has a body read, so never more than the bodies).
   */
  tracked(): {
    readonly addresses: number;
    readonly sources: number;
    readonly reading: number;
    readonly readingAddresses: number;
  };
};

type Rate = { readonly perSecond: number; readonly burst: number };
type Bucket = { readonly tokens: number; readonly atMs: number };

const PER_ADDRESS: Rate = { perSecond: HOOK_ADDRESS_PER_SECOND, burst: HOOK_ADDRESS_BURST };
const PER_SOURCE: Rate = { perSecond: HOOK_SOURCE_PER_SECOND, burst: HOOK_SOURCE_BURST };

/** A bucket's tokens at `nowMs`: a key not remembered (never seen, or forgotten) has its whole burst. */
function tokensOf(bucket: Bucket | undefined, rate: Rate, nowMs: number): number {
  if (bucket === undefined) {
    return rate.burst;
  }
  const elapsedMs = Math.max(0, nowMs - bucket.atMs);
  return Math.min(rate.burst, bucket.tokens + (elapsedMs * rate.perSecond) / 1000);
}

/** Whole seconds until a bucket holding `tokens` (fewer than one) has one again. */
function secondsUntilToken(tokens: number, rate: Rate): number {
  return Math.max(1, Math.ceil((1 - tokens) / rate.perSecond));
}

/** Sets a key as the most recent, and forgets the least recent past `max`. */
function remember(map: Map<string, Bucket>, key: string, bucket: Bucket, max: number): void {
  map.delete(key);
  map.set(key, bucket);
  for (const oldest of map.keys()) {
    if (map.size <= max) {
      break;
    }
    map.delete(oldest);
  }
}

const IPV4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/**
 * The key a sender's address is limited by: an IPv4 address whole (also as the IPv4-mapped form a
 * dual-stack socket reports), an IPv6 address by its first 64 bits, so the addresses of one host's
 * /64 share one bucket. The kernel's address is well formed; a zone (`%eth0`) is not part of it.
 */
export function addressKeyOf(address: string | undefined): string {
  if (address === undefined) {
    return "unknown";
  }
  const mapped = IPV4_MAPPED.exec(address);
  if (mapped !== null) {
    return mapped[1] ?? address;
  }
  if (!address.includes(":")) {
    return address;
  }
  const bare = address.split("%")[0] ?? address;
  const [head = "", tail] = bare.split("::");
  const groupsOf = (part: string): string[] => (part === "" ? [] : part.split(":"));
  const front = groupsOf(head);
  const back = tail === undefined ? [] : groupsOf(tail);
  // An embedded IPv4 address (`64:ff9b::192.0.2.1`) holds the last two groups.
  const width = (groups: string[]): number =>
    groups.reduce((sum, group) => sum + (group.includes(".") ? 2 : 1), 0);
  const zeros = tail === undefined ? 0 : Math.max(0, 8 - width(front) - width(back));
  const groups = [...front, ...Array.from({ length: zeros }, () => "0"), ...back];
  const prefix = groups.slice(0, 4).map((group) => Number.parseInt(group, 16).toString(16));
  return `${prefix.join(":")}::/64`;
}

/**
 * The key a source is limited by: the two names after `/v1/hooks/` as the router reads them, every
 * escape decoded and in lowercase, as `isHookUrl` judges a hook, so no spelling of one source has a
 * bucket of its own (a spelling the router refuses shares the real one's, which only limits it
 * more). Hashed, so a key is short whatever length of path a sender writes.
 */
function sourceKeyOf(url: string): string {
  const path = new URL(url).pathname.replace(/%[0-9A-Fa-f]{2}/g, (escaped) =>
    String.fromCharCode(Number.parseInt(escaped.slice(1), 16)),
  );
  const [plugin = "", source = ""] = path
    .toLowerCase()
    .slice(HOOKS_PATH.length + 1)
    .split("/")
    .filter((name) => name !== "");
  return createHash("sha256").update(`${plugin}/${source}`).digest("base64url");
}

/**
 * Behind a proxy on this machine: the socket is the proxy's for every visitor, so its address says
 * nothing of the sender. A forwarding header from any other socket is the sender's own text and
 * changes nothing (`X-Forwarded-For` is not trusted for an address).
 */
function behindProxy(request: HookRequest): boolean {
  return (
    isLoopbackAddress(request.remoteAddress) &&
    PROXY_HEADERS.some((name) => request.headers[name] !== undefined)
  );
}

function after(seconds: number): string {
  return `Send the delivery again after ${seconds} ${seconds === 1 ? "second" : "seconds"}.`;
}

function tooMany(message: string, retryAfterSeconds: number): ApiError {
  return new ApiError(429, "too_many_deliveries", message, after(retryAfterSeconds), {
    "retry-after": String(retryAfterSeconds),
  });
}

/** The 408 of a hook whose body was not whole by the deadline. */
export function hookBodyTooSlow(): ApiError {
  return new ApiError(
    408,
    "body_too_slow",
    `The delivery's body was not whole ${HOOK_BODY_DEADLINE_MS / 1000} seconds after its headers, so it was given up.`,
    "Send the delivery again, its body whole at once.",
  );
}

export function createHookLimiter(deps: { readonly clock: Clock }): HookLimiter {
  const addresses = new Map<string, Bucket>();
  const sources = new Map<string, Bucket>();
  let reading = 0;
  /** Bodies read now per address key; a key is deleted when its count reaches zero. */
  const readingBy = new Map<string, number>();

  function admit(request: HookRequest): HookAdmission {
    const nowMs = deps.clock.now();
    const addressKey = behindProxy(request) ? undefined : addressKeyOf(request.remoteAddress);
    const sourceKey = sourceKeyOf(request.url);
    const addressTokens =
      addressKey === undefined
        ? undefined
        : tokensOf(addresses.get(addressKey), PER_ADDRESS, nowMs);
    const sourceTokens = tokensOf(sources.get(sourceKey), PER_SOURCE, nowMs);
    const addressShort = addressTokens !== undefined && addressTokens < 1;
    const sourceShort = sourceTokens < 1;
    if (addressShort || sourceShort) {
      const seconds = Math.max(
        addressShort ? secondsUntilToken(addressTokens, PER_ADDRESS) : 0,
        sourceShort ? secondsUntilToken(sourceTokens, PER_SOURCE) : 0,
      );
      return {
        kind: "refused",
        error: tooMany(
          addressShort
            ? `This address sent deliveries faster than the ${HOOK_ADDRESS_PER_SECOND} a second (${HOOK_ADDRESS_BURST} at once) the hook route takes from one sender.`
            : `This source was sent deliveries faster than the ${HOOK_SOURCE_PER_SECOND} a second (${HOOK_SOURCE_BURST} at once) the hook route takes for one source.`,
          seconds,
        ),
      };
    }
    const readingByAddress = addressKey === undefined ? 0 : (readingBy.get(addressKey) ?? 0);
    if (readingByAddress >= HOOK_READING_PER_ADDRESS) {
      return {
        kind: "refused",
        error: tooMany(
          `This address already has ${HOOK_READING_PER_ADDRESS} deliveries being read, as many as the hook route reads from one sender at once.`,
          HOOK_BUSY_RETRY_AFTER_SECONDS,
        ),
      };
    }
    if (reading >= HOOK_BODIES_AT_ONCE) {
      return {
        kind: "refused",
        error: tooMany(
          `The worker is reading ${HOOK_BODIES_AT_ONCE} deliveries at once, as many as it reads.`,
          HOOK_BUSY_RETRY_AFTER_SECONDS,
        ),
      };
    }
    if (addressKey !== undefined && addressTokens !== undefined) {
      remember(
        addresses,
        addressKey,
        { tokens: addressTokens - 1, atMs: nowMs },
        HOOK_TRACKED_ADDRESSES,
      );
    }
    remember(sources, sourceKey, { tokens: sourceTokens - 1, atMs: nowMs }, HOOK_TRACKED_SOURCES);
    reading += 1;
    if (addressKey !== undefined) {
      readingBy.set(addressKey, readingByAddress + 1);
    }
    let released = false;
    return {
      kind: "admitted",
      release: () => {
        if (released) {
          return;
        }
        released = true;
        reading -= 1;
        if (addressKey !== undefined) {
          // A key lives only while its address has a body read: the map holds at most the slots.
          const left = (readingBy.get(addressKey) ?? 1) - 1;
          if (left > 0) {
            readingBy.set(addressKey, left);
          } else {
            readingBy.delete(addressKey);
          }
        }
      },
    };
  }

  return {
    admit,
    tracked: () => ({
      addresses: addresses.size,
      sources: sources.size,
      reading,
      readingAddresses: readingBy.size,
    }),
  };
}
