import { Button, DitherStrip } from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import {
  ApiError,
  type BackfillState,
  type BackfillStatus,
  type Home,
  homeQuery,
  type SourceRow,
} from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { compactTokens } from "../../shell/index.ts";
import { Problem, whenWords } from "../decisions/index.ts";
import { countWords, dollarWords, plural } from "../questions/index.ts";
import { BACKFILL_REFRESH_MS, type BackfillRead, backfillKey, backfillQuery } from "./queries.ts";

/**
 * A source's backfill from the page: a job inside the worker, driven from the source's row on the
 * Sources page and from an added question's install. A table source pages through its rows; a
 * plugin source through its plugin's scan, through the same endpoints and in the same steps, its
 * estimate saying it paged the plugin. The state in words, then the two steps: "Answer existing
 * records" asks the worker to count and price the records (nothing is asked of the model), and
 * Start, enabled only once that estimate is on the page, sends the token the estimate gave, so no
 * backfill starts from a page that has not shown its cost. While it runs the progress is a strip
 * with its words and Stop ends it after the page in hand; stopped, paused at the spending cap or
 * failed, the worker's why stands with what to do, and Resume asks for a new estimate from the last
 * finished page. While a job lives the state is asked again on the studio's scheduler; a refresh
 * that fails leaves what is shown, said as the last known with the time of the last read that
 * landed, and the next tick asks again all the same; a first read that fails is said in words with
 * what to do and asked again too.
 *
 * The space is reserved: the strip's box, the words' lines, the actions and the status line are
 * there in every state, so the row does not jump as the state changes.
 */

const STRIP_WIDTH = 120;

/** A job that will change on its own: asked again on the scheduler. */
const LIVE: ReadonlySet<BackfillState> = new Set(["estimating", "waiting", "running", "stopping"]);

/** A job that ended part way: the next estimate counts from the last finished page. */
const ENDED_PART_WAY: ReadonlySet<BackfillState> = new Set(["stopped", "paused", "failed"]);

/** A job whose pages settled: the strip shows how far it got. */
const PAGED: ReadonlySet<BackfillState> = new Set([
  "running",
  "stopping",
  "stopped",
  "paused",
  "failed",
]);

