import type { Question, ThresholdOverride } from "@facetdb/core";
import type { ActionCall, OnCapReached, ProjectConfig, SourceConfig, StorageMode } from "./dsl.ts";
import { ConfigError, type ConfigIssue, parseProjectConfig } from "./schema.ts";

/**
 * The project JSON: what the dashboard reads and exports, and what imports back without loss. It
 * differs from the config file in the ways a file can not be shipped around: a connection string
 * is never in it (a source names the environment variable it comes from), and an action is its
 * plugin name and arguments, not a call.
 */

type QuestionJson = Omit<Question, "name">;

export type SourceJson = {
  readonly name: string;
  readonly api: boolean;
  readonly database?: { readonly env: string };
  readonly table?: string;
  readonly where?: string;
  readonly read: readonly string[];
  readonly storage: StorageMode;
  readonly onChange: SourceConfig["onChange"];
  readonly onOutage: SourceConfig["onOutage"];
  readonly maxStateTokens?: number;
  readonly questions: { readonly [name: string]: QuestionJson };
  readonly thresholds: { readonly [question: string]: ThresholdOverride };
  readonly actions: readonly ActionCall[];
  readonly model?: string;
};

export type ProjectJson = {
  readonly model: string;
  readonly modelUrl?: string;
  readonly alerts?: { readonly channels: readonly string[] };
  readonly spendingCap?: number;
  readonly onCapReached: OnCapReached;
  readonly sources: readonly SourceJson[];
};

function questionJson(question: Question): QuestionJson {
  const { name: _name, ...rest } = question;
  return rest;
}

function sourceJson(source: SourceConfig): SourceJson {
  if (source.database !== undefined && source.databaseEnv === undefined) {
    throw new Error(
      `Source "${source.name}" holds a connection string but not the environment variable it came from, and an export must never carry the string. Load the config with loadConfig, which records the variable.`,
    );
  }
  return {
    name: source.name,
    api: source.api,
    ...(source.databaseEnv === undefined ? {} : { database: { env: source.databaseEnv } }),
    ...(source.table === undefined ? {} : { table: source.table }),
    ...(source.where === undefined ? {} : { where: source.where }),
    read: source.read,
    storage: source.storage,
    onChange: source.onChange,
    onOutage: source.onOutage,
    ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
    questions: Object.fromEntries(
      source.questions.map((question) => [question.name, questionJson(question)]),
    ),
    thresholds: source.thresholds,
    actions: source.actions,
    ...(source.model === undefined ? {} : { model: source.model }),
  };
}

export function toProjectJson(config: ProjectConfig): ProjectJson {
  return {
    model: config.model,
    ...(config.modelUrl === undefined ? {} : { modelUrl: config.modelUrl }),
    ...(config.alerts === undefined ? {} : { alerts: config.alerts }),
    ...(config.spendingCap === undefined ? {} : { spendingCap: config.spendingCap }),
    onCapReached: config.onCapReached,
    sources: config.sources.map(sourceJson),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Turns the JSON's shape back into the config's, leaving every judgement to the schema. */
function sourceInput(
  raw: unknown,
  index: number,
  env: Readonly<Record<string, string | undefined>>,
  issues: ConfigIssue[],
): unknown {
  if (!isRecord(raw)) {
    return raw;
  }
  const { database, questions, ...rest } = raw;
  const converted: Record<string, unknown> = { ...rest };
  if (database !== undefined) {
    const variable = isRecord(database) ? database["env"] : undefined;
    if (typeof variable === "string" && Object.keys(database as object).length === 1) {
      converted["databaseEnv"] = variable;
      const value = env[variable];
      if (value !== undefined && value !== "") {
        converted["database"] = value;
      }
    } else {
      issues.push({
        path: `sources[${index}].database`,
        message:
          'a connection string never goes in the project JSON; write { "env": "DATABASE_URL" } and set the variable',
      });
    }
  }
  if (isRecord(questions)) {
    converted["questions"] = Object.entries(questions).map(([name, question]) =>
      isRecord(question) ? { ...question, name } : question,
    );
  } else {
    issues.push({
      path: `sources[${index}].questions`,
      message: "questions is an object of question name to question; add at least one question",
    });
  }
  return converted;
}

/**
 * Reads a project JSON into a project config, or throws a ConfigError naming every problem with its
 * path. A source's connection string is looked up in `env` by the variable the JSON names; a variable
 * that is not set leaves the source without a connection until one is.
 */
export function fromProjectJson(
  json: unknown,
  env: Readonly<Record<string, string | undefined>> = {},
): ProjectConfig {
  const issues: ConfigIssue[] = [];
  let input = json;
  const listed = isRecord(json) ? json["sources"] : undefined;
  if (isRecord(json) && Array.isArray(listed)) {
    input = {
      ...json,
      sources: listed.map((source, index) => sourceInput(source, index, env, issues)),
    };
  }
  const parsed = parseProjectConfig(input);
  if (issues.length > 0 || !parsed.ok) {
    throw new ConfigError([...issues, ...(parsed.ok ? [] : parsed.issues)], "The project JSON");
  }
  return parsed.config;
}

const text = (value: unknown): string => JSON.stringify(value);

function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line, i) => (i === 0 || line === "" ? line : pad + line))
    .join("\n");
}

