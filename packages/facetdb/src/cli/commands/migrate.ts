import type {
  DatabaseEngine,
  EngineDeps,
  EngineObject,
  EnginePlan,
  EngineTarget,
  PlanResult,
} from "@facetdb/core";
import type { SourceConfig } from "../../config/index.ts";
import { databaseChanged, refusalError, stoppedError } from "../engines.ts";
import { asCliError, CliError, databaseLabel, defineCommand } from "../program.ts";
import {
  rebuildReviewCards,
  requireStoreUrl,
  runStoreMigration,
  type StoreMigration,
  sameDatabase,
  showStoreMigration,
  storeSecretWarning,
  storeSharedFor,
  storeSourceId,
} from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  adminRun,
  engineTarget,
  loadProjectConfig,
  projectRef,
  questionSetOf,
  type TableTarget,
  tableTargets,
  variableOf,
  WORKER_LOGIN,
  withoutNothingDone,
  workerLoginOf,
} from "./database.ts";

/**
 * `facetdb migrate`: runs install for every source that reads a table, through the source's engine.
 * Every script is printed first, from the engine's plans; then, once confirmed, each plan is made
 * again and runs only when its script is the one shown, so the SQL executed is the SQL printed,
 * string for string. The admin connection string is used for the run and kept nowhere. The store is
 * the Postgres `DATABASE_URL` names: when it is the source's own database the engine's plan holds
 * its part, today's one script; otherwise the store's part is printed and run first, under a `--
 * store:` header (a store already current says so and runs nothing; one newer than this FacetDB is
 * refused before the confirmation), and each source's under `-- source <name>:`. The store's step
 * is said as it runs, and a source's failure after it says the store moved. Every line names the
 * table as its engine does (`DatabaseEngine.label`): `public.listings` on Postgres, `dbo.listings`
 * on SQL Server, `listings` on MySQL.
 */

type MigrateOptions = {
  readonly config: string;
  readonly adminUrl?: string;
  readonly source?: string;
  readonly yes: boolean;
  readonly prune: boolean;
  readonly allowInsecure?: boolean;
};

/** One table's plans, as shown: the prune (with `--prune`) and the install, with their scripts. */
type Shown = {
  readonly target: TableTarget;
  readonly engineTarget: EngineTarget;
  /** The table as its engine names it: `public.listings`, `dbo.listings`, `listings`. */
  readonly label: string;
  readonly install: EnginePlan;
  readonly installScript: string;
  /** Undefined without `--prune`; an empty plan when the table is not installed yet. */
  readonly prune: EnginePlan | undefined;
  readonly pruneScript: string;
};

/** ` (why)`, the reason the engine gives an object, as the line prints it. */
const why = (object: EngineObject) => (object.reason === undefined ? "" : ` (${object.reason})`);

/** A revoked read's line: the worker loses the read, unless another role's grant still gives it. */
function revokedLine(grant: EngineObject, done: boolean): string {
  const verb = done ? "revoked" : "to revoke";
  return grant.reason?.startsWith("a grant by ") === true
    ? `  ${grant.of}: FacetDB's grant ${verb}${why(grant)}`
    : `  ${grant.of}: the worker login's read ${verb}${why(grant)}`;
}

/**
 * One line per column the prune touches or keeps, with what happens to it and why: "to drop"
 * before the confirmation, "dropped" after the run; then each of the plan's notes.
 */
function pruneLines(plan: EnginePlan, done: boolean): readonly string[] {
  const columns = (objects: readonly EngineObject[]) =>
    objects.filter((object) => object.kind === "column");
  return [
    ...columns(plan.removes).map(
      (column) => `  ${column.name}: ${done ? "dropped" : "to drop"}${why(column)}`,
    ),
    ...columns(plan.keeps).map((column) => `  ${column.name}: kept${why(column)}`),
    ...plan.removes
      .filter((object) => object.kind === "grant")
      .map((grant) => revokedLine(grant, done)),
    ...plan.notes.map((note) => `note: ${note}`),
  ];
}

