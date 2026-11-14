import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  type DatabaseEngine,
  type EnginePlan,
  EngineRefusal,
  type EngineTarget,
  type PlanResult,
} from "@facetdb/core";
import {
  createSqliteConnector,
  type OpenSqlite,
  openNodeSqlite,
  SQLITE_CAPABILITIES,
  type SqliteClient,
} from "../connector/index.ts";
import {
  BUSY_TIMEOUT_MS,
  planInstall,
  planPrune,
  planUninstall,
  readInstalled,
  render,
  run,
  type SqliteQuery,
  sqliteQuery,
} from "../install/index.ts";
import { DOCTOR_CHECKS, doctorChecks } from "./doctor.ts";
import { pathRefusal, sqlitePath } from "./path.ts";

/**
 * The SQLite engine: `facetdb worker` opens the file itself through node:sqlite, in WAL mode, one
 * worker, polling every second, answers inline. Its plans are the install's, read through a
 * read-only handle (a writable one would create a missing file while planning), and its run is the
 * install's, on the file. The CLI picks it for `sqlite:` and `file:` connection strings and bare
 * paths ending in `.db`, `.sqlite` or `.sqlite3` (cli/engines.ts).
 *
 * SQLite has no users: the file's path and its permissions are the credential, nothing travels over
 * a network, and `checkUrl` refuses only a string that names no file.
 *
 * `--purge`: the store is never the source's database (it is Postgres), so a plan holds no `store`
 * statement and the CLI's store door deletes the log after the engine's run. When the table no
 * longer carries FacetDB's install (an earlier uninstall left the log), `uninstall --purge` plans
 * the log-only purge Postgres plans: no statement on the file, the source's name typed back, and the
 * store door's part alone.
 *
 * One process opens one handle per file, shared by the connectors of every table of it the engine
 * opens: two handles of one process on one file would wait on each other's write lock, inside one
 * thread, and node:sqlite waits synchronously.
 */

/** How the CLI names this engine (`DatabaseEngine.name`). */
export const ENGINE_NAME = "sqlite";

export type SqliteEngineOptions = {
  /** Opens a file for the runtime connector; node:sqlite by default, a test passes its own. */
  readonly open?: OpenSqlite;
};

/** The refusal of a file that is not there: FacetDB never creates one (`run` says the same). */
function noFile(path: string): PlanResult {
  return {
    ok: false,
    refusal: {
      code: "no-file",
      message: `${path} does not exist; FacetDB opens an existing SQLite file and never creates one, so nothing was planned`,
      fix: "check the file's path in the source's connection string, then run the command again",
    },
  };
}

/** Plans through a read-only handle on the file, closed whatever happens. */
async function planning(
  target: EngineTarget,
  url: string,
  plan: (query: SqliteQuery) => Promise<PlanResult>,
): Promise<PlanResult> {
  const path = sqlitePath(url);
  if (path === undefined) {
    return { ok: false, refusal: pathRefusal(target) };
  }
  if (!existsSync(path)) {
    return noFile(path);
  }
  const db = new DatabaseSync(path, { readOnly: true, timeout: BUSY_TIMEOUT_MS });
  try {
    return await plan(sqliteQuery(db));
  } finally {
    db.close();
  }
}

/** `uninstall --purge` of a table FacetDB is no longer installed on: the store's part alone. */
function logOnlyPurge(target: EngineTarget, reason: string): EnginePlan {
  return {
    statements: [],
    transactional: true,
    removes: [],
    keeps: [],
    notes: [
      `${reason.replace(/\.$/, "")}: nothing is removed from the SQLite file, and only the decision log of source ${target.source} in the FacetDB store is deleted.`,
    ],
    confirm: { kind: "source", name: target.source },
  };
}

export function createSqliteEngine(options: SqliteEngineOptions = {}): DatabaseEngine {
  const openFile = options.open ?? openNodeSqlite;
  /** The handle of each file a connector holds open, by absolute path, and how many hold it. */
  const shared = new Map<string, { readonly client: SqliteClient; users: number }>();

  /** The file's shared client: the last connector that closes it closes the handle. */
  const share: OpenSqlite = (path) => {
    const at = resolve(path);
    let entry = shared.get(at);
    if (entry === undefined) {
      entry = { client: openFile(path), users: 0 };
      shared.set(at, entry);
    }
    entry.users += 1;
    const held = entry;
    let closed = false;
    return {
      run: (sql, params) => held.client.run(sql, params),
      all: (sql, params) => held.client.all(sql, params),
      transaction: (work) => held.client.transaction(work),
      close: async () => {
        if (closed) {
          return;
        }
        closed = true;
        held.users -= 1;
        if (held.users === 0) {
          shared.delete(at);
          await held.client.close();
        }
      },
    };
  };

  return {
    name: ENGINE_NAME,
    schemes: ["sqlite", "file"],
    capabilities: SQLITE_CAPABILITIES,
    checks: DOCTOR_CHECKS,

    planInstall: (target, url) => planning(target, url, (query) => planInstall(target, query)),

    planUninstall: (target, url, uninstallOptions) =>
      planning(target, url, async (query) => {
        if (uninstallOptions.purge) {
          const installed = await readInstalled(query, target.table);
          if ("reason" in installed) {
            return { ok: true, plan: logOnlyPurge(target, installed.reason) };
          }
        }
        return planUninstall(target, query, {
          alsoUninstalling: uninstallOptions.alsoUninstalling,
        });
      }),

    planPrune: (target, url) => planning(target, url, (query) => planPrune(target, query)),

    render,

    async run(target, plan, url) {
      const path = sqlitePath(url);
      if (path === undefined) {
        return {
          ran: [],
          stopped: { at: 0, refusal: pathRefusal(target) },
          removed: [],
          notes: [],
        };
      }
      return run(target, plan, path);
    },

    checkUrl: (target, url) => (sqlitePath(url) === undefined ? pathRefusal(target) : undefined),

    async open(target, url, openOptions) {
      const path = sqlitePath(url);
      if (path === undefined) {
        throw new EngineRefusal(pathRefusal(target));
      }
      return createSqliteConnector(target, path, {
        clock: openOptions.clock,
        open: share,
        ...(openOptions.workerId === undefined ? {} : { workerId: openOptions.workerId }),
      });
    },

    async doctor(target, url, deps) {
      const path = sqlitePath(url);
      if (path === undefined) {
        const refusal = pathRefusal(target);
        return [
          { name: "file", status: "fail", detail: refusal.message, fix: refusal.fix },
          ...DOCTOR_CHECKS.slice(1).map(({ name }) => ({
            name,
            status: "skip" as const,
            detail: "the file could not be checked",
          })),
        ];
      }
      return doctorChecks(target, path, deps);
    },
  };
}

/**
 * The engine over node:sqlite, for tools and tests. The CLI's composition root makes its own with
 * `createSqliteEngine()`, so the handles it shares live and die with that process's registration.
 */
export const sqliteEngine: DatabaseEngine = createSqliteEngine();
