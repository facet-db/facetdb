import {
  type DatabaseEngine,
  type DoctorCheck,
  modelNameWords,
  type Question,
} from "@facetdb/core";
import { createBackoff, RetryableError } from "@facetdb/model";
import {
  ConfigError,
  type PluginProviderRef,
  type ProjectConfig,
  pluginProviderOf,
  type SourceConfig,
} from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import {
  checkActions,
  checkChannels,
  checkPluginProvider,
  checkSources,
  type PluginHost,
  PluginHostError,
  PluginProviderError,
} from "../../plugin/index.ts";
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
  heldVersions,
  pollingStoreClash,
  STORE_SECRET_VARIABLE,
  STORE_VARIABLE,
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
import { presetKeyOf } from "./model-provider.ts";

/**
 * `facetdb doctor`: runs the checks in order, prints one line each with the fix, and exits 1 naming
 * the first failing check, 0 when all pass. A source's database is checked by its engine
 * (`DatabaseEngine.doctor`: the connection and login with the distance, the pooler, the capture and
 * the install), the store by the store door. When the store is the one table source's own database,
 * or `DATABASE_URL` names none, the report is one list of lines (nine on Postgres added `capture`);
 * with the store in another database, or several table sources, the lines come in a `source
 * <name>:` group per source and a `store:` group (the store reachable and current, its pooler, the
 * worker's heartbeat, the secret). A source's checks come after one `engine:` line naming the
 * engine that checked it, the database its scheme names and the server's version where the engine
 * read one; each check prints under its engine's own name, and each fix ends with the page about
 * that check. A check that cannot run because an earlier one failed is skipped, not reported as a
 * second failure. Nothing here changes a database or the store.
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
  /** The group it is printed under: `source <name>` or `store`; none in the one-list report. */
  readonly group?: string;
  /** On the `engine:` line only: what it says, as data. */
  readonly engine?: EngineReport;
};

/** What a check may touch: the command's dependencies and options. */
export type DoctorEnvironment = {
  readonly deps: CliDeps;
  readonly options: DoctorOptions;
  /** A step's bound in milliseconds: `DOCTOR_STEP_MS` unless a test passes a shorter one. */
  readonly stepMs?: number;
  /** How long a connection may take to open, in seconds: the step's bound unless a test passes one. */
  readonly connectTimeoutSeconds?: number;
};

const ok = (detail: string): CheckResult => ({ status: "ok", detail });
const fail = (detail: string, fix: string): CheckResult => ({ status: "fail", detail, fix });
const skip = (detail: string): CheckResult => ({ status: "skip", detail });
const warn = (detail: string): CheckResult => ({ status: "warn", detail });

/** The words of the checks an engine names by id (`worker`, not "worker heartbeat"). */
const LABELS: Readonly<Record<string, string>> = { worker: "worker heartbeat" };
const labelOf = (name: string) => LABELS[name] ?? name;

const CONFIG_CHECK = {
  id: "config",
  label: "config",
  looksAt: "loads the config file and judges it with the schema",
} as const;

/** Present only when the config names a plugin, so `planned` (no config read) never lists it. */
const PLUGINS_CHECK = { id: "plugins", label: "plugins" } as const;

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
 * How long one step of a run may take, in milliseconds: the config, a source's engine checks, the
 * heartbeat, the model, the store. Past it, the checks of the step that had not ended fail saying
 * so and the run goes on; each connection a step opens may take as long to open
 * (`DoctorDeps.connectTimeoutSeconds`; the Postgres engine's own default is the same 10 seconds,
 * `DOCTOR_CONNECT_TIMEOUT_S` in packages/postgres/src/engine/doctor.ts).
 */
export const DOCTOR_STEP_MS = 10_000;

/** A number of seconds in words: `1 second`, `0.5 seconds`, `10 seconds`. */
const secondsWords = (seconds: number) => `${seconds} ${seconds === 1 ? "second" : "seconds"}`;

