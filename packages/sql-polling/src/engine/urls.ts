import type { EngineTarget, Refusal } from "@facetdb/core";
import type { SqlDialect, TlsVerdict } from "../dialect/index.ts";

/**
 * The polling engine's side of "connections use TLS": every call refuses, before it connects, a URL
 * its dialect does not read and a URL that would carry a password to another machine in the clear,
 * by the dialect's TLS rule. The words are the Postgres trigger engine's (its urls.ts), with the
 * dialect's shape, its way of asking for TLS and the variable its driver falls back to, so a source
 * says the same thing whichever engine watches it; they name the source's connection string by the
 * target's `urlVariable`, or as `SOURCE_URL`.
 */

/** How the engine names a source's connection string in its words when no variable is known. */
export const SOURCE_URL = "the source's connection string";

/** The source's connection string as the words name it: its variable, else `SOURCE_URL`. */
export function subjectOf(target: Pick<EngineTarget, "urlVariable">): string {
  return target.urlVariable ?? SOURCE_URL;
}

/** `scheme:` at the start of a connection string (a URL's, per RFC 3986). */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/** A connection string's scheme when the dialect does not read it; undefined when it does or has none. */
function otherScheme(dialect: SqlDialect, url: string): string | undefined {
  const scheme = SCHEME.exec(url.trim())?.[1]?.toLowerCase();
  return scheme === undefined || dialect.schemes.includes(scheme) ? undefined : scheme;
}

/** The dialect's schemes in words: `postgres://, postgresql://`. */
const schemesOf = (dialect: SqlDialect) =>
  dialect.schemes.map((scheme) => `${scheme}://`).join(", ");

const AMBIGUOUS =
  "has more than one @ before the path, so its host cannot be read for sure (the driver and the check would read different hosts)";

const ambiguousFix = (subject: string) =>
  `percent-encode every @ in the user and password of ${subject} as %40`;

type Plaintext = Exclude<TlsVerdict, undefined | "invalid" | "ambiguous">;

/** Where a refused URL would go: its host, or the fallback variable's when the URL names none. */
const reaches = (subject: string, verdict: Plaintext) =>
  verdict.via === undefined
    ? `${subject} reaches ${verdict.host} without TLS`
    : `${subject} names no host, so the driver reaches ${verdict.via.variable} (${verdict.host}) without TLS`;

const fixFor = (dialect: SqlDialect, subject: string, via: Plaintext["via"]) =>
  `${dialect.tls.ask} ${subject},${via === undefined ? "" : ` ${via.fix},`} or pass --allow-insecure if that network is trusted`;

/** The admin URL's refusal, before anything connects; it plans and runs every script. */
export function adminUrlRefusal(
  dialect: SqlDialect,
  url: string,
  allowInsecure: boolean,
): Refusal | undefined {
  const subject = "the admin connection string";
  const scheme = otherScheme(dialect, url);
  if (scheme !== undefined) {
    return {
      code: "admin-url",
      message: `${subject} is a ${scheme}: one, and this polling engine reads ${dialect.name} (${schemesOf(dialect)}); no connection was made`,
      fix: `pass ${dialect.tls.secureShape} as --admin-url`,
    };
  }
  const verdict = dialect.tls.verdict(url, allowInsecure);
  if (verdict === undefined) {
    return undefined;
  }
  if (verdict === "invalid") {
    return {
      code: "admin-url",
      message: `${subject} is not a connection string`,
      fix: `pass ${dialect.tls.secureShape} as --admin-url`,
    };
  }
  if (verdict === "ambiguous") {
    return {
      code: "admin-url",
      message: `${subject} ${AMBIGUOUS}; no connection was made`,
      fix: ambiguousFix(subject),
    };
  }
  return {
    code: "admin-url-tls",
    message: `${reaches(subject, verdict)}, so the admin password would travel in the clear; no connection was made`,
    fix: fixFor(dialect, subject, verdict.via),
  };
}

/** A worker-side URL's problem and its fix, `subject` naming the URL, or undefined when it may be used. */
export function urlProblem(
  dialect: SqlDialect,
  url: string,
  subject: string,
  allowInsecure: boolean,
): { readonly code: string; readonly problem: string; readonly fix: string } | undefined {
  const scheme = otherScheme(dialect, url);
  if (scheme !== undefined) {
    return {
      code: "polling-scheme",
      problem: `${subject} is a ${scheme}: connection string, and this polling engine reads ${dialect.name} (${schemesOf(dialect)})`,
      fix: `set ${subject} to a ${dialect.name} connection string (${dialect.tls.shape}), or leave connector: "polling" out so its scheme picks the engine (it is for a Postgres host that forbids triggers; the Oracle and CockroachDB engines poll already)`,
    };
  }
  const verdict = dialect.tls.verdict(url, allowInsecure);
  if (verdict === undefined) {
    return undefined;
  }
  const code = "database-url-tls";
  if (verdict === "ambiguous") {
    return { code, problem: `${subject} ${AMBIGUOUS}`, fix: ambiguousFix(subject) };
  }
  return verdict === "invalid"
    ? {
        code,
        problem: `${subject} is not a connection string (${dialect.tls.shape})`,
        fix: fixFor(dialect, subject, undefined),
      }
    : {
        code,
        problem: `${reaches(subject, verdict)}, so the password in it would travel in the clear`,
        fix: fixFor(dialect, subject, verdict.via),
      };
}

/** The worker URL's refusal, before `open` connects (and `checkUrl`'s), naming it as `subject`. */
export function workerUrlRefusal(
  dialect: SqlDialect,
  url: string,
  allowInsecure: boolean,
  subject: string,
): Refusal | undefined {
  const refused = urlProblem(dialect, url, subject, allowInsecure);
  return refused === undefined
    ? undefined
    : {
        code: refused.code,
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
 * password, what is derived from it. Nothing the engine returns ever carries one.
 */
export function plainMessage(error: unknown, secrets: readonly unknown[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (typeof secret !== "string" || secret === "") {
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
