import type { Clock, DoctorCheck, EngineDeps, EngineTarget } from "@facetdb/core";
import {
  JOBS_TABLE,
  OWNED_MARK,
  OWNERS_TABLE,
  ownedColumns,
  readColumns,
  readFacetdbTables,
  readWorkerRights,
  WORKER_ACCOUNT,
  WORKER_USER,
  type WorkerRights,
} from "../install/index.ts";
import {
  type MysqlConnect,
  type MysqlQuery,
  plainMessage,
  quoteIdent,
  quoteTable,
  withClient,
  workerUrlRefusal,
} from "../sql/index.ts";

/**
 * `facetdb doctor`'s checks of a MySQL or MariaDB source, under the worker login, on one
 * connection, changing nothing: the connection (the login, TLS, the round trip), the server's
 * version, the install as the worker sees it (FacetDB's marked columns, the queue, the marker row's
 * project), the worker's grants, and the queue's depth. The triggers and their definer are the
 * admin's to check: `information_schema` lists a trigger only to an account with the `trigger`
 * privilege on its table, which the worker login never has, so `facetdb migrate --dry-run` with the
 * admin connection string is the trigger check (an empty plan means they are as installed). Where
 * no variable names the connection string, the words say "the source's connection string".
 */

/** The MySQL and MariaDB FacetDB needs. */
export const MINIMUM_MYSQL = [8, 0] as const;
export const MINIMUM_MARIADB = [10, 5] as const;

export const DOCTOR_CHECKS: readonly { readonly name: string; readonly looksAt: string }[] = [
  {
    name: "database",
    looksAt:
      "connects with the source's connection string, checks that it logs in as facetdb_worker and whether TLS is on, and times three round trips",
  },
  {
    name: "version",
    looksAt:
      "reads the server's version (MySQL 8.0 or MariaDB 10.5 at least), fails binary logging in STATEMENT format, and warns of binary logging without log_bin_trust_function_creators and of NO_BACKSLASH_ESCAPES in the sql_mode",
  },
  {
    name: "install",
    looksAt:
      "reads the catalog as the worker sees it for FacetDB's marked columns, the jobs table and the project's marker row",
  },
  {
    name: "grants",
    looksAt:
      "reads information_schema's privilege views for the worker's rights on the key, the state columns, FacetDB's columns and its two tables",
  },
  { name: "queue", looksAt: "counts the table's jobs waiting and claimed in facetdb_jobs" },
];

/** How many `select 1` round trips measure the link; the median of them is what doctor reports. */
const ROUND_TRIPS = 3;

/** Above this many milliseconds a round trip is a warning: the 1 second target assumes a near database. */
const FAR_MS = 100;

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });
const fail = (name: string, detail: string, fix: string): DoctorCheck => ({
  name,
  status: "fail",
  detail,
  fix,
});
const skip = (name: string, detail: string): DoctorCheck => ({ name, status: "skip", detail });
const warn = (name: string, detail: string): DoctorCheck => ({ name, status: "warn", detail });

/** The middle of three numbers, so a single slow or fast trip does not decide. */
function median(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** `8.4.3` at least `8.0`, part by part. */
export function atLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10));
  for (const [index, wanted] of minimum.entries()) {
    const part = parts[index] ?? 0;
    if (part !== wanted) {
      return part > wanted;
    }
  }
  return true;
}

/** `version()` as the server names itself: `MariaDB 10.6.20` from `10.6.20-MariaDB…`, else `MySQL 8.4.3`. */
export function serverName(version: string): {
  readonly engine: "MySQL" | "MariaDB";
  readonly number: string;
} {
  const number = /^\d+(?:\.\d+)*/.exec(version)?.[0] ?? version;
  return /mariadb/i.test(version) ? { engine: "MariaDB", number } : { engine: "MySQL", number };
}

/** Where a connection string points, without its user or password: what the words name. */
function databaseLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//, "");
    return name === "" ? parsed.host : `${parsed.host}/${name}`;
  } catch {
    return "the database";
  }
}

/** What the first connection learns, read at the boundary. */
type Session = {
  readonly login: string;
  readonly version: string;
  readonly database: string | undefined;
  readonly tls: string | undefined;
  readonly roundTripMs: number;
  readonly sqlMode: string;
  readonly binaryLogging: boolean;
  readonly trustCreators: boolean;
  /** `@@global.binlog_format`: `ROW`, `MIXED` or `STATEMENT`. */
  readonly binlogFormat: string;
};

