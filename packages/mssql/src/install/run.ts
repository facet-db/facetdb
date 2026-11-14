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
  adminUrlRefusal,
  type MssqlClient,
  type MssqlConnect,
  type MssqlQuery,
  quoteString,
  withoutSecrets,
} from "../sql/index.ts";
import { anotherProjectOwner, SCRIPT_ERROR, SCRIPT_PREFIX } from "./marker.ts";
import { tableNames } from "./objects.ts";
import { ranNote } from "./uninstall.ts";

/**
 * `run`: the plan's statements against the admin connection string, in order and as printed, in
 * one transaction (`xact_abort` on, so the server rolls it back at a failure too), each its own
 * request with `@p1`, `@p2`, … parameters. The one statement that is not run bare is the `secret`
 * one: its text reads the worker password from `@p1`, and the run binds the password given there,
 * so it is in no plan, no script and no result. A stop is the script's own refusal when it raised
 * one (its owner check, a log-only purge's re-check), the server's error otherwise, with no secret
 * in its words.
 */

/** What a run says when it reaches the plan's `secret` statement without a password. */
const NO_PASSWORD: Refusal = {
  code: "worker-password",
  message: "this plan sets the worker login's password, and the run was given none",
  fix: "set the source's connection string to the worker login with its password",
};

/** Thrown inside the run's transaction to stop it, and roll it back, with a refusal. */
class Stop extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "Stop";
    this.refusal = refusal;
  }
}

/** The server's error number, read off the driver's error (a boundary). */
function errorNumber(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("number" in error)) {
    return undefined;
  }
  return typeof error.number === "number" ? error.number : undefined;
}

/**
 * The refusal a script raised, read by its error number and its own words, never by a guess at
 * the server's text: install's owner check (another project claimed the table since the plan was
 * read), or an uninstall's re-check (a plan that asks for a name back).
 */
function scriptRefusal(
  error: unknown,
  target: EngineTarget,
  plan: EnginePlan,
): Refusal | undefined {
  if (
    !(error instanceof Error) ||
    errorNumber(error) !== SCRIPT_ERROR ||
    !error.message.startsWith(SCRIPT_PREFIX)
  ) {
    return undefined;
  }
  const message = error.message.slice(SCRIPT_PREFIX.length);
  if (anotherProjectOwner(tableNames(target).label, message) !== undefined) {
    return {
      code: "another-project",
      message,
      fix: "uninstall it from that project first, or point this source at another table",
    };
  }
  return plan.confirm === undefined
    ? undefined
    : {
        code: "uninstall-refused",
        message,
        fix: "check what the message says, then run facetdb uninstall again",
      };
}

/**
 * Whether this run was its uninstall's last: the run-scoped objects it removes, the database's
 * queue and its marker table, are gone because no table of the run needs them any more; the first
 * table's run of a multi-table uninstall keeps them for the next. Read in the run's own
 * transaction, after its statements.
 */
async function lastOfRun(
  query: MssqlQuery,
  target: EngineTarget,
  removes: readonly EngineObject[],
): Promise<boolean> {
  const run = removes.filter((object) => object.scope === "run");
  if (run.length === 0) {
    return true;
  }
  const names = tableNames(target);
  const [row] = await query(
    `select object_id(${quoteString(names.jobsRelation)}, N'U') as queue, object_id(${quoteString(names.markerRelation)}, N'U') as marker`,
  );
  return (
    row !== undefined &&
    run.every((object) => row[object.kind === "jobs-table" ? "queue" : "marker"] === null)
  );
}

export async function runPlan(
  connect: MssqlConnect,
  target: EngineTarget,
  plan: EnginePlan,
  url: string,
  options: RunOptions,
): Promise<RunResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure);
  if (insecure !== undefined) {
    return { ran: [], stopped: { at: 0, refusal: insecure }, removed: [], notes: [] };
  }
  if (plan.statements.length === 0) {
    return { ran: [], removed: [], notes: plan.notes.map(ranNote) };
  }
  const { workerPassword } = options;
  const done: PlanStatement[] = [];
  let at = 0;
  let client: MssqlClient | undefined;
  const work = async (query: MssqlQuery): Promise<boolean> => {
    for (const [index, statement] of plan.statements.entries()) {
      at = index;
      if (statement.secret === true) {
        if (workerPassword === undefined) {
          throw new Stop(NO_PASSWORD);
        }
        await query(statement.text, [workerPassword]);
      } else {
        await query(statement.text);
      }
      done.push(statement);
    }
    return lastOfRun(query, target, plan.removes);
  };
  try {
    client = connect(url);
    const last = plan.transactional ? await client.transaction(work) : await work(client.query);
    return {
      ran: plan.statements,
      removed: last ? plan.removes : plan.removes.filter((object) => object.scope === "source"),
      notes: plan.notes.map(ranNote),
    };
  } catch (error) {
    // A transaction rolls back whole; without one, what ran before the stop stays. Nothing links
    // an object to a statement, so a stopped run reports none removed.
    const refusal = error instanceof Stop ? error.refusal : scriptRefusal(error, target, plan);
    const message = error instanceof Error ? error.message : String(error);
    return {
      ran: plan.transactional ? [] : done,
      stopped:
        refusal === undefined
          ? { at, error: withoutSecrets(message, [url, workerPassword]) }
          : { at, refusal },
      removed: [],
      notes: [],
    };
  } finally {
    await client?.close();
  }
}
