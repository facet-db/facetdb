import { Dither, StatusWord, type TimelineEntry } from "@facetdb/ui";
import type { DecisionOutcome, ExplainedEntry } from "../../api/index.ts";
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

/**
 * What an answer came to, by the tag the worker sends beside the words, never by the words: an
 * option may be named "needs review" or "unknown", and the model deciding it is a decision.
 */
export function Outcome({
  outcome,
  words,
}: {
  readonly outcome: DecisionOutcome;
  readonly words: string;
}) {
  switch (outcome) {
    case "needs_review":
      return <StatusWord status="needs_review" size="small" />;
    case "unknown":
      return (
        <span className="text-text-2">
          unknown<span className="sr-only">, the question set it ran under is no longer kept</span>
        </span>
      );
    case "decided":
      return <span className="font-semibold text-text">{words}</span>;
  }
}

/** The version as explain says it ("question set v3"). */
function version(entry: { readonly version: number }): string {
  return `question set v${String(entry.version)}`;
}

function Answers({ entry }: { readonly entry: Answered }) {
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
            <Outcome outcome={answer.outcome} words={answer.decision} />
          </span>
        </li>
      ))}
    </ul>
  );
}

type Answered = Extract<ExplainedEntry, { kind: "answer" }>;

/**
 * Why a record was asked again, from the model answer before this one: the state hash changed (the
 * record changed), or the question-set version did (its wording, criteria, state fields or model).
 * A threshold change asks nothing, so it is not here.
 */
function askedAgain(entry: Answered, before: Answered): string {
  const changed = entry.stateHash !== before.stateHash;
  const reworded = entry.version !== before.version;
  if (changed && reworded) {
    return `Asked again: the record changed, under ${version(entry)}`;
  }
  if (changed) {
    return "Asked again: the record changed";
  }
  return reworded ? `Asked again under ${version(entry)}` : "Asked again";
}

/** One entry of the history as the timeline has it; `before` is the model answer before it, if any. */
function timelineEntry(
  entry: ExplainedEntry,
  id: string,
  before: Answered | undefined,
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
        what: before === undefined ? "First answer" : askedAgain(entry, before),
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
  let before: Answered | undefined;
  return entries
    .map((entry, index) => {
      const shown = timelineEntry(entry, String(index), before, now);
      if (entry.kind === "answer") {
        before = entry;
      }
      return shown;
    })
    .reverse();
}
