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
 * One send gets this long (a constructor option): well below the lease, so the loop that claimed a
 * row has finished with it, one way or the other, before another loop may claim it again.
 */
export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
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

/** A webhook that was not delivered within 24 hours; the composition root turns it into an alert. */
export type WebhookGaveUp = {
  readonly projectId: string;
  readonly deliveryId: string;
  /** The host only: the full URL may be a secret by itself. */
  readonly host: string;
  readonly attempts: number;
  readonly queuedAt: number;
};

export type OutboxDeps = {
  readonly client: OutboxDatabase;
  readonly clock: Clock;
  readonly fetch: WebhookFetch;
  /**
   * How long one send may take before it counts as a failed attempt: above 0 and below
   * `CLAIM_LEASE_MS` (anything else is refused when the outbox is created); defaults to
   * `DEFAULT_FETCH_TIMEOUT_MS`. It is wall time, not the clock's.
   */
  readonly fetchTimeoutMs?: number;
  /** Names this loop on the rows it claims; defaults to a fresh UUID per outbox. */
  readonly loopId?: string;
  /** The signing secret of the project's endpoint, from the encrypted credential store. */
  secretFor(projectId: string, endpoint: string): Promise<string>;
  /** Raises the alert event for a webhook given up on. May run twice for one webhook after a crash. */
  onGiveUp(event: WebhookGaveUp): Promise<void>;
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
   * Sent, but this loop no longer held the claim when it came to record the outcome (its lease ran
   * out and another loop took the row): nothing was written and no alert was raised.
   */
  readonly lost: readonly string[];
  /** Alerts that could not be raised for a webhook given up on; reported, never swallowed. */
  readonly alertFailures: readonly unknown[];
};

/**
 * The outbox reads and writes `facetdb.webhook_outbox` and never creates it: the table is a store
 * migration (@facetdb/postgres, `store/schema.ts`), made by `facetdb migrate` with the admin
 * credential and granted to the worker login, which may not create tables.
 */
export type Outbox = {
  /** Queues a webhook for delivery now; returns its delivery id. */
  enqueue(webhook: NewWebhook): Promise<string>;
  /** Sends every webhook whose `next_attempt_at` is at or before `now`; the worker loop calls it each pass. */
  deliverDue(now: number): Promise<DeliveryReport>;
};

type Claimed = {
  readonly id: string;
  readonly projectId: string;
  readonly endpoint: string;
  readonly payload: string;
  readonly attempts: number;
  readonly createdAt: number;
};

function claimed(row: SqlRow): Claimed {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    endpoint: String(row["endpoint"]),
    payload: String(row["payload"]),
    attempts: Number(row["attempts"]),
    createdAt: Number(row["created_at"]),
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

  /** Takes the due rows and pushes their `next_attempt_at` past the lease, so no other loop sends them. */
  async function claim(now: number): Promise<Claimed[]> {
    const rows = await client.query(
      `update facetdb.webhook_outbox
          set attempts = attempts + 1, next_attempt_at = $1::bigint + $2::bigint, claimed_by = $4
        where id in (
          select id from facetdb.webhook_outbox
           where delivered_at is null and gave_up_at is null and next_attempt_at <= $1::bigint
           order by next_attempt_at, id
           limit $3
             for update skip locked)
        returning id::text as id, project_id, endpoint, payload, attempts, created_at::text as created_at`,
      [now, CLAIM_LEASE_MS, DELIVERY_BATCH, loopId],
    );
    return rows.map(claimed);
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

  /** One attempt; undefined when it succeeded, else the reason, in words that carry no URL or secret. */
  async function attempt(row: Claimed, now: number): Promise<string | undefined> {
    let secret: string;
    try {
      secret = await deps.secretFor(row.projectId, row.endpoint);
    } catch {
      return "the signing secret could not be read";
    }
    // The timeout bounds one send only; when to send is the row's `next_attempt_at`, never a timer.
    // The platform's timeout signal is unref'd, so an idle process is not kept alive by it.
    const signal = AbortSignal.timeout(timeoutMs);
    const deadline = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
    });
    try {
      const response = await Promise.race([
        deps.fetch(row.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WEBHOOK_SIGNATURE_HEADER]: sign(secret, Math.floor(now / 1000), row.payload),
            "facetdb-delivery": row.id,
          },
          body: row.payload,
          redirect: "manual",
          signal,
        }),
        deadline,
      ]);
      return response.status >= 200 && response.status < 300
        ? undefined
        : `the receiver answered ${response.status}`;
    } catch {
      return signal.aborted
        ? `the receiver did not answer within ${timeoutMs} ms`
        : "the receiver could not be reached";
    }
  }

  return {
    async enqueue(webhook) {
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
      const lost: string[] = [];
      const alertFailures: unknown[] = [];

      const rows = await claim(now);
      await Promise.all(
        rows.map(async (row) => {
          const failure = await attempt(row, now);
          if (failure === undefined) {
            const held = await whileHeld(row, "delivered_at = $4::bigint, last_error = null", [
              now,
            ]);
            (held ? delivered : lost).push(row.id);
            return;
          }
          // The last attempt falls exactly on the deadline; a failure at or after it is the end.
          const deadline = row.createdAt + GIVE_UP_AFTER_MS;
          if (now >= deadline) {
            // Renew the lease first: it proves this loop still holds the row (a loop that lost it
            // raises no alert) and keeps the row ours while the alert goes out.
            const renewed = await whileHeld(
              row,
              "next_attempt_at = $4::bigint + $5::bigint, last_error = $6",
              [now, CLAIM_LEASE_MS, failure],
            );
            if (!renewed) {
              lost.push(row.id);
              return;
            }
            // The alert comes before the row is closed: a crash in between retries the row after the
            // lease and alerts again, where the other order would lose the alert for good.
            try {
              await deps.onGiveUp({
                projectId: row.projectId,
                deliveryId: row.id,
                host: new URL(row.endpoint).host,
                attempts: row.attempts,
                queuedAt: row.createdAt,
              });
            } catch (error) {
              alertFailures.push(error);
            }
            const closed = await whileHeld(row, "gave_up_at = $4::bigint, last_error = $5", [
              now,
              failure,
            ]);
            (closed ? gaveUp : lost).push(row.id);
            return;
          }
          const next = Math.min(now + retryDelayMs(row.attempts), deadline);
          const rescheduled = await whileHeld(
            row,
            "next_attempt_at = $4::bigint, last_error = $5",
            [next, failure],
          );
          (rescheduled ? retrying : lost).push(row.id);
        }),
      );
      return { delivered, retrying, gaveUp, lost, alertFailures };
    },
  };
}
