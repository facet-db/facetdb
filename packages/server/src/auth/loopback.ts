import type { Peer } from "./middleware.ts";

const IPV4_LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const IPV4_MAPPED = /^::ffff:/i;

/**
 * The headers a reverse proxy adds; one of them means the visitor is not who the socket says. The
 * hook route's limits read the same list (hooks/limits.ts).
 */
export const PROXY_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-real-ip",
] as const;

/** 127.0.0.0/8 and ::1, also as an IPv4-mapped IPv6 address, which a dual-stack socket reports. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (address === undefined) {
    return false;
  }
  const bare = address.replace(IPV4_MAPPED, "");
  return bare === "::1" || IPV4_LOOPBACK.test(bare);
}

/** A host a server may be told to bind (`--host`): `localhost` or a loopback address, bracketed or not. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare.toLowerCase() === "localhost" || isLoopbackAddress(bare);
}

function hostOf(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/**
 * Whether a request is the operator's own browser or terminal on this machine, the only request
 * that needs no sign-in. The socket's address must be loopback, and three things that would make a
 * local socket carry a stranger's request must be absent: a proxy's headers (a proxy on this
 * machine makes every visitor look local), a `Host` that is not a loopback name (DNS rebinding
 * points a page's own name at 127.0.0.1), and an `Origin` that is not the page's own host (a web
 * page open on this machine posting to it).
 */
export function fromThisMachine(request: Request, peer: Peer): boolean {
  if (!isLoopbackAddress(peer.remoteAddress)) {
    return false;
  }
  if (PROXY_HEADERS.some((name) => request.headers.has(name))) {
    return false;
  }
  const host = hostOf(request.url);
  if (host === undefined || !isLoopbackHost(new URL(request.url).hostname)) {
    return false;
  }
  const origin = request.headers.get("origin");
  return origin === null || hostOf(origin) === host;
}

/**
 * A request that would be this machine's but for its `Origin`, which names another host: a loopback
 * socket, a loopback `Host` and no proxy header. A page of the studio sends its own address as its
 * Origin, so this is what a proxy in front looks like when it rewrites `Host` to the upstream's (as
 * nginx's `proxy_pass` does) and sets no forwarding header. A page of another site open in a
 * browser on this machine looks the same, which is why it is only ever reported, never trusted.
 */
export function proxiedWithoutHeader(request: Request, peer: Peer): boolean {
  if (!isLoopbackAddress(peer.remoteAddress)) {
    return false;
  }
  if (PROXY_HEADERS.some((name) => request.headers.has(name))) {
    return false;
  }
  const host = hostOf(request.url);
  if (host === undefined || !isLoopbackHost(new URL(request.url).hostname)) {
    return false;
  }
  const origin = request.headers.get("origin");
  const pageHost = origin === null ? undefined : hostOf(origin);
  return pageHost !== undefined && pageHost !== host;
}
