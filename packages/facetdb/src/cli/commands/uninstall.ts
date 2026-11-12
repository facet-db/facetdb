import { type TableName, type UninstallPlan, uninstall } from "@facetdb/postgres";
import { asCliError, type CliDeps, CliError, defineCommand } from "../program.ts";
import {
  ALLOW_INSECURE_OPTION,
  adminUrl,
  loadProjectConfig,
  refused,
  sameAsShown,
  type TableTarget,
  tableTargets,
} from "./database.ts";
import {
  once,
  ROLES_KEPT,
  runKept,
  runRemoved,
  tableKept,
  tableRemoved,
} from "./uninstall-words.ts";

/**
 * `facetdb uninstall`: prints the script for every table first, from a dry run of the connector,
 * with every note the connector returns, then one account of what the whole run removes and keeps,
 * then asks for the name back once; a wrong name runs nothing. The confirmed run refuses any script
 * but the one shown, and after each table says what that run removed. The decision log stays unless
 * `--purge`. Every word about what goes and what stays comes from the connector's plans
 * (`uninstall-words.ts`), never from a guess here.
 */

type UninstallOptions = {
  readonly config: string;
  readonly adminUrl?: string;
  readonly source?: string;
  readonly purge: boolean;
  readonly allowInsecure?: boolean;
};

type Shown = {
  readonly target: TableTarget;
  readonly sql: string;
  readonly plan: UninstallPlan;
  readonly notes: readonly string[];
};

function uninstallSource(target: TableTarget) {
  return { table: target.table, schema: target.schema, sourceId: target.source.name };
}

const label = (target: TableTarget) => `${target.schema}.${target.table}`;

/** The run's tables other than `target`, as the connector counts them gone (`alsoUninstalling`). */
function others(targets: readonly TableTarget[], target: TableTarget): readonly TableName[] {
  return targets
    .filter((other) => other !== target)
    .map((other) => ({ schema: other.schema, table: other.table }));
}

async function show(
  deps: CliDeps,
  url: string,
  target: TableTarget,
  run: readonly TableTarget[],
  purge: boolean,
): Promise<Shown> {
  const result = await uninstall({
    adminUrl: url,
    source: uninstallSource(target),
    purge,
    print: () => undefined,
    // A dry run asks nothing; the name is asked once, for every table, after all scripts are shown.
    confirm: () => Promise.resolve(""),
    dryRun: true,
    // The whole run's forecast: each table's plan counts the run's other tables as gone.
    alsoUninstalling: others(run, target),
    connect: deps.connect,
  });
  if (!result.ok) {
    throw refused("uninstall-refused", result.reason);
  }
  return { target, sql: result.sql, plan: result.plan, notes: result.notes };
}

/**
 * The run's words: each table's own, then the run-wide ones from the last plan (it counts every
 * other table of the run as gone, so it is the run's end).
 */
function runWords(items: readonly Shown[]): {
  readonly removes: readonly string[];
  readonly keeps: readonly string[];
} {
  const last = items.at(-1);
  return {
    removes: once([
      ...items.flatMap((item) => tableRemoved(item.plan)),
      ...(last === undefined ? [] : runRemoved(last.plan)),
    ]),
    keeps: once([
      ...items.flatMap((item) => tableKept(item.plan)),
      ...(last === undefined ? [] : runKept(last.plan)),
    ]),
  };
}

/**
 * The line after the whole run. "Removed FacetDB from …" stands alone (but for the worker login,
 * which uninstall never drops) only when nothing else of FacetDB is left behind.
 */
function doneWords(ran: readonly Shown[]): string {
  const { keeps } = runWords(ran);
  const allLogOnly = ran.every((item) => item.plan.mode === "log-only");
  const done = allLogOnly
    ? `Purged the decision log of source ${ran.map((item) => item.plan.log.given).join(", ")}`
    : `Removed FacetDB from ${ran.map((item) => label(item.target)).join(", ")}`;
  return keeps.length === 1 && keeps[0] === ROLES_KEPT
    ? `${done}; only ${ROLES_KEPT} stay.`
    : `${done}; kept: ${keeps.join("; ")}.`;
}

/**
 * Any failure of a later table once earlier ones were removed (a refusal, a changed database, or a
 * raw database error such as a customer's view on a column): the message says which tables went
 * and that the run-wide removals promised did not happen, and `--json` carries the tables, so
 * nobody believes the whole run was rolled back. A raw error keeps its "unexpected" code.
 */
function afterPartialRun(
  error: unknown,
  ran: readonly Shown[],
  promised: readonly string[],
): unknown {
  if (ran.length === 0) {
    return error;
  }
  const cliError = asCliError(error);
  const removed = ran.map((item) => label(item.target));
  const notDone =
    promised.length === 0
      ? ""
      : ` The run-wide removals "This removes" listed did not happen: ${promised.join("; ")}.`;
  return new CliError(
    cliError.code,
    `${cliError.message} Already removed in this run, before this: ${removed.join(", ")}.${notDone}`,
    "fix what the message says, then run facetdb uninstall --source <name> for each table still installed",
    cliError.exit,
    { removed },
  );
}

