import { Dither, type TimelineEntry } from "@facetdb/ui";
import type { ExplainedEntry } from "../../api/index.ts";
import { Moment } from "../decisions/index.ts";

/**
 * A record's history as the why page words it. The entries are `facetdb explain`'s, in its words,
 * oldest first as the worker sends them; the page reads newest first, so the decision in force is
 * on top. Every string below is the customer's or the model's text and is placed as text.
 */

/**
 * The share a said-sentence carries, 0 to 1, for the dither beside it: "58% likely yes" and
 * "billing, 82% sure" both end in the figure explain wrote (packages/core, log/explain.ts, percent()).
 * Undefined if the sentence has none, and then no strip is drawn: the words stand alone.
 */
export function shareOf(said: string): number | undefined {
  const last = [...said.matchAll(/(\d{1,3})%/g)].at(-1);
  return last?.[1] === undefined ? undefined : Number(last[1]) / 100;
}

/** A decorative strip beside words that already say the figure. */
export function Share({ said }: { readonly said: string }) {
  const share = shareOf(said);
  return share === undefined ? null : (
    <span aria-hidden="true" className="inline-flex shrink-0">
      <Dither value={share} size={16} label={said} />
    </span>
  );
}

export function At({ at, now }: { readonly at: string; readonly now: Date }) {
  return <Moment at={at} now={now} />;
}

/** The version as explain says it ("question set v3"). */
function version(entry: { readonly version: number }): string {
  return `question set v${String(entry.version)}`;
}

function Answers({ entry }: { readonly entry: Extract<ExplainedEntry, { kind: "answer" }> }) {
  return (
    <ul className="grid gap-1.5">
      {entry.answers.map((answer) => (
        <li key={answer.question} className="flex items-start gap-2.5">
          <span className="mt-0.5">
            <Share said={answer.said} />
          </span>
          <span>
            {`"${answer.wording}" `}
            <span className="font-semibold text-text">{answer.said}</span>
            <span aria-hidden="true"> → </span>
            <span className="sr-only">, so </span>
            <span className="font-semibold text-text">{answer.decision}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** One entry of the history as the timeline has it; `first` is whether it is the first model answer. */
function timelineEntry(
  entry: ExplainedEntry,
  id: string,
  first: boolean,
  now: Date,
): TimelineEntry {
  switch (entry.kind) {
    case "answer":
      return {
        id,
        kind: "answer",
        when: (
          <>
            <At at={entry.at} now={now} />
            {`, ${entry.model}, ${version(entry)}`}
          </>
        ),
        what: first ? "First answer" : "Asked again",
        detail: <Answers entry={entry} />,
      };
    case "human":
      return {
        id,
        kind: "human",
        when: (
          <>
            <At at={entry.at} now={now} />
            {`, ${entry.reviewer}, ${version(entry)}`}
          </>
        ),
        what: `"${entry.wording}" decided ${entry.decided}`,
        ...(entry.note === undefined ? {} : { detail: `Note: ${entry.note}` }),
      };
    case "withdrawal":
      return {
        id,
        kind: "human",
        when: (
          <>
            <At at={entry.at} now={now} />
            {`, ${entry.reviewer}, ${version(entry)}`}
          </>
        ),
        what: `"${entry.wording}" decision withdrawn`,
        detail: `${entry.reviewer} took back their own decision. Both stay in the log.`,
      };
  }
}

/** The timeline's entries, newest first. */
export function timelineEntries(
  entries: readonly ExplainedEntry[],
  now: Date,
): readonly TimelineEntry[] {
  const firstAnswer = entries.findIndex((entry) => entry.kind === "answer");
  return entries
    .map((entry, index) => timelineEntry(entry, String(index), index === firstAnswer, now))
    .reverse();
}
