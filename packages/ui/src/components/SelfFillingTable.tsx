import { type ReactNode, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type DitherContextFactory, DitherStrip } from "../dither/index.ts";
import { motionMs } from "../tokens/index.ts";
import { type StatusKind, StatusWord } from "./StatusWord.tsx";

// One column of the table. A question takes two (its answer in words, its measure as a dither
// strip with the number) and the record's status one at the row's end; those three kinds fill in.
// `text` columns (the record's own fields) render with the row at once.
export type TableColumn<Row> =
  | {
      kind: "text";
      id: string;
      header: string;
      cell: (row: Row) => ReactNode;
      // Figures: right-aligned in the measured face.
      numeric?: boolean;
    }
  | {
      kind: "answer";
      id: string;
      header: string;
      // The decided answer in words; null when the model answered but nothing was decided
      // ("unsure", the muted word); undefined while there is no answer yet (the cell stays empty
      // and lands when the answer arrives).
      answer: (row: Row) => string | null | undefined;
    }
  | {
      kind: "measure";
      id: string;
      header: string;
      // The probability or confidence behind the answer and the words that carry it for a screen
      // reader ("Scam? 58% likely yes"); undefined while there is no answer yet.
      measure: (row: Row) => { value: number; label: string } | undefined;
    }
  | { kind: "status"; id: string; header: string; status: (row: Row) => StatusKind };

// Starts a timer and returns what stops it; the fill's clock, which a test replaces.
export type Schedule = (run: () => void, delayMs: number) => () => void;

export const timeoutSchedule: Schedule = (run, delayMs) => {
  const handle = setTimeout(run, delayMs);
  return () => {
    clearTimeout(handle);
  };
};

// Brief section 3: cells land 40 ms apart, 20 at most staggered on screen; any cell past the
// twentieth lands with it, so a long table still fills in about 0.8 s.
const staggeredCells = 20;

const reducedMotionQuery = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void): () => void {
  const query = window.matchMedia(reducedMotionQuery);
  query.addEventListener("change", onChange);
  return () => {
    query.removeEventListener("change", onChange);
  };
}

function reducedMotionSnapshot(): boolean {
  return window.matchMedia(reducedMotionQuery).matches;
}

export type SelfFillingTableProps<Row> = {
  // Names the table for a screen reader.
  label: string;
  columns: readonly TableColumn<Row>[];
  rows: readonly Row[];
  rowKey: (row: Row) => string;
  // Reduced motion: by default the user's preference; every cell then renders at once.
  reducedMotion?: boolean;
  // The fill's clock, 40 ms between cells; by default setTimeout.
  schedule?: Schedule;
  // Passed to the measure strips (tests pass fakes; by default the device's).
  ratio?: number;
  context?: DitherContextFactory;
};

type FillColumn<Row> = Exclude<TableColumn<Row>, { kind: "text" }>;

function isFill<Row>(column: TableColumn<Row>): column is FillColumn<Row> {
  return column.kind !== "text";
}

// Whether the cell has anything to show yet: a cell without an answer is empty, not landed.
function hasContent<Row>(column: FillColumn<Row>, row: Row): boolean {
  if (column.kind === "answer") return column.answer(row) !== undefined;
  if (column.kind === "measure") return column.measure(row) !== undefined;
  return true;
}

