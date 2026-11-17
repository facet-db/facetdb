import type { DoctorCheck, EngineDeps, EngineTarget } from "@facetdb/core";
import { Timestamp } from "mongodb";
import {
  AWAIT_MS,
  CLAIM_LEASE_MS,
  type WorkerClient,
  type WorkerConnect,
  workerUrlRefusal,
} from "../connector/index.ts";
import {
  belowFloor,
  covers,
  driverFloor,
  type HeldPrivilege,
  JOB_COLLECTION_FIELD,
  JOBS_COLLECTION,
  JOBS_INDEXES,
  META_COLLECTION,
  markerId,
  refusedHere,
  rightsInWords,
  SERVER_FLOOR,
  type ServerDocument,
  WORKER_USER,
  workerPrivileges,
} from "../install/index.ts";
import {
  databaseOf,
  hostsOf,
  parseConnectionString,
  plainMessage,
  subjectOf,
  tlsVerdict,
} from "../urls/index.ts";

/**
 * `facetdb doctor`'s checks of a MongoDB source, under the worker login, on one connection,
 * changing nothing: the connection (the login, TLS, the round trip), the server's version, the
 * replica set change streams need, the worker's role and rights, the install as the worker sees it
 * (the project's marker, the jobs collection, its indexes), the oplog's window and the queue's
 * depth. What the worker's role may not read is said, with who can: the jobs collection's indexes
 * are the admin's `facetdb migrate --dry-run` to check (an empty plan means they are as installed),
 * and the oplog an admin's `rs.printReplicationInfo()`.
 */

/** The oldest MongoDB FacetDB runs on: the pinned driver's floor. */
export const MINIMUM_MONGODB = SERVER_FLOOR.split(".").map(Number);

export const DOCTOR_CHECKS: readonly { readonly name: string; readonly looksAt: string }[] = [
  {
    name: "database",
    looksAt:
      "connects with the source's connection string, checks that it logs in as facetdb_worker and whether TLS is on, and times three round trips",
  },
  {
    name: "version",
    looksAt: `reads the server's version (MongoDB ${SERVER_FLOOR} at least, the oldest the mongodb driver talks to)`,
  },
  {
    name: "replica-set",
    looksAt:
      "asks hello whether the server is a replica set member or a sharded cluster's router, which change streams need",
  },
  {
    name: "login",
    looksAt:
      "reads connectionStatus for the rights the worker login holds on the collection, facetdb_jobs and facetdb_meta",
  },
  {
    name: "install",
    looksAt:
      "reads the project's marker in facetdb_meta, the jobs collection and, where the worker may list them, its indexes",
  },
  {
    name: "oplog",
    looksAt:
      "reads how many hours of changes the oplog holds, where the worker may read it: a worker stopped longer than that resumes with one full pass",
  },
  { name: "queue", looksAt: "counts the collection's jobs waiting and claimed in facetdb_jobs" },
];

/** How many `ping` round trips measure the link; the median of them is what doctor reports. */
const ROUND_TRIPS = 3;

/** Above this many milliseconds a round trip is a warning: change streams wake the worker at once. */
const FAR_MS = 100;

/** Below this many hours of oplog, a worker stopped over a weekend would reconcile. */
const SHORT_OPLOG_HOURS = 24;

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });
const fail = (name: string, detail: string, fix: string): DoctorCheck => ({
  name,
  status: "fail",
  detail,
  fix,
});
const skip = (name: string, detail: string): DoctorCheck => ({ name, status: "skip", detail });
const warn = (name: string, detail: string): DoctorCheck => ({ name, status: "warn", detail });

