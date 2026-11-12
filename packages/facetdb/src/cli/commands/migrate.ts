import {
  type MigratePlan,
  type MigrateSource,
  migrate,
  type ProjectRef,
  prune,
  WORKER_ROLE,
} from "@facetdb/postgres";
import type { ProjectConfig } from "../../config/index.ts";
import { type CliDeps, CliError, defineCommand } from "../program.ts";
import {
  ALLOW_INSECURE_OPTION,
  adminUrl,
  databaseLabel,
  loadProjectConfig,
  projectRef,
  questionSetOf,
  refused,
  sameAsShown,
  type TableTarget,
  tableTargets,
  workerLoginOf,
} from "./database.ts";

/**
 * `facetdb migrate`: runs install for every source that reads a table. Every script is printed
 * first, from a dry run of the connector; then, once confirmed, the connector runs again with a
 * print callback that refuses any script but the one shown, so the SQL executed is the SQL printed,
 * string for string. The admin connection string is used for the run and kept nowhere.
 */

type MigrateOptions = {
  readonly config: string;
  readonly adminUrl?: string;
  readonly source?: string;
  readonly yes: boolean;
  readonly prune: boolean;
  readonly allowInsecure?: boolean;
};

/** One table's scripts, as shown: the prune (when `--prune` has something to drop) and the install. */
type Shown = {
  readonly target: TableTarget;
  readonly plan: MigratePlan;
  readonly pruneSql: string;
  readonly sql: string;
};

const QUERY_WORKER_ROLE = "select 1 from pg_catalog.pg_roles where rolname = $1";

async function workerRoleExists(deps: CliDeps, url: string): Promise<boolean> {
  const client = deps.connect(url);
  try {
    return (await client.query(QUERY_WORKER_ROLE, [WORKER_ROLE])).length > 0;
  } finally {
    await client.close();
  }
}

/**
 * The worker login's password on the first install, when the role does not exist yet: the password
 * of the source's connection string, which is the worker's (`postgres://facetdb_worker:…@host/db`),
 * so the login migrate creates is the one the worker connects with. Once the role exists it is left
 * as it is: other projects on the server may share it.
 */
function workerPassword(target: TableTarget): string {
  const variable = target.source.databaseEnv ?? "DATABASE_URL";
  const fix = `set ${variable} to postgres://${WORKER_ROLE}:<a long random password>@<host>/<database> (or postgres://${WORKER_ROLE}.<suffix>:… when a connection pooler such as the Supabase session pooler asks for a suffixed user); migrate creates that login with that password, and the worker connects with it`;
  if (target.source.database === undefined) {
    throw new CliError(
      "worker-login",
      `the source "${target.source.name}" has no connection string, so the worker login has no password to be created with`,
      fix,
    );
  }
  let url: URL;
  try {
    url = new URL(target.source.database);
  } catch {
    throw new CliError("worker-login", `the connection string in ${variable} is not a URL`, fix);
  }
  if (workerLoginOf(target.source.database) === undefined || url.password === "") {
    throw new CliError(
      "worker-login",
      `the worker login ${WORKER_ROLE} does not exist yet, and ${variable} does not log in as it with a password`,
      fix,
    );
  }
  return decodeURIComponent(url.password);
}

function planFor(
  config: ProjectConfig,
  target: TableTarget,
  project: ProjectRef,
  password: string | undefined,
): MigratePlan {
  const source: MigrateSource = {
    table: target.table,
    schema: target.schema,
    onChange: target.source.onChange,
    storage: target.source.storage,
  };
  return {
    source,
    questionSet: questionSetOf(config, target.source),
    project,
    ...(password === undefined ? {} : { workerPassword: password }),
  };
}

/** The dry run of one table: both scripts as the connectors would run them, nothing touched. */
async function show(
  deps: CliDeps,
  url: string,
  plan: MigratePlan,
  target: TableTarget,
  withPrune: boolean,
): Promise<Shown> {
  let pruneSql = "";
  if (withPrune) {
    const pruned = await prune({
      adminUrl: url,
      source: { table: target.table, schema: target.schema },
      questionSet: plan.questionSet,
      project: plan.project,
      print: () => undefined,
      dryRun: true,
      connect: deps.connect,
    });
    // Not installed yet: a first install has nothing to prune.
    pruneSql = pruned.ok ? pruned.sql : "";
  }
  const result = await migrate({
    adminUrl: url,
    plan,
    print: () => undefined,
    dryRun: true,
    connect: deps.connect,
  });
  if (!result.ok) {
    throw refused("migrate-refused", result.reason);
  }
  return { target, plan, pruneSql, sql: result.sql };
}

/** The confirmed run of one table: the prune first, from the catalog it was shown from, then install. */
async function apply(deps: CliDeps, url: string, shown: Shown): Promise<void> {
  if (shown.pruneSql !== "") {
    const pruned = await prune({
      adminUrl: url,
      source: { table: shown.target.table, schema: shown.target.schema },
      questionSet: shown.plan.questionSet,
      project: shown.plan.project,
      print: sameAsShown(shown.pruneSql),
      connect: deps.connect,
    });
    if (!pruned.ok) {
      throw refused("prune-refused", pruned.reason);
    }
  }
  const result = await migrate({
    adminUrl: url,
    plan: shown.plan,
    print: sameAsShown(shown.sql),
    connect: deps.connect,
  });
  if (!result.ok) {
    throw refused("migrate-refused", result.reason);
  }
}

function label(target: TableTarget): string {
  return `${target.schema}.${target.table}`;
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
    const url = await adminUrl(deps, options.adminUrl, options.allowInsecure);
    const project = projectRef(deps.projectDir);
    const roleExists = await workerRoleExists(deps, url);
    const shown: Shown[] = [];
    for (const target of targets) {
      const password = roleExists ? undefined : workerPassword(target);
      const plan = planFor(config, target, project, password);
      shown.push(await show(deps, url, plan, target, options.prune));
    }
    for (const item of shown) {
      if (item.pruneSql !== "") {
        print(`-- facetdb migrate --prune: ${item.target.source.name} (${label(item.target)})`);
        print(item.pruneSql);
      }
      print(`-- facetdb migrate: ${item.target.source.name} (${label(item.target)})`);
      print(item.sql);
    }
    const summary = (applied: boolean) => ({
      ok: true,
      dryRun: options.dryRun,
      sources: shown.map((item) => ({
        source: item.target.source.name,
        table: label(item.target),
        ...(item.pruneSql === "" ? {} : { pruneSql: item.pruneSql }),
        sql: item.sql,
        applied,
      })),
    });
    if (options.dryRun) {
      print("Dry run: nothing was changed.");
      return summary(false);
    }
    if (!options.yes) {
      const answer = await deps.io.prompt(
        `Run the SQL above on ${databaseLabel(url)}? Type yes to continue: `,
      );
      if (answer.trim().toLowerCase() !== "yes") {
        throw new CliError(
          "not-confirmed",
          "the SQL was not confirmed, so nothing was run",
          "run facetdb migrate again and type yes, or pass --yes once you have read the SQL",
        );
      }
    }
    for (const item of shown) {
      await apply(deps, url, item);
      print(`Installed on ${label(item.target)} (source ${item.target.source.name}).`);
    }
    return summary(true);
  },
});
