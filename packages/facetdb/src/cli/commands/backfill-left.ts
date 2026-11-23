import type { BackfillReport } from "@facetdb/core";

/**
 * The closing line of an added-question backfill, said alike by `facetdb backfill
 * --question` and by the studio's job: what became of every record the run left alone. Only a
 * record core found in the queue (`queued`: its answer is current, and a worker holds it or will)
 * is the worker's. Every other one is skipped and in no queue this run made: never answered
 * (`unanswered`), another question unanswered (`incomplete`), or changed since its answer (`stale`),
 * which is not proof of a queue entry: a field added to `read` changes every hash and queues
 * nothing, and the worker acks a record it refuses as too large without logging an answer. The
 * line names the whole-set backfill for those: it queues them, and one already queued keeps its one
 * entry.
 */

/** The deferred records of an added-question run, counted by what becomes of each. */
export type LeftOver = {
  /** Answered at its state and in the queue: the worker asks it with the whole set. */
  readonly queued: number;
  /** Changed, never answered, or another question unanswered: in no queue this run made. */
  readonly skipped: number;
};

export const NOTHING_LEFT: LeftOver = { queued: 0, skipped: 0 };

export function leftOver(deferred: BackfillReport["deferred"]): LeftOver {
  let queued = 0;
  let skipped = 0;
  for (const { reason } of deferred) {
    switch (reason) {
      case "queued":
        queued += 1;
        break;
      case "stale":
      case "unanswered":
      case "incomplete":
        skipped += 1;
        break;
    }
  }
  return { queued, skipped };
}

/**
 * Where the line sends a reader for the skipped records: the terminal, or the studio's Sources
 * page, named as such: the install's offer shows the same words beside a control of the same label
 * that asks the added questions alone again, which would skip the same records.
 */
export type WholeSetDoor = "cli" | "studio";

const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * "Done: 1 answered, 1 already answered, 3 queued for the worker. 3 skipped (changed or never fully
 * answered): run facetdb backfill --source listings to queue them with every question." A part that
 * counts zero is left out; with none of the first three, "nothing answered".
 */
export function addedQuestionsEnd(
  opening: string,
  counts: { readonly answered: number; readonly alreadyAnswered: number },
  left: LeftOver,
  source: string,
  door: WholeSetDoor,
): string {
  const parts = [
    ...(counts.answered > 0 ? [`${whole.format(counts.answered)} answered`] : []),
    ...(counts.alreadyAnswered > 0
      ? [`${whole.format(counts.alreadyAnswered)} already answered`]
      : []),
    ...(left.queued > 0 ? [`${whole.format(left.queued)} queued for the worker`] : []),
  ];
  const line = `${opening}: ${parts.length === 0 ? "nothing answered" : parts.join(", ")}.`;
  if (left.skipped === 0) {
    return line;
  }
  const how =
    door === "cli"
      ? `run facetdb backfill --source ${source}`
      : "use Answer existing records on the Sources page";
  return `${line} ${whole.format(left.skipped)} skipped (changed or never fully answered): ${how} to queue ${left.skipped === 1 ? "it" : "them"} with every question.`;
}
