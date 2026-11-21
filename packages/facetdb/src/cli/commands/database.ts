import { basename } from "node:path";
import {
  type DatabaseEngine,
  type EngineTarget,
  parseQuestionSet,
  type QuestionSet,
} from "@facetdb/core";
import { ConfigError, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import {
  checkActions,
  checkChannels,
  type PluginHost,
  PluginHostError,
} from "../../plugin/index.ts";
import { databaseOf, engineFor, schemeOf } from "../engines.ts";
import { type CliDeps, CliError, EXIT_USAGE } from "../program.ts";

/**
 * What the commands that reach a source share: the config, the sources that read a table, the
 * project they belong to, the engine target each one is (a command reaches a source's database
 * through its engine and nothing else), and the admin connection string (asked for, used for this
 * run, never stored).
 */

/** A project as an install marks it: its id marks the table, uninstall asks its name back. */
export type ProjectRef = EngineTarget["project"];

/** A source that reads a table, with the table split into schema and name. */
export type TableTarget = {
  readonly source: SourceConfig;
  /**
   * The schema the config names, `public` when it names none: Postgres's default. migrate and
   * uninstall name the table by `DatabaseEngine.label` instead, the engine's own spelling.
   */
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

/**
 * The plugin host of a loaded config, built when the config loads, so a plugin that is not
 * installed, a setting its schema refuses or a variable that is not set stops the command in the
 * host's words with their fix. The words name variables, never their values.
 */
export async function loadPluginHost(
  deps: CliDeps,
  config: ProjectConfig,
  path: string,
): Promise<PluginHost> {
  try {
    return await deps.pluginHost(config, path);
  } catch (error) {
    if (error instanceof PluginHostError) {
      throw new CliError(error.code, error.message, error.fix);
    }
    throw error;
  }
}

/**
 * The plugin host of a command that raises alerts beside the worker (`facetdb backfill`, `facetdb
 * test`), when it needs one: the host `provided` already built for a plugin's provider, else one
 * built now when the config names alert channels, whose plugins deliver what the command raises.
 * Every channel is checked as the worker checks it at its start; with no channel and no host given,
 * none is built, as before.
 */
export async function pluginHostForAlerts(
  deps: CliDeps,
  config: ProjectConfig,
  path: string,
  provided: PluginHost | undefined,
): Promise<PluginHost | undefined> {
  if ((config.alerts?.channels ?? []).length === 0) {
    return provided;
  }
  const plugins = provided ?? (await loadPluginHost(deps, config, path));
  try {
    checkChannels(config, plugins, deps.env);
  } catch (error) {
    if (error instanceof PluginHostError) {
      throw new CliError(error.code, error.message, error.fix);
    }
    throw error;
  }
  return plugins;
}

/**
 * The config a running worker starts from, and its plugin host: what `facetdb worker`, `facetdb
 * studio` and `facetdb dev` each load first, a dry run included, so the three refuse a bad plugin
 * setting alike before anything starts. Every source's actions are checked against the plugins the
 * host loaded too: an action its plugin does not provide, or settings its schema refuses.
 */
export async function loadWorkerConfig(
  deps: CliDeps,
  path: string,
): Promise<{ readonly config: ProjectConfig; readonly plugins: PluginHost }> {
  const config = await loadProjectConfig(deps, path);
  const plugins = await loadPluginHost(deps, config, path);
  try {
    checkActions(config, plugins, deps.env);
    // Each alert channel bound to its plugin's channel, refused here when it cannot be.
    checkChannels(config, plugins, deps.env);
  } catch (error) {
    if (error instanceof PluginHostError) {
      throw new CliError(error.code, error.message, error.fix);
    }
    throw error;
  }
  return { config, plugins };
}

/** `schema.table` names a schema; a bare name is in `public`. */
export function splitTable(table: string): { readonly schema: string; readonly table: string } {
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
      'add a source with table: "<name>" and database: env("DATABASE_URL") to facetdb.config.ts',
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
  // One run plans with one engine: a table watched by polling and one by its scheme's own engine
  // are run apart, or the second would get the first's capture.
  const connectors = new Set(targets.map((target) => target.source.connector ?? "scheme"));
  if (connectors.size > 1) {
    throw new CliError(
      "several-connectors",
      `the sources ${targets.map((target) => target.source.name).join(", ")} are watched in different ways (some with connector: "polling", some by their scheme's own engine), and one run plans with one engine`,
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

/** The environment variable a source's connection string was read from: what the words name. */
export function variableOf(source: SourceConfig): string {
  return source.databaseEnv ?? "DATABASE_URL";
}

/**
 * A table source as its engine sees it (`EngineTarget`): the schema only when the config names one,
 * so the engine's default applies to a bare name; the key from the engine's catalog; the variable
 * its words name.
 */
export function engineTarget(
  config: ProjectConfig,
  target: TableTarget,
  project: ProjectRef,
): EngineTarget {
  const named = (target.source.table ?? "").includes(".");
  return {
    project,
    source: target.source.name,
    table: target.table,
    ...(named ? { schema: target.schema } : {}),
    storage: target.source.storage,
    // Absent unless the config says: every engine but SQL Server's knows one capture.
    ...(target.source.capture === undefined ? {} : { capture: target.source.capture }),
    // Absent unless the config says: only the polling engine reads it.
    ...(target.source.lastChanged === undefined ? {} : { lastChanged: target.source.lastChanged }),
    onChange: target.source.onChange,
    questionSet: questionSetOf(config, target.source),
    urlVariable: variableOf(target.source),
  };
}

/** A table source as a command that reads it holds it: its engine, target, URL and its table's name. */
export type SourceTable = {
  readonly own: EngineTarget;
  /** The source's engine and connection string; absent when the string is unset here. */
  readonly reached?: { readonly engine: DatabaseEngine; readonly url: string };
  /**
   * The table as its engine names it (`DatabaseEngine.label`), as migrate's header does:
   * `public.listings` on Postgres, `app.listings` on MySQL. With the connection string unset here,
   * the table as the config writes it: no engine says what its default would be.
   */
  readonly label: string;
};

/**
 * A table source's engine, by its connection string's scheme or its `connector:` (nothing
 * connects, and nothing judges the string yet), and the name every line of the command gives the
 * table: what preview, backfill and explain print.
 */
export async function sourceTable(
  deps: Pick<CliDeps, "engines" | "projectDir">,
  config: ProjectConfig,
  target: TableTarget,
): Promise<SourceTable> {
  const own = engineTarget(config, target, projectRef(deps.projectDir));
  const url = target.source.database;
  if (url === undefined || url === "") {
    return { own, label: target.source.table ?? target.table };
  }
  const engine = await engineFor(deps.engines, url, target.source.connector);
  return { own, reached: { engine, url }, label: engine.label(own, url) };
}

/** A source's unset connection string, with the fix: `what` it should be set to. */
function noUrlError(source: SourceConfig, what: string): CliError {
  return new CliError(
    "database-url",
    `the source "${source.name}" has no connection string`,
    `set ${variableOf(source)} to ${what}`,
  );
}

/**
 * Whether the source's connection string was set where the loader read it: the variable
 * `variableOf` names, in the environment the process started with.
 */
export function hasUrl(source: Pick<SourceConfig, "database">): boolean {
  return source.database !== undefined && source.database !== "";
}

/** The source's connection string, or the fix when the config left it unset. */
export function sourceUrlOf(source: SourceConfig, what: string): string {
  const url = source.database;
  if (url === undefined || url === "") {
    throw noUrlError(source, what);
  }
  return url;
}

/** The engine and connection string of a table source, or the fix when the string is unset. */
export function reachedOf(
  table: SourceTable,
  source: SourceConfig,
  what: string,
): NonNullable<SourceTable["reached"]> {
  if (table.reached === undefined) {
    throw noUrlError(source, what);
  }
  return table.reached;
}

/**
 * Every saved version of a source's question set among `versions` (`explain` and `export` read the
 * history with the wording and thresholds of its own time). The store's rows are a boundary: a row
 * that no longer parses is an error that names the version, never a guess; a version the store does
 * not keep is simply absent from the map.
 */
export async function savedQuestionSets(
  deps: CliDeps,
  url: string,
  source: string,
  versions: readonly number[],
): Promise<ReadonlyMap<number, QuestionSet>> {
  const kept = new Map<number, QuestionSet>();
  if (versions.length === 0) {
    return kept;
  }
  const client = deps.connect(url);
  try {
    const rows = await client.query(
      "select version::text as version, question_set from facetdb.question_set_versions where source_id = $1 and version = any($2::int[])",
      [source, versions],
    );
    for (const row of rows) {
      const version = Number(row["version"]);
      const raw = row["question_set"];
      const parsed = parseQuestionSet(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (!parsed.ok) {
        throw new CliError(
          "question-set-version",
          `question set v${version} of "${source}" in the FacetDB store cannot be read: ${parsed.errors.join("; ")}`,
          "open an issue with this message; the store's saved versions are never edited by hand",
        );
      }
      kept.set(version, parsed.questionSet);
    }
    return kept;
  } finally {
    await client.close();
  }
}

/**
 * A failure's own words, ready for what is said after them once part of the run has committed (the
 * store's half): without the period they end with, and without the "nothing was run" or "nothing
 * was changed" that is no longer true of the run.
 */
export function withoutNothingDone(message: string): string {
  return message.replace(/([;,]? nothing was (run|changed))?\.?$/, "");
}

/** The `--allow-insecure` option, in the same words on every command that connects. */
export const ALLOW_INSECURE_OPTION = {
  flags: "--allow-insecure",
  description:
    "connect without TLS to a database on a network you trust (a remote host needs ?sslmode=require otherwise)",
} as const;

/**
 * The admin connection string: `--admin-url`, or asked for with the input hidden. It is handed to
 * the engine for this run and kept nowhere: not in a file, not in the output, not in an error. The
 * engine refuses it before it connects when it would carry the admin password to another machine
 * in the clear, unless `--allow-insecure` says the network is trusted.
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

/**
 * The engine a run of migrate or uninstall plans with, and the admin connection string it runs
 * under, in that order: the engine from the source's own connection string, so a scheme FacetDB
 * does not serve is refused before anyone types a credential; then the admin string. When the
 * scheme table reads both and they name different databases (a MySQL admin string for a Postgres
 * source), it is refused; a string the table does not read (a bare SQLite path with no extension, a
 * local libSQL server's `http://`) goes to the source's engine, whose words judge it. A source
 * whose connection string is unset here leaves the admin string alone to say which engine.
 */
export async function adminRun(
  deps: CliDeps,
  first: TableTarget,
  given: string | undefined,
): Promise<{ readonly engine: DatabaseEngine; readonly url: string }> {
  const source = first.source.database;
  if (source === undefined) {
    const url = await adminUrl(deps, given);
    return { engine: await engineFor(deps.engines, url, first.source.connector), url };
  }
  const engine = await engineFor(deps.engines, source, first.source.connector);
  const url = await adminUrl(deps, given);
  const admin = databaseOf(url);
  const own = databaseOf(source);
  if (admin !== undefined && own !== undefined && admin.key !== own.key) {
    const variable = variableOf(first.source);
    throw new CliError(
      "admin-url-scheme",
      `the admin connection string is ${admin.name}'s (${schemeOf(url)}:), and the source "${first.source.name}" reads ${own.name}'s (${schemeOf(source)}:) from ${variable}, so the two name different kinds of database; nothing was connected`,
      `give the admin connection string of the database ${variable} names, in the same form (${schemeOf(source)}:)`,
    );
  }
  return { engine, url };
}

/**
 * The worker login every engine creates (`facetdb_worker` on Postgres, MySQL and MongoDB alike), as
 * the words name it and the source's connection string logs in.
 */
export const WORKER_LOGIN = "facetdb_worker";

/** `facetdb_worker`, or `facetdb_worker.<suffix>` with one dot and a suffix of letters, digits, `_`, `-`. */
const WORKER_USER = new RegExp(`^${WORKER_LOGIN}(?:\\.([A-Za-z0-9_-]+))?$`);

/**
 * The worker login a connection string's user names (decoded, as the source's engine reads it). A
 * connection pooler routes by the user (Supabase's session pooler wants
 * `facetdb_worker.<project ref>`) while Postgres still reports the role as `facetdb_worker`, so the
 * user is the role alone or the role plus a pooler suffix: this returns the suffix (undefined for
 * the role alone). Any other user, `postgres.<ref>` (the admin through the pooler) included, is not
 * the worker login: `undefined` instead of an object. It reads only the user; whether the login
 * really is the worker's is `current_user`'s to say (doctor asks it).
 */
export function workerLoginOf(user: string): { readonly suffix: string | undefined } | undefined {
  const match = WORKER_USER.exec(user);
  return match === null ? undefined : { suffix: match[1] };
}
