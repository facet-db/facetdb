import type {
  EnginePlan,
  EngineTarget,
  PlanStatement,
  Refusal,
  RunOptions,
  RunResult,
} from "@facetdb/core";
import type { PollingClient, PollingConnect, PollingQuery, SqlDialect } from "../dialect/index.ts";
import { labelOf, readTable, tableOf } from "../install/index.ts";
import { anotherProject, REFUSED_FIX } from "./plans.ts";
import { adminUrlRefusal, plainMessage } from "./urls.ts";

/**
 * `run`: the plan's statements against the admin URL, in order and as printed, in one transaction
 * where the dialect's DDL is transactional. Elsewhere a stopped run keeps what ran, and a fresh plan
 * made after the stop, from the table as it is then, completes it (the same plan run again would
 * add a column the stopped run already added). The one statement that is not its printed text is
 * the `secret` one: a comment in the plan, run as the dialect's statement with what it derives from
 * the password bound, so neither the password nor anything made of it is in a plan, a script or a
 * result.
 *
 * The run reads the table's mark again ("the engine checks again, inside the run, what the plan
 * read before it"): right after the plan's lock statement, as the trigger engine checks right after
 * its claim, so another install of the table has either committed its mark (and stops this run) or
 * waits for this one; before anything where the dialect locks nothing, and, where it groups DDL
 * instead (`SqlDialect.atomic`), again right after the claim that opens its install. A dialect's
 * group runs inside the client's own transaction, so the driver rolls a failure back and no
 * connection is left in an aborted transaction. An empty plan that asks for the source's name back
 * (a log-only purge) reads the table too: an install made since it was planned makes the log live
 * again, and the store's purge must not follow.
 */

/** What a run says when it reaches the plan's `secret` statement without a password. */
const NO_PASSWORD: Refusal = {
  code: "worker-password",
  message: "this plan sets the worker login's password, and the run was given none",
  fix: "set the source's connection string to the worker login with its password",
};

/** Thrown inside the run to stop it, and roll it back where it can, with a refusal. */
class Stop extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "Stop";
    this.refusal = refusal;
  }
}

/** Stops the run when another project marked the table: the plan was read before it did. */
async function checkMark(dialect: SqlDialect, query: PollingQuery, target: EngineTarget) {
  const found = await readTable(dialect, query, target);
  if (found?.project !== undefined && found.project !== target.project.id) {
    throw new Stop({
      code: "another-project",
      message: anotherProject(labelOf(found.table), found.project),
      fix: REFUSED_FIX,
    });
  }
}

/**
 * A log-only purge's run: the table must still have no install of FacetDB's, or the decision log
 * the store's purge deletes next would be a live source's (the trigger engine's re-check, the same
 * words).
 */
async function checkStillGone(
  dialect: SqlDialect,
  connect: PollingConnect,
  target: EngineTarget,
  url: string,
): Promise<RunResult> {
  const client = connect(url);
  try {
    const found = await readTable(dialect, client.query, target);
    return found === undefined || found.owned.length === 0
      ? { ran: [], removed: [], notes: [] }
      : {
          ran: [],
          stopped: {
            at: 0,
            refusal: {
              code: "uninstall-refused",
              message: `the decision log of source "${target.source}" is live again: ${labelOf(found.table)} is now installed for its project; nothing was changed`,
              fix: REFUSED_FIX,
            },
          },
          removed: [],
          notes: [],
        };
  } finally {
    await client.close();
  }
}

export async function runPlan(
  dialect: SqlDialect,
  connect: PollingConnect,
  target: EngineTarget,
  plan: EnginePlan,
  url: string,
  options: RunOptions,
): Promise<RunResult> {
  const insecure = adminUrlRefusal(dialect, url, options.allowInsecure);
  if (insecure !== undefined) {
    return { ran: [], stopped: { at: 0, refusal: insecure }, removed: [], notes: [] };
  }
  if (plan.statements.length === 0) {
    return plan.confirm?.kind === "source"
      ? checkStillGone(dialect, connect, target, url)
      : { ran: [], removed: [], notes: plan.notes };
  }
  const { workerPassword } = options;
  const secrets: unknown[] = [url, workerPassword];
  const done: PlanStatement[] = [];
  const lock = dialect.lock?.(tableOf(dialect, target));
  const locks = lock !== undefined && plan.statements.some((statement) => statement.text === lock);
  // Where nothing locks the table and the dialect groups DDL (CockroachDB), the install's first
  // statement claims it: the mark is read again right after the claim, and after a claim that
  // failed (another run added facetdb_state_hash first), so the loser stops with the refusal.
  const claims = !locks && dialect.atomic !== undefined;
  let at = 0;
  let client: PollingClient | undefined;
  const work = async (query: PollingQuery): Promise<void> => {
    if (!locks) {
      await checkMark(dialect, query, target);
    }
    for (const [index, statement] of plan.statements.entries()) {
      at = index;
      const claim = claims && statement.purpose === "marker";
      try {
        if (statement.secret === true) {
          if (workerPassword === undefined || dialect.login === undefined) {
            throw new Stop(NO_PASSWORD);
          }
          const secret = dialect.login.secret(workerPassword);
          secrets.push(...secret.params);
          await query(secret.text, secret.params);
        } else {
          const inner = dialect.atomic?.inner(statement.text);
          await (inner === undefined || client === undefined
            ? query(statement.text)
            : client.transaction((grouped) => grouped(inner)));
        }
      } catch (error) {
        if (claim && !(error instanceof Stop)) {
          await checkMark(dialect, query, target);
        }
        throw error;
      }
      done.push(statement);
      if ((locks && statement.text === lock) || claim) {
        // The table is this run's until it commits: a mark read now is one another run committed.
        await checkMark(dialect, query, target);
      }
    }
  };
  try {
    client = connect(url);
    await (plan.transactional ? client.transaction(work) : work(client.query));
    return { ran: plan.statements, removed: plan.removes, notes: plan.notes };
  } catch (error) {
    // A transaction rolls back whole; without one, what ran before the stop stays. Nothing links
    // an object to a statement, so a stopped run reports none removed.
    return {
      ran: plan.transactional ? [] : done,
      stopped:
        error instanceof Stop
          ? { at, refusal: error.refusal }
          : { at, error: plainMessage(error, secrets) },
      removed: [],
      notes: [],
    };
  } finally {
    await client?.close();
  }
}
