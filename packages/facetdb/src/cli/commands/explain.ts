import { randomUUID } from "node:crypto";
import {
  type Connector,
  type CurrentDecision,
  type DatabaseEngine,
  type EngineDeps,
  type EngineTarget,
  type ExplainedEntry,
  explainHistory,
  type LogEntry,
  type Question,
} from "@facetdb/core";
import type { ProjectConfig, SourceConfig } from "../../config/index.ts";
import { keyWords, openConnector, requireUsableUrl, tableKeyText } from "../engines.ts";
import { CliError, defineCommand, EXIT_USAGE, type OpenStore } from "../program.ts";
import { requireUsableStoreUrl, storeSharedFor, storeSourceId } from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  loadProjectConfig,
  projectRef,
  reachedOf,
  savedQuestionSets,
  singleTarget,
  sourceTable,
} from "./database.ts";

/**
 * `facetdb explain <source> <key>`: one record's full history, oldest first, in words. Each model
 * answer and each human decision is shown with the wording and thresholds of the question-set
 * version it ran under, read from the store's saved versions, never from today's config: the
 * history says what was asked then. The record as it stands now is its connector's `current`: the
 * engine's for a table source, the store's for an API source. It writes nothing; the decision log
 * is append-only. The key is taken and printed as the user writes it: through the engine's
 * `keyText` where its keys carry a type tag (MongoDB: `explain listings 1` reads the key `n:1`), in
 * the `_id` type the collection's marker records (`explain listings 1001` reads the string "1001"),
 * as typed everywhere else.
 */

type ExplainOptions = {
  readonly config: string;
  readonly allowInsecure?: boolean;
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
  /** The table as its engine names it, what a failure to read it names. */
  readonly label: string;
};

/** The table source's engine, target and URL; its URL refused before anything connects. */
async function tableRead(
  deps: Parameters<typeof sourceTable>[0],
  config: ProjectConfig,
  source: SourceConfig,
  allowInsecure: boolean,
): Promise<TableRead> {
  const target = singleTarget(config, source.name);
  const table = await sourceTable(deps, config, target);
  const { engine, url } = reachedOf(
    table,
    source,
    `the connection string of the database that holds ${target.table}`,
  );
  requireUsableUrl(engine, table.own, url, allowInsecure);
  return { engine, target: table.own, url, label: table.label };
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
    const [sourceName, typed] = args;
    if (sourceName === undefined || typed === undefined) {
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
        `Dry run: would read the history of record ${typed} of ${source.name} from the FacetDB store. Nothing is written by explain, with or without --dry-run.`,
      );
      return { ok: true, dryRun: true, source: source.name, key: typed };
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
      source.table === undefined ? undefined : await tableRead(deps, config, source, allowInsecure);
    // The key as the store and the connector hold it, read from the key as the user wrote it; and
    // the form every line prints it in (MongoDB: `1` for `n:1`, the hex for `oid:<hex>`; `1001` for
    // the string "1001" where the collection's marker records string `_id`s).
    const keyText =
      table === undefined
        ? undefined
        : await tableKeyText(table.engine, table.target, table.url, allowInsecure);
    const key = keyText === undefined ? typed : keyText.fromText(typed);
    const shown = keyWords(keyText, key);
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
        `FacetDB has no history for record ${shown} of "${source.name}".\n` +
          `Is the source right? The sources in the config are: ${config.sources.map((candidate) => candidate.name).join(", ")}.\n` +
          `Has the worker run? Start it with facetdb worker, or answer existing rows with facetdb backfill. Then check the key: it is ${keyText?.form ?? "the table's primary key, as text"}.`,
      );
      return { ok: true, source: source.name, key: shown, entries: [] };
    }

    const versions = await savedQuestionSets(deps, url, sourceId, [
      ...new Set(history.map((entry) => entry.version)),
    ]);
    // The same function GET /v1/decisions/:source/:key answers with.
    const entries = explainHistory(history, versions);

    print(`History of record ${shown} of "${source.name}", oldest first:`);
    for (const entry of entries) {
      for (const line of lineOf(entry)) {
        print(line);
      }
    }
    print(stateLine(state));
    return { ok: true, source: source.name, key: shown, entries, current: state };
  },
});
