import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { fromThisMachine, isLoopbackHost, proxiedWithoutHeader } from "./loopback.ts";
import type { AppEnv } from "./middleware.ts";
import { SESSION_COOKIE } from "./sessions.ts";

/**
 * Who is the operator, the one person who needs no sign-in. By default it is a request from this
 * machine (`fromThisMachine`). A studio whose config names a `studioUrl` on another host is opened
 * through that address, by a proxy or from other machines, and a proxy on this machine makes every
 * visitor's request look local: there no address makes the operator, and every request signs in,
 * this machine's too.
 */

/**
 * Whether the operator is known by address: true with no `studioUrl` or one naming this machine
 * (`localhost`, 127.0.0.0/8, `[::1]`), false for any other host. The host is read as a browser reads
 * it (`http://127.1` is 127.0.0.1, `http://LOCALHOST` is localhost), and anything that does not
 * parse, or names this machine in any other spelling (`localhost.`, an IPv4-mapped address), counts
 * as another host: the mistake that can happen is asking this machine's user to sign in.
 */
export function operatorKnownByAddress(studioUrl: string | undefined): boolean {
  if (studioUrl === undefined) {
    return true;
  }
  try {
    return isLoopbackHost(new URL(studioUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The host of a `studioUrl` as words name it: the parsed host (`studio.example.com`,
 * `studio.example.com:8443`), never the text as written, so nothing but the host is ever repeated.
 */
export function studioUrlHost(studioUrl: string): string {
  return URL.canParse(studioUrl) ? new URL(studioUrl).host : "another host";
}

/** What the worker prints, once, when a proxy in front seems to set no forwarding header. */
export const PROXY_WITHOUT_HEADER_LINE =
  "A request from another site reached the studio with no forwarding header. If a proxy sends visitors here, they get in as you: set studioUrl in facetdb.config.ts to the address people open, then restart the worker.";

/**
 * The first middleware after the request id: sets `byAddress` for every request, which every check
 * of who is asking reads (`requireReviewer`, the session cookie's `Secure`, `isOperator`). With the
 * operator known by address, the first request that looks proxied without a forwarding header
 * prints `PROXY_WITHOUT_HEADER_LINE`, once for the process; it changes nothing about the request.
 */
export function addressCheck(options: {
  readonly operatorByAddress: boolean;
  readonly log: (line: string) => void;
}) {
  let told = false;
  return createMiddleware<AppEnv>(async (c, next) => {
    if (!options.operatorByAddress) {
      c.set("byAddress", "nobody");
    } else if (fromThisMachine(c.req.raw, c.env)) {
      c.set("byAddress", "this-machine");
    } else {
      c.set("byAddress", "elsewhere");
      if (!told && proxiedWithoutHeader(c.req.raw, c.env)) {
        told = true;
        options.log(PROXY_WITHOUT_HEADER_LINE);
      }
    }
    await next();
  });
}

/** The words a route refuses a request with, as an `ApiError`'s message and fix. */
export type OperatorRefusal = { readonly message: string; readonly fix: string };

/**
 * The words for a request that is not the operator: `noOperator` where no address makes one (a
 * `studioUrl` on another host, which then needs the commands to run instead), `notOperator`
 * otherwise. The setup and the question install choose by it; so may any operator-only route.
 */
export function operatorRefusal(
  c: Context<AppEnv>,
  words: { readonly notOperator: OperatorRefusal; readonly noOperator: OperatorRefusal },
): OperatorRefusal {
  return c.get("byAddress") === "nobody" ? words.noOperator : words.notOperator;
}

/**
 * Whether the request is this machine's operator: on this machine by address, with no session
 * cookie (a signed-in account is that account, never the OS user). False for every request when
 * the operator is not known by address. The setup's and the question install's writing routes are
 * the operator's alone.
 */
export function isOperator(c: Context<AppEnv>): boolean {
  return c.get("byAddress") === "this-machine" && getCookie(c, SESSION_COOKIE) === undefined;
}
