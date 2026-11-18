import type { EngineObject, EnginePlan, EngineTarget, RunResult } from "@facetdb/core";
import { databaseChanged, refusalError, stoppedError } from "../engines.ts";
import { asCliError, CliError, databaseLabel, defineCommand } from "../program.ts";
import {
  requireStoreUrl,
  resumeRowsByHand,
  runStoreUninstall,
  type StoreUninstall,
  showStoreUninstall,
  storeSharedFor,
  storeSourceId,
  storeUrlOf,
} from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  adminRun,
  engineTarget,
  loadProjectConfig,
  projectRef,
  type TableTarget,
  tableTargets,
  withoutNothingDone,
} from "./database.ts";
import {
  accountLines,
  once,
  resumeRows,
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
 * ends it. Every uninstall, purge or not, deletes the source's resume rows in the store's
 * `facetdb.cursors`: in the engine's script with the store shared, through the store door
 * otherwise, so a source with the store elsewhere needs `DATABASE_URL` whatever the flags.
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
  /** The table as its engine names it: `public.listings`, `dbo.listings`, `listings`. */
  readonly label: string;
  readonly plan: EnginePlan;
  readonly script: string;
  /**
   * With the store in another database: the store's part, run after the engine's, when there is
   * one (`--purge`, or resume rows of the source in the store).
   */
  readonly store?: StoreUninstall;
};

/**
 * What the run removes from the store, with the store in its own database: the source's log with
 * `--purge`, and its resume rows when it has any.
 */
function storeRemoved(item: Shown): readonly string[] {
  const part = item.store;
  if (part === undefined) {
    return [];
  }
  const name = item.target.source.name;
  return [
    ...(part.log === undefined ? [] : [sourceLog(name, part.log.decisions, part.log.versions)]),
    ...(part.resumeRows.length === 0 ? [] : [resumeRows(name, part.resumeRows.length)]),
  ];
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
 * uninstall never drops) only when nothing else of FacetDB is left behind; with nothing kept at all
 * (a SQLite file, which has no logins) it ends there.
 */
function doneWords(ran: readonly Shown[], keeps: readonly string[]): string {
  const allLogOnly = ran.every((item) => confirmOf(item).kind === "source");
  const done = allLogOnly
    ? `Purged the decision log of source ${ran.map((item) => item.target.source.name).join(", ")}`
    : `Removed FacetDB from ${ran.map((item) => item.label).join(", ")}`;
  if (keeps.length === 0) {
    return `${done}.`;
  }
  const last = ran.at(-1);
  // The polling engine keeps one login, the trigger engine two; runKept says them last.
  const kept = last?.plan.keeps.filter((object) => object.scope === "run") ?? [];
  const logins = kept.filter((object) => object.kind === "login").length;
  const loginWords = last === undefined || logins === 0 ? undefined : runKept(kept).at(-1);
  return keeps.length === 1 && keeps[0] === loginWords
    ? `${done}; only ${loginWords} ${logins === 1 ? "stays" : "stay"}.`
    : `${done}; kept: ${keeps.join("; ")}.`;
}

/** What the store's part of a table's uninstall deletes, in short words: its log, its resume rows. */
function storeShortWords(item: Shown, part: StoreUninstall): string {
  const name = item.target.source.name;
  const parts = [
    ...(part.log === undefined ? [] : [`the decision log of source ${name}`]),
    ...(part.resumeRows.length === 0 ? [] : [`the resume rows of source ${name}`]),
  ];
  return parts.join(" and ");
}

/** A table the run removed, in words: with the store elsewhere, its log or resume rows there too. */
const removedWords = (item: Shown) =>
  item.store === undefined
    ? item.label
    : `${item.label} (and ${storeShortWords(item, item.store)} in the FacetDB store)`;

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
  const removed = ran.map((item) => item.label);
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
 * Without `--purge` the store's part is the source's resume rows alone: the words say they stay,
 * and the fix is the statement that deletes them.
 */
