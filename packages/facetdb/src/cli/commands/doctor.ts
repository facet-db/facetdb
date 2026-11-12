import { HEARTBEAT_LOSS_MS, type Question } from "@facetdb/core";
import {
  FACETDB_SCHEMA,
  installOwnedColumns,
  SECRET_VARIABLE,
  SIDE_TABLE_SCHEMA,
  sideTableName,
  triggerName,
  WORKER_ROLE,
} from "@facetdb/postgres";
import { ConfigError, type ProjectConfig, type SourceConfig } from "../../config/index.ts";
import { type CliDeps, CliError, defineCommand } from "../program.ts";
import {
  ALLOW_INSECURE_OPTION,
  databaseLabel,
  projectRef,
  questionSetOf,
  tlsFix,
  tlsProblem,
  workerLoginOf,
} from "./database.ts";

/**
 * `facetdb doctor`: runs the checks in order, prints one line each with the fix, and exits 1 naming
 * the first failing check, 0 when all pass. Every check is a small function over
 * `DoctorEnvironment`, which is everything it may touch, so a test makes each one fail on its own.
 * A check that cannot run because an earlier one failed is skipped, not reported as a second
 * failure. Nothing here changes the database or the store.
 */

type DoctorOptions = {
  readonly config: string;
  readonly offline: boolean;
  readonly allowInsecure?: boolean;
};

/** `warn` is something to know that is not a failure: it is not counted and the exit code stays 0. */
export type CheckStatus = "ok" | "fail" | "skip" | "warn";

export type CheckResult = {
  readonly status: CheckStatus;
  /** What was found, in plain words. */
  readonly detail: string;
  /** What to do, for a failure. */
  readonly fix?: string;
  /** A line of its own after this one, for what the check saw besides its verdict (the distance). */
  readonly warning?: string;
};

export type CheckLine = CheckResult & {
  readonly id: string;
  readonly label: string;
};

/** What a check may touch: the command's dependencies and options, and the config once it loaded. */
export type DoctorEnvironment = {
  readonly deps: CliDeps;
  readonly options: DoctorOptions;
};

type Check = {
  readonly id: string;
  readonly label: string;
  /** What `--dry-run` says this check would look at. */
  readonly looksAt: string;
  readonly run: (environment: DoctorEnvironment, config: ProjectConfig) => Promise<CheckResult>;
};

const ok = (detail: string, warning?: string): CheckResult => ({
  status: "ok",
  detail,
  ...(warning === undefined ? {} : { warning }),
});
const fail = (detail: string, fix: string): CheckResult => ({ status: "fail", detail, fix });
const skip = (detail: string): CheckResult => ({ status: "skip", detail });

/** The sources that read a table: the ones with something in a database to check. */
function tableSources(config: ProjectConfig): readonly SourceConfig[] {
  return config.sources.filter((source) => source.table !== undefined);
}

/** `schema.table` names a schema; a bare name is in `public`. */
function splitTable(table: string): { readonly schema: string; readonly table: string } {
  const dot = table.indexOf(".");
  return dot === -1
    ? { schema: "public", table }
    : { schema: table.slice(0, dot), table: table.slice(dot + 1) };
}

/** The connection string of a source: written in its config, or in the variable the config read it from. */
function connectionOf(
  source: SourceConfig,
  env: CliDeps["env"],
): { readonly url: string | undefined; readonly variable: string } {
  const variable = source.databaseEnv ?? "DATABASE_URL";
  const url = source.database ?? env[variable];
  return { url: url === "" ? undefined : url, variable };
}

/** An error's message with any secret it carries blanked out, so a check never prints a password. */
function plainMessage(error: unknown, secrets: readonly (string | undefined)[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) {
    if (secret === undefined || secret === "") {
      continue;
    }
    message = message.replaceAll(secret, "***");
    try {
      const password = decodeURIComponent(new URL(secret).password);
      if (password !== "") {
        message = message.replaceAll(password, "***");
      }
    } catch {
      // Not a URL: the whole value was already blanked.
    }
  }
  return message;
}