/** A run of the checks: the command's environment, its bounds, and the servers that never answered. */
type Run = DoctorEnvironment & {
  readonly stepMs: number;
  readonly connectTimeoutSeconds: number;
  /**
   * The login, host, port and database (never the password) of each connection string whose
   * server never answered a step: a later step asks it nothing and fails at once. A pooler host
   * serving other databases or logins is still asked for those.
   */
  readonly silent: Set<string>;
};

/** `within 10 seconds`, from the run's own bound. */
const within = (run: Run) => `within ${secondsWords(run.stepMs / 1000)}`;

/** What a connection string reaches, as `login@host:port/database`; none for one `new URL` cannot read. */
function serverKeyOf(url: string | undefined): string | undefined {
  if (url === undefined) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    return parsed.host === "" ? undefined : `${parsed.username}@${parsed.host}${parsed.pathname}`;
  } catch {
    return undefined;
  }
}

/** The run never asks this connection string's server anything more. */
function markSilent(run: Run, url: string | undefined): void {
  const key = serverKeyOf(url);
  if (key !== undefined) {
    run.silent.add(key);
  }
}

/** A step's server that never answered, naming its host and never its connection string. */
function notAnswered(run: Run, url: string | undefined): string {
  let host = "";
  try {
    host = url === undefined ? "" : new URL(url).host;
  } catch {
    // Not a URL `new URL` reads: the words name no host.
  }
  return `${host === "" ? "the database server" : `the server at ${host}`} did not answer ${within(run)}`;
}

/** The fix for a server that never answered: its address, and what may stand in the way. */
const notAnsweredFix = (variable: string) =>
  `check the host and port in ${variable}, and that the database accepts connections from this machine (a firewall or an allow-list)`;

/** A check that had not ended when its step ran out, its server having answered the ones before. */
const notFinished = (run: Run, name: string) =>
  `the ${labelOf(name)} check did not finish ${within(run)}`;

const NOT_FINISHED_FIX =
  "the database answered but this check was slow: run facetdb doctor again, and if it repeats, look at the server's load";

/**
 * Runs one step against the run's bound on its clock: what it ended with, or `late` when the
 * clock got there first. The timer is cleared on every exit; a step given up on runs on unheard,
 * and what it ends with is dropped. Given the connection string it reaches, a server that never
 * answered an earlier step is not asked again (`late` at once). A clock whose wait ends at once
 * (a fake that moves time on `sleep`, or one that never moves) would make every step late: that is
 * a wiring error, and it throws instead of reporting answering servers as silent.
 */
async function bounded<T>(
  run: Run,
  work: () => Promise<T>,
  url?: string,
): Promise<{ readonly value: T } | "late"> {
  const key = serverKeyOf(url);
  if (key !== undefined && run.silent.has(key)) {
    return "late";
  }
  const { clock } = run.deps;
  const timer = new AbortController();
  const started = clock.now();
  try {
    const deadline = clock.sleep(run.stepMs, timer.signal).then(() => "late" as const);
    if (clock.now() - started >= run.stepMs) {
      throw new DoctorClockError(run);
    }
    const ended = await Promise.race([work().then((value) => ({ value })), deadline]);
    if (ended === "late" && clock.now() - started < run.stepMs / 2) {
      throw new DoctorClockError(run);
    }
    return ended;
  } finally {
    timer.abort();
  }
}

/** A clock whose waits end at once, refused by `bounded`: a wiring error, never a check's failure. */
class DoctorClockError extends Error {
  constructor(run: Run) {
    super(
      `doctor's clock ended a ${secondsWords(run.stepMs / 1000)} wait without that time passing on it, so every step would read as unanswered: give doctor a clock whose sleeps wait (the process clock, or SteppedClock in a test)`,
    );
    this.name = "DoctorClockError";
  }
}

/** The driver a step reaches the store with: every connection opens within the run's connect bound. */
function stepDriver(run: Run): {
  readonly connect: CliDeps["connect"];
  /** Ends every connection the step opened: a step given up on holds none after the run. */
  readonly release: () => void;
} {
  const opened: ReturnType<CliDeps["connect"]>[] = [];
  return {
    connect: (url, options) => {
      const client = run.deps.connect(url, {
        ...options,
        connectTimeoutSeconds: run.connectTimeoutSeconds,
      });
      opened.push(client);
      return client;
    },
    release: () => {
      for (const client of opened) {
        client.close().catch(() => undefined);
      }
    },
  };
}

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
    ...(source.lastChanged === undefined
      ? []
      : [`lastChanged: ${JSON.stringify(source.lastChanged)}`]),
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

