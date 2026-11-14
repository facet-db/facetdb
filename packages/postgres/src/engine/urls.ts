import type { Refusal } from "@facetdb/core";
import { AmbiguousHostError, PlaintextUrlError, requireTls } from "../store/index.ts";

/**
 * The engine's side of "connections use TLS": every call refuses, before it
 * connects, a URL that would carry a password to another machine in the clear, by the store's own
 * rule (`requireTls`), in the words the CLI prints today (its database.ts). The engine is not told
 * which variable holds a source's URL, so it names it `SOURCE_URL`.
 */

/** How the engine names a source's connection string in its words. */
export const SOURCE_URL = "the source's connection string";

/** What the TLS rule says of a URL: nothing, not a URL, an ambiguous host, or the host reached in the clear. */
type TlsVerdict =
  | undefined
  | "invalid"
  | "ambiguous"
  | { readonly host: string; readonly viaPgHost: boolean };

function tlsVerdict(url: string, allowInsecure: boolean, pgHost: string | undefined): TlsVerdict {
  try {
    requireTls(url, allowInsecure, pgHost);
    return undefined;
  } catch (error) {
    if (error instanceof AmbiguousHostError) {
      return "ambiguous";
    }
    return error instanceof PlaintextUrlError
      ? { host: error.host, viaPgHost: error.viaPgHost }
      : "invalid";
  }
}

const AMBIGUOUS =
  "has more than one @ before the path, so its host cannot be read for sure (the driver and the check would read different hosts)";

const ambiguousFix = (target: string) =>
  `percent-encode every @ in the user and password of ${target} as %40`;

/** Where a refused URL would go: its host, or `PGHOST`'s when the URL names none. */
const reaches = (subject: string, host: { readonly host: string; readonly viaPgHost: boolean }) =>
  host.viaPgHost
    ? `${subject} names no host, so the driver reaches PGHOST (${host.host}) without TLS`
    : `${subject} reaches ${host.host} without TLS`;

const fixFor = (target: string, viaPgHost: boolean) =>
  `add ?sslmode=require to ${target},${viaPgHost ? " point PGHOST at this machine or a socket directory," : ""} or pass --allow-insecure if that network is trusted`;

/** The admin URL's refusal, before anything connects; it plans and runs every script. */
export function adminUrlRefusal(
  url: string,
  allowInsecure: boolean,
  pgHost: string | undefined,
): Refusal | undefined {
  const verdict = tlsVerdict(url, allowInsecure, pgHost);
  if (verdict === undefined) {
    return undefined;
  }
  if (verdict === "invalid") {
    return {
      code: "admin-url",
      message: "the admin connection string is not a connection string",
      fix: "pass postgres://user:password@host/database?sslmode=require as --admin-url",
    };
  }
  if (verdict === "ambiguous") {
    return {
      code: "admin-url",
      message: `the admin connection string ${AMBIGUOUS}; no connection was made`,
      fix: ambiguousFix("the admin connection string"),
    };
  }
  return {
    code: "admin-url-tls",
    message: `${reaches("the admin connection string", verdict)}, so the admin password would travel in the clear; no connection was made`,
    fix: fixFor("the admin connection string", verdict.viaPgHost),
  };
}

/** A worker-side URL's problem and its fix, `subject` naming the URL, or undefined when it may be used. */
export function urlProblem(
  url: string,
  subject: string,
  allowInsecure: boolean,
  pgHost: string | undefined,
): { readonly problem: string; readonly fix: string } | undefined {
  const verdict = tlsVerdict(url, allowInsecure, pgHost);
  if (verdict === undefined) {
    return undefined;
  }
  if (verdict === "ambiguous") {
    return { problem: `${subject} ${AMBIGUOUS}`, fix: ambiguousFix(subject) };
  }
  return verdict === "invalid"
    ? {
        problem: `${subject} is not a connection string (postgres://user:password@host/database)`,
        fix: fixFor(subject, false),
      }
    : {
        problem: `${reaches(subject, verdict)}, so the password in it would travel in the clear`,
        fix: fixFor(subject, verdict.viaPgHost),
      };
}

/** The worker URL's refusal, before `open` connects. */
export function workerUrlRefusal(
  url: string,
  allowInsecure: boolean,
  pgHost: string | undefined,
): Refusal | undefined {
  const refused = urlProblem(url, SOURCE_URL, allowInsecure, pgHost);
  return refused === undefined
    ? undefined
    : {
        code: "database-url-tls",
        message: `${refused.problem}; no connection was made`,
        fix: refused.fix,
      };
}

/** Where a connection string points, without its user or password: what the words name. */
export function databaseLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//, "");
    return name === "" ? parsed.host : `${parsed.host}/${name}`;
  } catch {
    return "the database";
  }
}

/**
 * An error's message with every secret blanked out: a URL and the password in it, the worker
 * password, the verifier made of it. Nothing the engine returns ever carries one.
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
