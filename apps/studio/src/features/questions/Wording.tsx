import { StatusWord } from "@facetdb/ui";
import { useId } from "react";
import type { DraftValidation } from "../../api/index.ts";
import { Problem, StaleNote } from "../decisions/index.ts";
import { issuePlace, issueWords } from "./words.ts";

/**
 * The Wording section beside the preview: the loader's warnings for the draft in the words `facetdb
 * preview` prints, each with its fix, and the problems that stand under no field. Its one status
 * line says the count, so a screen reader hears each judgement once; the problems under the fields
 * are tied to them and are not announced again.
 */

function countSentence(judged: DraftValidation): string {
  if (!judged.valid) {
    const count = judged.issues.length;
    return count === 1
      ? "The draft has one problem: fix it before testing or applying."
      : `The draft has ${String(count)} problems: fix them before testing or applying.`;
  }
  const count = judged.warnings.length;
  if (count === 0) {
    return "No warnings.";
  }
  return count === 1 ? "One warning." : `${String(count)} warnings.`;
}

export function Wording({
  blocked,
  judged,
  checking,
  failure,
  readAt,
  now,
}: {
  /** A question's name cannot be sent: nothing is judged until it can (draft.ts, `nameProblem`). */
  readonly blocked: boolean;
  /** The last judgement of the draft; undefined before the first one arrives. */
  readonly judged: DraftValidation | undefined;
  /** The draft changed since that judgement, and the settled draft is being judged. */
  readonly checking: boolean;
  /** The newest judgement could not be asked for. */
  readonly failure: Error | null;
  /** When the judgement on screen arrived, in epoch milliseconds. */
  readonly readAt: number;
  readonly now: Date;
}) {
  const id = useId();
  const unplaced = judged?.issues.filter((issue) => issuePlace(issue) === undefined) ?? [];
  return (
    <section className="grid min-w-0 gap-2" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="m-0 text-[17px] font-bold">
        Wording
      </h2>
      {failure === null ? null : (
        <>
          <Problem error={failure} />
          {judged === undefined ? null : (
            <StaleNote what="The judgement below was" readAt={readAt} now={now} />
          )}
        </>
      )}
      <p role="status" className="m-0">
        {blocked ? (
          "A question is marked in the form: the wording is judged, and Preview, Test and Apply are open, once every question has a name of its own and its cut lines in order."
        ) : judged === undefined ? (
          "Checking the wording"
        ) : judged.valid && judged.warnings.length > 0 ? (
          <StatusWord status="warning" size="small" label={countSentence(judged)} />
        ) : (
          countSentence(judged)
        )}
      </p>
      {checking ? <p className="m-0 text-[12.5px] text-text-3">Checking the latest edit</p> : null}
      {judged?.warnings.map((warning) => (
        <div key={`${warning.code}:${warning.question ?? ""}`} className="grid gap-1">
          <p className="m-0">{warning.message}</p>
          <p className="m-0 text-text-2">{`Fix: ${warning.fix}`}</p>
        </div>
      ))}
      {unplaced.map((issue) => (
        <p key={`${issue.path}:${issue.message}`} className="m-0 border-l-2 border-no pl-2">
          {issueWords(issue)}
        </p>
      ))}
      {judged?.valid === true && judged.warnings.length === 0 ? (
        <p className="m-0 text-[12.5px] text-text-2">
          No double negatives, no counting, no date comparisons.
        </p>
      ) : null}
    </section>
  );
}
