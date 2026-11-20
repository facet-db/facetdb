import type { ComponentProps } from "react";

// What a status badge can say: the six record statuses, the three alert severities, and `resolved`,
// the state an alert reaches (the alerts page).
export const recordStatuses = [
  "pending",
  "done",
  "needs_review",
  "error",
  "unchecked",
  "skipped",
] as const;
export const alertSeverities = ["critical", "warning", "information"] as const;
export const statusKinds = [...recordStatuses, ...alertSeverities, "resolved"] as const;
export type StatusKind = (typeof statusKinds)[number];

type Tone = "yes" | "review" | "no" | "pending" | "skipped";

// The word each kind shows (sentence case) and the role of its square.
const statuses: Record<StatusKind, { word: string; tone: Tone }> = {
  pending: { word: "pending", tone: "pending" },
  done: { word: "done", tone: "yes" },
  needs_review: { word: "needs review", tone: "review" },
  error: { word: "error", tone: "no" },
  unchecked: { word: "unchecked", tone: "pending" },
  skipped: { word: "skipped", tone: "skipped" },
  critical: { word: "critical", tone: "no" },
  warning: { word: "warning", tone: "review" },
  information: { word: "information", tone: "yes" },
  resolved: { word: "resolved", tone: "skipped" },
};

// The word of a status, for a table cell's text or a toast's announcement.
export function statusWord(status: StatusKind): string {
  return statuses[status].word;
}

export type StatusWordProps = Omit<ComponentProps<"span">, "children"> & {
  status: StatusKind;
  // The word is the status's own unless the surface adds detail the status governs ("resolved
  // 11:09 pm", "Beating, 2 s ago"); a status is never shown without a word.
  label?: string;
  size?: "default" | "small";
};

// A status is an 8 px square (the tag's is 6 px) in the status color plus the word in the text
// color: never color alone, and the status colors pass 3:1 only, so they never set a word.
export function StatusWord({ status, label, size = "default", ...rest }: StatusWordProps) {
  const { word, tone } = statuses[status];
  return (
    <span className="fdb-status" data-status={status} data-tone={tone} data-size={size} {...rest}>
      {label ?? word}
    </span>
  );
}
