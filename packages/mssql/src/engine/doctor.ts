import type { Clock, DoctorCheck, EngineDeps, EngineTarget } from "@facetdb/core";
import {
  AZURE_SQL_DATABASE,
  AZURE_SQL_MANAGED_INSTANCE,
  type CatalogColumn,
  type CatalogObject,
  CREATION_COLUMN,
  containedUsers,
  JOBS_TABLE,
  MARKER_TABLE,
  ownedColumns,
  readColumns,
  readGrants,
  readKey,
  readMarker,
  readObjects,
  readServer,
  type ServerFacts,
  SHARED_SCHEMA,
  SIDE_RIGHTS,
  sameTrigger,
  type TableNames,
  tableNames,
  trackedColumns,
  triggerText,
  WORKER_USER,
  type WorkerGrant,
} from "../install/index.ts";
import {
  type MssqlConnect,
  type MssqlQuery,
  parseMssqlUrl,
  quoteName,
  withoutSecrets,
  workerUrlRefusal,
} from "../sql/index.ts";
import {
  CHANGE_TRACKING_CHECK,
  changeTrackingCheck,
  trackingRightsMissing,
} from "./change-tracking.ts";
import type { OpenCursors } from "./engine.ts";

/**
 * `facetdb doctor`'s checks of a SQL Server or Azure SQL source, under the worker login, on one
 * connection, changing nothing: the connection (the login, TLS, the round trip), the server's
 * version, the database's containment and its owner, the install as the worker sees it (FacetDB's
 * columns, the queue, the marker's row, a renamed table), the trigger, the worker's grants and the
 * queue's depth. What the worker login cannot see is the admin's to check: a trigger's stored text
 * needs VIEW DEFINITION, which the worker never has, so `facetdb migrate --dry-run` with the admin
 * connection string is the check of the trigger's text (an empty plan means every object is as
 * installed: its trigger is compared by its stored text there). Where no variable names the
 * connection string, the words say "the source's connection string".
 */

/** SQL Server 2016 is version 13. */
export const MINIMUM_MAJOR_VERSION = 13;

export const DOCTOR_CHECKS: readonly { readonly name: string; readonly looksAt: string }[] = [
  {
    name: "database",
    looksAt:
      "connects with the source's connection string, checks that it logs in as facetdb_worker, says whether TLS is on and the certificate checked, and times three round trips",
  },
  {
    name: "version",
    looksAt: "reads the server's version: SQL Server 2016 (version 13) or later, or Azure SQL",
  },
  {
    name: "containment",
    looksAt:
      "reads whether the database is contained (the worker is a user of the database) or not (a server login), and that the database's owner has a login, which the trigger runs as",
  },
  {
    name: "install",
    looksAt:
      "reads the catalog as the worker sees it for FacetDB's columns, the jobs table, the project's marker row and a table renamed under its trigger",
  },
  {
    name: "trigger",
    looksAt:
      "reads the table's trigger, enabled and named for the table; its stored text is checked by facetdb migrate --dry-run with the admin connection string",
  },
  CHANGE_TRACKING_CHECK,
  {
    name: "grants",
    looksAt:
      "reads sys.database_permissions for the worker's rights on the key, the state columns, FacetDB's columns, the jobs table and the marker",
  },
  { name: "queue", looksAt: "counts the table's jobs waiting and claimed in facetdb_jobs" },
];

/**
 * The checks of one source, in order: the trigger's, or with `capture: "change-tracking"` the
 * Change Tracking check in its place. `DOCTOR_CHECKS` lists both for `--dry-run`.
 */
export function checksOf(
  target: Pick<EngineTarget, "capture">,
): readonly { readonly name: string; readonly looksAt: string }[] {
  const instead = target.capture === "change-tracking" ? "trigger" : CHANGE_TRACKING_CHECK.name;
  return DOCTOR_CHECKS.filter((check) => check.name !== instead);
}

/** How many `select 1` round trips measure the link; the median of them is what doctor reports. */
const ROUND_TRIPS = 3;

/** Above this many milliseconds a round trip is a warning: the 1 second target assumes a near database. */
const FAR_MS = 100;

/** The release each major version is, for the words. */
const RELEASES: Readonly<Record<number, string>> = {
  11: "2012",
  12: "2014",
  13: "2016",
  14: "2017",
  15: "2019",
  16: "2022",
  17: "2025",
};

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

/** Where a connection string points, without its user or password: what the words name. */
function databaseLabel(url: string): string {
  try {
    const parsed = parseMssqlUrl(url);
    return parsed.database === undefined
      ? `${parsed.host}:${parsed.port}`
      : `${parsed.host}:${parsed.port}/${parsed.database}`;
  } catch {
    return "the database";
  }
}