// A data table with a full grid: the record's fields appear with the row, and the answer and
// measure cells and the status land one after another, 40 ms apart, in reading order (left to
// right, row by row) as rows arrive. Rows that arrive later queue behind the cells still landing; a
// cell that has landed stays. Under reduced motion everything renders at once.
export function SelfFillingTable<Row>({
  label,
  columns,
  rows,
  rowKey,
  reducedMotion,
  schedule = timeoutSchedule,
  ratio,
  context,
}: SelfFillingTableProps<Row>) {
  const preferred = useSyncExternalStore(subscribeToReducedMotion, reducedMotionSnapshot);
  const instant = reducedMotion ?? preferred;
  const [landed, setLanded] = useState<ReadonlySet<string>>(() => new Set());
  const queued = useRef(new Map<string, () => void>());

  const fillColumns = columns.filter(isFill);
  const cellKey = (row: Row, column: FillColumn<Row>): string => `${rowKey(row)}|${column.id}`;

  // Reading order: row by row, the fill columns in column order.
  const readingOrder = rows.flatMap((row) =>
    fillColumns.filter((column) => hasContent(column, row)).map((column) => cellKey(row, column)),
  );

  // No dependency array, on purpose: what this reads (the rows, the columns' functions, the
  // clock) is whatever the caller passed this render and is usually a new array or closure each
  // time, so a list of dependencies would be either wrong or always changing. It is idempotent
  // instead: it drops what has gone (a cell that left the reading order, say a row removed or an
  // answer gone blank, loses its landed mark and its timer, and fills again if it comes back),
  // then queues the cells that are neither landed nor already waiting, behind those waiting.
  useEffect(() => {
    const live = new Set(readingOrder);
    const waiting = queued.current;
    for (const [key, cancel] of waiting) {
      if (live.has(key)) continue;
      cancel();
      waiting.delete(key);
    }
    if ([...landed].some((key) => !live.has(key))) {
      setLanded((previous) => new Set([...previous].filter((key) => live.has(key))));
    }
    if (instant) return;
    const fresh = readingOrder.filter((key) => !landed.has(key) && !waiting.has(key));
    const behind = waiting.size;
    fresh.forEach((key, index) => {
      const slot = Math.min(behind + index, staggeredCells - 1);
      const cancel = schedule(() => {
        waiting.delete(key);
        setLanded((previous) => new Set(previous).add(key));
      }, slot * motionMs["motion-fill-step"]);
      waiting.set(key, cancel);
    });
  });

  // Unmounting stops the timers.
  useEffect(() => {
    const waiting = queued.current;
    return () => {
      for (const cancel of waiting.values()) cancel();
      waiting.clear();
    };
  }, []);

  const strip = {
    ...(ratio === undefined ? {} : { ratio }),
    ...(context === undefined ? {} : { context }),
  };

  function fillContent(column: FillColumn<Row>, row: Row): ReactNode {
    if (column.kind === "answer") {
      const answer = column.answer(row);
      if (answer === undefined) return null;
      return answer === null ? (
        <span className="fdb-answer-unsure">unsure</span>
      ) : (
        <span className="fdb-answer-word">{answer}</span>
      );
    }
    if (column.kind === "measure") {
      const measure = column.measure(row);
      if (measure === undefined) return null;
      return (
        <span className="fdb-measure">
          <DitherStrip value={measure.value} label={measure.label} width={48} rows={6} {...strip} />
          <span className="fdb-measure-figure" aria-hidden="true">
            {`${String(Math.round(measure.value * 100))}%`}
          </span>
        </span>
      );
    }
    return <StatusWord status={column.status(row)} size="small" />;
  }

  return (
    <div className="fdb-table-frame fdb-brackets">
      {/* A scrolling region must be reachable by keyboard, or its off-screen columns are not. */}
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: the scroller is the keyboard's way to the columns beyond the viewport */}
      <section className="fdb-table-wrap" aria-label={`${label}, scrollable`} tabIndex={0}>
        <table className="fdb-table" aria-label={label}>
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.id} scope="col">
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={rowKey(row)}>
                {columns.map((column) => {
                  if (column.kind === "text") {
                    return (
                      <td
                        key={column.id}
                        {...(column.numeric === true ? { "data-numeric": "" } : {})}
                      >
                        {column.cell(row)}
                      </td>
                    );
                  }
                  const shown = instant || landed.has(cellKey(row, column));
                  return (
                    <td
                      key={column.id}
                      data-fill={column.kind}
                      {...(shown && !instant && hasContent(column, row)
                        ? { "data-landed": "" }
                        : {})}
                    >
                      {shown ? fillContent(column, row) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
