import type { DoctorCheck } from "@facetdb/core";
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

export function installVerdict(database: string, checks: readonly DoctorCheck[]): InstallCheck {
  const columns = checks.filter((check) => COLUMN_CHECKS.includes(check.name));
  const rights = checks.filter((check) => RIGHTS_CHECKS.includes(check.name));
  if (!columns.some((check) => check.name === "install") || rights.length === 0) {
    return {
      kind: "cannot-tell",
      why: `the worker's checks of ${database} cannot tell whether the worker login may write them`,
    };
  }
  const failed = [...columns, ...rights].filter((check) => !passed(check));
  if (failed.length > 0) {
    return { kind: "missing", missing: failed.map((check) => check.detail).join("; ") };
  }
  return { kind: "holds" };
}
