import { basename } from "node:path";
import type { QuestionSet } from "@facetdb/core";
import { type ProjectRef, WORKER_ROLE } from "@facetdb/postgres";
import { ConfigError, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import { type CliDeps, CliError, EXIT_USAGE } from "../program.ts";

/**
 * What `migrate` and `uninstall` share: the config, the sources that read a table, the project they
 * belong to, the admin connection string (asked for, used for this run, never stored), and the guard
 * that makes the SQL run exactly the SQL printed.
 */

/** A source that reads a table, with the table split into schema and name. */
export type TableTarget = {
  readonly source: SourceConfig;
  readonly schema: string;
  readonly table: string;
};

export async function loadProjectConfig(deps: CliDeps, path: string): Promise<ProjectConfig> {
  try {
    return await deps.loadConfig(path);
  } catch (error) {
    if (error instanceof ConfigError) {
      throw new CliError(
        "config",
        error.message,
        `do what each line above says in ${path}, then run the command again`,
      );
    }
    throw error;
  }
}

/** `schema.table` names a schema; a bare name is in `public`. */
function splitTable(table: string): { readonly schema: string; readonly table: string } {
  const dot = table.indexOf(".");
  return dot === -1
    ? { schema: "public", table }
    : { schema: table.slice(0, dot), table: table.slice(dot + 1) };
}

/**
 * The sources that read a table, or the one `--source` names. API sources keep their answers in the
 * FacetDB store and have nothing to install. One admin connection reaches one database, so sources
 * behind different connection strings are run one at a time with `--source`.
 */
export function tableTargets(
  config: ProjectConfig,
  only: string | undefined,
): readonly TableTarget[] {
  if (only !== undefined && !config.sources.some((source) => source.name === only)) {
    throw new CliError(
      "unknown-source",
      `the config has no source named "${only}"`,
      `pass one of: ${config.sources.map((source) => source.name).join(", ")}`,
      EXIT_USAGE,
    );
  }
  const targets = config.sources
    .filter((source) => only === undefined || source.name === only)
    .flatMap((source) =>
      source.table === undefined ? [] : [{ source, ...splitTable(source.table) }],
    );
  if (targets.length === 0) {
    throw new CliError(
      "no-table-source",
      only === undefined
        ? "no source in the config reads a table, so there is nothing to install"
        : `the source "${only}" does not read a table (an API source keeps its answers in the FacetDB store)`,
      'add a source with table: "<name>" and database: process.env.DATABASE_URL to facetdb.config.ts',
    );
  }
  const databases = new Set(targets.map((target) => target.source.database ?? ""));
  if (databases.size > 1) {
    throw new CliError(
      "several-databases",
      `the sources ${targets.map((target) => target.source.name).join(", ")} live in different databases, and one admin connection reaches one of them`,
      "run the command once per source with --source <name>",
      EXIT_USAGE,
    );
  }
  return targets;
}

/**
 * The one table source a command that reads or answers rows works on: the one `--source` names, or
 * the only one the config has. Several and no `--source` is a bad invocation that lists the names.
 */
export function singleTarget(config: ProjectConfig, only: string | undefined): TableTarget {
  const targets = tableTargets(config, only);
  const [first] = targets;
  if (first === undefined || targets.length > 1) {
    throw new CliError(
      "which-source",
      `the config has ${targets.length} sources that read a table, and this command works on one`,
      `pass --source with one of: ${targets.map((target) => target.source.name).join(", ")}`,
      EXIT_USAGE,
    );
  }
  return first;
}

/**
 * The project the install belongs to. The config does not name the project yet, so the project
 * directory's name is both its name and its id: it is what `uninstall` asks to have typed back.
 */
export function projectRef(projectDir: string): ProjectRef {
  const name = basename(projectDir);
  return { id: name, name };
}

/** The question set the install SQL is generated from, as the worker will see it. */
export function questionSetOf(config: ProjectConfig, source: SourceConfig): QuestionSet {
  return {
    questions: source.questions,
    read: source.read,
    model: source.model ?? config.model,
    thresholds: source.thresholds,
    ...(source.where === undefined ? {} : { where: source.where }),
  };
}

/**
 * The admin connection string: `--admin-url`, or asked for with the input hidden. It is handed to
 * the connector for this run and kept nowhere: not in a file, not in the output, not in an error.
 */
export async function adminUrl(deps: CliDeps, given: string | undefined): Promise<string> {
  const url =
    given ??
    (await deps.io.prompt("Admin connection string (used for this run only, never stored): ", {
      secret: true,
    }));
  if (url.trim() === "") {
    throw new CliError(
      "admin-url",
      "no admin connection string was given",
      "pass --admin-url, or type the connection string of a role that may alter the table when asked",
    );
  }
  return url.trim();
}

/** `facetdb_worker`, or `facetdb_worker.<suffix>` with one dot and a suffix of letters, digits, `_`, `-`. */
const WORKER_LOGIN = new RegExp(`^${WORKER_ROLE}(?:\\.([A-Za-z0-9_-]+))?$`);

/**
 * The worker login a connection string names. A connection pooler routes by the user (Supabase's
 * session pooler wants `facetdb_worker.<project ref>`) while Postgres still reports the role as
 * `facetdb_worker`, so the user is the role alone or the role plus a pooler suffix. Any other user,
 * `postgres.<ref>` (the admin through the pooler) included, is not the worker login: `undefined`.
 */
export function workerLoginOf(
  url: string,
): { readonly role: string; readonly suffix: string | undefined } | undefined {
  let username: string;
  try {
    username = decodeURIComponent(new URL(url).username);
  } catch {
    return undefined;
  }
  const match = WORKER_LOGIN.exec(username);
  return match === null ? undefined : { role: WORKER_ROLE, suffix: match[1] };
}

/** Where a connection string points, without its user or password: what a confirmation names. */
export function databaseLabel(url: string): string {
  try {
    const parsed = new URL(url);
    const name = parsed.pathname.replace(/^\//, "");
    return name === "" ? parsed.host : `${parsed.host}/${name}`;
  } catch {
    return "the database";
  }
}

/**
 * The print callback of the run that executes: the connectors call it with the script they are
 * about to run, before anything runs. A script that differs from the one shown means the database
 * changed in between, so it throws, and the connector runs nothing.
 */
export function sameAsShown(shown: string): (sql: string) => void {
  return (sql) => {
    if (sql !== shown) {
      throw new CliError(
        "database-changed",
        "the database changed after the SQL was shown, so the SQL to run is no longer the SQL you saw; nothing was run",
        "run the command again to see the SQL for the database as it is now",
      );
    }
  };
}

/** The connector's own reason for refusing (it already says what to do), as an error to print. */
export function refused(code: string, reason: string): CliError {
  return new CliError(
    code,
    reason,
    "change the table or the config as the message says, then run the command again; nothing was changed",
  );
}
