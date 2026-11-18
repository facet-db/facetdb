import type { DatabaseEngine, DoctorCheck, Question } from "@facetdb/core";
import { ConfigError, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import { DATABASES_PAGE, databaseOf, engineFor } from "../engines.ts";
import {
  type CliDeps,
  CliError,
  defineCommand,
  docsLink,
  type EngineEntry,
  plainMessage,
} from "../program.ts";
import {
  enginePlansStore,
  heartbeatCheck,
  pollingStoreClash,
  STORE_SECRET_VARIABLE,
  sameDatabase,
  secretCheck,
  storeCheck,
  storePoolerCheck,
  storeUrlOf,
  storeUrlProblem,
  storeVariableMisuse,
} from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  engineTarget,
  projectRef,
  splitTable,
  variableOf,
  WORKER_LOGIN,
} from "./database.ts";

/**
 * `facetdb doctor`: runs the checks in order, prints one line each with the fix, and exits 1 naming
 * the first failing check, 0 when all pass. A source's database is checked by its engine
 * (`DatabaseEngine.doctor`: the connection and login with the distance, the pooler, the install),
 * the store by the store door. When the store is the one table source's own database, or
 * `DATABASE_URL` names none, the report is today's eight lines; with the store in another database,
 * or several table sources, the lines come in a `source <name>:` group per source and a `store:`
 * group (the store reachable and current, its pooler, the worker's heartbeat, the secret). A
 * source's checks come after one `engine:` line naming the engine that checked it, the database its
 * scheme names and the server's version where the engine read one; each check prints under its
 * engine's own name, and each fix ends with the page about that check. A check that cannot run
 * because an earlier one failed is skipped, not reported as a second failure. Nothing here changes
 * a database or the store.
 */

type DoctorOptions = {
  readonly config: string;
  readonly offline: boolean;
  readonly allowInsecure?: boolean;
};

/**
 * `warn` is something to know that is not a failure: it is not counted and the exit code stays 0.
 * `info` is the `engine:` line before a source's checks: never a check, never counted.
 */
export type CheckStatus = "ok" | "fail" | "skip" | "warn" | "info";

/** Which engine checked a source, as the `engine:` line says it and `--json` carries it. */
export type EngineReport = {
  /** The source it serves. */
  readonly source: string;
  /** The engine's own name: `postgres`, `mysql`, `polling`. */
  readonly name: string;
  /** The database the connection string's scheme names: `MySQL or MariaDB`. */
  readonly database: string;
  /** The server's version as the engine's own version check read it, when it has one and it passed. */
  readonly version?: string;
};

export type CheckResult = {
  readonly status: CheckStatus;
  /** What was found, in plain words. */
  readonly detail: string;
  /** What to do, for a failure. */
  readonly fix?: string;
};

export type CheckLine = CheckResult & {
  readonly id: string;
  readonly label: string;
  /** The group it is printed under: `source <name>` or `store`; none in the eight-line report. */
  readonly group?: string;
  /** On the `engine:` line only: what it says, as data. */
  readonly engine?: EngineReport;
};

/** What a check may touch: the command's dependencies and options. */
export type DoctorEnvironment = {
  readonly deps: CliDeps;
  readonly options: DoctorOptions;
};

const ok = (detail: string): CheckResult => ({ status: "ok", detail });
const fail = (detail: string, fix: string): CheckResult => ({ status: "fail", detail, fix });
const skip = (detail: string): CheckResult => ({ status: "skip", detail });

/** The words of the checks an engine names by id (`worker`, not "worker heartbeat"). */
const LABELS: Readonly<Record<string, string>> = { worker: "worker heartbeat" };
const labelOf = (name: string) => LABELS[name] ?? name;

const CONFIG_CHECK = {
  id: "config",
  label: "config",
  looksAt: "loads the config file and judges it with the schema",
} as const;

const MODEL_KEY = {
  id: "model-key",
  label: "model key",
  looksAt: "checks that TYPESAFE_API_KEY is set, or that the config names a model server",
} as const;

const MODEL_REACHABLE = {
  id: "model-reachable",
  label: "model reachable",
  looksAt: "asks the model one tiny question (skipped with --offline)",
} as const;

const SECRET = {
  id: "secret",
  label: STORE_SECRET_VARIABLE,
  looksAt: `checks that ${STORE_SECRET_VARIABLE} is set`,
} as const;

/** The store group's own check: the store reachable and at this FacetDB's schema version. */
const STORE_LABEL = "store";

/**
 * The worker's connection string when the source has none to read its database from: Postgres's
 * shape, the store's kind, and the page with every other database's.
 */
