import type { BackfillReport, RestoreReport } from "@facetdb/core";

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

/** What a whole-set backfill did with its records, from core's report. */
export type WholeSetCounts = {
  /** In the queue, by the connector's own answer: a worker asks each one. */
  readonly queued: number;
  readonly alreadyAnswered: number;
  /** Handed to a plugin source's queue and left out: its plugin no longer returns them. */
  readonly notQueued: number;
};

/**
 * The closing line of a whole-set backfill, said alike by `facetdb backfill` and the studio's job:
 * "Done: 3 records queued for the worker, 1 already answered. 2 not queued: the plugin no longer
 * returns them. Run facetdb worker to answer the queue." Only a record the connector queued is
 * counted as queued; a part that counts zero is left out, and the terminal names the worker only
 * when something waits for it (the studio's job runs inside the worker).
 */
export function wholeSetEnd(opening: string, counts: WholeSetCounts, door: WholeSetDoor): string {
  const parts = [
    ...(counts.queued > 0
      ? [
          `${whole.format(counts.queued)} record${counts.queued === 1 ? "" : "s"} queued for the worker`,
        ]
      : []),
    ...(counts.alreadyAnswered > 0
      ? [`${whole.format(counts.alreadyAnswered)} already answered`]
      : []),
  ];
  const sentences = [
    parts.length > 0
      ? `${opening}: ${parts.join(", ")}.`
      : counts.notQueued > 0
        ? `${opening}.`
        : `${opening}: nothing to queue.`,
    ...(counts.notQueued > 0
      ? [
          `${whole.format(counts.notQueued)} not queued: the plugin no longer returns ${counts.notQueued === 1 ? "it" : "them"}.`,
        ]
      : []),
    ...(door === "cli" && counts.queued > 0 ? ["Run facetdb worker to answer the queue."] : []),
  ];
  return sentences.join(" ");
}

/**
 * The closing line of `facetdb backfill --from-log`: what was written back from the decision log,
 * and what is left for a plain `facetdb backfill`, which queues a record changed since its answer,
 * one answered before a question was added, and one never answered (the log holds no answer for
 * those, so they are named, never counted). The run queued nothing: "queued" belongs to a key
 * `enqueue` returned. A part that counts zero is left out.
 *
 * "Done: 3 written, 1 already current. 2 changed since their answer: run facetdb backfill --source
 * listings to queue them, and any record never answered."
 */
export function fromLogEnd(
  report: Pick<RestoreReport, "written" | "current" | "changed" | "incomplete" | "kept" | "gone">,
  source: string,
  dryRun: boolean,
): string {
  const count = (keys: readonly unknown[]): string => whole.format(keys.length);
  const written =
    report.written.length > 0
      ? `${count(report.written)} ${dryRun ? "to write" : "written"}`
      : dryRun
        ? "nothing to write"
        : "nothing written";
  const parts = [
    written,
    ...(report.current.length > 0 ? [`${count(report.current)} already current`] : []),
    ...(report.kept.length > 0
      ? [`${count(report.kept)} left with the worker's later status (error, unchecked or skipped)`]
      : []),
    ...(report.gone.length > 0 ? [`${count(report.gone)} no longer in the source`] : []),
  ];
  const opening = `${dryRun ? "Dry run, nothing written" : "Done"}: ${parts.join(", ")}.`;
  const why = [
    ...(report.changed.length > 0
      ? [
          `${count(report.changed)} changed since ${report.changed.length === 1 ? "its" : "their"} answer`,
        ]
      : []),
    ...(report.incomplete.length > 0
      ? [`${count(report.incomplete)} answered before a question was added`]
      : []),
  ];
  const how = `facetdb backfill --source ${source}`;
  const left = report.changed.length + report.incomplete.length;
  return left === 0
    ? `${opening} Run ${how} to queue any record never answered.`
    : `${opening} ${why.join(" and ")}: run ${how} to queue ${left === 1 ? "it" : "them"}, and any record never answered.`;
}
