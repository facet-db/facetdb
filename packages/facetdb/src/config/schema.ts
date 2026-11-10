import { type QuestionSet, questionSetSchema } from "@facetdb/core";
import { z } from "zod";
import type { ActionCall, ProjectConfig, SourceConfig } from "./dsl.ts";

/**
 * The config boundary: the one schema that judges a project, whether it came from
 * `facetdb.config.ts` or from the dashboard's JSON. It reuses core's question-set schema for the
 * questions, thresholds, `read`, `where` and `model` of each source, so the rules for those live
 * in one place, and only adds what a project file has on top: sources, actions and alerts.
 */

export type ConfigIssue = {
  /** Where the problem is, as written in the file: `sources[0].questions.urgency.levels`. */
  readonly path: string;
  /** What is wrong and what to do about it, in plain words. */
  readonly message: string;
};

export type ConfigParseResult =
  | { readonly ok: true; readonly config: ProjectConfig }
  | { readonly ok: false; readonly issues: readonly ConfigIssue[] };

export class ConfigError extends Error {
  readonly issues: readonly ConfigIssue[];

  constructor(issues: readonly ConfigIssue[], origin?: string) {
    const lines = issues.map((issue) =>
      issue.path === "" ? issue.message : `${issue.path}: ${issue.message}`,
    );
    const heading = origin === undefined ? "The config has problems:" : `${origin} has problems:`;
    super([heading, ...lines.map((line) => `  - ${line}`)].join("\n"));
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export function formatPath(path: readonly PropertyKey[]): string {
  let text = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      text += `[${segment}]`;
    } else {
      text += text === "" ? String(segment) : `.${String(segment)}`;
    }
  }
  return text;
}

/**
 * Key names that hold secrets by convention. `auth` only as a word (auth, authToken, basicAuth,
 * authorization, authentication), so "author" is not one. What this cannot catch: a secret under
 * a neutral name with no shape of its own; the `…Env` convention is the defence there, and the
 * refusal messages say so.
 */
const SECRET_WORDS = /key|secret|password|token|credential|bearer/i;
const AUTH_KEY = /^auth$|^auth[A-Z_0-9]|^authoriz|^authentic|Auth$|Auth[A-Z_0-9]/;
const isSecretKey = (key: string): boolean => SECRET_WORDS.test(key) || AUTH_KEY.test(key);

/** What a key ending in "Env" may hold: the name of an environment variable, never its value. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ENV_NAME_RULE =
  "must name an environment variable (uppercase letters, digits and underscores, such as SLACK_TOKEN), never hold the value itself: this file and its JSON export carry no secret";

/** A URL with a username or password in it carries a credential, which this file never does. */
function hasUrlCredential(text: string): boolean {
  try {
    const url = new URL(text);
    return url.username !== "" || url.password !== "";
  } catch {
    return false;
  }
}

/**
 * Incoming-webhook URLs that are bearer secrets by themselves (no username or password, so only
 * the host tells). The list is the known services; any other bearer URL cannot be told from a
 * plain URL by shape, and the `…Env` convention is the defence there.
 */
const BEARER_WEBHOOK_PREFIXES = [
  "hooks.slack.com/services/",
  "hooks.slack.com/workflows/",
  "discord.com/api/webhooks/",
  "discordapp.com/api/webhooks/",
  "canary.discord.com/api/webhooks/",
  "ptb.discord.com/api/webhooks/",
  "outlook.office.com/webhook/",
  "hooks.zapier.com/hooks/catch/",
];
/** Teams' current webhooks live on a per-tenant host: `<tenant>.webhook.office.com/webhookb2/`. */
const BEARER_WEBHOOK_HOST_SUFFIX = ".webhook.office.com";

function isBearerWebhook(text: string): boolean {
  try {
    const url = new URL(text);
    const at = `${url.host}${url.pathname}`;
    return (
      BEARER_WEBHOOK_PREFIXES.some((prefix) => at.startsWith(prefix)) ||
      (url.host.endsWith(BEARER_WEBHOOK_HOST_SUFFIX) && url.pathname.startsWith("/webhookb2/"))
    );
  } catch {
    return false;
  }
}

type SecretKind = "secret" | "env-literal" | "url-credential" | "bearer-url";

type SecretProblem = {
  readonly path: readonly (string | number)[];
  readonly kind: SecretKind;
};

/** Whether a string value is a secret by its shape: a URL credential, or a known bearer webhook. */
function stringSecretKind(value: string): SecretKind | undefined {
  if (hasUrlCredential(value)) {
    return "url-credential";
  }
  if (isBearerWebhook(value)) {
    return "bearer-url";
  }
  return undefined;
}

/**
 * Inside an action's config: every key that looks like it holds a secret (it would be exported
 * verbatim into the project JSON), and every key ending in "Env" whose value is not an environment
 * variable name (a literal such as "xoxb-…" would be exported just the same).
 */