const WORKER_URL_SHAPE = `postgres://${WORKER_LOGIN}:<a long random password>@<host>/<database>, or the worker's connection string for your database in the shape ${DATABASES_PAGE} shows`;

/**
 * The checks whose passing detail is the server's version as the engine read it (`MySQL 8.4.3`,
 * `SQL Server 2022 (16)`, `MongoDB 7.0.14`, `SQLite 3.46.1`): the `engine:` line repeats it.
 */
const VERSION_CHECKS: ReadonlySet<string> = new Set(["version", "sqlite"]);

/** The `engine:` line of a source, from its engine, its connection string and its checks. */
function engineLine(
  engine: DatabaseEngine,
  source: SourceConfig,
  url: string,
  checks: readonly DoctorCheck[],
  group?: string,
): CheckLine {
  const database = databaseOf(url)?.name ?? engine.name;
  const version = checks.find(
    (check) => VERSION_CHECKS.has(check.name) && (check.status === "ok" || check.status === "warn"),
  )?.detail;
  const how = [
    ...(source.connector === undefined ? [] : [`connector: "${source.connector}"`]),
    ...(source.capture === undefined ? [] : [`capture: "${source.capture}"`]),
  ];
  const report: EngineReport = {
    source: source.name,
    name: engine.name,
    database,
    ...(version === undefined ? {} : { version }),
  };
  return {
    id: "engine",
    label: "engine",
    status: "info",
    detail: `${engine.name}, for ${database}${how.length === 0 ? "" : ` (${how.join(", ")})`}${version === undefined ? "" : `; the server is ${version}`}`,
    engine: report,
    ...(group === undefined ? {} : { group }),
  };
}

function line(
  entry: { readonly id: string; readonly label: string },
  result: CheckResult,
  group?: string,
): CheckLine {
  return {
    id: entry.id,
    label: entry.label,
    status: result.status,
    detail: result.detail,
    ...(result.fix === undefined ? {} : { fix: result.fix }),
    ...(group === undefined ? {} : { group }),
  };
}

/** A check's result from the engine or the store door, as a line; `scrub` blanks the CLI's secrets. */
function fromCheck(check: DoctorCheck, scrub: (text: string) => string, group?: string): CheckLine {
  return line(
    { id: check.name, label: labelOf(check.name) },
    {
      status: check.status,
      detail: scrub(check.detail),
      ...(check.fix === undefined ? {} : { fix: scrub(check.fix) }),
    },
    group,
  );
}

