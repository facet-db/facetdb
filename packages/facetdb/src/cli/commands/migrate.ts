import type {
  DatabaseEngine,
  EngineDeps,
  EngineObject,
  EnginePlan,
  EngineTarget,
  PlanLock,
  PlanLocks,
  PlanResult,
  PlanStep,
} from "@facetdb/core";
import type { ProjectConfig, SourceConfig } from "../../config/index.ts";
import { databaseChanged, refusalError, stoppedError } from "../engines.ts";
import {
  asCliError,
  CliError,
  type CommandContext,
  databaseLabel,
  defineCommand,
  plainMessage,
} from "../program.ts";
import {
  LOCK_WAIT,
  rebuildReviewCards,
  requireStoreRunnable,
  requireStoreUrl,
  runStoreMigration,
  type StoreLogin,
  type StoreMigration,
  sameDatabase,
  showStoreMigration,
  storeSecretWarning,
  storeSharedFor,
  storeSourceId,
  storeStepLocks,
} from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  adminRun,
  engineTarget,
  loadProjectConfig,
  type ProjectRef,
  projectRef,
  questionSetOf,
  readsNoTable,
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
 * the Postgres `DATABASE_URL` names. Its step is printed and run first, on its own, in its own
 * transaction, under a `-- store:` header (a store already current says so and runs nothing; one
 * newer than this FacetDB is refused before the confirmation), and each source's part under `--
 * source <name>:`; also when the store is the source's own database, where the step runs under the
 * admin string and the engine's plan still holds the store's statements, which then find everything
 * and change nothing. So no statement holds a lock on a customer's table while the store's
 * migrations run. The store's step is said as it runs, and a source's failure after it says the
 * store moved. Every line names the table as its engine does (`DatabaseEngine.label`):
 * `public.listings` on Postgres, `dbo.listings` on SQL Server, `listings` on MySQL. Sources that
 * read no table (a plugin or API source) have the store's step alone, and a Postgres install says
 * whether it created the worker login or found it and kept its password. Last before the
 * confirmation, and in `--dry-run` and `--json`, it lists every table each step locks, what the
 * application cannot do to it meanwhile and how many rows the step goes through, read from the
 * scripts shown.
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
export function loginOf(
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

/** The line migrate prints over a source's install script: `-- facetdb migrate: listings (public.listings)`. */
export function installHeader(source: string, label: string): string {
  return `-- facetdb migrate: ${source} (${label})`;
}

/** A note as migrate prints it, after the scripts. */
export function noteLine(note: string): string {
  return `note: ${note}`;
}

/** `240`, `12,400`, `1.2M`, `3B`: an estimate, written short. */
function short(rows: number): string {
  const scaled = (by: number, unit: string) =>
    `${(rows / by).toFixed(1).replace(/\.0$/, "")}${unit}`;
  return rows >= 1e9
    ? scaled(1e9, "B")
    : rows >= 1e6
      ? scaled(1e6, "M")
      : rows.toLocaleString("en-US");
}

/**
 * The rows a step goes through in a table, in words: the estimate named as the database's own
 * (`Postgres's` for the store and a Postgres source), never a count.
 */
function rowsWords(rows: Exclude<PlanLock["rows"], "empty">, database: string): string {
  if (rows === "none") {
    return "no rows";
  }
  if (rows === "unknown") {
    return `every row (${database} has no estimate yet)`;
  }
  return `about ${short(rows)} ${rows === 1 ? "row" : "rows"} (${database}'s estimate)`;
}

/** The step a lock is taken in, as its line names it: `store step`, `install of listings`. */
function stepOf(step: PlanStep, source: string | undefined): string {
  return step === "store" ? "store step" : `${step} of ${source ?? "the source"}`;
}

/** When a step's locks end: with its transaction. */
function stepEnd(step: PlanStep): string {
  return step === "store" ? "the store step ends" : `the ${step} ends`;
}

/**
 * One lock on a table that exists, as migrate prints it before it runs: the step, the table as its
 * engine names it, what the application cannot do to it until the step ends, and how many rows the
 * step goes through. No row's content and no connection string is in it.
 */
export function lockLine(lock: PlanLock, source?: string, database = "Postgres"): string {
  const blocks = lock.mode === "no reads or writes" ? "blocks reads and writes" : "blocks writes";
  const rows = lock.rows === "empty" ? "no rows" : rowsWords(lock.rows, database);
  return `  ${stepOf(lock.step, source)}, ${lock.table}: ${blocks} until ${stepEnd(lock.step)}; ${rows}`;
}

