import { randomUUID } from "node:crypto";
import {
  type Answer,
  checkStateSize,
  choiceConfidence,
  type Decision,
  decide,
  estimateRequestTokens,
  type ProviderRequest,
  type Question,
  type ReadRow,
  type RecordKey,
  type RecordStatus,
  resolveThresholds,
  shouldSkip,
  statusOf,
} from "@facetdb/core";
import { keyWords, openConnector } from "../engines.ts";
import {
  type CliDeps,
  CliError,
  defineCommand,
  EXIT_USAGE,
  likelyYes,
  percent,
} from "../program.ts";
import { storeSharedFor } from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  loadProjectConfig,
  questionSetOf,
  reachedOf,
  type SourceTable,
  singleTarget,
  sourceTable,
  type TableTarget,
} from "./database.ts";

/**
 * `facetdb preview`: reads the most recent rows of a source through its engine's connector (the
 * first page of `scan`, newest first), asks the model every question of the set once per row, and
 * prints what FacetDB would decide, in words, with the status each row would get. It writes
 * nothing: it calls the connector's `scan` alone, never `write`, the queue or the decision log, and
 * closes it before the model is asked.
 */

type PreviewOptions = {
  readonly config: string;
  readonly source?: string;
  readonly limit: string;
  readonly allowInsecure?: boolean;
};

export const PREVIEW_DEFAULT_LIMIT = 20;
const PREVIEW_MAX_LIMIT = 100;
/** Requests in flight at once: a preview is a handful of rows, not a worker. */
const PREVIEW_IN_FLIGHT = 4;

/**
 * One row's preview: what the model said for each question and the status that would follow. Its
 * key as the user writes it (`keyWords`): MongoDB's `65f1…`, never the stored `oid:65f1…`.
 */
type PreviewedRow =
  | { readonly key: string; readonly kind: "skipped"; readonly why: string }
  | {
      readonly key: string;
      readonly kind: "answered";
      readonly status: RecordStatus;
      readonly lines: readonly PreviewedAnswer[];
    };

type PreviewedAnswer = {
  readonly question: string;
  /** The answer in words: "58% likely yes", "billing, 82% sure". */
  readonly said: string;
  /** What the thresholds make of it: "yes", "no", a level or option name, or "needs review". */
  readonly decision: string;
};

function parseLimit(text: string): number {
  const limit = Number(text);
  if (!Number.isInteger(limit) || limit < 1 || limit > PREVIEW_MAX_LIMIT) {
    throw new CliError(
      "limit",
      `--limit is a number of rows from 1 to ${PREVIEW_MAX_LIMIT}, not "${text}"`,
      `pass --limit ${PREVIEW_DEFAULT_LIMIT}, or any whole number up to ${PREVIEW_MAX_LIMIT}`,
      EXIT_USAGE,
    );
  }
  return limit;
}

function label(question: Question): string {
  return question.name.replaceAll("_", " ");
}

/** The answer as a person reads it. Never a raw probability. */
function said(question: Question, answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return likelyYes(answer.probability);
    case "choice":
      return `${answer.top}, ${percent(choiceConfidence(answer.probabilities))} sure`;
    case "score": {
      const level =
        question.type === "score"
          ? question.levels[answer.probabilities.indexOf(Math.max(...answer.probabilities))]
          : undefined;
      return `${level?.name ?? "unknown"}, ${percent(answer.confidence)} sure`;
    }
  }
}

function decisionWords(decision: Decision): string {
  if (decision.kind === "needs_review") {
    return "needs review";
  }
  if (typeof decision.value === "boolean") {
    return decision.value ? "yes" : "no";
  }
  return decision.value;
}

/**
 * The `limit` most recent rows: the first page of the engine connector's `scan`, newest first. The
 * engine refuses a password in the clear to another machine before it connects.
 */
async function recentRows(
  deps: CliDeps,
  target: TableTarget,
  table: SourceTable,
  limit: number,
  allowInsecure: boolean,
): Promise<readonly ReadRow[]> {
  const { source } = target;
  const { engine, url } = reachedOf(
    table,
    source,
    `the connection string of the database that holds ${target.table}`,
  );
  const connector = await openConnector(engine, table.own, url, {
    clock: deps.clock,
    allowInsecure,
    storeShared: storeSharedFor(deps.env, source),
    workerId: `preview-${randomUUID()}`,
  });
  try {
    return (await connector.scan(null)).rows.slice(0, limit);
  } finally {
    await connector.close();
  }
}

/** Runs `work` over `items`, `width` at a time, keeping the order of the results. */
async function inChunks<Item, Result>(
  items: readonly Item[],
  width: number,
  work: (item: Item) => Promise<Result>,
): Promise<Result[]> {
  const results: Result[] = [];
  for (let start = 0; start < items.length; start += width) {
    results.push(...(await Promise.all(items.slice(start, start + width).map(work))));
  }
  return results;
}