async function readDoctorSession(query: MysqlQuery, clock: Clock): Promise<Session> {
  const [row] = await query(
    "select current_user() as login, version() as server_version, database() as current_database, @@session.sql_mode as sql_mode, @@global.log_bin as log_bin, @@global.log_bin_trust_function_creators as trust_creators, @@global.binlog_format as binlog_format",
  );
  const [cipher] = await query("show session status like 'Ssl_cipher'");
  const taken: number[] = [];
  for (let trip = 0; trip < ROUND_TRIPS; trip += 1) {
    const started = clock.now();
    await query("select 1");
    taken.push(clock.now() - started);
  }
  const [first = 0, second = 0, third = 0] = taken;
  const tls = cipher?.["Value"];
  return {
    login: String(row?.["login"] ?? ""),
    version: String(row?.["server_version"] ?? ""),
    database:
      row?.["current_database"] === null || row?.["current_database"] === undefined
        ? undefined
        : String(row["current_database"]),
    tls: typeof tls === "string" && tls !== "" ? tls : undefined,
    roundTripMs: Math.round(median(first, second, third)),
    sqlMode: String(row?.["sql_mode"] ?? ""),
    binaryLogging: Number(row?.["log_bin"] ?? 0) !== 0,
    trustCreators: Number(row?.["trust_creators"] ?? 0) !== 0,
    binlogFormat: String(row?.["binlog_format"] ?? "").toUpperCase(),
  };
}

/**
 * What the server's settings mean for FacetDB: a trigger needs SUPER to create under binary
 * logging without `log_bin_trust_function_creators` (error 1419; the next `facetdb migrate` that
 * creates one), and `NO_BACKSLASH_ESCAPES` in the server's mode, which the worker's own sessions
 * drop (`SESSION_STATEMENTS`) and install refuses: both worth knowing, never a failure of the
 * worker's. `binlog_format = STATEMENT` with binary logging on is one: InnoDB refuses every write
 * of a `read committed` session under it (error 1665), the level the worker's sessions run at.
 */
function settingsWarnings(session: Session): readonly DoctorCheck[] {
  return [
    ...(session.binaryLogging && !session.trustCreators
      ? [
          warn(
            "binlog",
            "binary logging is on and log_bin_trust_function_creators is off, so the next facetdb migrate that creates a trigger needs an admin with SUPER (error 1419 otherwise), as on RDS and Cloud SQL without the setting",
          ),
        ]
      : []),
    ...(session.binaryLogging && session.binlogFormat === "STATEMENT"
      ? [
          fail(
            "binlog",
            "binary logging is on with binlog_format = STATEMENT, under which InnoDB refuses the worker's writes in its read committed sessions (error 1665), so every claim, write and ack would fail",
            "set binlog_format to ROW or MIXED (MySQL 8's default is ROW), then run doctor again",
          ),
        ]
      : []),
    ...(session.sqlMode.split(",").includes("NO_BACKSLASH_ESCAPES")
      ? [
          warn(
            "sql-mode",
            "the server's sql_mode has NO_BACKSLASH_ESCAPES; the worker drops it in its own sessions, and facetdb migrate refuses to run until it is removed from the server's",
          ),
        ]
      : []),
  ];
}

function versionCheck(version: string): DoctorCheck {
  const named = serverName(version);
  const minimum = named.engine === "MariaDB" ? MINIMUM_MARIADB : MINIMUM_MYSQL;
  return atLeast(named.number, minimum)
    ? ok("version", `${named.engine} ${named.number}`)
    : fail(
        "version",
        `${named.engine} ${named.number} is older than ${minimum.join(".")}, the oldest FacetDB runs on`,
        `upgrade the server to ${named.engine} ${minimum.join(".")} or later`,
      );
}

