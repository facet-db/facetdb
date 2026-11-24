import { BlockList, isIP } from "node:net";

/**
 * Whether a webhook's destination is on this machine or a private network: the worker posts signed
 * decisions to the addresses a config names, and an address inside the worker's own network (a
 * database, an admin port, the cloud's metadata service at 169.254.169.254) is not where a webhook
 * goes unless the config says `allowPrivate: true`.
 *
 * The load-time rule judges the host as the WHATWG URL parser leaves it, which has already read
 * every other spelling of an IPv4 address (`127.1`, `2130706433`, `0177.0.0.1`, `0x7f.1`, a
 * percent-encoded or full-width one, a trailing dot) into its dotted form and lowercased a name. A
 * public name that resolves to a private address is not visible here: the send-time check judges
 * each address a name resolves to with `isPrivateAddress`.
 */

/** IPv4 ranges that are not a public internet address. */
const IPV4_RANGES: readonly (readonly [string, number])[] = [
  ["0.0.0.0", 8], // "this network"; 0.0.0.0 reaches this machine
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, the cloud metadata service among them
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, the broadcast address among them
];

/**
 * IPv6 ranges that are not a public internet address. `::` and `::1` sit in `::/96`, which is
 * judged by the IPv4 address in its last 32 bits (`ipv4Inside`), as 0.0.0.0 and 0.0.0.1.
 */
const IPV6_RANGES: readonly (readonly [string, number])[] = [
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // site-local, deprecated but still routed by some stacks
  ["ff00::", 8], // multicast
  ["64:ff9b:1::", 48], // NAT64 for local use (RFC 8215)
];

const blocked = new BlockList();
for (const [network, prefix] of IPV4_RANGES) {
  blocked.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of IPV6_RANGES) {
  blocked.addSubnet(network, prefix, "ipv6");
}

/**
 * Names that never belong to a public host: `localhost` and every name under it (RFC 6761), and
 * the suffixes reserved or used for a local network: mDNS's `.local`, `.internal` (where clouds
 * name their metadata service, `metadata.google.internal`), `.home.arpa` and `.localdomain`; and
 * the ones private by convention, none a delegated top-level name: Kubernetes' `.svc`
 * (`kubernetes.default.svc`), `.lan`, `.home`, `.corp` and `.intranet`.
 */
const PRIVATE_SUFFIXES: readonly string[] = [
  "localhost",
  "local",
  "internal",
  "home.arpa",
  "localdomain",
  "svc",
  "lan",
  "home",
  "corp",
  "intranet",
];

/** The eight 16-bit groups of an IPv6 address `isIP` accepted, a trailing dotted quad included. */
function groupsOf(address: string): readonly number[] {
  let text = address;
  const quad = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (quad !== null) {
    const [, a, b, c, d] = quad.map(Number);
    const high = ((a ?? 0) << 8) | (b ?? 0);
    const low = ((c ?? 0) << 8) | (d ?? 0);
    text = `${text.slice(0, quad.index)}${high.toString(16)}:${low.toString(16)}`;
  }
  const parts = (half: string): number[] =>
    half === "" ? [] : half.split(":").map((group) => Number.parseInt(group, 16));
  const [head = "", tail] = text.split("::");
  if (tail === undefined) {
    return parts(head);
  }
  const before = parts(head);
  const after = parts(tail);
  return [...before, ...Array<number>(8 - before.length - after.length).fill(0), ...after];
}

function dotted(high: number, low: number): string {
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

/**
 * The IPv4 address an IPv6 one carries, or undefined: IPv4-mapped (`::ffff:a.b.c.d`), the
 * deprecated IPv4-compatible `::a.b.c.d` (`::` and `::1` among them), IPv4-translated
 * (`::ffff:0:a.b.c.d`), NAT64's well-known prefix (`64:ff9b::a.b.c.d`) and 6to4 (`2002:AABB:CCDD::`).
 */
function ipv4Inside(groups: readonly number[]): string | undefined {
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  const zeroToG3 = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0;
  if (zeroToG3 && g4 === 0 && (g5 === 0 || g5 === 0xffff)) {
    return dotted(g6, g7);
  }
  if (zeroToG3 && g4 === 0xffff && g5 === 0) {
    return dotted(g6, g7);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return dotted(g6, g7);
  }
  if (g0 === 0x2002) {
    return dotted(g1 ?? 0, g2 ?? 0);
  }
  return undefined;
}

/**
 * Whether `address`, an IP address as text (IPv4 dotted, IPv6 without brackets, a zone allowed),
 * is on this machine, a private or link-local network, or otherwise not a public internet address.
 * Text that is not an IP address is not a public address either: true.
 */
export function isPrivateAddress(address: string): boolean {
  const bare = address.replace(/%.*$/, "");
  const family = isIP(bare);
  if (family === 4) {
    return blocked.check(bare, "ipv4");
  }
  if (family !== 6) {
    return true;
  }
  const groups = groupsOf(bare);
  const inside = ipv4Inside(groups);
  if (inside !== undefined) {
    return blocked.check(inside, "ipv4");
  }
  return blocked.check(bare, "ipv6");
}

/**
 * Whether a URL's host, as `new URL(text).hostname` gives it (an IPv6 address in brackets), is a
 * private address (`isPrivateAddress`), `localhost` or a name under a private suffix, or a name
 * of one label (`metadata`, `intranet`), which only a local resolver answers. A trailing dot and
 * case are ignored. Any other name is judged where it is resolved, never here.
 */
export function isPrivateHost(hostname: string): boolean {
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare.replace(/%.*$/, "")) !== 0) {
    return isPrivateAddress(bare);
  }
  const name = bare.toLowerCase().replace(/\.+$/, "");
  if (!name.includes(".")) {
    return true;
  }
  return PRIVATE_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}
