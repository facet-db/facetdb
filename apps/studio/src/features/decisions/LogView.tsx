import {
  Button,
  EmptyState,
  focusBrackets,
  SelfFillingTable,
  StatusWord,
  type TableColumn,
} from "@facetdb/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { type DecisionFilters, isDotSegment } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { Problem, StaleNote } from "./controls.tsx";
import { type LogLine, logLines } from "./log-lines.ts";
import { Moment, ZoneNote } from "./Moment.tsx";
import { logQuery } from "./queries.ts";

/**
 * The log, newest first (the Decisions tab): one line per question of each model call and each
 * person's decision, the model's figure as a dither strip with the number and the words, what the
 * thresholds made of it as a status word with the value, and who decided. A row leads to the why
 * page of its record. "Show more" asks for the next page with the cursor the worker gave.
 */

const RECORD_LINK = `${focusBrackets} font-medium text-text underline decoration-hairline underline-offset-4 hover:decoration-text-2`;

/** By the tag, never the words: an option named "withdrawn" or "needs review" is a decided value. */
function Decided({ line }: { readonly line: LogLine }) {
  switch (line.outcome) {
    case "needs_review":
      return <StatusWord status="needs_review" size="small" />;
    case "withdrawn":
      return <StatusWord status="skipped" size="small" label="withdrawn" />;
    case "unknown":
      // The answer's question-set version is no longer kept, so nothing can say what it led to.
      return (
        <span className="text-text-2">
          unknown<span className="sr-only">, the question set it ran under is no longer kept</span>
        </span>
      );
    case "decided":
      return <StatusWord status="done" size="small" label={line.decided} />;
  }
}

export function LogView({
  source,
  filters,
  onClear,
  narrowed,
}: {
  readonly source: string;
  readonly filters: DecisionFilters;
  /** Back to every record of the source, of all time. */
  readonly onClear: () => void;
  /** Whether a filter narrows the log (so clearing it can show more). */
  readonly narrowed: boolean;
}) {
  const api = useApi();
  const schedule = useSchedule();
  const log = useInfiniteQuery(logQuery(api, filters));
  const now = new Date(schedule.now());

  const rows = useMemo(() => log.data?.pages.flatMap((page) => page.decisions) ?? [], [log.data]);
  const lines = useMemo(() => logLines(rows, filters.question), [rows, filters.question]);

  const columns: readonly TableColumn<LogLine>[] = [
    {
      kind: "text",
      id: "when",
      header: "When",
      numeric: true,
      cell: (line) => <Moment at={line.at} now={now} />,
    },
    {
      kind: "text",
      id: "record",
      header: "Record",
      // A key of `.` or `..` would be resolved out of a path, so it goes in the query instead.
      cell: (line) =>
        isDotSegment(line.record) ? (
          <Link
            to="/decisions/history"
            search={{ source, key: line.record }}
            className={RECORD_LINK}
          >
            {line.record}
          </Link>
        ) : (
          <Link
            to="/decisions/$source/$key"
            params={{ source, key: line.record }}
            className={RECORD_LINK}
          >
            {line.record}
          </Link>
        ),
    },
    { kind: "text", id: "question", header: "Question", cell: (line) => line.question },
    {
      kind: "measure",
      id: "figure",
      header: "The model said",
      measure: (line) =>
        line.said === undefined ? undefined : { value: line.said.figure, label: line.said.label },
    },
    { kind: "answer", id: "words", header: "In words", answer: (line) => line.said?.words },
    { kind: "text", id: "decided", header: "Decided", cell: (line) => <Decided line={line} /> },
    {
      kind: "text",
      id: "by",
      header: "By",
      cell: (line) =>
        line.by.kind === "model" ? (
          <span className="text-text-2">the model</span>
        ) : (
          line.by.reviewer
        ),
    },
  ];

  if (log.isPending) {
    return (
      <p role="status" className="text-text-3">
        Reading the log
      </p>
    );
  }
  if (log.isError && log.data === undefined) {
    return <Problem error={log.error} />;
  }
  const more = log.hasNextPage;
  // A failed read after a good one keeps the rows: they are shown as last read, never as current.
  const stale = log.isError;
  if (lines.length === 0 && !more && !stale) {
    return (
      <EmptyState
        title="No decisions match"
        action={narrowed ? <Button onClick={onClear}>Clear the filters</Button> : undefined}
      >
        {narrowed
          ? "Nothing in the log of this source has these filters and this time."
          : "The log of this source is empty. Decisions appear here once the worker has answered a record."}
      </EmptyState>
    );
  }
  const shown =
    lines.length === 0
      ? "Nothing yet in the part of the log read so far."
      : `${lines.length.toLocaleString("en-US")} ${lines.length === 1 ? "decision" : "decisions"}, newest first.${more ? "" : " Nothing older."}`;
  return (
    <div className="grid gap-3">
      {log.isError ? <Problem error={log.error} /> : null}
      {/* A new set of filters is a new table, so its answers fill in again; more rows append. */}
      <SelfFillingTable
        key={JSON.stringify(filters)}
        label={`Decisions of ${source}`}
        columns={columns}
        rows={lines}
        rowKey={(line) => line.id}
        schedule={(run, ms) => schedule.after(ms, run)}
      />
      <div className="flex flex-wrap items-center justify-between gap-3">
        {stale ? (
          <StaleNote what="These rows were" readAt={log.dataUpdatedAt} now={now} />
        ) : (
          <p role="status" className="text-[12.5px] text-text-2">
            {shown}
          </p>
        )}
        {more ? (
          <Button
            variant="quiet"
            size="small"
            disabled={log.isFetchingNextPage}
            onClick={() => {
              void log.fetchNextPage();
            }}
          >
            {log.isFetchingNextPage ? "Reading more" : "Show more"}
          </Button>
        ) : null}
      </div>
      <ZoneNote />
    </div>
  );
}
