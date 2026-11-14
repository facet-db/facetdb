import { randomUUID } from "node:crypto";
import {
  type Answer,
  type AnswerEntry,
  type Connector,
  type CurrentDecision,
  choiceConfidence,
  type DatabaseEngine,
  type Decision,
  decide,
  type EngineDeps,
  type EngineTarget,
  type HumanEntry,
  type LogEntry,
  type Question,
  type QuestionSet,
  resolveThresholds,
} from "@facetdb/core";
import type { ProjectConfig, SourceConfig } from "../../config/index.ts";
import { engineFor, openConnector, requireUsableUrl } from "../engines.ts";
import {
  CliError,
  defineCommand,
  EXIT_USAGE,
  likelyYes,
  type OpenStore,
  percent,
} from "../program.ts";
import { requireUsableStoreUrl, storeSharedFor, storeSourceId } from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  engineTarget,
  loadProjectConfig,
  projectRef,
  savedQuestionSets,
  singleTarget,
  sourceUrlOf,
} from "./database.ts";

/**
 * `facetdb explain <source> <key>`: one record's full history, oldest first, in words. Each model
 * answer and each human decision is shown with the wording and thresholds of the question-set
 * version it ran under, read from the store's saved versions, never from today's config: the
 * history says what was asked then. The record as it stands now is its connector's `current`: the
 * engine's for a table source, the store's for an API source. It writes nothing; the decision log
 * is append-only.
 */

type ExplainOptions = {
  readonly config: string;
  readonly allowInsecure?: boolean;
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

/** `YYYY-MM-DD HH:MM`, in UTC, so the same history reads the same on every machine. */
function when(at: Date): string {
  return at.toISOString().slice(0, 16).replace("T", " ");
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

/**
 * The record as its connector's `current` holds it now, in words: each question's decision, or
 * "not answered" while it holds none (not answered yet, or waiting for a person).
 */
async function currentState(
  connector: Pick<Connector, "current">,
  questions: readonly Question[],
  key: string,
  where: string,
): Promise<CurrentState> {
  let current: CurrentDecision | undefined;
  try {
    current = (await connector.current([key])).get(key);
  } catch (cause) {
    throw new CliError(
      "row-read",
      `the record's current state could not be read from ${where}: ${cause instanceof Error ? cause.message : String(cause)}`,
      "run facetdb doctor to check the connection and the login's permissions",
    );
  }
  if (current === undefined) {
    return { found: false, values: {} };
  }
  const values: Record<string, string> = {};
  for (const question of questions) {
    const decision = current.decisions[question.name];
    values[question.name] =
      decision === undefined
        ? "not answered"
        : typeof decision.value === "boolean"
          ? yesNo(decision.value)
          : decision.value;
  }
  return { found: true, status: current.status, reviewed: current.reviewed, values };
}

/** A table source as explain reads it: its engine, its target and the worker login's URL. */
type TableRead = {
  readonly engine: DatabaseEngine;
  readonly target: EngineTarget;
  readonly url: string;
  /** `schema.table`, what a failure to read it names. */
  readonly label: string;
};

/** The table source's engine, target and URL; its URL refused before anything connects. */
async function tableRead(
  entries: Parameters<typeof engineFor>[0],
  config: ProjectConfig,
  source: SourceConfig,
  project: ReturnType<typeof projectRef>,
  allowInsecure: boolean,
): Promise<TableRead> {
  const table = singleTarget(config, source.name);
  const url = sourceUrlOf(
    source,
    `the connection string of the database that holds ${table.table}`,
  );
  const engine = await engineFor(entries, url, source.connector);
  const target = engineTarget(config, table, project);
  requireUsableUrl(engine, target, url, allowInsecure);
  return { engine, target, url, label: `${table.schema}.${table.table}` };
}

/** The record now: its table's FacetDB columns through its engine, or its row in the store. */
async function readCurrent(
  store: OpenStore,
  table: TableRead | undefined,
  source: SourceConfig,
  key: string,
  deps: Pick<EngineDeps, "clock" | "allowInsecure" | "storeShared">,
  sourceId: string,
): Promise<CurrentState> {
  const workerId = `explain-${randomUUID()}`;
  if (table === undefined) {
    const connector = store.connector({ sourceId, fields: source.read, workerId });
    return currentState(connector, source.questions, key, "the FacetDB store");
  }
  const connector = await openConnector(table.engine, table.target, table.url, {
    ...deps,
    workerId,
  });
  try {
    return await currentState(connector, source.questions, key, table.label);
  } finally {
    await connector.close();
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
    ALLOW_INSECURE_OPTION,
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
    // Before any connection: the store's, then the source's own (a table source's current state is
    // read from its database with the worker login, through its engine).
    const allowInsecure = options.allowInsecure === true;
    requireUsableStoreUrl(url, allowInsecure, deps.env["PGHOST"]);
    const project = projectRef(deps.projectDir);
    const table =
      source.table === undefined
        ? undefined
        : await tableRead(deps.engines, config, source, project, allowInsecure);
    const store = await deps.store({ allowInsecure });
    const sourceId = storeSourceId(project.id, source.name);
    let history: readonly LogEntry[];
    let state: CurrentState | undefined;
    try {
      history = await store.log(sourceId).history(key);
      if (history.length > 0) {
        state = await readCurrent(
          store,
          table,
          source,
          key,
          { clock: deps.clock, allowInsecure, storeShared: storeSharedFor(deps.env, source) },
          sourceId,
        );
      }
    } finally {
      await store.close();
    }
    if (state === undefined) {
      print(
        `FacetDB has no history for record ${key} of "${source.name}".\n` +
          `Is the source right? The sources in the config are: ${config.sources.map((candidate) => candidate.name).join(", ")}.\n` +
          "Has the worker run? Start it with facetdb worker, or answer existing rows with facetdb backfill. Then check the key: it is the table's primary key, as text.",
      );
      return { ok: true, source: source.name, key, entries: [] };
    }

    const versions = await savedQuestionSets(deps, url, sourceId, [
      ...new Set(history.map((entry) => entry.version)),
    ]);
    const entries = history.map((entry) =>
      entry.kind === "answer"
        ? explainAnswer(entry, versions.get(entry.version))
        : explainHuman(entry, versions.get(entry.version)),
    );

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
