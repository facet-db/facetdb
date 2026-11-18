import { EngineRefusal, type EngineTarget, type PlanResult, type Refusal } from "@facetdb/core";
import { TLS_PARAMETER } from "../sql/index.ts";
import {
  JOBS_TABLE,
  NAME_LIMIT,
  RECORD_KEY_LENGTH,
  WORKER_ACCOUNT,
  WORKER_HOST,
  WORKER_USER,
} from "./sql.ts";

/**
 * Why a plan will not go on, in plain words with the fix. Where the concept is Postgres's too, the
 * code, the fix and the words are the Postgres engine's (`migrate-refused`, `uninstall-refused`,
 * `prune-refused`, the message saying what to change), so the CLI and the docs read one code for
 * one concept whatever the engine; MySQL's own concepts have codes of their own, each with its fix.
 * A refusal carries no statement, so nothing runs.
 */

/** The Postgres engine's fix of a plan's refusal (packages/postgres/src/engine/plans.ts). */
export const REFUSED_FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

export function installRefused(message: string): Refusal {
  return { code: "migrate-refused", message, fix: REFUSED_FIX };
}

export function uninstallRefused(message: string): Refusal {
  return { code: "uninstall-refused", message, fix: REFUSED_FIX };
}

export function pruneRefused(message: string): Refusal {
  return { code: "prune-refused", message, fix: REFUSED_FIX };
}

/** How the words name the source's connection string when no variable is known. */
const SOURCE_URL = "the source's connection string";

/** The source's connection string as the words name it: its variable, else `SOURCE_URL`. */
export function subjectOf(target: Pick<EngineTarget, "urlVariable">): string {
  return target.urlVariable ?? SOURCE_URL;
}

/** One table belongs to one project, in the Postgres engine's words. */
export function anotherProject(label: string, owner: string): string {
  return `${label} already carries FacetDB columns from another project (${owner}); one table belongs to one project. Uninstall there first, or point this project at another table.`;
}

/** The contract's own code: the CLI words it from the source's connection string. */
export function workerLoginRefusal(target: EngineTarget): Refusal {
  return {
    code: "worker-login",
    message: `the worker login ${WORKER_USER} does not exist yet, and no password was given to create it with`,
    fix: `put the worker login and a long random password in ${subjectOf(target)}: mysql://${WORKER_USER}:<a long random password>@<host>:3306/<database>?${TLS_PARAMETER}; the install creates the login with that password`,
  };
}

/**
 * Accounts of the worker's name for other hosts. MySQL matches a connection to the account with
 * the most specific host, so one for `localhost` would take the worker's logins from there and run
 * them without FacetDB's rights; install adds no second account of the name.
 */
export function workerHostRefusal(hosts: readonly string[]): Refusal {
  const others = hosts.filter((host) => host !== WORKER_HOST);
  const accounts = others.map((host) => `'${WORKER_USER}'@'${host}'`).join(", ");
  return {
    code: "worker-host",
    message: hosts.includes(WORKER_HOST)
      ? `this server has ${accounts} beside ${WORKER_ACCOUNT}; MySQL logs a connection from a matching host in as the more specific account, which has none of the rights FacetDB gives ${WORKER_ACCOUNT}`
      : `this server has ${accounts} and no ${WORKER_ACCOUNT}; FacetDB's worker login is ${WORKER_ACCOUNT}, and install adds no second account of the name`,
    fix: `drop ${accounts} (drop user ${accounts}) if nothing else uses ${others.length === 1 ? "it" : "them"}, then run facetdb migrate again`,
  };
}

export function noDatabaseRefusal(target: EngineTarget): Refusal {
  return {
    code: "no-database",
    message: `the admin connection string names no database, and the source names no database for the table ${target.table}`,
    fix: `add the database to the admin connection string (mysql://user:password@host:3306/<database>), or name the table as <database>.${target.table} in the config`,
  };
}

export function backslashModeRefusal(): Refusal {
  return {
    code: "sql-mode",
    message:
      "this server's sql_mode includes NO_BACKSLASH_ESCAPES, under which a backslash in a quoted value is a plain character; mysql2, the driver FacetDB uses, escapes the values it sends (the worker password, the worker's answers) with backslashes, so they would be stored wrong; nothing was changed",
    fix: "remove NO_BACKSLASH_ESCAPES from the server's sql_mode (its option file, or the parameter group of a managed server), then run facetdb migrate again",
  };
}

