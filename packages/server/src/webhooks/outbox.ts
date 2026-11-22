import { randomUUID } from "node:crypto";
import type { Clock } from "@facetdb/core";
import { sign, WEBHOOK_SIGNATURE_HEADER } from "./sign.ts";

type SqlRow = Readonly<Record<string, unknown>>;

/**
 * The one thing the outbox needs from the store's database: run a statement. The store's own client
 * (postgres.js in production, PGlite in tests) has this shape.
 */
export type OutboxDatabase = {
  query(text: string, params?: readonly unknown[]): Promise<readonly SqlRow[]>;
};

/** The first retry comes this long after a failed attempt; each next one waits twice as long. */
export const RETRY_FIRST_MS = 10_000;
export const RETRY_MAX_MS = 60 * 60_000;
/** Retried with backoff for 24 hours, counted from when the webhook was queued. */
export const GIVE_UP_AFTER_MS = 24 * 60 * 60_000;
/** A claimed row is invisible to other loops this long; a crash mid-send retries after it. */
export const CLAIM_LEASE_MS = 5 * 60_000;
/**
 * One send, and one give-up alert, gets this long (a constructor option): well below the lease, so
 * the loop that claimed a row has finished with it, one way or the other, before another loop may
 * claim it again.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
/**
 * Appended to `last_error` when the alert for a webhook given up on could not be raised: the row
 * stays open for one more try of the alert alone (the webhook is not sent again), and that try
 * closes it whatever the alert does.
 */
export const ALERT_NOT_RAISED = "the alert that it was given up on could not be raised";
export const DELIVERY_BATCH = 20;

/** How long to wait after the `attempt`th failed attempt (1 is the first): 10 s, 20 s, … capped at 1 h. */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

/** What the outbox needs from `fetch`; the composition root passes the real one. */
export type WebhookFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    /** A redirect is not followed: a 3xx counts as a failed attempt. */
    readonly redirect: "manual";
    /** Aborted when the send outlives the outbox's timeout; the real `fetch` honours it. */
    readonly signal: AbortSignal;
  },
) => Promise<{ readonly status: number }>;

/** A webhook that was not delivered within 24 hours. */
export type EndpointGaveUp = {
  readonly projectId: string;
  readonly deliveryId: string;
  /** The host only: the full URL may be a secret by itself. */
  readonly host: string;
  readonly attempts: number;
  readonly queuedAt: number;
};

/** A plugin's action on one record that did not succeed within 24 hours. */
export type ActionGaveUp = {
  readonly projectId: string;
  readonly deliveryId: string;
  /** The store's id of the source: `sourceIdOf(project, name)`. */
  readonly sourceId: string;
  readonly plugin: string;
  readonly action: string;
  readonly attempts: number;
  readonly queuedAt: number;
};

/**
 * A row of the outbox that was not delivered within 24 hours, a webhook (its host) or a plugin's
 * action (its source, plugin and action); the composition root turns it into an alert.
 */
export type WebhookGaveUp = EndpointGaveUp | ActionGaveUp;

/**
 * A plugin's action on one record, queued after a decision: delivered as a webhook is, with its
 * retries and its 24 hours, by the runner the composition root passes. The payload is what the
 * runner needs (the decision, the settings), never the record's state.
 */
export type NewAction = {
  readonly projectId: string;
  /** The store's id of the source: `sourceIdOf(project, name)`. */
  readonly sourceId: string;
  readonly recordKey: string;
  readonly plugin: string;
  readonly action: string;
  /** Its place in the source's `actions`, from 0. */
  readonly position: number;
  /** Serialised once here, as a webhook's payload is. */
  readonly payload: unknown;
  /** The batch a digest gathers it into; none for an action run on its own. */
  readonly batchKey?: string;
};

/** An action row as its runner receives it, at each attempt. */
export type ActionDelivery = {
  readonly deliveryId: string;
  readonly projectId: string;
  readonly sourceId: string;
  readonly recordKey: string;
  readonly plugin: string;
  readonly action: string;
  readonly position: number;
  /** The payload as it was queued, read back from its JSON. */
  readonly payload: unknown;
  readonly batchKey: string | undefined;
  /** This attempt's number, from 1. */
  readonly attempt: number;
  readonly queuedAt: number;
};

/**
 * What a runner says when the action did not fail but must not be tried again: the row is closed
 * with this reason ("record gone") in `last_error`, so in words that carry no secret and no record
 * state; it is never deleted, and no alert is raised.
 */
export type ActionClose = { readonly close: string };

/**
 * What a runner says when the action cannot be tried yet and the wait is no failure of its own
 * (140: its source is stopped, so the record cannot be read): the row is put back for
 * `ACTION_DEFER_MS` with this reason in `last_error`, and the attempt it was claimed for is given
 * back, so a wait spends no attempt and never gives the row up. Its 24 hours still count from
 * when it was queued: once its source runs again, a try that fails past them is its last.
 */
export type ActionDefer = { readonly defer: string };

/** How long a deferred action row waits before it is claimed again. */
export const ACTION_DEFER_MS = 60_000;

/**
 * The digest rule: of the rows one batch key queues in one clock minute, the first this many, in
 * the order they were queued, are run one by one as they happen.
 */
export const DIGEST_AFTER = 10;

/** The clock minute the digest rule counts in: from a whole minute since the epoch to the next. */
export const DIGEST_MINUTE_MS = 60_000;

/** A span of time from `start` (inside it) to `end` (outside), in ms since the epoch. */
export type TimeSpan = { readonly start: number; readonly end: number };

/**
 * Why the rows of a digest are one message: the rest of a clock minute after its first
 * `DIGEST_AFTER`, or a quiet period of the batch's channel, every row queued inside it.
 */
export type DigestWindow = { readonly kind: "minute" | "quiet" } & TimeSpan;

/** One row of a digest: its record and the payload as it was queued. */
export type DigestRow = {
  readonly deliveryId: string;
  readonly recordKey: string;
  /** Read back from its JSON. */
  readonly payload: unknown;
  readonly queuedAt: number;
};

/**
 * The rows of one batch key the digest rule gathers into one message, as the digest's runner
 * receives them at each attempt: the source, plugin, action and place they share, the window that
 * made them one, and every row, oldest first.
 */
export type DigestDelivery = {
  readonly projectId: string;
  /** The store's id of the source: `sourceIdOf(project, name)`. */
  readonly sourceId: string;
  readonly plugin: string;
  readonly action: string;
  readonly position: number;
  readonly batchKey: string;
  readonly window: DigestWindow;
  readonly rows: readonly DigestRow[];
  /** This attempt's number, from 1: its oldest row's. */
  readonly attempt: number;
};

/** `last_error` of a row held for its minute's digest: it is no failure, and spends no attempt. */
export const HELD_FOR_DIGEST = `held for the digest: more than ${DIGEST_AFTER} rows of its batch were queued in its minute, so it goes out with the others of that minute as one message when the minute ends`;

