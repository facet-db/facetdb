import type {
  EngineObject,
  EnginePlan,
  EngineTarget,
  PlanStatement,
  Refusal,
  RunOptions,
  RunResult,
} from "@facetdb/core";
import {
  anotherProjectOwner,
  installRefusal,
  loginLock,
  PASSWORD_STATEMENT,
  pruneRefusal,
  ranNote,
  scramVerifier,
  uninstallRefusal,
} from "../install/index.ts";
import {
  quoteLiteral,
  type SqlClient,
  type SqlConnect,
  type SqlQuery,
  type SqlRow,
} from "../sql/index.ts";
import { REFUSED_FIX } from "./plans.ts";
import { adminUrlRefusal, plainMessage } from "./urls.ts";

/**
 * `run`: the plan's statements against the admin URL, in order and as printed, in one transaction
 * as `migrate`, `uninstall` and `prune` run theirs. The one statement that is not its printed text
 * is the `secret` one: a comment in the plan, run as `PASSWORD_STATEMENT` with a fresh SCRAM
 * verifier of the password given, so neither the password nor a verifier is in a plan, a script or
 * a result. A stop is the script's own refusal when it raised one (in its words, under the code the
 * CLI prints for it today), the database's error otherwise, with no secret in it.
 */

/** What a run says when it reaches the plan's `secret` statement without a password. */
const NO_PASSWORD: Refusal = {
  code: "worker-password",
  message: "this plan sets the worker login's password, and the run was given none",
  fix: "set the source's connection string to the worker login with its password",
};

/**
 * What a run says when the worker login it was planned to create exists by its `secret` statement:
 * another project's migrate created it between this plan and its run, and setting this password
 * would lock that project's worker out (an existing login keeps its password).
 */
function loginCreatedMeanwhile(login: string): Refusal {
  return {
    code: "worker-login-created",
    message: `the worker login ${login} was created meanwhile, by another project's migrate; its password was left as it is and nothing was changed`,
    fix: "run facetdb migrate again, which keeps it",
  };
}

/**
 * The worker login's row, read inside the run's transaction at its `secret` statement. The name is
 * `workerRole`'s (lower-case letters, digits and `_` only), written as a literal: the statement
 * carries no parameter, so nothing but the password statement ever binds one.
 */
const roleExists = (login: string) =>
  `select 1 from pg_catalog.pg_roles where rolname = ${quoteLiteral(login)}`;

/** SQLSTATE `lock_not_available`: a wait passed the script's `lock_timeout` (10 seconds). */
const LOCK_TIMEOUT = "55P03";

/**
 * The refusal of a run that waited past its `lock_timeout` on the login's lock (`loginLock`, its
 * third statement): another first install on the server is creating the worker login right now,
 * and holds the lock until it commits. Only this statement's timeout is read so; a timeout on any
 * other statement (a busy table the install alters) stays the database's own words, as before.
 */
function loginLockTimeout(
  error: unknown,
  statement: PlanStatement | undefined,
  login: string,
): Refusal | undefined {
  if (sqlState(error) !== LOCK_TIMEOUT || statement?.text !== loginLock(login)) {
    return undefined;
  }
  return {
    code: "worker-login-busy",
    message: `another project's migrate is creating the worker login ${login} at this moment, and this run waited 10 seconds for it; nothing was changed (the transaction rolled back after its two set local lines)`,
    fix: "run facetdb migrate again once that migrate has finished: it then finds the login and keeps its password",
  };
}

/** Thrown inside the run's transaction to stop it, and roll it back, with a refusal. */
class Stop extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "Stop";
    this.refusal = refusal;
  }
}

/** The SQLSTATE of a plpgsql `raise exception` with no code of its own. */
const RAISED = "P0001";

/** How the scripts' own `raise`s begin their messages. */
const FACETDB = "FacetDB: ";

