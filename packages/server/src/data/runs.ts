import type { RunKind } from "@facetdb/core";
import type { RunsReader } from "@facetdb/postgres";

/** The run log shows 50 runs a page. */
export const RUNS_PER_PAGE = 50;

/** One run as the endpoint answers it: times as ISO 8601, the source by its name in the config. */
export type RunView = {
  readonly source: string;
  /** `backfill` for a page of a backfill (the dashboard writes "<source>, a backfill page"). */
  readonly kind: RunKind;
  readonly startedAt: string;
  readonly endedAt: string;
  readonly claimed: number;
  readonly answered: number;
  readonly toReview: number;
  readonly errors: number;
  readonly discarded: number;
  readonly tokens: number;
};

export type RunsPage = {
  readonly runs: readonly RunView[];
  /** The page asked for, from 1. */
  readonly page: number;
  readonly perPage: number;
  /** True when an older page has runs too. */
  readonly more: boolean;
};

export type RunsService = {
  /** One page of the project's run log, newest first; one source by name, or all when undefined. */
  list(projectId: string, source: string | undefined, page: number): Promise<RunsPage>;
};

export function createRunsService(deps: { readonly reader: RunsReader }): RunsService {
  return {
    async list(projectId, source, page) {
      // One row past the page tells whether an older page exists, without counting the table.
      const rows = await deps.reader.page({
        projectId,
        source,
        limit: RUNS_PER_PAGE + 1,
        offset: (page - 1) * RUNS_PER_PAGE,
      });
      return {
        runs: rows.slice(0, RUNS_PER_PAGE).map((run) => ({
          ...run,
          startedAt: run.startedAt.toISOString(),
          endedAt: run.endedAt.toISOString(),
        })),
        page,
        perPage: RUNS_PER_PAGE,
        more: rows.length > RUNS_PER_PAGE,
      };
    },
  };
}
