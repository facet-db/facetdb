import type { DoctorCheck } from "@facetdb/core";
import { type ProjectConfig, type SourceConfig, toProjectJson } from "../../config/index.ts";
import type { InstallCheck } from "./config-reload.ts";

/**
 * Which of an engine's doctor checks stand for "the columns are there and the worker login may
 * write them", read from the checks the doctor ran for the new question set under the worker login:
 *  - the columns: `install` on every engine (the answer columns in the catalog on PostgreSQL, MySQL,
 *    SQL Server and the polling engines; the marker and jobs on MongoDB, whose fields need none),
 *    and `marks` where the doctor has it (SQLite and libSQL: each column FacetDB writes is there);
 *  - the right to write them: `grants` (MySQL, MariaDB, SQL Server: the privilege views for FacetDB's
 *    columns), `login` (MongoDB: the rights the login holds on the collection) and `file` (SQLite:
 *    the file and its directory are writable, and the file has no other login).
 * PostgreSQL, CockroachDB, Oracle and libSQL have no check of the worker login's rights on the new
 * columns (a libSQL token that is accepted may still be read-only), so their doctor cannot tell and
 * the source waits for migrate and a restart, as before.
 */
const COLUMN_CHECKS: readonly string[] = ["install", "marks"];
const RIGHTS_CHECKS: readonly string[] = ["grants", "login", "file"];

/** A check that found nothing wrong; a warning is worth knowing and never a failure. */
const passed = (check: DoctorCheck) => check.status === "ok" || check.status === "warn";

/**
 * `granted`: this worker has just run the install of this very source to its end from the studio
 * (the migrate door), and the install grants the worker login its rights on every column it adds.
 * On an engine with no rights check that run stands in for one; the columns are still read from the
 * doctor under the worker login, so an install that reached another database than the worker's
 * switches nothing. A rights check the doctor does have still counts.
 */
export function installVerdict(
  database: string,
  checks: readonly DoctorCheck[],
  granted = false,
): InstallCheck {
  const columns = checks.filter((check) => COLUMN_CHECKS.includes(check.name));
  const rights = checks.filter((check) => RIGHTS_CHECKS.includes(check.name));
  if (!columns.some((check) => check.name === "install") || (rights.length === 0 && !granted)) {
    return {
      kind: "cannot-tell",
      why: `the worker's checks of ${database} cannot tell whether the worker login may write them`,
    };
  }
  // Whether the doctor read the rights itself: where it did not, `granted` stood in, and this
  // reading used it up, so a reading asked for again cannot hold.
  const rightsRead = rights.length > 0;
  const failed = [...columns, ...rights].filter((check) => !passed(check));
  if (failed.length > 0) {
    return { kind: "missing", missing: failed.map((check) => check.detail).join("; "), rightsRead };
  }
  return { kind: "holds", rightsRead };
}

/**
 * The checks that reach the database at all (`database` on the SQL engines and MongoDB, `server`
 * on libSQL, `file` on SQLite): when one of them failed and the install check was left unmade for
 * it, the reading told nothing of the install.
 */
const REACH_CHECKS: readonly string[] = ["database", "server", "file"];

/**
 * The words of a reading that could not be made because the database did not answer: the install
 * check skipped behind a failed reach check. The caller throws them, so the fleet says the read
 * failed and asks again later, and a finished install run is kept for the next reading rather than
 * used up by one that could not tell. Undefined for every other reading, whose verdict is
 * `installVerdict`'s.
 */
export function unreadCheck(checks: readonly DoctorCheck[]): string | undefined {
  const install = checks.find((check) => check.name === "install");
  if (install === undefined || install.status !== "skip") {
    return undefined;
  }
  return checks.find((check) => REACH_CHECKS.includes(check.name) && check.status === "fail")
    ?.detail;
}

/**
 * The installs this worker ran to their end from the studio, each for its source as the file held
 * it then, until the reload that follows reads it: `installVerdict`'s `granted`. Spent by the first
 * reading of its source, so a later Check again on an engine whose doctor cannot tell says so again
 * rather than leaning on an old run (a prune by hand since, say).
 */
export type InstallRuns = {
  /** This worker's migrate door ran the install of `source`, as `config` holds it, to its end. */
  ran(source: SourceConfig, config: ProjectConfig): void;
  /** Whether it did for `source` as `config` holds it now; the answer is given once. */
  took(source: SourceConfig, config: ProjectConfig): boolean;
};

export function installRuns(): InstallRuns {
  const runs = new Map<string, string>();
  /** The source as the file holds it, in the exporter's form: any change since is another source. */
  const keyOf = (source: SourceConfig, config: ProjectConfig) =>
    JSON.stringify(toProjectJson({ ...config, sources: [source] }).sources[0]);
  return {
    ran(source, config) {
      runs.set(source.name, keyOf(source, config));
    },
    took(source, config) {
      const ran = runs.get(source.name);
      runs.delete(source.name);
      return ran !== undefined && ran === keyOf(source, config);
    },
  };
}