export const previewCommand = defineCommand<PreviewOptions>("preview", {
  description: "Answers the most recent rows in the terminal, without changing the database",
  options: [
    {
      flags: "--config <path>",
      description: "the config file",
      defaultValue: "facetdb.config.ts",
    },
    { flags: "--source <name>", description: "the source to preview" },
    {
      flags: "--limit <rows>",
      description: "how many of the most recent rows to answer",
      defaultValue: String(PREVIEW_DEFAULT_LIMIT),
    },
    ALLOW_INSECURE_OPTION,
  ],
  run: async ({ options, deps, print }) => {
    const limit = parseLimit(options.limit);
    const config = await loadProjectConfig(deps, options.config);
    const target = singleTarget(config, options.source);
    const source = target.source;
    const questionSet = questionSetOf(config, source);
    // The table as its engine names it, as migrate's header does.
    const table = await sourceTable(deps, config, target);
    const name = table.label;
    if (options.dryRun) {
      print(
        `Dry run: would read the ${limit} most recent rows of ${name} (source ${source.name}) and ask the model ${questionSet.questions.length} question${questionSet.questions.length === 1 ? "" : "s"} about each. Nothing would be written, and nothing was asked.`,
      );
      return { ok: true, dryRun: true, source: source.name, table: name, rows: limit };
    }

    const rows = await recentRows(deps, target, table, limit, options.allowInsecure === true);
    // A key as the user writes it: MongoDB's `65f1…` for `oid:65f1…`, `1` for `n:1`.
    const keyText = table.reached?.engine.keyText;
    const shown = (key: RecordKey) => keyWords(keyText, key);
    if (rows.length === 0) {
      print(`${name} has no rows yet, so there is nothing to preview.`);
      return { ok: true, source: source.name, table: name, rows: [] };
    }
    const provider = deps.provider(config);
    const previewed = await inChunks(
      rows,
      PREVIEW_IN_FLIGHT,
      async (row): Promise<PreviewedRow> => {
        const key = shown(row.key);
        const skip = shouldSkip(questionSet.read, row.state, { filterExcluded: row.excluded });
        if (skip.skip) {
          return {
            key,
            kind: "skipped",
            why:
              skip.reason === "filtered-out"
                ? "left out by the source's where filter"
                : "nothing to read: every field is empty",
          };
        }
        const request: ProviderRequest = {
          model: questionSet.model,
          state: row.state,
          questions: questionSet.questions,
        };
        if (
          checkStateSize(estimateRequestTokens(request), source.maxStateTokens).kind === "refuse"
        ) {
          return { key, kind: "skipped", why: "too large to send to the model" };
        }
        let response: Awaited<ReturnType<typeof provider.ask>>;
        try {
          response = await provider.ask(request);
        } catch (cause) {
          throw new CliError(
            "model-call",
            `the model did not answer for row ${key}: ${cause instanceof Error ? cause.message : String(cause)}`,
            "run facetdb doctor to check the model key and the connection, then run preview again; nothing was written",
          );
        }
        const decisions: Record<string, Decision> = {};
        const lines = questionSet.questions.map((question): PreviewedAnswer => {
          const answer = response.answers[question.name];
          if (answer === undefined) {
            throw new CliError(
              "model-call",
              `the model's response has no answer for "${question.name}" (row ${key})`,
              "run preview again; if it repeats, run facetdb doctor",
            );
          }
          const decision = decide(
            question,
            resolveThresholds(question, source.thresholds[question.name]),
            answer,
          );
          decisions[question.name] = decision;
          return {
            question: label(question),
            said: said(question, answer),
            decision: decisionWords(decision),
          };
        });
        return { key, kind: "answered", status: statusOf(decisions), lines };
      },
    );

    print(`Preview of ${name}: the ${previewed.length} most recent rows. Nothing was written.`);
    for (const row of previewed) {
      if (row.kind === "skipped") {
        print(`\nRow ${row.key}: skipped (${row.why})`);
        continue;
      }
      print(
        `\nRow ${row.key}: ${row.status === "done" ? "would be decided" : "would go to review"}`,
      );
      for (const line of row.lines) {
        print(`  ${line.question}: ${line.said} -> ${line.decision}`);
      }
    }
    const answered = previewed.filter((row) => row.kind === "answered");
    const review = answered.filter((row) => row.status === "needs_review").length;
    print(
      `\n${answered.length - review} of ${answered.length} answered rows would be decided automatically; ${review} would go to review.`,
    );
    return {
      ok: true,
      source: source.name,
      table: name,
      rows: previewed,
      decided: answered.length - review,
      review,
    };
  },
});
