import { randomUUID } from "node:crypto";
import {
  type AgreementSide,
  contentHash,
  createAlerts,
  createQuestionTestService,
  type ModelProvider,
  PreviewModelError,
  type PreviewSkipReason,
  type QuestionSet,
  QuestionTestFieldsError,
  type QuestionTestResult,
  type QuestionTestRow,
  type RecordKey,
  resolveThresholds,
  TEST_DEFAULT_SAMPLE,
  TEST_ESTIMATE_TOLERANCE,
  TEST_MAX_SAMPLE,
  type TestEstimate,
} from "@facetdb/core";
import { createBackoff, createInFlightLimiter, createResilientProvider } from "@facetdb/model";
import { projectSpending } from "../backfill-wiring.ts";
import { keyWords, openConnector, requireUsableUrl, tableKeyText } from "../engines.ts";
import { CliError, defineCommand, EXIT_USAGE, percent } from "../program.ts";
import { requireUsableStoreUrl, storeSharedFor, storeSourceId, storeUrlOf } from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  loadProjectConfig,
  projectRef,
  questionSetOf,
  reachedOf,
  savedQuestionSets,
  singleTarget,
  sourceTable,
} from "./database.ts";
import { pluginHostForProvider } from "./model-provider.ts";

/**
 * `facetdb test`: the draft in `facetdb.config.ts` as it stands on disk, run on the newest records
 * and on every record a person decided, against the question set the store keeps as the version in
 * force. The cost is printed first and asked about (`--yes` skips the question); then, per
 * question, how many answers would change and how agreement with reviewers moves. Nothing is
 * written to the source or to the store's log or versions: applying the draft is committing the
 * file and starting the worker on it, and re-answering existing records is `facetdb backfill`.
 */

type TestOptions = {
  readonly config: string;
  readonly source?: string;
  readonly sample: string;
  readonly yes: boolean;
  readonly allowInsecure?: boolean;
};

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

function money(dollars: number): string {
  return dollars > 0 && dollars < 0.01 ? "less than $0.01" : `about $${dollars.toFixed(2)}`;
}

function plural(count: number, one: string, many: string): string {
  return `${whole.format(count)} ${count === 1 ? one : many}`;
}

function parseSample(text: string): number {
  const sample = Number(text);
  if (!Number.isInteger(sample) || sample < 1 || sample > TEST_MAX_SAMPLE) {
    throw new CliError(
      "sample",
      `--sample is a number of records from 1 to ${whole.format(TEST_MAX_SAMPLE)}, not "${text}"`,
      `pass --sample ${TEST_DEFAULT_SAMPLE} (the default), or a smaller whole number to test fewer records`,
      EXIT_USAGE,
    );
  }
  return sample;
}

/**
 * The thresholds each question decides at, stakes defaults and overrides resolved: a change of
 * stakes moves them as an override does, though neither is part of the version's content hash.
 */
function thresholdsKey(set: QuestionSet): string {
  return JSON.stringify(
    set.questions
      .map((question) => [
        question.name,
        resolveThresholds(question, set.thresholds[question.name]),
      ])
      .sort(([a], [b]) => (String(a) < String(b) ? -1 : 1)),
  );
}

/** Whether running the draft could change anything: the model sees the same, the thresholds are the same. */
function sameAsCurrent(current: QuestionSet, draft: QuestionSet): boolean {
  return (
    contentHash(current) === contentHash(draft) &&
    thresholdsKey(current) === thresholdsKey(draft) &&
    current.where === draft.where
  );
}

/** The estimate in words, with the margin its "about" promises. */
export function estimateWords(estimate: TestEstimate): string {
  const reviewed =
    estimate.reviewedRecords === 0
      ? "no record a person decided"
      : plural(estimate.reviewedRecords, "record a person decided", "records a person decided");
  return (
    `${plural(estimate.sampleRecords, "newest record", "newest records")} and ${reviewed}: ` +
    `${plural(estimate.requests, "model request", "model requests")}, ` +
    `about ${whole.format(Math.round(estimate.inputTokens))} input tokens, ${money(estimate.dollars)}. ` +
    `The count after the run can differ from this by up to ${percent(TEST_ESTIMATE_TOLERANCE)}.`
  );
}