/** `last_error` of a row held because its channel is in quiet hours. */
export const HELD_FOR_QUIET =
  "held for quiet hours: its channel is in quiet hours, so it goes out in one digest with every row queued inside them when they end";

/**
 * An action's failure in words the runner vouches for: they are kept in the row's `last_error` and
 * repeated in the give-up alert, so they carry no secret and no record state. Any other error a
 * runner throws counts as a failed attempt too, but its text is not kept: a plugin's error may
 * hold a token or a URL.
 */
export class ActionFailed extends Error {}

/** `last_error` of an action whose runner threw anything but `ActionFailed`. */
export const ACTION_ERROR_NOT_KEPT =
  "the action failed; its error is not kept, as it may hold a secret";

export type OutboxDeps = {
  readonly client: OutboxDatabase;
  readonly clock: Clock;
  readonly fetch: WebhookFetch;
  /**
   * How long one send, or one give-up alert, may take before it counts as failed: above 0 and below
   * `CLAIM_LEASE_MS` (anything else is refused when the outbox is created); defaults to
   * `DEFAULT_FETCH_TIMEOUT_MS`.
   */
  readonly fetchTimeoutMs?: number;
  /**
   * A signal that aborts `ms` milliseconds from now: the platform's timeout signal (unref'd, so it
   * keeps no idle process alive), wired by the composition root; a fake on the test's clock in a
   * test, so no real timer decides a test's outcome.
   */
  abortAfter(ms: number): AbortSignal;
  /** Names this loop on the rows it claims; defaults to a fresh UUID per outbox. */
  readonly loopId?: string;
  /**
   * The signing secret of a project's webhook, read at each attempt: the worker answers its own
   * project's from the built-in webhook plugin's settings (a variable the config names) and refuses
   * any other. A rejection is a failed attempt in fixed words; its text is not kept.
   */
  secretFor(projectId: string, endpoint: string): Promise<string>;
  /**
   * Raises the alert event for a webhook or an action given up on, within the send timeout
   * (`signal` aborts when it runs out); `lastError` is the failure the row ends on, in the words
   * `last_error` keeps. May run twice for one row after a crash, or after an alert that failed.
   */
  onGiveUp(event: WebhookGaveUp, signal: AbortSignal, lastError: string): Promise<void>;
  /**
   * Runs one attempt of a plugin's action, within the send timeout (`signal` aborts when it runs
   * out): resolves when it succeeded, with `ActionClose` when the row must be closed untried
   * again, or with `ActionDefer` when it cannot be tried yet; throws (`ActionFailed` for words
   * worth keeping) when the attempt failed, which is retried on the webhook's schedule. An outbox
   * without a runner sends webhooks only and leaves action rows to the loop that has one.
   */
  readonly runAction?: (
    row: ActionDelivery,
    signal: AbortSignal,
  ) => Promise<ActionClose | ActionDefer | undefined>;
  /**
   * With `runAction`, runs one digest within the send timeout: the rows of one batch key past the
   * first `DIGEST_AFTER` of a minute, once the minute ended, or every row queued in a quiet period
   * of the batch's channel, once it ended. Resolves when the digest was delivered (every row is
   * then delivered), with `ActionClose` when its rows must be closed untried; throws for a failure
   * (`ActionFailed` for words worth keeping), and the digest is retried as a whole on the webhook's
   * schedule with its rows still open: a crash before they are marked sends it again. Absent, a row
   * with a batch key is run alone, as any other action row.
   */
  readonly runDigest?: (
    digest: DigestDelivery,
    signal: AbortSignal,
  ) => Promise<ActionClose | undefined>;
  /**
   * The quiet period of a batch key's channel that the instant `at` falls in, or undefined when the
   * channel is not quiet then: a batched row due inside it is held until it ends, and every row
   * queued inside it then goes out as one digest. Absent, no channel of a batch has quiet hours.
   */
  readonly quietPeriod?: (batchKey: string, at: number) => TimeSpan | undefined;
  /**
   * With `runAction`, the one project whose action rows this loop takes: a worker runs the plugins
   * of its own project's config, and a row of another project sharing the store waits for that
   * project's worker, never closed or given up on here. The same holds for a webhook a plugin
   * queued (`WebhookOrigin`), which only its own project's worker can sign. Absent, every
   * project's.
   */
  readonly actionProject?: string;
  /**
   * Asked before each attempt of a webhook a plugin queued (`WebhookOrigin`): why the row must not
   * be sent now, in fixed words that carry no address and no secret (the worker: its endpoint is no
   * longer one its config names), or undefined to send it. A refused row is closed untried as an
   * action row its runner closes is (`closed` in the report, `gave_up_at` set, no alert), never
   * sent. A webhook queued by no plugin is not asked.
   */
  readonly refuseWebhook?: (row: {
    readonly projectId: string;
    readonly plugin: string;
    readonly endpoint: string;
  }) => string | undefined;
};

/**
 * The plugin entry that queued a webhook (the built-in `@facetdb/webhook`, its action `send` or its
 * channel `webhook`). Its row is still a webhook, sent and signed to its endpoint, but it is that
 * plugin's as an action row is: only a loop that runs its project's plugins claims it, and signs it
 * with that project's secret (`secretFor`), never another project's worker.
 */
export type WebhookOrigin = {
  /** As the config names it: `@facetdb/webhook`. */
  readonly plugin: string;
  /** The action or the channel that queued it: `send`, `webhook`. */
  readonly entry: string;
  /**
   * For an action's delivery, the decision's record and the action's place in the source's
   * `actions`. It is compared with the LATEST row queued for that record and place, whatever its
   * endpoint: when that row waits or was delivered, goes to the same endpoint and carries the same
   * payload (its delivery id aside), it is the delivery of this very decision and nothing new is
   * queued; in every other case the row is queued. A job released and run again, a lost ack, or a
   * record queued again at the same state hands the worker the logged decision with its logged
   * time, which is that latest row. A decision that changed since and changed back (a threshold
   * moved and moved back, re-deciding one answer: the same `decidedAt` each time) is compared with
   * the row of the change, not with an older equal one, so it is queued again and the receiver ends
   * on the record's decision.
   */
  readonly record?: {
    /** The store's id of the source: `sourceIdOf(project, name)`. */
    readonly sourceId: string;
    readonly recordKey: string;
    /** Its place in the source's `actions`, from 0. */
    readonly position: number;
  };
};

export type NewWebhook = {
  readonly projectId: string;
  /** The URL to POST to (https, or http for a receiver on the same machine). */
  readonly endpoint: string;
  /** The plugin entry that queued it, when one did; a webhook queued by none is any loop's to send. */
  readonly origin?: WebhookOrigin;
} & (
  | {
      /** Serialised once here: the bytes stored are the bytes signed and sent, on every attempt. */
      readonly payload: unknown;
    }
  | {
      /**
       * The same, for a payload that names its own delivery id: called once with the id the row
       * will have, so the body (and so the signature) covers it.
       */
      readonly payloadOf: (deliveryId: string) => unknown;
    }
);

