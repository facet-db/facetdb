import type {
  EngineObject,
  EnginePlan,
  EngineTarget,
  PlanStatement,
  Refusal,
  RunOptions,
  RunResult,
} from "@facetdb/core";
import { adminUrlRefusal, plainMessage, tlsVerdict } from "../urls/index.ts";
import {
  type AdminClient,
  type AdminConnect,
  driverFloor,
  type ServerDocument,
  serverCode,
} from "./admin.ts";
import { readMarker, refusedHere } from "./catalog.ts";
import { anotherProjectWords, belowFloor, REFUSED_FIX, sourceDatabase } from "./install.ts";
import { byHandFix, byHandSteps } from "./login.ts";
import {
  bindCommand,
  type CommandDocument,
  holdsPassword,
  type MongoshLine,
  PASSWORD_PROMPT,
  parseLine,
} from "./mongosh.ts";
import { WORKER_USER } from "./objects.ts";

/**
 * `run`: the plan's lines against the admin connection string, in order and as printed. Each line
 * is read back into the command document the operator read (mongosh.ts) before anything runs, and
 * sent through the driver; the one value bound is the worker's password, into the one command
 * allowed to take it, the worker login's `createUser` (the `secret` statement, where the line
 * prints `passwordPrompt()`), so no plan, script or result ever holds it. MongoDB has no
 * transaction for these commands: a stop keeps what ran before it, and the same plan run again
 * completes it, because a command that finds its work already done (a collection or a role that
 * exists, one already gone) is taken as done. When MongoDB refuses the role or the login to this
 * admin (Atlas keeps them to its own pages), the run stops there, and its refusal's fix and its
 * notes carry the steps to make them by hand.
 */

/** What a run says when it reaches the plan's `secret` statement without a password. */
const NO_PASSWORD: Refusal = {
  code: "worker-password",
  message: "this plan sets the worker login's password, and the run was given none",
  fix: "set the source's connection string to the worker login with its password",
};

const DUPLICATE_KEY = 11000;

/**
 * The server's codes for a command whose work is already done: what `create`, `createRole` or
 * `createUser` would make exists (DuplicateKey on servers before their own codes), what `drop` or
 * `dropRole` would remove is gone. A login found there keeps its password (an existing login is not
 * reset), and the grant after it gives it the role all the same.
 */
const ALREADY_DONE: ReadonlyMap<string, readonly number[]> = new Map([
  ["create", [48]],
  ["createRole", [51002, DUPLICATE_KEY]],
  ["createUser", [51003, DUPLICATE_KEY]],
  ["drop", [26]],
  ["dropRole", [31]],
]);

/** The commands that make the worker's role and login: refused on Atlas, which keeps them to its pages. */
const LOGIN_COMMANDS: ReadonlySet<string> = new Set([
  "createRole",
  "updateRole",
  "createUser",
  "grantRolesToUser",
]);

/** Why a line stopped the run, and what the operator is told with it. */
type Stop = {
  readonly why: { readonly refusal: Refusal } | { readonly error: string };
  readonly notes: readonly string[];
};

/**
 * Whether a command is the one a `secret` statement may hold: the worker login's `createUser`
 * exactly as install prints it, the password's place and no role (the grant after it gives one).
 */
function isLoginCreation(command: CommandDocument): boolean {
  const roles = command["roles"];
  return (
    Object.keys(command).join(",") === "createUser,pwd,roles" &&
    command["createUser"] === WORKER_USER &&
    command["pwd"] === PASSWORD_PROMPT &&
    Array.isArray(roles) &&
    roles.length === 0
  );
}

/** Whether a line may run as the statement it is: the password's place in the secret one only. */
function holdsWhatItMay(line: MongoshLine, statement: PlanStatement): boolean {
  if (statement.secret === true) {
    return line.unlessAny === undefined && isLoginCreation(line.command);
  }
  return (
    !holdsPassword(line.command) &&
    (line.unlessAny === undefined || !holdsPassword(line.unlessAny.filter))
  );
}

/** The first write error of a reply, in the server's words, or undefined when there is none. */
function writeError(reply: ServerDocument): string | undefined {
  const errors = reply["writeErrors"];
  if (!Array.isArray(errors) || errors.length === 0) {
    return undefined;
  }
  const [first]: unknown[] = errors;
  return typeof first === "object" && first !== null && "errmsg" in first
    ? String(first.errmsg)
    : JSON.stringify(first);
}

