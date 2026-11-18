import type { Clock, DoctorCheck, EngineDeps, EngineTarget } from "@facetdb/core";
import type { PollingConnect, PollingQuery, PoolerRule, SqlDialect } from "../dialect/index.ts";
import { labelOf, ownedColumnNames, readTable } from "../install/index.ts";
import { hourlyScan, keyProblem, pollingWords, unreadColumn } from "./plans.ts";
import { databaseLabel, plainMessage, subjectOf, urlProblem } from "./urls.ts";

/**
 * `facetdb doctor`'s checks of a polling source, under the names and in the words of the Postgres
 * trigger engine's where the two check the same thing: the connection, the login and the round trip
 * (with the distance as a warning of its own), the pooler where the dialect's driver prepares
 * statements, and the install in the catalog, which says the source polls ("polls every 10 seconds
 * by updated_at; no trigger", or "reads whole every hour") and, on a polling line of its own, warns
 * when the table has no column to poll by and the config did not choose the hourly scan
 * (`lastChanged: false`), or fails when the column the config's `lastChanged` names cannot be
 * polled by. The worker's heartbeat is in the store, which the CLI's store door checks. Nothing is
 * changed.
 */

/** The checks, in order, and what each looks at: what `doctor --dry-run` lists. */
export function doctorChecksOf(
  dialect: SqlDialect,
): readonly { readonly name: string; readonly looksAt: string }[] {
  return [
    {
      name: "database",
      looksAt:
        "connects to each table source with its own connection string, checks the login, and times three round trips",
    },
    ...(dialect.pooler === undefined
      ? []
      : [
          {
            name: "pooler",
            looksAt:
              "runs one prepared statement twice on each connection the worker opens, to find a transaction-mode pooler",
          },
        ]),
    {
      name: "install",
      looksAt:
        "reads the catalog for the answer columns, facetdb_state_hash, the project's mark and the column FacetDB polls by",
    },
    { name: "worker", looksAt: "reads the worker's last heartbeat from the FacetDB store" },
  ];
}

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });
const fail = (name: string, detail: string, fix: string): DoctorCheck => ({
  name,
  status: "fail",
  detail,
  fix,
});

/** How many round trips measure the link; the median of them is what doctor reports. */
const ROUND_TRIPS = 3;

/** Above this many milliseconds a round trip is a warning: the 1 second target assumes a near database. */
const FAR_MS = 100;

