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
export const DELIVERY_BATCH = 20;

/** How long to wait after the `attempt`th failed attempt (1 is the first): 10 s, 20 s, … capped at 1 h. */
export function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_FIRST_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

/** What the outbox needs from `fetch`; the composition root passes the real one (with its own timeout). */
export type WebhookFetch = (
  url: string,
  init: {
    readonly method: "POST";
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string;
    /** A redirect is not followed: a 3xx counts as a failed attempt. */
    readonly redirect: "manual";
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
  /** The signing secret of the project's endpoint, from the encrypted credential store. */
  secretFor(projectId: string, endpoint: string): Promise<string>;
  /** Raises the alert event for a webhook given up on. */
  onGiveUp(event: WebhookGaveUp): Promise<void>;
};

export type NewWebhook = {
  readonly projectId: string;
  /** The URL to POST to (https, or http for a receiver on the same machine). */
  readonly endpoint: string;
  /** Serialised once here: the bytes stored are the bytes signed and sent, on every attempt. */
  readonly payload: unknown;
};

export type DeliveryReport = {
  readonly delivered: readonly string[];
  /** Failed this time and scheduled again. */
  readonly retrying: readonly string[];
  readonly gaveUp: readonly string[];
  /** Alerts that could not be raised for a webhook given up on; reported, never swallowed. */
  readonly alertFailures: readonly unknown[];
};

export type Outbox = {
  /** Creates `facetdb.webhook_outbox` when it is missing. */
  install(): Promise<void>;
  /** Queues a webhook for delivery now; returns its delivery id. */
  enqueue(webhook: NewWebhook): Promise<string>;
  /** Sends every webhook whose `next_attempt_at` is at or before `now`; the worker loop calls it each pass. */
  deliverDue(now: number): Promise<DeliveryReport>;
};

const TABLE = `create table if not exists facetdb.webhook_outbox (
  id bigserial primary key,
  project_id text not null,
  endpoint text not null,
  payload text not null,
  attempts integer not null default 0,
  created_at bigint not null,
  next_attempt_at bigint not null,
  delivered_at bigint,
  gave_up_at bigint,
  last_error text
)`;
const INDEX = `create index if not exists webhook_outbox_due on facetdb.webhook_outbox (next_attempt_at)
  where delivered_at is null and gave_up_at is null`;

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

  /** Takes the due rows and pushes their `next_attempt_at` past the lease, so no other loop sends them. */
  async function claim(now: number): Promise<Claimed[]> {
    const rows = await client.query(
      `update facetdb.webhook_outbox
          set attempts = attempts + 1, next_attempt_at = $1::bigint + $2::bigint
        where id in (
          select id from facetdb.webhook_outbox
           where delivered_at is null and gave_up_at is null and next_attempt_at <= $1::bigint
           order by next_attempt_at, id
           limit $3
             for update skip locked)
        returning id::text as id, project_id, endpoint, payload, attempts, created_at::text as created_at`,
      [now, CLAIM_LEASE_MS, DELIVERY_BATCH],
    );
    return rows.map(claimed);
  }

  /** One attempt; undefined when it succeeded, else the reason, in words that carry no URL or secret. */
  async function attempt(row: Claimed, now: number): Promise<string | undefined> {
    let secret: string;
    try {
      secret = await deps.secretFor(row.projectId, row.endpoint);
    } catch {
      return "the signing secret could not be read";
    }
    try {
      const response = await deps.fetch(row.endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [WEBHOOK_SIGNATURE_HEADER]: sign(secret, Math.floor(now / 1000), row.payload),
          "facetdb-delivery": row.id,
        },
        body: row.payload,
        redirect: "manual",
      });
      return response.status >= 200 && response.status < 300
        ? undefined
        : `the receiver answered ${response.status}`;
    } catch {
      return "the receiver could not be reached";
    }
  }

  return {
    async install() {
      await client.query(TABLE);
      await client.query(INDEX);
    },

    async enqueue(webhook) {
      const url = new URL(webhook.endpoint);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        throw new Error("a webhook endpoint must be an http or https URL");
      }
      const now = clock.now();
      const rows = await client.query(
        `insert into facetdb.webhook_outbox (project_id, endpoint, payload, created_at, next_attempt_at)
         values ($1, $2, $3, $4::bigint, $4::bigint) returning id::text as id`,
        [webhook.projectId, webhook.endpoint, JSON.stringify(webhook.payload), now],
      );
      return String(rows[0]?.["id"]);
    },

    async deliverDue(now) {
      const delivered: string[] = [];
      const retrying: string[] = [];
      const gaveUp: string[] = [];
      const alertFailures: unknown[] = [];

      const rows = await claim(now);
      await Promise.all(
        rows.map(async (row) => {
          const failure = await attempt(row, now);
          if (failure === undefined) {
            await client.query(
              "update facetdb.webhook_outbox set delivered_at = $2::bigint, last_error = null where id = $1::bigint",
              [row.id, now],
            );
            delivered.push(row.id);
            return;
          }
          // The last attempt falls exactly on the deadline; a failure at or after it is the end.
          const deadline = row.createdAt + GIVE_UP_AFTER_MS;
          if (now >= deadline) {
            await client.query(
              "update facetdb.webhook_outbox set gave_up_at = $2::bigint, last_error = $3 where id = $1::bigint",
              [row.id, now, failure],
            );
            gaveUp.push(row.id);
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
            return;
          }
          const next = Math.min(now + retryDelayMs(row.attempts), deadline);
          await client.query(
            "update facetdb.webhook_outbox set next_attempt_at = $2::bigint, last_error = $3 where id = $1::bigint",
            [row.id, next, failure],
          );
          retrying.push(row.id);
        }),
      );
      return { delivered, retrying, gaveUp, alertFailures };
    },
  };
}
