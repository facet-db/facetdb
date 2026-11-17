import type { EngineTarget, Refusal } from "@facetdb/core";

/**
 * Where a libSQL source's connection string points and how FacetDB authenticates to it. Nothing
 * here connects.
 *
 * - The URL is `libsql://` (TLS unless `?tls=0`), `https://` or `http://`, as @libsql/client reads
 *   it; the CLI routes `libsql:`, and `https:` or `http:` with `turso.io` or `libsql` in the host,
 *   here (cli/engines.ts). A plaintext URL (`http://`, `libsql://…?tls=0`) to another machine is
 *   refused unless `--allow-insecure`: the auth token would travel in the clear.
 * - The auth token comes from the environment only, never from the config or the URL: the variable
 *   the source's connection string is read from with `_AUTH_TOKEN` appended (`LISTINGS_URL` gives
 *   `LISTINGS_URL_AUTH_TOKEN`), else `LIBSQL_AUTH_TOKEN`. An `authToken` parameter in the URL is
 *   refused, so a token never sits in a string that may be printed, logged or kept in a config. A
 *   server on this machine (the test server, a local sqld) may run without one.
 * - The words name the server by its host, never by its URL (cli/engines.ts: "the words never echo
 *   a connection string"), and never hold the token.
 */

/** The variable read when the source's own `<variable>_AUTH_TOKEN` is unset. */
export const LIBSQL_TOKEN_VARIABLE = "LIBSQL_AUTH_TOKEN";

/** What `<variable>` gets appended to name the source's own token variable. */
export const TOKEN_SUFFIX = "_AUTH_TOKEN";

/** Where the variables are read: `process.env` in the CLI, a test's own record otherwise. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** A libSQL server's URL as FacetDB reads it before anything connects. */
export type LibsqlServer = {
  /** The URL as given, handed to @libsql/client and never printed. */
  readonly url: string;
  /** The host the words name it by, with its port when the URL has one. */
  readonly host: string;
  /** Whether the client would speak to it without TLS (`http:`, `libsql:` with `?tls=0`). */
  readonly plaintext: boolean;
  /** Whether it is on this machine, where nothing travels over a network. */
  readonly loopback: boolean;
};

/** What every call of the engine connects with, once the URL and the token passed the rules. */
export type LibsqlConnection = {
  readonly server: LibsqlServer;
  /** The token and the variable it came from; absent for a loopback server run without one. */
  readonly token?: { readonly variable: string; readonly value: string };
};

const SCHEMES: ReadonlySet<string> = new Set(["libsql:", "https:", "http:"]);

/**
 * Loopback names and addresses (as `URL` writes them): nothing sent to one leaves this machine.
 * `localhost` exactly, 127.0.0.0/8 and ::1; a `*.localhost` name is not among them, since a
 * resolver without special handling for it may send it off the machine.
 */
function isLoopback(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

/** The local sqld form the words suggest: the CLI routes `libsql:`, not a plain loopback `http:`. */
const LOCAL_SQLD = "libsql://127.0.0.1:8080?tls=0";

/** How the words name the source's connection string: its variable, as the CLI read it. */
export function subjectOf(target: EngineTarget): string {
  return target.urlVariable ?? "the source's connection string";
}

/** The variables the token is read from, in order: the source's own, then `LIBSQL_AUTH_TOKEN`. */
export function tokenVariables(target: EngineTarget): readonly string[] {
  return target.urlVariable === undefined
    ? [LIBSQL_TOKEN_VARIABLE]
    : [`${target.urlVariable}${TOKEN_SUFFIX}`, LIBSQL_TOKEN_VARIABLE];
}

/**
 * The URL's server, or a reason it names none; nothing in the result echoes the URL.
 *
 * The client is handed `href`, the URL exactly as it was judged here, never the raw string: the
 * URL standard reads a backslash in `http:` as a slash where libSQL's own parser does not, so the
 * raw `http://127.0.0.1\@elsewhere:8080` would be judged loopback here and reach `elsewhere` there.
 * A parameter given twice is refused: the client reads every pair and the last one wins, so
 * `?tls=1&tls=0` would pass the TLS rule on its first value and connect in the clear on its last.
 */
function serverOf(
  url: string,
):
  | LibsqlServer
  | { readonly invalid: true }
  | { readonly tokenInUrl: true }
  | { readonly repeated: string } {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { invalid: true };
  }
  if (!SCHEMES.has(parsed.protocol) || parsed.hostname === "") {
    return { invalid: true };
  }
  if (parsed.searchParams.has("authToken")) {
    return { tokenInUrl: true };
  }
  const keys = [...parsed.searchParams.keys()];
  const repeated = keys.find((key, index) => keys.indexOf(key) !== index);
  if (repeated !== undefined) {
    return { repeated };
  }
  const plaintext =
    parsed.protocol === "http:" ||
    (parsed.protocol === "libsql:" && parsed.searchParams.get("tls") === "0");
  return {
    url: parsed.href,
    host: parsed.host,
    plaintext,
    loopback: isLoopback(parsed.hostname),
  };
}

