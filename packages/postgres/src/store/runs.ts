import type { RunKind, RunLog } from "@facetdb/core";
import type { SqlClient, SqlRow } from "../sql/index.ts";
import { flag, fromMs, integer, text, toMs } from "./rows.ts";

/**
 * `facetdb.runs` (store migration 6): the run log the worker writes after every pass that did work
 * and prunes after 30 days, and the page the dashboard's run log reads.
 */

/**
 * How a backfill page's row is told from a pass's: its `source_id` is the source's id with this
 * after it. A source's id is `<project>:<name>` and a source name holds only lowercase letters,
 * digits and `_`, so no source's own id can end in it, whatever its project's id holds.
 */
export const BACKFILL_RUN_MARK = "/backfill";

/** One row of the run log as the dashboard reads it: the source by its name in the config. */
export type StoredRun = {
  readonly source: string;
  readonly kind: RunKind;
  readonly startedAt: Date;
  readonly endedAt: Date;
  readonly claimed: number;
  readonly answered: number;
  readonly toReview: number;
  readonly errors: number;
  readonly discarded: number;
  readonly tokens: number;
};

export type RunsQuery = {
  readonly projectId: string;
  /** One source by its name, or every source of the project when undefined. */
  readonly source: string | undefined;
  readonly limit: number;
  readonly offset: number;
};

/** The run log's read side, for the server (`GET /v1/runs`). */
export type RunsReader = {
  /** The project's runs, newest first by when they started. */
  page(query: RunsQuery): Promise<readonly StoredRun[]>;
};

export type RunStore = RunLog & RunsReader;

export function createRunStore(client: SqlClient): RunStore {
  return {
    async record(run) {
      await client.query(
        `insert into facetdb.runs
           (source_id, started_at, ended_at, claimed, answered, to_review, errors, discarded, tokens)
         values ($1, ${fromMs("$2")}, ${fromMs("$3")}, $4, $5, $6, $7, $8, $9)`,
        [
          run.kind === "backfill" ? `${run.source}${BACKFILL_RUN_MARK}` : run.source,
          run.startedAt.getTime(),
          run.endedAt.getTime(),
          run.claimed,
          run.answered,
          run.toReview,
          run.errors,
          run.discarded,
          run.tokens,
        ],
      );
    },

    async prune(before) {
      // A row is kept for 30 days from when its run ended; the cutoff itself stays.
      await client.query(`delete from facetdb.runs where ended_at < ${fromMs("$1")}`, [
        before.getTime(),
      ]);
    },

    async page(query) {
      // The project's sources by `facetdb.sources`, never by a prefix of `source_id`: a project's id
      // may hold a colon, so one project's prefix can begin another's.
      const rows = await client.query(
        `select s.name, r.source_id <> s.id as backfill,
                ${toMs("r.started_at", "started_ms")}, ${toMs("r.ended_at", "ended_ms")},
                r.claimed::text as claimed, r.answered::text as answered,
                r.to_review::text as to_review, r.errors::text as errors,
                r.discarded::text as discarded, r.tokens::text as tokens
           from facetdb.runs r
           join facetdb.sources s on r.source_id in (s.id, s.id || $2::text)
          where s.project_id = $1 and ($3::text is null or s.name = $3)
          order by r.started_at desc, r.id desc
          limit $4 offset $5`,
        [query.projectId, BACKFILL_RUN_MARK, query.source ?? null, query.limit, query.offset],
      );
      return rows.map(toStoredRun);
    },
  };
}

function toStoredRun(row: SqlRow): StoredRun {
  return {
    source: text(row, "name"),
    kind: flag(row, "backfill") ? "backfill" : "pass",
    startedAt: new Date(integer(row, "started_ms")),
    endedAt: new Date(integer(row, "ended_ms")),
    claimed: integer(row, "claimed"),
    answered: integer(row, "answered"),
    toReview: integer(row, "to_review"),
    errors: integer(row, "errors"),
    discarded: integer(row, "discarded"),
    tokens: integer(row, "tokens"),
  };
}
