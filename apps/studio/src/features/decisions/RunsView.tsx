import { Button, EmptyState, SelfFillingTable, StatusWord, type TableColumn } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import type { Run } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { Problem, StaleNote } from "./controls.tsx";
import { Moment, ZoneNote } from "./Moment.tsx";
import { runsQuery } from "./queries.ts";
import { tookWords } from "./when.ts";

/**
 * The run log (the Runs tab): one row per worker pass that did work, newest first, 50 a page. A
 * backfill's page is a run of the source too and is named so. The log keeps 30 days, which the line
 * under the table says.
 */

function figure(count: number): string {
  return count.toLocaleString("en-US");
}

/** A run with its place on the page: two runs can share a start, a source and a kind. */
type Placed = { readonly run: Run; readonly index: number };

export function RunsView({
  source,
  page,
  onPage,
}: {
  /** One source by name; undefined for every source. */
  readonly source: string | undefined;
  readonly page: number;
  readonly onPage: (page: number) => void;
}) {
  const api = useApi();
  const schedule = useSchedule();
  const runs = useQuery(runsQuery(api, source, page));
  const now = new Date(schedule.now());

  const columns: readonly TableColumn<Placed>[] = [
    {
      kind: "text",
      id: "started",
      header: "Started",
      numeric: true,
      cell: ({ run }) => <Moment at={run.startedAt} now={now} seconds />,
    },
    {
      kind: "text",
      id: "source",
      header: "Source",
      cell: ({ run }) => (run.kind === "backfill" ? `${run.source}, a backfill page` : run.source),
    },
    {
      kind: "text",
      id: "claimed",
      header: "Claimed",
      numeric: true,
      cell: ({ run }) => figure(run.claimed),
    },
    {
      kind: "text",
      id: "answered",
      header: "Answered",
      numeric: true,
      cell: ({ run }) => figure(run.answered),
    },
    {
      kind: "text",
      id: "review",
      header: "To review",
      numeric: true,
      cell: ({ run }) => figure(run.toReview),
    },
    {
      kind: "text",
      id: "errors",
      header: "Errors",
      numeric: true,
      // A number alone would be a bare colored figure: the word and the square carry a failure.
      cell: ({ run }) =>
        run.errors === 0 ? (
          "0"
        ) : (
          <StatusWord
            status="error"
            size="small"
            label={`${figure(run.errors)} ${run.errors === 1 ? "error" : "errors"}`}
          />
        ),
    },
    {
      kind: "text",
      id: "discarded",
      header: "Discarded",
      numeric: true,
      cell: ({ run }) => figure(run.discarded),
    },
    {
      kind: "text",
      id: "tokens",
      header: "Tokens",
      numeric: true,
      cell: ({ run }) => figure(run.tokens),
    },
    {
      kind: "text",
      id: "took",
      header: "Took",
      numeric: true,
      cell: ({ run }) => tookWords(new Date(run.startedAt), new Date(run.endedAt)),
    },
  ];

  if (runs.isPending) {
    return (
      <p role="status" className="text-text-3">
        Reading the runs
      </p>
    );
  }
  if (runs.isError && runs.data === undefined) {
    return <Problem error={runs.error} />;
  }
  const { data } = runs;
  // A failed read after a good one keeps the rows: shown as last read, never as current.
  const stale = runs.isError;
  if (data.runs.length === 0 && page === 1 && !stale) {
    return (
      <EmptyState title="No runs yet">
        The worker writes one row for each pass that does work, and keeps them for 30 days.
      </EmptyState>
    );
  }
  return (
    <div className="grid gap-3">
      {runs.isError ? <Problem error={runs.error} /> : null}
      <SelfFillingTable
        key={`${source ?? "all"}:${String(page)}`}
        label={source === undefined ? "Runs of every source" : `Runs of ${source}`}
        columns={columns}
        rows={data.runs.map((run, index) => ({ run, index }))}
        rowKey={({ run, index }) => `${String(index)}|${run.startedAt}|${run.source}|${run.kind}`}
        schedule={(run, ms) => schedule.after(ms, run)}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {stale ? (
          <StaleNote what="These runs were" readAt={runs.dataUpdatedAt} now={now} />
        ) : (
          <p role="status" className="text-[12.5px] text-text-2">
            {data.runs.length === 0
              ? "No runs on this page."
              : `Page ${String(data.page)}, newest first. One row per worker pass that did work, kept for 30 days.`}
          </p>
        )}
        <div className="flex gap-2">
          {page > 2 || (page > 1 && data.runs.length === 0) ? (
            <Button
              variant="quiet"
              size="small"
              onClick={() => {
                onPage(1);
              }}
            >
              First page
            </Button>
          ) : null}
          {page > 1 ? (
            <Button
              variant="quiet"
              size="small"
              onClick={() => {
                onPage(page - 1);
              }}
            >
              Newer runs
            </Button>
          ) : null}
          {data.more ? (
            <Button
              variant="quiet"
              size="small"
              onClick={() => {
                onPage(page + 1);
              }}
            >
              Older runs
            </Button>
          ) : null}
        </div>
      </div>
      <ZoneNote />
    </div>
  );
}