function options(parts: readonly (string | undefined)[]): string {
  const present = parts.filter((part): part is string => part !== undefined);
  return present.length === 0 ? "" : `, { ${present.join(", ")} }`;
}

function questionSource(question: Question): string {
  const stakes = question.stakes === "low" ? undefined : `stakes: ${text(question.stakes)}`;
  if (question.type === "noul") {
    const criteria =
      question.criteria === undefined ? undefined : `criteria: ${text(question.criteria)}`;
    return `noul(${text(question.instructions)}${options([stakes, criteria])})`;
  }
  if (question.type === "choice") {
    const probabilities = question.storeProbabilities ? "storeProbabilities: true" : undefined;
    const listed = question.options.some((option) => /^\d+$/.test(option.name));
    const body = listed
      ? text(question.options)
      : `{ ${question.options.map((option) => `${text(option.name)}: ${text(option.description)}`).join(", ")} }`;
    return `choice(${text(question.instructions)}, ${body}${options([stakes, probabilities])})`;
  }
  const levels = question.levels.some((level) => level.description !== undefined)
    ? text(question.levels)
    : `[${question.levels.map((level) => text(level.name)).join(", ")}]`;
  return `score(${text(question.instructions)}, ${levels}${options([stakes])})`;
}

function sourceSource(source: SourceConfig): string {
  const fields: string[] = [`name: ${text(source.name)}`];
  if (source.api) {
    fields.push("api: true");
  } else {
    fields.push(`database: process.env.${source.databaseEnv ?? "DATABASE_URL"}`);
    fields.push(`table: ${text(source.table)}`);
  }
  if (source.where !== undefined) fields.push(`where: ${text(source.where)}`);
  fields.push(`read: ${text(source.read)}`);
  if (source.storage !== "inline") fields.push(`storage: ${text(source.storage)}`);
  if (source.onChange !== "reset") fields.push(`onChange: ${text(source.onChange)}`);
  if (source.onOutage !== "hold") fields.push(`onOutage: ${text(source.onOutage)}`);
  if (source.maxStateTokens !== undefined) fields.push(`maxStateTokens: ${source.maxStateTokens}`);
  if (source.model !== undefined) fields.push(`model: ${text(source.model)}`);
  const questions = source.questions
    .map((question) => `${text(question.name)}: ${questionSource(question)},`)
    .join("\n");
  fields.push(`questions: {\n${indent(questions, 2).replace(/^/, "  ")}\n}`);
  if (Object.keys(source.thresholds).length > 0) {
    fields.push(`thresholds: ${text(source.thresholds)}`);
  }
  if (source.actions.length > 0) {
    const calls = source.actions.map(
      (action) =>
        `actionCall(${text(action.plugin)}, ${text(action.action)}, ${text(action.config)}),`,
    );
    fields.push(`actions: [\n${indent(calls.join("\n"), 2).replace(/^/, "  ")}\n]`);
  }
  return `{\n${fields.map((field) => `  ${indent(field, 2)},`).join("\n")}\n}`;
}

/**
 * Writes the config file that loads to this project: what "export as a config file" hands a
 * developer. Actions come out as `actionCall("<plugin>", "<action>", {...})`, which needs no plugin
 * package to be installed to load.
 */
export function configFileSource(config: ProjectConfig): string {
  const used = new Set<string>(["facetdb"]);
  for (const source of config.sources) {
    if (source.actions.length > 0) used.add("actionCall");
    for (const question of source.questions) used.add(question.type);
  }
  const head: string[] = [`model: ${text(config.model)}`];
  if (config.modelUrl !== undefined) head.push(`modelUrl: ${text(config.modelUrl)}`);
  if (config.alerts !== undefined) head.push(`alerts: ${text(config.alerts)}`);
  if (config.spendingCap !== undefined) head.push(`spendingCap: ${config.spendingCap}`);
  if (config.onCapReached !== "pause") head.push(`onCapReached: ${text(config.onCapReached)}`);
  const sources = config.sources.map((source) => `${indent(sourceSource(source), 2)},`);
  head.push(`sources: [\n${sources.map((source) => `  ${source}`).join("\n")}\n]`);
  return [
    `import { ${[...used].sort().join(", ")} } from "facetdb";`,
    "",
    "export default facetdb({",
    ...head.map((field) => `  ${indent(field, 2)},`),
    "});",
    "",
  ].join("\n");
}
