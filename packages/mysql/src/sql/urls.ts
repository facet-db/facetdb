import type { Refusal } from "@facetdb/core";

/**
 * "Connections use TLS", on MySQL and MariaDB: every call refuses, before it connects, a connection
 * string that would carry a password to another machine in the clear, unless the operator passed
 * `--allow-insecure` for a network they trust. The URL is judged as mysql2 reads it
 * (`ConnectionConfig.parseUrl`, mysql2 3.24): the WHATWG parser, the host percent-decoded with an
 * IPv6 address's brackets dropped and an empty one read as localhost, a non-empty `socketPath`
 * parameter connecting through a socket on this machine, and each parameter taken from its first
 * occurrence, read as JSON when it parses as JSON. TLS is on when `ssl` is a JSON object
 * (`ssl={"rejectUnauthorized":true}`) or names one of the driver's profiles (`ssl=Amazon RDS`, a
 * name it does not know making it refuse to connect at all); `ssl=true` is a boolean, which mysql2
 * rejects rather than reads as TLS, so it is no TLS here either, with a fix that says how to write
 * it.
 */

/** Loopback names and addresses: a password sent to one never leaves this machine. */
const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1"]);

/** The parameter that turns TLS on, written the way the fixes print it. */
export const TLS_PARAMETER = 'ssl={"rejectUnauthorized":true}';

/** What the TLS rule finds in a URL: nothing to refuse, not a URL, or the host reached in the clear. */
export type TlsProblem = undefined | "invalid" | { readonly host: string };

/** A parameter's value as mysql2 reads it: JSON when it parses as JSON, else the text itself. */
function driverValue(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Whether mysql2 would connect with TLS, or not at all, for this `ssl` parameter. */
function asksForTls(ssl: string | null): boolean {
  if (ssl === null) {
    return false;
  }
  const value = driverValue(ssl);
  return (
    (typeof value === "object" && value !== null) || (typeof value === "string" && value !== "")
  );
}

/** The host mysql2 connects to: brackets dropped, percent-decoded, localhost when empty. */
function driverHost(parsed: URL): string {
  const { hostname } = parsed;
  const host = decodeURIComponent(hostname.startsWith("[") ? hostname.slice(1, -1) : hostname);
  return host === "" ? "localhost" : host;
}

export function tlsProblem(url: string, allowInsecure: boolean): TlsProblem {
  if (allowInsecure) {
    return undefined;
  }
  let parsed: URL;
  let host: string;
  try {
    parsed = new URL(url);
    host = driverHost(parsed);
  } catch {
    return "invalid";
  }
  // mysql2 goes through the socket when its socketPath is set, as JavaScript reads a value as set.
  const socket = parsed.searchParams.get("socketPath");
  const throughSocket = socket !== null && Boolean(driverValue(socket));
  if (throughSocket) {
    return undefined;
  }
  if (LOCAL_HOSTS.has(host.toLowerCase()) || asksForTls(parsed.searchParams.get("ssl"))) {
    return undefined;
  }
  return { host };
}

/** The admin URL's refusal, before anything connects: it plans and runs every script. */
export function adminUrlRefusal(url: string, allowInsecure: boolean): Refusal | undefined {
  const problem = tlsProblem(url, allowInsecure);
  if (problem === undefined) {
    return undefined;
  }
  if (problem === "invalid") {
    return {
      code: "admin-url",
      message: "the admin connection string is not a connection string",
      fix: `pass mysql://user:password@host:3306/database?${TLS_PARAMETER} as --admin-url`,
    };
  }
  return {
    code: "admin-url-tls",
    message: `the admin connection string reaches ${problem.host} without TLS, so the admin password would travel in the clear; no connection was made`,
    fix: `add ?${TLS_PARAMETER} to the admin connection string (mysql2 reads ssl as a JSON object, so ssl=true does not turn TLS on), or pass --allow-insecure if that network is trusted`,
  };
}

/**
 * An error's message with every secret blanked out: each value given, and the password inside one
 * that is a URL. The run passes the worker password both as given and as the driver escaped it; the
 * `secret` statement's own failure it reports by number and code alone, since a server's "near '…'"
 * quotes a cut of the statement that a whole-value search can miss.
 */
export function plainMessage(error: unknown, secrets: readonly (string | undefined)[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret === undefined || secret === "") {
      continue;
    }
    message = message.replaceAll(secret, "***");
    try {
      const password = decodeURIComponent(new URL(secret).password);
      if (password !== "") {
        message = message.replaceAll(password, "***");
      }
    } catch {
      // Not a URL: the whole value was already blanked.
    }
  }
  return message;
}
