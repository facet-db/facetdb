import { randomUUID } from "node:crypto";
import {
  type BackfillEstimate,
  type BackfillReport,
  createBackfill,
  DEFAULT_BACKFILL_PACE,
  followReview,
  type OpenConnector,
  restoreFromLog,
  reviewsOf,
} from "@facetdb/core";
import type { ProjectConfig, SourceCall, SourceConfig } from "../../config/index.ts";
import {
  hostedSource,
  type PluginHost,
  PluginHostError,
  PluginSourceFailed,
} from "../../plugin/index.ts";
import { openConnector, requireUsableUrl } from "../engines.ts";
import { type CliDeps, CliError, defineCommand, EXIT_SETUP, EXIT_USAGE } from "../program.ts";
import { requireUsableStoreUrl, storeSharedFor, storeSourceId, storeUrlOf } from "../store-door.ts";
import { costWords } from "./backfill-cost.ts";
import { addedQuestionsEnd, fromLogEnd, leftOver, wholeSetEnd } from "./backfill-left.ts";
import {
  ALLOW_INSECURE_OPTION,
  loadPluginHost,
  loadProjectConfig,
  pluginHostForAlerts,
  projectRef,
  questionSetOf,
  singleTarget,
  sourceTable,
  type TableTarget,
} from "./database.ts";
import { tableRead } from "./explain.ts";
import { pluginHostForProvider } from "./model-provider.ts";

/**
 * `facetdb backfill`: answers every existing row of a source, newest first, at a pace, resumable.
 * The cost is shown before anything is asked and nothing starts without a yes (or `--yes`). The
 * engine is core's `createBackfill`: it saves its place after every page, so a run that stops is
 * continued by running the command again. A plugin source is paged through its plugin's own `scan`,
 * in the plugin's order: "`facetdb backfill` labels every open issue once". Its words say that
 * order and never newest first, which the SDK does not ask of a plugin.
 */

/** What a backfill pages through: a source's table, or a plugin source's own scan. */
type BackfillTarget =
  | { readonly kind: "table"; readonly target: TableTarget }
  | { readonly kind: "plugin"; readonly source: SourceConfig; readonly call: SourceCall };

/**
 * The source `--source` names, or the config's one source a backfill can page through: one that
 * reads a table (`singleTarget`'s rule, so a config of tables reads as it always has) or one a
 * plugin reads. An API source's records arrive one by one: it has nothing to page through.
 */
function backfillTarget(config: ProjectConfig, only: string | undefined): BackfillTarget {
  const plugins = config.sources.flatMap((source) =>
    source.source !== undefined && (only === undefined || source.name === only)
      ? [{ kind: "plugin" as const, source, call: source.source }]
      : [],
  );
  if (plugins.length === 0) {
    return { kind: "table", target: singleTarget(config, only) };
  }
  const [first] = plugins;
  const tables =
    only === undefined ? config.sources.filter((source) => source.table !== undefined) : [];
  if (first !== undefined && plugins.length === 1 && tables.length === 0) {
    return first;
  }
  const names = config.sources
    .filter((source) => source.table !== undefined || source.source !== undefined)
    .map((source) => source.name);
  throw new CliError(
    "which-source",
    `the config has ${names.length} sources a backfill can page through (a table, or a plugin's scan), and this command works on one`,
    `pass --source with one of: ${names.join(", ")}`,
    EXIT_USAGE,
  );
}

/** The plugin source checked against the plugins loaded, as the worker checks it at its start. */
function checkPluginSource(
  deps: CliDeps,
  config: ProjectConfig,
  source: SourceConfig,
  host: PluginHost,
): void {
  try {
    hostedSource(host, config, source, deps.env);
  } catch (error) {
    if (error instanceof PluginHostError) {
      throw new CliError(error.code, error.message, error.fix);
    }
    throw error;
  }
}

/**
 * A plugin source's scan that failed, as the command's refusal: the words are FacetDB's, since a
 * plugin's own are never kept, and the saved place is where the next run starts.
 */
function scanFailure(error: unknown): CliError | undefined {
  if (
    !(error instanceof PluginSourceFailed) &&
    !(error instanceof Error && error.name === "SourceAccessLost")
  ) {
    return undefined;
  }
  return new CliError(
    "backfill-plugin",
    `${error.message}, so the backfill stopped; the pages queued before it are saved`,
    "once the plugin pages again (for a refused credential, set the variable named above where this command runs), run facetdb backfill again: it resumes from the saved place and skips what is answered",
    EXIT_SETUP,
  );
}