/**
 * A step's tables new to it, in one line: `creates 23 tables in facetdb`. Nothing can wait on a
 * table no one else can see yet, so each is not a line of its own.
 */
function createdLine(step: PlanStep, source: string | undefined, created: readonly PlanLock[]) {
  const bySchema = new Map<string, number>();
  for (const lock of created) {
    const schema = lock.table.includes(".") ? lock.table.slice(0, lock.table.indexOf(".")) : "";
    bySchema.set(schema, (bySchema.get(schema) ?? 0) + 1);
  }
  const parts = [...bySchema].map(([schema, count], index) => {
    const noun = index > 0 ? "" : count === 1 ? " table" : " tables";
    return `${count}${noun}${schema === "" ? "" : ` in ${schema}`}`;
  });
  const words =
    parts.length < 2 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return `  ${stepOf(step, source)}: creates ${words}`;
}

/**
 * One step's lines: its new tables folded into one line, then each table it locks; or, when its
 * list could not be made, why, in one line (its secrets hidden by `hide`).
 */
function stepLines(
  step: PlanStep,
  source: string | undefined,
  locks: PlanLocks,
  database: string,
  hide: (text: string) => string,
): readonly string[] {
  if ("unlisted" in locks) {
    return [`  ${stepOf(step, source)}: could not list this step's locks: ${hide(locks.unlisted)}`];
  }
  const created = locks.listed.filter((lock) => lock.rows === "empty");
  return [
    ...(created.length === 0 ? [] : [createdLine(step, source, created)]),
    ...locks.listed
      .filter((lock) => lock.rows !== "empty")
      .map((lock) => lockLine(lock, source, database)),
  ];
}

/** A step's list with its `unlisted` reason's secrets hidden, as the lines and `--json` carry it. */
function hidden(locks: PlanLocks, hide: (text: string) => string): PlanLocks {
  return "unlisted" in locks ? { unlisted: hide(locks.unlisted) } : locks;
}

/** Prints the lock list, both paths' one way: last before the confirmation and in `--dry-run`. */
function printLocks(print: (text: string) => void, section: readonly string[]): void {
  if (section.length > 0) {
    print(section.join("\n"));
  }
}

/** One source's plans as the lock list reads them: the prune's (with `--prune`), then the install's. */
type SourceLocks = {
  readonly source: string;
  readonly prune: EnginePlan | undefined;
  readonly install: EnginePlan;
};

/** A database engine's name as the lock list says whose estimate a row figure is. */
function databaseOf(engine: string): string {
  return engine === "postgres" ? "Postgres" : "the database";
}

/**
 * The lock list migrate prints before the confirmation and in `--dry-run`, on both of its paths:
 * the store's step first, then each source's prune and install, in the order they run. Its header
 * says what any lock does while it waits, with the scripts' own lock timeout. A plan whose engine
 * lists no locks yet prints no list: the whole section is left out when no step has one, and
 * otherwise the plan says so in one line, so its silence never reads as "no lock"; a list that
 * could not be made says why. Nothing listed at all: it says none.
 */
export function lockSection(
  store: PlanLocks,
  sources: readonly SourceLocks[],
  engine: string,
  hide: (text: string) => string = (text) => text,
): readonly string[] {
  const plans = sources.flatMap((item) => [
    ...(item.prune === undefined || item.prune.statements.length === 0
      ? []
      : [{ source: item.source, step: "prune" as const, plan: item.prune }]),
    { source: item.source, step: "install" as const, plan: item.install },
  ]);
  const storeSilent = "listed" in store && store.listed.length === 0;
  if (storeSilent && plans.every(({ plan }) => plan.locks === undefined)) {
    return [];
  }
  const lines = [
    ...stepLines("store", undefined, store, "Postgres", hide),
    ...plans.flatMap(({ source, step, plan }) =>
      plan.locks === undefined
        ? [
            `  ${stepOf(step, source)}: not listed (the ${engine} engine does not list its locks yet)`,
          ]
        : stepLines(step, source, plan.locks, databaseOf(engine), hide),
    ),
  ];
  return lines.length === 0
    ? ["Locks: none."]
    : [
        `Locks (each waits at most ${LOCK_WAIT} for the table; new queries queue behind it meanwhile; then migrate stops and changes nothing):`,
        ...lines,
      ];
}

