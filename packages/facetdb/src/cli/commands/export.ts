import {
  type Answer,
  type AnswerEntry,
  choiceConfidence,
  type Decision,
  decide,
  type HumanEntry,
  type LogEntry,
  type Question,
  type QuestionSet,
  resolveThresholds,
} from "@facetdb/core";
import { keyTextFor, keyWords } from "../engines.ts";
import { CliError, defineCommand, EXIT_USAGE } from "../program.ts";
import { requireUsableStoreUrl, storeSourceId } from "../store-door.ts";
import {
  ALLOW_INSECURE_OPTION,
  loadProjectConfig,
  projectRef,
  savedQuestionSets,
  variableOf,
} from "./database.ts";

/**
 * `facetdb export --source <name>`: a source's whole decision log as JSONL or CSV, oldest first, so
 * the promise that the answers are yours is kept by a command and not by a mirror. It reads the
 * FacetDB store only, a page at a time, never the source's own database; nothing is written but the
 * file `--out` names.
 */

const FORMATS = ["jsonl", "csv"] as const;

/** Log rows read per query: a log of any size is never one unbounded read. */
export const EXPORT_PAGE_SIZE = 500;

type ExportOptions = {
  readonly config: string;
  readonly source?: string;
  readonly format: string;
  readonly out?: string;
  readonly allowInsecure?: boolean;
};

/** The question sets of the versions the log mentions; a version the store does not keep is absent. */
type Versions = ReadonlyMap<number, QuestionSet>;

/** What one answer to one question comes to, in the columns the export has. */
type Reading = {
  /** The option or level the model named; empty for a noul, whose answer is the probability. */
  readonly value: string;
  readonly probability: number | null;
  readonly confidence: number | null;
  /** What the thresholds of that version made of it: "yes", "no", a name, "needs review", or "". */
  readonly decision: string;
};

function questionOf(set: QuestionSet | undefined, name: string): Question | undefined {
  return set?.questions.find((candidate) => candidate.name === name);
}

function decisionWords(decision: Decision): string {
  if (decision.kind === "needs_review") {
    return "needs review";
  }
  return typeof decision.value === "boolean" ? (decision.value ? "yes" : "no") : decision.value;
}

function readAnswer(set: QuestionSet | undefined, name: string, answer: Answer): Reading {
  const question = questionOf(set, name);
  const decision =
    question === undefined || set === undefined
      ? ""
      : decisionWords(decide(question, resolveThresholds(question, set.thresholds[name]), answer));
  switch (answer.type) {
    case "noul":
      return { value: "", probability: answer.probability, confidence: null, decision };
    case "choice":
      return {
        value: answer.top,
        probability: Math.max(...answer.probabilities),
        confidence: choiceConfidence(answer.probabilities),
        decision,
      };
    case "score": {
      const top = answer.probabilities.indexOf(Math.max(...answer.probabilities));
      return {
        value: question?.type === "score" ? (question.levels[top]?.name ?? "") : "",
        probability: Math.max(...answer.probabilities),
        confidence: answer.confidence,
        decision,
      };
    }
  }
}

/**
 * A row's answers in the order the question set of its version declares them (the store keeps them
 * as jsonb, which does not), so the same log exports the same lines every time; a question that
 * version does not name goes last, by name.
 */
