import {
  type ActionCondition,
  type ActionDecisions,
  type ActionInvocation,
  ActionNotQueued,
  type ActionRecord,
  type ActionStep,
  type AnswerEntry,
  answeredSet,
  type Connector,
  configureAction,
  type Decision,
  type DecisionLog,
  decideRecord,
  type LogEntry,
  type QuestionSet,
  RECORD_STATUSES,
  type RecordStatus,
  statusOf,
} from "@facetdb/core";
import {
  type ActionClose,
  type ActionDefer,
  type ActionDelivery,
  ActionFailed,
  CREDENTIAL_WORDS_WITHHELD,
} from "@facetdb/server";
import { ZodObject, type ZodType, z } from "zod";
import {
  type ActionCall,
  formatPath,
  isEnvReference,
  type JsonValue,
  type ProjectConfig,
  type SourceConfig,
  suggestedVariable,
} from "../config/index.ts";
import {
  isWebhookSend,
  type SourceWebhooks,
  WEBHOOK_ACTION,
  WEBHOOK_CHANNEL,
  WEBHOOK_PLUGIN,
  webhookStep,
} from "./builtin/webhook.ts";
import { firstPartyCredentialRefused, firstPartyFailure, handedValues } from "./channel-host.ts";
import { shortName } from "./define.ts";
import {
  type HostedPlugin,
  type HostedVariable,
  type PluginHost,
  PluginHostError,
  resolved,
  secretPlaces,
  startsWith,
} from "./host.ts";
import { type ActionContext, type ActionDefinition, NOTIFY_ACTION } from "./kinds.ts";
import {
  checkNotify,
  type NotifyDeps,
  notifyQueueing,
  payloadCondition,
  providesChannel,
  sendNotification,
} from "./notify.ts";
import { secretPaths } from "./zod.ts";

/**
 * The action host: a source's `actions` as the worker and a review run them. Each action is one
 * step, in the file's order, built with core's `configureAction`, so its `when` and `else` are
 * judged the way the pipeline judges them; a step runs nothing itself, it queues one outbox row
 * holding the decision and the settings as `when` and `else` resolved them, never anything of the
 * record's state, and never a variable's value: a setting read from a variable is queued as the
 * file writes it, `{ env: "NAME" }`, and read when the row is delivered. The runner the outbox
 * calls for that row reads the record through the source's connector at delivery and hands it to
 * the plugin's own `run`.
 */

/** One use of an action's settings as the file writes them: JSON, `when` and `else` left out. */
type Settings = { readonly [key: string]: JsonValue };

/** The environment the worker runs in: an action's settings may name a variable of it. */
type Env = Readonly<Record<string, string | undefined>>;

/** What an action's row carries: the decision it was queued for, and the settings that apply. */
export type ActionPayload = {
  readonly status: RecordStatus;
  /** The time of the log entry behind the decision, ISO 8601: what the plugin is told. */
  readonly decidedAt: string;
  /**
   * The hash of the state the decision was made at: with the decisions, it names the decision,
   * so the runner can tell whether it is still the record's. A hash, never the state.
   */
  readonly stateHash: string;
  readonly decisions: ActionDecisions;
  /** As the file writes them, a variable as `{ env: "NAME" }`: never a variable's value. */
  readonly settings: Settings;
};

/** One row a step queues: the record by its key alone, the action, its place and the payload. */
export type QueuedAction = {
  readonly recordKey: string;
  /** As the config names it: `@facetdb/github`. */
  readonly plugin: string;
  readonly action: string;
  /** Its place in the source's `actions`, from 0. */
  readonly position: number;
  /** A notification's: the batch the outbox's digest rule counts it in. */
  readonly batchKey?: string;
  readonly payload: ActionPayload & {
    /** A notification's: the condition it was queued under, which its words name. */
    readonly condition?: ActionCondition;
  };
};

/** Where an action is written in the file: `sources[0].actions[1]`. */
function placeOf(sourceIndex: number, position: number): string {
  return `sources[${sourceIndex}].actions[${position}]`;
}