/** 1. The config file loads and passes the schema; the first check, run on its own before the others. */
async function configLoads(environment: DoctorEnvironment): Promise<{
  readonly result: CheckResult;
  readonly config?: ProjectConfig;
}> {
  const path = environment.options.config;
  try {
    const config = await environment.deps.loadConfig(path);
    const sources = config.sources.length;
    return {
      result: ok(`${path} loads, with ${sources} ${sources === 1 ? "source" : "sources"}`),
      config,
    };
  } catch (error) {
    if (error instanceof ConfigError) {
      const problems = error.issues
        .map((issue) => (issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`))
        .join("; ");
      return {
        result: fail(
          `${path} does not load: ${problems}`,
          `do what each problem says in ${path}, or create the file with facetdb init`,
        ),
      };
    }
    return {
      result: fail(
        `${path} could not be read: ${plainMessage(error, [])}`,
        `check that ${path} exists and is valid TypeScript, or create it with facetdb init`,
      ),
    };
  }
}

/** A model key is set, or the config names a compatible server that needs none. */
function modelKey({ deps }: DoctorEnvironment, config: ProjectConfig): CheckResult {
  if (config.modelUrl !== undefined) {
    return ok(`the model is served from ${config.modelUrl}, so no TypeSafe key is needed`);
  }
  const key = deps.env["TYPESAFE_API_KEY"];
  return key === undefined || key === ""
    ? fail(
        "TYPESAFE_API_KEY is not set, so FacetDB has no key for the model",
        "set TYPESAFE_API_KEY to your TypeSafe key, or set modelUrl in the config to a compatible server",
      )
    : ok("TYPESAFE_API_KEY is set");
}

/** The smallest question there is; the model answers it so doctor can say the provider is reachable. */
const PING_QUESTION: Question = {
  type: "noul",
  name: "doctor_ping",
  instructions: "Is this note a test?",
  stakes: "low",
};

/** The provider answers one tiny question; `--offline` skips the network. */
async function modelReachable(
  { deps, options }: DoctorEnvironment,
  config: ProjectConfig,
): Promise<CheckResult> {
  if (options.offline) {
    return skip("skipped because of --offline");
  }
  try {
    const response = await deps.provider(config).ask({
      model: config.model,
      state: { note: "This is a test from facetdb doctor." },
      questions: [PING_QUESTION],
    });
    return ok(`${response.model} answered a test question`);
  } catch (error) {
    return fail(
      `the model did not answer: ${plainMessage(error, [deps.env["TYPESAFE_API_KEY"]])}`,
      config.modelUrl === undefined
        ? "check TYPESAFE_API_KEY and this machine's network access to TypeSafe, or run facetdb doctor --offline to leave this check out"
        : `check that ${config.modelUrl} is running and reachable from this machine, or run facetdb doctor --offline to leave this check out`,
    );
  }
}

/** The model's two checks, the second only once the first passed. */
async function modelLines(
  environment: DoctorEnvironment,
  config: ProjectConfig,
): Promise<readonly CheckLine[]> {
  const key = line(MODEL_KEY, modelKey(environment, config));
  const reachable =
    key.status === "ok"
      ? await modelReachable(environment, config)
      : skip(`not checked: the ${MODEL_KEY.label} check did not pass`);
  return [key, line(MODEL_REACHABLE, reachable)];
}

/** A table source, with the connection string it reads and whether the store is its database. */
type TableSource = {
  readonly source: SourceConfig;
  readonly url: string | undefined;
  readonly sharesStore: boolean;
};

/**
 * The connection string of a source: written in its config, or in the variable it is read from. A
 * polling source never shares the store (`enginePlansStore`): its engine checks no store, so the
 * store's own group says how the store stands.
 */
function tableSourcesOf(config: ProjectConfig, env: CliDeps["env"]): readonly TableSource[] {
  const store = storeUrlOf(env);
  return config.sources
    .filter((source) => source.table !== undefined)
    .map((source) => {
      const given = source.database ?? env[variableOf(source)];
      const url = given === "" ? undefined : given;
      return {
        source,
        url,
        sharesStore:
          enginePlansStore(source) &&
          store !== undefined &&
          url !== undefined &&
          sameDatabase(store, url, env),
      };
    });
}

/**
 * A table source's checks from its engine (database, distance, pooler, install), and the engine's
 * heartbeat line apart: it is the report's only when the store is this source's database. Never
 * throws: a source with no connection string, one that reads the store's variable for a database
 * that is not a Postgres, one no engine reads, or one whose engine fails to load (a driver that is
 * not installed) fails the database check, and the other sources and the store are still checked.
 */
async function sourceLines(
  environment: DoctorEnvironment,
  config: ProjectConfig,
  table: TableSource,
  scrub: (text: string) => string,
  group?: string,
): Promise<{ readonly lines: readonly CheckLine[]; readonly worker?: CheckLine }> {
  const { deps, options } = environment;
  const { source, url } = table;
  // The checks a failure here leaves unrun: the engine's own names once it is known, else the
  // Postgres engine's, the names of the eight-line report.
  const failed = (result: CheckResult, engine?: DatabaseEngine) => ({
    lines: [
      line({ id: "database", label: "database" }, result, group),
      ...(engine === undefined
        ? ["pooler", "install"]
        : engine.checks
            .map((check) => check.name)
            .filter((name) => name !== "database" && name !== "worker")
      ).map((id) =>
        line(
          { id, label: labelOf(id) },
          skip("not checked: the database check did not pass"),
          group,
        ),
      ),
    ],
  });
  if (url === undefined) {
    const variable = variableOf(source);
    return failed(
      fail(
        `${variable} is not set, so "${source.name}" has no database to connect to`,
        `set ${variable} to ${WORKER_URL_SHAPE}`,
      ),
    );
  }
  // Loaded first, so a refusal below names the engine's own checks as the ones left unrun.
  let resolved: { readonly engine: DatabaseEngine } | { readonly error: unknown };
  try {
    resolved = { engine: await engineFor(deps.engines, url, source.connector) };
  } catch (error) {
    resolved = { error };
  }
  const known = "engine" in resolved ? resolved.engine : undefined;
  const misuse = storeVariableMisuse(source, url) ?? pollingStoreClash(deps.env, source, url);
  if (misuse !== undefined) {
    return failed(fail(misuse.message, misuse.fix), known);
  }
  if (!("engine" in resolved)) {
    const { error } = resolved;
    // A scheme no engine here reads, or polling before its engine: the database check's failure.
    if (error instanceof CliError) {
      return failed(fail(`"${source.name}": ${error.message}`, error.fix));
    }
    // The engine's module did not load (its driver missing or broken): this source's failure.
    return failed(
      fail(
        `"${source.name}": the engine for its database could not be loaded: ${scrub(plainMessage(error, [url]))}`,
        "reinstall facetdb with its dependencies (npm install facetdb), then run facetdb doctor again",
      ),
    );
  }
  const { engine } = resolved;
  const target = engineTarget(
    config,
    { source, ...splitTable(source.table ?? "") },
    projectRef(deps.projectDir),
  );
  const checks = await engine.doctor(target, url, {
    clock: deps.clock,
    allowInsecure: options.allowInsecure === true,
    storeShared: table.sharesStore,
  });
  const worker = checks.find((check) => check.name === "worker" && check.status !== "skip");
  return {
    lines: [
      // The version it repeats is a check's detail, scrubbed as every engine word is.
      engineLine(
        engine,
        source,
        url,
        checks.map((check) => ({ ...check, detail: scrub(check.detail) })),
        group,
      ),
      ...checks
        .filter((check) => check.name !== "worker")
        .map((check) => fromCheck(check, scrub, group)),
    ],
    ...(worker === undefined ? {} : { worker: fromCheck(worker, scrub, group) }),
  };
}

/** The lines when no source reads a table: nothing to reach or install, the store's pooler alone. */
async function noTableLines(environment: DoctorEnvironment): Promise<readonly CheckLine[]> {
  const { deps, options } = environment;
  const store = storeUrlOf(deps.env);
  // A store URL the TLS rule refuses is the heartbeat check's failure: never probed here.
  const probed =
    store === undefined ||
    storeUrlProblem(store, options.allowInsecure, deps.env["PGHOST"]) !== undefined
      ? undefined
      : await storePoolerCheck(deps.connect, store);
  return [
    line(
      { id: "database", label: "database" },
      ok("no source reads a table, so there is no database to reach"),
    ),
    probed === undefined
      ? line({ id: "pooler", label: "pooler" }, ok("no connection to check"))
      : fromCheck(probed, (text) => text),
    line(
      { id: "install", label: "install" },
      ok("facetdb schema, jobs table, trigger and answer columns are in place"),
    ),
  ];
}

/** The store group's lines: reachable and current, its pooler, the worker's heartbeat, the secret. */
async function storeLines(
  environment: DoctorEnvironment,
  scrub: (text: string) => string,
): Promise<readonly CheckLine[]> {
  const { deps, options } = environment;
  const group = "store";
  const reached = fromCheck(
    await storeCheck(deps.connect, deps.env, options.allowInsecure),
    scrub,
    group,
  );
  const store = storeUrlOf(deps.env);
  const pooler =
    reached.status === "ok" && store !== undefined
      ? fromCheck(await storePoolerCheck(deps.connect, store), scrub, group)
      : line(
          { id: "pooler", label: "pooler" },
          skip(`not checked: the ${STORE_LABEL} check did not pass`),
          group,
        );
  return [
    reached,
    pooler,
    fromCheck(await heartbeat(environment), scrub, group),
    line(SECRET, secretCheck(deps.env), group),
  ];
}

/** The worker's heartbeat, read from the store by the store door. */
function heartbeat({ deps, options }: DoctorEnvironment): Promise<DoctorCheck> {
  return heartbeatCheck(
    deps.connect,
    deps.env,
    deps.clock,
    projectRef(deps.projectDir).id,
    options.allowInsecure,
  );
}

/** Runs every check in order. A check never throws: what goes wrong inside one is that check's failure. */
export async function runChecks(environment: DoctorEnvironment): Promise<readonly CheckLine[]> {
  const { deps } = environment;
  const loaded = await configLoads(environment);
  const lines: CheckLine[] = [line(CONFIG_CHECK, loaded.result)];
  const { config } = loaded;
  if (config === undefined) {
    const notChecked = skip("not checked: the config did not load");
    for (const id of ["database", "pooler", "install", "worker"]) {
      lines.push(line({ id, label: labelOf(id) }, notChecked));
    }
    lines.push(line(MODEL_KEY, notChecked), line(MODEL_REACHABLE, notChecked));
    // The one check that needs no config: it reads the environment alone, so it always runs.
    lines.push(line(SECRET, secretCheck(deps.env)));
    return lines;
  }
  // What an engine says is scrubbed of the CLI's own secrets, which no engine is given.
  const scrub = (text: string) =>
    plainMessage(text, [deps.env[STORE_SECRET_VARIABLE], deps.env["TYPESAFE_API_KEY"]]);
  const tables = tableSourcesOf(config, deps.env);
  const [only] = tables;
  const eightLines =
    tables.length === 0 ||
    (only !== undefined &&
      tables.length === 1 &&
      (storeUrlOf(deps.env) === undefined || only.sharesStore));
  if (eightLines) {
    if (only === undefined) {
      lines.push(...(await noTableLines(environment)));
      lines.push(fromCheck(await heartbeat(environment), scrub));
    } else {
      const checked = await sourceLines(environment, config, only, scrub);
      lines.push(...checked.lines);
      // The engine reads the heartbeat when the store is its database; the store door otherwise.
      lines.push(checked.worker ?? fromCheck(await heartbeat(environment), scrub));
    }
    lines.push(...(await modelLines(environment, config)));
    lines.push(line(SECRET, secretCheck(deps.env)));
    return lines;
  }
  lines.push(...(await modelLines(environment, config)));
  for (const table of tables) {
    const group = `source ${table.source.name}`;
    lines.push(...(await sourceLines(environment, config, table, scrub, group)).lines);
  }
  lines.push(...(await storeLines(environment, scrub)));
  return lines;
}

const MARKS: Record<CheckStatus, string> = {
  ok: "ok  ",
  fail: "FAIL",
  skip: "skip",
  warn: "warn",
  info: "    ",
};

/** One printed line; a fix ends with the page about that check. */
function render(entry: CheckLine): string {
  const mark = MARKS[entry.status];
  return `${mark}  ${entry.label}: ${entry.detail}${entry.fix === undefined ? "" : ` Fix: ${entry.fix}. See ${docsLink(`doctor-${entry.id}`)}`}`;
}

/**
 * What `--dry-run` lists: the config, every registered engine's checks once, the model, the
 * secret. It loads every registered engine to read its checks (a real run loads only the engines
 * its sources use), and connects to nothing.
 */
async function planned(entries: readonly EngineEntry[]): Promise<
  readonly {
    readonly id: string;
    readonly label: string;
    readonly looksAt: string;
  }[]
> {
  const checks = new Map<string, string>();
  for (const entry of entries) {
    const engine = await entry.load();
    for (const check of engine.checks) {
      if (!checks.has(check.name)) {
        checks.set(check.name, check.looksAt);
      }
    }
  }
  return [
    CONFIG_CHECK,
    ...[...checks].map(([id, looksAt]) => ({ id, label: labelOf(id), looksAt })),
    MODEL_KEY,
    MODEL_REACHABLE,
    SECRET,
  ];
}

export const doctorCommand = defineCommand<DoctorOptions>("doctor", {
  description:
    "Checks the connection, permissions, trigger, worker and model key, and says what is wrong",
  options: [
    {
      flags: "--config <path>",
      description: "the config file",
      defaultValue: "facetdb.config.ts",
    },
    { flags: "--offline", description: "skip the check that needs the network (the model)" },
    ALLOW_INSECURE_OPTION,
  ],
  run: async ({ options, deps, print }) => {
    const environment: DoctorEnvironment = { deps, options };
    if (options.dryRun) {
      const entries = await planned(deps.engines);
      for (const [index, entry] of entries.entries()) {
        print(`${index + 1}. ${entry.label}: ${entry.looksAt}`);
      }
      print("Dry run: nothing was checked.");
      return {
        ok: true,
        dryRun: true,
        checks: entries.map((entry) => ({
          id: entry.id,
          label: entry.label,
          looksAt: entry.looksAt,
        })),
      };
    }
    const lines = await runChecks(environment);
    let group: string | undefined;
    for (const entry of lines) {
      if (entry.group !== undefined && entry.group !== group) {
        print(`${entry.group}:`);
      }
      group = entry.group;
      print(render(entry));
    }
    const failing = lines.filter((entry) => entry.status === "fail");
    const first = failing[0];
    // A warning is a note under a check, not a check: it is in neither total, nor in `checks`;
    // nor is an `engine:` line, which `engines` carries (and `engine`, when one source has one).
    const checks = lines.filter((entry) => entry.status !== "warn" && entry.status !== "info");
    const warnings = lines.filter((entry) => entry.status === "warn");
    const engines = lines.flatMap((entry) => (entry.engine === undefined ? [] : [entry.engine]));
    const [engine] = engines;
    const reported = {
      checks,
      warnings,
      engines,
      ...(engine === undefined || engines.length > 1 ? {} : { engine }),
    };
    if (first === undefined) {
      print(`All ${checks.length} checks passed.`);
      return { ok: true, ...reported };
    }
    print(`${failing.length} of ${checks.length} checks failed.`);
    throw new CliError(
      `doctor-${first.id}`,
      `the ${first.label} check failed: ${first.detail}`,
      first.fix ?? "",
      undefined,
      reported,
    );
  },
});
