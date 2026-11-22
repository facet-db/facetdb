import { accessSync, constants, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DoctorCheck, EngineDeps, EngineTarget } from "@facetdb/core";
import { LOCK_FRESH_MS } from "../connector/index.ts";
import {
  absentColumns,
  applicationColumns,
  BUSY_TIMEOUT_MS,
  JOBS_TABLE,
  keyOf,
  lostMarks,
  OWNERS_TABLE,
  readTable,
  type SqliteQuery,
  sqliteQuery,
  type TableFacts,
  textOf,
  triggerNames,
  unmarkedNamesakes,
} from "../install/index.ts";
import { quoteIdent } from "../sql/index.ts";

/**
 * `facetdb doctor`'s checks of a SQLite source: the file, its journal mode, the SQLite Node runs,
 * the change capture and the install, the marks of FacetDB's columns, and the one worker's lock.
 * The file is opened read-only, so nothing is changed, and nothing is created where no file is.
 */

/**
 * What the `capture` check reads, in a file and on a libSQL server alike: what means the install is
 * gone, which the worker raises Connector lost access on.
 */
export const CAPTURE_LOOKS_AT =
  "reads that changes are still queued: the table, the jobs table and the two triggers, present";

/**
 * What the `install` check reads: what an install merely behind facetdb.config.ts lacks, which
 * `facetdb migrate` brings forward and which raises nothing.
 */
export const INSTALL_LOOKS_AT =
  "reads the project's marker row and that the table has every column the question set needs";

/** What the `marks` check reads, in a file and on a libSQL server alike. */
export const MARKS_LOOKS_AT =
  "reads the table's definition for FacetDB's mark on each of its columns, which a table rebuild drops";

/** The SQLite FacetDB needs: 3.35 brought `drop column` (uninstall, prune) and `returning` (claims). */
export const MINIMUM_SQLITE = [3, 35, 0] as const;

