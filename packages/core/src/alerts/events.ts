import type { ChannelMessage } from "../contracts/index.ts";
import { whenUtc } from "../log/index.ts";

/**
 * The system alerts FacetDB can observe. The review-queue and answer-drift alerts are FacetDB
 * Cloud's and have no kind here.
 */
export const ALERT_KINDS = [
  "worker_not_running",
  "model_failing",
  // A response named another model than the one that first answered its version.
  "model_changed",
  "connector_lost_access",
  "spending_80",
  "spending_paused",
  "backfill_finished",
  "backfill_failed",
  "question_set_changed",
  // A plugin action, or a webhook, the outbox stopped trying after 24 hours.
  "action_gave_up",
  // A plugin's action answered 401, its credential refused; the row keeps its 24 hours of retries,
  // and a later delivered try of that plugin resolves it.
  "action_credential_refused",
  // A table or plugin source's loop stopped by itself; a later pass of it that works resolves it.
  "source_stopped",
] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];

export type AlertSeverity = ChannelMessage["severity"];

/**
 * The kinds the code resolves: a healthy call resolves `model_failing`, a response naming the model
 * its version is held to resolves `model_changed`, and the worker resolves `connector_lost_access`
 * once the source reads well again (its doctor's verdict passes at the worker's 5-minute reading,
 * or a plugin source's read answers). Every other kind is raised and never resolved, so a page must
 * not say it is "not resolved". A kind that gains a resolve path is added here.
 * `worker_not_running` is not one: it is raised once for a worker that is gone, whose row is taken
 * as it is raised, and nothing later says it is back. `action_credential_refused` is resolved by
 * the outbox's next delivered try of that plugin on that source. `source_stopped` is resolved at
 * the worker's 5-minute look once a pass of the source begun after the alert has run: its loop runs
 * again.
 */
export const RESOLVABLE_ALERT_KINDS: readonly AlertKind[] = [
  "model_failing",
  "model_changed",
  "connector_lost_access",
  "action_credential_refused",
  "source_stopped",
];

/**
 * The kinds whose raise is sent no sooner than `ALERT_WINDOW_MS` after the last raise sent for the
 * same key, even when the alert was resolved in between: a source that stops, runs and stops again
 * every few minutes is said once per 30 minutes, not once per stop. Their resolve keeps the key's
 * row, marked resolved, so the time of the last raise sent outlives it; a raise inside that time is
 * recorded (open on the Alerts page) and sent to no channel, and so is its resolve. Every other
 * kind's resolve clears its row, as before.
 */
export const HELD_AFTER_RESOLVE_KINDS: readonly AlertKind[] = ["source_stopped"];

/** The Severity column of the system alerts. */
export const ALERT_SEVERITY: Readonly<Record<AlertKind, AlertSeverity>> = {
  worker_not_running: "critical",
  model_failing: "critical",
  model_changed: "critical",
  connector_lost_access: "critical",
  spending_80: "warning",
  spending_paused: "critical",
  backfill_finished: "information",
  backfill_failed: "warning",
  question_set_changed: "information",
  action_gave_up: "warning",
  action_credential_refused: "warning",
  source_stopped: "critical",
};

/** No heartbeat for this long and the worker is not running. */
export const HEARTBEAT_LOSS_MS = 2 * 60_000;

/** How often a running worker saves its own heartbeat row. */
export const WORKER_BEAT_EVERY_MS = 15_000;

/** How often a running worker takes the rows of the workers that stopped beating. */
export const WORKER_CHECK_EVERY_MS = 30_000;

/**
 * What the dashboard's health says when the project's own heartbeat is older than
 * `HEARTBEAT_LOSS_MS`. The alert for a worker that died is worded by the worker watch
 * (`dead-worker.ts`), which names the worker.
 */
export const WORKER_NOT_RUNNING_WHAT = "The worker has sent no heartbeat for 2 minutes.";

/**
 * What each kind is called where a person reads it (the dashboard's Home and its recent alerts).
 * The spending cap is one event in two steps.
 */
export const ALERT_TITLES: Readonly<Record<AlertKind, string>> = {
  worker_not_running: "Worker not running",
  model_failing: "Model failing",
  model_changed: "Model changed",
  connector_lost_access: "Connector lost access",
  spending_80: "Spending at 80% of the cap",
  spending_paused: "Spending cap reached",
  backfill_finished: "Backfill finished",
  backfill_failed: "Backfill failed",
  question_set_changed: "Question set changed",
  action_gave_up: "Action gave up",
  action_credential_refused: "Action credential refused",
  source_stopped: "Source stopped",
};

/** A source whose loop stopped by itself, as the worker's fleet holds it. */
export type SourceStop = {
  readonly source: string;
  /** The failure in words, every secret already hidden. */
  readonly why: string;
  /** When the worker tries it again, ms since the epoch; null when no wait mends it. */
  readonly retryAt: number | null;
};