function answersInOrder(entry: AnswerEntry, set: QuestionSet | undefined): [string, Answer][] {
  const position = (name: string) => {
    const at = set?.questions.findIndex((question) => question.name === name) ?? -1;
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  return Object.entries(entry.answers).sort(([a], [b]) => {
    const byPosition = position(a) - position(b);
    return byPosition !== 0 ? byPosition : a.localeCompare(b);
  });
}

function humanWords(entry: HumanEntry): string {
  return typeof entry.value === "boolean" ? (entry.value ? "yes" : "no") : entry.value;
}

/** A log row's key as the user writes it: the engine's form (MongoDB's `_id`), else the key. */
type KeyShown = (key: string) => string;

/** One JSON object per log row, the answers nested per question. */
function jsonOf(entry: LogEntry, versions: Versions, shown: KeyShown): string {
  const common = {
    time: entry.at.toISOString(),
    kind: entry.kind,
    record_key: shown(entry.key),
    version: entry.version,
    state_hash: entry.stateHash,
  };
  if (entry.kind === "human") {
    return JSON.stringify({
      ...common,
      question: entry.question,
      value: humanWords(entry),
      decision: humanWords(entry),
      decided_by: entry.reviewer,
      ...(entry.note === undefined ? {} : { note: entry.note }),
    });
  }
  const set = versions.get(entry.version);
  const answers = Object.fromEntries(
    answersInOrder(entry, set).map(([name, answer]) => [
      name,
      { ...answer, ...readAnswer(set, name, answer) },
    ]),
  );
  return JSON.stringify({ ...common, model: entry.model, answers });
}

export const CSV_COLUMNS = [
  "time",
  "kind",
  "record_key",
  "version",
  "model",
  "question",
  "value",
  "probability",
  "confidence",
  "decision",
  "decided_by",
] as const;

/** RFC 4180: a field with a quote, a comma or a line break is quoted, and its quotes are doubled. */
function csvField(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function csvLine(fields: readonly (string | number | null)[]): string {
  return `${fields.map(csvField).join(",")}\r\n`;
}

/** One line per question per log row. */
function csvOf(entry: LogEntry, versions: Versions, shown: KeyShown): string[] {
  const time = entry.at.toISOString();
  if (entry.kind === "human") {
    return [
      csvLine([
        time,
        entry.kind,
        shown(entry.key),
        entry.version,
        "",
        entry.question,
        humanWords(entry),
        null,
        null,
        humanWords(entry),
        entry.reviewer,
      ]),
    ];
  }
  const set = versions.get(entry.version);
  return answersInOrder(entry, set).map(([name, answer]) => {
    const reading = readAnswer(set, name, answer);
    return csvLine([
      time,
      entry.kind,
      shown(entry.key),
      entry.version,
      entry.model,
      name,
      reading.value,
      reading.probability,
      reading.confidence,
      reading.decision,
      "",
    ]);
  });
}

function plural(count: number, one: string, many: string): string {
  return `${count.toLocaleString("en-US")} ${count === 1 ? one : many}`;
}

export const exportCommand = defineCommand<ExportOptions>("export", {
  description:
    "Writes a source's whole decision log, oldest first, as JSONL or CSV: every answer and every human decision",
  options: [
    {
      flags: "--config <path>",
      description: "the config file",
      defaultValue: "facetdb.config.ts",
    },
    { flags: "--source <name>", description: "the source whose log to write" },
    {
      flags: "--format <format>",
      description: "jsonl (one object per log row) or csv (one line per question per log row)",
      defaultValue: "jsonl",
    },
    { flags: "--out <file>", description: "write to this file instead of the terminal" },
    ALLOW_INSECURE_OPTION,
  ],
  run: async ({ options, deps, print }) => {
    const format = FORMATS.find((candidate) => candidate === options.format);
    if (format === undefined) {
      throw new CliError(
        "usage",
        `"${options.format}" is not a format export writes`,
        `pass --format jsonl or --format csv`,
        EXIT_USAGE,
      );
    }
    const config = await loadProjectConfig(deps, options.config);
    const names = config.sources.map((candidate) => candidate.name).join(", ");
    if (options.source === undefined) {
      throw new CliError(
        "usage",
        "export needs the source whose log to write",
        `run facetdb export --source <name>; the sources in the config are: ${names}`,
        EXIT_USAGE,
      );
    }
    const source = config.sources.find((candidate) => candidate.name === options.source);
    if (source === undefined) {
      throw new CliError(
        "unknown-source",
        `the config has no source named "${options.source}"`,
        `pass one of: ${names}`,
        EXIT_USAGE,
      );
    }
    // --json is the result on stdout; the rows would be mixed into it, so they need a file.
    if (options.json && options.out === undefined) {
      throw new CliError(
        "usage",
        "--json prints the count of exported rows, and the rows themselves would share its output",
        "add --out <file> to write the rows to a file, or drop --json to get them on the terminal",
        EXIT_USAGE,
      );
    }

    const url = deps.env["DATABASE_URL"];
    if (url === undefined || url === "") {
      throw new CliError(
        "database-url",
        "DATABASE_URL is not set, so FacetDB has no store to read the log from",
        "set DATABASE_URL to the connection string of the database FacetDB keeps its store in",
      );
    }
    // The store only: the log is never read from, nor needs, the source's own database.
    const allowInsecure = options.allowInsecure === true;
    requireUsableStoreUrl(url, allowInsecure, deps.env["PGHOST"]);
    // The key column as the user writes the key: the store keeps MongoDB's tagged key, `n:1`, and
    // the export says `1`, as `explain` reads it. The engine is found, never opened.
    const keyText = await keyTextFor(deps.engines, source);
    const shown: KeyShown = (key) => keyWords(keyText, key);
    // Without the source's connection string its engine is unknown here: say which form the keys
    // take, so the two forms are never told apart in silence (stderr: stdout may be the data).
    if (source.table !== undefined && (source.database ?? "") === "") {
      const variable = variableOf(source);
      deps.io.stderr(
        `note: ${variable} is not set here, so export cannot tell which database "${source.name}" is on and writes each record_key as the FacetDB store keeps it: the same as you type it on every database but MongoDB, whose keys then read oid:<hex> and n:<number>. Set ${variable} to export MongoDB keys as you write them.\n`,
      );
    }

    const store = await deps.store({ allowInsecure });
    // The log is kept under the project-scoped id, never the bare source name.
    const sourceId = storeSourceId(projectRef(deps.projectDir).id, source.name);
    const log = store.log(sourceId);
    const versions = new Map<number, QuestionSet>();
    const asked = new Set<number>();
    let rows = 0;
    const chunks: string[] = [];
    // Rows go to the terminal as each page arrives; a file is written once, when the log is read.
    const emit = (text: string) => {
      if (options.out === undefined) {
        deps.io.stdout(text);
      } else {
        chunks.push(text);
      }
    };
    try {
      if (format === "csv" && !options.dryRun) {
        emit(csvLine(CSV_COLUMNS));
      }
      let after: number | undefined;
      do {
        const page = await log.page(after, EXPORT_PAGE_SIZE);
        rows += page.entries.length;
        if (!options.dryRun) {
          // Each version is read from the store once, however many pages mention it.
          const missing = [
            ...new Set(page.entries.map((entry) => entry.version).filter((v) => !asked.has(v))),
          ];
          for (const [version, set] of await savedQuestionSets(deps, url, sourceId, missing)) {
            versions.set(version, set);
          }
          for (const version of missing) {
            asked.add(version);
          }
          for (const entry of page.entries) {
            if (format === "csv") {
              for (const line of csvOf(entry, versions, shown)) {
                emit(line);
              }
            } else {
              emit(`${jsonOf(entry, versions, shown)}\n`);
            }
          }
        }
        after = page.next;
      } while (after !== undefined);
    } finally {
      await store.close();
    }

    const counted = plural(rows, "log row", "log rows");
    const where = options.out ?? "the terminal";
    if (options.dryRun) {
      print(
        `Dry run: would write ${counted} of "${source.name}" as ${format} to ${where}. Nothing is written by export, with or without --dry-run, except the file --out names.`,
      );
      return { ok: true, dryRun: true, source: source.name, format, rows };
    }
    if (options.out !== undefined) {
      await deps.workspace.write(options.out, chunks.join(""), { overwrite: true });
      print(`Wrote ${counted} of "${source.name}" as ${format} to ${options.out}.`);
    } else if (rows === 0) {
      // Not on stdout: that is the data. A pipe still gets what it asked for, and this says why it is empty.
      deps.io.stderr(
        `FacetDB has no log for "${source.name}" yet. Has the worker run? Start it with facetdb worker, or answer existing rows with facetdb backfill.\n`,
      );
    }
    return {
      ok: true,
      source: source.name,
      format,
      rows,
      ...(options.out !== undefined ? { out: options.out } : {}),
    };
  },
});
