import {
  type Answer,
  type AnswerEntry,
  answerColumns,
  choiceConfidence,
  type Decision,
  decide,
  type HumanEntry,
  type LogEntry,
  parseQuestionSet,
  type Question,
  type QuestionSet,
  resolveThresholds,
} from "@facetdb/core";
import { installOwnedColumns, SIDE_TABLE_SCHEMA, sideTableName } from "@facetdb/postgres";
import type { SourceConfig } from "../../config/index.ts";
import {
  type CliDeps,
  CliError,
  defineCommand,
  EXIT_USAGE,
  likelyYes,
  percent,
} from "../program.ts";
import { loadProjectConfig, questionSetOf, singleTarget } from "./database.ts";

/**
 * `facetdb explain <source> <key>`: one record's full history, oldest first, in words. Each model
 * answer and each human decision is shown with the wording and thresholds of the question-set
 * version it ran under, read from the store's saved versions, never from today's config: the
 * history says what was asked then. It reads and writes nothing else; the decision log is
 * append-only.
 */

type ExplainOptions = {
  readonly config: string;
};

/** One question as it was worded in the version in force, with the answer in words. */
type ExplainedAnswer = {
  readonly question: string;
  /** The wording the model was given in that version. */
  readonly wording: string;
  /** "58% likely yes", "billing, 82% sure". */
  readonly said: string;
  /** What that version's thresholds made of it: "yes", "no", a name, or "needs review". */
  readonly decision: string;
};

type ExplainedEntry =
  | {
      readonly kind: "answer";
      readonly at: string;
      readonly model: string;
      readonly version: number;
      readonly answers: readonly ExplainedAnswer[];
    }
  | {
      readonly kind: "human";
      readonly at: string;
      readonly version: number;
      readonly question: string;
      /** The wording of that version, or the question's name when the version is not kept. */
      readonly wording: string;
      readonly decided: string;
      readonly reviewer: string;
      readonly note?: string;
    };

/** The record as it stands now: FacetDB's own columns, in words. */
type CurrentState = {
  readonly found: boolean;
  readonly status?: string;
  readonly reviewed?: boolean;
  readonly values: Readonly<Record<string, string>>;
};

/** `2026-10-28 14:02`, in UTC, so the same history reads the same on every machine. */
function when(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ");
}

function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