/** What a stopped source says when no wait mends it, on Home and in the alert alike. */
export const NOT_TRIED_AGAIN =
  "Not tried again until it is fixed: then Check again on the Sources page, or restart facetdb worker.";

/**
 * What a stopped source says, Home's sentence and the Source stopped alert's from this one
 * function: what stopped and why, and what comes next. They differ in one thing: Home is read live,
 * so `live` names the next try's time; an alert is read later, when that time may have passed, so
 * it says only that FacetDB keeps trying. A stop no wait mends says so in both.
 */
export function sourceStoppedWords(
  stop: SourceStop,
  live: boolean,
): { readonly what: string; readonly next: string } {
  return {
    what: `${stop.source} stopped: ${stop.why.replace(/\.$/, "")}.`,
    next:
      stop.retryAt === null
        ? NOT_TRIED_AGAIN
        : live
          ? `Trying again at ${whenUtc(new Date(stop.retryAt))}.`
          : "Retrying on its own.",
  };
}

/** The longest stretch of a failure's words an alert quotes, in characters. */
export const QUOTED_WORDS_MAX = 300;

/**
 * What a quoted sentence keeps: letters, digits, spaces, ordinary punctuation, and the characters
 * that carry meaning in a failure's words: `_` (`facetdb_jobs`, `ER_ACCESS_DENIED_ERROR`) and `@`
 * (a plugin's scope); brackets only as the `[hidden]` marker (`HIDDEN`). Everything else goes:
 * control and format characters, `<…>`, `[…]`, backticks, `*`, `~`, `&`, `#`, `|`. Escaping what a channel reads as
 * markup is each channel's own job; this keeps the words plain and nothing in them a link.
 */
const NOT_A_SENTENCE = /[^\p{L}\p{N} .,:;()'"/+=%?!@_-]/gu;

/** The marker hidden words leave (`hideSecrets`): the only brackets a quoted sentence keeps. */
const HIDDEN = "[hidden]";

/**
 * Words a driver or a plugin chose, as an alert may quote them, the sibling of `modelNameWords` for
 * a sentence: on one line, only plain text and ordinary punctuation, nothing link-shaped left to
 * autolink (`://`, an address of four numbers, a dot before a letter are defanged), then cut at
 * `QUOTED_WORDS_MAX` characters, never inside one. Connection strings are the caller's to hide
 * first; this keeps what is left from being a link, a mention or markup.
 */
export function quotedWords(text: string): string {
  // Brackets go but in the literal marker: `[text](target)` is a link on a Markdown channel. A
  // marker followed by `(` is set apart, so it cannot be the text of a link either.
  const plain = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\s]+/gu, " ")
    .split(HIDDEN)
    .map((part) => part.replace(NOT_A_SENTENCE, ""))
    .join(HIDDEN)
    .replaceAll(`${HIDDEN}(`, `${HIDDEN} (`)
    .replace(/ {2,}/g, " ")
    .trim();
  const characters = [...defanged(plain)];
  if (characters.length === 0) {
    return "its error has nothing printable";
  }
  return characters.length <= QUOTED_WORDS_MAX
    ? characters.join("")
    : `${characters.slice(0, QUOTED_WORDS_MAX - 1).join("")}…`;
}

/**
 * A response that named another model than the one its question-set version is held to: the
 * version, the name the store holds for it, and the name the response gave.
 */
export type ModelChange = {
  readonly version: number;
  readonly held: string;
  readonly named: string;
};

/** The longest model name a message quotes, in characters: a server names itself, unbounded. */
export const MODEL_NAME_MAX = 80;

/**
 * What a server-chosen name keeps: letters, digits, spaces, and the `.`, `-`, `:`, `/` and `+` that
 * model names use. Everything else goes: control and format characters (line breaks, bidi
 * overrides, zero-width marks) and every character a channel reads as markup (Slack's `<…>` links
 * and mentions, `_`, `*` and `~` emphasis, Markdown, HTML, `@` mentions).
 */
const NOT_A_NAME = /[^\p{L}\p{N} .:/+-]/gu;

/**
 * Nothing link-shaped is left to autolink: a scheme's `://`, and a dot before a letter or inside an
 * address of four numbers, are written `[:]//` and `[.]`, the usual defanged form. A version's dots
 * (`jev-1.14.0`) stand between digits and stay.
 */
function defanged(name: string): string {
  return name
    .replace(/\d+(?:\.\d+){3}/g, (address) => address.replaceAll(".", "[.]"))
    .replace(/\.(?=\p{L})/gu, "[.]")
    .replaceAll("://", "[:]//");
}

/**
 * A model name a server chose, as a message may quote it: only plain text, nothing a channel could
 * render as markup, emphasis or a link, then cut at `MODEL_NAME_MAX` characters, never inside one.
 */
export function modelNameWords(model: string): string {
  const characters = [...defanged(model.replace(NOT_A_NAME, ""))];
  if (characters.length === 0) {
    return "(a name with nothing printable)";
  }
  return characters.length <= MODEL_NAME_MAX
    ? characters.join("")
    : `${characters.slice(0, MODEL_NAME_MAX - 1).join("")}…`;
}