export const DOCTOR_CHECKS: readonly { readonly name: string; readonly looksAt: string }[] = [
  {
    name: "file",
    looksAt: "checks that the SQLite file exists and that it and its directory are writable",
  },
  { name: "wal", looksAt: "reads the file's journal mode, which install sets to WAL" },
  { name: "sqlite", looksAt: "reads the version of the SQLite Node runs (3.35 or later)" },
  { name: "capture", looksAt: CAPTURE_LOOKS_AT },
  { name: "install", looksAt: INSTALL_LOOKS_AT },
  { name: "marks", looksAt: MARKS_LOOKS_AT },
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
    return {
      ...fail(
        "file",
        `${path} does not exist, or is not a file`,
        `check the file's path in ${subject}; FacetDB never creates a SQLite file`,
      ),
      unreachable: true,
    };
  }
  if (!writable(path) || !writable(dirname(path))) {
    // Nothing behind the file was read either, and a chmod mends it with no restart.
    return {
      ...fail(
        "file",
        `${path} or its directory is not writable by this user`,
        "let the worker's user write the file and its directory: WAL keeps a -wal and a -shm file beside it",
      ),
      unreachable: true,
    };
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
 * The `marks` check: every column of the question set the table has carries FacetDB's mark in its
 * definition. A rebuild's unmarked copies fail with migrate's own words and recovery; an unmarked
 * column of FacetDB's name on a table that shows no rebuild fails as the application's, as migrate
 * refuses it. A column the table lacks is the install check's: a question added and not migrated
 * yet is an install behind the file, never a lost access.
 */
async function marksCheck(
  query: SqliteQuery,
  target: EngineTarget,
  table: TableFacts,
): Promise<DoctorCheck> {
  const lost = await lostMarks(query, table, target.questionSet, keyOf(target, table));
  if (lost !== undefined) {
    return fail("marks", lost.message, lost.fix);
  }
  // No rebuild shows: an unmarked column of FacetDB's name is the application's, as migrate says.
  const namesakes = unmarkedNamesakes(table, target.questionSet);
  if (namesakes.length > 0) {
    return fail(
      "marks",
      applicationColumns(table.name, namesakes),
      "rename the question in the config, or the application's column, then run facetdb migrate",
    );
  }
  return ok(
    "marks",
    absentColumns(table, target.questionSet).length === 0
      ? `every column FacetDB writes on ${table.name} carries FacetDB's mark`
      : `every column FacetDB writes that ${table.name} has carries FacetDB's mark`,
  );
}

/** The `install` check's failure for the columns a question set needs and the table lacks. */
function absentCheck(table: TableFacts, target: EngineTarget): DoctorCheck | undefined {
  const absent = absentColumns(table, target.questionSet);
  return absent.length === 0
    ? undefined
    : fail(
        "install",
        `${table.name} has no column ${absent.join(", ")}, which the question set needs`,
        "run facetdb migrate: it adds the columns the table lacks, each marked as FacetDB's",
      );
}

/**
 * The `capture`, `install`, `marks` and `lock` checks, read through `query`: the table, the jobs
 * table and the two triggers (`capture`: what means changes are no longer queued, which the worker
 * raises Connector lost access on); the project's marker row and the columns the question set needs
 * (`install`: what `facetdb migrate` brings forward to the file, which raises nothing); the marks
 * of FacetDB's columns; then which worker holds the one worker's lock. Each fact kept the words it
 * had under `install` or `marks`. `where` names the database in the words (the file's path, a
 * libSQL server's host). Shared by the SQLite engine and the libSQL one: the marks are in the
 * table's definition and the lock is a row of `facetdb_table_owners`, so they read the same in a
 * file and on a server. The marks are checked whenever the marker names this project, the triggers
 * present or not: a table rebuild drops the triggers along with the marks.
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
        "capture",
        `${target.table} is not a table of ${where}`,
        "point the source at the table, and run facetdb migrate on it",
      ),
      skip("install", "there is no table to check the install of"),
      skip("marks", "there is no table to check the marks of"),
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
  // What means changes are no longer queued (the capture's), and what the install lacks besides.
  const gone = [
    ...(tables.has(JOBS_TABLE) ? [] : [JOBS_TABLE]),
    ...[names.insert, names.update].filter((name) => !triggers.has(name)),
  ];
  const notInstalled = (missing: readonly string[]) =>
    `FacetDB is not installed on ${target.table}: ${missing.join(", ")} missing`;
  checks.push(
    gone.length > 0
      ? fail("capture", notInstalled(gone), "run facetdb migrate")
      : ok("capture", `the jobs table and the two triggers of ${table} are there`),
  );
  const projectId = owner === undefined ? undefined : textOf(owner, "project_id");
  const marks =
    projectId === undefined
      ? skip("marks", "FacetDB is not installed on the table")
      : projectId === target.project.id
        ? await marksCheck(query, target, found)
        : skip("marks", "the table is another project's");
  if (owner === undefined) {
    checks.push(
      fail(
        "install",
        notInstalled([`the marker row of ${target.table} in ${OWNERS_TABLE}`]),
        "run facetdb migrate",
      ),
    );
    checks.push(marks);
    checks.push(skip("lock", "nothing is installed to hold a lock on"));
    return checks;
  }
  if (projectId !== target.project.id) {
    checks.push(
      fail(
        "install",
        `${table} belongs to another project (${projectId})`,
        "run doctor from that project's directory, or point the source at another table",
      ),
    );
    checks.push(marks);
    checks.push(skip("lock", "the table is another project's"));
    return checks;
  }
  checks.push(
    absentCheck(found, target) ??
      ok("install", `the marker of ${table} and every column the question set needs are there`),
  );
  checks.push(marks);
  if (gone.length > 0) {
    checks.push(skip("lock", "nothing is installed to hold a lock on"));
    return checks;
  }
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
