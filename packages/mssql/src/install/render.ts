import type { EnginePlan } from "@facetdb/core";

/**
 * A plan as one script, exactly as the CLI prints it before running it. Each statement is its own
 * batch, ended by `go` as sqlcmd and SSMS read it (`create trigger` must begin a batch), and is the
 * very text `run` executes. The frame is what `run` does through the driver: one transaction,
 * `xact_abort` on, so a failed statement rolls all of it back, as the first line says; and the
 * settings a trigger keeps from its creation, set as tedious sets them, so a trigger created by
 * hand behaves as one created by `run`.
 *
 * Run by hand, a failed batch does not stop every tool: SSMS and Azure Data Studio go on to the next
 * batch, which after the rollback would commit on its own. So each statement is preceded by a guard
 * batch, `if @@trancount = 0 set noexec on;`: once a failure rolled the transaction back, every
 * later batch, the commit included, is compiled and not run. It works in every tool and mode, where
 * sqlcmd's `-b` and SQLCMD mode's `:on error exit` each cover one (and `:on error exit` is a syntax
 * error outside SQLCMD mode). A compile error rolls nothing back: the one a plan can hit by hand is
 * the `secret` statement's undeclared `@p1`, and the worker's grants right after it then fail, the
 * worker not existing, which rolls the transaction back and lets the guards do the rest.
 */

/** What the first line of every transactional script says, before anything else. */
export const ONE_TRANSACTION =
  "-- FacetDB runs this script as one transaction: if a statement fails, all of it rolls back and nothing is changed.";

const HAND_RUN =
  "-- Run by hand (sqlcmd, SSMS), a check before each statement skips the rest once one failed; then run set noexec off.";

/** The guard batch before each statement and before the commit. */
const GUARD = "if @@trancount = 0 set noexec on;\ngo\n";

const OPEN = [
  ONE_TRANSACTION,
  HAND_RUN,
  "set xact_abort on;",
  "set ansi_nulls on;",
  "set quoted_identifier on;",
  "begin transaction;",
  "go",
].join("\n");

const CLOSE = "commit transaction;\ngo\n";

/** A plan whose run keeps what ran before a failure: no engine of this package makes one. */
const STATEMENT_BY_STATEMENT =
  "-- FacetDB runs this script statement by statement: if one fails, what ran before it stays, and running the script again completes it.";

/** The script of a plan; empty when it has no statement. */
export function render(plan: EnginePlan): string {
  if (plan.statements.length === 0) {
    return "";
  }
  if (!plan.transactional) {
    const batches = plan.statements.map((statement) => `${statement.text};\ngo\n`).join("\n");
    return `${STATEMENT_BY_STATEMENT}\n\n${batches}`;
  }
  const guarded = plan.statements
    .map((statement) => `${GUARD}\n${statement.text};\ngo\n`)
    .join("\n");
  return `${OPEN}\n\n${guarded}\n${GUARD}\n${CLOSE}`;
}