/**
 * Whether TLS is on, from the connection string: tedious refuses to connect when the string asks for
 * TLS and the server cannot give it, so the string says what the connection is. A session cannot
 * read its own `sys.dm_exec_connections` row without VIEW SERVER STATE, which the worker never has.
 */
function tlsWords(url: string): string {
  const parsed = parseMssqlUrl(url);
  if (parsed.encrypt === false) {
    return "without TLS (encrypt=false)";
  }
  if (parsed.trustServerCertificate) {
    return "over TLS, taking any certificate the server shows (trustServerCertificate=true)";
  }
  return parsed.encrypt === "strict"
    ? "over TLS (strict, TDS 8.0), the server's certificate checked"
    : "over TLS, the server's certificate checked";
}

/** The server as the words name it: `SQL Server 2022 (16)`, `Azure SQL Database`. */
export function serverName(server: Pick<ServerFacts, "edition" | "majorVersion">): string {
  if (server.edition === AZURE_SQL_DATABASE) {
    return "Azure SQL Database";
  }
  if (server.edition === AZURE_SQL_MANAGED_INSTANCE) {
    return "Azure SQL Managed Instance";
  }
  const major = server.majorVersion;
  if (major === null) {
    return "SQL Server of an unknown version";
  }
  const release = RELEASES[major];
  return release === undefined ? `SQL Server version ${major}` : `SQL Server ${release} (${major})`;
}

function versionCheck(server: ServerFacts): DoctorCheck {
  const name = serverName(server);
  const azure =
    server.edition === AZURE_SQL_DATABASE || server.edition === AZURE_SQL_MANAGED_INSTANCE;
  return azure || (server.majorVersion !== null && server.majorVersion >= MINIMUM_MAJOR_VERSION)
    ? ok("version", name)
    : fail(
        "version",
        `${name} is older than SQL Server 2016 (13), the oldest FacetDB runs on`,
        "upgrade the server to SQL Server 2016 or later, or move the database to Azure SQL",
      );
}

/**
 * Containment says what the worker is; the owner says whether the trigger can run. The trigger runs
 * `with execute as owner`, the table's owner, `dbo` for a `dbo` table, which is the database's
 * owning login: a database restored from another server can be owned by a login this server does
 * not have, and then every application insert and update of the table fails (error 15517). Azure
 * SQL Database maps `dbo` to its server admin, in master, which the database cannot name.
 */
function containmentCheck(server: ServerFacts): DoctorCheck {
  const contained = containedUsers(server);
  if (server.edition !== AZURE_SQL_DATABASE && server.ownerLogin === null) {
    return fail(
      "containment",
      `the database ${server.database} is owned by a login this server does not have (a database restored from another server keeps its owner), so FacetDB's trigger, which runs as the table's owner, fails every application insert and update of the table (error 15517)`,
      `give the database an owner this server has: alter authorization on database::${quoteName(server.database)} to [sa] (or another login), as an admin`,
    );
  }
  return ok(
    "containment",
    contained
      ? `${server.database} keeps its users itself (${server.edition === AZURE_SQL_DATABASE ? "Azure SQL Database" : "a contained database"}): ${WORKER_USER} is a user of this database alone`
      : `${server.database} is not contained: ${WORKER_USER} is a server login with a user in this database; the database's owner is the login ${server.ownerLogin ?? "of the server admin"}`,
  );
}

/** What the first statements learn of the session, read at the boundary. */
type Session = {
  readonly user: string;
  readonly login: string;
  readonly database: string;
  readonly roundTripMs: number;
};

async function readSession(query: MssqlQuery, clock: Clock): Promise<Session> {
  const [row] = await query(
    "select user_name() as user_name, suser_sname() as login_name, db_name() as database_name",
  );
  const taken: number[] = [];
  for (let trip = 0; trip < ROUND_TRIPS; trip += 1) {
    const started = clock.now();
    await query("select 1 as one");
    taken.push(clock.now() - started);
  }
  const [first = 0, second = 0, third = 0] = taken;
  return {
    user: String(row?.["user_name"] ?? ""),
    login: String(row?.["login_name"] ?? ""),
    database: String(row?.["database_name"] ?? ""),
    roundTripMs: Math.round(median(first, second, third)),
  };
}

/** The FacetDB triggers on the table, by name: one of another table's name means the table was renamed. */
const TABLE_TRIGGERS_QUERY = `select t.name as name
  from sys.triggers t
 where t.parent_id = object_id(@p1, N'U') and t.name like N'facetdb[_]%'
 order by t.name`;

