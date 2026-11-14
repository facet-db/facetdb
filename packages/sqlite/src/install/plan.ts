import type { EnginePlan, PlanResult, Refusal } from "@facetdb/core";

/**
 * The words every SQLite plan shares with Postgres's for the same situations (the engine plans), so
 * the CLI says one thing whatever the database: the codes `migrate-refused`, `uninstall-refused`,
 * `prune-refused` and `another-project`, and one fix.
 */

/** The fix of every refusal of a plan, as the CLI words Postgres's. */
export const REFUSED_FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

/**
 * The fix of a refusal that stops a run after its journal mode was set: that change stays (it ran
 * before the transaction, and it is persistent), and only it.
 */
export const REFUSED_AFTER_WAL_FIX =
  "change the table or the config as the message says, then run the command again; the file was put in WAL mode, which stays, and nothing else was changed";

export function refusal(code: string, message: string): Refusal {
  return { code, message, fix: REFUSED_FIX };
}

export function refused(code: string, message: string): PlanResult {
  return { ok: false, refusal: refusal(code, message) };
}

/** When another project claimed the table first: Postgres's words. */
export function anotherProject(table: string, owner: string): string {
  return `${table} already carries FacetDB columns from another project (${owner}); one table belongs to one project. Uninstall there first, or point this project at another table.`;
}

/** A plan with nothing to do: a prune of a source not installed yet. */
export const NOTHING: EnginePlan = {
  statements: [],
  transactional: true,
  removes: [],
  keeps: [],
  notes: [],
};