/**
 * What happened, and what FacetDB did with the fix. The worker's failure, a backfill's failed run
 * and the alert all say it in these words.
 */
export function modelChangedWords(change: ModelChange): {
  readonly what: string;
  readonly did: string;
} {
  const held = modelNameWords(change.held);
  return {
    what: `The model answered as ${modelNameWords(change.named)}, not ${held}, the model that first answered question-set version ${change.version}.`,
    did: `None of its answers was written, and the source is held: one record is asked again every 5 minutes, the others wait without a model call. Serve ${held} again at the provider's address, or set a new model in facetdb.config.ts, which starts a new version; every waiting record is then asked again.`,
  };
}

/** One alert per event per this long until it resolves. */
export const ALERT_WINDOW_MS = 30 * 60_000;

/** Calls are counted over this long when judging whether the model is failing. */
export const FAILURE_WINDOW_MS = 5 * 60_000;

/**
 * An event with the five things every alert says: what happened, which project, source and question,
 * what FacetDB did about it, and one link to the page where it is fixed.
 */
export type AlertEvent = {
  readonly kind: AlertKind;
  /** What happened, in a sentence. */
  readonly what: string;
  readonly project: string;
  readonly source: string;
  /** The question concerned; null when the event concerns every question of the source. */
  readonly question: string | null;
  /** What FacetDB did about it: paused, retrying, holding records. */
  readonly did: string;
  /** The one page where it is fixed. */
  readonly link: string;
  /**
   * The worker the event is about, for an event that is one per worker (`worker_not_running`);
   * absent for every other event. It is part of the event's key, so two dead workers within 30
   * minutes are two alerts.
   */
  readonly worker?: string;
  /**
   * The question-set version an event is about (`question_set_changed`); absent for every other
   * event. It is part of the event's key, so a second change within 30 minutes is an alert of its
   * own, while one version is one alert.
   */
  readonly version?: number;
  /**
   * The plugin an event is about, as the config names it (`action_credential_refused`,
   * `@facetdb/github`); absent for every other event. It is part of the event's key, so each plugin
   * of a source holds its own alert, and every action of one plugin there shares it.
   */
  readonly plugin?: string;
  /**
   * What raised a Connector lost access alert: its source's doctor at the worker's 5-minute look,
   * or a refusal its loop met (a refused login, right or credential). Kept with the active alert,
   * so every worker reading it knows: a look resolves only what a doctor raised, and a refusal's
   * alert waits for a write or a read through the source made after it began. Absent for every
   * other event; not part of the key.
   */
  readonly cause?: "doctor" | "refusal";
};

/** What makes two events "the same event": one alert is sent per key per 30 minutes. */
export function eventKey(
  event: Pick<
    AlertEvent,
    "kind" | "project" | "source" | "question" | "worker" | "version" | "plugin"
  >,
): string {
  const key = [event.kind, event.project, event.source, event.question ?? ""];
  return [
    ...key,
    ...(event.worker === undefined ? [] : [event.worker]),
    ...(event.version === undefined ? [] : [`v${event.version}`]),
    ...(event.plugin === undefined ? [] : [`plugin:${event.plugin}`]),
  ].join("|");
}

/**
 * The Source stopped alert: what stopped and why, the failure's words quoted (`quotedWords`) as a
 * third-party channel may show them, and what FacetDB does: keeps trying, or, for a stop no wait
 * mends, waits for the fix (`sourceStoppedWords`, as an alert says it).
 */
export function sourceStoppedEvent(
  stop: SourceStop,
  where: { readonly project: string; readonly link: string },
): AlertEvent {
  const { what, next } = sourceStoppedWords({ ...stop, why: quotedWords(stop.why) }, false);
  return {
    kind: "source_stopped",
    what,
    project: where.project,
    source: stop.source,
    question: null,
    did: next,
    link: where.link,
  };
}

/**
 * What the resolved message says happened: a stopped source's own short line, never its old cause;
 * every other kind's raise again, marked resolved.
 */
function resolvedWhat(event: AlertEvent): string {
  return event.kind === "source_stopped"
    ? `${event.source} runs again.`
    : `Resolved: ${event.what}`;
}

function placeOf(event: AlertEvent): string {
  const question = event.question === null ? "all questions" : `question ${event.question}`;
  return `Project ${event.project}, source ${event.source}, ${question}.`;
}

/** The message a channel delivers when the event is raised. */
export function alertMessage(event: AlertEvent): ChannelMessage {
  return {
    kind: "system-alert",
    severity: ALERT_SEVERITY[event.kind],
    text: `${event.what} ${placeOf(event)} FacetDB: ${event.did}`,
    link: event.link,
  };
}

/** The message a channel delivers, once, when the event is over. */
export function resolvedMessage(event: AlertEvent): ChannelMessage {
  return {
    kind: "system-alert",
    severity: "information",
    text: `${resolvedWhat(event)} ${placeOf(event)}`,
    link: event.link,
  };
}