export type DeliveryReport = {
  readonly delivered: readonly string[];
  /** Failed this time and scheduled again. */
  readonly retrying: readonly string[];
  readonly gaveUp: readonly string[];
  /**
   * Action rows closed untried because a later row for the same record, plugin, action and place
   * exists: a later decision's action replaces this one.
   */
  readonly superseded: readonly string[];
  /**
   * Action rows their runner closed with a reason (`ActionClose`), and webhooks a plugin queued
   * that `refuseWebhook` closed.
   */
  readonly closed: readonly string[];
  /** Action rows their runner put back to wait (`ActionDefer`), no attempt spent. */
  readonly deferred: readonly string[];
  /**
   * Batched rows the digest rule held, no attempt spent: past the first `DIGEST_AFTER` of their
   * minute before it ended, or due while their channel is in quiet hours. Only the rows this pass
   * claimed are listed; the other due rows of the same window are held with them.
   */
  readonly held: readonly string[];
  /**
   * Sent, but this loop no longer held the claim when it came to record the outcome (its lease ran
   * out and another loop took the row): nothing was written and no alert was raised.
   */
  readonly lost: readonly string[];
  /** Alerts that could not be raised for a webhook given up on; reported, never swallowed. */
  readonly alertFailures: readonly AlertFailure[];
};

/** A give-up alert that threw or outlived the timeout. */
export type AlertFailure = {
  readonly event: WebhookGaveUp;
  readonly error: unknown;
  /**
   * False: the row stays open (in `retrying`) and its next attempt raises the alert again, without
   * sending the webhook: its 24 hours are spent. True: that was the alert's one more try, and the
   * row is closed (in `gaveUp`) without an alert.
   */
  readonly final: boolean;
};

/** The signing secret could not be read for an attempt. */
class SecretUnreadable extends Error {}

/** A send or an alert that outlived the outbox's timeout. */
class TimedOut extends Error {
  constructor(timeoutMs: number) {
    super(`it did not finish within ${timeoutMs} ms`);
  }
}

/**
 * The outbox reads and writes `facetdb.webhook_outbox` and never creates it: the table is a store
 * migration (@facetdb/postgres, `store/schema.ts`), made by `facetdb migrate` with the admin
 * credential and granted to the worker login, which may not create tables.
 */
export type Outbox = {
  /** Queues a webhook, or a plugin's action, for delivery now; returns its delivery id. */
  enqueue(entry: NewWebhook | NewAction): Promise<string>;
  /** Sends every webhook whose `next_attempt_at` is at or before `now`; the worker loop calls it each pass. */
  deliverDue(now: number): Promise<DeliveryReport>;
};

/** What a row delivers: a signed POST to an endpoint, or a plugin's action through the runner. */
type Target =
  | {
      readonly kind: "webhook";
      readonly endpoint: string;
      /** The plugin that queued it (`WebhookOrigin`), or undefined for a webhook no plugin queued. */
      readonly plugin: string | undefined;
    }
  | {
      readonly kind: "action";
      readonly sourceId: string;
      readonly recordKey: string;
      readonly plugin: string;
      readonly action: string;
      readonly position: number;
      readonly batchKey: string | undefined;
    };

type Claimed = {
  readonly id: string;
  readonly projectId: string;
  readonly target: Target;
  readonly payload: string;
  readonly attempts: number;
  readonly createdAt: number;
  /**
   * Set when an earlier attempt gave up on the row but could not raise its alert: the send failure
   * it recorded. This claim is the alert's one more try, and the webhook is not sent again.
   */
  readonly alertRetryOf: string | undefined;
};

/** An action row with a batch key, which the digest rule places. */
type Batched = Extract<Target, { readonly kind: "action" }> & { readonly batchKey: string };

/** Every instant: a quiet hold takes every due row of the batch, whenever it was queued. */
const EVERY_TIME: TimeSpan = { start: 0, end: Number.MAX_SAFE_INTEGER };

/** What the digest rule makes of a batched row due now (`place`). */
type Placement =
  | { readonly kind: "alone" }
  | {
      readonly kind: "held";
      readonly until: number;
      readonly reason: string;
      /** The other due rows held with it: queued inside `window`, with an id above `after`. */
      readonly window: TimeSpan;
      readonly after: string;
    }
  | {
      readonly kind: "digest";
      readonly window: DigestWindow;
      /** The digest's rows have an id above this one (the minute's last row run alone). */
      readonly after: string;
    };

/** The rows of one digest this pass claimed, with what they share. */
type DigestGroup = {
  readonly projectId: string;
  readonly mine: readonly Claimed[];
  readonly target: Batched;
  readonly window: DigestWindow;
  readonly after: string;
};

/** One row of a digest as this loop gathered it: the attempt it holds it at. */
type Member = {
  readonly id: string;
  readonly recordKey: string;
  readonly payload: string;
  readonly attempts: number;
  readonly createdAt: number;
};

const ALERT_NOTE = `; ${ALERT_NOT_RAISED}`;

/**
 * SQL that holds for a row not awaiting its give-up alert's one more try: such a row carries
 * `ALERT_NOTE` at the end of its `last_error` (`claimed`), and the note is all that says its
 * 24 hours are spent, so the digest rule neither holds nor gathers it. `param` is bound to
 * `ALERT_NOTE`.
 */
function notAwaitingAlert(param: string): string {
  return `right(coalesce(last_error, ''), char_length(${param}::text)) <> ${param}::text`;
}

/** A text column that may be null, as the row holds it. */
function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function targetOf(row: SqlRow): Target {
  // The store's check (`webhook_outbox_endpoint_or_plugin`) holds an endpoint or a plugin. A row
  // with an endpoint is a webhook, whether or not a plugin queued it (`WebhookOrigin`): it is sent
  // and signed, never handed to a runner, and never superseded.
  if (row["endpoint"] !== null && row["endpoint"] !== undefined) {
    return {
      kind: "webhook",
      endpoint: String(row["endpoint"]),
      plugin: optionalText(row["plugin"]),
    };
  }
  return {
    kind: "action",
    sourceId: String(row["source_id"]),
    recordKey: String(row["record_key"]),
    plugin: String(row["plugin"]),
    action: String(row["action"]),
    position: Number(row["position"]),
    batchKey: optionalText(row["batch_key"]),
  };
}

function claimed(row: SqlRow): Claimed {
  const lastError = row["last_error"];
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    target: targetOf(row),
    payload: String(row["payload"]),
    attempts: Number(row["attempts"]),
    createdAt: Number(row["created_at"]),
    alertRetryOf:
      typeof lastError === "string" && lastError.endsWith(ALERT_NOTE)
        ? lastError.slice(0, -ALERT_NOTE.length)
        : undefined,
  };
}

