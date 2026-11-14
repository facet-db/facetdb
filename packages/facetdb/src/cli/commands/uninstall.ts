import type { EngineObject, EnginePlan, EngineTarget, RunResult } from "@facetdb/core";
import { databaseChanged, engineFor, refusalError, stoppedError } from "../engines.ts";
import { asCliError, CliError, databaseLabel, defineCommand } from "../program.ts";
import {
  requireStoreUrl,
  runStorePurge,
  type StorePurge,
  showStorePurge,
  storeSharedFor,
  storeSourceId,
} from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  adminUrl,
  engineTarget,
  loadProjectConfig,
  projectRef,
  type TableTarget,
  tableTargets,
  withoutNothingDone,
} from "./database.ts";
import {
  once,
  runKept,
  runRemoved,
  sourceLog,
  tableKept,
  tableRemoved,
} from "./uninstall-words.ts";

/**
 * `facetdb uninstall`: prints the script for every table first, from the source's engine's plans,
 * with every note the plan carries, then one account of what the whole run removes and keeps, then
 * asks for the name back once; a wrong name runs nothing. The confirmed run plans each table again
 * and runs only a plan whose script is the one shown, and after each table says what that run
 * removed. The decision log stays unless `--purge`. Every word about what goes and what stays comes
 * from the plans' objects (`uninstall-words.ts`), never from a guess here. With the store in
 * another database the engine's plan is the source's side alone, and `--purge` deletes the source's
 * log from the store through the store door, after the engine's run; when that purge fails, the
 * words say both halves: the source's side gone, the log still in the store, and the command that
 * ends it.
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
  readonly engineTarget: EngineTarget;
  readonly plan: EnginePlan;
  readonly script: string;
  /** With the store in another database and `--purge`: the store's part, run after the engine's. */
  readonly storePurge?: StorePurge;
};

const label = (target: TableTarget) => `${target.schema}.${target.table}`;

/** What the run removes from the store: the source's log, with the store in its own database. */
function storeRemoved(item: Shown): readonly string[] {
  const purge = item.storePurge;
  return purge === undefined
    ? []
    : [sourceLog(item.target.source.name, purge.log.decisions, purge.log.versions)];
}

/**
 * The run's words: each table's own, then the run-wide ones from the last plan (it counts every
 * other table of the run as gone, so it is the run's end). `kept` names the log a separate store
 * keeps, which no engine plan holds.
 */
function runWords(
  items: readonly Shown[],
  keptInStore: (item: Shown) => readonly string[],
): { readonly removes: readonly string[]; readonly keeps: readonly string[] } {
  const last = items.at(-1);
  return {
    removes: once([
      ...items.flatMap((item) => [...tableRemoved(item.plan.removes), ...storeRemoved(item)]),
      ...(last === undefined ? [] : runRemoved(last.plan.removes)),
    ]),
    keeps: once([
      ...items.flatMap((item) => [...tableKept(item.plan.keeps), ...keptInStore(item)]),
      ...(last === undefined ? [] : runKept(last.plan.keeps)),
    ]),
  };
}

/** The name an uninstall's plan asks to have typed back: the project's when it says none. */
function confirmOf(item: Shown): { readonly kind: "project" | "source"; readonly name: string } {
  return item.plan.confirm ?? { kind: "project", name: item.engineTarget.project.name };
}

/**
 * The line after the whole run. "Removed FacetDB from …" stands alone (but for the logins, which
 * uninstall never drops) only when nothing else of FacetDB is left behind.
 */
function doneWords(ran: readonly Shown[], keeps: readonly string[]): string {
  const allLogOnly = ran.every((item) => confirmOf(item).kind === "source");
  const done = allLogOnly
    ? `Purged the decision log of source ${ran.map((item) => item.target.source.name).join(", ")}`
    : `Removed FacetDB from ${ran.map((item) => label(item.target)).join(", ")}`;
  const last = ran.at(-1);
  const logins = last === undefined ? undefined : runKept(last.plan.keeps).at(-1);
  return keeps.length === 1 && keeps[0] === logins
    ? `${done}; only ${logins} stay.`
    : `${done}; kept: ${keeps.join("; ")}.`;
}

/** A table the run removed, in words: with the store elsewhere, its log purged there too. */
const removedWords = (item: Shown) =>
  item.storePurge === undefined
    ? label(item.target)
    : `${label(item.target)} (and the decision log of source ${item.target.source.name} in the FacetDB store)`;

/** The run-wide removals "This removes" promised that did not happen, as the sentence that says so. */
function notDoneWords(promised: readonly string[]): string {
  return promised.length === 0
    ? ""
    : ` The run-wide removals "This removes" listed did not happen: ${promised.join("; ")}.`;
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
  return new CliError(
    cliError.code,
    `${cliError.message} Already removed in this run, before this: ${ran.map(removedWords).join(", ")}.${notDoneWords(promised)}`,
    "fix what the message says, then run facetdb uninstall --source <name> for each table still installed",
    cliError.exit,
    { removed },
  );
}