/**
 * One source's install as `facetdb migrate --dry-run` prints it on stdout (the studio's setup flow
 * shows exactly this): the header, the script, then each note, every line ended as the command's
 * `print` ends it. The lines a dry run prints around it (the store's part, the source's database by
 * its host, "Dry run: nothing was changed.") are not the source's install.
 */
export function installPrintout(
  source: string,
  label: string,
  script: string,
  notes: readonly string[],
): string {
  return [installHeader(source, label), script, ...notes.map(noteLine)]
    .map((line) => (line.endsWith("\n") ? line : `${line}\n`))
    .join("");
}

/**
 * The worker login's password on the first install, from the source's connection string, which is
 * the worker's (`postgres://facetdb_worker:…@host/db`), so the login migrate creates is the one the
 * worker connects with; or why there is none. Once the login exists it is left as it is (other
 * projects on the server may share it) and the engine asks for no password.
 */
export function passwordOf(
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
export async function planInstall(
  engine: DatabaseEngine,
  target: TableTarget,
  own: EngineTarget,
  url: string,
  deps: EngineDeps,
  /** The login's password or why there is none: the source's string's unless the caller knows better. */
  login: ReturnType<typeof passwordOf> = passwordOf(engine, target.source),
): Promise<EnginePlan> {
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
export const STORE_CURRENT = "-- the FacetDB store is current: nothing to run there";

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

/**
 * The project an install refusal names as the table's owner, when it is that refusal: every engine
 * says it in the Postgres engine's words (`<table> already carries FacetDB columns from another
 * project (<owner>); one table belongs to one project.`; MongoDB's of a collection), whether its
 * plan refused or its run stopped at the owner check. Undefined for any other error.
 */
const ANOTHER_PROJECT =
  /from another project \((.+)\); one (?:table|collection) belongs to one project\./;

/**
 * Another project's table, with the fix a copied project needs: a project is named after its folder
 * (`projectRef`), so the same project copied into a folder of another name is another project to
 * the table. Both names are folder names, never a path. Any other error as it came.
 */
function withFolderFix(error: unknown, project: ProjectRef): unknown {
  const owner = error instanceof CliError ? ANOTHER_PROJECT.exec(error.message)?.[1] : undefined;
  if (owner === undefined || !(error instanceof CliError)) {
    return error;
  }
  return new CliError(
    error.code,
    error.message,
    `this project is named after its folder (${project.name}): if it is ${owner} under another folder name, rename the folder back to ${owner} and run facetdb migrate again`,
    error.exit,
    error.details,
  );
}

/** An install that ran, and the source it ran for. */
type Installed = { readonly plan: EnginePlan; readonly source: SourceConfig };

/**
 * What migrate says of the worker login once a Postgres install ran: created with the password in
 * the source's connection string, or found and left as it was (other projects on the server may
 * share it), with the statement an admin runs to give it the new one. The plan that ran tells
 * which: only a plan that creates the login holds the `secret` statement. Neither line holds a
 * password: the statement names the variable to take it from.
 */
export function workerLoginLine(ran: readonly Installed[]): string | undefined {
  const created = ran.find((item) =>
    item.plan.statements.some((statement) => statement.secret === true),
  );
  if (created !== undefined) {
    return `Created the worker login ${WORKER_LOGIN} with the password in ${variableOf(created.source)}.`;
  }
  const [first] = ran;
  if (first === undefined) {
    return undefined;
  }
  const variable = variableOf(first.source);
  return `Found the worker login ${WORKER_LOGIN} and kept its password. If ${variable} has another one, run this as the admin: alter role ${WORKER_LOGIN} password '<the password in ${variable}>';`;
}

/** The confirmation before anything runs, on `where`; anything but yes runs nothing. */
async function confirmRun(deps: CommandContext<MigrateOptions>["deps"], where: string) {
  const answer = await deps.io.prompt(`Run the SQL above on ${where}? Type yes to continue: `);
  if (answer.trim().toLowerCase() !== "yes") {
    throw new CliError(
      "not-confirmed",
      "the SQL was not confirmed, so nothing was run",
      "run facetdb migrate again and type yes, or pass --yes once you have read the SQL",
    );
  }
}

/**
 * Once the store holds the review queue (migration 6), the records decided needs_review before it
 * existed get their cards, once per project of the store, for every source of the config; said when
 * there were any.
 */
async function listWaitingCards(
  { deps, print }: Pick<CommandContext<MigrateOptions>, "deps" | "print">,
  storeUrl: string,
  project: ProjectRef,
  config: ProjectConfig,
): Promise<void> {
  const waiting = await rebuildReviewCards(
    deps.connect,
    storeUrl,
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
}

/**
 * `facetdb migrate` when the sources asked for read no table: a plugin or API source keeps its
 * records and answers in the FacetDB store, so the run is the store's step alone, on
 * `DATABASE_URL`, shown first and confirmed as a full run is. A store already current says so and
 * asks nothing; no admin connection string is asked for, since no source's database is touched.
 */
async function migrateStoreAlone(
  context: Pick<CommandContext<MigrateOptions>, "options" | "deps" | "print">,
  config: ProjectConfig,
  project: ProjectRef,
) {
  const { options, deps, print } = context;
  const storeUrl = requireStoreUrl(deps.env, options.allowInsecure === true);
  const store = await showStoreMigration(deps.connect, storeUrl);
  print(`-- store: ${store.label}`);
  print(store.current ? STORE_CURRENT : store.script);
  for (const note of store.notes) {
    print(noteLine(note));
  }
  // What the store's step locks, as the full run says it: an index built on the decision log holds
  // off the workers' writes to it.
  const hide = (text: string) => plainMessage(text, [storeUrl]);
  const storeLocks = hidden(await storeStepLocks(deps.connect, storeUrl, store), hide);
  printLocks(print, lockSection(storeLocks, [], "postgres", hide));
  const secretWarning = storeSecretWarning(deps.env);
  if (secretWarning !== undefined) {
    deps.io.stderr(`${secretWarning}\n`);
  }
  const summary = (applied: boolean) => ({
    ok: true,
    dryRun: options.dryRun,
    store: {
      database: store.label,
      current: store.current,
      sql: store.script,
      applied: applied && !store.current,
      locks: storeLocks,
    },
    sources: [],
  });
  if (options.dryRun) {
    print("Dry run: nothing was changed.");
    return summary(false);
  }
  if (store.current) {
    print(`The FacetDB store on ${store.label} was current: nothing ran there.`);
  } else {
    requireStoreRunnable(store, "store");
    if (!options.yes) {
      await confirmRun(deps, store.label);
    }
    await runStoreMigration(deps.connect, storeUrl, store, "store");
    print(`Migrated the FacetDB store on ${store.label}.`);
  }
  await listWaitingCards(context, storeUrl, project, config);
  return summary(true);
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
    const project = projectRef(deps.projectDir);
    if (readsNoTable(config, options.source)) {
      return migrateStoreAlone({ options, deps, print }, config, project);
    }
    const targets = tableTargets(config, options.source);
    const allowInsecure = options.allowInsecure === true;
    const [first] = targets;
    if (first === undefined) {
      throw new Error("tableTargets returns at least one target");
    }
    // One admin connection reaches one database (tableTargets): one engine and one store's place.
    // The engine first, so a scheme FacetDB does not serve is refused before a credential is asked.
    const { engine, url } = await adminRun(deps, first, options.adminUrl);
    const storeShared = storeSharedFor(deps.env, first.source);
    // The store's step runs on its own wherever the store is: on the source's own database under
    // the admin string, which is what may create there; else on DATABASE_URL.
    const storeLogin: StoreLogin = storeShared ? "admin" : "store";
    const storeUrl = storeShared ? url : requireStoreUrl(deps.env, allowInsecure);
    const engineDeps: EngineDeps = { clock: deps.clock, allowInsecure, storeShared };
    const shown: Shown[] = [];
    for (const target of targets) {
      const own = engineTarget(config, target, project);
      // The install first: its refusal (another project's table) is migrate's, in its own words,
      // with the fix for a project copied into a folder of another name.
      const install = await planInstall(engine, target, own, url, engineDeps).catch(
        (error: unknown) => {
          throw withFolderFix(error, project);
        },
      );
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
    // Read after the engine's plans, so a refusal of the admin string (no TLS) comes before any
    // connection opens with it.
    const store: StoreMigration = await showStoreMigration(deps.connect, storeUrl);
    print(`-- store: ${store.label}`);
    print(store.current ? STORE_CURRENT : store.script);
    for (const item of shown) {
      print(`-- source ${item.target.source.name}: ${databaseLabel(url)}`);
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
      print(installHeader(item.target.source.name, item.label));
      print(item.installScript);
    }
    // Store version 4 rekeys each source id to `<project>:<name>`; a log another project shared
    // stays with the registered one, said once before anything runs (the store's own notes when it
    // is its own database, the install plan's when the plan holds the store's part).
    const notes = new Set([...store.notes, ...shown.flatMap((item) => item.install.notes)]);
    for (const note of notes) {
      print(noteLine(note));
    }
    // What each step locks, last before the confirmation: read from the scripts above and the
    // databases as they stand, nothing changed. A list that could not be made says why, with no
    // connection string in the words.
    const hide = (text: string) =>
      plainMessage(text, [url, storeUrl, ...targets.map((target) => target.source.database)]);
    const storeLocks = hidden(await storeStepLocks(deps.connect, storeUrl, store), hide);
    // A source's locks under `--json`: the prune's and the install's, as the lines say them; no
    // field where the engine lists none.
    const lockedBy = (
      item: Shown,
    ): { readonly locks?: { readonly prune?: PlanLocks; readonly install?: PlanLocks } } => {
      const prune = item.prune?.locks;
      const install = item.install.locks;
      return prune === undefined && install === undefined
        ? {}
        : {
            locks: {
              ...(prune === undefined ? {} : { prune: hidden(prune, hide) }),
              ...(install === undefined ? {} : { install: hidden(install, hide) }),
            },
          };
    };
    printLocks(
      print,
      lockSection(
        storeLocks,
        shown.map((item) => ({
          source: item.target.source.name,
          prune: item.prune,
          install: item.install,
        })),
        engine.name,
        hide,
      ),
    );
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
      store: {
        database: store.label,
        current: store.current,
        sql: store.script,
        applied: applied && !store.current,
        locks: storeLocks,
      },
      sources: shown.map((item) => ({
        source: item.target.source.name,
        table: item.label,
        ...lockedBy(item),
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
    // The dry run prints the step for whoever may run it; a run whose login may not create the
    // store's tables stops here, before the confirmation, in words (and again at the run).
    requireStoreRunnable(store, storeLogin);
    if (!options.yes) {
      // One database named once: the store's step may run where the table is (a shared store, or a
      // polling source's), told by where the two strings connect, never by their labels.
      const where =
        store.current || sameDatabase(storeUrl, url, deps.env)
          ? databaseLabel(url)
          : `${store.label} and ${databaseLabel(url)}`;
      await confirmRun(deps, where);
    }
    // The store first, in its own transaction committed before any source's begins: the source's
    // worker writes its log there from its first record, and a store migration that builds an index
    // on a large log holds the store's tables while it builds, never a customer's table. Its step
    // is said as it happens, and a source's failure after it says the store moved.
    let migratedStore: string | undefined;
    if (store.current) {
      print(`The FacetDB store on ${store.label} was current: nothing ran there.`);
    } else {
      await runStoreMigration(deps.connect, storeUrl, store, storeLogin);
      migratedStore = store.label;
      print(`Migrated the FacetDB store on ${store.label}.`);
    }
    const installed: string[] = [];
    const ran: Installed[] = [];
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
        ran.push({ plan: install, source: item.target.source });
      } catch (error) {
        const worded = withFolderFix(error, project);
        throw migratedStore === undefined
          ? worded
          : afterStoreMigrated(worded, migratedStore, installed);
      }
      installed.push(item.label);
      const lines = pruned === undefined ? [] : pruneLines(pruned, true);
      if (lines.length > 0) {
        print(`Pruned ${item.label}:`);
        print(lines.join("\n"));
      }
      print(`Installed on ${item.label} (source ${item.target.source.name}).`);
    }
    // The worker login is the server's, so it is said once for the run; on Postgres only, whose
    // statement the line gives (the other engines have no such line yet).
    const loginLine = engine.name === "postgres" ? workerLoginLine(ran) : undefined;
    if (loginLine !== undefined) {
      print(loginLine);
    }
    // The store now holds the review queue (migration 6, in the store's part or the engine's plan).
    await listWaitingCards({ deps, print }, storeUrl, project, config);
    return summary(true);
  },
});
