import {
  createPreviewService,
  type DatabaseEngine,
  DEFAULT_BACKFILL_PACE,
  type EngineDeps,
  type EnginePlan,
  EngineRefusal,
  type EngineTarget,
  ESTIMATE_SAMPLE_SIZE,
  estimateBackfill,
  type ModelProvider,
  PreviewModelError,
  type ReadRow,
  type ReadRowsResult,
  type SpendingGate,
} from "@facetdb/core";
import {
  hideSecrets,
  type InspectOutcome,
  type ReloadSummary,
  type SetupDoor,
  type SetupInstallOutcome,
  type SetupPlanOutcome,
  type SetupPreviewOutcome,
  type SetupRefused,
  type SourceDraft,
  secretParts,
} from "@facetdb/server";
import {
  type ApplyPlan,
  apply,
  ConfigError,
  type ConfigFiles,
  type ConnectorChoice,
  judgeDraftSource,
  type ProjectConfig,
  planApply,
  type SourceConfig,
  uncommittedWords,
} from "../../config/index.ts";
import { databaseOf, engineFor, readsUrl, schemeOf } from "../engines.ts";
import { type CliDeps, CliError } from "../program.ts";
import {
  requireStoreUrl,
  STORE_SECRET_VARIABLE,
  sameDatabase,
  showStoreMigration,
  storeSharedFor,
} from "../store-door.ts";
import {
  engineTarget,
  type ProjectRef,
  splitTable,
  type TableTarget,
  tableTargets,
  variableOf,
} from "./database.ts";
import { installPrintout, passwordOf, planInstall } from "./migrate.ts";

/**
 * The studio's setup flow behind the server's `SetupDoor`: the CLI's own doors, opened for one
 * source the file does not have yet, with the admin connection string the operator pasted in the
 * studio for each call. It is `facetdb migrate`'s plan (`planInstall`, `render`, `run`,
 * `installPrintout`) and Apply's judgement and write (`planApply`, `apply`), and nothing of its own
 * reaches the database.
 *
 * The admin string is handed to the engine for the call and kept nowhere: no field, no closure past
 * the call, no log line; every connection the engine opens with it is closed before the call
 * returns. The variable the new source reads its connection from is read here, where the worker
 * runs, and never answered: only whether it is set, through Apply's own refusal when it is not.
 *
 * The install's order: the file is written first, then the install runs; when the run stops with
 * nothing kept (a transaction rolled back, or a stop before the first statement) the file is put
 * back as it was, and when statements stay (an engine without transactional DDL) the file keeps the
 * source, so `facetdb migrate` finishes it and `facetdb uninstall` takes it out. Nothing is
 * installed that the file does not name, except while a run is in flight. The worker is reloaded
 * only after a finished install, and the reload starts the source once the worker's own check of
 * its database holds; a run this worker finished stands in for the rights check an engine's doctor
 * lacks (`ran`, as the migrate door's), the columns still being the doctor's to find.
 */

export type SetupDoorDeps = InstallDeps & {
  /** The config file, as `--config` names it, its disk and git door, and its quiet loader. */
  readonly path: string;
  readonly files: ConfigFiles;
  readonly load: () => Promise<ProjectConfig>;
  /**
   * This worker ran the install of `source`, as `config` holds it, to its end: the reload that
   * follows may take that run as the worker login's rights on its columns (install-check.ts).
   */
  readonly ran: (source: SourceConfig, config: ProjectConfig) => void;
  /** The worker's reload of the written file (the fleet's). */
  readonly reload: () => Promise<ReloadSummary>;
  /** One file write at a time, shared with Apply's door. */
  readonly serial: <Result>(work: () => Promise<Result>) => Promise<Result>;
  /** The workers' model, behind their backoff and in-flight limit, and their spending gate. */
  readonly provider: ModelProvider;
  readonly spending: SpendingGate;
  /** The worker's output: the preview's own notes, never a connection string. */
  readonly print: (line: string) => void;
};

/**
 * What one source's install needs besides the admin string: the CLI's environment, clock and store
 * driver, the databases the doors reach, the project, and the worker's `--allow-insecure` for the
 * store it opened. The setup door's and the migrate door's alike.
 */