export const uninstallCommand = defineCommand<UninstallOptions>("uninstall", {
  description:
    "Prints its SQL, asks for the project name back, and removes the columns, trigger and queue",
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
    { flags: "--source <name>", description: "uninstall only this source" },
    { flags: "--purge", description: "also delete the decision log of these sources" },
    ALLOW_INSECURE_OPTION,
  ],
  run: async ({ options, deps, print }) => {
    const config = await loadProjectConfig(deps, options.config);
    const targets = tableTargets(config, options.source);
    const url = await adminUrl(deps, options.adminUrl, options.allowInsecure);
    const shown: Shown[] = [];
    for (const target of targets) {
      shown.push(await show(deps, url, target, targets, options.purge));
    }
    for (const item of shown) {
      print(
        `-- facetdb uninstall${options.purge ? " --purge" : ""}: ${item.target.source.name} (${label(item.target)})`,
      );
      print(item.sql);
      for (const note of item.notes) {
        print(`note: ${note}`);
      }
    }
    const planned = runWords(shown);
    print(`This removes: ${planned.removes.join("; ")}.`);
    print(`This keeps: ${planned.keeps.join("; ")}.`);
    const summary = (ran: readonly Shown[] | undefined) => {
      const words = runWords(ran ?? shown);
      return {
        ok: true,
        dryRun: options.dryRun,
        purge: options.purge,
        removes: words.removes,
        keeps: words.keeps,
        sources: (ran ?? shown).map((item) => ({
          source: item.target.source.name,
          table: label(item.target),
          sql: item.sql,
          applied: ran !== undefined,
          notes: item.notes,
        })),
      };
    };
    if (options.dryRun) {
      print("Dry run: nothing was changed.");
      return summary(undefined);
    }
    const names = [...new Set(shown.map((item) => item.plan.confirmName))];
    if (names.length > 1) {
      // A valid command the connector cannot confirm as one run: a setup problem, not a usage one.
      throw new CliError(
        "several-names",
        `these sources ask for different names to be typed back (${names.join(", ")}); nothing was changed`,
        "run facetdb uninstall once per source with --source <name>",
      );
    }
    const logOnly = shown.every((item) => item.plan.mode === "log-only");
    const typed = await deps.io.prompt(
      `Type the ${logOnly ? "source" : "project"} name (${names.join(", ")}) to continue: `,
    );
    // The connector compares what was typed with the name it asks for; check all before any runs.
    if (shown.some((item) => typed.trim() !== item.plan.confirmName)) {
      throw new CliError(
        "not-confirmed",
        `the name typed is not the ${logOnly ? "source" : "project"}'s name (${names.join(", ")}); nothing was changed`,
        `run facetdb uninstall again and type the ${logOnly ? "source" : "project"} name exactly`,
      );
    }
    const ran: Shown[] = [];
    // What "This removes" promised for the run as a whole: a later failure says it did not happen.
    const lastShown = shown.at(-1);
    const promised = lastShown === undefined ? [] : runRemoved(lastShown.plan);
    for (const [index, item] of shown.entries()) {
      // The plan of each run counts the tables still to come as gone, so the last one's is what
      // the run leaves, and a table's own words never promise what a later table changes.
      const still = shown.slice(index + 1).map((later) => ({
        schema: later.target.schema,
        table: later.target.table,
      }));
      let result: Awaited<ReturnType<typeof uninstall>>;
      try {
        result = await uninstall({
          adminUrl: url,
          source: uninstallSource(item.target),
          purge: options.purge,
          print: sameAsShown(item.sql),
          confirm: () => Promise.resolve(typed),
          alsoUninstalling: still,
          connect: deps.connect,
        });
      } catch (error) {
        throw afterPartialRun(error, ran, promised);
      }
      if (!result.ok) {
        throw afterPartialRun(refused("uninstall-refused", result.reason), ran, promised);
      }
      const removed = [
        ...tableRemoved(result.plan),
        // The run-wide removals happen in the last table's script, once nothing else needs them.
        ...(index === shown.length - 1 ? runRemoved(result.plan) : []),
      ];
      print(`Removed ${removed.join("; ")}.`);
      // The notes shown before the confirmation were the forecast; what the run says differently
      // (what the purge deleted) is printed too, each note once.
      for (const note of result.notes) {
        if (!item.notes.includes(note)) {
          print(`note: ${note}`);
        }
      }
      ran.push({ ...item, plan: result.plan, notes: result.notes });
    }
    print(doneWords(ran));
    return summary(ran);
  },
});
