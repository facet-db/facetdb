import { queryOptions } from "@tanstack/react-query";
import type { ApiClient, BackfillStatus } from "../../api/index.ts";
import type { Scheduler } from "../../schedule.ts";

/**
 * The Sources page's read: `GET /v1/sources`, asked again while the page is open (a change seen, a
 * backfill moving). Apply and the setup flow invalidate every `sources` key when they write.
 */

/** How often the page asks the worker again while it is open. */
export const SOURCES_REFRESH_MS = 15_000;

export const SOURCES_KEY = ["sources", "rows"] as const;

export function sourcesQuery(api: ApiClient) {
  return queryOptions({
    queryKey: SOURCES_KEY,
    queryFn: () => api.sources(),
    refetchInterval: SOURCES_REFRESH_MS,
  });
}

/**
 * How often a source's backfill is asked again while a job lives: the count moves while it is
 * estimated and the pages settle at 50 records a second while it runs, so every two seconds the
 * strip moves; once a job has ended nothing changes until the page acts.
 */
export const BACKFILL_REFRESH_MS = 2_000;

/** Under `sources`, so the writes that invalidate every sources key (Apply, the setup) read it again. */
export const backfillKey = (source: string) => ["sources", "backfill", source] as const;

/**
 * One read of the job, with when it landed by the studio's clock: the "last known" time once a
 * later read fails. Stamped as the answer arrives, so a job that sits unchanged for minutes (the
 * same answer each read) still names its last successful read.
 */
export type BackfillRead = {
  readonly job: BackfillStatus;
  readonly readAt: number;
};

/**
 * `GET /v1/sources/:name/backfill`, read once when the controls mount; the controls ask again on
 * the studio's scheduler while a job lives, never on TanStack's own timer, so a test moves time.
 * No retry of TanStack's own: the scheduler's next tick is the retry, so a read that fails is said
 * so at once, as the last known, instead of three tries hiding it (and, cancelled by each tick,
 * never settling at all).
 */
export function backfillQuery(api: ApiClient, schedule: Scheduler, source: string) {
  return queryOptions({
    queryKey: backfillKey(source),
    queryFn: async (): Promise<BackfillRead> => ({
      job: await api.backfillStatus(source),
      readAt: schedule.now(),
    }),
    retry: false,
  });
}