function secretProblems(value: unknown, path: readonly (string | number)[] = []): SecretProblem[] {
  if (typeof value === "string") {
    // A string anywhere, an array item included, is judged by its shape.
    const kind = stringSecretKind(value);
    return kind === undefined ? [] : [{ path, kind }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => secretProblems(item, [...path, index]));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]): SecretProblem[] => {
    const here = [...path, key];
    if (key.endsWith("Env")) {
      return typeof item === "string" && ENV_NAME.test(item)
        ? []
        : [{ path: here, kind: "env-literal" }];
    }
    if (isSecretKey(key)) {
      return [{ path: here, kind: "secret" }];
    }
    return secretProblems(item, here);
  });
}

function secretMessage(key: string, kind: SecretKind): string {
  switch (kind) {
    case "secret":
      return `"${key}" looks like a secret, and secrets never go in this file or its JSON export. Put the secret in an environment variable and name the variable here under a key ending in "Env", such as tokenEnv: "SLACK_TOKEN".`;
    case "env-literal":
      return `"${key}" ${ENV_NAME_RULE}.`;
    case "url-credential":
      return `"${key}" is a URL with a username or password in it, and this file and its JSON export carry no credential. Put the credential in an environment variable and name it under a key ending in "Env".`;
    case "bearer-url":
      return `"${key}" is an incoming-webhook URL that acts as a secret by itself, and this file and its JSON export carry no secret. Put the URL in an environment variable and name it under a key ending in "Env", such as webhookUrlEnv: "SLACK_WEBHOOK".`;
  }
}

/** An object that refuses unknown keys, saying which are known and where secrets belong. */
function strict<T extends z.ZodRawShape>(shape: T) {
  const known = Object.keys(shape).join(", ");
  return z.strictObject(shape, {
    error: (issue) => {
      if (issue.code !== "unrecognized_keys") {
        return undefined;
      }
      const keys = issue.keys.map((key) => `"${key}"`).join(", ");
      const secrets = issue.keys.some((key) => isSecretKey(key))
        ? " Secrets never go in this file: the model key is TYPESAFE_API_KEY, the store key FACETDB_SECRET and the API key FACETDB_API_KEY, all read from the environment."
        : "";
      return `unknown setting ${keys}; the settings here are ${known}.${secrets}`;
    },
  });
}

const identifier = (what: string) =>
  z
    .string()
    .regex(
      /^[a-z][a-z0-9_]*$/,
      `${what} must be lowercase letters, digits and underscores, starting with a letter`,
    );

const channelAddress = z
  .string()
  .regex(
    /^[a-z][a-z0-9-]*:\S.*$/,
    'an alert channel is written as "<channel>:<where>", such as "slack:#ops" or "email:ops@example.com"',
  )
  .refine((address) => stringSecretKind(address.slice(address.indexOf(":") + 1)) === undefined, {
    message:
      'an alert channel names where to post ("slack:#ops"), never a webhook URL or a credential: this file and its JSON export carry no secret. The channel plugin reads its webhook or token from the environment.',
  });

// Plugin names: `@facetdb/<name>` first-party, `facetdb-plugin-<name>` community.
const pluginName = z
  .string()
  .regex(
    /^(@facetdb\/[a-z0-9][a-z0-9-]*|facetdb-plugin-[a-z0-9][a-z0-9-]*)$/,
    'a plugin is named "@facetdb/<name>" or "facetdb-plugin-<name>"',
  );

const actionSchema = strict({
  plugin: pluginName,
  action: z.string().regex(/^[a-z][A-Za-z0-9]*$/, "an action name is camelCase, such as notify"),
  config: z
    .record(z.string(), z.json())
    .superRefine((config, context) => {
      for (const { path, kind } of secretProblems(config)) {
        context.addIssue({
          code: "custom",
          path: [...path],
          message: secretMessage(String(path[path.length - 1]), kind),
        });
      }
    })
    .default({}),
});