/** The install as the worker sees it, and the queue's depth after it: the `install` and `queue` checks. */
async function installChecks(
  query: MysqlQuery,
  target: EngineTarget,
  schema: string,
  rights: WorkerRights,
): Promise<readonly [install: DoctorCheck, queue: DoctorCheck]> {
  const label = `${schema}.${target.table}`;
  const columns = await readColumns(query, schema, target.table);
  const owned = ownedColumns(target.questionSet);
  const byName = new Map(columns.map((column) => [column.name, column]));
  const missing = owned.filter((column) => !byName.has(column.name)).map((column) => column.name);
  const unmarked = owned
    .filter((column) => byName.get(column.name)?.comment === "")
    .map((column) => column.name);
  const tables = await readFacetdbTables(query, schema);
  const problems = [
    ...(columns.length === 0 ? [`the worker login sees no column of ${label}`] : []),
    ...(columns.length > 0 && missing.length > 0 ? [`${label} lacks ${missing.join(", ")}`] : []),
    ...(unmarked.length > 0
      ? [
          `${unmarked.join(", ")} of ${label} ${unmarked.length === 1 ? "is" : "are"} not marked ${OWNED_MARK}`,
        ]
      : []),
    ...(tables.jobs ? [] : [`${schema}.${JOBS_TABLE} is missing`]),
    ...(tables.owners ? [] : [`${schema}.${OWNERS_TABLE} is missing`]),
  ];
  let project: string | undefined;
  if (tables.owners && rights.tables.some((held) => held.table === OWNERS_TABLE)) {
    const [row] = await query(
      `select ${quoteIdent("project_id")} as project_id from ${quoteTable(schema, OWNERS_TABLE)} where ${quoteIdent("table_name")} = ?`,
      [target.table],
    );
    project = row === undefined ? undefined : String(row["project_id"]);
    if (project === undefined) {
      problems.push(`${OWNERS_TABLE} has no row for ${target.table}`);
    }
  }
  if (problems.length > 0) {
    return [
      fail(
        "install",
        `FacetDB is not installed on ${label}: ${problems.join("; ")}`,
        "run facetdb migrate",
      ),
      skip("queue", "nothing is installed to queue for"),
    ];
  }
  if (project !== undefined && project !== target.project.id) {
    return [
      fail(
        "install",
        `${label} belongs to another project (${project})`,
        "run doctor from that project's directory, or point the source at another table",
      ),
      skip("queue", "the table is another project's"),
    ];
  }
  const install = ok(
    "install",
    `${owned.length} marked columns on ${label}, the jobs table and the marker row of project ${target.project.id} are there; the triggers are checked by facetdb migrate --dry-run with the admin connection string, which plans nothing when they are as installed`,
  );
  if (!rights.tables.some((held) => held.table === JOBS_TABLE && held.privilege === "SELECT")) {
    return [install, skip("queue", "the worker login may not read the jobs table")];
  }
  const [row] = await query(
    `select count(*) as total, sum(${quoteIdent("claimed_at")} is not null) as claimed from ${quoteTable(schema, JOBS_TABLE)} where ${quoteIdent("table_name")} = ?`,
    [target.table],
  );
  const total = Number(row?.["total"] ?? 0);
  const claimed = Number(row?.["claimed"] ?? 0);
  const waiting = total - claimed;
  return [
    install,
    ok(
      "queue",
      `${waiting} ${waiting === 1 ? "job waits" : "jobs wait"} for ${target.table}, ${claimed} ${claimed === 1 ? "is" : "are"} claimed`,
    ),
  ];
}

/** The worker's grants against what install gives: never more is checked here, only what is missing. */
function grantsCheck(
  target: EngineTarget,
  schema: string,
  key: string,
  rights: WorkerRights,
): DoctorCheck {
  const owned = ownedColumns(target.questionSet).map((column) => column.name);
  const holds = (table: string, privilege: string, column?: string) =>
    column === undefined
      ? rights.tables.some((held) => held.table === table && held.privilege === privilege)
      : rights.columns.some(
          (held) => held.table === table && held.column === column && held.privilege === privilege,
        );
  const select = [key, ...target.questionSet.read.filter((column) => column !== key), ...owned];
  const missing = [
    ...select
      .filter((column) => !holds(target.table, "SELECT", column))
      .map((column) => `select on ${column}`),
    ...owned
      .filter((column) => !holds(target.table, "UPDATE", column))
      .map((column) => `update on ${column}`),
    ...["SELECT", "INSERT", "UPDATE", "DELETE"]
      .filter((privilege) => !holds(JOBS_TABLE, privilege))
      .map((privilege) => `${privilege.toLowerCase()} on ${JOBS_TABLE}`),
    ...(holds(OWNERS_TABLE, "SELECT") ? [] : [`select on ${OWNERS_TABLE}`]),
  ];
  return missing.length === 0
    ? ok(
        "grants",
        `${WORKER_ACCOUNT} selects the key, the ${target.questionSet.read.length} state columns and FacetDB's columns of ${schema}.${target.table}, updates FacetDB's columns only, and has its rights on ${JOBS_TABLE} and ${OWNERS_TABLE}`,
      )
    : fail(
        "grants",
        `${WORKER_ACCOUNT} lacks ${missing.join(", ")}`,
        "run facetdb migrate: it grants what is missing and nothing more",
      );
}

