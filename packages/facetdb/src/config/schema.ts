import {
  PLUGIN_ENTRY_NAME,
  type Question,
  type QuestionSet,
  questionSetSchema,
  RECORD_STATUSES,
} from "@facetdb/core";
import { z } from "zod";
import {
  type ActionCall,
  type AlertChannel,
  isEnvReference,
  type ProjectConfig,
  type SourceConfig,
} from "./dsl.ts";
import { providerIssues } from "./provider.ts";

/**
 * The config boundary: the one schema that judges a project, whether it came from
 * `facetdb.config.ts` or from the dashboard's JSON. It reuses core's question-set schema for the
 * questions, thresholds, `read`, `where` and `model` of each source, so the rules for those live in
 * one place, and only adds what a project file has on top: sources, actions and alerts.
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
 * Why `studioUrl` is refused, or undefined when it holds: an http or https address a browser opens,
 * with no credential, query, fragment or path. The words never carry the value, which may hold a
 * password.
 */
function studioUrlProblem(text: string): string | undefined {
  if (!/^https?:\/\//.test(text)) {
    return "studioUrl must be an address a browser opens, starting with http:// or https://, such as https://facetdb.example.com or http://127.0.0.1:4040";
  }
  // A backslash, a space, a control character and an invisible or direction-changing one are read
  // differently by a browser and by other parsers (`https://a.example\@b.example` is a.example to
  // one and b.example to another), and this address is sent to people in alerts.
  if (/[\\\s\p{Cc}\p{Cf}]/u.test(text) || !URL.canParse(text)) {
    return "studioUrl must be plain text a browser opens as written: remove any backslash, space, control or invisible character, and write it as https://host or https://host:port";
  }
  if (hasUrlCredential(text)) {
    return "studioUrl never carries a username or password: this file and its JSON export carry no credential; remove it from the address";
  }
  if (/[?#]/.test(text)) {
    return "studioUrl is the studio's address alone: remove everything from the ? or # on, because every link adds its own path";
  }
  if (new URL(text).pathname !== "/") {
    return "studioUrl is the address the studio is served at the root of, with no path: the studio loads its pages and files from /, so write https://host or https://host:port and put the studio at the root of that address";
  }
  return undefined;
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

/** `HH:MM` on a 24-hour clock: `22:00`, `07:30`. */
const CLOCK_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

const clockTime = (field: string) =>
  z
    .string({ error: `${field} is a time of day as "HH:MM" on a 24-hour clock, such as "22:00"` })
    .regex(CLOCK_TIME, `${field} is a time of day as "HH:MM" on a 24-hour clock, such as "22:00"`);

/** Whether the runtime knows `zone` as an IANA time zone (`Europe/Berlin`, `UTC`). */
function isTimeZone(zone: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(zone)) {
    return false;
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

// Parsed and carried; nothing holds messages in them yet.
const quietHours = strict({
  from: clockTime("quiet.from"),
  to: clockTime("quiet.to"),
  zone: z
    .string({ error: 'quiet.zone is a time zone name, such as "Europe/Berlin" or "UTC"' })
    .refine(
      isTimeZone,
      'quiet.zone is not a time zone this machine knows: write an IANA name such as "Europe/Berlin", "America/New_York" or "UTC"',
    )
    .exactOptional(),
}).refine((quiet) => quiet.from !== quiet.to, {
  message:
    "quiet.from and quiet.to are the same time, which makes quiet hours of no length: give two different times, or take quiet out",
});

const channelSends = z.enum(["critical", "warnings", "everything"], {
  error:
    'sends is "critical" (critical alerts only), "warnings" (critical alerts and warnings) or "everything" (the default)',
});

const alertChannelObject = strict({
  to: channelAddress,
  sends: channelSends.exactOptional(),
  quiet: quietHours.exactOptional(),
});

/**
 * One alert channel: an address, or `{ to, sends?, quiet? }`, kept in the form the file wrote. The
 * form is chosen by what the file wrote, so a refusal names the field that is wrong (a union would
 * say only that neither form fits).
 */
const alertChannel = z.unknown().transform((value, context): AlertChannel => {
  const schema =
    typeof value === "string"
      ? channelAddress
      : typeof value === "object" && value !== null && !Array.isArray(value)
        ? alertChannelObject
        : undefined;
  if (schema === undefined) {
    context.addIssue({
      code: "custom",
      message:
        'an alert channel is an address such as "slack:#ops", or { to: "slack:#ops", sends: "warnings", quiet: { from: "22:00", to: "07:00" } }',
    });
    return z.NEVER;
  }
  const result = schema.safeParse(value);
  if (!result.success) {
    for (const issue of result.error.issues) {
      context.addIssue({ code: "custom", message: issue.message, path: issue.path });
    }
    return z.NEVER;
  }
  return result.data;
});

const alertChannels = z
  .array(alertChannel)
  .min(1, "alerts.channels needs at least one channel")
  .superRefine((channels, context) => {
    // Each address once: one written twice would be sent every alert twice.
    const seen = new Set<string>();
    channels.forEach((channel, index) => {
      const address = typeof channel === "string" ? channel : channel.to;
      if (seen.has(address)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: `${address} is named twice: name each channel once, so it is sent each alert once`,
        });
      }
      seen.add(address);
    });
  });

// Plugin names: `@facetdb/<name>` first-party, `facetdb-plugin-<name>` community.
const pluginName = z
  .string()
  .regex(
    /^(@facetdb\/[a-z0-9][a-z0-9-]*|facetdb-plugin-[a-z0-9][a-z0-9-]*)$/,
    'a plugin is named "@facetdb/<name>" or "facetdb-plugin-<name>"',
  );

/**
 * A key of `plugins`, by the plugin loader's rule (`shortName` in plugin/define.ts): a short name
 * (`github`, which the loader finds as `@facetdb/github`, then `facetdb-plugin-github`) or one of
 * the two package names.
 */
const PLUGIN_KEY_RULE =
  'a plugin is named by its short name ("github") or its package name ("@facetdb/github" or "facetdb-plugin-github")';
const pluginKey = z
  .string()
  .regex(/^(?:@facetdb\/|facetdb-plugin-)?[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, PLUGIN_KEY_RULE);

type PluginSecretKind = SecretKind | "env-name";

type PluginSecretProblem = {
  readonly path: readonly (string | number)[];
  readonly kind: PluginSecretKind;
};

/**
 * A plugin setting's key that names a secret by a word of its own: `token`, `apiKey`,
 * `webhookSecret`, `password`, `auth`. "Key" alone is not one (`primaryKey`, `labelKeys`): plugin
 * settings name ordinary keys, and the plugin's own `z.secret()` fields are the real guard, judged
 * by the host once the plugin is loaded.
 */
const PLUGIN_SECRET_WORDS =
  /secret|password|passwd|token|credential|bearer|(?:api|access|private|signing|client|master|encryption)_?key/i;
const isPluginSecretKey = (key: string): boolean =>
  PLUGIN_SECRET_WORDS.test(key) || /^key$/i.test(key) || AUTH_KEY.test(key);

/**
 * Inside a plugin's settings, every value that would put a secret in this file or its JSON export:
 * text sitting directly under a key that names a secret (a number, a boolean, a list or an object
 * there is judged by its own contents, never by its parent's key), any text that is a URL carrying
 * a credential or a bearer webhook, a key ending in "Env" whose text is no variable's name, and an
 * `env(...)` whose name is not one. `env("NAME")` is the one way a secret is written, at any depth.
 *
 * Not the action config's walk (`secretProblems`) with an option: that one refuses any value under
 * a secret-looking key and has no `env(...)`; changing it would change what an action accepts.
 */
function pluginSecretProblems(
  value: unknown,
  path: readonly (string | number)[],
  secretKey: boolean,
): PluginSecretProblem[] {
  if (isEnvReference(value)) {
    return ENV_NAME.test(value.env) ? [] : [{ path, kind: "env-name" }];
  }
  if (typeof value === "string") {
    if (secretKey) {
      return [{ path, kind: "secret" }];
    }
    const kind = stringSecretKind(value);
    return kind === undefined ? [] : [{ path, kind }];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => pluginSecretProblems(item, [...path, index], false));
  }
  if (typeof value !== "object" || value === null) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]): PluginSecretProblem[] => {
    const here = [...path, key];
    if (key.endsWith("Env") && typeof item === "string") {
      return ENV_NAME.test(item) ? [] : [{ path: here, kind: "env-literal" }];
    }
    return pluginSecretProblems(item, here, isPluginSecretKey(key));
  });
}