const sourceSchema = strict({
  name: identifier("a source name"),
  api: z.boolean().default(false),
  database: z.string().min(1).exactOptional(),
  databaseEnv: z.string().regex(ENV_NAME, `databaseEnv ${ENV_NAME_RULE}`).exactOptional(),
  table: z.string().min(1, "table must not be empty").exactOptional(),
  // The rest of the question-set fields are judged by core's schema, per source, below.
  where: z.unknown().optional(),
  read: z.unknown().optional(),
  storage: z
    .enum(["inline", "side-table"], { error: 'storage must be "inline" or "side-table"' })
    .default("inline"),
  onChange: z
    .enum(["reset", "keep"], { error: 'onChange must be "reset" or "keep"' })
    .default("reset"),
  onOutage: z
    .enum(["hold", "release"], { error: 'onOutage must be "hold" or "release"' })
    .default("hold"),
  maxStateTokens: z
    .number()
    .int("maxStateTokens must be a whole number")
    .positive("maxStateTokens must be more than 0")
    .exactOptional(),
  questions: z.unknown().optional(),
  thresholds: z.unknown().optional(),
  actions: z.array(actionSchema).default([]),
  model: z.unknown().optional(),
}).superRefine((source, context) => {
  // The free-text fields a source carries are exported too: judged by shape like any other string.
  for (const field of ["table", "where"] as const) {
    const value = source[field];
    const kind = typeof value === "string" ? stringSecretKind(value) : undefined;
    if (kind !== undefined) {
      context.addIssue({ code: "custom", path: [field], message: secretMessage(field, kind) });
    }
  }
});

const projectSchema = strict({
  model: z.unknown().optional(),
  modelUrl: z
    .string()
    .regex(/^https?:\/\/\S+$/, "modelUrl must be a base URL starting with http:// or https://")
    .refine(
      (url) => !hasUrlCredential(url),
      "modelUrl never carries a username or password: this file and its JSON export carry no credential; a gateway key is read from the environment",
    )
    .exactOptional(),
  alerts: strict({
    channels: z.array(channelAddress).min(1, "alerts.channels needs at least one channel"),
  }).exactOptional(),
  spendingCap: z
    .number()
    .int("spendingCap must be a whole number of billable input tokens")
    .positive("spendingCap must be more than 0")
    .exactOptional(),
  onCapReached: z
    .enum(["pause", "continue"], { error: 'onCapReached must be "pause" or "continue"' })
    .default("pause"),
  sources: z.array(sourceSchema).min(1, "a project needs at least one source"),
});

type ParsedProject = z.infer<typeof projectSchema>;
type ParsedSource = ParsedProject["sources"][number];

function issuesOf(error: z.ZodError, prefix: readonly PropertyKey[] = []): ConfigIssue[] {
  return error.issues.map((issue) => ({
    path: formatPath([...prefix, ...issue.path]),
    message: issue.message,
  }));
}

function sourceStructureIssues(source: ParsedSource, at: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (source.api) {
    for (const field of ["table", "where", "database", "databaseEnv"] as const) {
      if (source[field] !== undefined) {
        issues.push({
          path: `${at}.${field}`,
          message: `an API source has no ${field}: your code sends its records to /v1/check; remove ${field}, or drop api: true to read a table`,
        });
      }
    }
    if (source.storage === "side-table") {
      issues.push({
        path: `${at}.storage`,
        message:
          "an API source keeps its answers in the FacetDB store; remove storage, or drop api: true to read a table",
      });
    }
    return issues;
  }
  if (source.table === undefined) {
    issues.push({
      path: `${at}.table`,
      message:
        'a source reads a table: add table: "<name>", or add api: true if your code sends the records',
    });
  }
  if (source.database === undefined && source.databaseEnv === undefined) {
    issues.push({
      path: `${at}.database`,
      message:
        "no connection string: the environment variable this reads is not set; set it (for example DATABASE_URL) and run again",
    });
  }
  return issues;
}

/** The core question-set input of one source: what core's schema judges. */
function questionSetInput(source: ParsedSource, projectModel: unknown): Record<string, unknown> {
  const questions = source.questions;
  return {
    questions,
    read: source.read,
    model: source.model ?? projectModel,
    thresholds: source.thresholds ?? {},
    ...(source.where === undefined ? {} : { where: source.where }),
  };
}

/** Remaps core's `questions[1].levels` to the file's `sources[0].questions.urgency.levels`. */
function remapQuestionSetIssues(
  found: readonly z.core.$ZodIssue[],
  index: number,
  source: ParsedSource,
  projectModelDeclaredHere: boolean,
): ConfigIssue[] {
  const at = `sources[${index}]`;
  const questions = Array.isArray(source.questions) ? (source.questions as unknown[]) : [];
  return found.map((issue) => {
    const [head, second, ...rest] = issue.path;
    if (head === "model" && !projectModelDeclaredHere) {
      return { path: "model", message: issue.message };
    }
    if (head === "questions" && typeof second === "number") {
      const named = questions[second];
      const name =
        typeof named === "object" &&
        named !== null &&
        "name" in named &&
        typeof named.name === "string"
          ? named.name
          : String(second);
      return { path: formatPath([at, "questions", name, ...rest]), message: issue.message };
    }
    return { path: formatPath([at, ...issue.path]), message: issue.message };
  });
}

