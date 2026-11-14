import type { Refusal } from "@facetdb/core";

/**
 * A SQL Server connection string as FacetDB reads it, and the engine's side of "connections use
 * TLS": `mssql://user:password@host:1433/database` (or `sqlserver://`), with TLS on and the
 * server's certificate checked unless the string says `encrypt=false` or
 * `trustServerCertificate=true`. Either one toward another machine is refused before anything
 * connects, unless the operator passed `--allow-insecure`; this machine's own server may be reached
 * either way, as the Postgres engine's rule allows (its `requireTls`).
 */

/** The schemes of a SQL Server connection string, as the CLI's engine table maps them. */
export const MSSQL_SCHEMES: readonly string[] = ["mssql", "sqlserver"];

/** SQL Server's port when the string names none. */
export const DEFAULT_PORT = 1433;

/** What a connection string says, decoded. */
export type MssqlUrl = {
  /** As written: `db.example.com`, `127.0.0.1`, `[::1]`. */
  readonly host: string;
  readonly port: number;
  /** The database the path names; without one the login's default database is used. */
  readonly database: string | undefined;
  readonly user: string;
  readonly password: string;
  /** `strict` is TDS 8.0: TLS before the login, the certificate always checked. */
  readonly encrypt: boolean | "strict";
  readonly trustServerCertificate: boolean;
};

/** Why a string is not a SQL Server connection string, as the words of a refusal go on from it. */
export class MssqlUrlError extends Error {
  /** More than one `@` before the path: the host cannot be read for sure. */
  readonly ambiguous: boolean;

  constructor(message: string, ambiguous: boolean) {
    super(message);
    this.name = "MssqlUrlError";
    this.ambiguous = ambiguous;
  }
}

const AMBIGUOUS =
  "has more than one @ before the path, so its host cannot be read for sure (the driver and the check would read different hosts)";

/**
 * The one form FacetDB reads. Named instances (`host\instance`, found through the SQL Browser) and
 * the key=value strings of ADO.NET, ODBC, JDBC or Prisma (`Server=…;Database=…`,
 * `sqlserver://host;database=…;password=…`) are not read: the instance's TCP port takes its name's
 * place, and a key=value string is written again as a URL.
 */
export const URL_FORM = "mssql://user:password@host:1433/database";

const NOT_A_URL = `is not a SQL Server URL (${URL_FORM})`;

/**
 * A host name or an IPv4 address (letters, digits, `-`, `_` and dots), or an IPv6 address in
 * brackets. Anything else is refused before it reaches the driver: a Prisma-style string's
 * `host;database=x;password=…` reads to a URL parser as one host, password included, which the
 * driver would then name in its connection error.
 */
const HOST = /^(?:[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*|\[[0-9A-Fa-f:.]+\])$/;

/**
 * The last value of a parameter, its name in any case (`Encrypt=false` as the portals write it): a
 * later one replaces an earlier one, as a driver reads them.
 */
function lastParam(url: URL, name: string): string | undefined {
  return [...url.searchParams]
    .filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .at(-1)?.[1]
    .toLowerCase();
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new MssqlUrlError(`${NOT_A_URL}: it holds a % that starts no escape`, false);
  }
}

