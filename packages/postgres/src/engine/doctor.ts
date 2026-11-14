import {
  type Clock,
  type DoctorCheck,
  type EngineDeps,
  type EngineTarget,
  HEARTBEAT_LOSS_MS,
} from "@facetdb/core";
import { installOwnedColumns, triggerName, WORKER_ROLE } from "../install/index.ts";
import { SIDE_TABLE_SCHEMA, sideTableName } from "../scan/index.ts";
import type { SqlConnect, SqlQuery } from "../sql/index.ts";
import { databaseLabel, plainMessage, SOURCE_URL, urlProblem } from "./urls.ts";

/**
 * `facetdb doctor`'s checks of one table source, moved here from the
 * CLI's doctor.ts with the same names, details, fixes and statuses: the connection, the
 * login and the round trip (with the distance as a warning of its own), the pooler, the install
 * in the catalog, and the worker's heartbeat. Nothing is changed. Where the CLI names the variable
 * that holds the URL, these words say `SOURCE_URL`: the engine is not told the variable.
 */

/** The checks, in order, and what each looks at: what `doctor --dry-run` lists today. */
export const DOCTOR_CHECKS: readonly { readonly name: string; readonly looksAt: string }[] = [
  {
    name: "database",
    looksAt:
      "connects to each table source with its own connection string, checks the login, and times three round trips",
  },
  {
    name: "pooler",
    looksAt:
      "runs one prepared statement twice on each connection the worker opens, to find a transaction-mode pooler",
  },
  {
    name: "install",
    looksAt:
      "reads the catalog for the facetdb schema, the jobs table, the trigger and the answer columns",
  },
  { name: "worker", looksAt: "reads the worker's last heartbeat from the FacetDB store" },
];

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });
const fail = (name: string, detail: string, fix: string): DoctorCheck => ({
  name,
  status: "fail",
  detail,
  fix,
});

const WORKER_URL_SHAPE = `postgres://${WORKER_ROLE}:<a long random password>@<host>/<database>`;

/** How many `select 1` round trips measure the link; the median of them is what doctor reports. */
const ROUND_TRIPS = 3;

/** Above this many milliseconds a round trip is a warning: the 1 second target assumes a near database. */
const FAR_MS = 100;