/**
 * A table renamed under its trigger (`sp_rename`): the trigger moves with the table and keeps
 * writing to the old name (`update … from [dbo].[listings]`), so every application insert and
 * update of the table fails (error 208) until it is renamed back. Seen from either side: the
 * config's name with another table's trigger on it, or the config's trigger on a table of another
 * name.
 */
function renamed(
  names: TableNames,
  trigger: CatalogObject | undefined,
  onTable: readonly string[],
): DoctorCheck | undefined {
  if (
    trigger !== undefined &&
    trigger.parentTable !== null &&
    trigger.parentTable !== names.table
  ) {
    const now = `${trigger.parentSchema ?? names.schema}.${trigger.parentTable}`;
    return fail(
      "install",
      `${names.label} was renamed to ${now}: FacetDB's trigger ${trigger.name} moved with it and still writes to ${names.relation}, so every insert and update of ${now} fails (error 208)`,
      `rename ${now} back to ${names.table} (exec sp_rename N'${now}', N'${names.table}'), then run facetdb doctor again`,
    );
  }
  const other = onTable.find((name) => name !== names.trigger);
  if (other !== undefined && !onTable.includes(names.trigger)) {
    const was = other.slice("facetdb_".length);
    return fail(
      "install",
      `${names.label} carries the trigger ${other}, made for a table named ${was}: the table was renamed, and the trigger still writes to that name, so every insert and update of ${names.label} fails (error 208)`,
      `rename ${names.label} back to ${was} and set the source's table to ${was} in facetdb.config.ts; to keep the new name, run facetdb uninstall with the old name first, then facetdb migrate`,
    );
  }
  return undefined;
}

/** What the worker needs and lacks, against what install grants: never more is checked, only what is missing. */
function missingRights(
  target: EngineTarget,
  names: TableNames,
  key: string,
  columns: readonly CatalogColumn[],
  grants: readonly WorkerGrant[],
): readonly string[] {
  const holds = (object: string, schema: string, permission: string, column?: string) =>
    grants.some(
      (grant) =>
        grant.schema === schema &&
        grant.object === object &&
        grant.permission === permission &&
        (grant.column === undefined || grant.column === column),
    );
  // In side-table mode FacetDB's columns are the side table's, whole.
  const sideMode = target.storage === "side-table";
  const owned = sideMode ? [] : ownedColumns(target.questionSet).map((column) => column.name);
  const created = columns.some((column) => column.name === CREATION_COLUMN);
  const readable = [
    ...new Set([key, ...target.questionSet.read, ...owned, ...(created ? [CREATION_COLUMN] : [])]),
  ];
  return [
    ...readable
      .filter((column) => !holds(names.table, names.schema, "SELECT", column))
      .map((column) => `select on ${column}`),
    ...owned
      .filter((column) => !holds(names.table, names.schema, "UPDATE", column))
      .map((column) => `update on ${column}`),
    ...(sideMode ? SIDE_RIGHTS : [])
      .filter((permission) => !holds(names.sideTable, names.schema, permission))
      .map((permission) => `${permission.toLowerCase()} on ${names.sideTable}`),
    ...["SELECT", "INSERT", "UPDATE", "DELETE"]
      .filter((permission) => !holds(JOBS_TABLE, SHARED_SCHEMA, permission))
      .map((permission) => `${permission.toLowerCase()} on ${JOBS_TABLE}`),
    ...(holds(MARKER_TABLE, SHARED_SCHEMA, "SELECT") ? [] : [`select on ${MARKER_TABLE}`]),
  ];
}

/**
 * Error 334 and 213, which the install's notes named, repeated while the trigger is there: an
 * application statement with an OUTPUT clause and no INTO fails on a table with a trigger (Entity
 * Framework Core 7 and later write so by default), and an insert listing no columns fails once the
 * table has more columns than it lists.
 */
function applicationWrites(names: TableNames): DoctorCheck {
  return warn(
    "app-writes",
    `${names.label} has a trigger, so an application statement on it with an OUTPUT clause and no INTO fails (error 334), as Entity Framework Core 7 and later write by default: declare the trigger to EF Core (HasTrigger("${names.trigger}") on the table's entity), or watch the table with Change Tracking instead of a trigger; and an insert that lists no columns (insert into ${names.label} values (…)) fails (error 213) until it names them`,
  );
}

/**
 * Every check of the source in order, never throwing: what goes wrong inside one is its failure.
 * A check an earlier failure left nothing to look at is skipped.
 */
