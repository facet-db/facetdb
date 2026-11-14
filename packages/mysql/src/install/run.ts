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
  driverLiteral,
  type MysqlConnect,
  type MysqlQuery,
  plainMessage,
  quoteIdent,
  quoteTable,
} from "../sql/index.ts";
import { INSTALL_RERUN_NOTE } from "./install.ts";
import { PRUNE_RERUN_NOTE } from "./prune.ts";
import { anotherProject, NO_PASSWORD, REFUSED_FIX } from "./refusals.ts";
import { JOBS_TABLE, OWNER_GUARD_COMMENT, OWNERS_TABLE } from "./sql.ts";
import { UNINSTALL_RERUN_NOTE } from "./uninstall.ts";

/**
 * `run` on MySQL and MariaDB: the plan's statements against the admin URL, in order and as printed,
 * one statement per call on one connection. MySQL commits each DDL statement as it runs, so there
 * is no transaction to roll back: a stop reports where it stopped, what ran before it stays, and
 * planning again completes it. The one statement whose run is not its printed text is the
 * `secret` one: the driver writes the password in place of its `?`, and neither the password nor
 * its escaped form is ever in a plan, a script or a result; a failure there is told by its number
 * and code alone. The checks that need no connection (the TLS rule, a password for the login the
 * plan creates) stop the run before its first statement, so nothing changes.
 */

/** The notes a plan carries for a run that stops part way: a finished run has no use for them. */
const RERUN_NOTES: ReadonlySet<string> = new Set([
  INSTALL_RERUN_NOTE,
  UNINSTALL_RERUN_NOTE,
  PRUNE_RERUN_NOTE,
]);

/** MySQL's `ER_SUBQUERY_NO_1_ROW`: the owner guard's way of stopping the script. */
const SUBQUERY_ROWS = 1242;

/** The server's error number, read off the driver's error (a boundary). */
function errorNumber(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("errno" in error)) {
    return undefined;
  }
  return typeof error.errno === "number" ? error.errno : undefined;
}

/** The server's error code (`ER_PARSE_ERROR`), read off the driver's error (a boundary). */
function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * A failure of the `secret` statement in its number and code alone: the server's words can quote
 * the statement near the error (a parse error quotes 80 characters of it), the escaped password
 * among them, in a form no blanking can be sure to find.
 */
function secretFailure(error: unknown): string {
  const named = [errorNumber(error), errorCode(error)].filter((part) => part !== undefined);
  return `creating the worker login failed${named.length === 0 ? "" : ` with error ${named.join(" ")}`}; the server's words are not shown, since they can quote the password`;
}

/** The schema the plan named its objects in: the target's, or the database the URL names. */
async function schemaOf(query: MysqlQuery, target: EngineTarget): Promise<string | undefined> {
  if (target.schema !== undefined) {
    return target.schema;
  }
  const value = (await query("select database() as name"))[0]?.["name"];
  return value === null || value === undefined ? undefined : String(value);
}

/**
 * The owner guard's stop as the refusal it is, with the project that claimed the table since the
 * plan was read, under the code and words the Postgres engine's run gives it; undefined for any
 * other failure, or when the owner cannot be read back.
 */
async function guardRefusal(
  query: MysqlQuery,
  target: EngineTarget,
  statement: PlanStatement,
  error: unknown,
): Promise<Refusal | undefined> {
  if (!statement.text.startsWith(OWNER_GUARD_COMMENT) || errorNumber(error) !== SUBQUERY_ROWS) {
    return undefined;
  }
  try {
    const schema = await schemaOf(query, target);
    if (schema === undefined) {
      return undefined;
    }
    const [row] = await query(
      `select ${quoteIdent("project_id")} as project_id from ${quoteTable(schema, OWNERS_TABLE)} where ${quoteIdent("table_name")} = ?`,
      [target.table],
    );
    return row === undefined
      ? undefined
      : {
          code: "another-project",
          message: anotherProject(`${schema}.${target.table}`, String(row["project_id"])),
          fix: REFUSED_FIX,
        };
  } catch {
    // The connection the guard's stop came on may be gone: the stop is reported as its error.
    return undefined;
  }
}

/**
 * Whether this run was its uninstall's last: every run-scoped object of the plan is gone. The
 * cleanup drops the queue and the marker only once no table uses them, so a run that left them for
 * another table reports its own objects alone.
 */
async function lastOfRun(
  query: MysqlQuery,
  target: EngineTarget,
  removes: readonly EngineObject[],
): Promise<boolean> {
  const shared = removes.filter((object) => object.scope === "run");
  if (shared.length === 0) {
    return true;
  }
  const schema = await schemaOf(query, target);
  if (schema === undefined) {
    return false;
  }
  for (const object of shared) {
    const table = object.kind === "jobs-table" ? JOBS_TABLE : OWNERS_TABLE;
    const rows = await query(
      "select count(*) as n from information_schema.tables where table_schema = ? and table_name = ?",
      [schema, table],
    );
    if (Number(rows[0]?.["n"] ?? 0) > 0) {
      return false;
    }
  }
  return true;
}

export async function runPlan(
  connect: MysqlConnect,
  target: EngineTarget,
  plan: EnginePlan,
  url: string,
  options: RunOptions,
): Promise<RunResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure);
  if (insecure !== undefined) {
    return { ran: [], stopped: { at: 0, refusal: insecure }, removed: [], notes: [] };
  }
  const finished = plan.notes.filter((note) => !RERUN_NOTES.has(note));
  if (plan.statements.length === 0) {
    return { ran: [], removed: [], notes: finished };
  }
  const password = options.workerPassword;
  if (password === undefined && plan.statements.some((statement) => statement.secret === true)) {
    return { ran: [], stopped: { at: 0, refusal: NO_PASSWORD }, removed: [], notes: [] };
  }
  const secrets = [
    url,
    password,
    ...(password === undefined ? [] : [driverLiteral(password).slice(1, -1)]),
  ];
  const ran: PlanStatement[] = [];
  const client = connect(url);
  try {
    for (const [at, statement] of plan.statements.entries()) {
      try {
        await client.query(statement.text, statement.secret === true ? [password] : undefined);
      } catch (error) {
        const refusal = await guardRefusal(client.query, target, statement, error);
        const words =
          statement.secret === true ? secretFailure(error) : plainMessage(error, secrets);
        return {
          ran,
          stopped: refusal === undefined ? { at, error: words } : { at, refusal },
          removed: [],
          notes: plan.notes,
        };
      }
      ran.push(statement);
    }
    const last = await lastOfRun(client.query, target, plan.removes);
    return {
      ran,
      removed: last ? plan.removes : plan.removes.filter((object) => object.scope === "source"),
      notes: finished,
    };
  } finally {
    await client.close();
  }
}