function said(question: Question | undefined, answer: Answer): string {
  switch (answer.type) {
    case "noul":
      return likelyYes(answer.probability);
    case "choice":
      return `${answer.top}, ${percent(choiceConfidence(answer.probabilities))} sure`;
    case "score": {
      const level =
        question?.type === "score"
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
  return typeof decision.value === "boolean" ? yesNo(decision.value) : decision.value;
}

/**
 * Every saved version of the source's question set that the history mentions. The store's rows are
 * a boundary: a row that no longer parses is an error that names the version, never a guess.
 */
async function versionsOf(
  deps: CliDeps,
  url: string,
  source: string,
  versions: readonly number[],
): Promise<ReadonlyMap<number, QuestionSet>> {
  const kept = new Map<number, QuestionSet>();
  if (versions.length === 0) {
    return kept;
  }
  const client = deps.connect(url);
  try {
    const rows = await client.query(
      "select version::text as version, question_set from facetdb.question_set_versions where source_id = $1 and version = any($2::int[])",
      [source, versions],
    );
    for (const row of rows) {
      const version = Number(row["version"]);
      const raw = row["question_set"];
      const parsed = parseQuestionSet(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (!parsed.ok) {
        throw new CliError(
          "question-set-version",
          `question set v${version} of "${source}" in the FacetDB store cannot be read: ${parsed.errors.join("; ")}`,
          "open an issue with this message; the store's saved versions are never edited by hand",
        );
      }
      kept.set(version, parsed.questionSet);
    }
    return kept;
  } finally {
    await client.close();
  }
}

function explainAnswer(entry: AnswerEntry, set: QuestionSet | undefined): ExplainedEntry {
  const answers = Object.entries(entry.answers).map(([name, answer]): ExplainedAnswer => {
    const question = set?.questions.find((candidate) => candidate.name === name);
    return {
      question: name,
      wording: question?.instructions ?? name,
      said: said(question, answer),
      decision:
        question === undefined || set === undefined
          ? "unknown"
          : decisionWords(
              decide(question, resolveThresholds(question, set.thresholds[name]), answer),
            ),
    };
  });
  return {
    kind: "answer",
    at: entry.at.toISOString(),
    model: entry.model,
    version: entry.version,
    answers,
  };
}

function explainHuman(entry: HumanEntry, set: QuestionSet | undefined): ExplainedEntry {
  const question = set?.questions.find((candidate) => candidate.name === entry.question);
  return {
    kind: "human",
    at: entry.at.toISOString(),
    version: entry.version,
    question: entry.question,
    wording: question?.instructions ?? entry.question,
    decided: typeof entry.value === "boolean" ? yesNo(entry.value) : entry.value,
    reviewer: entry.reviewer,
    ...(entry.note === undefined ? {} : { note: entry.note }),
  };
}

function lineOf(entry: ExplainedEntry): string[] {
  const at = when(new Date(entry.at));
  if (entry.kind === "human") {
    const note = entry.note === undefined ? "" : ` · note: ${entry.note}`;
    return [
      `${at} · question set v${entry.version} · "${entry.wording}" decided ${entry.decided} by ${entry.reviewer}${note}`,
    ];
  }
  return [
    `${at} · ${entry.model} · question set v${entry.version}`,
    ...entry.answers.map((answer) => `    "${answer.wording}" ${answer.said} → ${answer.decision}`),
  ];
}

function describe(value: unknown): string {
  if (value === null || value === undefined) {
    return "not answered";
  }
  return typeof value === "boolean" ? yesNo(value) : String(value);
}

/** Reads the record's own FacetDB columns from its table, or its row in the store for an API source. */
async function currentState(
  deps: CliDeps,
  config: Parameters<typeof questionSetOf>[0],
  source: SourceConfig,
  key: string,
  storeUrl: string,
): Promise<CurrentState> {
  const questionSet = questionSetOf(config, source);
  const fail = (cause: unknown, where: string) =>
    new CliError(
      "row-read",
      `the record's current state could not be read from ${where}: ${cause instanceof Error ? cause.message : String(cause)}`,
      "run facetdb doctor to check the connection and the login's permissions",
    );
  if (source.table === undefined) {
    const client = deps.connect(storeUrl);
    try {
      const rows = await client.query(
        "select status, decision, reviewed from facetdb.records where source_id = $1 and record_key = $2",
        [source.name, key],
      );
      const row = rows[0];
      if (row === undefined) {
        return { found: false, values: {} };
      }
      const decision = row["decision"];
      const parsed: unknown = typeof decision === "string" ? JSON.parse(decision) : decision;
      const values: Record<string, string> = {};
      if (typeof parsed === "object" && parsed !== null) {
        for (const [name, value] of Object.entries(parsed)) {
          values[name] = describe(value);
        }
      }
      return {
        found: true,
        status: String(row["status"]),
        reviewed: row["reviewed"] === true,
        values,
      };
    } catch (cause) {
      throw fail(cause, "the FacetDB store");
    } finally {
      await client.close();
    }
  }

  const { schema, table } = singleTarget(config, source.name);
  const url = source.database;
  if (url === undefined) {
    throw new CliError(
      "database-url",
      `the source "${source.name}" has no connection string`,
      `set ${source.databaseEnv ?? "DATABASE_URL"} to the connection string of the database that holds ${table}`,
    );
  }
  // Side-table mode keeps the answers and the status on facetdb.<table>_answers (install never
  // adds them to the app's table), keyed by the source's key; the worker login can read that
  // table and its key from the catalog, but not the app table's constraints (as doctor does).
  const [answerSchema, answerTable] =
    source.storage === "side-table" ? [SIDE_TABLE_SCHEMA, sideTableName(table)] : [schema, table];
  const client = deps.connect(url);
  try {
    const keyRows =
      source.storage === "side-table"
        ? await client.query(
            `select a.attname as name
               from pg_catalog.pg_index i
               join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = any (i.indkey)
              where i.indrelid = to_regclass($1) and i.indisprimary
              order by array_position(i.indkey::int2[], a.attnum)`,
            [`${quote(answerSchema)}.${quote(answerTable)}`],
          )
        : await client.query(
            `select kcu.column_name as name
               from information_schema.table_constraints tc
               join information_schema.key_column_usage kcu
                 on kcu.constraint_name = tc.constraint_name
                and kcu.constraint_schema = tc.constraint_schema
                and kcu.table_schema = tc.table_schema
                and kcu.table_name = tc.table_name
              where tc.table_schema = $1 and tc.table_name = $2 and tc.constraint_type = 'PRIMARY KEY'
              order by kcu.ordinal_position`,
            [schema, table],
          );
    const keyColumns = keyRows.map((row) => String(row["name"]));
    const [keyColumn] = keyColumns;
    if (keyColumn === undefined || keyColumns.length > 1) {
      throw new CliError(
        "primary-key",
        `${answerSchema}.${answerTable} needs a single-column primary key, and has ${keyColumns.length === 0 ? "none" : keyColumns.join(", ")}`,
        source.storage === "side-table"
          ? "run facetdb migrate: the side table is made with the source's key"
          : "add a primary key (or a surrogate key) to the table; FacetDB keys its answers by it",
      );
    }
    const columns = installOwnedColumns(questionSet);
    const rows = await client.query(
      `select ${columns.map(quote).join(", ")} from ${quote(answerSchema)}.${quote(answerTable)} where ${quote(keyColumn)}::text = $1`,
      [key],
    );
    const row = rows[0];
    if (row === undefined) {
      return { found: false, values: {} };
    }
    const values: Record<string, string> = {};
    for (const question of questionSet.questions) {
      const value = answerColumns(question).find((column) => column.role === "value");
      if (value !== undefined) {
        values[question.name] = describe(row[value.name]);
      }
    }
    return {
      found: true,
      status: String(row["facetdb_status"]),
      reviewed: row["facetdb_reviewed"] === true,
      values,
    };
  } catch (cause) {
    if (cause instanceof CliError) {
      throw cause;
    }
    throw fail(cause, `${answerSchema}.${answerTable}`);
  } finally {
    await client.close();
  }
}

function stateLine(state: CurrentState): string {
  if (!state.found) {
    return "Now: the record is not in the source any more, or FacetDB has not seen it yet.";
  }
  const values = Object.entries(state.values).map(([name, value]) => `${name}: ${value}`);
  return `Now: ${[...values, `status: ${state.status ?? "unknown"}`, `reviewed: ${yesNo(state.reviewed === true)}`].join(" · ")}`;
}

export const explainCommand = defineCommand<ExplainOptions>("explain", {
  description: "Prints one record's full history in words: every answer and every human decision",
  arguments: ["<source>", "<key>"],
  options: [
    {
      flags: "--config <path>",
      description: "the config file",
      defaultValue: "facetdb.config.ts",
    },
  ],
  run: async ({ options, args, deps, print }) => {
    const [sourceName, key] = args;
    if (sourceName === undefined || key === undefined) {
      throw new CliError(
        "usage",
        "explain needs a source and a record key",
        "run facetdb explain <source> <key>, for example facetdb explain listings 42",
        EXIT_USAGE,
      );
    }
    const config = await loadProjectConfig(deps, options.config);
    const source = config.sources.find((candidate) => candidate.name === sourceName);
    if (source === undefined) {
      throw new CliError(
        "unknown-source",
        `the config has no source named "${sourceName}"`,
        `pass one of: ${config.sources.map((candidate) => candidate.name).join(", ")}`,
        EXIT_USAGE,
      );
    }
    if (options.dryRun) {
      print(
        `Dry run: would read the history of record ${key} of ${source.name} from the FacetDB store. Nothing is written by explain, with or without --dry-run.`,
      );
      return { ok: true, dryRun: true, source: source.name, key };
    }

    const url = deps.env["DATABASE_URL"];
    if (url === undefined || url === "") {
      throw new CliError(
        "database-url",
        "DATABASE_URL is not set, so FacetDB has no store to read the history from",
        "set DATABASE_URL to the connection string of the database FacetDB keeps its store in",
      );
    }
    const store = await deps.store();
    let history: readonly LogEntry[];
    try {
      history = await store.log(source.name).history(key);
    } finally {
      await store.close();
    }
    if (history.length === 0) {
      print(
        `FacetDB has no history for record ${key} of "${source.name}".\n` +
          `Is the source right? The sources in the config are: ${config.sources.map((candidate) => candidate.name).join(", ")}.\n` +
          "Has the worker run? Start it with facetdb worker, or answer existing rows with facetdb backfill. Then check the key: it is the table's primary key, as text.",
      );
      return { ok: true, source: source.name, key, entries: [] };
    }

    const versions = await versionsOf(deps, url, source.name, [
      ...new Set(history.map((entry) => entry.version)),
    ]);
    const entries = history.map((entry) =>
      entry.kind === "answer"
        ? explainAnswer(entry, versions.get(entry.version))
        : explainHuman(entry, versions.get(entry.version)),
    );
    const state = await currentState(deps, config, source, key, url);

    print(`History of record ${key} of "${source.name}", oldest first:`);
    for (const entry of entries) {
      for (const line of lineOf(entry)) {
        print(line);
      }
    }
    print(stateLine(state));
    return { ok: true, source: source.name, key, entries, current: state };
  },
});
