import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  EngineObject,
  EnginePlan,
  EngineTarget,
  PlanStatement,
  Refusal,
  RunResult,
} from "@facetdb/core";
import { OWNER_QUERY, type SqliteRow, type SqliteValue, textOf } from "./catalog.ts";
import { anotherProject, REFUSED_AFTER_WAL_FIX, refusal } from "./plan.ts";
import { beforeTransaction, GUARDED_SCRIPT, guardOf, OWNERS_TABLE } from "./sql.ts";

/**
 * A plan as the operator reads it and as it runs, on node:sqlite's `DatabaseSync` (Node 24's own
 * SQLite): the journal mode first, outside any transaction, then every other statement in one
 * `begin immediate` transaction, all or nothing. What runs is what was printed, string for string;
 * a statement whose first line is a guard (`guardOf`) runs only when its guard finds no row, the
 * check SQLite's SQL cannot make itself, and is skipped otherwise.
 */

/** How long a statement waits for another connection's write before it gives up (5 s). */
export const BUSY_TIMEOUT_MS = 5_000;

/** Opens the source's file; a test passes its own to reach what a real file rarely does. */
export type OpenDatabase = (path: string) => DatabaseSync;

/** How `run` opens the file: waiting up to `BUSY_TIMEOUT_MS` behind another connection's write. */
export function openSource(path: string): DatabaseSync {
  return new DatabaseSync(path, { timeout: BUSY_TIMEOUT_MS });
}

/** Where the plan's leading statements end: those that run before the transaction opens. */
function opening(plan: EnginePlan): number {
  const index = plan.statements.findIndex((statement) => !beforeTransaction(statement));
  return index === -1 ? plan.statements.length : index;
}

/**
 * The plan as one script, exactly as `run` runs it: the journal mode, then the rest framed by `begin
 * immediate` and `commit` (the write lock taken at once, so the transaction never fails half way to
 * upgrade a read lock); empty for a plan with no statements. A script holding a guard says above its
 * first line how to run it by hand (`GUARDED_SCRIPT`).
 */
export function render(plan: EnginePlan): string {
  if (plan.statements.length === 0) {
    return "";
  }
  const header = plan.statements.some((statement) => guardOf(statement) !== undefined)
    ? GUARDED_SCRIPT
    : "";
  const texts = plan.statements.map((statement) => statement.text);
  if (!plan.transactional) {
    return `${header}${texts.join(";\n\n")};\n`;
  }
  const at = opening(plan);
  return `${header}${[...texts.slice(0, at), "begin immediate", ...texts.slice(at), "commit"].join(";\n\n")};\n`;
}

/** Thrown inside the transaction to stop the run, and roll it back, with a refusal. */
class Stop extends Error {
  readonly refusal: Refusal;

  constructor(stopped: Refusal) {
    super(stopped.message);
    this.name = "Stop";
    this.refusal = stopped;
  }
}

function noFile(path: string): Refusal {
  return {
    code: "no-file",
    message: `${path} does not exist; FacetDB opens an existing SQLite file and never creates one, so nothing was run`,
    fix: "check the file's path in the source's connection string, then run the command again",
  };
}

/** SQLite answers the pragma with the mode the file is in, and keeps the old one when it cannot switch. */
function journalModeRefusal(path: string, mode: string): Refusal {
  return {
    code: "journal-mode",
    message: `${path} stays in ${mode} journal mode: SQLite would not put it in WAL mode, which lets the application and the worker read and write without blocking each other; nothing else was run`,
    fix: "keep the file on a local disk where SQLite can write beside it (WAL keeps a -wal and a -shm file next to the database) and close any connection holding it in exclusive locking mode, then run the command again",
  };
}

/** The table's owner now, inside the run's transaction, where nothing can change it any more. */
function ownerOf(db: DatabaseSync, table: string): string | undefined {
  const marker = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = ?")
    .get(OWNERS_TABLE);
  if (marker === undefined) {
    return undefined;
  }
  const row = db.prepare(OWNER_QUERY).get(table);
  return row === undefined ? undefined : textOf(row, "project_id");
}

/** Whether a run-scoped object, one of FacetDB's shared tables, is gone from the file. */
function gone(db: DatabaseSync, object: EngineObject): boolean {
  return db.prepare("select 1 from sqlite_master where name = ?").get(object.name) === undefined;
}

/**
 * Runs the plan on the file at `path`. The project's claim on the table is read again inside the
 * transaction before its first statement (`begin immediate` holds the write lock, so nothing changes
 * it after): a table another project claimed since the plan was read stops the run, and nothing of
 * the transaction is kept. A stopped run keeps only the journal mode, which ran before it, and its
 * refusal says so. `ran` lists the statements that ran: a guarded drop skipped is not among them.
 */
