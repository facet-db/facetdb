import type { Clock, Decision, RecordKey, RecordStatus, StateValue, Worker } from "@facetdb/core";
import type { StoredRecord } from "@facetdb/postgres";

/** An API source as the check service needs it: its state fields and the queue and records of the store. */
export type ApiSource = {
  /** The state fields the questions read (`read` in the config), in config order. */
  readonly fields: readonly string[];
  readonly connector: {
    upsertRecord(key: RecordKey, state: Readonly<Record<string, StateValue>>): Promise<boolean>;
    getRecord(key: RecordKey): Promise<StoredRecord | undefined>;
  };
};

export type CheckStore = {
  /** The API source `name` of the project, or undefined when the project has none by that name. */
  apiSource(projectId: string, name: string): ApiSource | undefined;
};

export type CheckWorkers = {
  /**
   * A worker whose pass takes the record `key` of the source and no other (see `onlyRecord`): the
   * call waits for its own record, and its wait is not spent on the rest of the queue.
   */
  forRecord(projectId: string, name: string, key: RecordKey): Worker;
};

export type CheckDeps = {
  readonly store: CheckStore;
  readonly worker: CheckWorkers;
  readonly clock: Clock;
  /**
   * What `retry-after` says (whole seconds) when the model could not be asked: the model package's
   * backoff ceiling, which the composition root passes. The record stays queued and the worker loop
   * answers it when the model is back, so the caller may also just wait for its webhook.
   */
  readonly retryAfterSeconds: number;
};

/**
 * The call is synchronous and returns in about a second. A call waits this long for an answer
 * before it says the record is stored and still pending.
 */
export const CHECK_WAIT_MS = 10_000;
export const CHECK_POLL_MS = 250;

export type CheckRequest = {
  readonly source: string;
  readonly id: string;
  readonly record: Readonly<Record<string, StateValue>>;
};

/** One decided question as the caller sees it. A noul has a probability; the rest a confidence. */
export type CheckedAnswer =
  | { readonly value: boolean; readonly probability: number }
  | { readonly value: string; readonly confidence: number; readonly expected?: number };

export type CheckResult =
  | {
      readonly kind: "answered";
      readonly id: string;
      readonly status: RecordStatus;
      /** Decided questions only: a question left to a person has no answer here yet. */
      readonly answers: Readonly<Record<string, CheckedAnswer>>;
    }
  | { readonly kind: "unknown_source"; readonly source: string }
  | { readonly kind: "invalid_record"; readonly problems: readonly string[] }
  /** The record is stored and queued, but no answer exists: the wait ran out, or the model could not be asked. */
  | { readonly kind: "unanswered"; readonly id: string; readonly reason: "waiting" }
  | {
      readonly kind: "unanswered";
      readonly id: string;
      readonly reason: "unavailable";
      /** The seconds the caller is told to wait (`retry-after`). */
      readonly retryAfterSeconds: number;
      /**
       * Whether the record is still in the queue. False when the outage policy ruled on it (`hold`
       * marks it `error`, `release` marks it `unchecked`): it leaves the queue with that status
       * until the policy's next retry, and the next call with the same id answers 200 carrying the status.
       */
      readonly queued: boolean;
    };

export type CheckService = {
  check(projectId: string, request: CheckRequest): Promise<CheckResult>;
};

export function createCheckService(deps: CheckDeps): CheckService {
  const { store, worker, clock } = deps;

  return {
    async check(projectId, request) {
      const source = store.apiSource(projectId, request.source);
      if (source === undefined) {
        return { kind: "unknown_source", source: request.source };
      }
      const problems = recordProblems(source.fields, request.record);
      if (problems.length > 0) {
        return { kind: "invalid_record", problems };
      }

      // The same state returns false here and changes nothing, so a stored answer is served without
      // the worker running; a changed state is queued again by the store, in one transaction.
      await source.connector.upsertRecord(request.id, request.record);

      const deadline = clock.now() + CHECK_WAIT_MS;
      for (;;) {
        const stored = await source.connector.getRecord(request.id);
        if (stored === undefined) {
          throw new Error(`the record ${request.id} is missing right after it was stored`);
        }
        if (stored.status !== "pending") {
          return {
            kind: "answered",
            id: request.id,
            status: stored.status,
            answers: answersOf(stored),
          };
        }
        if (clock.now() >= deadline) {
          return { kind: "unanswered", id: request.id, reason: "waiting" };
        }

        const report = await worker.forRecord(projectId, request.source, request.id).runOnce();
        const failed = report.failures.some(
          (failure) => failure.key === request.id && failure.stage === "ask",
        );
        if (failed || report.paused) {
          // A failed model call is an error, never an answer. Unless the outage policy has ruled on
          // the record, the failed job went back to the queue, so the worker loop answers it when
          // the model returns and the source's webhook action (the outbox) delivers that answer.
          const held = report.held.some((entry) => entry.key === request.id);
          return {
            kind: "unanswered",
            id: request.id,
            reason: "unavailable",
            retryAfterSeconds: deps.retryAfterSeconds,
            queued: !held,
          };
        }
        if (report.claimed === 0) {
          // Another worker holds the job: look again shortly instead of asking twice.
          await clock.sleep(CHECK_POLL_MS);
        }
      }
    },
  };
}

/** Every read field must be present (null is a value: "blank"), and nothing else is accepted. */
function recordProblems(
  fields: readonly string[],
  record: Readonly<Record<string, StateValue>>,
): string[] {
  const problems: string[] = [];
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      problems.push(`the field "${field}" is missing`);
    }
  }
  for (const name of Object.keys(record)) {
    if (!fields.includes(name)) {
      problems.push(`the field "${name}" is not one of the source's fields (${fields.join(", ")})`);
    }
  }
  return problems;
}

function answersOf(stored: StoredRecord): Record<string, CheckedAnswer> {
  const answers: Record<string, CheckedAnswer> = {};
  for (const [name, decision] of Object.entries(stored.decision?.decisions ?? {})) {
    const answer = checkedAnswer(decision);
    if (answer !== undefined) {
      answers[name] = answer;
    }
  }
  return answers;
}

export function checkedAnswer(decision: Decision): CheckedAnswer | undefined {
  if (decision.kind === "needs_review") {
    return undefined;
  }
  if (typeof decision.value === "boolean") {
    return { value: decision.value, probability: decision.probabilityOrConfidence };
  }
  return {
    value: decision.value,
    confidence: decision.probabilityOrConfidence,
    ...(decision.expected === undefined ? {} : { expected: decision.expected }),
  };
}