/** `GITHUB_TOKEN` for the `token` of `github`: the variable a refusal suggests. */
export function suggestedVariable(plugin: string, key: string): string {
  const short = plugin.replace(/^@facetdb\/|^facetdb-plugin-/, "");
  return `${short}_${key}`
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
}

function pluginSecretMessage(plugin: string, key: string, kind: PluginSecretKind): string {
  const named = `${key}: env("${suggestedVariable(plugin, key)}")`;
  switch (kind) {
    case "secret":
      return `"${key}" looks like a secret, and secrets never go in this file or its JSON export. Put the secret in an environment variable and name the variable here: ${named}.`;
    case "url-credential":
      return `"${key}" is a URL with a username or password in it, and this file and its JSON export carry no credential. Put the URL in an environment variable and name the variable here: ${named}.`;
    case "bearer-url":
      return `"${key}" is an incoming-webhook URL that acts as a secret by itself, and this file and its JSON export carry no secret. Put the URL in an environment variable and name the variable here: ${named}.`;
    case "env-literal":
      return `"${key}" ${ENV_NAME_RULE}.`;
    case "env-name":
      return `env(...) ${ENV_NAME_RULE}.`;
  }
}

/** The setting a path ends at, for the words: the last key, not an array's position. */
function keyOf(plugin: string, path: readonly (string | number)[]): string {
  const key = [...path].reverse().find((step): step is string => typeof step === "string");
  return key ?? plugin;
}