/**
 * The script creates the login, then grants it rights. Run by hand by a client that goes on past an
 * error (`source`, a paste), the `create user` fails at its placeholder, and on MariaDB without
 * NO_AUTO_CREATE_USER the first grant creates the login with no password, which nothing repairs
 * later (install keeps an existing login's password). MySQL 8 never creates a user from a grant.
 */
export function autoCreateUserRefusal(): Refusal {
  return {
    code: "sql-mode",
    message: `this MariaDB server's sql_mode lacks NO_AUTO_CREATE_USER, under which a grant to an account that does not exist creates it with no password: the printed script creates ${WORKER_ACCOUNT} and then grants it rights, so run by hand past a failed create user it would leave the login open; nothing was changed`,
    fix: "add NO_AUTO_CREATE_USER to the server's sql_mode (it is in MariaDB's default), then run facetdb migrate again",
  };
}

/**
 * Creating a trigger with binary logging on needs SUPER or `log_bin_trust_function_creators` (error
 * 1419); refused before anything runs, rather than stopped at the first trigger.
 */
export function binaryLoggingRefusal(): Refusal {
  return {
    code: "log-bin",
    message:
      "this server logs binary changes and has log_bin_trust_function_creators off, so it lets only an account with the SUPER privilege create triggers, and the account of the admin connection string has none: the install would stop at its first trigger; nothing was changed",
    fix: "set log_bin_trust_function_creators to 1 (on RDS, in the instance's parameter group; on Cloud SQL, as a database flag), or run facetdb migrate as an account with SUPER, then run it again",
  };
}

export function notATableRefusal(label: string, type: string): Refusal {
  return {
    code: "not-a-table",
    message: `${label} is a ${type.toLowerCase()}, not a table; FacetDB puts its columns and triggers on a base table`,
    fix: "point the source at the table it reads",
  };
}

/**
 * Side-table mode names its table `facetdb_<table>_answers`, 16 characters more than the table's
 * own name, within MySQL's 64.
 */
export function sideNameTooLongRefusal(table: string, most: number): Refusal {
  return {
    code: "name-too-long",
    message: `the table name ${table} has ${table.length} characters; side-table mode keeps the answers in facetdb_<table>_answers, and MySQL allows ${NAME_LIMIT} characters in a name, so a table name can have ${most} at most`,
    fix: `rename the table to ${most} characters or fewer, or set storage "inline" for this source, then run facetdb migrate again`,
  };
}

export function nameTooLongRefusal(table: string): Refusal {
  const most = NAME_LIMIT - "facetdb__ins".length;
  return {
    code: "name-too-long",
    message: `the table name ${table} has ${table.length} characters; FacetDB names its triggers facetdb_<table>_new, _ins and _upd, and MySQL allows ${NAME_LIMIT} characters in a name, so a table name can have ${most} at most`,
    fix: `rename the table to ${most} characters or fewer, then run facetdb migrate again`,
  };
}

/** A key the queue cannot keep as the text of it (`RECORD_KEY_LENGTH`). */
export function queueKeyRefusal(message: string): Refusal {
  return {
    code: "queue-key",
    message,
    fix: `use an integer, char or varchar key of at most ${RECORD_KEY_LENGTH} characters (a uuid as char(36) rather than binary(16))`,
  };
}

/**
 * A table of the queue's name that is not the queue (an older FacetDB's, or one of the
 * application's): the triggers would write into it, and the application's writes fail with them.
 */
export function jobsTableRefusal(schema: string, lacks: readonly string[]): Refusal {
  return {
    code: "jobs-table",
    message: `${schema}.${JOBS_TABLE} exists and is not the queue this FacetDB makes: ${lacks.join("; ")}`,
    fix: `drop or rename ${schema}.${JOBS_TABLE} if no FacetDB install uses it (an earlier version may have left it), then run facetdb migrate again`,
  };
}

export function triggerNameRefusal(label: string, name: string, other: string): Refusal {
  return {
    code: "trigger-name",
    message: `a trigger named ${name} is already on ${other}; it is the name FacetDB gives a trigger of ${label}`,
    fix: "rename that trigger, then run facetdb migrate again",
  };
}

/** The `mysql` schema's grant tables a plan reads as the admin. */
export type GrantTable = "user" | "tables_priv";

/** What a plan reads each grant table for, in the refusal's words. */
const GRANT_TABLE_USE: Readonly<Record<GrantTable, string>> = {
  user: `to find every account named ${WORKER_USER} (and MariaDB's roles) before it creates or keeps the worker login`,
  tables_priv:
    "to find which accounts hold rights on the table, its side table and its view (install grants the view to the table's readers; uninstall and prune take those rights back)",
};