/**
 * The user and password a connection string logs in with: as its engine reads the string where the
 * engine says how (MongoDB's several-host replica set string), else as a URL.
 */
function loginOf(
  engine: DatabaseEngine,
  url: string,
): { readonly user: string; readonly password: string } | undefined {
  if (engine.login !== undefined) {
    return engine.login(url);
  }
  try {
    const parsed = new URL(url);
    return {
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    };
  } catch {
    return undefined;
  }
}

/**
 * The worker login's password on the first install, from the source's connection string, which is
 * the worker's (`postgres://facetdb_worker:…@host/db`), so the login migrate creates is the one the
 * worker connects with; or why there is none. Once the login exists it is left as it is (other
 * projects on the server may share it) and the engine asks for no password.
 */
function passwordOf(
  engine: DatabaseEngine,
  source: SourceConfig,
): { readonly password: string } | { readonly problem: string } {
  const variable = variableOf(source);
  if (source.database === undefined) {
    return {
      problem: `the source "${source.name}" has no connection string, so the worker login has no password to be created with`,
    };
  }
  const login = loginOf(engine, source.database);
  if (login === undefined) {
    return { problem: `the connection string in ${variable} is not a URL` };
  }
  if (workerLoginOf(login.user) === undefined || login.password === "") {
    return {
      problem: `the worker login ${WORKER_LOGIN} does not exist yet, and ${variable} does not log in as it with a password`,
    };
  }
  return { password: login.password };
}

/**
 * The install plan, with today's `worker-login` refusal in the CLI's words: the engine refuses with
 * that code when it must create the login and was given no password, and the CLI knows why the
 * source's connection string gave none and how to name the login in it.
 */
