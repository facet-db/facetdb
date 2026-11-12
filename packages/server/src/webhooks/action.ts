import type { Action, Clock } from "@facetdb/core";
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
  /** The delivery id: the same on every retry of this webhook, and in the `facetdb-delivery` header. */
  readonly delivery: string;
  readonly source: string;
  readonly id: string;
  readonly status: string;
  /**
   * When the decision this webhook reports was made (ISO 8601, UTC). A retried `needs_review`
   * webhook can arrive after the `done` one a person's decision produced: apply the payload with
   * the later `decidedAt` and ignore the other.
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
  /** The action runs right after the decision is written, so its time is the decision's. */
  readonly clock: Clock;
}): Action<WebhookConfig> {
  return {
    async run(record, decisions, config) {
      const answers: Record<string, CheckedAnswer> = {};
      for (const [name, decision] of Object.entries(decisions)) {
        const answer = checkedAnswer(decision);
        if (answer !== undefined) {
          answers[name] = answer;
        }
      }
      const decidedAt = new Date(deps.clock.now()).toISOString();
      await deps.outbox.enqueue({
        projectId: deps.projectId,
        endpoint: config.url,
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