/** "is_vehicle", "is_vehicle and colour", "is_vehicle, colour and year". */
function listWords(names: readonly string[]): string {
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1) ?? ""}`;
}

/** "about 24 seconds", "about 3 minutes", "about 1.5 hours": the records at the pace, for a person. */
function durationWords(records: number, pace: number): string {
  const seconds = records / pace;
  if (seconds < 60) {
    return `about ${plural(Math.max(1, Math.round(seconds)), "second", "seconds")}`;
  }
  if (seconds < 3600) {
    return `about ${plural(Math.round(seconds / 60), "minute", "minutes")}`;
  }
  const hours = seconds / 3600;
  return `about ${plural(hours < 10 ? Math.round(hours * 2) / 2 : Math.round(hours), "hour", "hours")}`;
}

/** What a backfill pages through: the source's table, or a plugin source's own scan. */
type BackfillPages = "table" | "plugin";

/**
 * How a plugin source's estimate was counted, after its figures: the count paged once through the
 * plugin's scan and the run pages through it again, so the plugin's API is called twice for every
 * page, which a large source feels; said before Start, as facetdb backfill says it before its yes.
 * Said at no records too: core's backfill runs at zero all the same, and a source whose records are
 * all left out (answered, or outside a filter) can still be many pages.
 */
const PLUGIN_PAGED =
  "Counted by paging through the plugin. Start pages through it again, so the plugin's API is called twice for every page: once for this count, once for the run.";

/** The estimate in the page's words: how many records, what it costs, at what pace, how long. */
function estimateWords(
  status: BackfillStatus,
  spending: Home["spending"] | undefined,
  pages: BackfillPages,
): string | null {
  const { estimate, pace, questions } = status;
  if (estimate === null) {
    return null;
  }
  const what = questions === null ? "" : ` for ${listWords(questions)}`;
  if (estimate.records === 0) {
    // A table's run reads rows and asks no one; a plugin's asks the model nothing, and its API again.
    return pages === "plugin"
      ? `Estimated${what}: no records to answer from here, so starting it asks the model nothing. ${PLUGIN_PAGED}`
      : `Estimated${what}: no records to answer from here, so starting it asks nothing.`;
  }
  const time =
    pace === null
      ? ""
      : `, at ${plural(pace, "record", "records")} a second: ${durationWords(estimate.records, pace)}`;
  // Set against what is left of this month's cap (a backfill started under a cap it would cross,
  // which the loop then met part way).
  const cap = spending?.cap ?? null;
  const left =
    spending === undefined || cap === null
      ? null
      : Math.max(0, cap.inputTokens - spending.inputTokens);
  // The cap and what it does at 100% are the worker's (GET /v1/home): the ones it enforces now,
  // which each Apply from Settings replaces.
  const beyond =
    cap !== null && left !== null && estimate.tokens > left
      ? ` That is more than what is left this month under the cap the worker runs with (${compactTokens(left)} input tokens), so ${cap.onCapReached === "pause" ? "the answering pauses at the cap, part way" : "it goes past the cap, as the worker was started to do"}.`
      : "";
  // After the cap's sentence, whose "That" is the estimate's figures.
  const plugin = pages === "plugin" ? ` ${PLUGIN_PAGED}` : "";
  return `Estimated${what}: ${plural(estimate.records, "record", "records")}, about ${dollarWords(estimate.dollars)} (${compactTokens(estimate.tokens)} input tokens)${time}.${beyond}${plugin}`;
}

/** How far the job got, for the strip: the pages settled over the records estimated. */
function progressOf(status: BackfillStatus): number | null {
  if (status.state === "finished") {
    return 1;
  }
  const { counts, estimate } = status;
  if (!PAGED.has(status.state) || counts === null || estimate === null || estimate.records === 0) {
    return null;
  }
  return Math.min(1, counts.records / estimate.records);
}

/** How far a job that ended part way got, beside its strip: ", 600 of 1,200 records done". */
function doneWords(status: BackfillStatus): string {
  const { counts, estimate } = status;
  return counts === null || estimate === null
    ? ""
    : `, ${countWords(counts.records)} of ${countWords(estimate.records)} records done`;
}

/** The state at a glance, in words; the detail under it says the rest. */
function stateWords(status: BackfillStatus, known: SourceRow["backfill"] | undefined): string {
  switch (status.state) {
    case "idle":
      return known?.state === "finished"
        ? "Finished"
        : known?.state === "part-way"
          ? "Part way, not running"
          : "No backfill yet";
    case "estimating":
      return "Counting the records";
    case "waiting":
      return "Estimated, not started";
    case "running":
      return "Running";
    case "stopping":
      return "Stopping";
    case "stopped":
      return `Stopped${doneWords(status)}`;
    case "finished":
      return "Finished";
    case "failed":
      return `Failed${doneWords(status)}`;
    case "paused":
      return `Paused at the spending cap${doneWords(status)}`;
  }
}

/** What to do next, where the state leaves something to do. */
function nextWords(status: BackfillStatus, now: Date): string {
  if (status.state === "waiting") {
    const dropped =
      status.expiresAt === null
        ? ""
        : ` It is dropped at ${whenWords(new Date(status.expiresAt), now)} if it is not started.`;
    return `Nothing is asked until you press Start.${dropped}`;
  }
  if (ENDED_PART_WAY.has(status.state)) {
    return "Resume asks for a new estimate from the last finished page and shows it before anything is asked.";
  }
  return "";
}

/** The worker runs no jobs (`facetdb worker --once`): said in its words, with nothing to press. */
function unavailable(error: unknown): ApiError | null {
  return error instanceof ApiError && error.code === "backfill_unavailable" ? error : null;
}

/** A read that failed, in words with what to do: the worker's own, or the page's when it did not answer. */
function readFailure(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(
        0,
        "no_answer",
        "The worker did not answer when asked where this source's backfill stands.",
        `Check that facetdb studio or facetdb worker still runs; this row asks again every ${String(BACKFILL_REFRESH_MS / 1000)} seconds.`,
      );
}

/** Why the last refresh failed, after "could not be asked again: ". */
function refusalWords(error: unknown): string {
  return error instanceof ApiError ? error.message : "it did not answer.";
}

export function BackfillControls({
  source,
  pages = "table",
  questions,
  known,
}: {
  readonly source: string;
  /** What the backfill pages through: a plugin source's scan, whose estimate says so; absent, a table. */
  readonly pages?: BackfillPages;
  /** The added questions to ask alone (an install's offer); absent, the whole question set. */
  readonly questions?: readonly string[];
  /** What GET /v1/sources says of the source's backfill from its cursor: the words while no job lives. */
  readonly known?: SourceRow["backfill"];
}) {
  const api = useApi();
  const schedule = useSchedule();
  const queryClient = useQueryClient();
  const status = useQuery(backfillQuery(api, schedule, source));
  // The project's spending, as the rail reads it: a whole-set backfill asks nothing itself, it
  // queues records for the worker, which answers them only under the cap ("Finished" beside a
  // paused project read as a backfill above the cap).
  const home = useQuery(homeQuery(api));
  /** The last action's refusal, in the worker's words; cleared by the next action. */
  const [problem, setProblem] = useState<Error | null>(null);

  const read = status.data;
  const job = read?.job;
  const live = job !== undefined && LIVE.has(job.state);
  const noJobs = job === undefined ? unavailable(status.error) : null;
  // A first read that failed (the worker away) is tried again too, so the row never sticks.
  const unread = job === undefined && status.isError && noJobs === null;
  // A job that lives is asked again on the injected scheduler, so a test moves the time by hand.
  // A read still in flight is never cancelled by the tick (a slow worker would never answer).
  const { refetch } = status;
  const asksAgain = live || unread;
  useEffect(() => {
    if (!asksAgain) {
      return undefined;
    }
    return schedule.every(BACKFILL_REFRESH_MS, () => {
      void refetch({ cancelRefetch: false });
    });
  }, [schedule, refetch, asksAgain]);

  // Each action answers the job as it stands, which the page shows at once; a refusal is shown
  // and the state read again, since the refusal says what stands now (an estimate expired, a job
  // another page started).
  const outcome = {
    onMutate: () => {
      setProblem(null);
    },
    onSuccess: (next: BackfillStatus) => {
      queryClient.setQueryData<BackfillRead>(backfillKey(source), {
        job: next,
        readAt: schedule.now(),
      });
    },
    onError: (error: Error) => {
      setProblem(error);
      void refetch({ cancelRefetch: false });
    },
  };
  const estimate = useMutation({
    mutationFn: (asked: readonly string[] | undefined) => api.backfillEstimate(source, asked),
    ...outcome,
  });
  const start = useMutation({
    mutationFn: (token: string) => api.backfillStart(source, token),
    ...outcome,
  });
  const stop = useMutation({ mutationFn: () => api.backfillStop(source), ...outcome });

  const now = new Date(schedule.now());
  const busy = estimate.isPending || start.isPending || stop.isPending;
  const token = job?.token ?? null;
  const resumesJob = job !== undefined && ENDED_PART_WAY.has(job.state);
  const resumes = resumesJob || (job?.state === "idle" && known?.state === "part-way");
  // Resume asks for the stopped job's own questions: the worker keeps a place per subset, so a
  // job of one added question goes on from its own page, not from the whole set's.
  const asked = resumesJob ? (job.questions ?? undefined) : questions;
  // No job since the worker started: the cursor's own progress, as GET /v1/sources reads it.
  const fraction =
    job === undefined || job.state === "idle" ? (known?.fraction ?? null) : progressOf(job);
  const failed = job === undefined && status.isError ? (noJobs ?? readFailure(status.error)) : null;
  const heading =
    job === undefined
      ? failed === null
        ? "Reading the backfill"
        : noJobs === null
          ? "Could not be read"
          : "No backfill from this worker"
      : stateWords(job, known);
  const detail =
    job === undefined
      ? (failed?.message ?? known?.words ?? "")
      : job.state === "idle"
        ? (known?.words ?? job.words)
        : job.state === "waiting"
          ? (estimateWords(job, home.data?.spending, pages) ?? job.words)
          : job.words;
  // A job of some questions asks the model itself and pauses on its own, so the note is the
  // whole set's alone, on the row and in the job it shows.
  const pausedNote =
    questions === undefined &&
    (job === undefined || job.questions === null) &&
    home.data?.spending.status === "paused"
      ? "The worker is paused at the spending cap, so the records queued for it wait: raise the cap in Settings, which applies at once, or they are answered when the month resets."
      : "";
  const next = [job === undefined ? (failed?.fix ?? "") : nextWords(job, now), pausedNote]
    .filter((words) => words !== "")
    .join(" ");
  const lastKnown =
    read !== undefined && status.isError
      ? `Last known ${whenWords(new Date(read.readAt), now, { seconds: true })}. The worker could not be asked again: ${refusalWords(status.error)}`
      : "";

  return (
    // A fieldset is a group to a screen reader, named for the source: the row has several.
    <fieldset aria-label={`Backfill of ${source}`} className="m-0 grid min-w-0 gap-2 border-0 p-0">
      <div className="grid min-h-[4lh] content-start gap-1">
        <span className="flex items-center gap-3">
          <span className="inline-flex h-2 w-[120px] shrink-0">
            {fraction === null ? null : (
              <DitherStrip
                value={fraction}
                width={STRIP_WIDTH}
                label={`Backfill ${String(Math.round(fraction * 100))}% done`}
              />
            )}
          </span>
          <span className="font-medium">{heading}</span>
        </span>
        <p className="m-0 max-w-[64ch] text-text-2">{detail}</p>
        <p className="m-0 max-w-[64ch] text-text-2">{next}</p>
      </div>
      {noJobs === null ? (
        <div className="flex flex-wrap gap-2">
          {/* Wide enough for either word, so Start and Stop stay put when it changes. */}
          <Button
            size="small"
            className="min-w-48 justify-center"
            disabled={job === undefined || live || busy}
            onClick={() => {
              estimate.mutate(asked);
            }}
          >
            {resumes ? "Resume" : "Answer existing records"}
          </Button>
          <Button
            size="small"
            disabled={token === null || busy}
            onClick={() => {
              if (token !== null) {
                start.mutate(token);
              }
            }}
          >
            Start
          </Button>
          <Button
            size="small"
            variant="quiet"
            disabled={!live || job.state === "stopping" || busy}
            onClick={() => {
              stop.mutate();
            }}
          >
            Stop
          </Button>
        </div>
      ) : null}
      {problem === null ? null : <Problem error={problem} />}
      <p role="status" className="m-0 min-h-[1lh] text-[12.5px] text-text-2">
        {lastKnown}
      </p>
    </fieldset>
  );
}
