import type { EngineTarget, Refusal } from "@facetdb/core";
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

/** A run that reaches the plan's `secret` statement without a password. */
export const NO_PASSWORD: Refusal = {
  code: "worker-password",
  message: "this plan sets the worker login's password, and the run was given none",
  fix: "set the source's connection string to the worker login with its password",
};