/** One try of a row: it succeeded, it failed and why, or it is to be closed untried again and why. */
type Attempted =
  | { readonly outcome: "done" }
  | { readonly outcome: "failed"; readonly failure: string }
  | { readonly outcome: "closed"; readonly reason: string }
  | { readonly outcome: "deferred"; readonly reason: string };

/** The same, a close carrying the report's list it lands in. */
type Tried =
  | Exclude<Attempted, { readonly outcome: "closed" }>
  | { readonly outcome: "closed"; readonly reason: string; readonly list: string[] };

/**
 * Closes a row untried (an action row, or a webhook a plugin queued that `refuseWebhook` refused),
 * as the row says: `superseded_at` and `gave_up_at` set, the reason in `last_error`.
 */
const CLOSE_UNTRIED = "superseded_at = $4::bigint, gave_up_at = $4::bigint, last_error = $5";

/** The reason a superseded row keeps: which later row replaced it. */
function supersededBy(laterId: string): string {
  return `superseded by delivery ${laterId}: a later decision queued the same action for this record`;
}

/** The clock minute an instant falls in. */
function minuteOf(at: number): TimeSpan {
  const start = Math.floor(at / DIGEST_MINUTE_MS) * DIGEST_MINUTE_MS;
  return { start, end: start + DIGEST_MINUTE_MS };
}

/**
 * Queues a plugin's action for delivery now: no URL, and the row names the record, the action and
 * its place; returns its delivery id. The outbox's `enqueue` does this, and so does a process that
 * only queues and delivers nothing (`facetdb review`: the running worker delivers its rows). A row
 * with a batch key whose minute already holds `DIGEST_AFTER` rows of that key is due at the
 * minute's end, when its digest goes: a guess that saves the loop claiming it before then, as two
 * processes queueing at once may both count nine. The digest rule at delivery decides, by the rows'
 * order in the store, whatever the guess was.
 */
export async function queueAction(
  client: OutboxDatabase,
  clock: Pick<Clock, "now">,
  entry: NewAction,
): Promise<string> {
  const now = clock.now();
  const minute = minuteOf(now);
  const rows = await client.query(
    `insert into facetdb.webhook_outbox
       (project_id, payload, created_at, next_attempt_at, source_id, record_key, plugin, action, position, batch_key)
     values ($1, $2, $3::bigint,
             case when $9::text is not null and (
               select count(*) from facetdb.webhook_outbox
                where project_id = $1 and batch_key = $9 and created_at >= $10::bigint and created_at < $11::bigint
             ) >= $12::integer then $11::bigint else $3::bigint end,
             $4, $5, $6, $7, $8::integer, $9)
     returning id::text as id`,
    [
      entry.projectId,
      JSON.stringify(entry.payload),
      now,
      entry.sourceId,
      entry.recordKey,
      entry.plugin,
      entry.action,
      entry.position,
      entry.batchKey ?? null,
      minute.start,
      minute.end,
      DIGEST_AFTER,
    ],
  );
  return String(rows[0]?.["id"]);
}

/**
 * A webhook an action queued (`origin.record`), unless the latest row queued for the same record
 * and place (whatever its endpoint) is this very delivery: waiting or delivered, to the same
 * endpoint, with the same payload. Then it is that row's id, and nothing is written; otherwise the
 * row is queued. Only the latest row is compared: an older equal one says nothing of what the
 * receiver holds now (a decision changed and changed back is queued again, `WebhookOrigin`). One
 * statement, the latest row read through the record's index (`webhook_outbox_action`, partial on
 * `plugin`, which such a row names), newest first, one row; the payloads are compared as JSON
 * without their `delivery`, so key order or a re-serialisation never splits one decision in two.
 * A latest row given up on does not count: the decision queued again gets another 24 hours. Two
 * processes queueing at the same instant can still both write the same decision (read committed,
 * no unique index without a store migration): the receiver keys deliveries by `delivery`.
 * Exported for the real-Postgres test that reads its plan.
 */
export const QUEUE_DECISION = `with latest as (
  select id, endpoint, payload, gave_up_at from facetdb.webhook_outbox
   where project_id = $2 and source_id = $6 and record_key = $7 and plugin = $8 and action = $9
     and position = $10::integer
   order by id desc
   limit 1
), earlier as (
  select id from latest
   where gave_up_at is null and endpoint = $3
     and (payload::jsonb - 'delivery') = ($4::text::jsonb - 'delivery')
), queued as (
  insert into facetdb.webhook_outbox
    (id, project_id, endpoint, payload, created_at, next_attempt_at, source_id, record_key, plugin, action, position)
  select $1::bigint, $2, $3, $4::text, $5::bigint, $5::bigint, $6, $7, $8, $9, $10::integer
   where not exists (select 1 from earlier)
  returning id
)
select id::text as id from queued
union all
select id::text as id from earlier`;

/**
 * Queues a webhook for delivery now; returns its delivery id. Its id is taken first, so a payload
 * can name it and the bytes signed include their own delivery id; the bytes stored are the bytes
 * signed and sent on every attempt. The outbox's `enqueue` does this, and so does a process that
 * only queues (`outboxQueue`: the worker's steps and channels, `facetdb review`).
 */
export async function queueWebhook(
  client: OutboxDatabase,
  clock: Pick<Clock, "now">,
  webhook: NewWebhook,
): Promise<string> {
  const url = new URL(webhook.endpoint);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("a webhook endpoint must be an http or https URL");
  }
  const now = clock.now();
  const reserved = await client.query(
    "select nextval(pg_get_serial_sequence('facetdb.webhook_outbox', 'id'))::text as id",
  );
  const id = String(reserved[0]?.["id"]);
  const payload = JSON.stringify("payloadOf" in webhook ? webhook.payloadOf(id) : webhook.payload);
  const { origin } = webhook;
  if (origin === undefined) {
    await client.query(
      `insert into facetdb.webhook_outbox (id, project_id, endpoint, payload, created_at, next_attempt_at)
       values ($1::bigint, $2, $3, $4, $5::bigint, $5::bigint)`,
      [id, webhook.projectId, webhook.endpoint, payload, now],
    );
    return id;
  }
  if (origin.record === undefined) {
    await client.query(
      `insert into facetdb.webhook_outbox (id, project_id, endpoint, payload, created_at, next_attempt_at, plugin, action)
       values ($1::bigint, $2, $3, $4, $5::bigint, $5::bigint, $6, $7)`,
      [id, webhook.projectId, webhook.endpoint, payload, now, origin.plugin, origin.entry],
    );
    return id;
  }
  const rows = await client.query(QUEUE_DECISION, [
    id,
    webhook.projectId,
    webhook.endpoint,
    payload,
    now,
    origin.record.sourceId,
    origin.record.recordKey,
    origin.plugin,
    origin.entry,
    origin.record.position,
  ]);
  return String(rows[0]?.["id"]);
}