type BackfillOptions = {
  readonly config: string;
  readonly source?: string;
  readonly pace: string;
  readonly question?: string;
  readonly fromLog?: boolean;
  readonly yes: boolean;
  readonly allowInsecure?: boolean;
};

function parsePace(text: string): number {
  const pace = Number(text);
  if (!Number.isFinite(pace) || pace <= 0) {
    throw new CliError(
      "pace",
      `--pace is a number of records per second above zero, not "${text}"`,
      `pass --pace ${DEFAULT_BACKFILL_PACE} (the default), or a lower number to go gentler on the model`,
      EXIT_USAGE,
    );
  }
  return pace;
}

function parseQuestions(
  text: string | undefined,
  known: readonly string[],
): readonly string[] | undefined {
  if (text === undefined) {
    return undefined;
  }
  const names = text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  const unknown = names.filter((name) => !known.includes(name));
  if (names.length === 0 || unknown.length > 0) {
    throw new CliError(
      "unknown-question",
      names.length === 0
        ? "--question names no question"
        : `the source has no question named ${unknown.map((name) => `"${name}"`).join(", ")}`,
      `pass --question with one or more of: ${known.join(", ")} (separate several with commas)`,
      EXIT_USAGE,
    );
  }
  return names;
}

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * `facetdb backfill --from-log`: each record the decision log answered gets its latest logged
 * decision written back (core's `restoreFromLog`), with no model call and no action: no provider,
 * spending gate or action is built, so nothing is asked, reserved or sent. The count comes first
 * and nothing is written without a yes (or `--yes`); `--dry-run` reads the log and the source and
 * writes nothing. The log lives in the store, so a dry run opens it too, as `export --dry-run`
 * does. A table's records are read and written through its engine, a plugin source's in the store.
 */
async function writeBackFromLog(
  deps: CliDeps,
  print: (text: string) => void,
  config: ProjectConfig,
  picked: BackfillTarget,
  run: {
    readonly pace: number;
    readonly dryRun: boolean;
    readonly yes: boolean;
    readonly allowInsecure: boolean;
  },
) {
  const source = picked.kind === "table" ? picked.target.source : picked.source;
  const { allowInsecure } = run;
  const storeUrl = storeUrlOf(deps.env);
  if (storeUrl === undefined) {
    throw new CliError(
      "database-url",
      "DATABASE_URL is not set, so FacetDB has no decision log to write back from",
      "set DATABASE_URL to the connection string of the database FacetDB keeps its store in",
    );
  }
  // Before any connection: the store's URL, then the source's own.
  requireUsableStoreUrl(storeUrl, allowInsecure, deps.env["PGHOST"]);
  const table =
    picked.kind === "table" ? await tableRead(deps, config, source, allowInsecure) : undefined;
  const name =
    table?.label ??
    (picked.kind === "plugin" ? `${picked.call.plugin} ${picked.call.source}` : source.name);
  const store = await deps.store({ allowInsecure });
  const workerId = `restore-${randomUUID()}`;
  const sourceId = storeSourceId(projectRef(deps.projectDir).id, source.name);
  let connector: OpenConnector | undefined;
  try {
    connector =
      table === undefined
        ? undefined
        : await openConnector(table.engine, table.target, table.url, {
            clock: deps.clock,
            allowInsecure,
            storeShared: storeSharedFor(deps.env, source),
            workerId,
          });
    const reviews = reviewsOf(store.reviews, sourceId);
    const report = await restoreFromLog(
      {
        questionSet: questionSetOf(config, source),
        log: store.log(sourceId),
        connector: connector ?? store.connector({ sourceId, fields: source.read, workerId }),
        follow: (record, decision, answer) => followReview(reviews, record, decision, answer),
        clock: deps.clock,
      },
      {
        pace: run.pace,
        dryRun: run.dryRun,
        confirm: async (records) => {
          print(
            `Write back from the decision log, ${name} (source ${source.name}): ${records === 0 ? "no record has" : `${whole.format(records)} ${records === 1 ? "record has" : "records have"}`} a logged answer.`,
          );
          if (records === 0) {
            return true;
          }
          print(
            "Each gets its latest logged decision, a person's included, unless it changed since. No model call and no action, so no cost.",
          );
          if (run.dryRun) {
            return true;
          }
          print(`Pace: at most ${run.pace} records written per second.`);
          if (run.yes) {
            return true;
          }
          const answer = await deps.io.prompt("Write them back? Type yes to continue: ");
          return answer.trim().toLowerCase() === "yes";
        },
        onProgress: (looked, records) => {
          if (looked < records) {
            print(`${whole.format(looked)} of ${whole.format(records)} records looked at.`);
          }
        },
      },
    );
    const counts = {
      written: report.written.length,
      alreadyCurrent: report.current.length,
      changed: report.changed.length,
      missingQuestion: report.incomplete.length,
      kept: report.kept.length,
      gone: report.gone.length,
    };
    if (report.status === "declined") {
      print("Nothing was written. Run the command again and type yes (or pass --yes) to start.");
      return { ok: true, fromLog: true, dryRun: run.dryRun, status: report.status, ...counts };
    }
    print(fromLogEnd(report, source.name, run.dryRun));
    return { ok: true, fromLog: true, dryRun: run.dryRun, status: report.status, ...counts };
  } finally {
    await connector?.close();
    await store.close();
  }
}

/** The estimate in words: records, tokens, dollars ("at least" when nothing billed scaled it). */
function describeEstimate(estimate: BackfillEstimate): string {
  return `${whole.format(estimate.records)} records to answer, ${costWords(estimate)}.`;
}

function summary(report: BackfillReport) {
  return {
    status: report.status,
    estimate: report.estimate,
    queued: report.enqueued.length,
    notQueued: report.notQueued.length,
    answered: report.answered.length,
    alreadyAnswered: report.alreadyAnswered.length,
    discarded: report.discarded.length,
    refused: report.refused.length,
    deferred: report.deferred.length,
    failed: report.failures.length,
    cursor: report.cursor,
  };
}

export const backfillCommand = defineCommand<BackfillOptions>("backfill", {
  description:
    "Answers every existing row, newest first (in the plugin's order for a plugin source), paced and resumable",
  options: [
    {
      flags: "--config <path>",
      description: "the config file",
      defaultValue: "facetdb.config.ts",
    },
    { flags: "--source <name>", description: "the source to backfill" },
    {
      flags: "--pace <records>",
      description: "records started per second",
      defaultValue: String(DEFAULT_BACKFILL_PACE),
    },
    {
      flags: "--question <names>",
      description: "ask only these questions (comma-separated), for questions you just added",
    },
    {
      flags: "--from-log",
      description:
        "write each answered record's latest logged decision back, with no model call and no action (after a table rebuild)",
    },
    { flags: "--yes", description: "start without asking, after showing the estimate" },
    ALLOW_INSECURE_OPTION,
  ],
  run: async ({ options, deps, print }) => {
    if (options.fromLog === true && options.question !== undefined) {
      throw new CliError(
        "from-log-question",
        "--from-log writes back every question the log answered, so it does not take --question",
        "run facetdb backfill --from-log without --question; for a question you just added, run facetdb backfill --question <names> after it",
        EXIT_USAGE,
      );
    }
    const pace = parsePace(options.pace);
    const config = await loadProjectConfig(deps, options.config);
    const picked = backfillTarget(config, options.source);
    if (options.fromLog === true) {
      return writeBackFromLog(deps, print, config, picked, {
        pace,
        dryRun: options.dryRun,
        yes: options.yes,
        allowInsecure: options.allowInsecure === true,
      });
    }
    const source = picked.kind === "table" ? picked.target.source : picked.source;
    const onlyQuestions = parseQuestions(
      options.question,
      source.questions.map((question) => question.name),
    );
    const allowInsecure = options.allowInsecure === true;
    let name: string;
    if (picked.kind === "table") {
      // The table as its engine names it, as migrate's header does.
      const table = await sourceTable(deps, config, picked.target);
      name = table.label;
      // Before anything connects, a dry run included (it reads the source): no password in the
      // clear, by the source's engine for its connection string and by the store door for the store's.
      if (table.reached !== undefined) {
        requireUsableUrl(table.reached.engine, table.own, table.reached.url, allowInsecure);
      }
    } else {
      // The source as the Sources page names its connector: the plugin and its source.
      name = `${picked.call.plugin} ${picked.call.source}`;
    }
    const storeUrl = storeUrlOf(deps.env);
    if (!options.dryRun && storeUrl !== undefined) {
      requireUsableStoreUrl(storeUrl, allowInsecure, deps.env["PGHOST"]);
    }
    // A plugin's provider needs its plugin host, built as the worker builds it, and so do the alert
    // channels the backfill's alerts go to; a config with neither builds none. A plugin source is
    // read through its plugin, so it always has one, its source checked as the worker's.
    let host: PluginHost | undefined;
    if (picked.kind === "plugin") {
      const loaded = await loadPluginHost(deps, config, options.config);
      checkPluginSource(deps, config, source, loaded);
      host = loaded;
    } else {
      host = await pluginHostForProvider(deps, config, options.config);
    }
    const plugins = await pluginHostForAlerts(deps, config, options.config, host);
    const setup = await deps.backfill(config, source, {
      dryRun: options.dryRun,
      ...(options.allowInsecure === true ? { allowInsecure: true } : {}),
      ...(plugins === undefined ? {} : { plugins }),
      ...(picked.kind === "plugin" ? { note: print } : {}),
    });
    try {
      const backfill = createBackfill(setup.deps);
      let answeredRecords = 0;
      const report = await backfill.run({
        pace,
        ...(onlyQuestions === undefined ? {} : { onlyQuestions }),
        onEstimate: async (estimate) => {
          print(
            `Backfill of ${name} (source ${source.name}), ${picked.kind === "plugin" ? "records in the plugin's order" : "newest records first"}:`,
          );
          print(describeEstimate(estimate));
          // The pace is a ceiling: each queue call is a round trip, so a far database (about 200 ms
          // a statement) goes slower than it.
          const seconds = Math.ceil(estimate.records / pace);
          print(
            `Pace: at most ${pace} records per second, so about ${whole.format(seconds)} ${seconds === 1 ? "second" : "seconds"} on a database close to the worker.`,
          );
          if (picked.kind === "plugin") {
            // What the estimate cost the plugin, and what the run costs it: said before the yes.
            print(
              options.dryRun
                ? "Counting them paged once through the plugin's scan, one call to the plugin per page."
                : "Counting them paged once through the plugin's scan from the saved place, one call to the plugin per page, and stored and queued nothing. The run pages through it again, each page once, and takes each record into FacetDB's store as it queues it.",
            );
          }
          if (options.dryRun) {
            print(
              picked.kind === "plugin"
                ? "The estimate counts every record the plugin's scan returns: a dry run does not open FacetDB's store, so it cannot see a saved resume point or records already answered."
                : "The estimate counts every row of the table: a dry run does not open FacetDB's store, so it cannot see a saved resume point or rows already answered.",
            );
            print("Dry run: nothing was asked and nothing was changed.");
            return false;
          }
          if (options.yes) {
            return true;
          }
          const answer = await deps.io.prompt("Start the backfill? Type yes to continue: ");
          return answer.trim().toLowerCase() === "yes";
        },
        onPage: (page) => {
          answeredRecords += page.records;
          print(
            page.cursor === null
              ? `${whole.format(answeredRecords)} records done. That was the last page.`
              : picked.kind === "plugin"
                ? // A plugin's cursor is its own text, never printed: it could hold a line break.
                  `${whole.format(answeredRecords)} records done. Resume point saved.`
                : `${whole.format(answeredRecords)} records done. Resume point saved: ${page.cursor}`,
          );
        },
      });

      if (report.status === "declined") {
        if (!options.dryRun) {
          print(
            "Nothing was asked and nothing was changed. Run the command again and type yes (or pass --yes) to start.",
          );
        }
        return { ok: true, dryRun: options.dryRun, ...summary(report) };
      }
      if (report.status === "stopped") {
        throw new CliError(
          "backfill-stopped",
          `${report.failures.length} record${report.failures.length === 1 ? "" : "s"} failed, so the backfill stopped at the page it was on; the earlier pages are saved`,
          "run facetdb doctor to check the model key and the connection, then run facetdb backfill again: it resumes from the saved place and skips what is answered",
          EXIT_SETUP,
          summary(report),
        );
      }
      if (report.status === "paused") {
        throw new CliError(
          "backfill-paused",
          "the spending cap was reached, so the backfill paused; the earlier pages are saved",
          "raise the spending cap in the config or wait for the next month, then run facetdb backfill again: it resumes from the saved place",
          EXIT_SETUP,
          summary(report),
        );
      }
      print(
        onlyQuestions === undefined
          ? wholeSetEnd(
              "Done",
              {
                queued: report.enqueued.length,
                alreadyAnswered: report.alreadyAnswered.length,
                notQueued: report.notQueued.length,
              },
              "cli",
            )
          : addedQuestionsEnd(
              "Done",
              {
                answered: report.answered.length,
                alreadyAnswered: report.alreadyAnswered.length,
              },
              leftOver(report.deferred),
              source.name,
              "cli",
            ),
      );
      return { ok: true, ...summary(report) };
    } catch (error) {
      // A plugin's scan that failed: said in FacetDB's words, with where the next run starts.
      throw scanFailure(error) ?? error;
    } finally {
      await setup.close();
    }
  },
});
