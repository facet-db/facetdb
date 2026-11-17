import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DoctorCheck, EngineDeps, EngineTarget } from "@facetdb/core";
import { LOCK_FRESH_MS } from "../connector/index.ts";
import {
  BUSY_TIMEOUT_MS,
  JOBS_TABLE,
  OWNERS_TABLE,
  readTable,
  type SqliteQuery,
  sqliteQuery,
  textOf,
  triggerNames,
} from "../install/index.ts";
import { quoteIdent } from "../sql/index.ts";

/**
 * `facetdb doctor`'s checks of a SQLite source: the file, its journal mode, the SQLite Node runs,
 * the install, and the one worker's lock. The file is opened read-only, so nothing is changed, and
 * nothing is created where no file is.
 */

/** The SQLite FacetDB needs: 3.35 brought `drop column` (uninstall, prune) and `returning` (claims). */
export const MINIMUM_SQLITE = [3, 35, 0] as const;

export const DOCTOR_CHECKS: readonly { readonly name: string; readonly looksAt: string }[] = [
  {
    name: "file",
    looksAt: "checks that the SQLite file exists and that it and its directory are writable",
  },
  { name: "wal", looksAt: "reads the file's journal mode, which install sets to WAL" },
  { name: "sqlite", looksAt: "reads the version of the SQLite Node runs (3.35 or later)" },
  {
    name: "install",
    looksAt: "reads the file for the jobs table, the project's marker row and the two triggers",
  },
  {
    name: "lock",
    looksAt: "reads which worker holds the file's one worker lock, and when it renewed it",
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

function writable(path: string): boolean {
  try {
    accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/** `3.45.1` at least `3.35.0`, part by part. */
export function atLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split(".").map(Number);
  for (const [index, wanted] of minimum.entries()) {
    const part = parts[index] ?? 0;
    if (part !== wanted) {
      return part > wanted;
    }
  }
  return true;
}

function fileCheck(path: string, subject: string): DoctorCheck {
  if (!existsSync(path) || !statSync(path).isFile()) {
    return fail(
      "file",
      `${path} does not exist, or is not a file`,
      `check the file's path in ${subject}; FacetDB never creates a SQLite file`,
    );
  }
  if (!writable(path) || !writable(dirname(path))) {
    return fail(
      "file",
      `${path} or its directory is not writable by this user`,
      "let the worker's user write the file and its directory: WAL keeps a -wal and a -shm file beside it",
    );
  }
  return ok("file", `${path} exists, and it and its directory are writable`);
}

/** The journal mode and the SQLite version of the file, on a read-only handle. */
function fileChecks(db: DatabaseSync, path: string): readonly DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const mode = textOf(db.prepare("pragma journal_mode").get() ?? {}, "journal_mode");
  checks.push(
    mode === "wal"
      ? ok("wal", `${path} is in WAL mode: the application and the worker do not block each other`)
      : fail(
          "wal",
          `${path} is in ${mode} journal mode, not WAL`,
          "run facetdb migrate: it puts the file in WAL mode before anything else",
        ),
  );
  const version = textOf(db.prepare("select sqlite_version() as v").get() ?? {}, "v");
  checks.push(sqliteCheck(version, "run FacetDB on Node 24 or later, whose SQLite is new enough"));
  return checks;
}

/** The SQLite under the database is new enough for `drop column` and `returning`. */
export function sqliteCheck(version: string, fix: string): DoctorCheck {
  return atLeast(version, MINIMUM_SQLITE)
    ? ok("sqlite", `SQLite ${version}`)
    : fail(
        "sqlite",
        `SQLite ${version} is older than ${MINIMUM_SQLITE.join(".")}, which brought drop column and returning`,
        fix,
      );
}

/**
 * The `install` and `lock` checks, read through `query`: the table, the jobs table, the project's
 * marker row and the two triggers, then which worker holds the one worker's lock. `where` names the
 * database in the words (the file's path, a libSQL server's host). Shared by the SQLite engine and
 * the libSQL one: the lock is a row of `facetdb_table_owners`, so it reads the same in a file and
 * on a server.
 */
export async function installChecks(
  query: SqliteQuery,
  target: EngineTarget,
  where: string,
  now: number,
): Promise<readonly DoctorCheck[]> {
  // The table's spelling is the database's; the read refuses nothing here, it only checks there is one.
  const found = await readTable(query, target.table);
  if (found.kind !== "table") {
    return [
      fail(
        "install",
        `${target.table} is not a table of ${where}`,
        "point the source at the table, and run facetdb migrate on it",
      ),
      skip("lock", "there is no table to hold a lock on"),
    ];
  }
  const checks: DoctorCheck[] = [];
  const tables = new Set(
    (
      await query("select name from sqlite_master where type = 'table' and name in (?, ?)", [
        JOBS_TABLE,
        OWNERS_TABLE,
      ])
    ).map((row) => textOf(row, "name")),
  );
  const [owner] = tables.has(OWNERS_TABLE)
    ? await query(
        `select table_name, project_id, worker_id, heartbeat_at from ${quoteIdent(OWNERS_TABLE)} where table_name = ? collate nocase`,
        [target.table],
      )
    : [];
  const table = owner === undefined ? target.table : textOf(owner, "table_name");
  const names = triggerNames(table);
  const triggers = new Set(
    (
      await query("select name from sqlite_master where type = 'trigger' and name in (?, ?)", [
        names.insert,
        names.update,
      ])
    ).map((row) => textOf(row, "name")),
  );
  const missing = [
    ...(tables.has(JOBS_TABLE) ? [] : [JOBS_TABLE]),
    ...(owner === undefined ? [`the marker row of ${target.table} in ${OWNERS_TABLE}`] : []),
    ...[names.insert, names.update].filter((name) => !triggers.has(name)),
  ];
  if (missing.length > 0) {
    checks.push(
      fail(
        "install",
        `FacetDB is not installed on ${target.table}: ${missing.join(", ")} missing`,
        "run facetdb migrate",
      ),
    );
    checks.push(skip("lock", "nothing is installed to hold a lock on"));
    return checks;
  }
  const projectId = textOf(owner ?? {}, "project_id");
  if (projectId !== target.project.id) {
    checks.push(
      fail(
        "install",
        `${table} belongs to another project (${projectId})`,
        "run doctor from that project's directory, or point the source at another table",
      ),
    );
    checks.push(skip("lock", "the table is another project's"));
    return checks;
  }
  checks.push(
    ok("install", `the jobs table, the marker of ${table} and its two triggers are there`),
  );
  // The lock is the database's: a worker on any of its tables holds it (the connector refuses a
  // second one while any row's lock is fresh), so the latest renewal of every row is what counts.
  const [holder] = await query(
    `select table_name, worker_id, heartbeat_at from ${quoteIdent(OWNERS_TABLE)}
      where worker_id is not null and heartbeat_at is not null
      order by heartbeat_at desc limit 1`,
  );
  if (holder === undefined) {
    checks.push(ok("lock", "no worker holds the lock; the next facetdb worker takes it"));
    return checks;
  }
  const worker = textOf(holder, "worker_id");
  const heartbeat = textOf(holder, "heartbeat_at");
  const on = textOf(holder, "table_name");
  checks.push(
    ok(
      "lock",
      Date.parse(heartbeat) > now - LOCK_FRESH_MS
        ? `worker ${worker} holds the lock (on ${on}), renewed at ${heartbeat}`
        : `worker ${worker} last renewed the lock (on ${on}) at ${heartbeat}, over 2 minutes ago: it stopped, and the next worker takes the lock over`,
    ),
  );
  return checks;
}

export async function doctorChecks(
  target: EngineTarget,
  path: string,
  deps: EngineDeps,
): Promise<readonly DoctorCheck[]> {
  const subject = target.urlVariable ?? "the source's connection string";
  const file = fileCheck(path, subject);
  if (file.status === "fail") {
    return [
      file,
      ...DOCTOR_CHECKS.slice(1).map(({ name }) => skip(name, "the file could not be checked")),
    ];
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    return [
      file,
      ...fileChecks(db, path),
      ...(await installChecks(sqliteQuery(db), target, path, deps.clock.now())),
    ];
  } finally {
    db.close();
  }
}
