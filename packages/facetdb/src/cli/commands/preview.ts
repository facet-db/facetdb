import { randomUUID } from "node:crypto";
import {
  type Answer,
  choiceConfidence,
  createPreviewService,
  type Decision,
  type ModelProvider,
  PREVIEW_DEFAULT_LIMIT,
  PreviewModelError,
  type PreviewRow,
  type PreviewSkipReason,
  type Question,
  type QuestionSet,
  type RecordKey,
  type RecordStatus,
  type SpendingGate,
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
 * `facetdb preview`: reads the most recent rows of a source through its engine's connector (`scan`,
 * newest first), asks the model every question of the set once per row through core's preview
 * service (the one the studio's `POST /v1/preview` runs too), and prints what FacetDB would decide,
 * in words, with the status each row would get. It writes nothing: the service calls the
 * connector's `scan` alone, never `write`, the queue or the decision log.
 */

type PreviewOptions = {
  readonly config: string;
  readonly source?: string;
  readonly limit: string;
  readonly allowInsecure?: boolean;
};

export { PREVIEW_DEFAULT_LIMIT };

const PREVIEW_MAX_LIMIT = 100;

/**
 * The terminal's preview opens no FacetDB store: opening one builds its schema in the database, and
 * a preview changes nothing, before `facetdb migrate` too, so its tokens are not counted against
 * the month. The studio's preview runs inside `facetdb worker` on the project's own gate, the
 * store-backed one its workers share (`projectSpending`).
 */
const TERMINAL_UNMETERED: SpendingGate = {
  allowsWork: () => Promise.resolve(true),
  admit: () => Promise.resolve("terminal-preview"),
  settle: () => Promise.resolve(),
  record: () => Promise.resolve(),
  finish: () => Promise.resolve(),
};

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

const SKIPPED_WHY: Readonly<Record<PreviewSkipReason, string>> = {
  "filtered-out": "left out by the source's where filter",
  "empty-state": "nothing to read: every field is empty",
  "too-large": "too large to send to the model",
  "spending-cap": "not asked: the spending cap was reached",
};

/** The service's row in the terminal's words. */
function inWords(questionSet: QuestionSet, row: PreviewRow, key: string): PreviewedRow {
  if (row.kind === "skipped") {
    return { key, kind: "skipped", why: SKIPPED_WHY[row.reason] };
  }
  const lines = questionSet.questions.map((question): PreviewedAnswer => {
    const answer = row.answers[question.name];
    const decision = row.decisions[question.name];
    if (answer === undefined || decision === undefined) {
      throw new Error(`the preview service answered row ${key} without "${question.name}"`);
    }
    return {
      question: label(question),
      said: said(question, answer),
      decision: decisionWords(decision),
    };
  });
  return { key, kind: "answered", status: row.status, lines };
}

/** A failed model call in words: the row as the user writes it, and what to do. */
function modelFailure(error: PreviewModelError, key: string): CliError {
  if (error.question !== undefined) {
    return new CliError(
      "model-call",
      `the model's response has no answer for "${error.question}" (row ${key})`,
      "run preview again; if it repeats, run facetdb doctor",
    );
  }
  return new CliError(
    "model-call",
    `the model did not answer for row ${key}: ${error.message}`,
    "run facetdb doctor to check the model key and the connection, then run preview again; nothing was written",
  );
}

/**
 * The preview through the engine's connector, closed afterwards. The engine refuses a password in
 * the clear to another machine before it connects.
 */
async function previewRows(
  deps: CliDeps,
  target: TableTarget,
  table: SourceTable,
  questionSet: QuestionSet,
  limit: number,
  options: {
    readonly allowInsecure: boolean;
    readonly provider: ModelProvider;
    readonly print: (text: string) => void;
  },
) {
  const { source } = target;
  const { engine, url } = reachedOf(
    table,
    source,
    `the connection string of the database that holds ${target.table}`,
  );
  const connector = await openConnector(engine, table.own, url, {
    clock: deps.clock,
    allowInsecure: options.allowInsecure,
    storeShared: storeSharedFor(deps.env, source),
    workerId: `preview-${randomUUID()}`,
  });
  try {
    return await createPreviewService({
      connector,
      provider: options.provider,
      spending: TERMINAL_UNMETERED,
      log: (line) => options.print(`note: ${line}`),
      // Read only at a reached cap, which the terminal's unmetered gate never reports.
      clock: deps.clock,
      ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
    }).preview(questionSet, limit);
  } finally {
    await connector.close();
  }
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

    // A key as the user writes it: MongoDB's `65f1…` for `oid:65f1…`, `1` for `n:1`.
    const keyText = table.reached?.engine.keyText;
    const shown = (key: RecordKey) => keyWords(keyText, key);
    // Made on the first request only, so a table with no rows needs no model.
    let provider: ModelProvider | undefined;
    const lazyProvider: ModelProvider = {
      ask: (request) => {
        provider ??= deps.provider(config);
        return provider.ask(request);
      },
    };
    let result: Awaited<ReturnType<typeof previewRows>>;
    try {
      result = await previewRows(deps, target, table, questionSet, limit, {
        allowInsecure: options.allowInsecure === true,
        provider: lazyProvider,
        print,
      });
    } catch (error) {
      if (error instanceof PreviewModelError) {
        throw modelFailure(error, shown(error.key));
      }
      throw error;
    }
    if (result.kind === "capped") {
      throw new CliError("spending-cap", result.message, result.fix);
    }
    if (result.rows.length === 0) {
      print(`${name} has no rows yet, so there is nothing to preview.`);
      return { ok: true, source: source.name, table: name, rows: [] };
    }
    const previewed = result.rows.map((row) => inWords(questionSet, row, shown(row.key)));

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