/** The middle of three numbers, so a single slow or fast trip does not decide. */
function median(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** Times three round trips with the given clock and returns the median, in ms. */
async function roundTripMs(clock: Clock, query: PollingQuery, ping: string): Promise<number> {
  const taken: number[] = [];
  for (let trip = 0; trip < ROUND_TRIPS; trip += 1) {
    const started = clock.now();
    await query(ping);
    taken.push(clock.now() - started);
  }
  const [first = 0, second = 0, third = 0] = taken;
  return Math.round(median(first, second, third));
}

/** Opens a connection, runs `work` and closes it, whatever happens. */
async function withConnection<T>(
  connect: PollingConnect,
  url: string,
  work: (query: PollingQuery) => Promise<T>,
): Promise<T> {
  const client = connect(url);
  try {
    return await work(client.query);
  } finally {
    await client.close();
  }
}

/** The database check, and the distance worth a warning line of its own. */
async function databaseCheck(
  dialect: SqlDialect,
  connect: PollingConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<{ readonly check: DoctorCheck; readonly warning?: string }> {
  const subject = subjectOf(target);
  const refused = urlProblem(dialect, url, subject, deps.allowInsecure);
  if (refused !== undefined) {
    return { check: fail("database", `"${target.source}": ${refused.problem}`, refused.fix) };
  }
  const { login } = dialect;
  try {
    const { name, milliseconds } = await withConnection(connect, url, async (query) => ({
      name: login === undefined ? undefined : String((await query(login.whoami))[0]?.["name"]),
      milliseconds: await roundTripMs(deps.clock, query, dialect.ping),
    }));
    if (login !== undefined && name !== login.name) {
      return {
        check: fail(
          "database",
          `"${target.source}" logs in as ${name} on ${databaseLabel(url)}, not as the worker login ${login.name}`,
          `set ${subject} to ${login.urlShape}; facetdb migrate creates that login with the password in it, and it is the only login the worker needs`,
        ),
      };
    }
    return {
      check: ok(
        "database",
        `${login === undefined ? "connected" : `logged in as ${login.name}`}: ${target.source} on ${databaseLabel(url)} (round trip ${milliseconds} ms)`,
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
        `check the host, port, user and password in ${subject}, and that the database accepts connections from this machine (a firewall or an allow-list)`,
      ),
    };
  }
}

/** The server's error code, read off the driver's error (a boundary). */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Why a connection cannot keep the worker's prepared statements, or undefined when it can: one
 * prepared statement run twice on one client connection either finds itself gone or runs in two
 * server sessions behind a transaction-mode pooler.
 */
async function transactionPooler(
  pooler: PoolerRule,
  connect: PollingConnect,
  url: string,
): Promise<string | undefined> {
  const known = pooler.known(url);
  if (known !== undefined) {
    return known;
  }
  const client = connect(url, { max: 1 });
  try {
    const first = await client.query(pooler.probe, [1]);
    const second = await client.query(pooler.probe, [2]);
    return first[0]?.["pid"] === second[0]?.["pid"]
      ? undefined
      : "one prepared statement ran in two server sessions on one connection";
  } catch (error) {
    if (sqlState(error) === pooler.goneState) {
      return `a prepared statement was gone on its second run (SQLSTATE ${pooler.goneState}, prepared statement does not exist)`;
    }
    throw error;
  } finally {
    await client.close();
  }
}

async function poolerCheck(
  pooler: PoolerRule,
  connect: PollingConnect,
  target: EngineTarget,
  url: string,
): Promise<DoctorCheck> {
  const where = `"${target.source}" on ${databaseLabel(url)}`;
  const fix = `use the session pooler (port 5432) or a direct connection in ${subjectOf(target)}; the worker prepares each statement once per connection`;
  try {
    const why = await transactionPooler(pooler, connect, url);
    return why === undefined
      ? ok(
          "pooler",
          `prepared statements stay on one server session on "${target.source}" (a direct connection or a session pooler)`,
        )
      : fail(
          "pooler",
          `${where}: the database is behind a transaction-mode pooler (Supabase port 6543, PgBouncer transaction mode): ${why}`,
          fix,
        );
  } catch (error) {
    return fail(
      "pooler",
      `${where}: a prepared statement could not be run: ${plainMessage(error, [url])}`,
      fix,
    );
  }
}

const REINSTALL = "run facetdb migrate: it prints the SQL first and installs what is missing";

/**
 * The install check, and the polling line: a warning of the hourly scan when the table has no
 * column to poll by and the config did not choose the scan, a failure when the column the config's
 * `lastChanged` names cannot be polled by or a state field cannot be read as text.
 */
async function installCheck(
  dialect: SqlDialect,
  connect: PollingConnect,
  target: EngineTarget,
  url: string,
): Promise<{ readonly check: DoctorCheck; readonly warning?: DoctorCheck }> {
  let problems: string[];
  let polls = "";
  let warning: DoctorCheck | undefined;
  try {
    const found = await withConnection(connect, url, (query) => readTable(dialect, query, target));
    if (found === undefined) {
      problems = [
        `the table ${labelOf({ schema: target.schema ?? dialect.defaultSchema, name: target.table })} does not exist`,
      ];
    } else {
      const label = labelOf(found.table);
      const unread = unreadColumn(found);
      const owned = new Set(found.owned);
      const absent = ownedColumnNames(target.questionSet).filter((name) => !owned.has(name));
      problems = [
        ...(found.facts.triggers.length === 0
          ? []
          : [
              `${label} is watched by FacetDB's trigger (${found.facts.triggers.join(", ")}) as well, a trigger install's`,
            ]),
        ...(target.key === undefined && found.key === undefined
          ? [keyProblem(label, found.facts.key)]
          : []),
        ...(absent.length === 0 ? [] : [`${label} lacks the answer columns ${absent.join(", ")}`]),
        ...(found.installed && found.project === undefined
          ? [
              `${label} carries no project mark yet (a polling install from before FacetDB marked one)`,
            ]
          : []),
        ...(found.project !== undefined && found.project !== target.project.id
          ? [`${label} is marked as project ${found.project}'s, not ${target.project.id}'s`]
          : []),
        // A column the application added after the install: the worker cannot read it until
        // migrate grants it, and `open` refuses it in the same words.
        ...(unread === undefined ? [] : [unread.message]),
      ];
      const unfit = found.lastChangedRefusal ?? found.stateRefusal;
      // A column the config's lastChanged names that cannot be polled by, or a state field no poll
      // can read, fails on the polling line, in the words migrate and the worker refuse it with:
      // the install is not what is wrong.
      polls = unfit === undefined ? `; ${pollingWords(label, found.lastChanged)}` : "";
      const scan = hourlyScan(label, found.lastChanged);
      warning =
        unfit !== undefined
          ? { name: "polling", status: "fail", detail: unfit.message, fix: unfit.fix }
          : scan === undefined
            ? undefined
            : { name: "polling", status: "warn", detail: scan.detail, fix: scan.fix };
    }
  } catch (error) {
    const login = dialect.login?.name;
    problems = [
      `the catalog could not be read${login === undefined ? "" : ` as ${login}`}: ${plainMessage(error, [url])}`,
    ];
  }
  return {
    check:
      problems.length === 0
        ? ok("install", `the answer columns and facetdb_state_hash are in place${polls}`)
        : fail(
            "install",
            problems.map((problem) => `${target.source}: ${problem}`).join("; "),
            REINSTALL,
          ),
    ...(warning === undefined ? {} : { warning }),
  };
}

/**
 * Every check of the source in order, never throwing: what goes wrong inside one is its failure.
 * A check an earlier failure left nothing to look at is skipped.
 */
export async function doctorChecks(
  dialect: SqlDialect,
  connect: PollingConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<readonly DoctorCheck[]> {
  const database = await databaseCheck(dialect, connect, target, url, deps);
  const reached = database.check.status === "ok";
  const skipped = (name: string): DoctorCheck => ({
    name,
    status: "skip",
    detail: "not checked: the database check did not pass",
  });
  const install = reached ? await installCheck(dialect, connect, target, url) : undefined;
  return [
    database.check,
    ...(database.warning === undefined
      ? []
      : [{ name: "distance", status: "warn", detail: database.warning } satisfies DoctorCheck]),
    ...(dialect.pooler === undefined
      ? []
      : [reached ? await poolerCheck(dialect.pooler, connect, target, url) : skipped("pooler")]),
    install === undefined ? skipped("install") : install.check,
    ...(install?.warning === undefined ? [] : [install.warning]),
    {
      name: "worker",
      status: "skip",
      detail:
        "not checked here: the worker's heartbeat is in the FacetDB store, which the store's checks read",
    },
  ];
}