/**
 * The URL and the token every call connects with, or the refusal it is turned away with before it
 * connects: a string that names no libSQL server, a token in the URL, a plaintext URL to another
 * machine without `--allow-insecure`, or no token for a server that is not on this machine.
 */
export function connectionOf(
  target: EngineTarget,
  url: string,
  env: Environment,
  allowInsecure: boolean,
): LibsqlConnection | Refusal {
  const subject = subjectOf(target);
  const variables = tokenVariables(target);
  const [own = LIBSQL_TOKEN_VARIABLE] = variables;
  const server = serverOf(url);
  if ("invalid" in server) {
    return {
      code: "libsql-url",
      message: `${subject} names no libSQL server (libsql://, https:// or http://, with a host); no connection was made`,
      fix: `set ${subject} to the database's URL, such as libsql://<database>-<organization>.turso.io (turso db show --url <database> prints it), or ${LOCAL_SQLD} for sqld on this machine`,
    };
  }
  if ("repeated" in server) {
    return {
      code: "libsql-url",
      message: `${subject} gives the ${server.repeated} parameter more than once; the libSQL client would read the last one, so FacetDB judges no such URL; no connection was made`,
      fix: `keep one ${server.repeated} parameter in ${subject}`,
    };
  }
  if ("tokenInUrl" in server) {
    return {
      code: "libsql-token-in-url",
      message: `${subject} carries an authToken parameter; FacetDB reads a libSQL auth token from the environment only, so it never sits in a connection string that may be printed or logged; no connection was made`,
      fix: `remove the authToken parameter from ${subject}, and set ${own} to the token instead`,
    };
  }
  if (server.plaintext && !server.loopback && !allowInsecure) {
    return {
      code: "database-url-tls",
      message: `${subject} reaches ${server.host} without TLS (http://, or libsql:// with ?tls=0), so the auth token would travel in the clear; no connection was made`,
      fix: `use libsql:// or https:// in ${subject}, or pass --allow-insecure if that network is trusted`,
    };
  }
  for (const variable of variables) {
    const value = env[variable];
    if (value !== undefined && value !== "") {
      return { server, token: { variable, value } };
    }
  }
  if (server.loopback) {
    return { server };
  }
  return {
    code: "libsql-auth-token",
    message: `no auth token for the libSQL server at ${server.host}: ${variables.join(" and ")} ${variables.length === 1 ? "is" : "are"} unset; no connection was made`,
    fix: `set ${own} to the database's auth token (turso db tokens create <database> makes one); FacetDB reads it from the environment only, never from the config or the URL`,
  };
}

/** Whether `connectionOf` refused. */
export function isRefusal(value: LibsqlConnection | Refusal): value is Refusal {
  return "code" in value;
}

/** How the words name a server's database: by its host, never its URL. */
export function labelOf(server: LibsqlServer): string {
  return `the libSQL database at ${server.host}`;
}