/** One line: its guard, then its command; a stop, or undefined when its work is done. */
async function runLine(
  client: AdminClient,
  line: MongoshLine,
  statement: PlanStatement,
  target: EngineTarget,
  options: RunOptions,
  secrets: readonly (string | undefined)[],
): Promise<Stop | undefined> {
  if (line.unlessAny !== undefined) {
    const { collection, filter } = line.unlessAny;
    // Another collection still installed in the database uses what this line would drop.
    if ((await client.findOne(line.database, collection, bindCommand(filter))) !== null) {
      return undefined;
    }
  }
  const command = bindCommand(
    line.command,
    statement.secret === true ? options.workerPassword : undefined,
  );
  const [name = ""] = Object.keys(command);
  let reply: ServerDocument;
  try {
    reply = await client.command(line.database, command);
  } catch (error) {
    const code = serverCode(error);
    if (code !== undefined && ALREADY_DONE.get(name)?.includes(code) === true) {
      return undefined;
    }
    // The marker's query names the project: a duplicate key is another project's marker, written
    // since the plan was read. Nothing ran before it; the rest never runs. Postgres's run stops its
    // own owner check with the same code.
    if (statement.purpose === "marker" && code === DUPLICATE_KEY) {
      const owner = await readMarker(client, line.database, target.table);
      return {
        why: {
          refusal: {
            code: "another-project",
            message: anotherProjectWords(line.database, target.table, owner?.project),
            fix: REFUSED_FIX,
          },
        },
        notes: [],
      };
    }
    if (LOGIN_COMMANDS.has(name) && refusedHere(error)) {
      return {
        why: {
          refusal: {
            code: "users-refused",
            message: `MongoDB refused ${name} to the admin connection string (${plainMessage(error, secrets)}): Atlas makes roles and users only on its own pages, and another server needs an admin with userAdmin on ${line.database}; the commands before it ran and stay`,
            // The CLI prints a stopped run's refusal and not its notes: the steps are in both.
            fix: byHandFix(line.database, target.table),
          },
        },
        notes: byHandSteps(line.database, target.table),
      };
    }
    throw error;
  }
  // `update` and `delete` report a failed document with `ok: 1`, beside the ones that went through.
  const failed = writeError(reply);
  return failed === undefined
    ? undefined
    : { why: { error: `MongoDB refused ${name}: ${plainMessage(failed, secrets)}` }, notes: [] };
}

/**
 * Whether this run was its uninstall's last: every run-scoped object of the plan, the jobs and
 * marker collections, is gone because no collection needed it any more.
 */
async function lastOfRun(
  client: AdminClient,
  database: string,
  removes: readonly EngineObject[],
): Promise<boolean> {
  for (const object of removes) {
    if (object.scope !== "run") {
      continue;
    }
    if (
      object.kind !== "collection" ||
      (await client.listCollections(database, { name: object.name })).length > 0
    ) {
      return false;
    }
  }
  return true;
}

export async function runPlan(
  connect: AdminConnect,
  target: EngineTarget,
  plan: EnginePlan,
  url: string,
  options: RunOptions,
): Promise<RunResult> {
  const insecure = adminUrlRefusal(url, options.allowInsecure);
  if (insecure !== undefined) {
    return { ran: [], stopped: { at: 0, refusal: insecure }, removed: [], notes: [] };
  }
  // An uninstall's plan is the one that asks for a name back.
  const source = sourceDatabase(
    target,
    url,
    plan.confirm === undefined ? "migrate-refused" : "uninstall-refused",
  );
  if (!source.ok) {
    return { ran: [], stopped: { at: 0, refusal: source.refusal }, removed: [], notes: [] };
  }
  if (plan.statements.length === 0) {
    return { ran: [], removed: [], notes: plan.notes };
  }
  const secrets = [url, options.workerPassword];
  // Every line is read back before any runs: a plan that is not FacetDB's own printing runs nothing.
  const lines: { readonly statement: PlanStatement; readonly line: MongoshLine }[] = [];
  for (const [at, statement] of plan.statements.entries()) {
    let line: MongoshLine;
    try {
      line = parseLine(statement.text);
    } catch (error) {
      return {
        ran: [],
        stopped: { at, error: plainMessage(error, secrets) },
        removed: [],
        notes: [],
      };
    }
    if (!holdsWhatItMay(line, statement)) {
      return {
        ran: [],
        stopped: {
          at,
          error: `the plan's secret statement is the worker login's createUser of ${WORKER_USER} with no role, and passwordPrompt() belongs there and nowhere else`,
        },
        removed: [],
        notes: [],
      };
    }
    lines.push({ statement, line });
  }
  const verdict = tlsVerdict(url, options.allowInsecure);
  const done: PlanStatement[] = [];
  let at = 0;
  let client: AdminClient | undefined;
  try {
    client = connect(url, { forceTls: verdict.kind === "ok" && verdict.forceTls });
    for (const [index, { statement, line }] of lines.entries()) {
      at = index;
      if (statement.secret === true && options.workerPassword === undefined) {
        return { ran: done, stopped: { at, refusal: NO_PASSWORD }, removed: [], notes: [] };
      }
      const stop = await runLine(client, line, statement, target, options, secrets);
      if (stop !== undefined) {
        return { ran: done, stopped: { at, ...stop.why }, removed: [], notes: stop.notes };
      }
      done.push(statement);
    }
    const last = await lastOfRun(client, source.database, plan.removes);
    return {
      ran: plan.statements,
      removed: last ? plan.removes : plan.removes.filter((object) => object.scope === "source"),
      notes: plan.notes,
    };
  } catch (error) {
    // No transaction: what ran before the stop stays. Nothing links an object to a statement, so
    // a stopped run reports none removed. A server below the driver's floor is refused, in words.
    const floor = driverFloor(error);
    return {
      ran: done,
      stopped:
        floor === undefined
          ? { at, error: plainMessage(error, secrets) }
          : { at, refusal: belowFloor(url, floor) },
      removed: [],
      notes: [],
    };
  } finally {
    await client?.close();
  }
}
