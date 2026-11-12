import {
  type BackfillEstimate,
  type BackfillReport,
  createBackfill,
  DEFAULT_BACKFILL_PACE,
} from "@facetdb/core";
import { CliError, defineCommand, EXIT_SETUP, EXIT_USAGE } from "../program.ts";
import { loadProjectConfig, singleTarget } from "./database.ts";

/**
 * `facetdb backfill`: answers every existing row of a source, newest first, at a pace, resumable.
 * The cost is shown before anything is asked and nothing starts without a yes (or `--yes`). The
 * engine is core's `createBackfill`: it saves its place after every page, so a run that stops is
 * continued by running the command again.
 */

type BackfillOptions = {
  readonly config: string;
  readonly source?: string;
  readonly pace: string;
  readonly question?: string;
  readonly yes: boolean;
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

function money(dollars: number): string {
  return dollars > 0 && dollars < 0.01 ? "less than $0.01" : `about $${dollars.toFixed(2)}`;
}

/** The estimate in words: records, tokens, dollars. */
function describeEstimate(estimate: BackfillEstimate): string {
  return `${whole.format(estimate.records)} records to answer, about ${whole.format(Math.round(estimate.tokens))} input tokens, ${money(estimate.dollars)}.`;
}

function summary(report: BackfillReport) {
  return {
    status: report.status,
    estimate: report.estimate,
    queued: report.enqueued.length,
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
  description: "Answers every existing row, newest first, paced and resumable",
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
    { flags: "--yes", description: "start without asking, after showing the estimate" },
  ],
  run: async ({ options, deps, print }) => {
    const pace = parsePace(options.pace);
    const config = await loadProjectConfig(deps, options.config);
    const target = singleTarget(config, options.source);
    const source = target.source;
    const onlyQuestions = parseQuestions(
      options.question,
      source.questions.map((question) => question.name),
    );
    const name = `${target.schema}.${target.table}`;
    const setup = await deps.backfill(config, source, { dryRun: options.dryRun });
    try {
      const backfill = createBackfill(setup.deps);
      let answeredRecords = 0;
      const report = await backfill.run({
        pace,
        ...(onlyQuestions === undefined ? {} : { onlyQuestions }),
        onEstimate: async (estimate) => {
          print(`Backfill of ${name} (source ${source.name}), newest records first:`);
          print(describeEstimate(estimate));
          // The pace is a ceiling: each queue call is a round trip, so a far database (about 200 ms
          // a statement) goes slower than it.
          const seconds = Math.ceil(estimate.records / pace);
          print(
            `Pace: at most ${pace} records per second, so about ${whole.format(seconds)} ${seconds === 1 ? "second" : "seconds"} on a database close to the worker.`,
          );
          if (options.dryRun) {
            print(
              "The estimate counts every row of the table: a dry run does not open FacetDB's store, so it cannot see a saved resume point or rows already answered.",
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
          ? `Done: ${whole.format(report.enqueued.length)} records queued for the worker, ${whole.format(report.alreadyAnswered.length)} already answered. Run facetdb worker to answer the queue.`
          : `Done: ${whole.format(report.answered.length)} records answered, ${whole.format(report.alreadyAnswered.length)} already had these answers, ${whole.format(report.deferred.length)} left for the worker.`,
      );
      return { ok: true, ...summary(report) };
    } finally {
      await setup.close();
    }
  },
});