export function run(
  target: EngineTarget,
  plan: EnginePlan,
  path: string,
  open: OpenDatabase = openSource,
): RunResult {
  if (plan.statements.length === 0) {
    return { ran: [], removed: [], notes: plan.notes };
  }
  if (!existsSync(path)) {
    return { ran: [], stopped: { at: 0, refusal: noFile(path) }, removed: [], notes: [] };
  }
  const leading = opening(plan);
  const ran: PlanStatement[] = [];
  let at = 0;
  let db: DatabaseSync | undefined;
  try {
    db = open(path);
    for (const statement of plan.statements.slice(0, leading)) {
      const row = db.prepare(statement.text).get();
      const mode = row === undefined ? "an unknown" : textOf(row, "journal_mode");
      if (mode !== "wal") {
        return {
          ran,
          stopped: { at, refusal: journalModeRefusal(path, mode) },
          removed: [],
          notes: [],
        };
      }
      ran.push(statement);
      at += 1;
    }
    if (plan.transactional) {
      db.exec("begin immediate");
    }
    const owner = ownerOf(db, target.table);
    if (owner !== undefined && owner !== target.project.id) {
      throw new Stop(refusal("another-project", anotherProject(target.table, owner)));
    }
    for (const statement of plan.statements.slice(leading)) {
      const guard = guardOf(statement);
      if (guard === undefined || db.prepare(guard).get() === undefined) {
        db.exec(statement.text);
        ran.push(statement);
      }
      at += 1;
    }
    // Whether this run was its uninstall's last, read inside the transaction as Postgres's run reads
    // it: whatever fails here rolls the run back, so a committed run is never reported as stopped.
    const handle = db;
    const last = plan.removes
      .filter((object) => object.scope === "run")
      .every((object) => gone(handle, object));
    if (plan.transactional) {
      db.exec("commit");
    }
    return {
      ran,
      removed: last ? plan.removes : plan.removes.filter((object) => object.scope === "source"),
      notes: plan.notes,
    };
  } catch (error) {
    if (db?.isTransaction === true) {
      db.exec("rollback");
    }
    return stoppedRun(plan, ran, leading, at, error);
  } finally {
    db?.close();
  }
}

/** A run that stopped at `at`: what stays of it, and why it stopped. */
function stoppedRun(
  plan: EnginePlan,
  ran: readonly PlanStatement[],
  leading: number,
  at: number,
  error: unknown,
): RunResult {
  // A transaction rolls back whole: only what ran before it opened stays, the journal mode.
  const kept = plan.transactional ? ran.slice(0, leading) : ran;
  return {
    ran: kept,
    stopped:
      error instanceof Stop
        ? {
            at,
            refusal:
              kept.length === 0 ? error.refusal : { ...error.refusal, fix: REFUSED_AFTER_WAL_FIX },
          }
        : { at, error: error instanceof Error ? error.message : String(error) },
    removed: [],
    notes: [],
  };
}

/** The statements `runThrough` runs, alone or inside its transaction. */
export type RunStatements = {
  all(sql: string, params?: readonly SqliteValue[]): Promise<readonly SqliteRow[]>;
  exec(sql: string): Promise<void>;
};

/**
 * What `runThrough` runs a plan on: a client whose transaction is `begin immediate` … `commit`,
 * rolled back when its work throws (the connector's `SqliteClient` is one).
 */
export type RunClient = RunStatements & {
  transaction<T>(work: (tx: RunStatements) => Promise<T>): Promise<T>;
};

/**
 * `run` through a client instead of a file (libSQL's client, over the network): the same order, the
 * same guards, the same owner check inside the transaction, the same result. `where` names the
 * database in the words. A libSQL server's plan has no journal mode (the server owns it, so the
 * plan leaves the pragma out), and a plan that holds one checks its answer as `run` does.
 */
export async function runThrough(
  target: EngineTarget,
  plan: EnginePlan,
  client: RunClient,
  where: string,
): Promise<RunResult> {
  if (plan.statements.length === 0) {
    return { ran: [], removed: [], notes: plan.notes };
  }
  const leading = opening(plan);
  const ran: PlanStatement[] = [];
  let at = 0;
  try {
    for (const statement of plan.statements.slice(0, leading)) {
      const [row] = await client.all(statement.text);
      const mode = row === undefined ? "an unknown" : textOf(row, "journal_mode");
      if (mode !== "wal") {
        return {
          ran,
          stopped: { at, refusal: journalModeRefusal(where, mode) },
          removed: [],
          notes: [],
        };
      }
      ran.push(statement);
      at += 1;
    }
    const body = async (tx: RunStatements): Promise<boolean> => {
      const marker = await tx.all("select 1 from sqlite_master where type = 'table' and name = ?", [
        OWNERS_TABLE,
      ]);
      const [row] = marker.length === 0 ? [] : await tx.all(OWNER_QUERY, [target.table]);
      const owner = row === undefined ? undefined : textOf(row, "project_id");
      if (owner !== undefined && owner !== target.project.id) {
        throw new Stop(refusal("another-project", anotherProject(target.table, owner)));
      }
      for (const statement of plan.statements.slice(leading)) {
        const guard = guardOf(statement);
        if (guard === undefined || (await tx.all(guard)).length === 0) {
          await tx.exec(statement.text);
          ran.push(statement);
        }
        at += 1;
      }
      // Whether this run was its uninstall's last, read inside the transaction, as `run` reads it.
      for (const object of plan.removes.filter((one) => one.scope === "run")) {
        const left = await tx.all("select 1 from sqlite_master where name = ?", [object.name]);
        if (left.length > 0) {
          return false;
        }
      }
      return true;
    };
    const last = plan.transactional ? await client.transaction(body) : await body(client);
    return {
      ran,
      removed: last ? plan.removes : plan.removes.filter((object) => object.scope === "source"),
      notes: plan.notes,
    };
  } catch (error) {
    return stoppedRun(plan, ran, leading, at, error);
  }
}