function sideWords(side: AgreementSide): string {
  const rate = side.rate === null ? "decided none" : percent(side.rate);
  return side.unsure === 0 ? rate : `${rate} (${whole.format(side.unsure)} left unsure)`;
}

/** One question's row of the table, in words: what would change, and how agreement moves. */
export function questionWords(row: QuestionTestRow): readonly string[] {
  const label = row.question.replaceAll("_", " ");
  if (row.comparison === "new") {
    return [
      `${label}: a new question, so the version in force has no answers to compare with.`,
      agreementWords(row),
    ];
  }
  if (row.comparison === "kind-changed") {
    return [
      `${label}: this question changed kind (yes or no, choice, score), so its answers cannot be compared.`,
      agreementWords(row),
    ];
  }
  const moves = [
    ...(row.toDecided > 0 ? [`${whole.format(row.toDecided)} move from unsure to a decision`] : []),
    ...(row.toReview > 0 ? [`${whole.format(row.toReview)} the other way`] : []),
    ...(row.toAnotherValue > 0 ? [`${whole.format(row.toAnotherValue)} to another value`] : []),
  ];
  const change =
    row.compared === 0
      ? "no record to compare"
      : row.changed === 0
        ? `none of ${whole.format(row.compared)} answers would change`
        : `${whole.format(row.changed)} of ${whole.format(row.compared)} answers would change (${moves.join(", ")})`;
  const notes = [
    ...(row.noCurrentAnswer > 0
      ? [
          `${plural(row.noCurrentAnswer, "record has", "records have")} no answer in the log at its present state, so not compared`,
        ]
      : []),
    ...(row.keptForPeople > 0
      ? [
          `${plural(row.keptForPeople, "record keeps", "records keep")} a person's decision whatever the draft says`,
        ]
      : []),
  ];
  return [
    `${label}: ${change}.`,
    ...(notes.length === 0 ? [] : [`  ${notes.join("; ")}.`]),
    agreementWords(row),
  ];
}

function agreementWords(row: QuestionTestRow): string {
  const { agreement } = row;
  if (agreement.kind === "none") {
    return "  Agreement with reviewers: no record a person decided on this question was tested, so there is no number.";
  }
  const base = `  Agreement with reviewers (${plural(agreement.records, "record", "records")} a person decided): `;
  return agreement.now === null
    ? `${base}${sideWords(agreement.draft)} with the draft; the version in force has no answers to set it against.`
    : `${base}${sideWords(agreement.now)} now, ${sideWords(agreement.draft)} with the draft.`;
}

const NOT_ASKED: Readonly<Record<PreviewSkipReason, string>> = {
  "filtered-out": "left out by the where filter",
  "empty-state": "nothing to read",
  "too-large": "too large to send to the model",
  "spending-cap": "not asked because the spending cap was reached",
};

function notAskedWords(skipped: Readonly<Record<PreviewSkipReason, number>>): string | undefined {
  const parts = (Object.keys(NOT_ASKED) as PreviewSkipReason[])
    .filter((reason) => skipped[reason] > 0)
    .map((reason) => `${whole.format(skipped[reason])} ${NOT_ASKED[reason]}`);
  return parts.length === 0 ? undefined : `Not asked: ${parts.join(", ")}.`;
}

function modelFailure(error: PreviewModelError, key: string): CliError {
  if (error.question !== undefined) {
    return new CliError(
      "model-call",
      `the model's response has no answer for "${error.question}" (record ${key})`,
      "run the test again; if it repeats, run facetdb doctor",
    );
  }
  return new CliError(
    "model-call",
    `the model did not answer for record ${key}: ${error.message}`,
    "run facetdb doctor to check the model key and the connection, then run the test again; nothing was written",
  );
}