/** The plugin a call names, as the host loaded it; refuses in words when it was not loaded. */
function hostedOf(host: PluginHost, call: ActionCall, where: string): HostedPlugin {
  const hosted = host.plugin(call.plugin);
  if (hosted === undefined) {
    // The host loads every plugin the config names when the worker starts; one named only since
    // (a reload after the file changed) is not loaded until the worker starts again.
    throw new PluginHostError(
      "plugin-not-installed",
      `${where}.plugin names the plugin "${call.plugin}", which this worker did not load when it started`,
      "restart facetdb worker so it loads the plugin, after installing it with facetdb add if it is not installed",
    );
  }
  return hosted;
}

/** The plugin's action a call names; refuses in words when the plugin does not provide it. */
function entryOf(host: PluginHost, call: ActionCall, where: string): ActionDefinition<unknown> {
  const hosted = hostedOf(host, call, where);
  const entry = Object.hasOwn(hosted.plugin.actions, call.action)
    ? hosted.plugin.actions[call.action]
    : undefined;
  if (entry === undefined) {
    const names = Object.keys(hosted.plugin.actions);
    throw new PluginHostError(
      "plugin-no-action",
      `${where}.action is "${call.action}", but the plugin "${hosted.packageName}" has no action of that name: ${
        names.length === 0 ? "it provides no action" : `its actions are ${names.join(", ")}`
      }`,
      names.length === 0
        ? `take ${where} out of the config, or use a plugin that provides the action`
        : `change ${where}.action to one of ${names.join(", ")}`,
    );
  }
  return entry;
}

/** The settings without `when` and `else`, and the `else` as written (an object: the schema says). */
function splitSettings(call: ActionCall): {
  readonly own: Settings;
  readonly otherwise: Settings | undefined;
} {
  const { when: _when, else: otherwise, ...own } = call.config;
  return { own, otherwise: otherwise as Settings | undefined };
}

/** One variable a setting reads: where, inside the action's (or a source's) settings, and its name. */
export type Variable = { readonly path: readonly (string | number)[]; readonly variable: string };

/** Every `env("NAME")` in an action's (or a source's) settings, at any depth. */
export function variablesIn(value: unknown, path: readonly (string | number)[] = []): Variable[] {
  if (isEnvReference(value)) {
    return [{ path, variable: value.env }];
  }
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).flatMap((item, index) =>
      variablesIn(item, [...path, index]),
    );
  }
  if (typeof value === "object" && value !== null) {
    return Object.entries(value).flatMap(([key, item]) => variablesIn(item, [...path, key]));
  }
  return [];
}

/** The variables' names for a sentence, each once: `HOOK_URL and OTHER_URL`. */
export function listed(variables: readonly Variable[]): string {
  return [...new Set(variables.map(({ variable }) => variable))].join(" and ");
}

/**
 * The schema's refusal of one value, as lines under `base`; a schema that throws is one line. A
 * reason may quote what it was given, so where a variable fed the value (at the issue's path,
 * inside it or around it) only the variable's name is said, as the plugin host does. `whose` names
 * the schema in the words: an action's, or a source's.
 */
export function refusals(
  entry: { readonly config: ZodType },
  value: unknown,
  base: string,
  variables: readonly Variable[],
  whose: "action" | "source" = "action",
): string[] {
  let parsed: ReturnType<typeof entry.config.safeParse>;
  try {
    parsed = entry.config.safeParse(value);
  } catch {
    // A transform or a refine that throws is the plugin's fault: none of its words are kept.
    return [
      `${base}: the ${whose}'s schema failed while it read these settings, instead of refusing a value in words`,
    ];
  }
  if (parsed.success) {
    return [];
  }
  return parsed.error.issues.map((issue) => {
    const path = issue.path as (string | number)[];
    const fed = variables.filter(
      (entry) => startsWith(entry.path, path) || startsWith(path, entry.path),
    );
    return fed.length === 0
      ? `${formatPath([base, ...path])}: ${issue.message}`
      : `${formatPath([base, ...path])}: the value of ${listed(fed)} is refused by the ${whose}'s schema (its reason is not shown, as it could quote the value)`;
  });
}

