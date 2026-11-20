import { Button, Dialog, DialogClose, DitherStrip } from "@facetdb/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import {
  type AgreementSide,
  ApiError,
  type SourceDraft,
  type TestQuestionRow,
  type TestResult,
} from "../../api/index.ts";
import { useApi } from "../../deps.tsx";
import { Problem } from "../decisions/index.ts";
import { countWords, dollarWords, plural } from "./words.ts";

/**
 * Test: the draft against the version in force on the newest records and every record a person
 * decided. It spends up to a thousand model requests, so the dialog asks the estimate first
 * (`estimate: true` reads the records and asks nothing), shows the cost, and runs only on the
 * person's "Run the test", once. The result is per question: the answers that would change and the
 * agreement with reviewers now and with the draft, then "Apply this draft".
 */

const percent = (rate: number): string => `${String(Math.round(rate * 100))}%`;

/**
 * No answer, or an answer that is not the surface's (`unreadable`: a proxy's page, a dropped body):
 * whether the model was asked is not known.
 */
function outcomeUnknown(failure: Error): boolean {
  return !(failure instanceof ApiError) || failure.code === "unreadable";
}

/**
 * A refusal another run can clear: the model did not answer one record (503 model_unavailable, "test
 * again in a minute"). Every other refusal is known and stands for the same draft: the spending cap
 * (429 spending_cap_reached, until the month resets), the draft's problems (invalid_draft,
 * invalid_request), its fields (fields_differ), the source (unknown_source), the project.
 */
function clearsOnRetry(failure: Error): boolean {
  return failure instanceof ApiError && failure.code === "model_unavailable";
}

function Side({ side, words }: { readonly side: AgreementSide | null; readonly words: string }) {
  if (side === null || side.rate === null) {
    return <span className="text-text-2">{`no decision ${words}`}</span>;
  }
  const label = `${percent(side.rate)} agree ${words}`;
  return (
    <span className="inline-flex items-center gap-2">
      <DitherStrip value={side.rate} label={label} width={40} rows={6} />
      <span className="font-mono" aria-hidden="true">
        {percent(side.rate)}
      </span>
      <span className="text-text-2" aria-hidden="true">
        {words}
      </span>
    </span>
  );
}

function Changed({ row }: { readonly row: TestQuestionRow }) {
  switch (row.comparison) {
    case "new":
      return <span className="text-text-2">new: nothing to compare</span>;
    case "kind-changed":
      return <span className="text-text-2">another kind now: not compared</span>;
    case "compared":
      return (
        <span className="font-mono">{`${countWords(row.changed)} of ${countWords(row.compared)}`}</span>
      );
  }
}

function Agreement({ row }: { readonly row: TestQuestionRow }) {
  if (row.agreement.kind === "none") {
    return <span className="text-text-2">nobody decided this question yet</span>;
  }
  return (
    <span className="flex flex-wrap items-center gap-x-4.5 gap-y-1">
      <Side side={row.agreement.now} words="now" />
      <Side side={row.agreement.draft} words="with the draft" />
    </span>
  );
}

function moves(row: TestQuestionRow): string | null {
  if (row.changed === 0 || row.comparison !== "compared") {
    return null;
  }
  const parts = [
    `${countWords(row.toDecided)} move from unsure to a decision`,
    `${countWords(row.toReview)} the other way`,
    ...(row.toAnotherValue === 0 ? [] : [`${countWords(row.toAnotherValue)} to another value`]),
  ];
  return `${row.question}: of the ${countWords(row.changed)}, ${parts.join(", ")}.`;
}

