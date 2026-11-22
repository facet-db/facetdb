import type { DoctorCheck, EngineDeps, EngineTarget } from "@facetdb/core";
import type { SqliteClient } from "../connector/index.ts";
import {
  CAPTURE_LOOKS_AT,
  INSTALL_LOOKS_AT,
  installChecks,
  MARKS_LOOKS_AT,
  sqliteCheck,
} from "../engine/index.ts";
import { textOf } from "../install/index.ts";
import type { OpenLibsql } from "./client.ts";
import {
  connectionOf,
  type Environment,
  isRefusal,
  LIBSQL_TOKEN_VARIABLE,
  labelOf,
  subjectOf,
  tokenVariables,
} from "./server.ts";

/**
 * `facetdb doctor`'s checks of a libSQL source: the server answers, the auth token is read from the
 * environment and accepted, the SQLite under the server, the change capture (the jobs table, the
 * two triggers) and the install (the marker row, the columns), the marks of FacetDB's columns and
 * the one worker's lock. One query reaches the server for the first three; the capture, the
 * install, the marks and the lock are the file's checks, read through the same client. Nothing is
 * changed. No word holds the token or the URL.
 */

export const LIBSQL_DOCTOR_CHECKS: readonly { readonly name: string; readonly looksAt: string }[] =
  [
    {
      name: "server",
      looksAt:
        "checks that the URL names a libSQL server reached with TLS (or on this machine) and that it answers a query",
    },
    {
      name: "token",
      looksAt: `reads the auth token from the source's variable with _AUTH_TOKEN appended, else ${LIBSQL_TOKEN_VARIABLE}, and checks the server accepts it (a server on this machine may need none)`,
    },
    {
      name: "sqlite",
      looksAt: "reads the version of the SQLite the server runs (3.35 or later)",
    },
    { name: "capture", looksAt: CAPTURE_LOOKS_AT },
    { name: "install", looksAt: INSTALL_LOOKS_AT },
    { name: "marks", looksAt: MARKS_LOOKS_AT },
    {
      name: "lock",
      looksAt: "reads which worker holds the database's one worker lock, and when it renewed it",
    },
  ];

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });
const fail = (name: string, detail: string, fix: string): DoctorCheck => ({
  name,
  status: "fail",
  detail,
  fix,
});
const skip = (name: string, detail: string): DoctorCheck => ({ name, status: "skip", detail });

/** The checks after `from`, skipped for `why`. */
function skipped(from: string, why: string): readonly DoctorCheck[] {
  const at = LIBSQL_DOCTOR_CHECKS.findIndex((check) => check.name === from);
  return LIBSQL_DOCTOR_CHECKS.slice(at).map(({ name }) => skip(name, why));
}

/** The HTTP status a client error carries, along its causes (hrana's `HttpServerError.status`). */
function httpStatusOf(error: unknown): number | undefined {
  for (let at: unknown = error, depth = 0; at instanceof Error && depth < 5; depth += 1) {
    const status: unknown = Reflect.get(at, "status");
    if (typeof status === "number") {
      return status;
    }
    at = at.cause;
  }
  return undefined;
}

/** Whether the server turned the request away for its credentials. */
export function refusedCredentials(error: unknown): boolean {
  const status = httpStatusOf(error);
  if (status === 401 || status === 403) {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP status 40[13]\b|unauthori[sz]ed/i.test(message);
}

export async function libsqlDoctor(
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
  env: Environment,
  open: OpenLibsql,
): Promise<readonly DoctorCheck[]> {
  const subject = subjectOf(target);
  const [own = LIBSQL_TOKEN_VARIABLE] = tokenVariables(target);
  const connection = connectionOf(target, url, env, deps.allowInsecure);
  if (isRefusal(connection)) {
    if (connection.code === "libsql-auth-token" || connection.code === "libsql-token-in-url") {
      return [
        skip(
          "server",
          connection.code === "libsql-token-in-url"
            ? "not contacted: the URL carries an auth token, which FacetDB refuses to send from a connection string"
            : "not contacted: there is no auth token to send it",
        ),
        fail("token", connection.message, connection.fix),
        ...skipped("sqlite", "the server was not contacted"),
      ];
    }
    return [
      fail("server", connection.message, connection.fix),
      ...skipped("token", "the URL names no server FacetDB connects to"),
    ];
  }
  const { server, token } = connection;
  const unanswered = (error: unknown): readonly DoctorCheck[] => [
    {
      ...fail(
        "server",
        `the libSQL server at ${server.host} did not answer: ${error instanceof Error ? error.message : String(error)}`,
        `check that the server is running and that ${subject} names it`,
      ),
      unreachable: true,
    },
    ...skipped("token", "the server did not answer"),
  ];
  let client: SqliteClient;
  try {
    client = open({ url: server.url, ...(token === undefined ? {} : { authToken: token.value }) });
  } catch (error) {
    return unanswered(error);
  }
  try {
    let version: string;
    try {
      const [row] = await client.all("select sqlite_version() as v");
      version = textOf(row ?? {}, "v");
    } catch (error) {
      if (refusedCredentials(error)) {
        return [
          ok("server", `the libSQL server at ${server.host} answers`),
          fail(
            "token",
            token === undefined
              ? `the libSQL server at ${server.host} asks for an auth token, and ${tokenVariables(target).join(" and ")} ${tokenVariables(target).length === 1 ? "is" : "are"} unset`
              : `the libSQL server at ${server.host} refused the auth token from ${token.variable}`,
            `set ${token?.variable ?? own} to a token of this database (turso db tokens create <database> makes one)`,
          ),
          ...skipped("sqlite", "the server refused the token"),
        ];
      }
      return unanswered(error);
    }
    return [
      ok("server", `the libSQL server at ${server.host} answers`),
      ok(
        "token",
        token === undefined
          ? `no auth token: ${server.host} is on this machine, and the server asks for none`
          : `the server accepts the auth token from ${token.variable}`,
      ),
      sqliteCheck(version, "upgrade the libSQL server: sqld and Turso run a SQLite new enough"),
      ...(await installChecks(
        (sql, params) => client.all(sql, params),
        target,
        labelOf(server),
        deps.clock.now(),
      )),
    ];
  } finally {
    await client.close();
  }
}