/**
 * The outbox's `enqueue` alone, over the store's database: what a process queues through when it
 * delivers nothing itself (`facetdb review`), or before its outbox loop runs (the worker's steps,
 * built as its sources open, and its alert channels).
 */
export function outboxQueue(
  client: OutboxDatabase,
  clock: Pick<Clock, "now">,
): Pick<Outbox, "enqueue"> {
  return {
    enqueue: (entry) =>
      "plugin" in entry ? queueAction(client, clock, entry) : queueWebhook(client, clock, entry),
  };
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const { client, clock } = deps;
  const timeoutMs = deps.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs >= CLAIM_LEASE_MS) {
    throw new Error(
      `the webhook fetch timeout is ${timeoutMs} ms; it must be above 0 and below the claim lease (${CLAIM_LEASE_MS} ms), or a second loop could send a row the first is still sending. Set a shorter fetchTimeoutMs.`,
    );
  }
  const loopId = deps.loopId ?? randomUUID();
  // The claim takes no action row without a runner, so this one is never called: were it, the
  // attempt fails and is retried as any other, never dropped.
  const runner =
    deps.runAction ??
    (() => Promise.reject(new ActionFailed("this loop has no runner for plugin actions")));

  /**
   * Takes the due rows and pushes their `next_attempt_at` past the lease, so no other loop sends
   * them. A loop without an action runner takes webhooks only, and one with a runner for a project
   * takes that project's action rows only. A row that names a plugin is taken as an action row is,
   * whether it is an action or a webhook a plugin queued: that webhook is signed with its own
   * project's secret, which only that project's worker holds.
   */
  async function claim(now: number): Promise<Claimed[]> {
    const rows = await client.query(
      `update facetdb.webhook_outbox
          set attempts = attempts + 1, next_attempt_at = $1::bigint + $2::bigint, claimed_by = $4
        where id in (
          select id from facetdb.webhook_outbox
           where delivered_at is null and gave_up_at is null and next_attempt_at <= $1::bigint
             and (plugin is null or ($5::boolean and ($6::text is null or project_id = $6::text)))
           order by next_attempt_at, id
           limit $3
             for update skip locked)
        returning id::text as id, project_id, endpoint, payload, attempts, created_at::text as created_at,
                  last_error, source_id, record_key, plugin, action, position, batch_key`,
      [
        now,
        CLAIM_LEASE_MS,
        DELIVERY_BATCH,
        loopId,
        deps.runAction !== undefined,
        deps.actionProject ?? null,
      ],
    );
    return rows.map(claimed);
  }

  /**
   * The latest row queued after this one for the same record, plugin, action and place in the
   * pipeline (the partial index `webhook_outbox_action` finds it): a later decision's action. A
   * webhook a plugin queued is never one: it supersedes nothing and is never superseded.
   */
  async function laterRow(
    row: Claimed,
    target: Extract<Target, { kind: "action" }>,
  ): Promise<string | undefined> {
    const rows = await client.query(
      `select id::text as id from facetdb.webhook_outbox
        where project_id = $1 and source_id = $2 and record_key = $3 and plugin = $4 and action = $5
          and position = $6::integer and id > $7::bigint and endpoint is null
        order by webhook_outbox.id desc
        limit 1`,
      [
        row.projectId,
        target.sourceId,
        target.recordKey,
        target.plugin,
        target.action,
        target.position,
        row.id,
      ],
    );
    return optionalText(rows[0]?.["id"]);
  }

  /**
   * Writes an outcome only while this loop still holds the claim: the row carries this loop's id and
   * the attempt number the claim gave it. A row another loop took after the lease ran out has a
   * different attempt number, so a late update here changes nothing. `set` may use `$4` and up.
   */
  async function whileHeld(
    row: Claimed,
    set: string,
    params: readonly unknown[],
  ): Promise<boolean> {
    const updated = await client.query(
      `update facetdb.webhook_outbox set ${set}
        where id = $1::bigint and claimed_by = $2 and attempts = $3::integer
          and delivered_at is null and gave_up_at is null
        returning id`,
      [row.id, loopId, row.attempts, ...params],
    );
    return updated.length > 0;
  }

  /** Read through a call so a check before `work` ran does not narrow the signal to "not aborted". */
  function isAborted(signal: AbortSignal): boolean {
    return signal.aborted;
  }

  /**
   * Runs `work` for at most the timeout: past it, `work`'s signal aborts and this rejects with
   * `TimedOut` whether or not `work` honours the signal. The timeout bounds one send or one alert
   * only; when to send is the row's `next_attempt_at`, never a timer.
   */
  async function withinTimeout<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const signal = deps.abortAfter(timeoutMs);
    // An abort listener added after the abort never fires: a spent signal is a timeout at once.
    if (signal.aborted) {
      throw new TimedOut(timeoutMs);
    }
    const deadline = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new TimedOut(timeoutMs)), { once: true });
    });
    try {
      // `work` runs inside the race even when it throws before returning a promise.
      return await Promise.race([(async () => work(signal))(), deadline]);
    } catch (error) {
      // A `fetch` that honours the signal rejects on its own, maybe before `deadline` does. The
      // signal is read again here, not narrowed by the check above: it aborts while `work` runs.
      throw isAborted(signal) ? new TimedOut(timeoutMs) : error;
    }
  }

  /** One attempt; undefined when it succeeded, else the reason, in words that carry no URL or secret. */
  async function attempt(row: Claimed, endpoint: string, now: number): Promise<string | undefined> {
    // The secret is read inside the timeout too: a slow credential read cannot outlive the lease.
    // `as boolean`: the flag is set inside the closure below, which TypeScript does not follow.
    let sending = false as boolean;
    try {
      const response = await withinTimeout(async (signal) => {
        let secret: string;
        try {
          secret = await deps.secretFor(row.projectId, endpoint);
        } catch {
          throw new SecretUnreadable();
        }
        sending = true;
        return deps.fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WEBHOOK_SIGNATURE_HEADER]: sign(secret, Math.floor(now / 1000), row.payload),
            "facetdb-delivery": row.id,
          },
          body: row.payload,
          redirect: "manual",
          signal,
        });
      });
      return response.status >= 200 && response.status < 300
        ? undefined
        : `the receiver answered ${response.status}`;
    } catch (error) {
      if (error instanceof TimedOut) {
        return sending
          ? `the receiver did not answer within ${timeoutMs} ms`
          : `the signing secret could not be read within ${timeoutMs} ms`;
      }
      return error instanceof SecretUnreadable
        ? "the signing secret could not be read"
        : "the receiver could not be reached";
    }
  }

  /**
   * One attempt of a plugin's action through the runner, under the same timeout as a send: the
   * failure in words that carry no secret, a close the runner asked for, or neither when it ran.
   */
  async function act(
    row: Claimed,
    target: Extract<Target, { kind: "action" }>,
  ): Promise<Attempted> {
    try {
      const outcome = await withinTimeout((signal) =>
        runner(
          {
            deliveryId: row.id,
            projectId: row.projectId,
            sourceId: target.sourceId,
            recordKey: target.recordKey,
            plugin: target.plugin,
            action: target.action,
            position: target.position,
            // Read inside the attempt: a payload that cannot be read fails it, never the pass.
            payload: JSON.parse(row.payload) as unknown,
            batchKey: target.batchKey,
            attempt: row.attempts,
            queuedAt: row.createdAt,
          },
          signal,
        ),
      );
      if (outcome === undefined) {
        return { outcome: "done" };
      }
      return "close" in outcome
        ? { outcome: "closed", reason: outcome.close }
        : { outcome: "deferred", reason: outcome.defer };
    } catch (error) {
      if (error instanceof TimedOut) {
        return { outcome: "failed", failure: `the action did not finish within ${timeoutMs} ms` };
      }
      return {
        outcome: "failed",
        failure: error instanceof ActionFailed ? error.message : ACTION_ERROR_NOT_KEPT,
      };
    }
  }

  /**
   * The 24 hours are spent. Renews the lease, raises the alert under the timeout, then closes the
   * row; an alert that fails keeps the row open for one more try of the alert alone. `failure` is
   * the send failure the row ends on.
   */
  async function giveUp(
    row: Claimed,
    now: number,
    failure: string,
    report: {
      readonly retrying: string[];
      readonly gaveUp: string[];
      readonly lost: string[];
      readonly alertFailures: AlertFailure[];
    },
  ): Promise<void> {
    // Renew the lease first, from the clock's time now (the send took some of the claim's), and
    // never shorter than it was: it proves this loop still holds the row (a loop that lost it
    // raises no alert) and keeps the row ours for a whole lease, longer than the alert may take.
    // `last_error` is left alone: after a crash here it still says whether an earlier alert failed.
    const renewed = await whileHeld(
      row,
      "next_attempt_at = greatest(next_attempt_at, $4::bigint)",
      [clock.now() + CLAIM_LEASE_MS],
    );
    if (!renewed) {
      report.lost.push(row.id);
      return;
    }
    // The alert comes before the row is closed: a crash in between retries the row after the
    // lease and alerts again, where the other order would lose the alert for good.
    const retry = row.alertRetryOf !== undefined;
    // The alert's own retry claimed the row once more without sending.
    const attempts = retry ? row.attempts - 1 : row.attempts;
    const { target } = row;
    const event: WebhookGaveUp =
      target.kind === "webhook"
        ? {
            projectId: row.projectId,
            deliveryId: row.id,
            host: new URL(target.endpoint).host,
            attempts,
            queuedAt: row.createdAt,
          }
        : {
            projectId: row.projectId,
            deliveryId: row.id,
            sourceId: target.sourceId,
            plugin: target.plugin,
            action: target.action,
            attempts,
            queuedAt: row.createdAt,
          };
    try {
      await withinTimeout((signal) => deps.onGiveUp(event, signal, failure));
    } catch (error) {
      // An alert that failed keeps the row open for one more try of the alert, and only one: the
      // row says so in `last_error`, and that try closes it whatever happens.
      report.alertFailures.push({ event, error, final: retry });
      const note = `${failure}${ALERT_NOTE}`;
      if (retry) {
        const closed = await whileHeld(row, "gave_up_at = $4::bigint, last_error = $5", [
          now,
          note,
        ]);
        (closed ? report.gaveUp : report.lost).push(row.id);
      } else {
        const kept = await whileHeld(row, "next_attempt_at = $4::bigint, last_error = $5", [
          clock.now() + retryDelayMs(row.attempts),
          note,
        ]);
        (kept ? report.retrying : report.lost).push(row.id);
      }
      return;
    }
    const closed = await whileHeld(row, "gave_up_at = $4::bigint, last_error = $5", [now, failure]);
    (closed ? report.gaveUp : report.lost).push(row.id);
  }

  /**
   * The id of the `DIGEST_AFTER`th row a batch key queued in a minute, in the store's order (its
   * ids), or undefined while the minute holds fewer: a row at or below it is run alone, one above
   * it goes in the minute's digest. Every row queued counts, whatever became of it, so the answer
   * never changes once the minute is over.
   */
  async function lastAlone(
    projectId: string,
    batchKey: string,
    minute: TimeSpan,
  ): Promise<string | undefined> {
    const rows = await client.query(
      // Ordered by the column, not by the text it is answered as (`10` sorts before `9`).
      `select id::text as id from facetdb.webhook_outbox
        where project_id = $1 and batch_key = $2 and created_at >= $3::bigint and created_at < $4::bigint
        order by webhook_outbox.id
        offset $5::integer limit 1`,
      [projectId, batchKey, minute.start, minute.end, DIGEST_AFTER - 1],
    );
    return optionalText(rows[0]?.["id"]);
  }

  /**
   * Where the digest rule puts a batched row due now: held while its channel is quiet (every due
   * row of its batch with it) until the quiet period ends; in the digest of the quiet period it was
   * queued in, once that ended; run alone when it is one of the first `DIGEST_AFTER` of its minute;
   * else held until its minute ends (with the minute's other due rows past the first ones), then in
   * that minute's digest.
   */
  async function place(row: Claimed, target: Batched, now: number): Promise<Placement> {
    const quietNow = deps.quietPeriod?.(target.batchKey, now);
    if (quietNow !== undefined) {
      return {
        kind: "held",
        until: quietNow.end,
        reason: HELD_FOR_QUIET,
        window: EVERY_TIME,
        after: "0",
      };
    }
    const quietThen = deps.quietPeriod?.(target.batchKey, row.createdAt);
    if (quietThen !== undefined) {
      return { kind: "digest", window: { kind: "quiet", ...quietThen }, after: "0" };
    }
    const minute = minuteOf(row.createdAt);
    const last = await lastAlone(row.projectId, target.batchKey, minute);
    if (last === undefined || BigInt(row.id) <= BigInt(last)) {
      return { kind: "alone" };
    }
    if (now < minute.end) {
      return {
        kind: "held",
        until: minute.end,
        reason: HELD_FOR_DIGEST,
        window: minute,
        after: last,
      };
    }
    return { kind: "digest", window: { kind: "minute", ...minute }, after: last };
  }

  /**
   * Holds a claimed batched row until `until`, giving back the attempt it was claimed for, then
   * the other due rows of its window past `after`, so the loop does not claim each of them in turn
   * only to hold it. A row another loop holds (its lease runs, so it is not due) is left alone, and
   * so is one awaiting its give-up alert's one more try (`notAwaitingAlert`): its note stays.
   */
  async function hold(
    row: Claimed,
    target: Batched,
    placement: Extract<Placement, { readonly kind: "held" }>,
    now: number,
  ): Promise<boolean> {
    const held = await whileHeld(
      row,
      "attempts = attempts - 1, next_attempt_at = $4::bigint, last_error = $5",
      [placement.until, placement.reason],
    );
    if (held) {
      await client.query(
        `update facetdb.webhook_outbox set next_attempt_at = $5::bigint, last_error = $8
          where project_id = $1 and batch_key = $2 and created_at >= $3::bigint and created_at < $4::bigint
            and id > $6::bigint and delivered_at is null and gave_up_at is null
            and next_attempt_at <= $7::bigint and ${notAwaitingAlert("$9")}`,
        [
          row.projectId,
          target.batchKey,
          placement.window.start,
          placement.window.end,
          placement.until,
          placement.after,
          now,
          placement.reason,
          ALERT_NOTE,
        ],
      );
    }
    return held;
  }

  /**
   * Takes every open row of a digest for this loop: the rows this pass claimed (`mine`, already
   * counted an attempt) and every due one of the window past `after` that no other loop holds, each
   * counted an attempt and leased as a claim leases. Oldest first. A row awaiting its give-up
   * alert's one more try is never taken: its 24 hours are spent, and only its alert is tried.
   */
  async function gather(group: DigestGroup, now: number): Promise<Member[]> {
    const { mine, window } = group;
    const rows = await client.query(
      `update facetdb.webhook_outbox
          set attempts = case when id = any($7::bigint[]) then attempts else attempts + 1 end,
              next_attempt_at = $6::bigint + $9::bigint, claimed_by = $8
        where id in (
          select id from facetdb.webhook_outbox
           where project_id = $1 and batch_key = $2 and created_at >= $3::bigint and created_at < $4::bigint
             and id > $5::bigint and delivered_at is null and gave_up_at is null
             and (next_attempt_at <= $6::bigint or (id = any($7::bigint[]) and claimed_by = $8))
             and ${notAwaitingAlert("$10")}
           order by id
             for update skip locked)
        returning id::text as id, record_key, payload, attempts, created_at::text as created_at`,
      [
        group.projectId,
        group.target.batchKey,
        window.start,
        window.end,
        group.after,
        now,
        mine.map((row) => row.id),
        loopId,
        CLAIM_LEASE_MS,
        ALERT_NOTE,
      ],
    );
    return rows
      .map((row) => ({
        id: String(row["id"]),
        recordKey: String(row["record_key"]),
        payload: String(row["payload"]),
        attempts: Number(row["attempts"]),
        createdAt: Number(row["created_at"]),
      }))
      .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  /**
   * `whileHeld` for every row of a digest at once: each is written only while this loop holds it
   * at the attempt it gathered it with. Answers the ids written; `set` may use `$4` and up, and no
   * column on its right side (the update joins the list of rows).
   */
  async function whileHeldAll(
    members: readonly Member[],
    set: string,
    params: readonly unknown[],
  ): Promise<ReadonlySet<string>> {
    const updated = await client.query(
      `update facetdb.webhook_outbox o set ${set}
         from unnest($1::bigint[], $2::integer[]) as gathered(id, attempts)
        where o.id = gathered.id and o.attempts = gathered.attempts and o.claimed_by = $3
          and o.delivered_at is null and o.gave_up_at is null
        returning o.id::text as id`,
      [
        members.map((member) => member.id),
        members.map((member) => member.attempts),
        loopId,
        ...params,
      ],
    );
    return new Set(updated.map((row) => String(row["id"])));
  }

  /** One attempt of a digest through its runner, under the same timeout as a send. */
  async function digestAttempt(
    run: NonNullable<OutboxDeps["runDigest"]>,
    digest: Omit<DigestDelivery, "rows">,
    members: readonly Member[],
  ): Promise<Exclude<Attempted, { readonly outcome: "deferred" }>> {
    try {
      const outcome = await withinTimeout((signal) =>
        run(
          {
            ...digest,
            // Read inside the attempt: a payload that cannot be read fails it, never the pass.
            rows: members.map((member) => ({
              deliveryId: member.id,
              recordKey: member.recordKey,
              payload: JSON.parse(member.payload) as unknown,
              queuedAt: member.createdAt,
            })),
          },
          signal,
        ),
      );
      return outcome === undefined
        ? { outcome: "done" }
        : { outcome: "closed", reason: outcome.close };
    } catch (error) {
      if (error instanceof TimedOut) {
        return { outcome: "failed", failure: `the digest did not finish within ${timeoutMs} ms` };
      }
      return {
        outcome: "failed",
        failure: error instanceof ActionFailed ? error.message : ACTION_ERROR_NOT_KEPT,
      };
    }
  }

  /**
   * One digest: its rows gathered, handed to the runner together, and every row written with the
   * one outcome. A failure reschedules them all on the oldest row's attempt; past the 24 hours of
   * its oldest row, that row is given up with its alert (`giveUp`, which keeps it open for one more
   * try of a failed alert) and the others are closed with it, so one digest raises one alert.
   */
  async function sendDigest(
    run: NonNullable<OutboxDeps["runDigest"]>,
    group: DigestGroup,
    now: number,
    lists: {
      readonly delivered: string[];
      readonly closed: string[];
      readonly retrying: string[];
      readonly gaveUp: string[];
      readonly lost: string[];
      readonly alertFailures: AlertFailure[];
    },
  ): Promise<void> {
    const { target } = group;
    const members = await gather(group, now);
    const gathered = new Set(members.map((member) => member.id));
    // A row this pass claimed that the gathering did not take was taken by another loop since.
    lists.lost.push(...group.mine.filter((row) => !gathered.has(row.id)).map((row) => row.id));
    const [oldest] = members;
    if (oldest === undefined) {
      return;
    }
    const tried = await digestAttempt(
      run,
      {
        projectId: group.projectId,
        sourceId: target.sourceId,
        plugin: target.plugin,
        action: target.action,
        position: target.position,
        batchKey: target.batchKey,
        window: group.window,
        attempt: oldest.attempts,
      },
      members,
    );
    const settle = async (
      list: string[],
      set: string,
      params: readonly unknown[],
      of = members,
    ) => {
      const written = await whileHeldAll(of, set, params);
      for (const member of of) {
        (written.has(member.id) ? list : lists.lost).push(member.id);
      }
    };
    if (tried.outcome === "done") {
      await settle(lists.delivered, "delivered_at = $4::bigint, last_error = null", [now]);
      return;
    }
    if (tried.outcome === "closed") {
      await settle(lists.closed, CLOSE_UNTRIED, [now, tried.reason]);
      return;
    }
    const queuedAt = Math.min(...members.map((member) => member.createdAt));
    const deadline = queuedAt + GIVE_UP_AFTER_MS;
    if (now < deadline) {
      const next = Math.min(now + retryDelayMs(oldest.attempts), deadline);
      await settle(lists.retrying, "next_attempt_at = $4::bigint, last_error = $5", [
        next,
        tried.failure,
      ]);
      return;
    }
    // The alert first, as for one row: a crash before the others are closed gives them up again
    // after the lease, and the alert's 30-minute rule absorbs the second raise.
    const failuresBefore = lists.alertFailures.length;
    await giveUp(
      {
        id: oldest.id,
        projectId: group.projectId,
        target: { ...target, recordKey: oldest.recordKey },
        payload: oldest.payload,
        attempts: oldest.attempts,
        createdAt: queuedAt,
        alertRetryOf: undefined,
      },
      now,
      tried.failure,
      lists,
    );
    const others = members.slice(1);
    if (others.length > 0) {
      // Said as it went: the alert raised, kept for one more try on the oldest row, or not raised
      // by this loop at all because another took the oldest row.
      const alert =
        lists.alertFailures.length > failuresBefore
          ? `its alert could not be raised, and delivery ${oldest.id} tries it once more`
          : lists.lost.includes(oldest.id)
            ? `its alert is delivery ${oldest.id}'s, which another worker took`
            : `delivery ${oldest.id} raised its alert`;
      await settle(
        lists.gaveUp,
        "gave_up_at = $4::bigint, last_error = $5",
        [now, `${tried.failure} (given up with its digest; ${alert})`],
        others,
      );
    }
  }

  return {
    ...outboxQueue(client, clock),

    async deliverDue(now) {
      const delivered: string[] = [];
      const retrying: string[] = [];
      const gaveUp: string[] = [];
      const superseded: string[] = [];
      const closed: string[] = [];
      const deferred: string[] = [];
      const held: string[] = [];
      const lost: string[] = [];
      const alertFailures: AlertFailure[] = [];

      const report = { retrying, gaveUp, lost, alertFailures };

      /** The row's one try now: done, failed with a reason, or to be closed untried again. */
      async function tryRow(row: Claimed): Promise<Tried> {
        const { target } = row;
        if (target.kind === "webhook") {
          // A webhook a plugin queued is sent only while its process still allows its endpoint.
          const refused =
            target.plugin === undefined
              ? undefined
              : deps.refuseWebhook?.({
                  projectId: row.projectId,
                  plugin: target.plugin,
                  endpoint: target.endpoint,
                });
          if (refused !== undefined) {
            return { outcome: "closed", reason: refused, list: closed };
          }
          const failure = await attempt(row, target.endpoint, now);
          return failure === undefined ? { outcome: "done" } : { outcome: "failed", failure };
        }
        // A later decision's action replaces this one; it is closed, untried.
        const later = await laterRow(row, target);
        if (later !== undefined) {
          return { outcome: "closed", reason: supersededBy(later), list: superseded };
        }
        const ran = await act(row, target);
        return ran.outcome === "closed" ? { ...ran, list: closed } : ran;
      }

      /** One row's attempt and its outcome written, as every row was before the digest rule. */
      async function deliverRow(row: Claimed): Promise<void> {
        if (row.alertRetryOf !== undefined) {
          // The webhook's 24 hours were spent when its alert failed: only the alert is retried.
          await giveUp(row, now, row.alertRetryOf, report);
          return;
        }
        const tried = await tryRow(row);
        if (tried.outcome === "closed") {
          const kept = await whileHeld(row, CLOSE_UNTRIED, [now, tried.reason]);
          (kept ? tried.list : lost).push(row.id);
          return;
        }
        if (tried.outcome === "done") {
          const kept = await whileHeld(row, "delivered_at = $4::bigint, last_error = null", [now]);
          (kept ? delivered : lost).push(row.id);
          return;
        }
        if (tried.outcome === "deferred") {
          // A wait, not a failure: the claim's attempt is given back and no give-up is judged.
          const kept = await whileHeld(
            row,
            "attempts = attempts - 1, next_attempt_at = $4::bigint, last_error = $5",
            [now + ACTION_DEFER_MS, tried.reason],
          );
          (kept ? deferred : lost).push(row.id);
          return;
        }
        // The last attempt falls exactly on the deadline; a failure at or after it is the end.
        const deadline = row.createdAt + GIVE_UP_AFTER_MS;
        if (now >= deadline) {
          await giveUp(row, now, tried.failure, report);
          return;
        }
        const next = Math.min(now + retryDelayMs(row.attempts), deadline);
        const rescheduled = await whileHeld(row, "next_attempt_at = $4::bigint, last_error = $5", [
          next,
          tried.failure,
        ]);
        (rescheduled ? retrying : lost).push(row.id);
      }

      const rows = await claim(now);
      // A row with a batch key is placed by the digest rule when this loop runs digests; every
      // other row, and one whose alert is to be raised again, is delivered as before.
      const { runDigest } = deps;
      const batched: { readonly row: Claimed; readonly target: Batched }[] = [];
      const single: Claimed[] = [];
      for (const row of rows) {
        const { target } = row;
        if (
          runDigest !== undefined &&
          row.alertRetryOf === undefined &&
          target.kind === "action" &&
          target.batchKey !== undefined
        ) {
          batched.push({ row, target: { ...target, batchKey: target.batchKey } });
        } else {
          single.push(row);
        }
      }
      // Every other row starts at once, as every row did before the digest rule: a store error while
      // placing holds none of them up. It is observed below, so an early rejection is not unhandled.
      const plain = Promise.all(single.map(deliverRow));
      plain.catch(() => undefined);
      const placed = await Promise.allSettled(
        batched.map(async (entry) => ({
          ...entry,
          placement: await place(entry.row, entry.target, now),
        })),
      );
      const alone: Claimed[] = [];
      const digests = new Map<string, DigestGroup>();
      const holds: Promise<void>[] = [];
      /** The first placement the store failed: its row waits out its lease, placed again then. */
      let unplaced: { readonly error: unknown } | undefined;
      for (const outcome of placed) {
        if (outcome.status === "rejected") {
          unplaced ??= { error: outcome.reason };
          continue;
        }
        const { row, target, placement } = outcome.value;
        if (placement.kind === "alone") {
          alone.push(row);
        } else if (placement.kind === "held") {
          holds.push(
            hold(row, target, placement, now).then((kept) => {
              (kept ? held : lost).push(row.id);
            }),
          );
        } else {
          const key = JSON.stringify([row.projectId, target.batchKey, placement.window]);
          const group = digests.get(key);
          digests.set(key, {
            projectId: row.projectId,
            mine: [...(group?.mine ?? []), row],
            target,
            window: placement.window,
            after: placement.after,
          });
        }
      }
      const lists = { delivered, closed, retrying, gaveUp, lost, alertFailures };
      await Promise.all([
        plain,
        ...alone.map(deliverRow),
        ...holds,
        ...(runDigest === undefined
          ? []
          : [...digests.values()].map((group) => sendDigest(runDigest, group, now, lists))),
      ]);
      // Said once every other row of the pass has run: the pass failed for the rows not placed.
      if (unplaced !== undefined) {
        throw unplaced.error;
      }
      return {
        delivered,
        retrying,
        gaveUp,
        superseded,
        closed,
        deferred,
        held,
        lost,
        alertFailures,
      };
    },
  };
}