/** Reads a connection string, or throws `MssqlUrlError` saying what is wrong with it. */
export function parseMssqlUrl(url: string): MssqlUrl {
  const scheme = url.indexOf("://");
  const authority = scheme === -1 ? "" : (url.slice(scheme + 3).split(/[/?#]/)[0] ?? "");
  if (authority.split("@").length > 2) {
    throw new MssqlUrlError(AMBIGUOUS, true);
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new MssqlUrlError(NOT_A_URL, false);
  }
  if (!MSSQL_SCHEMES.includes(parsed.protocol.slice(0, -1).toLowerCase())) {
    throw new MssqlUrlError(NOT_A_URL, false);
  }
  if (parsed.hostname === "") {
    throw new MssqlUrlError(`${NOT_A_URL}: it names no host`, false);
  }
  if (!HOST.test(parsed.hostname)) {
    throw new MssqlUrlError(
      `${NOT_A_URL}: its host holds characters no host name has, as the key=value pairs of a JDBC or Prisma string do`,
      false,
    );
  }
  const encrypt = lastParam(parsed, "encrypt");
  const trust = lastParam(parsed, "trustServerCertificate");
  if (encrypt !== undefined && !["true", "false", "strict"].includes(encrypt)) {
    throw new MssqlUrlError(`${NOT_A_URL}: encrypt is true, false or strict`, false);
  }
  if (trust !== undefined && !["true", "false"].includes(trust)) {
    throw new MssqlUrlError(`${NOT_A_URL}: trustServerCertificate is true or false`, false);
  }
  const database = decoded(parsed.pathname.replace(/^\//, ""));
  return {
    host: parsed.hostname,
    port: parsed.port === "" ? DEFAULT_PORT : Number(parsed.port),
    database: database === "" ? undefined : database,
    user: decoded(parsed.username),
    password: decoded(parsed.password),
    encrypt: encrypt === "strict" ? "strict" : encrypt !== "false",
    trustServerCertificate: trust === "true",
  };
}

const LOCAL_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** What would cross the network unprotected: the password in the clear, or past any certificate. */
export type TlsProblem = {
  readonly host: string;
  /** `plaintext`: `encrypt=false`; `unverified`: `trustServerCertificate=true`. */
  readonly kind: "plaintext" | "unverified";
};

/**
 * The TLS rule for a connection string: nothing when it may be used, else what is wrong. A host of
 * this machine may be reached without TLS, as on Postgres; `allowInsecure` is the one way out.
 */
export function tlsProblem(url: MssqlUrl, allowInsecure: boolean): TlsProblem | undefined {
  if (allowInsecure || LOCAL_HOSTS.has(url.host.toLowerCase())) {
    return undefined;
  }
  if (url.encrypt === false) {
    return { host: url.host, kind: "plaintext" };
  }
  return url.trustServerCertificate ? { host: url.host, kind: "unverified" } : undefined;
}

/**
 * The admin connection string's refusal, before anything connects: it plans and runs every script
 *. Undefined when it may be used.
 */
export function adminUrlRefusal(url: string, allowInsecure: boolean): Refusal | undefined {
  let parsed: MssqlUrl;
  try {
    parsed = parseMssqlUrl(url);
  } catch (error) {
    if (!(error instanceof MssqlUrlError)) {
      throw error;
    }
    return error.ambiguous
      ? {
          code: "admin-url",
          message: `the admin connection string ${error.message}; no connection was made`,
          fix: "percent-encode every @ in the user and password of the admin connection string as %40",
        }
      : {
          code: "admin-url",
          message: `the admin connection string ${error.message}; no connection was made`,
          fix: `pass the admin connection string as ${URL_FORM} (or sqlserver://…) with --admin-url; a named instance (host\\instance) and an ADO.NET, ODBC, JDBC or Prisma key=value string (Server=…;Database=…) are not read: give the instance's TCP port, and write the string as that URL`,
        };
  }
  const problem = tlsProblem(parsed, allowInsecure);
  if (problem === undefined) {
    return undefined;
  }
  return problem.kind === "plaintext"
    ? {
        code: "admin-url-tls",
        message: `the admin connection string reaches ${problem.host} without TLS (encrypt=false), so the admin password would travel in the clear; no connection was made`,
        fix: "remove encrypt=false from the admin connection string, or pass --allow-insecure if that network is trusted",
      }
    : {
        code: "admin-url-tls",
        message: `the admin connection string takes any certificate ${problem.host} shows (trustServerCertificate=true), so a machine in between could read the admin password; no connection was made`,
        fix: "remove trustServerCertificate=true and give the server a certificate this machine trusts, or pass --allow-insecure if that network is trusted",
      };
}

/**
 * The worker login's connection string refused before anything connects (`checkUrl`, `open`,
 * doctor; "connections use TLS"), worded with `subject`, the variable that names it: undefined when
 * it may be used. The worker's password is the one credential FacetDB keeps, so it never crosses
 * the network in the clear or past an unchecked certificate unless the operator passed
 * `--allow-insecure`.
 */
export function workerUrlRefusal(
  url: string,
  allowInsecure: boolean,
  subject: string,
): Refusal | undefined {
  let parsed: MssqlUrl;
  try {
    parsed = parseMssqlUrl(url);
  } catch (error) {
    if (!(error instanceof MssqlUrlError)) {
      throw error;
    }
    return {
      code: "database-url",
      message: `${subject} ${error.message}; no connection was made`,
      fix: error.ambiguous
        ? `percent-encode every @ in the user and password of ${subject} as %40`
        : `set ${subject} to mssql://facetdb_worker:<the worker password>@<host>:1433/<database>; a named instance (host\\instance) and an ADO.NET, ODBC, JDBC or Prisma key=value string are not read: give the instance's TCP port, and write the string as that URL`,
    };
  }
  const problem = tlsProblem(parsed, allowInsecure);
  if (problem === undefined) {
    return undefined;
  }
  return problem.kind === "plaintext"
    ? {
        code: "database-url-tls",
        message: `${subject} reaches ${problem.host} without TLS (encrypt=false), so the worker password would travel in the clear; no connection was made`,
        fix: `remove encrypt=false from ${subject}, or pass --allow-insecure if that network is trusted`,
      }
    : {
        code: "database-url-tls",
        message: `${subject} takes any certificate ${problem.host} shows (trustServerCertificate=true), so a machine in between could read the worker password; no connection was made`,
        fix: `remove trustServerCertificate=true from ${subject} and give the server a certificate this machine trusts, or pass --allow-insecure if that network is trusted`,
      };
}

/**
 * An error's message with every secret blanked out: a connection string and the password in it,
 * the worker password. Nothing a run returns ever carries one.
 */
export function withoutSecrets(message: string, secrets: readonly (string | undefined)[]): string {
  let plain = message;
  for (const secret of secrets) {
    if (secret === undefined || secret === "") {
      continue;
    }
    plain = plain.replaceAll(secret, "***");
    try {
      const { password } = parseMssqlUrl(secret);
      if (password !== "") {
        plain = plain.replaceAll(password, "***");
      }
    } catch {
      // Not a connection string: the whole value was already blanked.
    }
  }
  return plain;
}
