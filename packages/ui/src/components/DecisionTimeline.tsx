import type { ReactNode } from "react";

// What happened at an entry, as a visible word before its time: the square's color classes it for
// the eye but is never the only carrier, and the word is what a screen reader reads too.
export type TimelineKind = "created" | "answer" | "human" | "threshold" | "version";

const kindWords: Record<TimelineKind, string> = {
  created: "Record created",
  answer: "Model answer",
  human: "Human decision",
  threshold: "Threshold change",
  version: "Question set version",
};

export type TimelineEntry = {
  id: string;
  kind: TimelineKind;
  // When and by whom or which model, already worded by the page: "Nov 3 10:02 am, jev-1.14.0,
  // wording version 2".
  when: ReactNode;
  // The headline: "Decided Scam? Yes", "Asked again: the seller edited the listing".
  what: ReactNode;
  // The sentence beneath: what the answer was, which cut line applied, what the note said.
  detail?: ReactNode;
};

export type DecisionTimelineProps = {
  // Names the list for a screen reader ("Decisions for record 1042").
  label: string;
  // Newest first, as the "why was this decided" page reads.
  entries: readonly TimelineEntry[];
};

// The vertical strip of the "why was this decided" page: a model answer, a human decision or a
// threshold change at each entry, with the wording and the version in force.
export function DecisionTimeline({ label, entries }: DecisionTimelineProps) {
  return (
    <ol className="fdb-timeline" aria-label={label}>
      {entries.map((entry) => (
        <li key={entry.id} className="fdb-timeline-entry" data-kind={entry.kind}>
          <span className="fdb-timeline-head">
            <span className="fdb-timeline-kind">{kindWords[entry.kind]}</span>
            <span className="fdb-timeline-when">{entry.when}</span>
          </span>
          <span className="fdb-timeline-what">{entry.what}</span>
          {entry.detail === undefined ? null : (
            <span className="fdb-timeline-detail">{entry.detail}</span>
          )}
        </li>
      ))}
    </ol>
  );
}
