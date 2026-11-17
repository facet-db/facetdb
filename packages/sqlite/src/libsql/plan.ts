import type { PlanResult } from "@facetdb/core";
import {
  beforeTransaction,
  guardsInMain,
  NO_USERS,
  ONE_WORKER,
  WAL_KEPT,
  WAL_NOTE,
} from "../install/index.ts";

/**
 * The SQLite plans as a libSQL server runs them: the same statements, the same text, but for two
 * things a server does not do. A file is put in WAL mode before the transaction opens; a server
 * owns its journal mode (sqld and Turso choose it for the database they serve), so the plan leaves
 * the pragma out, says so, and runs whole inside `begin immediate`. And sqld refuses temporary
 * tables, so an uninstall's hand-run guard table lives in `main` for the script's one transaction
 * and is dropped by its last statement (sql.ts, `guardsInMain`). The notes that speak of a file say
 * what a server does instead; every other note, and every refusal, is the file's word for word.
 */

/** The token is the credential, and install grants nothing. */
export const SERVER_ACCESS =
  "A libSQL server's auth token is the credential: FacetDB reads it from the environment (the variable of the source's connection string with _AUTH_TOKEN appended, else LIBSQL_AUTH_TOKEN), never from the config or the URL; this install creates no login and grants nothing.";

/** Why this script sets no journal mode. */
export const SERVER_JOURNAL =
  "The libSQL server owns the journal mode of the database it serves, so this script sets none: pragma journal_mode = wal, which install runs first on a SQLite file, is left out.";

/** The one-worker note, on a server. */
export const SERVER_ONE_WORKER =
  "One worker may run on this database at a time; its lock is a row of facetdb_table_owners on the server, so it holds for workers on other machines too, as long as their clocks are synchronized: the lock and the claim lease compare each worker's own time.";

/** Each file note, and what a server's plan says instead (nothing, for the WAL kept on uninstall). */
const ON_A_SERVER: ReadonlyMap<string, string | undefined> = new Map([
  [NO_USERS, SERVER_ACCESS],
  [WAL_NOTE, SERVER_JOURNAL],
  [ONE_WORKER, SERVER_ONE_WORKER],
  [WAL_KEPT, undefined],
]);

/** A SQLite plan for a libSQL server: no journal mode, and the notes a server's operator needs. */
export function forServer(result: PlanResult): PlanResult {
  if (!result.ok) {
    return result;
  }
  const { plan } = result;
  return {
    ok: true,
    plan: {
      ...plan,
      statements: guardsInMain(
        plan.statements.filter((statement) => !beforeTransaction(statement)),
      ),
      notes: plan.notes.flatMap((note) => {
        if (!ON_A_SERVER.has(note)) {
          return [note];
        }
        const instead = ON_A_SERVER.get(note);
        return instead === undefined ? [] : [instead];
      }),
    },
  };
}