async function planInstall(
  engine: DatabaseEngine,
  target: TableTarget,
  own: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<EnginePlan> {
  const login = passwordOf(engine, target.source);
  const planned: PlanResult = await engine.planInstall(own, url, {
    ...deps,
    ...("password" in login ? { workerPassword: login.password } : {}),
  });
  if (planned.ok) {
    return planned.plan;
  }
  if (planned.refusal.code === "worker-login" && "problem" in login) {
    const variable = variableOf(target.source);
    throw new CliError(
      "worker-login",
      login.problem,
      `set ${variable} to postgres://${WORKER_LOGIN}:<a long random password>@<host>/<database> (or postgres://${WORKER_LOGIN}.<suffix>:… when a connection pooler such as the Supabase session pooler asks for a suffixed user); migrate creates that login with that password, and the worker connects with it, directly or through a session pooler (Supabase: port 5432), not a transaction pooler (6543), because it queues records with named prepared statements`,
    );
  }
  throw refusalError(planned.refusal);
}

/** The prune plan; a refusal (another project's table, a lost key) in the engine's words. */
async function planPrune(
  engine: DatabaseEngine,
  own: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<EnginePlan> {
  const planned = await engine.planPrune(own, url, deps);
  if (!planned.ok) {
    throw refusalError(planned.refusal);
  }
  return planned.plan;
}

/** Runs a plan made again right before the run, only when its script is the one shown. */
async function runAsShown(
  engine: DatabaseEngine,
  own: EngineTarget,
  url: string,
  shown: string,
  again: EnginePlan,
  deps: EngineDeps & { readonly workerPassword?: string },
): Promise<void> {
  if (engine.render(again) !== shown) {
    throw databaseChanged();
  }
  const result = await engine.run(own, again, url, deps);
  if (result.stopped !== undefined) {
    throw stoppedError(result.stopped);
  }
}

/** What the show says in place of the store's DDL when the store is at this version already. */
const STORE_CURRENT = "-- the FacetDB store is current: nothing to run there";

/**
 * A source's failure once the store's own migration has committed: the source's words, without the
 * "nothing was run" no longer true of the run, then what ran before it and stays, so nobody
 * believes the store is where it was. The next migrate finds the store current and runs the
 * sources' part alone; `--json` carries what ran.
 */
function afterStoreMigrated(
  error: unknown,
  storeLabel: string,
  installed: readonly string[],
): CliError {
  const cause = asCliError(error);
  const ran = [
    `the FacetDB store's migration on ${storeLabel}`,
    ...installed.map((table) => `the install on ${table}`),
  ];
  return new CliError(
    cause.code,
    `${withoutNothingDone(cause.message)}. Already run in this run, before this, and kept: ${ran.join("; ")}.`,
    cause.fix,
    cause.exit,
    { storeMigrated: storeLabel, installed },
  );
}

export const migrateCommand = defineCommand<MigrateOptions>("migrate", {
  description:
    "Runs install for every source: answer columns, jobs table, change capture. Prints the SQL first",
  options: [
    {
      flags: "--config <path>",
      description: "the config file",
      defaultValue: "facetdb.config.ts",
    },
    {
      flags: "--admin-url <url>",
      description:
        "a connection string that may alter the tables; asked for when absent, never stored",
    },
    { flags: "--source <name>", description: "install only this source" },
    { flags: "--yes", description: "run the printed SQL without asking" },
    { flags: "--prune", description: "also drop the answer columns of questions you removed" },
    ALLOW_INSECURE_OPTION,
  ],
  run: async ({ options, deps, print }) => {
    const config = await loadProjectConfig(deps, options.config);
    const targets = tableTargets(config, options.source);
    const project = projectRef(deps.projectDir);
    const allowInsecure = options.allowInsecure === true;
    const [first] = targets;
    if (first === undefined) {
      throw new Error("tableTargets returns at least one target");
    }
    // One admin connection reaches one database (tableTargets): one engine and one store's place.
    // The engine first, so a scheme FacetDB does not serve is refused before a credential is asked.
    const { engine, url } = await adminRun(deps, first, options.adminUrl);
    const storeShared = storeSharedFor(deps.env, first.source);
    const storeUrl = storeShared ? undefined : requireStoreUrl(deps.env, allowInsecure);
    const engineDeps: EngineDeps = { clock: deps.clock, allowInsecure, storeShared };
    const shown: Shown[] = [];
    for (const target of targets) {
      const own = engineTarget(config, target, project);
      // The install first: its refusal (another project's table) is migrate's, in its own words.
      const install = await planInstall(engine, target, own, url, engineDeps);
      const prune = options.prune ? await planPrune(engine, own, url, engineDeps) : undefined;
      shown.push({
        target,
        engineTarget: own,
        label: engine.label(own, url),
        install,
        installScript: engine.render(install),
        prune,
        pruneScript: prune === undefined ? "" : engine.render(prune),
      });
    }
    const store: StoreMigration | undefined =
      storeUrl === undefined ? undefined : await showStoreMigration(deps.connect, storeUrl);
    if (store !== undefined) {
      print(`-- store: ${store.label}`);
      print(store.current ? STORE_CURRENT : store.script);
    }
    for (const item of shown) {
      if (store !== undefined) {
        print(`-- source ${item.target.source.name}: ${databaseLabel(url)}`);
      }
      if (item.pruneScript !== "") {
        print(`-- facetdb migrate --prune: ${item.target.source.name} (${item.label})`);
        print(item.pruneScript);
      }
      // What the prune drops, keeps and revokes, column by column; a kept column is named even
      // when there is no script, so nothing stays without a word.
      const lines = item.prune === undefined ? [] : pruneLines(item.prune, false);
      if (lines.length > 0) {
        print(`Prune of ${item.label}:`);
        print(lines.join("\n"));
      }
      print(`-- facetdb migrate: ${item.target.source.name} (${item.label})`);
      print(item.installScript);
    }
    // Store version 4 rekeys each source id to `<project>:<name>`; a log another project shared
    // stays with the registered one, said once before anything runs (the store's own notes when it
    // is its own database, the install plan's when the plan holds the store's part).
    const notes = new Set([
      ...(store?.notes ?? []),
      ...shown.flatMap((item) => item.install.notes),
    ]);
    for (const note of notes) {
      print(`note: ${note}`);
    }
    // migrate never opens the store's encrypted part, so an unset secret stops nothing here; the
    // worker it installs for refuses to start without it. Said before the run, on stderr, the dry
    // run included.
    const secretWarning = storeSecretWarning(deps.env);
    if (secretWarning !== undefined) {
      deps.io.stderr(`${secretWarning}\n`);
    }
    const summary = (applied: boolean) => ({
      ok: true,
      dryRun: options.dryRun,
      // A current store runs nothing: no SQL, and never reported applied.
      ...(store === undefined
        ? {}
        : {
            store: {
              database: store.label,
              current: store.current,
              sql: store.script,
              applied: applied && !store.current,
            },
          }),
      sources: shown.map((item) => ({
        source: item.target.source.name,
        table: item.label,
        ...(item.pruneScript === "" ? {} : { pruneSql: item.pruneScript }),
        ...(item.prune === undefined
          ? {}
          : {
              pruned: {
                removes: item.prune.removes,
                keeps: item.prune.keeps,
                notes: item.prune.notes,
              },
            }),
        sql: item.installScript,
        applied,
      })),
    });
    if (options.dryRun) {
      print("Dry run: nothing was changed.");
      return summary(false);
    }
    if (!options.yes) {
      // One database named once: a polling source's store part may run where its table is, told by
      // where the two strings connect, never by how their labels read.
      const oneDatabase = storeUrl !== undefined && sameDatabase(storeUrl, url, deps.env);
      const where =
        store === undefined || store.current || oneDatabase
          ? databaseLabel(url)
          : `${store.label} and ${databaseLabel(url)}`;
      const answer = await deps.io.prompt(`Run the SQL above on ${where}? Type yes to continue: `);
      if (answer.trim().toLowerCase() !== "yes") {
        throw new CliError(
          "not-confirmed",
          "the SQL was not confirmed, so nothing was run",
          "run facetdb migrate again and type yes, or pass --yes once you have read the SQL",
        );
      }
    }
    // The store first: the source's worker writes its log there from its first record. Its step is
    // said as it happens, and a source's failure after it says the store moved.
    let migratedStore: string | undefined;
    if (store !== undefined && storeUrl !== undefined) {
      if (store.current) {
        print(`The FacetDB store on ${store.label} was current: nothing ran there.`);
      } else {
        await runStoreMigration(deps.connect, storeUrl);
        migratedStore = store.label;
        print(`Migrated the FacetDB store on ${store.label}.`);
      }
    }
    const installed: string[] = [];
    for (const item of shown) {
      // The prune first, from the catalog it was shown from, then install.
      let pruned: EnginePlan | undefined;
      try {
        if (item.pruneScript !== "") {
          pruned = await planPrune(engine, item.engineTarget, url, engineDeps);
          await runAsShown(engine, item.engineTarget, url, item.pruneScript, pruned, engineDeps);
        }
        const login = passwordOf(engine, item.target.source);
        const install = await planInstall(engine, item.target, item.engineTarget, url, engineDeps);
        await runAsShown(engine, item.engineTarget, url, item.installScript, install, {
          ...engineDeps,
          ...("password" in login ? { workerPassword: login.password } : {}),
        });
      } catch (error) {
        throw migratedStore === undefined
          ? error
          : afterStoreMigrated(error, migratedStore, installed);
      }
      installed.push(item.label);
      const lines = pruned === undefined ? [] : pruneLines(pruned, true);
      if (lines.length > 0) {
        print(`Pruned ${item.label}:`);
        print(lines.join("\n"));
      }
      print(`Installed on ${item.label} (source ${item.target.source.name}).`);
    }
    // The store now holds the review queue (migration 6, in the store's part or the engine's plan);
    // the records decided needs_review before it existed get their cards, once per project of the
    // store, for every source of the config.
    const waiting = await rebuildReviewCards(
      deps.connect,
      storeUrl ?? url,
      project.id,
      new Map(
        config.sources.map((source) => [
          storeSourceId(project.id, source.name),
          questionSetOf(config, source),
        ]),
      ),
    );
    if (waiting !== undefined && waiting > 0) {
      print(
        `Listed ${waiting} record(s) decided before the review queue existed: they wait for review.`,
      );
    }
    return summary(true);
  },
});