const isRecord = (value: unknown): value is ServerDocument =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function list(value: unknown): readonly ServerDocument[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

/** The middle of three numbers, so a single slow or fast trip does not decide. */
function median(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** `7.0.45` at least `4.4`, part by part. */
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

/** A cursor reply's first batch (`find`, `listIndexes`, `listCollections`). */
function firstBatch(reply: ServerDocument): readonly ServerDocument[] {
  const cursor = reply["cursor"];
  return isRecord(cursor) ? list(cursor["firstBatch"]) : [];
}

/** The privileges `connectionStatus` reports, read at the boundary. */
function heldPrivileges(value: unknown): readonly HeldPrivilege[] {
  return list(value).map((privilege) => {
    const resource = isRecord(privilege["resource"]) ? privilege["resource"] : {};
    const { db, collection, anyResource } = resource;
    const actions = Array.isArray(privilege["actions"]) ? privilege["actions"] : [];
    return {
      resource: {
        ...(typeof db === "string" ? { db } : {}),
        ...(typeof collection === "string" ? { collection } : {}),
        ...(anyResource === true ? { anyResource } : {}),
      },
      actions: actions.filter((action): action is string => typeof action === "string"),
    };
  });
}

/** Whether TLS is on for this string, by the rule the connection was opened with. */
function tlsOn(url: string, allowInsecure: boolean): boolean {
  const verdict = tlsVerdict(url, allowInsecure);
  const parsed = parseConnectionString(url);
  return (
    (verdict.kind === "ok" && verdict.forceTls) ||
    parsed?.tls === true ||
    (parsed?.srv === true && parsed.tls !== false)
  );
}

/** What the first round trips learn: who the login is, and how far the server is. */
type Session = {
  readonly users: readonly string[];
  readonly privileges: readonly HeldPrivilege[];
  readonly roles: readonly string[];
  readonly roundTripMs: number;
};

async function readSession(client: WorkerClient, deps: EngineDeps): Promise<Session> {
  const status = await client.command("admin", { connectionStatus: 1, showPrivileges: true });
  const auth = isRecord(status["authInfo"]) ? status["authInfo"] : {};
  const taken: number[] = [];
  for (let trip = 0; trip < ROUND_TRIPS; trip += 1) {
    const started = deps.clock.now();
    await client.command("admin", { ping: 1 });
    taken.push(deps.clock.now() - started);
  }
  const [first = 0, second = 0, third = 0] = taken;
  return {
    users: list(auth["authenticatedUsers"]).map(
      (user) => `${String(user["user"])}@${String(user["db"])}`,
    ),
    roles: list(auth["authenticatedUserRoles"]).map(
      (role) => `${String(role["role"])}@${String(role["db"])}`,
    ),
    privileges: heldPrivileges(auth["authenticatedUserPrivileges"]),
    roundTripMs: Math.round(median(first, second, third)),
  };
}

function versionCheck(version: string): DoctorCheck {
  return atLeast(version, MINIMUM_MONGODB)
    ? ok("version", `MongoDB ${version}`)
    : fail(
        "version",
        `MongoDB ${version} is older than ${SERVER_FLOOR}, the oldest the mongodb driver FacetDB connects with talks to`,
        `upgrade the server to MongoDB ${SERVER_FLOOR} or later`,
      );
}

/** The replica set check, and whether the server is a router (which keeps no oplog of its own). */
function replicaSetCheck(hello: ServerDocument): {
  readonly check: DoctorCheck;
  readonly kind: "member" | "router" | "standalone";
} {
  const setName = hello["setName"];
  if (typeof setName === "string") {
    return { check: ok("replica-set", `a member of the replica set ${setName}`), kind: "member" };
  }
  if (hello["msg"] === "isdbgrid") {
    return { check: ok("replica-set", "a sharded cluster's router (mongos)"), kind: "router" };
  }
  return {
    check: fail(
      "replica-set",
      "the server is a standalone mongod: FacetDB follows changes with change streams, which only a replica set has (one node is enough)",
      "restart mongod as a one-node replica set (mongod --replSet rs0, or replication.replSetName: rs0 in mongod.conf), run rs.initiate() once in mongosh, and connect with ?replicaSet=rs0; every Atlas cluster is already a replica set",
    ),
    kind: "standalone",
  };
}

/** The worker's rights against what install gives: never more is checked here, only what is missing. */
function loginCheck(session: Session, database: string, collection: string): DoctorCheck {
  const needed = workerPrivileges(database, collection);
  const missing = needed.flatMap(({ resource, actions }) =>
    actions
      .filter((action) => !covers(session.privileges, [{ resource, actions: [action] }]))
      .map((action) => `${action} on ${resource.db}.${resource.collection}`),
  );
  return missing.length === 0
    ? ok(
        "login",
        `${WORKER_USER} holds ${session.roles.length === 0 ? "no role" : session.roles.join(", ")}, with every right it needs: ${rightsInWords(database, collection)}`,
      )
    : fail(
        "login",
        `${WORKER_USER} lacks ${missing.join(", ")}`,
        "run facetdb migrate: it gives the worker's role exactly these rights (on Atlas, give them to the custom role on the Database Access page)",
      );
}

/** The install as the worker sees it: the marker, the jobs collection, its indexes if it may list them. */
async function installCheck(
  client: WorkerClient,
  target: EngineTarget,
  database: string,
): Promise<DoctorCheck> {
  const label = `${database}.${target.table}`;
  const [marker] = firstBatch(
    await client.command(database, {
      find: META_COLLECTION,
      filter: { _id: markerId(target.table) },
      limit: 1,
    }),
  );
  if (marker === undefined) {
    return fail(
      "install",
      `FacetDB is not installed on ${label}: ${META_COLLECTION} holds no marker for it`,
      "run facetdb migrate",
    );
  }
  if (marker["project"] !== target.project.id) {
    return fail(
      "install",
      `${label} belongs to another project (${String(marker["project"])})`,
      "run doctor from that project's directory, or point the source at another collection",
    );
  }
  const jobs = firstBatch(
    await client.command(database, {
      listCollections: 1,
      filter: { name: JOBS_COLLECTION },
      nameOnly: true,
      authorizedCollections: true,
    }),
  );
  if (jobs.length === 0) {
    return fail(
      "install",
      `${database}.${JOBS_COLLECTION} is missing, and the worker never makes it (made by a write it would lack its unique index)`,
      "run facetdb migrate",
    );
  }
  let indexes: readonly ServerDocument[];
  try {
    indexes = firstBatch(await client.command(database, { listIndexes: JOBS_COLLECTION }));
  } catch (error) {
    if (!refusedHere(error)) {
      throw error;
    }
    return ok(
      "install",
      `the marker of project ${target.project.id} on ${label} and ${JOBS_COLLECTION} are there; the worker login may not list ${JOBS_COLLECTION}'s indexes, which facetdb migrate --dry-run with the admin connection string checks (it plans nothing when they are as installed)`,
    );
  }
  const missing = JOBS_INDEXES.filter(
    (wanted) =>
      !indexes.some((index) => {
        const key = isRecord(index["key"]) ? index["key"] : {};
        return (
          Object.keys(key).join(",") === wanted.fields.join(",") &&
          Object.values(key).every((direction) => direction === 1) &&
          (index["unique"] === true) === wanted.unique
        );
      }),
  );
  return missing.length === 0
    ? ok(
        "install",
        `the marker of project ${target.project.id} on ${label}, ${JOBS_COLLECTION} and its ${JOBS_INDEXES.length} indexes are there`,
      )
    : fail(
        "install",
        `${database}.${JOBS_COLLECTION} lacks ${missing.map((index) => `${index.name}${index.unique ? " (unique: without it a record changed twice before the worker comes is queued twice)" : ""}`).join(", ")}`,
        "run facetdb migrate: it makes the missing indexes",
      );
}

/** The oplog's window in hours, as `rs.printReplicationInfo()` reads it, or why it cannot be read. */
async function oplogChecks(
  client: WorkerClient,
  kind: "member" | "router" | "standalone",
  label: string,
): Promise<readonly DoctorCheck[]> {
  if (kind === "standalone") {
    return [skip("oplog", "a standalone server keeps no oplog")];
  }
  if (kind === "router") {
    return [
      warn(
        "oplog",
        "a sharded cluster keeps an oplog per shard, which the router does not show: an admin sees each shard's window with rs.printReplicationInfo() in mongosh on the shard",
      ),
    ];
  }
  const end = async (direction: 1 | -1): Promise<Timestamp | undefined> => {
    const [entry] = firstBatch(
      await client.command("local", {
        find: "oplog.rs",
        sort: { $natural: direction },
        limit: 1,
        projection: { ts: 1 },
      }),
    );
    const ts = entry?.["ts"];
    return ts instanceof Timestamp ? ts : undefined;
  };
  let first: Timestamp | undefined;
  let last: Timestamp | undefined;
  try {
    first = await end(1);
    last = await end(-1);
  } catch (error) {
    if (!refusedHere(error)) {
      throw error;
    }
    return [
      warn(
        "oplog",
        "the worker login may not read local.oplog.rs, so doctor cannot say how long the worker may stop before its restart reconciles with a full pass; an admin sees the window with rs.printReplicationInfo() in mongosh",
      ),
    ];
  }
  if (first === undefined || last === undefined) {
    return [warn("oplog", "local.oplog.rs holds no entry to measure the window by")];
  }
  const hours = Math.round(((last.t - first.t) / 3600) * 10) / 10;
  return [
    ok(
      "oplog",
      `the oplog holds ${hours} hours of changes: a worker stopped longer than that resumes with one full pass over ${label}, queuing every document whose state changed since its last answer and every document never answered, unpaced and with no cost estimate first`,
    ),
    ...(hours < SHORT_OPLOG_HOURS
      ? [
          warn(
            "oplog-window",
            `${hours} hours is under a day: a worker stopped over a weekend would reconcile with a full pass; raise the oplog size (replSetResizeOplog, or the cluster's oplog settings on Atlas)`,
          ),
        ]
      : []),
  ];
}

async function queueCheck(
  client: WorkerClient,
  target: EngineTarget,
  database: string,
): Promise<DoctorCheck> {
  const count = async (query: ServerDocument): Promise<number> => {
    const reply = await client.command(database, { count: JOBS_COLLECTION, query });
    const n = reply["n"];
    return typeof n === "number" ? n : 0;
  };
  const total = await count({ [JOB_COLLECTION_FIELD]: target.table });
  const claimed = await count({ [JOB_COLLECTION_FIELD]: target.table, claimed_at: { $ne: null } });
  const waiting = total - claimed;
  return ok(
    "queue",
    `${waiting} ${waiting === 1 ? "job waits" : "jobs wait"} for ${target.table}, ${claimed} ${claimed === 1 ? "is" : "are"} claimed (a claim lapses after ${CLAIM_LEASE_MS / 60_000} minutes)`,
  );
}

/**
 * Every check of the source in order, never throwing: what goes wrong inside one is its failure.
 * A check an earlier failure left nothing to look at is skipped.
 */
export async function doctorChecks(
  connect: WorkerConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<readonly DoctorCheck[]> {
  const subject = subjectOf(target);
  const skipped = (from: number, why = "not checked: the database check did not pass") =>
    DOCTOR_CHECKS.slice(from).map(({ name }) => skip(name, why));
  const refused = workerUrlRefusal(url, deps.allowInsecure, subject);
  if (refused !== undefined) {
    return [fail("database", `"${target.source}": ${refused.message}`, refused.fix), ...skipped(1)];
  }
  const database = target.schema ?? databaseOf(url);
  const where = hostsOf(url);
  if (database === undefined) {
    return [
      fail(
        "database",
        `"${target.source}": ${subject} names no database, and the source names no database for the collection ${target.table}`,
        `add the database to ${subject} (mongodb://${WORKER_USER}:<the worker password>@<host>/<database>), or name the collection as <database>.${target.table} in the config`,
      ),
      ...skipped(1),
    ];
  }
  const verdict = tlsVerdict(url, deps.allowInsecure);
  const client = connect(url, database, {
    forceTls: verdict.kind === "ok" && verdict.forceTls,
    maxConnections: 1,
    maxAwaitMs: AWAIT_MS,
  });
  // What passed so far, so a check that throws is that check's failure, the ones before it kept.
  const checks: DoctorCheck[] = [];
  try {
    let session: Session;
    try {
      session = await readSession(client, deps);
    } catch (error) {
      const floor = driverFloor(error);
      const refusal = floor === undefined ? undefined : belowFloor(url, floor);
      return [
        refusal === undefined
          ? fail(
              "database",
              `"${target.source}": ${where}/${database} could not be reached as the worker login: ${plainMessage(error, [url])}`,
              `check the host, the database and the worker password in ${subject}, and that the server lets this machine connect`,
            )
          : fail("database", `"${target.source}": ${refusal.message}`, refusal.fix),
        ...skipped(1),
      ];
    }
    const worker = session.users.find((user) => user.startsWith(`${WORKER_USER}@`));
    if (worker === undefined) {
      return [
        fail(
          "database",
          `"${target.source}": ${subject} logs in to ${where}/${database} as ${session.users.length === 0 ? "no user" : session.users.join(", ")}, not ${WORKER_USER}`,
          `set ${subject} to the worker login: mongodb://${WORKER_USER}:<the worker password>@<host>/${database}`,
        ),
        ...skipped(1),
      ];
    }
    checks.push(
      ok(
        "database",
        `"${target.source}": connected to ${where}/${database} as ${worker} ${tlsOn(url, deps.allowInsecure) ? "over TLS" : "without TLS (a server on this machine, or --allow-insecure)"}, ${session.roundTripMs} ms per round trip`,
      ),
    );
    if (session.roundTripMs > FAR_MS) {
      checks.push(
        warn(
          "distance",
          `${where} is ${session.roundTripMs} ms away; every record costs a few round trips, so run the worker within ${FAR_MS} ms of the database`,
        ),
      );
    }
    const info = await client.command(database, { buildInfo: 1 });
    checks.push(versionCheck(String(info["version"] ?? "")));
    const replicaSet = replicaSetCheck(await client.command("admin", { hello: 1 }));
    checks.push(replicaSet.check, loginCheck(session, database, target.table));
    const install = await installCheck(client, target, database);
    checks.push(install);
    checks.push(...(await oplogChecks(client, replicaSet.kind, `${database}.${target.table}`)));
    checks.push(
      install.status === "fail"
        ? skip("queue", "nothing is installed to queue for")
        : await queueCheck(client, target, database),
    );
    return checks;
  } catch (error) {
    const done = new Set(checks.map((check) => check.name));
    const at = DOCTOR_CHECKS.findIndex(({ name }) => !done.has(name));
    const name = DOCTOR_CHECKS[at]?.name ?? "queue";
    return [
      ...checks,
      fail(
        name,
        `"${target.source}": the ${name} check on ${where}/${database} failed as the worker login: ${plainMessage(error, [url])}`,
        `check that ${subject} is the worker login facetdb migrate created, then run facetdb migrate again`,
      ),
      ...(at === -1 ? [] : skipped(at + 1, "not checked: an earlier check failed")),
    ];
  } finally {
    await client.close();
  }
}