export type InstallDeps = {
  readonly cli: Pick<CliDeps, "env" | "clock" | "connect">;
  readonly databases: DoorDatabases;
  readonly project: ProjectRef;
  readonly allowInsecureStore: boolean;
};

/**
 * The databases the studio's doors reach, and what the doors know of a connection string to one.
 * Under `facetdb worker` they are every engine the composition root registered, picked by the
 * string's scheme (`registeredDatabases`: cli/engines.ts and the store door); under `facetdb dev`
 * the one embedded database, which dev's address alone names and dev's own engine serves, every
 * other string refused in words naming that address (dev.ts).
 */
export type DoorDatabases = {
  /** Whether a connection string names a database these doors read; nothing loads or connects. */
  reads(url: string): boolean;
  /** The database a connection string names, in words: `Postgres`, `PGlite`; undefined when none. */
  name(url: string): string | undefined;
  /** The engine for a connection string, or `connector:`'s; refused in words for a string not read. */
  engine(url: string, override?: ConnectorChoice): Promise<DatabaseEngine>;
  /** The engine an install of `source` plans with under the admin string, which must name its kind. */
  adminEngine(source: SourceConfig, admin: string): Promise<DatabaseEngine>;
  /** Whether two connection strings reach one database (the store door's `sameDatabase`). */
  same(a: string, b: string): boolean;
  /** Whether the store is `source`'s own database, so the install's plan holds the store's part. */
  storeShared(source: SourceConfig): boolean;
  /** The worker login's password an install creates the login with, or why there is none. */
  workerPassword(engine: DatabaseEngine, source: SourceConfig): ReturnType<typeof passwordOf>;
  /**
   * What to do when the variable step five names holds no connection string these doors read
   * (unset, or another kind of string): the words after the finding, in the terms of the worker
   * that runs (a worker login's string and `facetdb worker`; dev's address and `facetdb dev`).
   */
  variableFix(variable: string): string;
};

/** The doors' databases under `facetdb worker`: the registered engines, judged by the scheme table. */
export function registeredDatabases(deps: Pick<CliDeps, "engines" | "env">): DoorDatabases {
  const { engines, env } = deps;
  return {
    // The same answer as the static table alone gave before only because main.ts registers an
    // engine for every key of that table.
    reads: (url) => readsUrl(engines, url),
    name: (url) => databaseOf(url)?.name,
    engine: (url, override) => engineFor(engines, url, override),
    adminEngine: (source, admin) => adminEngineOf(engines, source, admin),
    same: (a, b) => sameDatabase(a, b, env),
    storeShared: (source) => storeSharedFor(env, source),
    workerPassword: passwordOf,
    variableFix: () =>
      "set it to the worker login's connection string (postgres://facetdb_worker:<a long random password>@<host>/<database>: the install creates that login with that password), restart facetdb worker, then show the SQL again",
  };
}

/** One source's install as `facetdb migrate` plans and prints it, and what its run needs. */
export type SourceInstall = {
  readonly engine: DatabaseEngine;
  readonly own: EngineTarget;
  readonly plan: EnginePlan;
  /** The table as its engine names it: `public.listings`. */
  readonly label: string;
  /** The source's part of `facetdb migrate --source <name> --dry-run` (`installPrintout`). */
  readonly sql: string;
  readonly storeShared: boolean;
  readonly engineDeps: EngineDeps;
  readonly workerPassword: string | undefined;
  readonly questionSet: EngineTarget["questionSet"];
};

/**
 * The engine an install plans with, as `adminRun` picks it: the source's connection string's, and
 * the admin string must name the same kind of database (the setup's words).
 */
export async function adminEngineOf(
  engines: CliDeps["engines"],
  source: SourceConfig,
  admin: string,
): Promise<DatabaseEngine> {
  const engine = await engineFor(engines, source.database ?? admin, source.connector);
  const theirs = databaseOf(admin);
  const own = source.database === undefined ? undefined : databaseOf(source.database);
  if (theirs !== undefined && own !== undefined && theirs.key !== own.key) {
    throw new CliError(
      "admin-url-scheme",
      `the admin connection string is ${theirs.name}'s (${schemeOf(admin)}:), and ${variableOf(source)} holds ${own.name}'s (${schemeOf(source.database ?? "")}:), so the two name different kinds of database; nothing was connected`,
      `give the admin connection string of the database ${variableOf(source)} names`,
    );
  }
  return engine;
}