/** The paths of the action's schema that hold a secret (`z.secret()`); refuses one it cannot walk. */
function secretsOf(entry: ActionDefinition<unknown>, call: ActionCall, where: string): string[] {
  return schemaSecrets(entry.config, `${where} (${call.plugin} ${call.action})`, "action");
}

/**
 * The paths of a settings schema that hold a secret (`z.secret()`), none for a schema that is not
 * an object; refuses, in words naming `what`, a schema the walker cannot read.
 */
export function schemaSecrets(
  schema: ZodType | undefined,
  what: string,
  whose: "action" | "source",
): string[] {
  if (!(schema instanceof ZodObject)) {
    return [];
  }
  try {
    return [...secretPaths(schema)];
  } catch (error) {
    throw new PluginHostError(
      whose === "action" ? "action-settings" : "source-settings",
      `the settings schema of ${what} cannot be read for the secrets it holds: ${error instanceof Error ? error.message : String(error)}`,
      `install a version of the plugin whose ${whose} schema FacetDB can read, or ask its author to fix it`,
    );
  }
}

/**
 * Checks one action as the config names it: its plugin provides the action; no secret of the
 * action's schema is written into the file (a variable's name is, `env("NAME")`); every variable
 * its settings name is set; its settings (the config without `when` and `else`), with each
 * variable read, pass the action's schema; and its `else` names only settings of that schema and
 * passes it laid over them. Throws the refusal in words with its fix, never a variable's value.
 */
function checkAction(host: PluginHost, call: ActionCall, where: string, env: Env): void {
  // `notify` is FacetDB's own on every plugin with a channel, checked against it.
  if (call.action === NOTIFY_ACTION) {
    checkNotify(host, hostedOf(host, call, where), call, where, env);
    return;
  }
  const entry = entryOf(host, call, where);
  const { own, otherwise } = splitSettings(call);
  // The built-in webhook's step queues its endpoint row at the decision, its address in the row
  // (`actionSteps`), so the address is written in the file: a variable would be queued unread.
  const fed = isWebhookSend(call) ? [...variablesIn(own), ...variablesIn(otherwise ?? {})] : [];
  if (fed.length > 0) {
    throw new PluginHostError(
      "action-settings",
      `${where} (${call.plugin} ${call.action}) reads ${listed(fed)} from the environment, but ${ADDRESS_WORDS}`,
      `write the address in ${where}: webhook({ url: "https://hooks.example.com/facetdb" })`,
    );
  }
  const patterns = secretsOf(entry, call, where);
  for (const [base, settings] of [
    [where, own],
    [`${where}.else`, otherwise ?? {}],
  ] as const) {
    const literal = secretPlaces(settings, patterns).find(
      (place) => typeof place.value === "string" || typeof place.value === "number",
    );
    if (literal !== undefined) {
      const field = String(
        [...literal.path].reverse().find((step) => typeof step === "string") ?? call.action,
      );
      const variable = suggestedVariable(shortName(call.plugin) ?? call.plugin, field);
      throw new PluginHostError(
        "plugin-secret-literal",
        `${formatPath([base, ...literal.path])} is a secret of the action ${call.plugin} ${call.action} written into the config file, and secrets never go in this file, its JSON export or a queued action`,
        `put it in an environment variable and name the variable there: ${field}: env("${variable}"), then set ${variable} where the worker runs`,
      );
    }
  }
  const merged = { ...own, ...(otherwise ?? {}) };
  const unset = [...variablesIn(own), ...variablesIn(otherwise ?? {})].filter(
    ({ variable }) => env[variable] === undefined || env[variable] === "",
  );
  if (unset.length > 0) {
    throw new PluginHostError(
      "plugin-variable-unset",
      `${where} (${call.plugin} ${call.action}) cannot run: ${unset
        .map(
          ({ variable, path }) =>
            `${variable} is not set (${formatPath([where, ...path])} reads it)`,
        )
        .join("; ")}`,
      `set ${listed(unset)} where the worker runs, then start it again`,
    );
  }
  const lines = refusals(entry, resolved(own, env), where, variablesIn(own));
  if (otherwise !== undefined) {
    // `definePlugin` holds every action's settings to a `z.object`; its keys are what `else` sets.
    const known = entry.config instanceof ZodObject ? Object.keys(entry.config.shape) : [];
    const strangers = Object.keys(otherwise).filter((key) => !known.includes(key));
    lines.push(
      ...strangers.map(
        (key) =>
          `${where}.else.${key}: is not a setting of this action, so else cannot set it (its settings: ${known.join(", ")})`,
      ),
    );
    // What runs when the condition does not hold: judged once the action's own settings pass, so
    // a setting both lack is said once.
    if (lines.length === 0) {
      lines.push(...refusals(entry, resolved(merged, env), `${where}.else`, variablesIn(merged)));
    }
  }
  if (lines.length > 0) {
    throw new PluginHostError(
      "action-settings",
      `the settings of ${where} (${call.plugin} ${call.action}) are refused by the action's schema:\n${lines.map((line) => `  - ${line}`).join("\n")}`,
      `change ${where} in the config file, or the variable it names, as each line says`,
    );
  }
}

