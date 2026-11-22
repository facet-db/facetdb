import { type DatabaseEngine, EngineRefusal } from "@facetdb/core";
import {
  hideSecrets,
  type MigrateDoor,
  type MigratePlanOutcome,
  type MigrateRunOutcome,
  type ReloadSummary,
  type SetupRefused,
  secretParts,
} from "@facetdb/server";
import { ConfigError, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import { CliError } from "../program.ts";
import { type FileQueue, planReload, type SourceLoop } from "./config-reload.ts";
import { tableTargets } from "./database.ts";
import {
  type InstallDeps,
  runSourceInstall,
  type SourceInstall,
  sourceInstallOf,
} from "./setup-door.ts";

/**
 * The studio's install of an added question. For one source of facetdb.config.ts as it loads now,
 * whose only difference from what its loop runs is questions added (the reload's own judgement,
 * `planReload`, so the page and the reload never disagree), it plans the whole idempotent install
 * again, exactly as `facetdb migrate --source <name>` plans and prints it (`sourceInstallOf`,
 * shared with the setup door), and on confirmation plans again and runs it only when the printout
 * is the one shown. Then it asks the worker to reload, and the reload switches the source to the
 * file's set once the worker's own check of the database holds.
 *
 * Every other change stays on the CLI and a restart: a question removed (its columns stay until
 * `migrate --prune`), a type, options or levels, `read`, `where`, storage, capture, the table; each
 * is refused with the commands that do it from a terminal. No file is written here: Apply wrote the
 * file before, and the run goes in the same queue as Apply's writes, so the file cannot move
 * between the plan made again and the reload.
 *
 * The admin string is handed to the engine for the call and kept nowhere; the server's setup
 * service hides it from every word it sends or logs.
 */

export type MigrateDoorDeps = InstallDeps & {
  /** The config file as `--config` names it, for the words. */
  readonly path: string;
  /** The file as it loads now, quietly. */
  readonly load: () => Promise<ProjectConfig>;
  /** The loop in force for a source: what it runs is what the file is compared with. */
  readonly running: (name: string) => SourceLoop | undefined;
  /**
   * This worker ran the install of `source`, as `config` holds it, to its end: the reload that
   * follows may take that run as the worker login's rights on its columns (install-check.ts).
   */
  readonly ran: (source: SourceConfig, config: ProjectConfig) => void;
  /** The worker's reload of the file (the fleet's), called inside `serial`. */
  readonly reload: () => Promise<ReloadSummary>;
  /** One write at a time, shared with Apply and the setup flow. */
  readonly serial: FileQueue;
};

/** What the CLI has to say: its own refusals and the engine's; anything else is thrown on. */
function asRefusal(error: unknown): SetupRefused {
  if (error instanceof CliError) {
    return { kind: "refused", code: error.code, message: error.message, fix: error.fix };
  }
  if (error instanceof EngineRefusal) {
    return { kind: "refused", ...error.refusal };
  }
  throw error;
}

/** A refusal before anything connects, with the commands that do it from a terminal. */
function refusal(code: string, message: string, fix: string): never {
  throw new CliError(code, message, fix);
}

/**
 * The source's own connection string as one call met it, so its parts are hidden from the words
 * that call answers (the setup's rule for the variable's value): a call has its own, since plans
 * may run side by side.
 */
type Seen = { url: string | undefined };

function hiding(seen: Seen): (text: string) => string {
  const parts = seen.url === undefined || seen.url === "" ? [] : secretParts(seen.url);
  return (text) => hideSecrets(text, parts);
}

function hidden(refused: SetupRefused, seen: Seen): SetupRefused {
  const hide = hiding(seen);
  return { ...refused, message: hide(refused.message), fix: hide(refused.fix) };
}

/** What a source's install, planned for the page, is for. */
type Planned = {
  readonly install: SourceInstall;
  readonly source: SourceConfig;
  readonly config: ProjectConfig;
  readonly questions: readonly string[];
};

export function createMigrateDoor(deps: MigrateDoorDeps): MigrateDoor {
  const { path } = deps;

  /**
   * The source as the file holds it now, judged against what its loop runs: only questions added
   * pass, every other case is refused in words that name what to run instead.
   */
  async function judged(name: string): Promise<{
    readonly config: ProjectConfig;
    readonly source: SourceConfig;
    readonly questions: readonly string[];
  }> {
    let config: ProjectConfig;
    try {
      config = await deps.load();
    } catch (error) {
      if (error instanceof ConfigError) {
        refusal(
          "config_unreadable",
          `${path} does not load as it is now, so nothing can be installed from it. ${error.message}`,
          `fix each line named in ${path}, then show the SQL again`,
        );
      }
      throw error;
    }
    const source = config.sources.find((candidate) => candidate.name === name);
    if (source === undefined) {
      refusal(
        "unknown-source",
        `${path} has no source named "${name}"`,
        `pick one of: ${config.sources.map((candidate) => candidate.name).join(", ")}`,
      );
    }
    if (source.source !== undefined) {
      refusal(
        "plugin-source",
        `the source "${name}" is read by the plugin ${source.source.plugin}, so there is no table to install its questions in`,
        "nothing to install: its answers live in the FacetDB store; restart facetdb worker to run the file as it is",
      );
    }
    if (source.api) {
      refusal(
        "api-source",
        `the source "${name}" answers through the check API, so there is no table to install its questions in`,
        "nothing to install: its answers live in the FacetDB store; restart facetdb worker to run the file as it is",
      );
    }
    const loop = deps.running(name);
    if (loop === undefined) {
      refusal(
        "not-running",
        `the source "${name}" is new in ${path} and the worker does not run it yet, so it is installed and started from a terminal`,
        `run facetdb migrate --source ${name} on this machine (it prints the SQL first), then restart facetdb worker`,
      );
    }
    const step = planReload(new Map([[name, loop]]), config).find(
      (candidate) => candidate.name === name,
    );
    switch (step?.kind) {
      case "added":
        return { config, source, questions: step.questions };
      case "keep":
        // Everything but questions added stays on the CLI and a restart.
        return refusal(
          "migrate-by-hand",
          `${path} changes more of "${name}" than questions added (a question removed, a type, options or levels, read, where, storage, capture or the table), and the studio installs only added questions`,
          `run facetdb migrate --source ${name} on this machine (it prints the SQL first; a removed question's column stays until facetdb migrate --source ${name} --prune), then restart facetdb worker`,
        );
      default:
        return refusal(
          "nothing-to-install",
          `nothing ${path} holds for "${name}" needs its database changed: the worker runs its questions' columns already`,
          "nothing to install; if the source still waits, restart facetdb worker",
        );
    }
  }

  /** The install of the source's set as the file holds it now, planned with the admin string. */
  async function planned(name: string, admin: string, seen: Seen): Promise<Planned> {
    const { config, source, questions } = await judged(name);
    seen.url = source.database;
    const [target] = tableTargets(config, name);
    if (target === undefined) {
      throw new Error(`tableTargets returned nothing for ${name}`);
    }
    const engine: DatabaseEngine = await deps.databases.adminEngine(source, admin);
    const install = await sourceInstallOf(deps, config, target, engine, admin);
    return { install, source, config, questions };
  }

  /** The worker's reload once the install ran; a reload that fails undoes nothing. */
  async function reloadAfter(): Promise<ReloadSummary> {
    try {
      return await deps.reload();
    } catch {
      return {
        loaded: false,
        message:
          "the install ran, and the worker could not read facetdb.config.ts again afterwards, so the source keeps answering with the version it ran",
        fix: "restart facetdb worker: it reads the file as it is now",
      };
    }
  }

  return {
    available: true,

    async plan(name, admin): Promise<MigratePlanOutcome> {
      const seen: Seen = { url: undefined };
      let made: Planned;
      try {
        made = await planned(name, admin, seen);
      } catch (error) {
        return hidden(asRefusal(error), seen);
      }
      return {
        kind: "planned",
        engine: made.install.engine.name,
        table: made.install.label,
        sql: made.install.sql,
        transactional: made.install.plan.transactional,
        questions: made.questions,
        storeElsewhere: !made.install.storeShared,
      };
    },

    run: (name, admin, shown) =>
      deps.serial(async (): Promise<MigrateRunOutcome> => {
        const seen: Seen = { url: undefined };
        let made: Planned;
        try {
          made = await planned(name, admin, seen);
        } catch (error) {
          return hidden(asRefusal(error), seen);
        }
        // Planned again right before the run: only the script that was shown runs (migrate's rule).
        if (made.install.engine.name !== shown.engine || made.install.sql !== shown.sql) {
          return { kind: "plan_changed" };
        }
        const { install } = made;
        const stopped = (
          at: number | null,
          why: Extract<MigrateRunOutcome, { kind: "stopped" }>["why"],
          kept: number,
        ): MigrateRunOutcome => ({
          kind: "stopped",
          table: install.label,
          at,
          purpose: at === null ? null : (install.plan.statements[at]?.purpose ?? null),
          why,
          known: why.kind !== "thrown",
          kept,
          transactional: install.plan.transactional,
        });
        let result: Awaited<ReturnType<DatabaseEngine["run"]>>;
        try {
          result = await runSourceInstall(install, admin);
        } catch (error) {
          // Thrown, the run did not say how it ended: a connection lost during the commit may have
          // committed it. No reload follows, so the source keeps answering with what it ran.
          return stopped(null, { kind: "thrown", error }, 0);
        }
        if (result.stopped !== undefined) {
          const why =
            "refusal" in result.stopped
              ? { kind: "refusal" as const, refusal: result.stopped.refusal }
              : { kind: "error" as const, error: hiding(seen)(result.stopped.error) };
          return stopped(result.stopped.at, why, result.ran.length);
        }
        deps.ran(made.source, made.config);
        return { kind: "migrated", table: install.label, reload: await reloadAfter() };
      }),
  };
}

/** The door of a worker that does not reload its config file: `--once`. */
export const UNAVAILABLE_MIGRATE_DOOR: MigrateDoor = {
  available: false,
  plan: () => Promise.reject(new Error("this worker installs no question")),
  run: () => Promise.reject(new Error("this worker installs no question")),
};
