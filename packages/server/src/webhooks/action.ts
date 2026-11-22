import type { Action } from "@facetdb/core";
import { type CheckedAnswer, checkedAnswer } from "../check/service.ts";
import type { Outbox } from "./outbox.ts";

/** `webhook({ url })` in a source's `actions`; the signing secret is the project's, read at delivery. */
export type WebhookConfig = {
  readonly url: string;
};

/**
 * The JSON body of a webhook: the record's key and status, and the questions decided so far. The
 * signature covers these exact bytes, so `delivery` and `decidedAt` cannot be altered in transit.
 */
export type WebhookPayload = {
  readonly event: "record.decided";
  /**
   * The delivery id: the same on every retry of this webhook, and in the `facetdb-delivery` header.
   * It is the outbox's sequence number, a whole number written in decimal, taken when the webhook
   * is queued: within one FacetDB store, a webhook queued later has a larger one.
   */
  readonly delivery: string;
  readonly source: string;
  readonly id: string;
  readonly status: string;
  /**
   * When the decision this webhook reports was made (ISO 8601, UTC): the decision log entry's time,
   * the same however late or often the action runs. A retried `needs_review` webhook can arrive
   * after the `done` one a person's decision produced: apply the payload with the later `decidedAt`
   * and ignore the other. Two payloads of one record can share a `decidedAt`: a threshold change
   * re-decides the record from the same logged answer (and can change it back). Between those, the
   * one with the larger `delivery`, compared as a whole number, was queued later and is the
   * record's decision.
   */
  readonly decidedAt: string;
  /** Decided questions only, in the shape `POST /v1/check` answers with; a question left to a person is absent. */
  readonly answers: Readonly<Record<string, CheckedAnswer>>;
};

/**
 * The webhook action of one source. The worker runs it after the answer columns are written and
 * again after a person's decision, so an automatic decision and a reviewer's both reach the same
 * endpoint; the action only queues, and `Outbox.deliverDue` sends, signs and retries.
 */
export function createWebhookAction(deps: {
  readonly outbox: Pick<Outbox, "enqueue">;
  readonly projectId: string;
  /** The source's name, as callers know it. */
  readonly source: string;
  /**
   * The configured action this is (`@facetdb/webhook`'s `send`), by its plugin, its name, the
   * source's store id and its place in the source's `actions`. With it each row names the
   * decision's record (`WebhookOrigin`): the same decision queued twice is one delivery, and only
   * the project's own worker sends it. The payload is the same either way.
   */
  readonly queuedBy?: {
    readonly plugin: string;
    readonly action: string;
    readonly sourceId: string;
    readonly position: number;
  };
}): Action<WebhookConfig> {
  const { queuedBy } = deps;
  return {
    async run(record, decisions, config) {
      const answers: Record<string, CheckedAnswer> = {};
      for (const [name, decision] of Object.entries(decisions)) {
        const answer = checkedAnswer(decision);
        if (answer !== undefined) {
          answers[name] = answer;
        }
      }
      // The worker hands over the logged decision's time: an action run late (a lost ack, a
      // backfill) or again must not make an old decision look newer than a person's later one.
      const decidedAt = record.decidedAt.toISOString();
      await deps.outbox.enqueue({
        projectId: deps.projectId,
        endpoint: config.url,
        ...(queuedBy === undefined
          ? {}
          : {
              origin: {
                plugin: queuedBy.plugin,
                entry: queuedBy.action,
                record: {
                  sourceId: queuedBy.sourceId,
                  recordKey: record.key,
                  position: queuedBy.position,
                },
              },
            }),
        payloadOf: (delivery): WebhookPayload => ({
          event: "record.decided",
          delivery,
          source: deps.source,
          id: record.key,
          status: record.status,
          decidedAt,
          answers,
        }),
      });
    },
  };
}