/**
 * The store's purge failed once the engine's run on the source had finished (a half-state): the
 * source's side is gone and the decision log is still in the store. Whatever the failure (the store
 * unreachable, its guard refusing, a raw error), the words say both halves and how to finish, in
 * afterPartialRun's shape: the tables removed before this one, the run-wide removals that did not
 * happen, and `--json` with every table removed, this one with them, and the log not purged.
 */
function logNotPurged(
  error: unknown,
  item: Shown,
  storeLabel: string,
  removedHere: readonly EngineObject[],
  ran: readonly Shown[],
  promised: readonly string[],
): CliError {
  const cause = asCliError(error);
  const name = item.target.source.name;
  const sourceSide =
    tableRemoved(removedHere).length === 0
      ? `${label(item.target)} had no FacetDB install left`
      : `the FacetDB install on ${label(item.target)} was removed`;
  const before =
    ran.length === 0
      ? ""
      : ` Already removed in this run, before this: ${ran.map(removedWords).join(", ")}.`;
  // What this table's run removed of the run's own objects did happen; the rest did not.
  const doneHere = new Set(runRemoved(removedHere));
  return new CliError(
    cause.code,
    `${sourceSide}; the decision log of source ${name} in the FacetDB store on ${storeLabel} was not purged: ${withoutNothingDone(cause.message)}.${before}${notDoneWords(promised.filter((words) => !doneHere.has(words)))}`,
    `fix what the message says, then run facetdb uninstall --purge --source ${name} again: with the install gone, it purges the log alone`,
    cause.exit,
    { removed: [...ran, item].map((done) => label(done.target)), notPurged: [name] },
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
    const url = await adminUrl(deps, options.adminUrl);
    const project = projectRef(deps.projectDir);
    const allowInsecure = options.allowInsecure === true;
    const [first] = targets;
    if (first === undefined) {
      throw new Error("tableTargets returns at least one target");
    }
    // One admin connection reaches one database (tableTargets): one engine and one store's place.
    const engine = await engineFor(
      deps.engines,
      first.source.database ?? url,
      first.source.connector,
    );
    const storeShared = storeSharedFor(deps.env, first.source);
    const storeUrl =
      storeShared || !options.purge ? undefined : requireStoreUrl(deps.env, allowInsecure);
    const engineDeps = { clock: deps.clock, allowInsecure, storeShared };
    const all = targets.map((target) => engineTarget(config, target, project));
    const shown: Shown[] = [];
    for (const [index, target] of targets.entries()) {
      const own = all[index] as EngineTarget;
      // The whole run's forecast: each table's plan counts the run's other tables as gone.
      const planned = await engine.planUninstall(own, url, {
        ...engineDeps,
        purge: options.purge,
        alsoUninstalling: all.filter((other) => other !== own),
      });
      if (!planned.ok) {
        throw refusalError(planned.refusal);
      }
      const storePurge =
        storeUrl === undefined
          ? undefined
          : await showStorePurge(deps.connect, storeUrl, {
              id: storeSourceId(project.id, target.source.name),
              name: target.source.name,
              projectId: project.id,
            });
      if (storePurge !== undefined && storePurge.log.records > 0) {
        throw new CliError(
          "uninstall-refused",
          `the decision log of source "${target.source.name}" is shared with the store source "${target.source.name}" of project ${project.id}, which holds records and is live; nothing was changed.`,
          "change the table or the config as the message says, then run the command again; nothing was changed",
        );
      }
      if (
        storePurge !== undefined &&
        planned.plan.confirm?.kind === "source" &&
        storePurge.log.decisions + storePurge.log.versions === 0
      ) {
        throw new CliError(
          "uninstall-refused",
          `${label(target)} has no FacetDB install left, and the FacetDB store on ${storePurge.label} holds no decision log of source "${target.source.name}"; there is nothing to purge.`,
          "check the source's name, table and schema; nothing was changed",
        );
      }
      shown.push({
        target,
        engineTarget: own,
        plan: planned.plan,
        script: engine.render(planned.plan),
        ...(storePurge === undefined ? {} : { storePurge }),
      });
    }
    // With the store elsewhere and no --purge, the log stays there, in no plan of the engine's.
    const keptInStore = (item: Shown): readonly string[] =>
      storeShared || options.purge
        ? []
        : [
            `the decision log of source ${item.target.source.name} in the FacetDB store (only --purge deletes a log)`,
          ];
    for (const item of shown) {
      if (!storeShared) {
        print(`-- source ${item.target.source.name}: ${databaseLabel(url)}`);
      }
      print(
        `-- facetdb uninstall${options.purge ? " --purge" : ""}: ${item.target.source.name} (${label(item.target)})`,
      );
      print(item.script);
      for (const note of item.plan.notes) {
        print(`note: ${note}`);
      }
      if (item.storePurge !== undefined) {
        print(`-- store: ${item.storePurge.label}`);
        print(item.storePurge.script);
      }
    }
    const planned = runWords(shown, keptInStore);
    print(`This removes: ${planned.removes.join("; ")}.`);
    print(`This keeps: ${planned.keeps.join("; ")}.`);
    const summary = (ran: readonly Shown[] | undefined) => {
      const words = runWords(ran ?? shown, keptInStore);
      return {
        ok: true,
        dryRun: options.dryRun,
        purge: options.purge,
        removes: words.removes,
        keeps: words.keeps,
        sources: (ran ?? shown).map((item) => ({
          source: item.target.source.name,
          table: label(item.target),
          sql: item.script,
          applied: ran !== undefined,
          notes: item.plan.notes,
          ...(item.storePurge === undefined
            ? {}
            : { store: { database: item.storePurge.label, sql: item.storePurge.script } }),
        })),
      };
    };
    if (options.dryRun) {
      print("Dry run: nothing was changed.");
      return summary(undefined);
    }
    const names = [...new Set(shown.map((item) => confirmOf(item).name))];
    if (names.length > 1) {
      // A valid command the engine cannot confirm as one run: a setup problem, not a usage one.
      throw new CliError(
        "several-names",
        `these sources ask for different names to be typed back (${names.join(", ")}); nothing was changed`,
        "run facetdb uninstall once per source with --source <name>",
      );
    }
    const logOnly = shown.every((item) => confirmOf(item).kind === "source");
    const typed = await deps.io.prompt(
      `Type the ${logOnly ? "source" : "project"} name (${names.join(", ")}) to continue: `,
    );
    // The name typed must be the one each plan asks for; check all before any runs.
    if (shown.some((item) => typed.trim() !== confirmOf(item).name)) {
      throw new CliError(
        "not-confirmed",
        `the name typed is not the ${logOnly ? "source" : "project"}'s name (${names.join(", ")}); nothing was changed`,
        `run facetdb uninstall again and type the ${logOnly ? "source" : "project"} name exactly`,
      );
    }
    const ran: Shown[] = [];
    // What "This removes" promised for the run as a whole: a later failure says it did not happen.
    const lastShown = shown.at(-1);
    const promised = lastShown === undefined ? [] : runRemoved(lastShown.plan.removes);
    for (const [index, item] of shown.entries()) {
      // The plan of each run counts the tables still to come as gone, so the last one's is what
      // the run leaves, and a table's own words never promise what a later table changes.
      const still = shown.slice(index + 1).map((later) => later.engineTarget);
      let plan: EnginePlan;
      let result: RunResult;
      try {
        const again = await engine.planUninstall(item.engineTarget, url, {
          ...engineDeps,
          purge: options.purge,
          alsoUninstalling: still,
        });
        if (!again.ok) {
          throw refusalError(again.refusal);
        }
        // What runs is what was shown, string for string: the database as it is now gives it.
        if (engine.render(again.plan) !== item.script) {
          throw databaseChanged();
        }
        plan = again.plan;
        result = await engine.run(item.engineTarget, plan, url, engineDeps);
        if (result.stopped !== undefined) {
          throw stoppedError(result.stopped);
        }
      } catch (error) {
        throw afterPartialRun(error, ran, promised);
      }
      // The store's part goes once the engine's run has finished (its source-side checks passed):
      // from here the source's side is gone, and any failure says both halves.
      if (item.storePurge !== undefined && storeUrl !== undefined) {
        try {
          await runStorePurge(deps.connect, storeUrl, item.storePurge);
        } catch (error) {
          throw logNotPurged(error, item, item.storePurge.label, result.removed, ran, promised);
        }
      }
      const removed = [
        ...tableRemoved(result.removed),
        ...storeRemoved(item),
        // The run-wide removals are the last table's run's, once nothing else needs them.
        ...runRemoved(result.removed),
      ];
      print(`Removed ${removed.join("; ")}.`);
      // The notes shown before the confirmation were the forecast; what the run says differently
      // (what the purge deleted) is printed too, each note once, after the store's part ran.
      for (const note of result.notes) {
        if (!item.plan.notes.includes(note)) {
          print(`note: ${note}`);
        }
      }
      ran.push({ ...item, plan });
    }
    print(doneWords(ran, runWords(ran, keptInStore).keeps));
    return summary(ran);
  },
});
