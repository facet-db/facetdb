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
  type RecordStatus,
  resolveThresholds,
  shouldSkip,
  statusOf,
} from "@facetdb/core";
import { createScan } from "@facetdb/postgres";
import type { SourceConfig } from "../../config/index.ts";
import {
  type CliDeps,
  CliError,
  defineCommand,
  EXIT_USAGE,
  likelyYes,
  percent,
} from "../program.ts";
import { loadProjectConfig, questionSetOf, singleTarget, type TableTarget } from "./database.ts";

/**
 * `facetdb preview`: reads the most recent rows of a source through `scan`, asks the model every
 * question of the set once per row, and prints what FacetDB would decide, in words, with the status
 * each row would get. It writes nothing: it holds no connector, so there is no `write`, no queue
 * and no decision log in reach.
 */

type PreviewOptions = {
  readonly config: string;
  readonly source?: string;
  readonly limit: string;
};

export const PREVIEW_DEFAULT_LIMIT = 20;
const PREVIEW_MAX_LIMIT = 100;
/** Requests in flight at once: a preview is a handful of rows, not a worker. */
const PREVIEW_IN_FLIGHT = 4;

const PRIMARY_KEY_QUERY = `select kcu.column_name as name
  from information_schema.table_constraints tc
  join information_schema.key_column_usage kcu
    on kcu.constraint_name = tc.constraint_name
   and kcu.constraint_schema = tc.constraint_schema
   and kcu.table_schema = tc.table_schema
   and kcu.table_name = tc.table_name
 where tc.table_schema = $1 and tc.table_name = $2 and tc.constraint_type = 'PRIMARY KEY'
 order by kcu.ordinal_position`;

/** One row's preview: what the model said for each question and the status that would follow. */
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

async function primaryKey(deps: CliDeps, url: string, target: TableTarget): Promise<string> {
  const client = deps.connect(url);
  try {
    const rows = await client.query(PRIMARY_KEY_QUERY, [target.schema, target.table]);
    const names = rows.map((row) => String(row["name"]));
    const [key] = names;
    if (key === undefined || names.length > 1) {
      throw new CliError(
        "primary-key",
        `${target.schema}.${target.table} needs a single-column primary key, and has ${names.length === 0 ? "none" : names.join(", ")}`,
        "add a primary key (or a surrogate key) to the table; FacetDB keys its answers by it",
      );
    }
    return key;
  } finally {
    await client.close();
  }
}

async function recentRows(
  deps: CliDeps,
  target: TableTarget,
  source: SourceConfig,
  config: Parameters<typeof questionSetOf>[0],
  limit: number,
): Promise<readonly ReadRow[]> {
  const url = source.database;
  if (url === undefined) {
    throw new CliError(
      "database-url",
      `the source "${source.name}" has no connection string`,
      `set ${source.databaseEnv ?? "DATABASE_URL"} to the connection string of the database that holds ${target.table}`,
    );
  }
  const key = await primaryKey(deps, url, target);
  const client = deps.connect(url);
  try {
    const scan = createScan({
      query: client.query,
      source: { table: target.table, schema: target.schema, key },
      questionSet: questionSetOf(config, source),
      pageSize: limit,
    });
    return (await scan(null)).rows;
  } finally {
    await client.close();
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
  ],
  run: async ({ options, deps, print }) => {
    const limit = parseLimit(options.limit);
    const config = await loadProjectConfig(deps, options.config);
    const target = singleTarget(config, options.source);
    const source = target.source;
    const questionSet = questionSetOf(config, source);
    const name = `${target.schema}.${target.table}`;
    if (options.dryRun) {
      print(
        `Dry run: would read the ${limit} most recent rows of ${name} (source ${source.name}) and ask the model ${questionSet.questions.length} question${questionSet.questions.length === 1 ? "" : "s"} about each. Nothing would be written, and nothing was asked.`,
      );
      return { ok: true, dryRun: true, source: source.name, table: name, rows: limit };
    }

    const rows = await recentRows(deps, target, source, config, limit);
    if (rows.length === 0) {
      print(`${name} has no rows yet, so there is nothing to preview.`);
      return { ok: true, source: source.name, table: name, rows: [] };
    }
    const provider = deps.provider(config);
    const previewed = await inChunks(
      rows,
      PREVIEW_IN_FLIGHT,
      async (row): Promise<PreviewedRow> => {
        const skip = shouldSkip(questionSet.read, row.state, { filterExcluded: row.excluded });
        if (skip.skip) {
          return {
            key: row.key,
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
          return { key: row.key, kind: "skipped", why: "too large to send to the model" };
        }
        let response: Awaited<ReturnType<typeof provider.ask>>;
        try {
          response = await provider.ask(request);
        } catch (cause) {
          throw new CliError(
            "model-call",
            `the model did not answer for row ${row.key}: ${cause instanceof Error ? cause.message : String(cause)}`,
            "run facetdb doctor to check the model key and the connection, then run preview again; nothing was written",
          );
        }
        const decisions: Record<string, Decision> = {};
        const lines = questionSet.questions.map((question): PreviewedAnswer => {
          const answer = response.answers[question.name];
          if (answer === undefined) {
            throw new CliError(
              "model-call",
              `the model's response has no answer for "${question.name}" (row ${row.key})`,
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
        return { key: row.key, kind: "answered", status: statusOf(decisions), lines };
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