function logNotPurged(
  error: unknown,
  item: Shown,
  part: StoreUninstall,
  removedHere: readonly EngineObject[],
  ran: readonly Shown[],
  promised: readonly string[],
): CliError {
  const cause = asCliError(error);
  const name = item.target.source.name;
  const sourceSide =
    tableRemoved(removedHere).length === 0
      ? `${item.label} had no FacetDB install left`
      : `the FacetDB install on ${item.label} was removed`;
  const before =
    ran.length === 0
      ? ""
      : ` Already removed in this run, before this: ${ran.map(removedWords).join(", ")}.`;
  // What this table's run removed of the run's own objects did happen; the rest did not.
  const doneHere = new Set(runRemoved(removedHere));
  const why = `${withoutNothingDone(cause.message)}.${before}${notDoneWords(promised.filter((words) => !doneHere.has(words)))}`;
  const removed = [...ran, item].map((done) => done.label);
  if (part.log === undefined) {
    // No purge: only the resume rows were to go, and a later uninstall finds no install to plan,
    // so the fix is the one statement that deletes the rows read before the confirmation.
    return new CliError(
      cause.code,
      `${sourceSide}; the resume rows of source ${name} in the FacetDB store on ${part.label} were not deleted: ${why}`,
      `fix what the message says, then delete them in the store: ${resumeRowsByHand(part)}`,
      cause.exit,
      { removed, resumeRowsLeft: [name] },
    );
  }
  return new CliError(
    cause.code,
    `${sourceSide}; the decision log of source ${name} in the FacetDB store on ${part.label} was not purged: ${why}`,
    `fix what the message says, then run facetdb uninstall --purge --source ${name} again: with the install gone, it purges the log alone`,
    cause.exit,
    { removed, notPurged: [name] },
  );
}

/**
 * Why an uninstall with the store in another database stops when `DATABASE_URL` is unset, before
 * anything connects: the store holds the sources' resume rows, and with `--purge` their logs, and
 * only it can remove them. A store whose database is gone is no dead end: reading and deleting what
 * is there treats a store without FacetDB's tables as an empty one.
 */
function storeNeeded(sources: readonly string[], purge: boolean): CliError {
  const named = `${sources.length === 1 ? "source" : "sources"} ${sources.join(", ")}`;
  const held = purge
    ? `the resume rows and the decision log of ${named}`
    : `the resume rows of ${named} (where a backfill or a change stream picks up again)`;
  return new CliError(
    "database-url",
    `DATABASE_URL is not set, and the FacetDB store, in another database than the source's, holds ${held}: uninstall needs DATABASE_URL to remove them; nothing was changed`,
    "set DATABASE_URL to the connection string of the FacetDB store's database; if that database is gone, point it at any Postgres where FacetDB may create its store. Nothing of the source is touched until you type the name back",
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
    // With the store elsewhere every uninstall reaches it: the source's resume rows go with or
    // without --purge, so its URL is required before anything connects.
    if (!storeShared && storeUrlOf(deps.env) === undefined) {
      throw storeNeeded(
        targets.map((target) => target.source.name),
        options.purge,
      );
    }
    const storeUrl = storeShared ? undefined : requireStoreUrl(deps.env, allowInsecure);
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
      const store =
        storeUrl === undefined
          ? undefined
          : await showStoreUninstall(
              deps.connect,
              storeUrl,
              {
                id: storeSourceId(project.id, target.source.name),
                name: target.source.name,
                projectId: project.id,
              },
              options.purge,
            );
      const log = store?.log;
      if (log !== undefined && log.records > 0) {
        throw new CliError(
          "uninstall-refused",
          `the decision log of source "${target.source.name}" is shared with the store source "${target.source.name}" of project ${project.id}, which holds records and is live; nothing was changed.`,
          "change the table or the config as the message says, then run the command again; nothing was changed",
        );
      }
      if (
        store !== undefined &&
        log !== undefined &&
        planned.plan.confirm?.kind === "source" &&
        log.decisions + log.versions + store.resumeRows.length === 0
      ) {
        throw new CliError(
          "uninstall-refused",
          `${engine.label(own)} has no FacetDB install left, and the FacetDB store on ${store.label} holds no decision log of source "${target.source.name}"; there is nothing to purge.`,
          "check the source's name, table and schema; nothing was changed",
        );
      }
      shown.push({
        target,
        engineTarget: own,
        label: engine.label(own),
        plan: planned.plan,
        script: engine.render(planned.plan),
        ...(store === undefined ? {} : { store }),
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
        `-- facetdb uninstall${options.purge ? " --purge" : ""}: ${item.target.source.name} (${item.label})`,
      );
      print(item.script);
      for (const note of item.plan.notes) {
        print(`note: ${note}`);
      }
      if (item.store !== undefined) {
        print(`-- store: ${item.store.label}`);
        print(item.store.script);
      }
    }
    for (const line of accountLines(runWords(shown, keptInStore))) {
      print(line);
    }
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
          table: item.label,
          sql: item.script,
          applied: ran !== undefined,
          notes: item.plan.notes,
          ...(item.store === undefined
            ? {}
            : { store: { database: item.store.label, sql: item.store.script } }),
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
      if (item.store !== undefined && storeUrl !== undefined) {
        try {
          await runStoreUninstall(deps.connect, storeUrl, item.store);
        } catch (error) {
          throw logNotPurged(error, item, item.store, result.removed, ran, promised);
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
