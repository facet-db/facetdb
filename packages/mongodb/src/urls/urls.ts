import type { EngineTarget, Refusal } from "@facetdb/core";

/**
 * How FacetDB reads a MongoDB connection string: the hosts it reaches, the database it names and
 * the TLS it asks for, split the way the driver splits it (mongodb-connection-string-url, the
 * mongodb package's own parser), so the check and the connection never read two different hosts. A
 * host other than this machine gets TLS: the driver is told `tls: true` when the string says
 * nothing, a `tls=false` (or `ssl=false`) there is refused unless the operator passed
 * `--allow-insecure`, and `mongodb+srv://` asks for TLS by itself.
 */

/** How the words name a source's connection string when no variable is known. */
export const SOURCE_URL = "the source's connection string";

/** The source's connection string as the words name it: its variable, else `SOURCE_URL`. */
export function subjectOf(target: Pick<EngineTarget, "urlVariable">): string {
  return target.urlVariable ?? SOURCE_URL;
}

/** The parts of a connection string FacetDB reads. */
export type ConnectionString = {
  /** `mongodb+srv://`: one DNS name the driver resolves, with TLS unless the string turns it off. */
  readonly srv: boolean;
  /** Each host as written, with its port; a Unix socket's path decoded (`/tmp/mongodb-27017.sock`). */
  readonly hosts: readonly string[];
  /** The database in the path, decoded; undefined when the path names none. */
  readonly database: string | undefined;
  /** The password, decoded, so an error's words can blank it out. */
  readonly password: string | undefined;
  /** What `tls` (or its alias `ssl`) says; undefined when the string has neither. */
  readonly tls: boolean | undefined;
};

/** The driver's split (mongodb-connection-string-url 7.0.2, `HOSTS_REGEX`): userinfo, hosts, the rest. */
const PARTS =
  /^(?<protocol>[^/]+):\/\/(?:(?<username>[^:@]*)(?::(?<password>[^@]*))?@)?(?<hosts>(?!:)[^/?@]*)(?<rest>.*)$/s;