/**
 * One source's install, planned with the admin string and printed exactly as `facetdb migrate
 * --source <name> --dry-run` prints the source's part (`installPrintout`). The store's part: when
 * the store is the source's own database the engine's plan holds it; otherwise a worker running on
 * the store has it current, so it is only read, for its notes, and a store `facetdb migrate` would
 * still have to move is refused. A refusal in the CLI's words throws.
 */
export async function sourceInstallOf(
  deps: InstallDeps,
  config: ProjectConfig,
  target: TableTarget,
  engine: DatabaseEngine,
  admin: string,
): Promise<SourceInstall> {
  const { env, clock } = deps.cli;
  const { databases } = deps;
  const source = target.source;
  const storeShared = databases.storeShared(source);
  const notes: string[] = [];
  if (!storeShared) {
    const store = await showStoreMigration(
      deps.cli.connect,
      requireStoreUrl(env, deps.allowInsecureStore),
    );
    if (!store.current) {
      throw new CliError(
        "store-not-current",
        `the FacetDB store on ${store.label} needs facetdb migrate before a source's install runs from the studio`,
        "run facetdb migrate on this machine, then restart facetdb worker",
      );
    }
    notes.push(...store.notes);
  }
  const own = engineTarget(config, target, deps.project);
  const engineDeps: EngineDeps = { clock, allowInsecure: false, storeShared };
  const login = databases.workerPassword(engine, source);
  const plan = await planInstall(engine, target, own, admin, engineDeps, login);
  const label = engine.label(own, admin);
  const sql = installPrintout(source.name, label, engine.render(plan), [
    ...new Set([...notes, ...plan.notes]),
  ]);
  return {
    engine,
    own,
    plan,
    label,
    sql,
    storeShared,
    engineDeps,
    workerPassword: "password" in login ? login.password : undefined,
    questionSet: own.questionSet,
  };
}

/** Runs an install as planned, with the worker login's password where the plan creates it. */
export function runSourceInstall(
  install: SourceInstall,
  admin: string,
): ReturnType<DatabaseEngine["run"]> {
  return install.engine.run(install.own, install.plan, admin, {
    ...install.engineDeps,
    ...(install.workerPassword === undefined ? {} : { workerPassword: install.workerPassword }),
  });
}

/** A draft's connection variable, as `database: { env }` names it. */
function variableIn(draft: SourceDraft): string | undefined {
  const database = draft["database"];
  return typeof database === "object" && database !== null && "env" in database
    ? typeof database.env === "string"
      ? database.env
      : undefined
    : undefined;
}

/** A refusal in the CLI's words: its code, message and fix. */
function refusedOf(error: CliError): SetupRefused {
  return { kind: "refused", code: error.code, message: error.message, fix: error.fix };
}

/** What the setup cannot read the file for. */
function unreadable(message: string, fix: string): SetupRefused {
  return { kind: "refused", code: "config_unreadable", message, fix };
}

const NO_VARIABLE: SetupRefused = {
  kind: "refused",
  code: "no-variable",
  message: "the draft names no environment variable for the worker's connection string",
  fix: 'name one in step five: "database": {"env": "LISTINGS_URL"}, set where the worker runs',
};

/**
 * FacetDB's own secrets, which no source may name as its connection: the store's key
 * (`STORE_SECRET_VARIABLE`, store-door.ts), the model's key (`TYPESAFE_API_KEY`, worker.ts
 * `requireModel`) and a project's API key (`FACETDB_API_KEY`, sdk/client.ts). Named, they would be
 * written into facetdb.config.ts as a source's connection and handed to a database driver.
 */
const OWN_SECRETS: readonly string[] = [
  STORE_SECRET_VARIABLE,
  "TYPESAFE_API_KEY",
  "FACETDB_API_KEY",
];

function ownSecret(variable: string): SetupInvalidOut | undefined {
  return OWN_SECRETS.includes(variable)
    ? {
        kind: "invalid",
        issues: [
          {
            path: "database.env",
            message: `${variable} holds one of FacetDB's own secrets, never a connection string; name the variable that holds the worker's connection string`,
          },
        ],
      }
    : undefined;
}