/** The table's single-column primary key as the worker sees it, or undefined. */
async function keyOf(
  query: MysqlQuery,
  schema: string,
  table: string,
): Promise<string | undefined> {
  const rows = await query(
    "select column_name as name from information_schema.key_column_usage where table_schema = ? and table_name = ? and constraint_name = 'PRIMARY' order by ordinal_position",
    [schema, table],
  );
  const [only] = rows;
  return only === undefined || rows.length > 1 ? undefined : String(only["name"]);
}

/**
 * Every check of the source in order, never throwing: what goes wrong inside one is its failure.
 * A check an earlier failure left nothing to look at is skipped.
 */
export async function doctorChecks(
  connect: MysqlConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<readonly DoctorCheck[]> {
  const subject = target.urlVariable ?? "the source's connection string";
  const skipped = (from: number): DoctorCheck[] =>
    DOCTOR_CHECKS.slice(from).map(({ name }) =>
      skip(name, "not checked: the database check did not pass"),
    );
  const refused = workerUrlRefusal(url, deps.allowInsecure, subject);
  if (refused !== undefined) {
    return [fail("database", `"${target.source}": ${refused.message}`, refused.fix), ...skipped(1)];
  }
  try {
    return await withClient(connect, url, async (query) => {
      const session = await readDoctorSession(query, deps.clock);
      const user = session.login.split("@")[0] ?? session.login;
      const where = databaseLabel(url);
      const checks: DoctorCheck[] = [];
      if (user !== WORKER_USER) {
        checks.push(
          fail(
            "database",
            `"${target.source}": ${subject} logs in to ${where} as ${session.login}, not ${WORKER_USER}`,
            `set ${subject} to the worker login: mysql://${WORKER_USER}:<the worker password>@<host>:3306/<database>`,
          ),
          ...skipped(1),
        );
        return checks;
      }
      checks.push(
        ok(
          "database",
          `"${target.source}": connected to ${where} as ${session.login} ${session.tls === undefined ? "without TLS" : `over TLS (${session.tls})`}, ${session.roundTripMs} ms per round trip`,
        ),
      );
      if (session.roundTripMs > FAR_MS) {
        checks.push(
          warn(
            "distance",
            `${where} is ${session.roundTripMs} ms away; the 1 second target assumes a database within ${FAR_MS} ms`,
          ),
        );
      }
      checks.push(versionCheck(session.version), ...settingsWarnings(session));
      const schema = target.schema ?? session.database;
      if (schema === undefined) {
        checks.push(
          fail(
            "install",
            `${subject} names no database, and the source names no database for the table ${target.table}`,
            `add the database to ${subject}, or name the table as <database>.${target.table} in the config`,
          ),
          skip("grants", "no database to look in"),
          skip("queue", "no database to look in"),
        );
        return checks;
      }
      const rights = await readWorkerRights(query, schema);
      const [install, queue] = await installChecks(query, target, schema, rights);
      const key = await keyOf(query, schema, target.table);
      const grants =
        key === undefined
          ? fail(
              "grants",
              `${schema}.${target.table} has no single-column primary key the worker login can see`,
              "run facetdb migrate: it refuses a table without one, and says what to change",
            )
          : grantsCheck(target, schema, key, rights);
      checks.push(install, grants, queue);
      return checks;
    });
  } catch (error) {
    return [
      fail(
        "database",
        `"${target.source}": ${databaseLabel(url)} could not be reached as the worker login: ${plainMessage(error, [url])}`,
        `check the host, port, database and worker password in ${subject}, and that the server lets this machine connect`,
      ),
      ...skipped(1),
    ];
  }
}