/**
 * An admin that may create users but not read `mysql.user`: error 1142 at the plan's first read,
 * said as the right to grant rather than the driver's words.
 */
export function grantTableRefusal(table: GrantTable): Refusal {
  return {
    code: "admin-rights",
    message: `the account of the admin connection string may not read mysql.${table} (error 1142); FacetDB reads it ${GRANT_TABLE_USE[table]}, and plans nothing it cannot see; nothing was changed`,
    fix: `grant the admin account select on mysql.${table} (grant select on mysql.${table} to <the admin account>, run by an account that may), or use an admin account that has it, then run the command again`,
  };
}

/**
 * Binary logging in STATEMENT format: InnoDB refuses every write of a `read committed` session
 * under it (error 1665), the level the worker's sessions run at. doctor fails it, install refuses
 * it, in the same words.
 */
export const STATEMENT_FORMAT_PROBLEM =
  "binary logging is on with binlog_format = STATEMENT, under which InnoDB refuses the worker's writes in its read committed sessions (error 1665), so every claim, write and ack would fail";

/** The fix of `STATEMENT_FORMAT_PROBLEM`, then the command to run again. */
export function statementFormatFix(then: string): string {
  return `set binlog_format to ROW or MIXED (MySQL 8's default is ROW), then run ${then} again`;
}

export function statementFormatRefusal(): Refusal {
  return {
    code: "binlog-format",
    message: `${STATEMENT_FORMAT_PROBLEM}; nothing was changed`,
    fix: statementFormatFix("facetdb migrate"),
  };
}

/** Why a state type cannot be read as text: its value is bytes, or a spatial value. */
export type NotText = "bytes" | "spatial";

/** What each kind holds and why its text would not tell two values apart, in the refusal's words. */
const NOT_TEXT_WORDS: Readonly<Record<NotText, { readonly holds: string; readonly why: string }>> =
  {
    bytes: { holds: "bytes", why: "bytes that are not text read alike" },
    spatial: {
      holds: "a spatial value",
      why: "MySQL reads a spatial value as text as NULL whatever it is, and MariaDB refuses to (error 4079)",
    },
  };

/**
 * A state field whose value is not text: the worker reads a state field as utf8mb4 text to hash it
 * and send it to the model. Bytes that are not utf8mb4 read as the same replacement characters, and
 * a spatial value reads as NULL on MySQL 8 (MariaDB fails the read), so two values could hash alike
 * and a stale answer be written over a changed row.
 */
export function stateTypeRefusal(
  label: string,
  fields: readonly { readonly name: string; readonly type: string; readonly kind: NotText }[],
): Refusal {
  const named = fields.map((field) => `${field.name} (${field.type})`).join(", ");
  const kinds = (["bytes", "spatial"] as const).filter((kind) =>
    fields.some((field) => field.kind === kind),
  );
  const holds = kinds.map((kind) => NOT_TEXT_WORDS[kind].holds).join(" or ");
  const why = kinds.map((kind) => NOT_TEXT_WORDS[kind].why).join(", and ");
  return {
    code: "state-type",
    message: `${label}: the state field ${named} holds ${holds}, not text; FacetDB reads a state field as utf8mb4 text to hash it and to send it to the model, and ${why}, so a changed value could keep its hash and a stale answer be written over it`,
    fix: "remove it from the source's read in the config and name the text, number or time columns the model reads, then run facetdb migrate again",
  };
}

/**
 * An inline install on a table installed in side-table mode, as SQL Server's install refuses it:
 * the answers would be kept twice, on the table and in the side table.
 */
export function inlineOverSideRefusal(label: string, sideLabel: string): Refusal {
  return {
    code: "storage-mode",
    message: `${label} is installed in side-table mode (its answers are in ${sideLabel}); installing inline would keep a second copy of them on the table`,
    fix: 'uninstall first (facetdb uninstall with storage "side-table"), or keep storage "side-table" for the source in facetdb.config.ts',
  };
}

/**
 * A plan's reads as one result: a refusal a read throws (`readGrantTable`) is the plan's refusal,
 * returned as the contract's other refusals are, with nothing planned and nothing run.
 */
export async function refusing(work: () => Promise<PlanResult>): Promise<PlanResult> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof EngineRefusal) {
      return { ok: false, refusal: error.refusal };
    }
    throw error;
  }
}

/** A run that reaches the plan's `secret` statement without a password. */
export const NO_PASSWORD: Refusal = {
  code: "worker-password",
  message: "this plan sets the worker login's password, and the run was given none",
  fix: "set the source's connection string to the worker login with its password",
};