/** The middle of three numbers, so a single slow or fast trip does not decide. */
function median(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** Times three `select 1` round trips with the given clock and returns the median, in ms. */
async function roundTripMs(clock: Clock, query: SqlQuery): Promise<number> {
  const taken: number[] = [];
  for (let trip = 0; trip < ROUND_TRIPS; trip += 1) {
    const started = clock.now();
    await query("select 1");
    taken.push(clock.now() - started);
  }
  const [first = 0, second = 0, third = 0] = taken;
  return Math.round(median(first, second, third));
}

/** Opens a connection, runs `work` and closes it, whatever happens. */
async function withConnection<T>(
  connect: SqlConnect,
  url: string,
  work: (query: SqlQuery) => Promise<T>,
): Promise<T> {
  const client = connect(url);
  try {
    return await work(client.query);
  } finally {
    await client.close();
  }
}

/** `facetdb_worker`, or `facetdb_worker.<suffix>`: a connection pooler routes by the user (Supabase). */
const WORKER_LOGIN = new RegExp(`^${WORKER_ROLE}(?:\\.([A-Za-z0-9_-]+))?$`);

/** The pooler suffix of the worker login a URL names, when it names one. */
function poolerSuffix(url: string): string | undefined {
  let username: string;
  try {
    username = decodeURIComponent(new URL(url).username);
  } catch {
    return undefined;
  }
  return WORKER_LOGIN.exec(username)?.[1];
}

/** The database check, and the distance worth a warning line of its own. */
async function databaseCheck(
  connect: SqlConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
  pgHost: string | undefined,
): Promise<{ readonly check: DoctorCheck; readonly warning?: string }> {
  const insecure = urlProblem(url, SOURCE_URL, deps.allowInsecure, pgHost);
  if (insecure !== undefined) {
    return { check: fail("database", `"${target.source}": ${insecure.problem}`, insecure.fix) };
  }
  try {
    const { login, milliseconds } = await withConnection(connect, url, async (query) => {
      const rows = await query("select current_user::text as name");
      return {
        login: String(rows[0]?.["name"]),
        milliseconds: await roundTripMs(deps.clock, query),
      };
    });
    if (login !== WORKER_ROLE) {
      return {
        check: fail(
          "database",
          `"${target.source}" logs in as ${login} on ${databaseLabel(url)}, not as the worker login ${WORKER_ROLE}`,
          `set ${SOURCE_URL} to ${WORKER_URL_SHAPE}; facetdb migrate creates that login with the password in it, and it is the only login the worker needs`,
        ),
      };
    }
    const suffix = poolerSuffix(url);
    return {
      check: ok(
        "database",
        `logged in as ${WORKER_ROLE}${suffix === undefined ? "" : ` (through a pooler as ${WORKER_ROLE}.${suffix})`}: ${target.source} on ${databaseLabel(url)} (round trip ${milliseconds} ms)`,
      ),
      ...(milliseconds > FAR_MS
        ? {
            warning: `the database is ${milliseconds} ms away; run the worker next to it, the 1 second target assumes a same-region link`,
          }
        : {}),
    };
  } catch (error) {
    return {
      check: fail(
        "database",
        `"${target.source}" cannot connect to ${databaseLabel(url)}: ${plainMessage(error, [url])}`,
        `check the host, port, user and password in ${SOURCE_URL}, and that the database accepts connections from this machine (a firewall or an allow-list)`,
      ),
    };
  }
}

/** A statement with a parameter, so the driver prepares it under a name, as it does the worker's. */
const POOLER_PROBE = "select pg_backend_pid() as pid, $1::int as run";

/** The server's error code, read off the driver's error (a boundary). */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Supabase serves transaction mode on port 6543: Supavisor on its pooler hosts
 * (`*.pooler.supabase.com`, session mode on 5432) and the dedicated PgBouncer beside the database
 * (`db.<project ref>.supabase.co`, the database itself on 5432).
 */
function supabaseTransactionPort(url: string): boolean {
  try {
    const { port, hostname } = new URL(url);
    return (
      port === "6543" &&
      (hostname.endsWith(".pooler.supabase.com") || /^db\.[^.]+\.supabase\.co$/.test(hostname))
    );
  } catch {
    return false;
  }
}

/**
 * Why a connection cannot keep the worker's prepared statements, or undefined when it can: one
 * prepared statement run twice on one client connection (`max: 1`) either finds itself gone
 * (SQLSTATE 26000) or runs in two server sessions behind a transaction-mode pooler.
 */
async function transactionPooler(connect: SqlConnect, url: string): Promise<string | undefined> {
  if (supabaseTransactionPort(url)) {
    return "port 6543 of a Supabase host is its transaction-mode pooler";
  }
  const client = connect(url, { max: 1 });
  try {
    const first = await client.query(POOLER_PROBE, [1]);
    const second = await client.query(POOLER_PROBE, [2]);
    return first[0]?.["pid"] === second[0]?.["pid"]
      ? undefined
      : "one prepared statement ran in two server sessions on one connection";
  } catch (error) {
    if (sqlState(error) === "26000") {
      return "a prepared statement was gone on its second run (SQLSTATE 26000, prepared statement does not exist)";
    }
    throw error;
  } finally {
    await client.close();
  }
}

const POOLER_FIX = `use the session pooler (port 5432) or a direct connection in ${SOURCE_URL}; the worker prepares each statement once per connection`;

async function poolerCheck(
  connect: SqlConnect,
  target: EngineTarget,
  url: string,
): Promise<DoctorCheck> {
  const where = `"${target.source}" on ${databaseLabel(url)}`;
  try {
    const why = await transactionPooler(connect, url);
    return why === undefined
      ? ok(
          "pooler",
          `prepared statements stay on one server session on "${target.source}" (a direct connection or a session pooler)`,
        )
      : fail(
          "pooler",
          `${where}: the database is behind a transaction-mode pooler (Supabase port 6543, PgBouncer transaction mode): ${why}`,
          POOLER_FIX,
        );
  } catch (error) {
    return fail(
      "pooler",
      `${where}: a prepared statement could not be run: ${plainMessage(error, [url])}`,
      POOLER_FIX,
    );
  }
}

const TABLE_FACTS = `select
  to_regnamespace('facetdb') is not null as schema_present,
  to_regclass('facetdb.jobs') is not null as jobs_present,
  to_regclass(format('%I.%I', $1::text, $2::text)) is not null as table_present`;

const TRIGGER_FACTS = `select t.tgenabled::text as enabled,
  coalesce((select string_agg(a.attname::text, ',' order by a.attname)
              from pg_catalog.pg_attribute a
             where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr)), '') as columns
  from pg_catalog.pg_trigger t
 where t.tgrelid = to_regclass(format('%I.%I', $1::text, $2::text))
   and t.tgname = $3 and not t.tgisinternal`;

const COLUMNS_OF = `select a.attname::text as name
  from pg_catalog.pg_attribute a
 where a.attrelid = to_regclass(format('%I.%I', $1::text, $2::text))
   and a.attnum > 0 and not a.attisdropped`;

const REINSTALL = "run facetdb migrate: it prints the SQL first and installs what is missing";

/** What the source's install is missing, as plain sentences (empty when it is whole). */
async function installProblems(query: SqlQuery, target: EngineTarget): Promise<readonly string[]> {
  const schema = target.schema ?? "public";
  const { table } = target;
  const label = `${schema}.${table}`;
  const facts = (await query(TABLE_FACTS, [schema, table]))[0];
  const missing: string[] = [];
  if (facts?.["schema_present"] !== true) {
    missing.push("the facetdb schema does not exist");
  } else if (facts["jobs_present"] !== true) {
    missing.push("the jobs table facetdb.jobs does not exist");
  }
  if (facts?.["table_present"] !== true) {
    missing.push(`the table ${label} does not exist`);
    return missing;
  }
  const trigger = triggerName({ table });
  const found = (await query(TRIGGER_FACTS, [schema, table, trigger]))[0];
  if (found === undefined) {
    missing.push(`${label} has no trigger ${trigger}, so changes are not queued`);
  } else {
    if (found["enabled"] === "D") {
      missing.push(`the trigger ${trigger} on ${label} is disabled`);
    }
    const expected = [...target.questionSet.read].sort().join(",");
    const watched = String(found["columns"]);
    if (watched !== expected) {
      missing.push(
        `the trigger on ${label} watches ${watched === "" ? "no columns" : watched}, not the columns the questions read (${expected})`,
      );
    }
  }
  const [answerSchema, answerTable] =
    target.storage === "side-table" ? [SIDE_TABLE_SCHEMA, sideTableName(table)] : [schema, table];
  const present = new Set(
    (await query(COLUMNS_OF, [answerSchema, answerTable])).map((row) => String(row["name"])),
  );
  const absent = installOwnedColumns(target.questionSet).filter((name) => !present.has(name));
  if (absent.length > 0) {
    missing.push(`${answerSchema}.${answerTable} lacks the answer columns ${absent.join(", ")}`);
  }
  return missing;
}

async function installCheck(
  connect: SqlConnect,
  target: EngineTarget,
  url: string,
): Promise<DoctorCheck> {
  let problems: readonly string[];
  try {
    problems = await withConnection(connect, url, (query) => installProblems(query, target));
  } catch (error) {
    problems = [`the catalog could not be read as ${WORKER_ROLE}: ${plainMessage(error, [url])}`];
  }
  return problems.length === 0
    ? ok("install", "facetdb schema, jobs table, trigger and answer columns are in place")
    : fail(
        "install",
        problems.map((problem) => `${target.source}: ${problem}`).join("; "),
        REINSTALL,
      );
}

const DATABASE_URL_FIX =
  "set DATABASE_URL to the connection string of the database FacetDB keeps its store in";

function ageOf(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 120) {
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

/**
 * The worker has reported within the last two minutes. Its heartbeat is in the
 * FacetDB store (`DATABASE_URL`): read here only when the store is this
 * source's database; otherwise the CLI's store door checks it.
 */
async function heartbeatCheck(
  connect: SqlConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
  pgHost: string | undefined,
): Promise<DoctorCheck> {
  if (!deps.storeShared) {
    return {
      name: "worker",
      status: "skip",
      detail: "not checked here: the worker's heartbeat is in the FacetDB store, another database",
    };
  }
  const insecure = urlProblem(url, "DATABASE_URL", deps.allowInsecure, pgHost);
  if (insecure !== undefined) {
    return fail("worker", insecure.problem, insecure.fix);
  }
  let last: number | undefined;
  try {
    // One plain select: opening the store would create its schema, which a check never does.
    const rows = await withConnection(connect, url, (query) =>
      query("select at::text as at from facetdb.heartbeats where project = $1", [
        target.project.id,
      ]),
    );
    const at = rows[0]?.["at"];
    last = at === undefined ? undefined : Number(at);
  } catch (error) {
    const message = plainMessage(error, [url]);
    if (/permission denied/i.test(message)) {
      return fail(
        "worker",
        `the login in DATABASE_URL may not read the store's heartbeats: ${message}`,
        "grant select on facetdb.heartbeats to the login in DATABASE_URL, or point DATABASE_URL at a login that can read it",
      );
    }
    if (/does not exist/i.test(message)) {
      return fail(
        "worker",
        `the store has no heartbeats table yet: ${message}`,
        "run facetdb migrate with the admin credential: it installs the store's tables, and the worker only uses them",
      );
    }
    return fail("worker", `the store could not be read: ${message}`, DATABASE_URL_FIX);
  }
  if (last === undefined) {
    return fail(
      "worker",
      "the worker has never sent a heartbeat for this project",
      "start it with facetdb worker, and leave it running",
    );
  }
  const age = deps.clock.now() - last;
  return age >= HEARTBEAT_LOSS_MS
    ? fail(
        "worker",
        `the last heartbeat was ${ageOf(age)} ago, and a worker counts as down after 2 minutes`,
        "start the worker with facetdb worker, or restart it, and read its log for why it stopped",
      )
    : ok("worker", `the last heartbeat was ${ageOf(age)} ago`);
}

/**
 * Every check of the source in order, never throwing: what goes wrong inside one is its failure.
 * A check an earlier failure left nothing to look at is skipped, as the CLI skips it today.
 */
export async function doctorChecks(
  connect: SqlConnect,
  pgHost: string | undefined,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<readonly DoctorCheck[]> {
  const database = await databaseCheck(connect, target, url, deps, pgHost);
  const reached = database.check.status === "ok";
  const skipped = (name: string): DoctorCheck => ({
    name,
    status: "skip",
    detail: "not checked: the database check did not pass",
  });
  return [
    database.check,
    ...(database.warning === undefined
      ? []
      : [{ name: "distance", status: "warn", detail: database.warning } satisfies DoctorCheck]),
    reached ? await poolerCheck(connect, target, url) : skipped("pooler"),
    reached ? await installCheck(connect, target, url) : skipped("install"),
    await heartbeatCheck(connect, target, url, deps, pgHost),
  ];
}