/** What the driver refuses unescaped in a user or a password. */
const ILLEGAL_IN_USERINFO = /[:/?#[\]@]/;

const SCHEMES: ReadonlyMap<string, boolean> = new Map([
  ["mongodb", false],
  ["mongodb+srv", true],
]);

function decoded(text: string): string | undefined {
  try {
    return decodeURIComponent(text);
  } catch {
    return undefined;
  }
}

/** The string's `tls` and `ssl` values: false when any turns TLS off, true when one turns it on. */
function tlsOption(query: string): boolean | undefined {
  let tls: boolean | undefined;
  for (const [key, value] of new URLSearchParams(query)) {
    if (key.toLowerCase() !== "tls" && key.toLowerCase() !== "ssl") {
      continue;
    }
    if (value === "false") {
      return false;
    }
    tls = value === "true" ? true : tls;
  }
  return tls;
}

/** The connection string's parts, or undefined when the driver would not take it either. */
export function parseConnectionString(url: string): ConnectionString | undefined {
  const parts = PARTS.exec(url)?.groups;
  const srv = SCHEMES.get(parts?.["protocol"] ?? "");
  const hosts = parts?.["hosts"] ?? "";
  const rest = parts?.["rest"] ?? "";
  const username = parts?.["username"];
  const password = parts?.["password"];
  if (srv === undefined || hosts === "" || /^[^/?]*@/.test(rest)) {
    return undefined;
  }
  for (const part of [username, password]) {
    if (part !== undefined && (ILLEGAL_IN_USERINFO.test(part) || decoded(part) === undefined)) {
      return undefined;
    }
  }
  const [beforeFragment = ""] = rest.split("#");
  const query = beforeFragment.includes("?")
    ? beforeFragment.slice(beforeFragment.indexOf("?") + 1)
    : "";
  const path = beforeFragment.split("?")[0] ?? "";
  if (path !== "" && !path.startsWith("/")) {
    return undefined;
  }
  const database = path === "" || path === "/" ? undefined : decoded(path.slice(1));
  const written = hosts.split(",").map((host) => decoded(host));
  if (written.some((host) => host === undefined || host === "")) {
    return undefined;
  }
  return {
    srv,
    hosts: written.filter((host): host is string => host !== undefined),
    database,
    password: password === undefined ? undefined : decoded(password),
    tls: tlsOption(query),
  };
}

/** A host's name without its port: `[::1]` of `[::1]:27017`, `db.example.com` of `db.example.com:27017`. */
function hostname(host: string): string {
  if (host.startsWith("[")) {
    const end = host.indexOf("]");
    return end === -1 ? host : host.slice(0, end + 1);
  }
  return host.split(":")[0] ?? host;
}

/** A host is this machine when it is a loopback name or address, or a Unix socket's path. */
function onThisMachine(host: string): boolean {
  if (host.startsWith("/")) {
    return true;
  }
  const name = hostname(host).toLowerCase();
  return name === "localhost" || name === "[::1]" || /^127(\.\d{1,3}){3}$/.test(name);
}

/** What the TLS rule says of a connection string: refused as no string, refused as plaintext, or how to connect. */
export type TlsVerdict =
  | { readonly kind: "invalid" }
  | { readonly kind: "plaintext"; readonly host: string }
  | {
      readonly kind: "ok";
      /** Tell the driver `tls: true` beside the string: a host off this machine, and no TLS asked. */
      readonly forceTls: boolean;
    };

export function tlsVerdict(url: string, allowInsecure: boolean): TlsVerdict {
  const parsed = parseConnectionString(url);
  if (parsed === undefined) {
    return { kind: "invalid" };
  }
  const remote = parsed.hosts.find((host) => !onThisMachine(host));
  if (remote === undefined || parsed.tls === true) {
    return { kind: "ok", forceTls: false };
  }
  if (parsed.tls === false) {
    return allowInsecure
      ? { kind: "ok", forceTls: false }
      : { kind: "plaintext", host: hostname(remote) };
  }
  // Nothing said: `mongodb+srv://` turns TLS on by itself; a `mongodb://` host gets it from FacetDB.
  return { kind: "ok", forceTls: !parsed.srv };
}

const SHAPE =
  "mongodb://user:password@host/database (or mongodb+srv://user:password@host/database)";

const plaintextFix = (subject: string) =>
  `remove tls=false (and ssl=false) from ${subject}: FacetDB connects with TLS to any host but this machine; or pass --allow-insecure if that network is trusted`;

/** A connection string's problem and its fix, `subject` naming it, or undefined when it may be used. */
export function urlProblem(
  url: string,
  subject: string,
  allowInsecure: boolean,
): { readonly problem: string; readonly fix: string } | undefined {
  const verdict = tlsVerdict(url, allowInsecure);
  switch (verdict.kind) {
    case "ok":
      return undefined;
    case "invalid":
      return {
        problem: `${subject} is not a MongoDB connection string (${SHAPE})`,
        fix: `write ${subject} as ${SHAPE}, with any @, :, / or ? in the user or the password percent-encoded`,
      };
    case "plaintext":
      return {
        problem: `${subject} reaches ${verdict.host} with tls=false, so the password in it would travel in the clear`,
        fix: plaintextFix(subject),
      };
  }
}

/** The admin connection string's refusal, before anything connects: it plans and runs every script. */
export function adminUrlRefusal(url: string, allowInsecure: boolean): Refusal | undefined {
  const verdict = tlsVerdict(url, allowInsecure);
  switch (verdict.kind) {
    case "ok":
      return undefined;
    case "invalid":
      return {
        code: "admin-url",
        message: "the admin connection string is not a MongoDB connection string",
        fix: `pass ${SHAPE} as --admin-url, with any @, :, / or ? in the user or the password percent-encoded`,
      };
    case "plaintext":
      return {
        code: "admin-url-tls",
        message: `the admin connection string reaches ${verdict.host} with tls=false, so the admin password would travel in the clear; no connection was made`,
        fix: plaintextFix("the admin connection string"),
      };
  }
}

/** The database a connection string's path names, or undefined. */
export function databaseOf(url: string): string | undefined {
  return parseConnectionString(url)?.database;
}

/** Where a connection string points, without its user or password: what the words name. */
export function hostsOf(url: string): string {
  return parseConnectionString(url)?.hosts.join(",") ?? "the server";
}

/**
 * An error's message with every secret blanked out: a connection string and the password in it,
 * the worker's password. Nothing a plan or a run returns ever carries one.
 */
export function plainMessage(error: unknown, secrets: readonly (string | undefined)[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret === undefined || secret === "") {
      continue;
    }
    message = message.replaceAll(secret, "***");
    // A connection string's password, as written (percent-encoded) and as the server reads it.
    const written = PARTS.exec(secret)?.groups?.["password"];
    for (const password of [written, written === undefined ? undefined : decoded(written)]) {
      if (password !== undefined && password !== "") {
        message = message.replaceAll(password, "***");
      }
    }
  }
  return message;
}