const WORKER_URL_SHAPE = `postgres://${WORKER_ROLE}:<a long random password>@<host>/<database>`;

/** Opens a source's connection, runs `work` and closes it, whatever happens. */
async function withConnection<T>(
  deps: CliDeps,
  url: string,
  work: (query: ReturnType<CliDeps["connect"]>["query"]) => Promise<T>,
): Promise<T> {
  const client = deps.connect(url);
  try {
    return await work(client.query);
  } finally {
    await client.close();
  }
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

/** How many `select 1` round trips measure the link; the median of them is what doctor reports. */
const ROUND_TRIPS = 3;

/** Above this many milliseconds a round trip is a warning: the 1 second target assumes a near database. */
const FAR_MS = 100;

/** The middle of three numbers, so a single slow or fast trip does not decide. */
function median(a: number, b: number, c: number): number {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

/** Times three `select 1` round trips with the command's clock and returns the median, in ms. */
async function roundTripMs(
  clock: CliDeps["clock"],
  query: ReturnType<CliDeps["connect"]>["query"],
): Promise<number> {
  const taken: number[] = [];
  for (let trip = 0; trip < ROUND_TRIPS; trip += 1) {
    const started = clock.now();
    await query("select 1");
    taken.push(clock.now() - started);
  }
  const [first = 0, second = 0, third = 0] = taken;
  return Math.round(median(first, second, third));
}

/**
 * 2. Every table source answers a query when logged in as the worker, over a connection that is
 * encrypted when it leaves this machine, and the report says how far away it is.
 */
const databaseReachable: Check = {
  id: "database",
  label: "database",
  looksAt:
    "connects to each table source with its own connection string, checks the login, and times three round trips",
  run: async ({ deps, options }, config) => {
    const sources = tableSources(config);
    if (sources.length === 0) {
      return ok("no source reads a table, so there is no database to reach");
    }
    const problems: string[] = [];
    let fix = "";
    const reached: string[] = [];
    const pooled = new Set<string>();
    let farthest = 0;
    for (const source of sources) {
      const { url, variable } = connectionOf(source, deps.env);
      if (url === undefined) {
        problems.push(`${variable} is not set, so "${source.name}" has no database to connect to`);
        fix = `set ${variable} to ${WORKER_URL_SHAPE}`;
        continue;
      }
      const insecure = tlsProblem(url, variable, options.allowInsecure);
      if (insecure !== undefined) {
        problems.push(`"${source.name}": ${insecure}`);
        fix = tlsFix(variable);
        continue;
      }
      try {
        const { login, milliseconds } = await withConnection(deps, url, async (query) => {
          const rows = await query("select current_user::text as name");
          return {
            login: String(rows[0]?.["name"]),
            milliseconds: await roundTripMs(deps.clock, query),
          };
        });
        if (login !== WORKER_ROLE) {
          problems.push(
            `"${source.name}" logs in as ${login} on ${databaseLabel(url)}, not as the worker login ${WORKER_ROLE}`,
          );
          fix = `set ${variable} to ${WORKER_URL_SHAPE}; facetdb migrate creates that login with the password in it, and it is the only login the worker needs`;
        } else {
          const suffix = workerLoginOf(url)?.suffix;
          if (suffix !== undefined) {
            pooled.add(`${WORKER_ROLE}.${suffix}`);
          }
          farthest = Math.max(farthest, milliseconds);
          reached.push(`${source.name} on ${databaseLabel(url)} (round trip ${milliseconds} ms)`);
        }
      } catch (error) {
        problems.push(
          `"${source.name}" cannot connect to ${databaseLabel(url)}: ${plainMessage(error, [url])}`,
        );
        fix = `check the host, port, user and password in ${variable}, and that the database accepts connections from this machine (a firewall or an allow-list)`;
      }
    }
    return problems.length === 0
      ? ok(
          `logged in as ${WORKER_ROLE}${pooled.size === 0 ? "" : ` (through a pooler as ${[...pooled].join(", ")})`}: ${reached.join(", ")}`,
          farthest > FAR_MS
            ? `the database is ${farthest} ms away; run the worker next to it, the 1 second target assumes a same-region link`
            : undefined,
        )
      : fail(problems.join("; "), fix);
  },
};

const TABLE_FACTS = `select
  to_regnamespace('facetdb') is not null as schema_present,
  to_regclass('facetdb.jobs') is not null as jobs_present,
  to_regclass(format('%I.%I', $1::text, $2::text)) is not null as table_present`;

const TRIGGER_FACTS = `select t.tgenabled::text as enabled,
  coalesce((select string_agg(a.attname::text, ',' order by a.attname)
              from pg_catalog.pg_attribute a
             where a.attrelid = t.tgrelid and a.attnum = any(t.tgattr)), '') as columns
  from pg_catalog.pg_trigger t
 where t.tgrelid = to_regclass(format('%I.%I', $1::text, $2::text))
   and t.tgname = $3 and not t.tgisinternal`;

const COLUMNS_OF = `select a.attname::text as name
  from pg_catalog.pg_attribute a
 where a.attrelid = to_regclass(format('%I.%I', $1::text, $2::text))
   and a.attnum > 0 and not a.attisdropped`;

const REINSTALL = "run facetdb migrate: it prints the SQL first and installs what is missing";

/** What one source's installation is missing, as a list of plain sentences (empty when whole). */
async function installProblems(
  deps: CliDeps,
  config: ProjectConfig,
  source: SourceConfig,
  url: string,
): Promise<readonly string[]> {
  if (source.table === undefined) {
    return [];
  }
  const { schema, table } = splitTable(source.table);
  const label = `${schema}.${table}`;
  return withConnection(deps, url, async (query) => {
    const facts = (await query(TABLE_FACTS, [schema, table]))[0];
    const missing: string[] = [];
    if (facts?.["schema_present"] !== true) {
      missing.push(`the ${FACETDB_SCHEMA} schema does not exist`);
    } else if (facts["jobs_present"] !== true) {
      missing.push(`the jobs table ${FACETDB_SCHEMA}.jobs does not exist`);
    }
    if (facts?.["table_present"] !== true) {
      missing.push(`the table ${label} does not exist`);
      return missing;
    }
    const trigger = (await query(TRIGGER_FACTS, [schema, table, triggerName({ table })]))[0];
    if (trigger === undefined) {
      missing.push(`${label} has no trigger ${triggerName({ table })}, so changes are not queued`);
    } else {
      if (trigger["enabled"] === "D") {
        missing.push(`the trigger ${triggerName({ table })} on ${label} is disabled`);
      }
      const expected = [...source.read].sort().join(",");
      const watched = String(trigger["columns"]);
      if (watched !== expected) {
        missing.push(
          `the trigger on ${label} watches ${watched === "" ? "no columns" : watched}, not the columns the questions read (${expected})`,
        );
      }
    }
    const [answerSchema, answerTable] =
      source.storage === "side-table" ? [SIDE_TABLE_SCHEMA, sideTableName(table)] : [schema, table];
    const present = new Set(
      (await query(COLUMNS_OF, [answerSchema, answerTable])).map((row) => String(row["name"])),
    );
    const owned = installOwnedColumns(questionSetOf(config, source));
    const absent = owned.filter((name) => !present.has(name));
    if (absent.length > 0) {
      missing.push(`${answerSchema}.${answerTable} lacks the answer columns ${absent.join(", ")}`);
    }
    return missing;
  });
}

/** 3. The facetdb schema, the jobs table and the trigger exist, on the columns the questions read. */
const installPresent: Check = {
  id: "install",
  label: "install",
  looksAt:
    "reads the catalog for the facetdb schema, the jobs table, the trigger and the answer columns",
  run: async ({ deps }, config) => {
    const problems: string[] = [];
    for (const source of tableSources(config)) {
      const { url } = connectionOf(source, deps.env);
      if (url === undefined) {
        continue;
      }
      try {
        const found = await installProblems(deps, config, source, url);
        problems.push(...found.map((problem) => `${source.name}: ${problem}`));
      } catch (error) {
        problems.push(
          `${source.name}: the catalog could not be read as ${WORKER_ROLE}: ${plainMessage(error, [url])}`,
        );
      }
    }
    return problems.length === 0
      ? ok(`${FACETDB_SCHEMA} schema, jobs table, trigger and answer columns are in place`)
      : fail(problems.join("; "), REINSTALL);
  },
};

const DATABASE_URL_FIX =
  "set DATABASE_URL to the connection string of the database FacetDB keeps its store in";

function ageOf(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 120) {
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

/** 4. The worker has reported within the last two minutes. */
const workerHeartbeat: Check = {
  id: "worker",
  label: "worker heartbeat",
  looksAt: "reads the worker's last heartbeat from the FacetDB store",
  run: async ({ deps, options }) => {
    // One plain select over its own connection: opening the store (`createStore`) would create its
    // schema and salt in the database, which a check must never do and the worker login cannot.
    const url = deps.env["DATABASE_URL"];
    if (url === undefined || url === "") {
      return fail("DATABASE_URL is not set, so there is no store to read", DATABASE_URL_FIX);
    }
    const insecure = tlsProblem(url, "DATABASE_URL", options.allowInsecure);
    if (insecure !== undefined) {
      return fail(insecure, tlsFix("DATABASE_URL"));
    }
    let last: number | undefined;
    try {
      const rows = await withConnection(deps, url, (query) =>
        query("select at::text as at from facetdb.heartbeats where project = $1", [
          projectRef(deps.projectDir).id,
        ]),
      );
      const at = rows[0]?.["at"];
      last = at === undefined ? undefined : Number(at);
    } catch (error) {
      const message = plainMessage(error, [url, deps.env[SECRET_VARIABLE]]);
      if (/permission denied/i.test(message)) {
        return fail(
          `the login in DATABASE_URL may not read the store's heartbeats: ${message}`,
          `grant select on facetdb.heartbeats to the login in DATABASE_URL, or point DATABASE_URL at a login that can read it`,
        );
      }
      if (/does not exist/i.test(message)) {
        return fail(
          `the store has no heartbeats table yet: ${message}`,
          "run facetdb migrate with the admin credential: it installs the store's tables, and the worker only uses them",
        );
      }
      return fail(`the store could not be read: ${message}`, DATABASE_URL_FIX);
    }
    if (last === undefined) {
      return fail(
        "the worker has never sent a heartbeat for this project",
        "start it with facetdb worker, and leave it running",
      );
    }
    const age = deps.clock.now() - last;
    return age >= HEARTBEAT_LOSS_MS
      ? fail(
          `the last heartbeat was ${ageOf(age)} ago, and a worker counts as down after 2 minutes`,
          "start the worker with facetdb worker, or restart it, and read its log for why it stopped",
        )
      : ok(`the last heartbeat was ${ageOf(age)} ago`);
  },
};

/** 5a. A model key is set, or the config names a compatible server that needs none. */
const modelKey: Check = {
  id: "model-key",
  label: "model key",
  looksAt: "checks that TYPESAFE_API_KEY is set, or that the config names a model server",
  run: async ({ deps }, config) => {
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
  },
};

/** The smallest question there is; the model answers it so doctor can say the provider is reachable. */
const PING_QUESTION: Question = {
  type: "noul",
  name: "doctor_ping",
  instructions: "Is this note a test?",
  stakes: "low",
};

/** 5b. The provider answers one tiny question; `--offline` skips the network. */
const modelReachable: Check = {
  id: "model-reachable",
  label: "model reachable",
  looksAt: "asks the model one tiny question (skipped with --offline)",
  run: async ({ deps, options }, config) => {
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
  },
};

/** 6. The store's secret is in the environment: it encrypts what the store keeps. */
const storeSecret: Omit<Check, "run"> & {
  readonly run: (environment: DoctorEnvironment) => Promise<CheckResult>;
} = {
  id: "secret",
  label: SECRET_VARIABLE,
  looksAt: `checks that ${SECRET_VARIABLE} is set`,
  run: ({ deps }) => {
    const secret = deps.env[SECRET_VARIABLE];
    return Promise.resolve(
      secret === undefined || secret === ""
        ? fail(
            `${SECRET_VARIABLE} is not set`,
            `set ${SECRET_VARIABLE} to a long random string (openssl rand -hex 32) and keep it: it encrypts the credentials the store holds`,
          )
        : ok(`${SECRET_VARIABLE} is set`),
    );
  },
};

/** The checks after the config, in the order they run; each names what must have passed before it. */
export const CHECKS: readonly { readonly check: Check; readonly after?: string }[] = [
  { check: databaseReachable },
  { check: installPresent, after: "database" },
  { check: workerHeartbeat },
  { check: modelKey },
  { check: modelReachable, after: "model-key" },
];

const CONFIG_CHECK = {
  id: "config",
  label: "config",
  looksAt: "loads the config file and judges it with the schema",
} as const;

function line(entry: { id: string; label: string }, result: CheckResult): CheckLine {
  const { warning: _warning, ...verdict } = result;
  return { id: entry.id, label: entry.label, ...verdict };
}

/** The line that follows a check which saw something worth knowing: it never counts as a failure. */
const WARNING_ENTRY = { id: "distance", label: "distance" } as const;

const MARKS: Record<CheckStatus, string> = { ok: "ok  ", fail: "FAIL", skip: "skip", warn: "warn" };

function render(entry: CheckLine): string {
  const mark = MARKS[entry.status];
  return `${mark}  ${entry.label}: ${entry.detail}${entry.fix === undefined ? "" : ` Fix: ${entry.fix}.`}`;
}

/** Runs every check in order. A check never throws: what goes wrong inside one is that check's failure. */
export async function runChecks(environment: DoctorEnvironment): Promise<readonly CheckLine[]> {
  const lines: CheckLine[] = [];
  const loaded = await configLoads(environment);
  lines.push(line(CONFIG_CHECK, loaded.result));
  const { config } = loaded;
  for (const { check, after } of CHECKS) {
    const earlier = after === undefined ? undefined : lines.find((entry) => entry.id === after);
    if (config === undefined) {
      lines.push(line(check, skip("not checked: the config did not load")));
    } else if (earlier !== undefined && earlier.status !== "ok") {
      lines.push(line(check, skip(`not checked: the ${earlier.label} check did not pass`)));
    } else {
      const result = await check.run(environment, config);
      lines.push(line(check, result));
      if (result.warning !== undefined) {
        lines.push(line(WARNING_ENTRY, { status: "warn", detail: result.warning }));
      }
    }
  }
  // The one check that needs no config: it reads the environment alone, so it always runs.
  lines.push(line(storeSecret, await storeSecret.run(environment)));
  return lines;
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
      const planned = [CONFIG_CHECK, ...CHECKS.map(({ check }) => check), storeSecret];
      for (const [index, entry] of planned.entries()) {
        print(`${index + 1}. ${entry.label}: ${entry.looksAt}`);
      }
      print("Dry run: nothing was checked.");
      return {
        ok: true,
        dryRun: true,
        checks: planned.map((entry) => ({
          id: entry.id,
          label: entry.label,
          looksAt: entry.looksAt,
        })),
      };
    }
    const lines = await runChecks(environment);
    for (const entry of lines) {
      print(render(entry));
    }
    const failing = lines.filter((entry) => entry.status === "fail");
    const first = failing[0];
    // A warning is a note under a check, not a check: it is in neither total, nor in `checks`.
    const checks = lines.filter((entry) => entry.status !== "warn");
    const warnings = lines.filter((entry) => entry.status === "warn");
    if (first === undefined) {
      print(`All ${checks.length} checks passed.`);
      return { ok: true, checks, warnings };
    }
    print(`${failing.length} of ${checks.length} checks failed.`);
    throw new CliError(
      `doctor-${first.id}`,
      `the ${first.label} check failed: ${first.detail}`,
      first.fix ?? "",
      undefined,
      { checks, warnings },
    );
  },
});