function Result({ result }: { readonly result: TestResult }) {
  const notAsked = Object.values(result.skipped).reduce((sum, count) => sum + count, 0);
  return (
    <div className="grid gap-3">
      <p className="m-0 text-text-2">
        {`${plural(result.sample.records, "recent record", "recent records")} and the ${plural(result.reviewed.records, "record a person decided", "records a person decided")}, answered with the draft for ${dollarWords(result.cost.dollars)} (about ${dollarWords(result.estimate.dollars)} was estimated).`}
      </p>
      <div className="fdb-table-frame">
        <table className="fdb-table" aria-label="What the draft would change">
          <thead>
            <tr>
              <th scope="col">Question</th>
              <th scope="col">Answers that would change</th>
              <th scope="col">Agreement with reviewers</th>
            </tr>
          </thead>
          <tbody>
            {result.questions.map((row) => (
              <tr key={row.question}>
                <td>{row.question}</td>
                <td data-numeric="">
                  <Changed row={row} />
                </td>
                <td>
                  <Agreement row={row} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {result.questions.flatMap((row) => {
        const words = moves(row);
        return words === null
          ? []
          : [
              <p key={row.question} className="m-0 text-[12.5px] text-text-2">
                {words}
              </p>,
            ];
      })}
      {result.removed.length === 0 ? null : (
        <p className="m-0 text-[12.5px] text-text-2">
          {`The draft drops ${result.removed.join(", ")}: its answers stay as they are.`}
        </p>
      )}
      {notAsked === 0 ? null : (
        <p className="m-0 text-[12.5px] text-text-2">
          {`${plural(notAsked, "record was", "records were")} not asked (left out by the where filter, empty, too large, or past the spending cap).`}
        </p>
      )}
    </div>
  );
}

function TestBody({
  source,
  draft,
  run: nonce,
  onApply,
}: {
  readonly source: string;
  readonly draft: SourceDraft;
  /** This opening of the dialog: each one asks a fresh estimate. */
  readonly run: number;
  readonly onApply: () => void;
}) {
  const api = useApi();
  // The draft as it was when the dialog opened: the estimate and the run are of the same one.
  const [asked] = useState(draft);
  const estimate = useQuery({
    queryKey: ["questions", "test-estimate", nonce],
    queryFn: () => api.testEstimate(asked),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
  });
  const test = useMutation({ mutationFn: () => api.testDraft(asked) });
  // One run per yes: a second click, or a click before the button is disabled, sends nothing. A run
  // that failed may already have asked the model, so running again is a second, separate yes, said
  // with what it may spend (`runAgain`), never the first button come back.
  const sent = useRef(false);

  const runTest = () => {
    if (sent.current) {
      return;
    }
    sent.current = true;
    test.mutate();
  };
  const failure = test.error;
  /** The failure a second yes was given for: one more run per failure shown, however many clicks. */
  const retriedFor = useRef<Error | null>(null);
  const runAgain = () => {
    if (failure === null || retriedFor.current === failure) {
      return;
    }
    retriedFor.current = failure;
    sent.current = false;
    runTest();
  };
  const unanswered = failure !== null && outcomeUnknown(failure);
  const retryable = failure !== null && (unanswered || clearsOnRetry(failure));

  return (
    <div className="grid gap-4.5">
      {estimate.isPending ? (
        <p role="status" className="m-0 text-text-2">
          {`Reading the records of ${source} to price the test`}
        </p>
      ) : null}
      {estimate.isError ? <Problem error={estimate.error} /> : null}
      {estimate.data === undefined || test.isSuccess ? null : (
        <p className="m-0">
          {`The test reads the ${plural(estimate.data.sampleRecords, "newest record", "newest records")} of ${source} and the ${plural(estimate.data.reviewedRecords, "record a person decided", "records a person decided")}, and asks the model ${plural(estimate.data.requests, "time", "times")} with the draft: about ${countWords(Math.round(estimate.data.inputTokens))} input tokens, about ${dollarWords(estimate.data.dollars)}, under the spending cap. Nothing is written.`}
        </p>
      )}
      <p role="status" className="m-0 text-text-2">
        {test.isPending ? "Asking the model with the draft" : ""}
      </p>
      {failure === null || unanswered ? null : <Problem error={failure} />}
      {unanswered ? (
        <p role="alert" className="m-0 border-l-2 border-no pl-3">
          {`The worker did not answer, so whether the model was asked is not known: the test may already have asked it up to ${plural(estimate.data?.requests ?? 0, "time", "times")}, about ${dollarWords(estimate.data?.dollars ?? 0)}. Running it again may spend the same again.`}
        </p>
      ) : null}
      {!retryable || estimate.data === undefined ? null : (
        <p className="m-0 text-text-2">
          {`A run that failed may have asked the model already; running the test again asks it again, up to about ${dollarWords(estimate.data.dollars)} more.`}
        </p>
      )}
      {test.data === undefined ? null : <Result result={test.data} />}
      <div className="fdb-dialog-actions">
        <DialogClose asChild>
          <Button variant="quiet">Close</Button>
        </DialogClose>
        {test.isSuccess ? (
          <Button variant="primary" onClick={onApply}>
            Apply this draft
          </Button>
        ) : failure !== null ? (
          // A known refusal shows its message and fix alone: nothing was spent, and the same run
          // would be refused again.
          retryable && estimate.data !== undefined ? (
            <Button variant="primary" onClick={runAgain}>
              {`Run it again, spending up to about ${dollarWords(estimate.data.dollars)} more`}
            </Button>
          ) : null
        ) : (
          <Button
            variant="primary"
            disabled={estimate.data === undefined || test.isPending}
            onClick={runTest}
          >
            {estimate.data === undefined
              ? "Run the test"
              : `Run the test for about ${dollarWords(estimate.data.dollars)}`}
          </Button>
        )}
      </div>
    </div>
  );
}

export function TestDialog({
  source,
  draft,
  inForce,
  open,
  onOpenChange,
  onApply,
}: {
  readonly source: string;
  readonly draft: SourceDraft;
  /** The version the worker answers under now: the test's "now" side. */
  readonly inForce: number | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Leads to Apply with the same draft. */
  readonly onApply: () => void;
}) {
  const [opened, setOpened] = useState(0);
  return (
    <Dialog
      title={
        inForce === null ? "Test this draft" : `Test: this draft against version ${String(inForce)}`
      }
      trigger={<Button>Test</Button>}
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setOpened((count) => count + 1);
        }
        onOpenChange(next);
      }}
    >
      <TestBody key={opened} source={source} draft={draft} run={opened} onApply={onApply} />
    </Dialog>
  );
}