/**
 * The `plugins` check's result, from the host the config's plugins were loaded into: each plugin by
 * its package, its version and the range of FacetDB it supports. The host refused any whose range
 * does not hold, so every one listed holds for this FacetDB. Strings here are the manifest's own,
 * which the loader checked to be a name, a semver version and a semver range.
 */
function pluginsHold(host: PluginHost): CheckResult | undefined {
  const hosted = host.all();
  if (hosted.length === 0) {
    return undefined;
  }
  const each = hosted.map(
    ({ packageName, plugin }) =>
      `${packageName} ${plugin.manifest.version} (FacetDB ${plugin.manifest.coreVersions})`,
  );
  return ok(
    `${each.join(", ")}: each loads, supports this FacetDB (${VERSION}) and has settings its schema accepts`,
  );
}

/** 1. The config file loads and passes the schema; the first check, run on its own before the others. */
async function configLoads(environment: DoctorEnvironment): Promise<{
  readonly result: CheckResult;
  readonly config?: ProjectConfig;
  /** The plugin host, when the plugins the config names loaded: a plugin's provider needs it. */
  readonly plugins?: PluginHost;
  /** The `plugins` check, when the config names a plugin. */
  readonly pluginsCheck?: CheckResult;
}> {
  const path = environment.options.config;
  try {
    const config = await environment.deps.loadConfig(path);
    // The plugins the config names are loaded and their settings checked as the worker does at its
    // start. The file itself loaded, so the checks after this one still run.
    let plugins: PluginHost;
    try {
      plugins = await environment.deps.pluginHost(config, path);
      // Each source's actions against those plugins, as the worker checks them at its start.
      checkActions(config, plugins, environment.deps.env);
      // And each alert channel bound to its plugin's channel.
      checkChannels(config, plugins, environment.deps.env);
      // Each plugin source against its plugin, as the worker checks it at its start.
      checkSources(config, plugins, environment.deps.env);
    } catch (error) {
      if (error instanceof PluginHostError) {
        // A check is one line: the schema's listed reasons follow the heading, joined.
        const [heading, ...reasons] = error.message.split(/\n\s*- /);
        const words = reasons.length === 0 ? `${heading}` : `${heading} ${reasons.join("; ")}`;
        return {
          result: fail(`${path} loads, but ${words}`, error.fix),
          config,
          pluginsCheck: fail(words, error.fix),
        };
      }
      // The host words every refusal itself; anything else came from a plugin's own code, and
      // its text is not printed, since it could quote a value the plugin was handed.
      const fix =
        "run facetdb worker --dry-run to see which plugin stops it, then reinstall that plugin or report it to its author";
      return {
        result: fail(`${path} loads, but loading the plugins it names failed unexpectedly`, fix),
        config,
        pluginsCheck: fail("loading the plugins the config names failed unexpectedly", fix),
      };
    }
    const sources = config.sources.length;
    const pluginsCheck = pluginsHold(plugins);
    return {
      result: ok(`${path} loads, with ${sources} ${sources === 1 ? "source" : "sources"}`),
      config,
      plugins,
      ...(pluginsCheck === undefined ? {} : { pluginsCheck }),
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

/** The check line's words when the config names a plugin's provider. */
function pluginProviderKey(
  provider: string,
  ref: PluginProviderRef,
  plugins: PluginHost | undefined,
): CheckResult {
  if (plugins === undefined) {
    return fail(
      `the provider ${provider} comes from the plugin ${ref.plugin}, which did not load`,
      "do what the config check says, then run facetdb doctor again",
    );
  }
  try {
    checkPluginProvider({ provider, ref, host: plugins });
  } catch (error) {
    if (error instanceof PluginProviderError) {
      return fail(error.message, error.fix);
    }
    throw error;
  }
  return ok(
    `the provider ${provider} is supplied by the plugin ${ref.plugin}, which reads the variables its settings name (the config check read them)`,
  );
}

/** A model key is set, or the config names a compatible server that needs none. */
function modelKey(
  { deps }: DoctorEnvironment,
  config: ProjectConfig,
  plugins: PluginHost | undefined,
): CheckResult {
  const chosen = presetKeyOf(config);
  if (chosen !== undefined) {
    const set = (deps.env[chosen.variable] ?? "") !== "";
    if (set && chosen.withheld) {
      return ok(
        `the ${chosen.provider} provider reads ${chosen.variable}, and it is set, but it is not sent: ${chosen.address} is plain http to another machine, where a key would cross the network in the clear; use an https modelUrl to send it`,
      );
    }
    if (set) {
      return ok(`the ${chosen.provider} provider reads ${chosen.variable}, and it is set`);
    }
    return chosen.required
      ? fail(
          `${chosen.variable} is not set, so FacetDB has no key for the ${chosen.provider} provider`,
          `set ${chosen.variable} to your ${chosen.provider} key where FacetDB runs`,
        )
      : ok(
          `the ${chosen.provider} provider reads ${chosen.variable} when it is set; it is not, so the server is asked with no key`,
        );
  }
  const plugin = config.provider === undefined ? undefined : pluginProviderOf(config.provider);
  if (config.provider !== undefined && plugin !== undefined) {
    return pluginProviderKey(config.provider, plugin, plugins);
  }
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

/** The model check's result, with the name the model answered under when it answered. */
type Reached = CheckResult & { readonly named?: string };

/** The one tiny question asked under `model`; the name the server answered under. */
async function ping(
  { deps }: DoctorEnvironment,
  config: ProjectConfig,
  plugins: PluginHost | undefined,
  model: string,
): Promise<string> {
  const response = await deps.provider(config, plugins).ask({
    model,
    state: { note: "This is a test from facetdb doctor." },
    questions: [PING_QUESTION],
  });
  return response.model;
}

/** The keys a model error may quote, blanked from what doctor prints. */
function modelKeys({ deps }: DoctorEnvironment, config: ProjectConfig): (string | undefined)[] {
  const chosen = presetKeyOf(config);
  return [
    deps.env["TYPESAFE_API_KEY"],
    ...(chosen === undefined ? [] : [deps.env[chosen.variable]]),
  ];
}

/** The provider answers one tiny question; `--offline` skips the network. */
async function modelReachable(
  environment: Run,
  config: ProjectConfig,
  plugins: PluginHost | undefined,
): Promise<Reached> {
  const chosen = presetKeyOf(config);
  // A preset the FacetDB team has not run against its vendor says so, whatever the answer was.
  const unrun =
    chosen === undefined || chosen.proven
      ? ""
      : `; the FacetDB team has not run the ${chosen.provider} provider yet, so tell us how it went`;
  if (environment.options.offline) {
    return skip(`skipped because of --offline${unrun}`);
  }
  const leave = "or run facetdb doctor --offline to leave this check out";
  let fix: string;
  if (chosen !== undefined) {
    fix = `check ${chosen.variable} and that ${chosen.address ?? "the provider's address"} is running and reachable from this machine, ${leave}`;
  } else if (config.provider !== undefined) {
    fix = `check the settings and variables of the plugin that supplies ${config.provider}, and that its service is reachable from this machine, ${leave}`;
  } else if (config.modelUrl === undefined) {
    fix = `check TYPESAFE_API_KEY and this machine's network access to TypeSafe, ${leave}`;
  } else {
    fix = `check that ${config.modelUrl} is running and reachable from this machine, ${leave}`;
  }
  // A 429 or 529 is retried as the worker retries it, within the step; the last one heard says why
  // the question did not get through.
  const heard: { refusal?: RetryableError } = {};
  const backoff = createBackoff({ clock: environment.deps.clock, random: environment.deps.random });
  try {
    const answered = await bounded(environment, () =>
      backoff.run(
        () => ping(environment, config, plugins, config.model),
        (refusal) => {
          heard.refusal = refusal;
        },
      ),
    );
    if (answered === "late") {
      return heard.refusal === undefined
        ? fail(`the model did not answer a test question ${within(environment)}${unrun}`, fix)
        : fail(`${rateLimited(heard.refusal, environment)}${unrun}`, RATE_LIMITED_FIX);
    }
    const named = answered.value;
    return { ...ok(`${modelNameWords(named)} answered a test question${unrun}`), named };
  } catch (error) {
    if (error instanceof DoctorClockError) {
      throw error;
    }
    if (error instanceof RetryableError) {
      return fail(`${rateLimited(error, environment)}${unrun}`, RATE_LIMITED_FIX);
    }
    const keys = modelKeys(environment, config);
    return fail(`the model did not answer: ${plainMessage(error, keys)}${unrun}`, fix);
  }
}

/** The model answered, with a rate limit or an overload, every time it was asked within the step. */
function rateLimited(refusal: RetryableError, run: Run): string {
  const said =
    refusal.status === 429 ? "it is rate limiting this project (429)" : "it is overloaded (529)";
  return `the model answered that ${said}, and the test question did not get through ${within(run)}`;
}

const RATE_LIMITED_FIX =
  "wait a minute and run facetdb doctor again; a worker running now may be using the project's whole rate limit";

/** The model's two checks, the second only once the first passed. */
async function modelLines(
  environment: Run,
  config: ProjectConfig,
  plugins: PluginHost | undefined,
): Promise<readonly CheckLine[]> {
  const key = line(MODEL_KEY, modelKey(environment, config, plugins));
  const reachable: Reached =
    key.status === "ok"
      ? await modelReachable(environment, config, plugins)
      : skip(`not checked: the ${MODEL_KEY.label} check did not pass`);
  return [
    key,
    line(MODEL_REACHABLE, reachable),
    ...(reachable.named === undefined
      ? []
      : await modelNameNotes(environment, config, plugins, reachable.named)),
  ];
}

/** Notes under the model check, never checks of their own. */
const MODEL_NAME = { id: "model-name", label: "model name" } as const;

/**
 * The worker holds each question-set version to the model its first answer named. A server that
 * answers under its own name whatever is asked (the publisher's Strands Decider server) makes the
 * config's `model` a label; a version the store holds to another name than the server answers its
 * source's own `model` with now is one whose source the worker holds. Each source is compared with
 * an answer to its own model: the project's, asked by the check above, or one a source sets, asked
 * once here; and only while the file names the model of the version in force (otherwise the next
 * reload starts a new version, and nothing is asked for it). Silent when the names agree. Names a
 * server chose are quoted as `modelNameWords` says.
 */
async function modelNameNotes(
  environment: Run,
  config: ProjectConfig,
  plugins: PluginHost | undefined,
  named: string,
): Promise<readonly CheckLine[]> {
  const { deps, options } = environment;
  const note = (detail: string) => line(MODEL_NAME, warn(detail));
  const notes: CheckLine[] = [];
  if (named !== config.model) {
    notes.push(
      note(
        `the server answers as ${modelNameWords(named)}, not ${config.model}: it serves its own model whatever is asked, so the config's model is only a label. To serve another model, also set a new model in facetdb.config.ts, which starts a new question-set version`,
      ),
    );
  }
  const store = storeUrlOf(deps.env);
  const driver = stepDriver(environment);
  const held = await bounded(
    environment,
    () =>
      heldVersions(
        driver.connect,
        deps.env,
        projectRef(deps.projectDir).id,
        config.sources.map((source) => source.name),
        options.allowInsecure,
      ),
    store,
  );
  if (held === "late") {
    // One plain select that never came back: its server never answered.
    driver.release();
    markSilent(environment, store);
  }
  const read: Awaited<ReturnType<typeof heldVersions>> =
    held === "late" ? { kind: "unreadable", why: notAnswered(environment, store) } : held.value;
  if (read.kind === "unreadable") {
    notes.push(
      note(
        `the store could not be read, so no source's model was compared with the one its version is held to: ${read.why}`,
      ),
    );
    return notes;
  }
  const answers = new Map<string, { readonly named: string } | { readonly failed: string }>([
    [config.model, { named }],
  ]);
  for (const version of read.versions) {
    const model =
      config.sources.find((each) => each.name === version.source)?.model ?? config.model;
    if (model !== version.model) {
      // The file names another model than the version the worker runs: its next reload starts a
      // new version, held to whatever answers it first, so this one's name is nothing to compare.
      notes.push(
        note(
          `the worker runs version ${version.version} of ${version.source} on ${version.model}, and facetdb.config.ts names ${model}: a new version starts at the worker's next reload`,
        ),
      );
      continue;
    }
    let answer = answers.get(model);
    if (answer === undefined) {
      try {
        const answered = await bounded(environment, () =>
          ping(environment, config, plugins, model),
        );
        answer =
          answered === "late"
            ? { failed: `none came ${within(environment)}` }
            : { named: answered.value };
      } catch (error) {
        if (error instanceof DoctorClockError) {
          throw error;
        }
        answer = { failed: plainMessage(error, modelKeys(environment, config)) };
      }
      answers.set(model, answer);
    }
    const held = modelNameWords(version.held);
    if ("failed" in answer) {
      notes.push(
        note(
          `${model}, the model of ${version.source}, did not answer a test question (${answer.failed}), so the model its version ${version.version} is held to (${held}) was not compared`,
        ),
      );
    } else if (answer.named !== version.held) {
      notes.push(
        note(
          `the store holds version ${version.version} of ${version.source} to ${held}, and the server now answers ${model} as ${modelNameWords(answer.named)}: the worker holds ${version.source}, writing none of its answers, until ${held} is served again or a new model in facetdb.config.ts starts a new version`,
        ),
      );
    }
  }
  return notes;
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
 * A source's checks when its engine's did not end within a step. The ones the engine reported as
 * they ended keep their own lines; each one left fails. When none ended, the server never answered:
 * each says so with the fix for its address, and the run asks it nothing more. When some did, the
 * server answered and a later check was slow: each one left says it did not finish. The heartbeat
 * is among them only where the engine would read it, the store being this source's database;
 * elsewhere the store door reads it, as its own step. An engine that reports nothing as it goes
 * (every engine but Postgres's) is judged as a whole.
 */
function lateChecks(
  run: Run,
  engine: DatabaseEngine,
  table: TableSource,
  url: string,
  reported: readonly DoctorCheck[],
): readonly DoctorCheck[] {
  const left = engine.checks
    .map((check) => check.name)
    .filter(
      (name) =>
        (name !== "worker" || table.sharesStore) && !reported.some((done) => done.name === name),
    );
  const source = `"${table.source.name}"`;
  if (reported.length === 0) {
    markSilent(run, url);
    const detail = `${source}: ${notAnswered(run, url)}`;
    const fix = notAnsweredFix(variableOf(table.source));
    return left.map((name): DoctorCheck => ({ name, status: "fail", detail, fix }));
  }
  return [
    ...reported,
    ...left.map(
      (name): DoctorCheck => ({
        name,
        status: "fail",
        detail: `${source}: ${notFinished(run, name)}`,
        fix: NOT_FINISHED_FIX,
      }),
    ),
  ];
}

/**
 * A table source's checks from its engine (database, distance, pooler, install), and the engine's
 * heartbeat line apart: it is the report's only when the store is this source's database. Never
 * throws: a source with no connection string, one that reads the store's variable for a database
 * that is not a Postgres, one no engine reads, or one whose engine fails to load (a driver that is
 * not installed) fails the database check, and the other sources and the store are still checked.
 */
async function sourceLines(
  environment: Run,
  config: ProjectConfig,
  table: TableSource,
  scrub: (text: string) => string,
  group?: string,
): Promise<{ readonly lines: readonly CheckLine[]; readonly worker?: CheckLine }> {
  const { deps, options } = environment;
  const { source, url } = table;
  // The checks a failure here leaves unrun: the engine's own names once it is known, else the
  // Postgres engine's, the names of the one-list report.
  const failed = (result: CheckResult, engine?: DatabaseEngine) => ({
    lines: [
      line({ id: "database", label: "database" }, result, group),
      ...(engine === undefined
        ? ["pooler", "capture", "install"]
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
  const reported: DoctorCheck[] = [];
  const answered = await bounded(
    environment,
    () =>
      engine.doctor(target, url, {
        clock: deps.clock,
        allowInsecure: options.allowInsecure === true,
        storeShared: table.sharesStore,
        connectTimeoutSeconds: environment.connectTimeoutSeconds,
        onCheck: (check) => {
          reported.push(check);
        },
      }),
    url,
  );
  const checks =
    answered === "late"
      ? lateChecks(environment, engine, table, url, [...reported])
      : answered.value;
  if (checks.some((check) => check.silent === true)) {
    markSilent(environment, url);
  }
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
async function noTableLines(environment: Run): Promise<readonly CheckLine[]> {
  const { deps, options } = environment;
  const store = storeUrlOf(deps.env);
  // A store URL the TLS rule refuses is the heartbeat check's failure: never probed here.
  const probed =
    store === undefined ||
    storeUrlProblem(store, options.allowInsecure, deps.env["PGHOST"]) !== undefined
      ? undefined
      : await storeStep(environment, "pooler", (connect) => storePoolerCheck(connect, store));
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
  environment: Run,
  scrub: (text: string) => string,
): Promise<readonly CheckLine[]> {
  const { deps, options } = environment;
  const group = "store";
  const store = storeUrlOf(deps.env);
  // The store reachable and current, then its pooler: one step. The store check is kept as soon as
  // it ends, so a slow pooler probe never turns an answered store into a failure.
  const driver = stepDriver(environment);
  const ended: { reached?: DoctorCheck } = {};
  const answered = await bounded(
    environment,
    async () => {
      const reached = await storeCheck(driver.connect, deps.env, options.allowInsecure);
      ended.reached = reached;
      return {
        reached,
        pooler:
          reached.status === "ok" && store !== undefined
            ? await storePoolerCheck(driver.connect, store)
            : undefined,
      };
    },
    store,
  );
  let reached: DoctorCheck;
  let pooler: DoctorCheck | undefined;
  if (answered !== "late") {
    ({ reached, pooler } = answered.value);
    if (reached.silent === true) {
      markSilent(environment, store);
    }
  } else if (ended.reached === undefined) {
    driver.release();
    markSilent(environment, store);
    reached = storeNotAnswered(environment, STORE_LABEL, store);
    pooler = storeNotAnswered(environment, "pooler", store);
  } else {
    driver.release();
    reached = ended.reached;
    pooler = storeNotFinished(environment, "pooler");
  }
  return [
    fromCheck(reached, scrub, group),
    pooler === undefined
      ? line(
          { id: "pooler", label: "pooler" },
          skip(`not checked: the ${STORE_LABEL} check did not pass`),
          group,
        )
      : fromCheck(pooler, scrub, group),
    fromCheck(await heartbeat(environment), scrub, group),
    line(SECRET, secretCheck(deps.env), group),
  ];
}

/** A store check whose step ended before the store's server answered anything. */
function storeNotAnswered(run: Run, name: string, url: string | undefined): DoctorCheck {
  return {
    name,
    status: "fail",
    detail: `the FacetDB store: ${notAnswered(run, url)}`,
    fix: notAnsweredFix(STORE_VARIABLE),
  };
}

/** A store check whose step ended after the store had answered the check before it. */
function storeNotFinished(run: Run, name: string): DoctorCheck {
  return {
    name,
    status: "fail",
    detail: `the FacetDB store: ${notFinished(run, name)}`,
    fix: NOT_FINISHED_FIX,
  };
}

/**
 * One store door check, one statement on one connection, as a step of its own: its result, or,
 * past the step's bound, its server never answered: the connection is ended and the server is
 * asked nothing more in the run.
 */
async function storeStep(
  run: Run,
  name: string,
  check: (connect: CliDeps["connect"]) => Promise<DoctorCheck>,
): Promise<DoctorCheck> {
  const store = storeUrlOf(run.deps.env);
  const driver = stepDriver(run);
  const answered = await bounded(run, () => check(driver.connect), store);
  if (answered === "late") {
    driver.release();
    markSilent(run, store);
    return storeNotAnswered(run, name, store);
  }
  if (answered.value.silent === true) {
    markSilent(run, store);
  }
  return answered.value;
}

/** The worker's heartbeat, read from the store by the store door. */
function heartbeat(run: Run): Promise<DoctorCheck> {
  const { deps, options } = run;
  return storeStep(run, "worker", (connect) =>
    heartbeatCheck(
      connect,
      deps.env,
      deps.clock,
      projectRef(deps.projectDir).id,
      options.allowInsecure,
    ),
  );
}

/**
 * Runs every check in order. A check never throws: what goes wrong inside one is that check's
 * failure. Each step ends within `DOCTOR_STEP_MS`, so a server that never answers is a failed check
 * in its own words, and the steps after it still run.
 */
export async function runChecks(command: DoctorEnvironment): Promise<readonly CheckLine[]> {
  const stepMs = command.stepMs ?? DOCTOR_STEP_MS;
  const environment: Run = {
    ...command,
    stepMs,
    connectTimeoutSeconds: command.connectTimeoutSeconds ?? stepMs / 1000,
    silent: new Set(),
  };
  const { deps } = environment;
  const configured = await bounded(environment, () => configLoads(environment));
  const path = environment.options.config;
  const loaded: Awaited<ReturnType<typeof configLoads>> =
    configured === "late"
      ? {
          result: fail(
            `${path} did not load ${within(environment)}`,
            `check that ${path} and the plugins it names load without waiting on the network, then run facetdb doctor again`,
          ),
        }
      : configured.value;
  const lines: CheckLine[] = [line(CONFIG_CHECK, loaded.result)];
  const { config, plugins } = loaded;
  if (config === undefined) {
    const notChecked = skip("not checked: the config did not load");
    for (const id of ["database", "pooler", "capture", "install", "worker"]) {
      lines.push(line({ id, label: labelOf(id) }, notChecked));
    }
    lines.push(line(MODEL_KEY, notChecked), line(MODEL_REACHABLE, notChecked));
    // The one check that needs no config: it reads the environment alone, so it always runs.
    lines.push(line(SECRET, secretCheck(deps.env)));
    return lines;
  }
  // Present only when the config names a plugin; the other checks are as they were.
  if (loaded.pluginsCheck !== undefined) {
    lines.push(line(PLUGINS_CHECK, loaded.pluginsCheck));
  }
  // What an engine says is scrubbed of the CLI's own secrets, which no engine is given.
  const scrub = (text: string) =>
    plainMessage(text, [
      deps.env[STORE_SECRET_VARIABLE],
      deps.env["TYPESAFE_API_KEY"],
      deps.env[presetKeyOf(config)?.variable ?? "TYPESAFE_API_KEY"],
    ]);
  const tables = tableSourcesOf(config, deps.env);
  const [only] = tables;
  const oneList =
    tables.length === 0 ||
    (only !== undefined &&
      tables.length === 1 &&
      (storeUrlOf(deps.env) === undefined || only.sharesStore));
  if (oneList) {
    if (only === undefined) {
      lines.push(...(await noTableLines(environment)));
      lines.push(fromCheck(await heartbeat(environment), scrub));
    } else {
      const checked = await sourceLines(environment, config, only, scrub);
      lines.push(...checked.lines);
      // The engine reads the heartbeat when the store is its database; the store door otherwise.
      lines.push(checked.worker ?? fromCheck(await heartbeat(environment), scrub));
    }
    lines.push(...(await modelLines(environment, config, plugins)));
    lines.push(line(SECRET, secretCheck(deps.env)));
    return lines;
  }
  lines.push(...(await modelLines(environment, config, plugins)));
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
    const environment: DoctorEnvironment = { deps, options, ...deps.doctorBounds };
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
