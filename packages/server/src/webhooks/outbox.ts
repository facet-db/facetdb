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
  /** The signing secret of the project's endpoint, from the encrypted credential store. */
  secretFor(projectId: string, endpoint: string): Promise<string>;
  /**
   * Raises the alert event for a webhook or an action given up on, within the send timeout
   * (`signal` aborts when it runs out); `lastError` is the failure the row ends on, in the words
   * `last_error` keeps. May run twice for one row after a crash, or after an alert that failed.
   */
  onGiveUp(event: WebhookGaveUp, signal: AbortSignal, lastError: string): Promise<void>;
  /**
   * Runs one attempt of a plugin's action, within the send timeout (`signal` aborts when it runs
   * out): resolves when it succeeded or with `ActionClose` when the row must be closed untried
   * again; throws (`ActionFailed` for words worth keeping) when the attempt failed, which is
   * retried on the webhook's schedule. An outbox without a runner sends webhooks only and leaves
   * action rows to the loop that has one.
   */
  readonly runAction?: (
    row: ActionDelivery,
    signal: AbortSignal,
  ) => Promise<ActionClose | undefined>;
};

export type NewWebhook = {
  readonly projectId: string;
  /** The URL to POST to (https, or http for a receiver on the same machine). */
  readonly endpoint: string;
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
  /** Action rows their runner closed with a reason (`ActionClose`). */
  readonly closed: readonly string[];
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
  | { readonly kind: "webhook"; readonly endpoint: string }
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

const ALERT_NOTE = `; ${ALERT_NOT_RAISED}`;

/** A text column that may be null, as the row holds it. */
function optionalText(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

function targetOf(row: SqlRow): Target {
  // The store's check (`webhook_outbox_endpoint_or_plugin`) holds an endpoint or a plugin.
  if (row["plugin"] === null || row["plugin"] === undefined) {
    return { kind: "webhook", endpoint: String(row["endpoint"]) };
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
  | { readonly outcome: "closed"; readonly reason: string };

/** The same, a close carrying the report's list it lands in. */
type Tried =
  | Exclude<Attempted, { readonly outcome: "closed" }>
  | { readonly outcome: "closed"; readonly reason: string; readonly list: string[] };

/** Closes an action row untried, as the row says: `superseded_at` and `gave_up_at` set, the reason in `last_error`. */
const CLOSE_UNTRIED = "superseded_at = $4::bigint, gave_up_at = $4::bigint, last_error = $5";

/** The reason a superseded row keeps: which later row replaced it. */
function supersededBy(laterId: string): string {
  return `superseded by delivery ${laterId}: a later decision queued the same action for this record`;
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
   * them. A loop without an action runner takes webhooks only.
   */
  async function claim(now: number): Promise<Claimed[]> {
    const rows = await client.query(
      `update facetdb.webhook_outbox
          set attempts = attempts + 1, next_attempt_at = $1::bigint + $2::bigint, claimed_by = $4
        where id in (
          select id from facetdb.webhook_outbox
           where delivered_at is null and gave_up_at is null and next_attempt_at <= $1::bigint
             and ($5::boolean or plugin is null)
           order by next_attempt_at, id
           limit $3
             for update skip locked)
        returning id::text as id, project_id, endpoint, payload, attempts, created_at::text as created_at,
                  last_error, source_id, record_key, plugin, action, position, batch_key`,
      [now, CLAIM_LEASE_MS, DELIVERY_BATCH, loopId, deps.runAction !== undefined],
    );
    return rows.map(claimed);
  }

  /**
   * The latest row queued after this one for the same record, plugin, action and place in the
   * pipeline (the partial index `webhook_outbox_action` finds it): a later decision's action.
   */
  async function laterRow(
    row: Claimed,
    target: Extract<Target, { kind: "action" }>,
  ): Promise<string | undefined> {
    const rows = await client.query(
      `select id::text as id from facetdb.webhook_outbox
        where project_id = $1 and source_id = $2 and record_key = $3 and plugin = $4 and action = $5
          and position = $6::integer and id > $7::bigint
        order by id desc
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
      return outcome === undefined
        ? { outcome: "done" }
        : { outcome: "closed", reason: outcome.close };
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

  /** Queues a plugin's action: no URL, and the row names the record, the action and its place. */
  async function enqueueAction(entry: NewAction): Promise<string> {
    const now = clock.now();
    const rows = await client.query(
      `insert into facetdb.webhook_outbox
         (project_id, payload, created_at, next_attempt_at, source_id, record_key, plugin, action, position, batch_key)
       values ($1, $2, $3::bigint, $3::bigint, $4, $5, $6, $7, $8::integer, $9)
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
      ],
    );
    return String(rows[0]?.["id"]);
  }

  return {
    async enqueue(webhook) {
      if ("plugin" in webhook) {
        return enqueueAction(webhook);
      }
      const url = new URL(webhook.endpoint);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("a webhook endpoint must be an http or https URL");
      }
      const now = clock.now();
      // The id is taken first so a payload can name it: the bytes signed include their own delivery id.
      const reserved = await client.query(
        "select nextval(pg_get_serial_sequence('facetdb.webhook_outbox', 'id'))::text as id",
      );
      const id = String(reserved[0]?.["id"]);
      const payload = "payloadOf" in webhook ? webhook.payloadOf(id) : webhook.payload;
      await client.query(
        `insert into facetdb.webhook_outbox (id, project_id, endpoint, payload, created_at, next_attempt_at)
         values ($1::bigint, $2, $3, $4, $5::bigint, $5::bigint)`,
        [id, webhook.projectId, webhook.endpoint, JSON.stringify(payload), now],
      );
      return id;
    },

    async deliverDue(now) {
      const delivered: string[] = [];
      const retrying: string[] = [];
      const gaveUp: string[] = [];
      const superseded: string[] = [];
      const closed: string[] = [];
      const lost: string[] = [];
      const alertFailures: AlertFailure[] = [];

      const report = { retrying, gaveUp, lost, alertFailures };

      /** The row's one try now: done, failed with a reason, or to be closed untried again. */
      async function tryRow(row: Claimed): Promise<Tried> {
        const { target } = row;
        if (target.kind === "webhook") {
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

      const rows = await claim(now);
      await Promise.all(
        rows.map(async (row) => {
          if (row.alertRetryOf !== undefined) {
            // The webhook's 24 hours were spent when its alert failed: only the alert is retried.
            await giveUp(row, now, row.alertRetryOf, report);
            return;
          }
          const tried = await tryRow(row);
          if (tried.outcome === "closed") {
            const held = await whileHeld(row, CLOSE_UNTRIED, [now, tried.reason]);
            (held ? tried.list : lost).push(row.id);
            return;
          }
          if (tried.outcome === "done") {
            const held = await whileHeld(row, "delivered_at = $4::bigint, last_error = null", [
              now,
            ]);
            (held ? delivered : lost).push(row.id);
            return;
          }
          // The last attempt falls exactly on the deadline; a failure at or after it is the end.
          const deadline = row.createdAt + GIVE_UP_AFTER_MS;
          if (now >= deadline) {
            await giveUp(row, now, tried.failure, report);
            return;
          }
          const next = Math.min(now + retryDelayMs(row.attempts), deadline);
          const rescheduled = await whileHeld(
            row,
            "next_attempt_at = $4::bigint, last_error = $5",
            [next, tried.failure],
          );
          (rescheduled ? retrying : lost).push(row.id);
        }),
      );
      return { delivered, retrying, gaveUp, superseded, closed, lost, alertFailures };
    },
  };
}