export async function doctorChecks(
  connect: MssqlConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
  cursors?: OpenCursors,
): Promise<readonly DoctorCheck[]> {
  const subject = target.urlVariable ?? "the source's connection string";
  const order = checksOf(target);
  const tracked = target.capture === "change-tracking";
  const skipped = (from: number, why = "not checked: the database check did not pass") =>
    order.slice(from).map(({ name }) => skip(name, why));
  const refused = workerUrlRefusal(url, deps.allowInsecure, subject);
  if (refused !== undefined) {
    return [fail("database", `"${target.source}": ${refused.message}`, refused.fix), ...skipped(1)];
  }
  const where = databaseLabel(url);
  const names = tableNames(target);
  let client: ReturnType<MssqlConnect> | undefined;
  const checks: DoctorCheck[] = [];
  try {
    client = connect(url);
    const { query } = client;
    const session = await readSession(query, deps.clock);
    if (session.user !== WORKER_USER) {
      return [
        fail(
          "database",
          `"${target.source}": ${subject} logs in to ${where} as ${session.login} (the user ${session.user} of ${session.database}), not ${WORKER_USER}`,
          `set ${subject} to the worker login: mssql://${WORKER_USER}:<the worker password>@<host>:1433/<database>`,
        ),
        ...skipped(1),
      ];
    }
    checks.push(
      ok(
        "database",
        `"${target.source}": connected to ${where} as ${WORKER_USER} ${tlsWords(url)}, ${session.roundTripMs} ms per round trip`,
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
    const server = await readServer(query);
    checks.push(versionCheck(server), containmentCheck(server));

    const columns = await readColumns(query, names.schema, names.table);
    const objects = await readObjects(query, names);
    const trigger = objects.find(
      (object) => object.schema === names.schema && object.name === names.trigger,
    );
    const onTable = (await query(TABLE_TRIGGERS_QUERY, [names.relation])).map((row) =>
      String(row["name"]),
    );
    const moved = renamed(names, trigger, onTable);
    if (moved !== undefined) {
      checks.push(moved, ...skipped(4, "not checked: the table was renamed"));
      return checks;
    }
    const owned = tracked
      ? trackedColumns(ownedColumns(target.questionSet))
      : ownedColumns(target.questionSet);
    const byName = new Map(columns.map((column) => [column.name, column]));
    // Where FacetDB's columns are: on the table, or in the side table.
    const sideMode = target.storage === "side-table";
    const answersAt = sideMode ? names.sideLabel : names.label;
    const stored = sideMode
      ? new Set(
          (await readColumns(query, names.schema, names.sideTable)).map((column) => column.name),
        )
      : new Set(byName.keys());
    const missing = owned.filter((column) => !stored.has(column.name)).map(({ name }) => name);
    const queue = objects.some(
      (object) => object.schema === SHARED_SCHEMA && object.name === JOBS_TABLE,
    );
    const marker = await readMarker(query, names, objects);
    const row = marker?.find((one) => one.schema === names.schema && one.table === names.table);
    const problems = [
      ...(columns.length === 0
        ? [
            `the worker login sees no column of ${names.label}: it does not exist, or the worker has no right on it`,
          ]
        : []),
      ...(columns.length > 0 && missing.length > 0
        ? [
            sideMode && stored.size === 0
              ? `${answersAt} is missing, or the worker has no right on it`
              : `${answersAt} lacks ${missing.join(", ")}`,
          ]
        : []),
      ...(queue ? [] : [`${SHARED_SCHEMA}.${JOBS_TABLE} is missing`]),
      ...(marker === undefined
        ? [`${SHARED_SCHEMA}.${MARKER_TABLE} is missing`]
        : row === undefined
          ? [`${MARKER_TABLE} has no row for ${names.label}`]
          : []),
    ];
    if (problems.length > 0) {
      checks.push(
        fail(
          "install",
          `FacetDB is not installed on ${names.label}: ${problems.join("; ")}`,
          "run facetdb migrate",
        ),
        ...skipped(4, "not checked: nothing is installed to look at"),
      );
      return checks;
    }
    if (row !== undefined && row.projectId !== target.project.id) {
      checks.push(
        fail(
          "install",
          `${names.label} belongs to another project (${row.projectId})`,
          "run doctor from that project's directory, or point the source at another table",
        ),
        ...skipped(4, "not checked: the table is another project's"),
      );
      return checks;
    }
    checks.push(
      ok(
        "install",
        `${owned.length} FacetDB columns on ${answersAt}, the jobs table and the marker row of project ${target.project.id} are there`,
      ),
    );

    const primary = await readKey(query, names.schema, names.table);
    const keyName = primary.length === 1 ? primary[0] : undefined;
    const key = keyName === undefined ? undefined : byName.get(keyName);
    if (tracked) {
      // No trigger, so no error 334 for the application either.
      checks.push(
        await changeTrackingCheck(
          query,
          target,
          names,
          server.database,
          trigger,
          cursors,
          deps.allowInsecure,
        ),
      );
    } else if (trigger === undefined) {
      checks.push(
        fail(
          "trigger",
          `${names.label} has no trigger ${names.trigger}, so no change of the table reaches the queue`,
          "run facetdb migrate: it makes the trigger again",
        ),
      );
    } else if (trigger.disabled) {
      checks.push(
        fail(
          "trigger",
          `the trigger ${names.trigger} on ${names.label} is disabled, so no change of the table reaches the queue`,
          "run facetdb migrate: it makes a disabled trigger again",
        ),
      );
    } else if (
      trigger.definition !== null &&
      key !== undefined &&
      !sameTrigger(
        trigger.definition,
        triggerText(names, key, target.questionSet.read, target.onChange, target.storage),
      )
    ) {
      checks.push(
        fail(
          "trigger",
          `the trigger ${names.trigger} on ${names.label} is not the one this config installs (its state columns or its onChange differ, or it was changed by hand)`,
          "run facetdb migrate: it makes the trigger again as the config says",
        ),
      );
    } else {
      checks.push(
        ok(
          "trigger",
          trigger.definition === null
            ? `${names.trigger} is on ${names.label} and enabled; its text is checked by facetdb migrate --dry-run with the admin connection string, which plans nothing when it is as installed (the worker login may not read a trigger's text)`
            : `${names.trigger} is on ${names.label}, enabled, and its text is the one this config installs`,
        ),
      );
    }
    if (trigger !== undefined && !tracked) {
      checks.push(applicationWrites(names));
    }

    const grants = keyName === undefined ? undefined : await readGrants(query, names);
    const lacking =
      keyName === undefined || grants === undefined
        ? undefined
        : [
            ...missingRights(target, names, keyName, columns, grants),
            ...(tracked ? trackingRightsMissing(names, grants) : []),
          ];
    checks.push(
      lacking === undefined
        ? fail(
            "grants",
            `${names.label} has no single-column primary key the worker login can see`,
            "run facetdb migrate: it refuses a table without one, and says what to change",
          )
        : lacking.length === 0
          ? ok(
              "grants",
              sideMode
                ? `${WORKER_USER} selects the key and the ${target.questionSet.read.length} state columns of ${names.label} and writes nothing there, selects, inserts and updates ${names.sideTable}, and has its rights on ${JOBS_TABLE} and ${MARKER_TABLE}`
                : `${WORKER_USER} selects the key, the ${target.questionSet.read.length} state columns and FacetDB's columns of ${names.label}, updates FacetDB's columns only, and has its rights on ${JOBS_TABLE} and ${MARKER_TABLE}`,
            )
          : fail(
              "grants",
              `${WORKER_USER} lacks ${lacking.join(", ")}`,
              "run facetdb migrate: it grants what is missing and nothing more",
            ),
    );

    const [counts] = await query(
      `select count(*) as total, count(j.[claimed_at]) as claimed from ${names.jobsRelation} j where j.[table_name] = @p1`,
      [names.relation],
    );
    const total = Number(counts?.["total"] ?? 0);
    const claimed = Number(counts?.["claimed"] ?? 0);
    const waiting = total - claimed;
    checks.push(
      ok(
        "queue",
        `${waiting} ${waiting === 1 ? "job waits" : "jobs wait"} for ${names.label}, ${claimed} ${claimed === 1 ? "is" : "are"} claimed`,
      ),
    );
    return checks;
  } catch (error) {
    const message = withoutSecrets(error instanceof Error ? error.message : String(error), [url]);
    const done = checks.filter((check) => order.some(({ name }) => name === check.name));
    if (done.length > 0) {
      // Connected, then a read of the catalog failed: that check fails, the rest are not looked at.
      const at = order[done.length]?.name ?? "queue";
      return [
        ...checks,
        fail(
          at,
          `reading ${names.label} as the worker login failed: ${message}`,
          "run facetdb migrate, which grants the worker what it needs, then run facetdb doctor again",
        ),
        ...skipped(done.length + 1, `not checked: the ${at} check could not finish`),
      ];
    }
    return [
      fail(
        "database",
        `"${target.source}": ${where} could not be reached as the worker login: ${message}`,
        `check the host, port, database and worker password in ${subject}, and that the server lets this machine connect`,
      ),
      ...skipped(1),
    ];
  } finally {
    await client?.close().catch(() => undefined);
  }
}
