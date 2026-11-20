import { Button, SelfFillingTable, type TableColumn } from "@facetdb/ui";
import { useId } from "react";
import { useSchedule } from "../../deps.tsx";
import { Problem, StaleNote } from "../decisions/index.ts";
import { type PreviewLine, previewColumns, previewLines, skipWords } from "./answers.ts";
import { previewKey, type SourceForm } from "./draft.ts";
import type { PreviewState } from "./preview.ts";
import { countWords, dollarWords, plural } from "./words.ts";

/**
 * The live preview (the right of the split): the newest rows of the source with the draft's answers
 * filling in, each answer in words beside its dither strip and number, the row's status at the end,
 * and its cost. The answers are re-decided here under the thresholds on the page now, so a cut line
 * moved changes the table and the counts, and asks nothing.
 */

/**
 * Why the rows on screen are not the draft's, and what asks again: only what is true. An edit of the
 * person's is sent when the typing stops; a failed run is not tried again on its own; a config read
 * again under a draft nobody edited waits for the person.
 */
function earlierWords(preview: PreviewState, blocked: boolean, source: string): string {
  if (blocked) {
    return "These rows were answered for the questions before the problem now marked in the form; nothing is asked until every question has a name of its own and its cut lines in order.";
  }
  if (preview.editPending) {
    return "These rows were answered for an earlier wording of the draft; they are answered again 1.5 seconds after the typing stops.";
  }
  if (preview.error !== null) {
    return 'These rows were answered for an earlier wording of the draft. The next edit, or "Preview again", asks again.';
  }
  return `These rows were answered for an earlier configuration of ${source}; "Preview again" answers them for the questions as they are now.`;
}

/** The record's own fields shown beside the answers: the first of what the source reads. */
const STATE_COLUMNS = 2;

export function PreviewPanel({
  source,
  read,
  form,
  preview,
  blocked,
}: {
  readonly source: string;
  readonly read: readonly string[];
  /** The draft now: its thresholds decide the rows. */
  readonly form: SourceForm;
  readonly preview: PreviewState;
  /** A question's name cannot be sent (draft.ts, `nameProblem`): nothing is asked until it can. */
  readonly blocked: boolean;
}) {
  const id = useId();
  const schedule = useSchedule();
  const { shown } = preview;
  const fields = read.slice(0, STATE_COLUMNS);
  const columns = shown === null ? [] : previewColumns(shown.form, form);
  const lines = shown === null ? [] : previewLines(shown.result.rows, columns);
  const asked = lines.filter((line) => line.status !== "skipped");
  const decided = asked.filter((line) => line.status === "done").length;
  const skipped = lines.length - asked.length;
  const undecided = asked.some((line) => line.status === "pending");

  const table: TableColumn<PreviewLine>[] = [
    ...fields.map(
      (field, index): TableColumn<PreviewLine> => ({
        kind: "text",
        id: `field:${field}`,
        header: field,
        cell: (line) => {
          if (line.status === "skipped") {
            const reason = shown?.result.rows.find((row) => row.key === line.key);
            return index === 0 && reason?.kind === "skipped" ? (
              <span className="text-text-2">{`${line.key}: ${skipWords(reason.reason)}`}</span>
            ) : null;
          }
          return <span className="block max-w-[30ch] truncate">{line.state[field] ?? ""}</span>;
        },
      }),
    ),
    ...columns.flatMap(({ question }): TableColumn<PreviewLine>[] => [
      {
        kind: "answer",
        id: `answer:${question.name}`,
        header: question.name,
        answer: (line) => line.cells.get(question.name)?.decided,
      },
      {
        kind: "measure",
        id: `measure:${question.name}`,
        header: question.type === "noul" ? "Likely yes" : "Sure",
        measure: (line) => {
          const cell = line.cells.get(question.name);
          return cell === undefined ? undefined : { value: cell.figure, label: cell.label };
        },
      },
    ]),
    { kind: "status", id: "status", header: "Status", status: (line) => line.status },
  ];

  const costLine =
    shown === null
      ? "Not asked yet. Each preview asks the model once for each of the 20 newest rows, under the spending cap, and says what it cost."
      : `The ${plural(shown.result.rows.length, "newest row", "newest rows")}, answered for ${dollarWords(shown.result.cost.dollars)} (${countWords(shown.result.cost.inputTokens)} input tokens).`;
  const forEarlierDraft = shown !== null && shown.key !== previewKey(form);

  return (
    <section className="grid min-w-0 gap-3" aria-labelledby={`${id}-title`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id={`${id}-title`} className="m-0 text-[17px] font-bold">
            Live preview
          </h2>
          <p className="m-0 text-[12.5px] text-text-2">{costLine}</p>
          {preview.runs > 1 ? (
            <p className="m-0 text-[12.5px] text-text-2">
              {`Previews of ${source} on this page so far: ${countWords(preview.runs)}, ${dollarWords(preview.spent)} together.`}
            </p>
          ) : null}
        </div>
        <Button
          variant="secondary"
          size="small"
          disabled={preview.running || blocked}
          onClick={preview.run}
        >
          {preview.armed ? "Preview again" : "Preview 20 rows"}
        </Button>
      </div>
      {blocked ? (
        <p className="m-0 text-[12.5px] text-text-2">
          The preview waits until every question has a name of its own and its cut lines in order:
          see the question marked in the form.
        </p>
      ) : null}
      {preview.armed ? null : (
        <p className="m-0 max-w-[64ch] text-text-2">
          After the first preview, the rows are answered again 1.5 seconds after you stop typing.
          Moving a cut line re-decides these rows on the page and asks nothing.
        </p>
      )}
      <p role="status" className="m-0 text-[12.5px] text-text-2">
        {preview.running ? `Asking the model about the newest rows of ${source}` : ""}
      </p>
      {preview.error === null ? null : (
        <div className="grid gap-1">
          <Problem error={preview.error} />
          {shown === null ? null : (
            <StaleNote
              what="The rows below, from the last preview that answered, were"
              readAt={shown.at}
              now={new Date(schedule.now())}
            />
          )}
        </div>
      )}
      {forEarlierDraft ? (
        <p className="m-0 text-[12.5px] text-text-2">{earlierWords(preview, blocked, source)}</p>
      ) : null}
      {shown === null ? null : (
        <>
          <SelfFillingTable
            key={shown.run}
            label={`Live preview of ${source}`}
            columns={table}
            rows={lines}
            rowKey={(line) => line.key}
            schedule={(run, ms) => schedule.after(ms, run)}
          />
          <p className="m-0 text-[12.5px] text-text-2">
            {undecided
              ? "Nothing is decided under cut lines that cross: the rows are decided again once they are in order."
              : `${countWords(decided)} of ${plural(asked.length, "answered row", "answered rows")} decided automatically at these thresholds, ${countWords(asked.length - decided)} to review.${skipped === 0 ? "" : ` ${plural(skipped, "row was", "rows were")} not asked.`}`}
          </p>
        </>
      )}
    </section>
  );
}