export const testCommand = defineCommand<TestOptions>("test", {
  description:
    "Runs the draft in facetdb.config.ts on recent and reviewed records and shows what would change",
  options: [
    {
      flags: "--config <path>",
      description: "the config file, the draft",
      defaultValue: "facetdb.config.ts",
    },
    { flags: "--source <name>", description: "the source to test" },
    {
      flags: "--sample <records>",
      description: "how many of the newest records to test, besides every reviewed record",
      defaultValue: String(TEST_DEFAULT_SAMPLE),
    },
    { flags: "--yes", description: "run without asking, after showing the estimate" },
    ALLOW_INSECURE_OPTION,
  ],
  run: async ({ options, deps, print }) => {
    const sample = parseSample(options.sample);
    const config = await loadProjectConfig(deps, options.config);
    const target = singleTarget(config, options.source);
    const source = target.source;
    const draft = questionSetOf(config, source);
    // The table as its engine names it, as preview and backfill print it.
    const table = await sourceTable(deps, config, target);
    const name = table.label;
    if (options.dryRun) {
      print(
        `Dry run: would read the ${whole.format(sample)} newest records of ${name} (source ${source.name}) and every record a person decided, from the FacetDB store's log, and print the estimate. Then, once you agree, it would ask the model the draft's ${plural(draft.questions.length, "question", "questions")} about each. Nothing would be written, and nothing was asked.`,
      );
      return { ok: true, dryRun: true, source: source.name, table: name, sample };
    }

    // Before anything connects: no password in the clear to another machine, the store's or the source's.
    const allowInsecure = options.allowInsecure === true;
    const { engine, url } = reachedOf(
      table,
      source,
      `the connection string of the database that holds ${target.table}`,
    );
    requireUsableUrl(engine, table.own, url, allowInsecure);
    const storeUrl = storeUrlOf(deps.env);
    if (storeUrl === undefined) {
      throw new CliError(
        "database-url",
        "DATABASE_URL is not set, so FacetDB has no store to read the version in force and the reviewed records from",
        "set DATABASE_URL to the connection string of the database FacetDB keeps its store in",
      );
    }
    requireUsableStoreUrl(storeUrl, allowInsecure, deps.env["PGHOST"]);

    const project = projectRef(deps.projectDir);
    const sourceId = storeSourceId(project.id, source.name);
    const store = await deps.store({ allowInsecure });
    try {
      // The set the worker runs, whole (store migration 8), when a worker has recorded one; else
      // the newest version's row, which keeps only what its content hash sees (a threshold changed
      // since the version was made is invisible there; the worker's row shows it).
      const inForce = await store.questionSets.inForce(sourceId);
      const version = inForce ?? (await store.questionSets.latest(sourceId));
      if (version === undefined) {
        throw new CliError(
          "no-version",
          `FacetDB has no saved version of the questions of "${source.name}" yet, so there is nothing to test the draft against`,
          "run facetdb worker (or facetdb backfill) once so the file you have now becomes version 1, then edit it and run facetdb test",
        );
      }
      const current =
        inForce?.questionSet ??
        (await savedQuestionSets(deps, storeUrl, sourceId, [version.version])).get(version.version);
      if (current === undefined) {
        throw new CliError(
          "question-set-version",
          `question set v${version.version} of "${source.name}" is not in the FacetDB store`,
          "open an issue with this message; the store's saved versions are never edited by hand",
        );
      }
      if (sameAsCurrent(current, draft)) {
        print(
          `${options.config} says what version ${version.version} of ${source.name} says: the questions, their wording, the model and the thresholds are the same, so nothing would change and nothing was asked.`,
        );
        return {
          ok: true,
          source: source.name,
          table: name,
          version: version.version,
          unchanged: true,
        };
      }

      // The rows carry every field either set reads: the current version's decide what still
      // stands, the draft's are what the model is shown.
      const read = [...new Set([...draft.read, ...current.read])];
      const keyText = await tableKeyText(engine, table.own, url, allowInsecure);
      const shown = (key: RecordKey) => keyWords(keyText, key);
      const connector = await openConnector(
        engine,
        { ...table.own, questionSet: { ...table.own.questionSet, read } },
        url,
        {
          clock: deps.clock,
          allowInsecure,
          storeShared: storeSharedFor(deps.env, source),
          workerId: `test-${randomUUID()}`,
        },
      );
      try {
        // Made on the first request only, so a test that asks nothing needs no model key. The
        // backoff and the in-flight limit are the worker's: a test is a thousand requests.
        // A plugin's provider needs its plugin host, built here so a refusal comes before any row.
        const plugins = await pluginHostForProvider(deps, config, options.config);
        let provider: ModelProvider | undefined;
        const lazyProvider: ModelProvider = {
          ask: (request) => {
            provider ??= createResilientProvider(deps.provider(config, plugins), {
              backoff: createBackoff({ clock: deps.clock, random: deps.random }),
              limiter: createInFlightLimiter({ clock: deps.clock }),
            });
            return provider.ask(request);
          },
        };
        const alerts = createAlerts({ store: store.alerts, clock: deps.clock, channels: [] });
        const service = createQuestionTestService({
          connector,
          decisions: store.log(sourceId),
          provider: lazyProvider,
          spending: projectSpending(config, store, alerts, deps.clock, project.id),
          note: (line) => print(`note: ${line}`),
          clock: deps.clock,
          ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
        });

        let plan: Awaited<ReturnType<typeof service.testQuestionSet>>;
        try {
          plan = await service.testQuestionSet({ current, draft, sample, reviewed: true });
        } catch (error) {
          if (error instanceof QuestionTestFieldsError) {
            throw new CliError(
              "test-fields",
              `the rows of ${name} do not carry the state fields ${error.missing.join(", ")}`,
              "check read: in facetdb.config.ts names columns the table has, then run the test again",
            );
          }
          throw error;
        }

        print(
          `Test of the draft in ${options.config} against version ${version.version} of ${source.name} (${name}):`,
        );
        print(estimateWords(plan.estimate));
        if (plan.estimate.requests === 0) {
          print("There is nothing to ask the model, so nothing was asked and nothing was changed.");
          return {
            ok: true,
            source: source.name,
            table: name,
            version: version.version,
            estimate: plan.estimate,
          };
        }
        if (!options.yes) {
          if (!(await deps.io.answerable())) {
            throw new CliError(
              "no-answer",
              "there is no terminal to ask whether to run the test on, and no line of standard input was given for it",
              "pass --yes to run the test after the estimate, or --dry-run to see what it would read",
            );
          }
          const answer = await deps.io.prompt("Run the test? Type yes to continue: ");
          if (answer.trim().toLowerCase() !== "yes") {
            print(
              "Nothing was asked and nothing was changed. Run the command again and type yes (or pass --yes) to run the test.",
            );
            return {
              ok: true,
              declined: true,
              source: source.name,
              table: name,
              version: version.version,
              estimate: plan.estimate,
            };
          }
        }

        let result: QuestionTestResult;
        try {
          result = await plan.run();
        } catch (error) {
          if (error instanceof PreviewModelError) {
            throw modelFailure(error, shown(error.key));
          }
          throw error;
        }
        if (result.kind === "capped") {
          throw new CliError("spending-cap", result.message, result.fix);
        }

        print("");
        for (const row of result.questions) {
          for (const line of questionWords(row)) {
            print(line);
          }
        }
        if (result.removed.length > 0) {
          print(
            `Dropped by the draft: ${result.removed.map((removed) => removed.replaceAll("_", " ")).join(", ")}.`,
          );
        }
        const notAsked = notAskedWords(result.skipped);
        if (notAsked !== undefined) {
          print(notAsked);
        }
        print(
          `\nThe model counted ${whole.format(result.cost.inputTokens)} input tokens (${money(result.cost.dollars)}); the estimate said about ${whole.format(Math.round(result.estimate.inputTokens))}.`,
        );
        print(
          `\nNothing was changed: the worker still runs version ${version.version}. Next:\n` +
            `  1. To run this draft from now on, commit ${options.config} and restart facetdb worker, which then runs the draft for the records it answers from then on.\n` +
            `  2. To re-answer the records already answered, run facetdb backfill after that; it shows its own estimate first (facetdb backfill --question <names> asks only the questions you added).`,
        );
        return {
          ok: true,
          source: source.name,
          table: name,
          version: version.version,
          ...result,
        };
      } finally {
        await connector.close();
      }
    } finally {
      await store.close();
    }
  },
});
