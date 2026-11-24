import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { WebhookFetch } from "./outbox.ts";
import { isPrivateAddress } from "./private-address.ts";

/**
 * The webhook send: a `WebhookFetch` over `node:http` and `node:https` that refuses a host on this
 * machine or a private network unless the endpoint allows one, and connects to the very address it
 * judged.
 *
 * How the check and the connect read one answer. A name is never resolved twice for a send: the
 * request's socket finds its address through `lookup` below, which asks the resolver once, judges
 * every address of that one answer, and hands the socket those addresses and no others; a second
 * lookup in the same send (none happens with a fresh socket per send, `agent: false`) is handed the
 * same answer. There is no other way to an address: Node's socket connects to what `lookup` gives,
 * and nothing here resolves a name to check it and lets the socket resolve it again. A literal
 * address in the URL, which the socket connects to with no lookup, is judged before the request.
 * TLS still checks the certificate against the name, which the request keeps as its host.
 *
 * No redirect is followed (a 3xx is the answer), no proxy is used, and the body of the answer is
 * never read: the outbox needs its status alone.
 */

/** One address a name resolves to, as `dns.promises.lookup(name, { all: true })` answers. */
export type ResolvedAddress = { readonly address: string; readonly family: number };

/**
 * What the socket asked its lookup for, handed to the resolver: the `getaddrinfo` hints Node passes
 * (ADDRCONFIG by default, so a machine with no IPv6 route is not handed an AAAA answer first).
 */
export type ResolveOptions = { readonly hints?: number };

/**
 * Resolves a name to every address it has, of both families; the composition root passes the
 * system resolver with the hints. Every address it answers is judged.
 */
export type Resolve = (
  hostname: string,
  options: ResolveOptions,
) => Promise<readonly ResolvedAddress[]>;

export type PinnedFetchDeps = {
  readonly resolve: Resolve;
  /**
   * The `User-Agent` each send carries, `facetdb/<version>` from the composition root: an edge
   * that refuses a request with none (AWS WAF's NoUserAgent_HEADER rule) accepts it.
   */
  readonly userAgent: string;
  /** Whether an address is on this machine or a private network: the shared classifier by default. */
  readonly isPrivate?: (address: string) => boolean;
};

const FIX = "if the receiver is yours, set allowPrivate: true beside its url";

/**
 * A send refused before any connection: the endpoint's host is, or resolved to, a private address
 * the endpoint does not allow. Its words name the address alone, never the URL's path or query,
 * and the outbox keeps them as the failed attempt's: retried on its schedule, as a name may
 * resolve elsewhere later, and given up after 24 hours as any failure.
 */
export class PrivateAddressRefused extends Error {
  readonly address: string;

  constructor(address: string, resolved: boolean) {
    const shown = isIP(address) === 0 ? "a value that is not an IP address" : address;
    super(
      resolved
        ? `the endpoint's host resolved to ${shown}, a private address this endpoint does not allow: ${FIX}`
        : `the endpoint's host is ${shown}, a private address this endpoint does not allow: ${FIX}`,
    );
    this.name = "PrivateAddressRefused";
    this.address = address;
  }
}

/** The family a socket's lookup asks for, or undefined for any. */
function familyOf(family: number | "IPv4" | "IPv6" | undefined): 4 | 6 | undefined {
  if (family === 4 || family === "IPv4") {
    return 4;
  }
  return family === 6 || family === "IPv6" ? 6 : undefined;
}

/**
 * The socket's `lookup` for one send: the resolver asked once, every address it answers judged,
 * and only those addresses handed on. Any private one refuses the send unless it is allowed, so a
 * name that answers a public and a private address cannot have the socket pick the private one.
 */
function pinnedLookup(
  resolve: Resolve,
  allowed: (address: string) => boolean,
): { readonly lookup: LookupFunction; readonly refusal: () => PrivateAddressRefused | undefined } {
  let answer: Promise<readonly ResolvedAddress[]> | undefined;
  let refused: PrivateAddressRefused | undefined;
  const lookup: LookupFunction = (hostname, options, callback) => {
    // Both families are asked for and judged whatever `family` the socket wants; only the family
    // it wants is handed back (below). The hints go through as the socket gave them.
    answer ??= resolve(hostname, options.hints === undefined ? {} : { hints: options.hints });
    answer.then(
      (addresses) => {
        const barred = addresses.find((found) => !allowed(found.address));
        if (barred !== undefined) {
          refused = new PrivateAddressRefused(barred.address, true);
          callback(refused, "");
          return;
        }
        const family = familyOf(options.family);
        const usable = addresses.filter((found) => family === undefined || found.family === family);
        const [first] = usable;
        if (first === undefined) {
          callback(
            Object.assign(new Error("the endpoint's host has no address"), { code: "ENOTFOUND" }),
            "",
          );
          return;
        }
        if (options.all === true) {
          callback(
            null,
            usable.map((found) => ({ address: found.address, family: found.family })),
          );
          return;
        }
        callback(null, first.address, first.family);
      },
      (error: unknown) => {
        callback(
          error instanceof Error ? error : new Error("the endpoint's host could not be resolved"),
          "",
        );
      },
    );
  };
  return { lookup, refusal: () => refused };
}

/**
 * The headers of one send: `User-Agent` and an `Accept` of any type by default (as `fetch` sent in
 * an earlier version, the agent now naming facetdb), every header the outbox set over them whatever
 * its case, and the body's length. Node adds `Host` and `Connection` itself. `fetch`'s
 * browser-shaped `accept-language: *` and `sec-fetch-mode: cors` are not sent.
 */
function requestHeaders(
  userAgent: string,
  init: Parameters<WebhookFetch>[1],
): Record<string, string> {
  const headers: Record<string, string> = { "user-agent": userAgent, accept: "*/*" };
  for (const [name, value] of Object.entries(init.headers)) {
    headers[name.toLowerCase()] = value;
  }
  headers["content-length"] = String(Buffer.byteLength(init.body));
  return headers;
}

/** The `WebhookFetch` the composition root hands the outbox (`createOutbox`'s `fetch`). */
export function createPinnedFetch(deps: PinnedFetchDeps): WebhookFetch {
  const isPrivate = deps.isPrivate ?? isPrivateAddress;
  return (endpoint, init) => {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return Promise.reject(new Error("a webhook is sent over http or https only"));
    }
    const allowed = (address: string): boolean => init.allowPrivate || !isPrivate(address);
    const hostname =
      url.hostname.startsWith("[") && url.hostname.endsWith("]")
        ? url.hostname.slice(1, -1)
        : url.hostname;
    // A literal address is connected to as written, with no lookup: it is judged here.
    if (isIP(hostname) !== 0 && !allowed(hostname)) {
      return Promise.reject(new PrivateAddressRefused(hostname, false));
    }
    const pinned = pinnedLookup(deps.resolve, allowed);
    const options: RequestOptions = {
      protocol: url.protocol,
      hostname,
      port: url.port === "" ? undefined : Number(url.port),
      path: `${url.pathname}${url.search}`,
      method: init.method,
      headers: requestHeaders(deps.userAgent, init),
      // A fresh socket per send: no socket connected for another send, under another answer, is reused.
      agent: false,
      lookup: pinned.lookup,
      signal: init.signal,
    };
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    return new Promise((resolve, reject) => {
      const request = send(options, (response) => {
        // The status is all the outbox reads; the body is never read, and the socket closes.
        resolve({ status: response.statusCode ?? 0 });
        response.destroy();
      });
      request.on("error", (error) => {
        reject(pinned.refusal() ?? error);
      });
      request.end(init.body);
    });
  };
}