/** What the CLI has to say: its own refusals; anything else is thrown on to the service. */
function asRefusal(error: unknown): SetupRefused {
  if (error instanceof CliError) {
    return refusedOf(error);
  }
  if (error instanceof EngineRefusal) {
    return { kind: "refused", ...error.refusal };
  }
  throw error;
}

export function createSetupDoor(deps: SetupDoorDeps): SetupDoor {
  const { cli, databases, project, path, files } = deps;
  const { env, clock } = cli;

  /** The file as it reads and loads now, or why it cannot be read. */
  async function current(): Promise<
    { readonly ok: true; readonly text: string; readonly config: ProjectConfig } | SetupRefused
  > {
    const read = await files.read(path);
    if (read.kind !== "file") {
      return unreadable(
        read.kind === "missing"
          ? `${path} is not there, so there is no file to add the source to`
          : `${path} is a link or a directory, and the setup writes only a regular file`,
        read.kind === "missing"
          ? `put ${path} back (git checkout ${path}), then try again`
          : `make ${path} a regular file in the project, then try again`,
      );
    }
    try {
      return { ok: true, text: read.text, config: await deps.load() };
    } catch (error) {
      if (error instanceof ConfigError) {
        return unreadable(
          `${path} does not load as it is now, so the source cannot be added to it. ${error.message}`,
          `fix each line named in ${path}, then try again`,
        );
      }
      throw error;
    }
  }

  /** The words of a refusal or a problem with the variable's value hidden, if it is set. */
  function hidingValue(draft: SourceDraft) {
    const variable = variableIn(draft);
    const value = variable === undefined ? undefined : env[variable];
    const parts = value === undefined || value === "" ? [] : secretParts(value);
    return (text: string) => hideSecrets(text, parts);
  }

  /** The source's table target, from the judged project. */
  function targetOf(config: ProjectConfig, name: string): TableTarget {
    const [target] = tableTargets(config, name);
    if (target === undefined) {
      throw new Error(`tableTargets returned nothing for ${name}`);
    }
    return target;
  }

  /**
   * The source of the file that already reads this table, if one does: the same table as its engine
   * labels it (schema included), on a database of the same kind, reached at the same host, port and
   * database as the admin string or the new source's own connection string. Nothing connects and
   * nothing of either string is returned. What it cannot tell: one database reached by two
   * addresses (a pooler's host and the direct one), or a table renamed since.
   */
  function sourceOfTable(
    config: ProjectConfig,
    source: SourceConfig,
    engine: DatabaseEngine,
    label: string,
    admin: string,
  ): string | undefined {
    return config.sources.find((other) => {
      if (other.name === source.name || other.table === undefined || other.database === undefined) {
        return false;
      }
      const there = other.database;
      // `same` is false across kinds of database (the store door reads Postgres addresses alone),
      // and true for every string under dev, where every table source lives on the one embedded
      // database whatever its string says.
      const sameDatabaseAs = (url: string | undefined) =>
        url !== undefined && databases.same(there, url);
      if (!(sameDatabaseAs(admin) || sameDatabaseAs(source.database))) {
        return false;
      }
      const theirs = engineTarget(config, { source: other, ...splitTable(other.table) }, project);
      return engine.label(theirs, there) === label;
    })?.name;
  }

  /** The install plan, its printout, and what the run needs; a refusal in the CLI's words throws. */
  async function installOf(
    applyPlan: ApplyPlan,
    name: string,
    admin: string,
  ): Promise<SourceInstall> {
    const config = applyPlan.config;
    const target = targetOf(config, name);
    const source = target.source;
    const engine = await databases.adminEngine(source, admin);
    // Before anything connects: a table the file already reads is not set up again.
    const own: EngineTarget = engineTarget(config, target, project);
    const taken = sourceOfTable(config, source, engine, engine.label(own, admin), admin);
    if (taken !== undefined) {
      throw new CliError(
        "table-taken",
        `${engine.label(own, admin)} is already the table of the source "${taken}" in ${path}, so it is not set up again under another name`,
        `that source is ${taken}; finish or check its install with facetdb migrate --source ${taken}, or take it out with facetdb uninstall --source ${taken}`,
      );
    }
    return sourceInstallOf(deps, config, target, engine, admin);
  }

  /** Apply's plan of the draft as a new source of the operator's, or why there is none. */
  async function applyPlanOf(
    draft: SourceDraft,
  ): Promise<{ readonly ok: true; readonly plan: ApplyPlan } | SetupRefused | SetupInvalidOut> {
    const variable = variableIn(draft);
    if (variable === undefined) {
      return NO_VARIABLE;
    }
    const own = ownSecret(variable);
    if (own !== undefined) {
      return own;
    }
    // Read where the worker runs, and said back only as set or not, or as not a connection string
    // FacetDB reads: never its value, nor what in it is wrong.
    const value = env[variable];
    if (value === undefined || value === "") {
      return {
        kind: "invalid",
        issues: [
          {
            path: "database.env",
            message: `${variable} is not set where the worker runs; ${databases.variableFix(variable)}`,
          },
        ],
      };
    }
    if (!databases.reads(value)) {
      return {
        kind: "invalid",
        issues: [
          {
            path: "database.env",
            message: `${variable} is set where the worker runs, and does not hold a connection string of a database FacetDB reads; ${databases.variableFix(variable)}`,
          },
        ],
      };
    }
    const now = await current();
    if (!("ok" in now)) {
      return now;
    }
    const planned = planApply(
      { path, text: now.text, config: now.config },
      { source: draft },
      env,
      {
        variable,
      },
    );
    if (!planned.ok) {
      const hide = hidingValue(draft);
      return {
        kind: "invalid",
        issues: planned.issues.map((issue) => ({ ...issue, message: hide(issue.message) })),
      };
    }
    return { ok: true, plan: planned.plan };
  }

  /**
   * Puts the config file back as it was before the setup wrote it, only while it is still the text
   * the setup wrote (Apply's own rule): an edit made while the install ran is never overwritten.
   */
  async function restore(plan: ApplyPlan): Promise<"restored" | "not-restored" | "changed"> {
    try {
      const now = await files.read(path);
      if (now.kind !== "file" || now.text !== plan.after) {
        return "changed";
      }
      await files.replace(path, plan.before);
      return "restored";
    } catch {
      return "not-restored";
    }
  }

  /**
   * The newest rows of the draft source through its engine's bounded read (one read-only
   * transaction with a statement timeout, nothing set on the session), or why there are none.
   */
  async function rowsOf(
    engine: DatabaseEngine,
    target: EngineTarget,
    admin: string,
    limit: number,
  ): Promise<ReadRowsResult> {
    if (engine.readRows === undefined) {
      return {
        ok: false,
        refusal: {
          code: "no-inspect",
          message: `the studio cannot read rows of a new source on ${engine.name} yet`,
          fix: "run facetdb init, facetdb preview and facetdb migrate on this machine instead",
        },
      };
    }
    return engine.readRows(target, admin, { allowInsecure: false, limit });
  }

  /**
   * The worker's reload once the install ran and the file is written. A reload that fails does not
   * undo either: the source is installed, and the operator is told to restart the worker.
   */
  async function reloadAfter(): Promise<ReloadSummary> {
    try {
      return await deps.reload();
    } catch {
      return {
        loaded: false,
        message:
          "the install ran and facetdb.config.ts names the source, and the worker could not reload the file afterwards",
        fix: "restart facetdb worker: it reads the file as it is now",
      };
    }
  }

  /**
   * The first table source of the file that reads the database `admin` reaches (host, port and
   * name), whose variable the page suggests: one database, one string, so Apply can tell which
   * source reads which. Nothing of either string is said, the variable's name alone. A file that
   * does not load, or cannot be read, suggests nothing and refuses nothing here: the suggestion is
   * a courtesy, the inspection is the answer.
   */
  async function sharedSource(
    admin: string,
  ): Promise<(SourceConfig & { readonly databaseEnv: string }) | undefined> {
    try {
      const now = await current();
      return "ok" in now
        ? now.config.sources.find(
            (source): source is SourceConfig & { readonly databaseEnv: string } =>
              source.table !== undefined &&
              source.database !== undefined &&
              source.databaseEnv !== undefined &&
              // A string these doors do not read is never suggested: under dev a source may read a
              // real server's string, which step five would then refuse.
              databases.reads(source.database) &&
              databases.same(source.database, admin),
          )
        : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    available: true,

    async inspect(admin, table): Promise<InspectOutcome> {
      try {
        const engine = await databases.engine(admin);
        const database = databases.name(admin) ?? engine.name;
        if (engine.inspect === undefined) {
          return {
            kind: "refused",
            code: "no-inspect",
            message: `the studio cannot add a source on ${database} yet`,
            fix: "run facetdb init and facetdb migrate on this machine: they add a source on every database FacetDB reads",
          };
        }
        const result = await engine.inspect(admin, {
          allowInsecure: false,
          ...(table === undefined ? {} : { table }),
        });
        if (!result.ok) {
          return { kind: "refused", ...result.refusal };
        }
        const shared = await sharedSource(admin);
        return {
          kind: "inspected",
          database,
          tables: result.inspection.tables,
          table: result.inspection.table ?? null,
          sharedWith:
            shared === undefined ? null : { source: shared.name, variable: shared.databaseEnv },
        };
      } catch (error) {
        return asRefusal(error);
      }
    },

    async preview(admin, draft, limit): Promise<SetupPreviewOutcome> {
      const now = await current();
      if (!("ok" in now)) {
        return now;
      }
      // The variable is chosen at step five; the preview reads the rows with the admin string, so
      // until then it is judged as reading DATABASE_URL, which it never opens.
      const variable = variableIn(draft) ?? "DATABASE_URL";
      const own = ownSecret(variable);
      if (own !== undefined) {
        return own;
      }
      const judged = judgeDraftSource(now.config, { ...draft, database: { env: variable } }, env, {
        variable,
      });
      if (!judged.ok) {
        const hide = hidingValue(draft);
        return {
          kind: "invalid",
          issues: judged.issues.map((issue) => ({ ...issue, message: hide(issue.message) })),
        };
      }
      let rows: readonly ReadRow[];
      let source: SourceConfig;
      try {
        const target = targetOf(judged.config, draft.name);
        source = target.source;
        const engine = await databases.engine(admin, source.connector);
        const read = await rowsOf(
          engine,
          engineTarget(judged.config, target, project),
          admin,
          limit,
        );
        if (!read.ok) {
          return { kind: "refused", ...read.refusal };
        }
        rows = read.rows;
      } catch (error) {
        return asRefusal(error);
      }
      try {
        const result = await createPreviewService({
          // The rows were read once, bounded (`readRows`); the preview asks the model about them.
          connector: { scan: () => Promise.resolve({ rows, next: null }) },
          provider: deps.provider,
          spending: deps.spending,
          log: (line) => {
            deps.print(`setup: preview: ${line}`);
          },
          clock,
          ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
        }).preview(judged.questionSet, limit);
        if (result.kind === "capped") {
          return {
            kind: "capped",
            message: result.message,
            fix: result.fix,
            retryAfterSeconds: result.retryAfterSeconds,
          };
        }
        return {
          kind: "previewed",
          rows: result.rows,
          decided: result.decided,
          review: result.review,
          cost: result.cost,
          warnings: judged.warnings,
        };
      } catch (error) {
        if (error instanceof PreviewModelError) {
          return { kind: "model_failed", key: error.key, reason: error.message };
        }
        throw error;
      }
    },

    async plan(admin, draft): Promise<SetupPlanOutcome> {
      const applied = await applyPlanOf(draft);
      if (!("ok" in applied)) {
        return applied;
      }
      const applyPlan = applied.plan;
      let install: SourceInstall;
      try {
        install = await installOf(applyPlan, draft.name, admin);
      } catch (error) {
        const refused = asRefusal(error);
        const hide = hidingValue(draft);
        return { ...refused, message: hide(refused.message), fix: hide(refused.fix) };
      }
      // The first backfill's estimate, bounded: the newest 100 rows priced, read once inside the
      // engine's read-only transaction with its timeout, and the table's size from the database's
      // own statistics (no count runs over the table); `facetdb backfill` counts exactly when run.
      const read = await rowsOf(install.engine, install.own, admin, ESTIMATE_SAMPLE_SIZE);
      if (!read.ok) {
        return { kind: "refused", ...read.refusal };
      }
      const states = read.rows.filter((row) => !row.excluded).map((row) => row.state);
      const estimate = estimateBackfill(install.questionSet, {
        records: read.estimatedRows ?? states.length,
        states,
      });
      return {
        kind: "planned",
        engine: install.engine.name,
        table: install.label,
        sql: install.sql,
        transactional: install.plan.transactional,
        path,
        diff: applyPlan.diff,
        diffPlan: applyPlan.id,
        uncommitted: applyPlan.changed
          ? (uncommittedWords(await files.gitState(path), path) ?? null)
          : null,
        warnings: applyPlan.warnings,
        estimate,
        pace: DEFAULT_BACKFILL_PACE,
        counted: read.estimatedRows === null ? "rows-read" : "statistics",
        storeElsewhere: !install.storeShared,
      };
    },

    install: (admin, draft, shown) =>
      deps.serial(async (): Promise<SetupInstallOutcome> => {
        const applied = await applyPlanOf(draft);
        if (!("ok" in applied)) {
          return applied;
        }
        const applyPlan = applied.plan;
        if (applyPlan.id !== shown.diffPlan) {
          return { kind: "stale" };
        }
        let install: SourceInstall;
        try {
          install = await installOf(applyPlan, draft.name, admin);
        } catch (error) {
          const refused = asRefusal(error);
          const hide = hidingValue(draft);
          return { ...refused, message: hide(refused.message), fix: hide(refused.fix) };
        }
        // Planned again right before the run, by the same engine: only the script that was shown
        // runs (migrate's rule).
        if (install.engine.name !== shown.engine || install.sql !== shown.sql) {
          return { kind: "plan_changed" };
        }
        // The file first, so nothing is installed that the file does not name.
        const written = await apply(applyPlan, { force: shown.force, files });
        switch (written.kind) {
          case "unchanged":
          case "moved":
            return { kind: "stale" };
          case "not-a-file":
            return unreadable(
              `${path} is a link or a directory, and the setup writes only a regular file`,
              `make ${path} a regular file in the project, then try again`,
            );
          case "uncommitted":
            return { kind: "uncommitted", message: written.message, fix: written.fix };
          case "written":
            break;
        }
        const stopped = (
          at: number | null,
          why: Extract<SetupInstallOutcome, { kind: "stopped" }>["why"],
          kept: number,
          file: Extract<SetupInstallOutcome, { kind: "stopped" }>["file"],
        ): SetupInstallOutcome => ({
          kind: "stopped",
          table: install.label,
          path,
          at,
          purpose: at === null ? null : (install.plan.statements[at]?.purpose ?? null),
          why,
          known: why.kind !== "thrown",
          kept,
          transactional: install.plan.transactional,
          file,
        });
        let result: Awaited<ReturnType<DatabaseEngine["run"]>>;
        try {
          result = await runSourceInstall(install, admin);
        } catch (error) {
          // Thrown, the run did not say how it ended: a connection lost during the commit may have
          // committed it. The file keeps the source, so `facetdb migrate --source X --dry-run` shows
          // what is there and migrate finishes it, or uninstall takes it out.
          return stopped(null, { kind: "thrown", error }, 0, "kept");
        }
        if (result.stopped !== undefined) {
          // The engine said how it ended: with nothing kept (a transaction rolled back, or a stop
          // before the first statement) the file goes back as it was; otherwise it keeps the source.
          const kept = result.ran.length;
          const file = kept === 0 ? await restore(applyPlan) : "kept";
          const why =
            "refusal" in result.stopped
              ? { kind: "refusal" as const, refusal: result.stopped.refusal }
              : { kind: "error" as const, error: hidingValue(draft)(result.stopped.error) };
          return stopped(result.stopped.at, why, kept, file);
        }
        // Ran to its end, for the source as the file now holds it: the reload's check may take it.
        deps.ran(targetOf(applyPlan.config, draft.name).source, applyPlan.config);
        return {
          kind: "installed",
          table: install.label,
          path,
          reload: await reloadAfter(),
        };
      }),
  };
}

type SetupInvalidOut = Extract<SetupPlanOutcome, { kind: "invalid" }>;

/** The door of a worker that does not write facetdb.config.ts: `--once`. */
export const UNAVAILABLE_SETUP_DOOR: SetupDoor = {
  available: false,
  inspect: () => Promise.reject(new Error("this worker adds no source")),
  preview: () => Promise.reject(new Error("this worker adds no source")),
  plan: () => Promise.reject(new Error("this worker adds no source")),
  install: () => Promise.reject(new Error("this worker adds no source")),
};