// A plugin's settings live in the file, every secret a variable's name.
const pluginsSchema = z
  .record(
    pluginKey,
    z.record(z.string(), z.json(), {
      error:
        'a plugin\'s settings are an object of its fields, such as github: { repo: "acme/web", token: env("GITHUB_TOKEN") }',
    }),
    { error: (issue) => (issue.code === "invalid_key" ? PLUGIN_KEY_RULE : undefined) },
  )
  .superRefine((plugins, context) => {
    for (const [name, settings] of Object.entries(plugins)) {
      for (const { path, kind } of pluginSecretProblems(settings, [], false)) {
        context.addIssue({
          code: "custom",
          path: [name, ...path],
          message: pluginSecretMessage(name, keyOf(name, path), kind),
        });
      }
    }
  });

const actionSchema = strict({
  plugin: pluginName,
  // The rule a plugin names its actions by (`definePlugin`), so every name a plugin can have is one
  // the file can write: lowercase words joined by `_` or `-`.
  action: z
    .string()
    .regex(
      PLUGIN_ENTRY_NAME,
      "an action is named as its plugin names it: lowercase letters and digits, words joined by _ or -, such as notify or add_label",
    ),
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

/**
 * A plugin source as the file writes it: the plugin by its package name, as an action names one,
 * the source by the name its plugin gives it, and the settings of this use, judged for secrets by
 * the plugin settings' own rule: `env("NAME")` at any depth, and a secret always that. What the
 * settings must hold is the plugin's schema's to say, once the worker has loaded it.
 */
const sourceCallSchema = strict({
  plugin: pluginName,
  source: z
    .string()
    .regex(
      PLUGIN_ENTRY_NAME,
      "a source is named as its plugin names it: lowercase letters and digits, words joined by _ or -, such as issues",
    ),
  settings: z
    .record(z.string(), z.json(), {
      error:
        'a source\'s settings are an object of its fields, such as { repo: "acme/web", include: ["issues"] }',
    })
    .default({}),
}).superRefine((call, context) => {
  for (const { path, kind } of pluginSecretProblems(call.settings, [], false)) {
    context.addIssue({
      code: "custom",
      path: ["settings", ...path],
      message: pluginSecretMessage(call.plugin, keyOf(call.source, path), kind),
    });
  }
});

/** The schemes of a SQL Server connection string, the one database with Change Tracking (cli/engines.ts). */
const CHANGE_TRACKING_SCHEMES: ReadonlySet<string> = new Set(["mssql", "sqlserver"]);

/** `scheme:` at the start of a connection string (RFC 3986), as the CLI's engine table reads it. */
const URL_SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Why `capture: "change-tracking"` cannot be this source's, or undefined: it is SQL Server's own
 * change capture, so another database's connection string, or the polling connector, which scans
 * instead, refuses it here at the boundary rather than leaving the engine to ignore it. A source
 * loaded from the project JSON before its variable is set has no connection string to read yet; the
 * scheme is judged once it has.
 */
function captureIssue(source: {
  readonly capture?: "trigger" | "change-tracking";
  readonly connector?: "polling";
  readonly database?: string;
}): string | undefined {
  if (source.capture !== "change-tracking") {
    return undefined;
  }
  if (source.connector === "polling") {
    return 'capture: "change-tracking" is SQL Server\'s own way to notice changes, and connector: "polling" scans the table instead; remove one of them';
  }
  if (source.database === undefined) {
    return undefined;
  }
  const scheme = URL_SCHEME.exec(source.database.trim())?.[1]?.toLowerCase();
  if (scheme !== undefined && CHANGE_TRACKING_SCHEMES.has(scheme)) {
    return undefined;
  }
  const what =
    scheme === undefined ? "names no scheme (a file path)" : `is a ${scheme}: connection string`;
  return `capture: "change-tracking" is SQL Server's Change Tracking, and this source's connection string ${what}; remove capture (that database is watched by its trigger), or point the source at a SQL Server with an mssql: or sqlserver: connection string`;
}

/**
 * A column's name as `lastChanged` takes it: an identifier of the source's database, in any case
 * (Oracle keeps unquoted names in capitals), never empty and never SQL. The polling engine quotes
 * it, and refuses it at migrate when the table has no such column.
 */
const COLUMN_NAME = /^[A-Za-z_][A-Za-z0-9_$]*$/;

const LAST_CHANGED_RULE =
  'lastChanged names the column the application sets on every insert and every update, such as "changed_on" (letters, digits, underscores and dollar signs, starting with a letter or an underscore), or is false to read the whole table every hour; for a column named otherwise, rename the column, or write lastChanged: false for the hourly scan';

// "Using a last-changed column; without one, a full scan every hour".
const lastChangedSchema = z
  .union([z.literal(false), z.string()], { error: LAST_CHANGED_RULE })
  .refine((value) => value === false || COLUMN_NAME.test(value), { error: LAST_CHANGED_RULE });

const sourceSchema = strict({
  name: identifier("a source name"),
  api: z.boolean().default(false),
  database: z.string().min(1).exactOptional(),
  // The name `env("X")` carries (the DSL puts it here); judged below, so the issue points at the
  // field the file writes: `database`.
  databaseEnv: z.string().exactOptional(),
  // The scheme picks the engine, this overrides it.
  connector: z
    .enum(["polling"], {
      error:
        'connector must be "polling" (watch the table by scanning, for a host that forbids triggers), or left out so the connection string\'s scheme picks the database',
    })
    .exactOptional(),
  // SQL Server's "trigger and facetdb_jobs table, or Change Tracking".
  capture: z
    .enum(["trigger", "change-tracking"], {
      error:
        'capture must be "trigger" (the default) or "change-tracking" (SQL Server only: watch the table without a trigger)',
    })
    .exactOptional(),
  lastChanged: lastChangedSchema.exactOptional(),
  source: sourceCallSchema.exactOptional(),
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
  if (source.databaseEnv !== undefined && !ENV_NAME.test(source.databaseEnv)) {
    context.addIssue({
      code: "custom",
      path: ["database"],
      message: `env(...) ${ENV_NAME_RULE}`,
    });
  }
  const capture = captureIssue(source);
  if (capture !== undefined) {
    context.addIssue({ code: "custom", path: ["capture"], message: capture });
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
  studioUrl: z
    .string({
      error:
        'studioUrl is text: the address people open the studio at, such as "https://facetdb.example.com"',
    })
    .superRefine((url, context) => {
      const problem = studioUrlProblem(url);
      if (problem !== undefined) {
        context.addIssue({ code: "custom", message: problem });
      }
    })
    .exactOptional(),
  provider: z
    .string({ error: 'provider is text: a preset such as "openrouter", or "<plugin>/<entry>"' })
    .exactOptional(),
  alerts: strict({ channels: alertChannels }).exactOptional(),
  spendingCap: z
    .number()
    .int("spendingCap must be a whole number of billable input tokens")
    .positive("spendingCap must be more than 0")
    .exactOptional(),
  onCapReached: z
    .enum(["pause", "continue"], { error: 'onCapReached must be "pause" or "continue"' })
    .default("pause"),
  plugins: pluginsSchema.exactOptional(),
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

/** The fields of a table source that a plugin or API source never has; `databaseEnv` is written `database`. */
const TABLE_FIELDS = [
  "table",
  "where",
  "database",
  "databaseEnv",
  "connector",
  "capture",
  "lastChanged",
] as const;

function sourceStructureIssues(source: ParsedSource, at: string): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  if (source.source !== undefined) {
    // A plugin source: its records come from the plugin, and they and their answers are kept in the
    // FacetDB store, so nothing of a table or of the check API belongs beside it.
    const plugin = `the plugin ${source.source.plugin}`;
    for (const field of TABLE_FIELDS) {
      if (source[field] !== undefined) {
        const written = field === "databaseEnv" ? "database" : field;
        issues.push({
          path: `${at}.${written}`,
          message: `a plugin source has no ${written}: ${plugin} reads its records; remove ${written}, or remove source to read a table`,
        });
      }
    }
    if (source.api) {
      issues.push({
        path: `${at}.api`,
        message: `a source is read by a plugin or sent by your code, not both: remove api: true to let ${plugin} read it, or remove source to send the records to /v1/check`,
      });
    }
    if (source.storage === "side-table") {
      issues.push({
        path: `${at}.storage`,
        message: `a plugin source keeps its answers in the FacetDB store; remove storage, or remove source to read a table`,
      });
    }
    return issues;
  }
  if (source.api) {
    for (const field of [
      "table",
      "where",
      "database",
      "databaseEnv",
      "connector",
      "capture",
      "lastChanged",
    ] as const) {
      if (source[field] !== undefined) {
        // The file writes database: env("X"); databaseEnv is the loader's name for it.
        const written = field === "databaseEnv" ? "database" : field;
        issues.push({
          path: `${at}.${written}`,
          message: `an API source has no ${written}: your code sends its records to /v1/check; remove ${written}, or drop api: true to read a table`,
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
        'a source reads a table: add table: "<name>", add api: true if your code sends the records, or add source: <plugin>.<source>({ ... }) for a plugin to read them',
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

/** A JSON value that is an object (not an array, not null). */
function isPlainObject(value: unknown): value is { readonly [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The values a question equals when decided: yes or no, an option's name, a level's name. */
function decidedValues(question: Question): readonly (boolean | string)[] {
  switch (question.type) {
    case "noul":
      return [true, false];
    case "choice":
      return question.options.map((option) => option.name);
    case "score":
      return question.levels.map((level) => level.name);
  }
}

/** What a question's term must equal, in words: `true or false`, `"low", "high"`. */
function valuesWords(question: Question): string {
  return question.type === "noul"
    ? "true or false"
    : decidedValues(question)
        .map((value) => JSON.stringify(value))
        .join(", ");
}

/**
 * Why one term of a `when` cannot hold as written, or undefined: a question equals one of its
 * decided values, `status` a record status, and `<question>.probability` or `.confidence` is `{
 * atLeast: n }` with n from 0 to 1.
 */
function termProblem(
  key: string,
  value: unknown,
  questions: readonly Question[],
): string | undefined {
  if (key === "status") {
    return typeof value === "string" && (RECORD_STATUSES as readonly string[]).includes(value)
      ? undefined
      : `status is compared with a record status: one of ${RECORD_STATUSES.map((status) => JSON.stringify(status)).join(", ")}`;
  }
  const [name, measure] = key.split(".");
  const question = questions.find((candidate) => candidate.name === name);
  if (question === undefined) {
    return undefined;
  }
  if (measure !== undefined) {
    const atLeast = isPlainObject(value) ? value["atLeast"] : undefined;
    const valid =
      isPlainObject(value) &&
      Object.keys(value).length === 1 &&
      typeof atLeast === "number" &&
      atLeast >= 0 &&
      atLeast <= 1;
    return valid
      ? undefined
      : `a ${measure} test is { atLeast: n } with n a number from 0 to 1, such as { atLeast: 0.9 }`;
  }
  return decidedValues(question).some((decided) => decided === value)
    ? undefined
    : `${name} is a ${question.type} question, so the condition compares it with ${valuesWords(question)}`;
}

function conditionIssues(
  actions: readonly ActionCall[],
  questions: readonly Question[],
  at: string,
): ConfigIssue[] {
  const questionNames = questions.map((question) => question.name);
  const issues: ConfigIssue[] = [];
  actions.forEach((action, actionIndex) => {
    const where = `${at}.actions[${actionIndex}]`;
    const otherwise = action.config["else"];
    if (otherwise !== undefined && !isPlainObject(otherwise)) {
      issues.push({
        path: `${where}.else`,
        message:
          'else is an object of the action\'s settings to use when the condition does not hold, such as else: { remove: ["Not Priority"] }',
      });
    }
    const when = action.config["when"];
    if (when === undefined) {
      return;
    }
    if (!isPlainObject(when)) {
      issues.push({
        path: `${where}.when`,
        message:
          'when is an object of conditions that must all hold, such as when: { not_priority: true } or when: { status: "needs_review" }',
      });
      return;
    }
    for (const [key, value] of Object.entries(when)) {
      const [name, measure] = key.split(".");
      const known =
        key === "status" ||
        (name !== undefined &&
          questionNames.includes(name) &&
          (measure === undefined || measure === "probability" || measure === "confidence"));
      if (!known) {
        issues.push({
          path: `${where}.when.${key}`,
          message: `"${key}" is not a question of this source; a condition names a question (${questionNames.join(", ")}) or status`,
        });
        continue;
      }
      const problem = termProblem(key, value, questions);
      if (problem !== undefined) {
        issues.push({ path: `${where}.when.${key}`, message: problem });
      }
    }
  });
  return issues;
}

/** One table is exactly one source: the same table behind the same connection may appear once. */
function duplicateIssues(sources: readonly ParsedSource[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const names = new Map<string, number>();
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
  });
  return [...issues, ...duplicateTableIssues(sources)];
}

/** What the one-table-one-source check reads of a source: a table source's database and table. */
type TableIdentity = {
  readonly name: string;
  readonly api?: boolean | undefined;
  readonly table?: string | undefined;
  readonly database?: string | undefined;
  readonly databaseEnv?: string | undefined;
};

/**
 * One table is exactly one source. The schema keys a source by its connection string, or by the
 * variable's name where the file wrote env("X") and no string is known yet, so the loader runs this
 * again once it has read every variable: two names over one database and one table are one table
 * twice, and only the values say so.
 */
export function duplicateTableIssues(sources: readonly TableIdentity[]): ConfigIssue[] {
  const issues: ConfigIssue[] = [];
  const tables = new Map<string, number>();
  sources.forEach((source, index) => {
    if (source.api === true || source.table === undefined) {
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
    ...(source.connector === undefined ? {} : { connector: source.connector }),
    ...(source.capture === undefined ? {} : { capture: source.capture }),
    ...(source.lastChanged === undefined ? {} : { lastChanged: source.lastChanged }),
    ...(source.source === undefined
      ? {}
      : {
          source: {
            ...source.source,
            settings: source.source.settings as NonNullable<SourceConfig["source"]>["settings"],
          },
        }),
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

  if (project.provider !== undefined) {
    issues.push(...providerIssues(project.provider, project.modelUrl));
  }

  const sets: (QuestionSet | undefined)[] = [];
  project.sources.forEach((source, index) => {
    const at = `sources[${index}]`;
    issues.push(...sourceStructureIssues(source, at));
    const parsed = questionSetSchema.safeParse(questionSetInput(source, projectModel));
    if (parsed.success) {
      sets.push(parsed.data);
      issues.push(...conditionIssues(source.actions, parsed.data.questions, at));
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
      ...(project.provider === undefined ? {} : { provider: project.provider }),
      ...(project.studioUrl === undefined ? {} : { studioUrl: project.studioUrl }),
      ...(project.alerts === undefined ? {} : { alerts: project.alerts }),
      ...(project.spendingCap === undefined ? {} : { spendingCap: project.spendingCap }),
      onCapReached: project.onCapReached,
      ...(project.plugins === undefined
        ? {}
        : { plugins: project.plugins as NonNullable<ProjectConfig["plugins"]> }),
      sources,
    },
  };
}