function conditionIssues(
  actions: readonly ActionCall[],
  questionNames: readonly string[],
  at: string,
): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  actions.forEach((action, actionIndex) => {
    const when = action.config["when"];
    if (typeof when !== "object" || when === null || Array.isArray(when)) {
      return;
    }
    for (const key of Object.keys(when)) {
      const [name, measure] = key.split(".");
      const known =
        key === "status" ||
        (name !== undefined &&
          questionNames.includes(name) &&
          (measure === undefined || measure === "probability" || measure === "confidence"));
      if (!known) {
        issues.push({
          path: `${at}.actions[${actionIndex}].when.${key}`,
          message: `"${key}" is not a question of this source; a condition names a question (${questionNames.join(", ")}) or status`,
        });
      }
    }
  });
  return issues;
}

/** One table is exactly one source: the same table behind the same connection may appear once. */
function duplicateIssues(sources: readonly ParsedSource[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const names = new Map<string, number>();
  const tables = new Map<string, number>();
  sources.forEach((source, index) => {
    const firstName = names.get(source.name);
    if (firstName === undefined) {
      names.set(source.name, index);
    } else {
      issues.push({
        path: `sources[${index}].name`,
        message: `the name "${source.name}" is already used by sources[${firstName}]; give each source its own name`,
      });
    }
    if (source.api || source.table === undefined) {
      return;
    }
    const key = `${source.database ?? source.databaseEnv ?? ""}\u0000${source.table}`;
    const first = tables.get(key);
    if (first === undefined) {
      tables.set(key, index);
    } else {
      issues.push({
        path: `sources[${index}].table`,
        message: `the table "${source.table}" is already the source "${sources[first]?.name}"; one table is exactly one source, so put its questions in that source`,
      });
    }
  });
  return issues;
}

function sourceConfig(
  source: ParsedSource,
  questionSet: QuestionSet,
  projectModel: string,
): SourceConfig {
  return {
    name: source.name,
    api: source.api,
    ...(source.database === undefined ? {} : { database: source.database }),
    ...(source.databaseEnv === undefined ? {} : { databaseEnv: source.databaseEnv }),
    ...(source.table === undefined ? {} : { table: source.table }),
    ...(questionSet.where === undefined ? {} : { where: questionSet.where }),
    read: questionSet.read,
    storage: source.storage,
    onChange: source.onChange,
    onOutage: source.onOutage,
    ...(source.maxStateTokens === undefined ? {} : { maxStateTokens: source.maxStateTokens }),
    questions: questionSet.questions,
    thresholds: questionSet.thresholds,
    actions: source.actions,
    ...(questionSet.model === projectModel ? {} : { model: questionSet.model }),
  };
}

/** Judges a project from any origin and reports every problem with its path, not just the first. */
export function parseProjectConfig(input: unknown): ConfigParseResult {
  const shape = projectSchema.safeParse(input);
  if (!shape.success) {
    return { ok: false, issues: issuesOf(shape.error) };
  }
  const project = shape.data;
  const issues: ConfigIssue[] = [];
  const projectModel = project.model;
  if (typeof projectModel !== "string") {
    issues.push({
      path: "model",
      message: 'model is required: pin an exact version such as model: "jev-1.14.0"',
    });
  }

  const sets: (QuestionSet | undefined)[] = [];
  project.sources.forEach((source, index) => {
    const at = `sources[${index}]`;
    issues.push(...sourceStructureIssues(source, at));
    const parsed = questionSetSchema.safeParse(questionSetInput(source, projectModel));
    if (parsed.success) {
      sets.push(parsed.data);
      issues.push(
        ...conditionIssues(
          source.actions,
          parsed.data.questions.map((question) => question.name),
          at,
        ),
      );
    } else {
      sets.push(undefined);
      const declaredHere = source.model !== undefined;
      // A missing or non-text project model is already reported once, at `model`.
      const own = parsed.error.issues.filter(
        (issue) => issue.path[0] !== "model" || declaredHere || typeof projectModel === "string",
      );
      issues.push(...remapQuestionSetIssues(own, index, source, declaredHere));
    }
  });
  issues.push(...duplicateIssues(project.sources));

  // A project model that is wrong is reported once, however many sources inherit it.
  const seen = new Set<string>();
  const unique = issues.filter((issue) => {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  if (unique.length > 0 || typeof projectModel !== "string") {
    return { ok: false, issues: unique };
  }

  const sources = project.sources.map((source, index) => {
    const set = sets[index];
    if (set === undefined) {
      throw new Error("unreachable: every source parsed when no issue was reported");
    }
    return sourceConfig(source, set, projectModel);
  });
  return {
    ok: true,
    config: {
      model: projectModel,
      ...(project.modelUrl === undefined ? {} : { modelUrl: project.modelUrl }),
      ...(project.alerts === undefined ? {} : { alerts: project.alerts }),
      ...(project.spendingCap === undefined ? {} : { spendingCap: project.spendingCap }),
      onCapReached: project.onCapReached,
      sources,
    },
  };
}