/** The server's error code, read off the driver's error (a boundary). */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * The refusal a script raised, read by its SQLSTATE and its own words, never by a guess at text:
 * the install's owner check right after the claim (another project claimed the table since the
 * plan was read), the install's and the prune's grant checks, an uninstall's re-checks and a lost
 * race (an uninstall's plan is the one that asks for a name back).
 */
function scriptRefusal(
  error: unknown,
  target: EngineTarget,
  plan: EnginePlan,
): Refusal | undefined {
  const refusal = (code: string, message: string): Refusal => ({ code, message, fix: REFUSED_FIX });
  if (error instanceof Error && sqlState(error) === RAISED && error.message.startsWith(FACETDB)) {
    const message = error.message.slice(FACETDB.length);
    const table = `${target.schema ?? "public"}.${target.table}`;
    if (anotherProjectOwner(table, message) !== undefined) {
      return refusal("another-project", message);
    }
  }
  const install = installRefusal(error);
  if (install !== undefined) {
    return refusal("migrate-refused", install);
  }
  const prune = pruneRefusal(error);
  if (prune !== undefined) {
    return refusal("prune-refused", prune);
  }
  const uninstall = plan.confirm === undefined ? undefined : uninstallRefusal(error);
  return uninstall === undefined ? undefined : refusal("uninstall-refused", uninstall);
}

const flag = (rows: readonly SqlRow[]) => rows[0]?.["gone"] === true;

/** The worker's usage of a schema, by the schema's own rights (a role's usage through PUBLIC is not FacetDB's). */
const USAGE_GONE = `select not exists (
  select 1 from pg_catalog.pg_namespace n
  cross join lateral pg_catalog.aclexplode(n.nspacl) a
  where n.nspname = $1 and a.privilege_type = 'USAGE'
    and a.grantee = (select r.oid from pg_catalog.pg_roles r where r.rolname = $2)) as gone`;

const RELATION_GONE = "select to_regclass($1) is null as gone";

/** Whether a run-scoped object of the plan is gone now, read in the run's own transaction. */
async function gone(query: SqlQuery, object: EngineObject): Promise<boolean> {
  switch (object.kind) {
    case "function":
      return flag(await query("select to_regprocedure($1) is null as gone", [`${object.name}()`]));
    case "schema":
      return flag(await query("select to_regnamespace($1) is null as gone", [object.name]));
    case "grant":
      return flag(await query(USAGE_GONE, [object.of, object.name]));
    case "marker": {
      const tableGone = flag(await query(RELATION_GONE, [object.name]));
      if (tableGone || object.of === undefined) {
        return tableGone;
      }
      // The project's entry (the one marker an `of` names) goes with its row. Its table is this
      // module's constant: a name from a plan, which may have been read back, never becomes SQL.
      return (
        (await query("select 1 from facetdb.projects where id = $1", [object.of])).length === 0
      );
    }
    default:
      // A table: the queue, the marks, the store's shared tables, the log's.
      return flag(await query(RELATION_GONE, [object.name]));
  }
}

/**
 * Whether this run was its uninstall's last: every run-scoped object of the plan is gone, because
 * nothing needs it any more. The first table's run of a multi-table uninstall finds the second
 * still needing them, so it reports its own objects only.
 */
async function lastOfRun(query: SqlQuery, removes: readonly EngineObject[]): Promise<boolean> {
  for (const object of removes) {
    if (object.scope === "run" && !(await gone(query, object))) {
      return false;
    }
  }
  return true;
}

export async function runPlan(
  connect: SqlConnect,
  pgHost: string | undefined,
  /** The worker login the plan's role block names (`workerRole` of the engine's suffix). */
  workerLogin: string,
  target: EngineTarget,
  plan: EnginePlan,
  url: string,
  options: RunOptions,
): Promise<RunResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure, pgHost);
  if (insecure !== undefined) {
    return { ran: [], stopped: { at: 0, refusal: insecure }, removed: [], notes: [] };
  }
  if (plan.statements.length === 0) {
    return { ran: [], removed: [], notes: plan.notes.map(ranNote) };
  }
  const { workerPassword } = options;
  const verifiers: string[] = [];
  const done: PlanStatement[] = [];
  let at = 0;
  let client: SqlClient | undefined;
  const work = async (query: SqlQuery): Promise<boolean> => {
    for (const [index, statement] of plan.statements.entries()) {
      at = index;
      if (statement.secret === true) {
        if (workerPassword === undefined) {
          throw new Stop(NO_PASSWORD);
        }
        // A plan holds a `secret` statement only when the login was absent as it was planned
        // (planInstall). Read again here, in the run's transaction: a login that exists now was
        // made by someone else since, and the role block would reset its password. The script took
        // the login's lock as its third statement, right after its two `set local` lines
        // (`loginLock`), and every script that may create the login takes it too, so none can
        // create it between this read and the role block.
        if ((await query(roleExists(workerLogin))).length > 0) {
          throw new Stop(loginCreatedMeanwhile(workerLogin));
        }
        const verifier = scramVerifier(workerPassword);
        verifiers.push(verifier);
        await query(PASSWORD_STATEMENT, [verifier]);
      } else {
        await query(statement.text);
      }
      done.push(statement);
    }
    // Every statement ran: a failure from here (the reading below, or the commit) is after the
    // last one, at the statement count, never blamed on the last statement.
    at = plan.statements.length;
    return lastOfRun(query, plan.removes);
  };
  try {
    client = connect(url);
    const { query } = client;
    const last = plan.transactional ? await client.transaction(work) : await work(query);
    return {
      ran: plan.statements,
      removed: last ? plan.removes : plan.removes.filter((object) => object.scope === "source"),
      notes: plan.notes.map(ranNote),
    };
  } catch (error) {
    // A transaction rolls back whole; without one, what ran before the stop stays. Nothing links
    // an object to a statement, so a stopped run reports none removed.
    const ran = plan.transactional ? [] : done;
    const refusal =
      error instanceof Stop
        ? error.refusal
        : (loginLockTimeout(error, plan.statements[at], workerLogin) ??
          scriptRefusal(error, target, plan));
    return {
      ran,
      stopped:
        refusal === undefined
          ? { at, error: plainMessage(error, [url, workerPassword, ...verifiers]) }
          : { at, refusal },
      removed: [],
      notes: [],
    };
  } finally {
    await client?.close();
  }
}