/**
 * Checks every action of one source of `config` against the plugins the host loaded: what the
 * worker does when it opens the source's loop, at its start and after a reload changed the file.
 */
export function checkSourceActions(
  config: ProjectConfig,
  source: SourceConfig,
  host: PluginHost,
  env: Env,
): void {
  const index = config.sources.findIndex((candidate) => candidate.name === source.name);
  source.actions.forEach((call, position) => {
    checkAction(host, call, placeOf(index, position), env);
  });
}

/** Why a webhook's address is written in the file, never read from a variable. */
const ADDRESS_WORDS =
  "a webhook's address is written in the file as text: it is where deliveries are sent, not a secret (the signing secret is plugins.webhook.secret), and the outbox row stores it as written";

/**
 * The built-in webhook's `endpoints` follow its `url`'s rule: each is an address written in the
 * file, since the outbox row stores it as written; one read from a variable is refused, naming
 * where and the variable, never its value.
 */
function checkWebhookEndpoints(config: ProjectConfig, host: PluginHost): void {
  const hosted = host.plugin(WEBHOOK_PLUGIN);
  const [fed] = (hosted?.variables ?? []).filter(({ path }) => /^endpoints(?:$|[.[])/.test(path));
  if (fed === undefined) {
    return;
  }
  const key =
    Object.keys(config.plugins ?? {}).find(
      (name) => host.plugin(name)?.packageName === WEBHOOK_PLUGIN,
    ) ?? "webhook";
  const where = `${formatPath(["plugins", key])}.${fed.path}`;
  const name = fed.path.startsWith("endpoints.") ? fed.path.slice("endpoints.".length) : "ops";
  throw new PluginHostError(
    "plugin-settings",
    `${where} reads ${fed.variable} from the environment, but ${ADDRESS_WORDS}`,
    `write the address in ${where}: ${name}: "https://hooks.example.com/facetdb"`,
  );
}

/** Checks every action of every source: `facetdb worker`, `studio`, `dev` and doctor, at load. */
export function checkActions(config: ProjectConfig, host: PluginHost, env: Env): void {
  checkWebhookEndpoints(config, host);
  for (const source of config.sources) {
    checkSourceActions(config, source, host, env);
  }
}

/**
 * The source's actions as steps, in the file's order: each judges its `when` and `else` with core's
 * pipeline and queues one row with what applies; an action whose `when` does not hold and that has
 * no `else` queues nothing. A row the store does not take is core's `ActionNotQueued`: the worker
 * releases the record's job and its next pass queues the row again. The worker's loop and a
 * person's decision (the studio, `facetdb review`) run these same steps; the plugin runs later,
 * from the outbox.
 *
 * One rule for a built-in: the built-in webhook's `send` is no action row. Its step queues the
 * endpoint row itself, in `webhooks`, at the decision (`webhookStep`), so a caller's code receives
 * every decision as a signed delivery and none is superseded by a later one; the same decision
 * queued again is the one delivery it already has. The worker and `facetdb review` always pass
 * `webhooks`; given none, such a step queues nothing and says so (`ActionNotQueued`).
 *
 * And one for `notify`: its row carries a batch key (the source, its place, the channel), which the
 * outbox's digest rule counts it in, and the condition it was queued under, which its words name;
 * it has no `else`, so nothing is queued when its condition does not hold.
 */
export function actionSteps(
  source: SourceConfig,
  queue: (row: QueuedAction) => Promise<unknown>,
  webhooks?: SourceWebhooks,
): readonly ActionStep[] {
  return source.actions.map((call, position) => {
    if (isWebhookSend(call)) {
      return webhooks === undefined
        ? {
            name: `${WEBHOOK_CHANNEL}.${WEBHOOK_ACTION}`,
            run: () =>
              Promise.reject(
                new ActionNotQueued(
                  "the webhook was not queued: this process was given no outbox to queue it in",
                ),
              ),
          }
        : webhookStep(source, call, position, webhooks);
    }
    const name = `${shortName(call.plugin) ?? call.plugin}.${call.action}`;
    // A notification's row carries its batch and its condition, and it has no `else`.
    const notify =
      call.action === NOTIFY_ACTION ? notifyQueueing(source.name, call, position) : undefined;
    return configureAction<Settings>(
      name,
      {
        async run(record, decisions, settings) {
          try {
            await queue({
              recordKey: record.key,
              plugin: call.plugin,
              action: call.action,
              position,
              ...(notify === undefined ? {} : { batchKey: notify.batchKey }),
              payload: {
                status: record.status,
                decidedAt: record.decidedAt.toISOString(),
                stateHash: record.stateHash,
                decisions,
                settings,
                ...(notify === undefined ? {} : { condition: notify.condition }),
              },
            });
          } catch (error) {
            throw new ActionNotQueued(
              `it was not queued, as the store did not take it (${error instanceof Error ? error.message : String(error)}); it is queued again when the worker next writes the record's decision, or a person decides it again`,
              { cause: error },
            );
          }
        },
      },
      // The config's schema judged `when` (each term against the source's questions) and `else`
      // (an object) when the file loaded: this is the invocation core's pipeline reads.
      (notify?.invocation ?? call.config) as ActionInvocation<Settings>,
    );
  });
}

/** A queued row's payload as the store gives it back: a database row, judged before it is used. */
const decisionSchema = z.union([
  z.object({
    kind: z.literal("decided"),
    value: z.union([z.boolean(), z.string()]),
    probabilityOrConfidence: z.number(),
    expected: z.number().optional(),
  }),
  z.object({ kind: z.literal("needs_review") }),
]);

const payloadSchema = z.object({
  status: z.enum(RECORD_STATUSES),
  decidedAt: z.iso.datetime(),
  stateHash: z.string(),
  decisions: z.record(z.string(), decisionSchema),
  settings: z.record(z.string(), z.json()),
});

/** The source of a queued row, as the worker finds it at delivery. */
export type ActionSource =
  /**
   * Its loop runs: the record is read through its connector, its log and the question set the
   * loop answers under say what the record's decision is now.
   */
  | {
      readonly kind: "running";
      readonly name: string;
      readonly connector: Pick<Connector, "read">;
      readonly log: Pick<DecisionLog, "history">;
      readonly questionSet: QuestionSet;
      /**
       * A plugin source's plugin, by its package name, and the source's settings as its schema
       * parsed them: an action of that same plugin is handed them as `ctx.source.settings`.
       * `variables` names each variable the plugin's settings and the source's read (the source
       * host's `HostedSource.variables`): no words of that action's error kept may repeat one.
       */
      readonly plugin?: {
        readonly packageName: string;
        readonly settings: Readonly<Record<string, unknown>>;
        readonly variables: readonly string[];
      };
    }
  /** In the config, but its loop is stopped: the row waits for it, no attempt spent. */
  | { readonly kind: "stopped"; readonly name: string }
  /** No longer in the config. */
  | { readonly kind: "gone" };

export type ActionRunnerDeps = {
  /** The plugins the worker loaded: each action's own `run`, schema and context. */
  readonly host: PluginHost;
  /** The source a row names, by its store id (`sourceIdOf(project, name)`). */
  readonly source: (sourceId: string) => ActionSource;
  /** The worker's environment: a setting queued as `{ env: "NAME" }` is read from it at delivery. */
  readonly env: Env;
  /** What a notification's delivery needs besides the plugins: the clock, the stop, the links. */
  readonly notify: NotifyDeps;
};

/**
 * Why a row is closed untried: the record left its source. Nothing runs the action instead: there
 * is no record to run it on.
 */
export const RECORD_GONE =
  "record gone: the record is no longer in its source, so the action is not run";

/**
 * Why a row is closed untried: the record's state changed since its decision (or it was asked at
 * another state since). The change queued the record, and the worker's answer at the new state is
 * a decision of its own that runs the actions it calls for.
 */
export const RECORD_CHANGED =
  "superseded: the record changed since this decision; the worker decides it again at its new state, and that decision runs the actions it calls for";

/**
 * Why a row is closed untried: at the same state, a decision the row carries is no longer the
 * record's. These words claim no newer run: a person's decision, an undo or the worker's newer
 * answer runs the actions again, but a threshold change runs none.
 */
export const SUPERSEDED =
  "superseded: at the same state, a decision this action was queued for is no longer the record's (a person decided, an undo, or a newer answer), so the action is not run for it";

/**
 * Why a row is closed untried: the decisions it carries still stand, but the record now waits for a
 * person (an answer since, such as the backfill's on an added question, is unsure). A question
 * waiting for a person never matches, and the person's decision runs the actions through the
 * review.
 */
export const WAITS_FOR_PERSON =
  "superseded: the record now waits for a person on a question answered since, so the action is not run for its earlier decision; the person's decision runs the actions";

/** Whether two decisions are the same: the same kind, and for a decided one the same value and figures. */
function sameDecision(a: Decision | undefined, b: Decision | undefined): boolean {
  if (a === undefined || b === undefined || a.kind !== b.kind) {
    return false;
  }
  if (a.kind === "needs_review" || b.kind === "needs_review") {
    return true;
  }
  return (
    a.value === b.value &&
    a.probabilityOrConfidence === b.probabilityOrConfidence &&
    a.expected === b.expected
  );
}

/**
 * Why the decision a row was queued for is no longer the record's, or undefined when it still is
 * and the row runs (a row is dropped when a newer decision for the record exists, though that
 * decision queued no row of its own; at least once otherwise). Judged by the log's own order and
 * the state hash, never by a clock. The record's standing decisions come from core's `decideRecord`
 * over the questions its latest answer holds (core's `answeredSet`, as the review service judges a
 * card), with the standing-human rule the worker writes by; they are compared on the questions the
 * ROW carries, so a question added since, answered or not, never closes a row on its own:
 * - a carried question decided otherwise now (a person, an undo, a re-answer): `SUPERSEDED`;
 * - every carried decision standing, but the record's status no longer the row's: when it now
 *   waits for a person, `WAITS_FOR_PERSON` (the person's decision runs the actions); otherwise
 *   `SUPERSEDED`;
 * - otherwise the row runs as queued. A carried question since removed from the set is left out,
 *   as a person's decision on it moves nothing in core. Where the log cannot judge (no answer, or
 *   none of the questions asked now), the row runs: no newer decision would run it instead.
 */
function supersededBy(
  payload: {
    readonly stateHash: string;
    readonly status: string;
    readonly decisions: ActionDecisions;
  },
  questionSet: QuestionSet,
  history: readonly LogEntry[],
): string | undefined {
  const latest = history.findLast((entry): entry is AnswerEntry => entry.kind === "answer");
  if (latest === undefined) {
    return undefined;
  }
  if (latest.stateHash !== payload.stateHash) {
    return RECORD_CHANGED;
  }
  const answered = answeredSet(questionSet, latest);
  const now = decideRecord(answered, answered.thresholds, latest, history);
  if (answered.questions.length === 0 || now === undefined) {
    return undefined;
  }
  const carried = answered.questions.filter((question) =>
    Object.hasOwn(payload.decisions, question.name),
  );
  if (
    !carried.every((question) => sameDecision(now[question.name], payload.decisions[question.name]))
  ) {
    return SUPERSEDED;
  }
  const status = statusOf(now);
  if (status === payload.status) {
    return undefined;
  }
  return status === "needs_review" ? WAITS_FOR_PERSON : SUPERSEDED;
}

/**
 * The longest a first-party action's own words are kept: GitHub's name the issue, the request and
 * its fix, which for a refused token's access runs past 300 characters, a delivery's length; still
 * bounded, as they go into the row and the alert.
 */
export const ACTION_WORDS_MAX = 600;

/**
 * Every value a plugin's action was handed from the environment, which no words kept may repeat
 * (the channel host's `handedValues`): the secrets its context holds, the plugin's settings'
 * variables, each variable the action's own settings read, and, run on a source of the same
 * plugin, each its settings read.
 */
function actionValues(
  env: Env,
  secrets: Readonly<Record<string, string>>,
  pluginVariables: readonly HostedVariable[],
  /** The action's settings as queued: each variable as `{ env: "NAME" }`. */
  settings: unknown,
  own: { readonly variables: readonly string[] } | undefined,
): readonly string[] {
  return handedValues(
    secrets,
    [
      ...pluginVariables.map(({ variable }) => variable),
      ...variablesIn(settings).map(({ variable }) => variable),
      ...(own?.variables ?? []),
    ],
    env,
  );
}

/** The settings with each `{ env: "NAME" }` read; fails, naming the variable, when one is not set. */
function withVariables(settings: Settings, env: Env): unknown {
  const unset = variablesIn(settings).filter(
    ({ variable }) => env[variable] === undefined || env[variable] === "",
  );
  if (unset.length > 0) {
    throw new ActionFailed(
      `${listed(unset)} is not set where the worker runs, and the action's settings read it`,
    );
  }
  return resolved(settings, env);
}

/**
 * The runner the outbox calls for one action row (`runAction`): the row's source and action found
 * again, its payload judged, the record read through the source's connector (closed as "record
 * gone" when it is not there), the row closed when its decision is no longer the record's, then the
 * plugin's `run` with the record, the decisions and the settings, which its schema parses again
 * with each variable read now. A row whose source is stopped waits, spending no attempt. The
 * plugin's own error is passed on as it is, never in words the outbox keeps: only this runner's
 * `ActionFailed` reaches the row, a log or an alert, since a plugin's message may hold a secret.
 * One exception, by the channel host's rule and table: a first-party plugin's own error
 * (`firstPartyFailure`) becomes an `ActionFailed` in its words, held to `ACTION_WORDS_MAX`, unless
 * they repeat a value the action was handed (`actionValues`), with the wait the service asked for
 * and whether the refusal is for good, which the outbox follows. A `notify` row, one of the first
 * 10 of its minute, is judged the same way, then sent through its plugin's channel
 * (`sendNotification`) instead of an action's `run`.
 */
export function createActionRunner(
  deps: ActionRunnerDeps,
): (row: ActionDelivery, signal: AbortSignal) => Promise<ActionClose | ActionDefer | undefined> {
  return async (row, signal) => {
    const source = deps.source(row.sourceId);
    if (source.kind === "gone") {
      return { close: "the source is no longer in the config, so the action is not run" };
    }
    if (source.kind === "stopped") {
      return {
        defer: `the source ${source.name} is stopped, so the record cannot be read; the action waits for it`,
      };
    }
    const hosted = deps.host.plugin(row.plugin);
    // A notification is FacetDB's own, run through the plugin's channel (notify.ts).
    const notify = row.action === NOTIFY_ACTION;
    const entry =
      hosted !== undefined && !notify && Object.hasOwn(hosted.plugin.actions, row.action)
        ? hosted.plugin.actions[row.action]
        : undefined;
    if (hosted === undefined || (notify ? !providesChannel(hosted) : entry === undefined)) {
      return {
        close: `the action ${row.plugin} ${row.action} is no longer one this worker runs, so it is not run`,
      };
    }
    const parsed = payloadSchema.safeParse(row.payload);
    const condition = notify ? payloadCondition(row.payload) : {};
    if (!parsed.success || condition === undefined) {
      throw new ActionFailed("the queued decision could not be read back from the store");
    }
    const payload = parsed.data;
    // The schema above is core's `Decision`, but zod types an optional key as `| undefined`.
    const decisions = payload.decisions as ActionDecisions;

    const { rows } = await source.connector.read([row.recordKey]);
    const [record] = rows;
    if (record === undefined) {
      return { close: RECORD_GONE };
    }
    // The record changed since the decision: the change queued it, and its next answer decides
    // again and runs the actions it calls for.
    if (record.hash !== payload.stateHash) {
      return { close: RECORD_CHANGED };
    }
    const superseded = supersededBy(
      { ...payload, decisions },
      source.questionSet,
      await source.log.history(row.recordKey),
    );
    if (superseded !== undefined) {
      return { close: superseded };
    }
    const decided: ActionRecord = {
      key: record.key,
      state: record.state,
      status: payload.status,
      stateHash: record.hash,
      decidedAt: new Date(payload.decidedAt),
    };
    if (entry === undefined) {
      // A notification: its channel is named in its settings, which hold no variable.
      return sendNotification({
        host: deps.host,
        hosted,
        env: deps.env,
        deps: deps.notify,
        signal,
        source: source.name,
        position: row.position,
        record: decided,
        decisions,
        settings: payload.settings,
        condition,
      });
    }

    // Parsed again here, so the plugin gets what its schema makes of them (a default, a transform),
    // each variable read now: the row holds its name, never its value.
    const settings = withVariables(payload.settings, deps.env);
    let checked: ReturnType<typeof entry.config.safeParse>;
    try {
      checked = entry.config.safeParse(settings);
    } catch {
      throw new ActionFailed(
        "the action's schema failed while it read the settings the action was queued with",
      );
    }
    if (!checked.success) {
      throw new ActionFailed(
        "the settings the action was queued with are refused by its schema now (the plugin, or a variable they read, changed since)",
      );
    }

    // A source of this same plugin hands the action its own settings (a GitHub label action reads
    // the repository of its GitHub issues source there); any other source, none.
    const own = source.plugin?.packageName === hosted.packageName ? source.plugin : undefined;
    const handed = deps.host.contextFor(row.plugin, signal);
    // What no kept words may repeat is read here, in the same turn as the context, never at the
    // throw: a reload may put other settings in force while the action runs, and its words could
    // hold a value it was handed, not one in force by then. The context exists, so the plugin does
    // in this same host; the fallback only satisfies the type.
    const values = actionValues(
      deps.env,
      handed.secrets,
      (deps.host.plugin(row.plugin) ?? hosted).variables,
      payload.settings,
      own,
    );
    const ctx: ActionContext<unknown> = {
      ...handed,
      source: { name: source.name, settings: own?.settings ?? null },
    };
    try {
      await entry.run(ctx, decided, decisions, checked.data);
    } catch (error) {
      // A first-party plugin's own error keeps its words, its wait and its refusal for good, by the
      // channel host's rule; a community plugin's never, whatever it is named.
      const vouched = firstPartyFailure(hosted.packageName, error, values, ACTION_WORDS_MAX);
      if (vouched !== undefined) {
        throw new ActionFailed(vouched.words, {
          ...(vouched.retryAfterMs === undefined ? {} : { retryAfterMs: vouched.retryAfterMs }),
          permanent: vouched.permanent,
          // A 401, its credential refused, keeps its retries and raises its alert.
          ...(vouched.credentialRefused === true ? { credentialRefused: true } : {}),
        });
      }
      // Words withheld, a refused credential is still said (a status is no secret), in fixed words,
      // so its alert is raised without them.
      if (firstPartyCredentialRefused(hosted.packageName, error)) {
        throw new ActionFailed(CREDENTIAL_WORDS_WITHHELD, { credentialRefused: true });
      }
      // A plugin that throws an `ActionFailed` of its own would have its words kept: they are
      // dropped, as any other error of the plugin's is.
      throw error instanceof ActionFailed ? new Error("the plugin's action failed") : error;
    }
    return undefined;
  };
}
