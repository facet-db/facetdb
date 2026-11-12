import {
  type DroppedColumn,
  type ForeignGrant,
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

/** What `--prune` does to a table's columns, as the connector listed it. */
type Pruned = {
  /** Each column with the connector's reason for dropping it. */
  readonly dropped: readonly DroppedColumn[];
  /** `<column>: kept (<why>)`, in the connector's words. */
  readonly kept: readonly string[];
  /** State columns whose select the worker login loses. */
  readonly revoked: readonly string[];
  /** What the prune cannot do (a grant another role made), in the connector's words. */
  readonly notes: readonly string[];
  /** The grants those notes are about, so a revoked column's line does not claim too much. */
  readonly foreignGrants: readonly ForeignGrant[];
};

const prunedOf = (result: Pruned): Pruned => ({
  dropped: result.dropped,
  kept: result.kept,
  revoked: result.revoked,
  notes: result.notes,
  foreignGrants: result.foreignGrants,
});

/** A revoked column's line: the worker loses the read, unless another role's grant still gives it. */
function revokedLine(pruned: Pruned, column: string, done: boolean): string {
  const foreign = pruned.foreignGrants.filter((grant) => grant.column === column);
  return foreign.length === 0
    ? `  ${column}: the worker login's read ${done ? "revoked" : "to revoke"} (read no longer lists it)`
    : `  ${column}: FacetDB's grant ${done ? "revoked" : "to revoke"} (a grant by ${foreign.map((grant) => grant.grantor).join(", ")} remains, see note)`;
}

/** One table's scripts, as shown: the prune (when `--prune` has something to drop) and the install. */
type Shown = {
  readonly target: TableTarget;
  readonly plan: MigratePlan;
  readonly pruneSql: string;
  /** Undefined without `--prune`, or when the table is not installed yet. */
  readonly pruned: Pruned | undefined;
  readonly sql: string;
};

/**
 * One line per column the prune touches or keeps, with what happens to it and why: "to drop"
 * before the confirmation, "dropped" after the run; then each of the connector's notes.
 */
function pruneLines(pruned: Pruned, done: boolean): readonly string[] {
  return [
    ...pruned.dropped.map(
      ({ column, reason }) => `  ${column}: ${done ? "dropped" : "to drop"} (${reason})`,
    ),
    ...pruned.kept.map((line) => `  ${line}`),
    ...pruned.revoked.map((column) => revokedLine(pruned, column, done)),
    ...pruned.notes.map((note) => `note: ${note}`),
  ];
}

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
  const fix = `set ${variable} to postgres://${WORKER_ROLE}:<a long random password>@<host>/<database> (or postgres://${WORKER_ROLE}.<suffix>:… when a connection pooler such as the Supabase session pooler asks for a suffixed user); migrate creates that login with that password, and the worker connects with it, directly or through a session pooler (Supabase: port 5432), not a transaction pooler (6543), because it queues records with named prepared statements`;
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
  let pruned: Pruned | undefined;
  if (withPrune) {
    const result = await prune({
      adminUrl: url,
      source: { table: target.table, schema: target.schema },
      questionSet: plan.questionSet,
      project: plan.project,
      print: () => undefined,
      dryRun: true,
      connect: deps.connect,
    });
    // Not installed yet: a first install has nothing to prune.
    if (result.ok) {
      pruneSql = result.sql;
      pruned = prunedOf(result);
    }
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
  return { target, plan, pruneSql, pruned, sql: result.sql };
}

/**
 * The confirmed run of one table: the prune first, from the catalog it was shown from, then
 * install. Returns what the prune did, as the run reports it.
 */
async function apply(deps: CliDeps, url: string, shown: Shown): Promise<Pruned | undefined> {
  let pruned: Pruned | undefined;
  if (shown.pruneSql !== "") {
    const result = await prune({
      adminUrl: url,
      source: { table: shown.target.table, schema: shown.target.schema },
      questionSet: shown.plan.questionSet,
      project: shown.plan.project,
      print: sameAsShown(shown.pruneSql),
      connect: deps.connect,
    });
    if (!result.ok) {
      throw refused("prune-refused", result.reason);
    }
    pruned = prunedOf(result);
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
  return pruned;
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
      // What the prune drops, keeps and revokes, column by column; a kept column is named even
      // when there is no script, so nothing stays without a word.
      const lines = item.pruned === undefined ? [] : pruneLines(item.pruned, false);
      if (lines.length > 0) {
        print(`Prune of ${label(item.target)}:`);
        print(lines.join("\n"));
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
        ...(item.pruned === undefined ? {} : { pruned: item.pruned }),
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
      const pruned = await apply(deps, url, item);
      const lines = pruned === undefined ? [] : pruneLines(pruned, true);
      if (lines.length > 0) {
        print(`Pruned ${label(item.target)}:`);
        print(lines.join("\n"));
      }
      print(`Installed on ${label(item.target)} (source ${item.target.source.name}).`);
    }
    return summary(true);
  },
});
