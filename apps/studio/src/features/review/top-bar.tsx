import { Listbox, type ListboxOption, StatusWord } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useEffect } from "react";
import { type ReviewFilter, SHELL_REFRESH_MS } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { facetsOf, reviewFacetsQuery, reviewQueueQuery } from "./queries.ts";
import { countWords, timeWords, waitWords } from "./words.ts";

/**
 * The thin bar over the card (Review): how many cards wait and how long the oldest has, and the
 * three filters: source, question and a probability band.
 */

const ALL = "all";

/** The bands of the mockup: a card matches when the model's figure for one of its questions is under it. */
const BANDS: readonly ListboxOption[] = [
  { value: ALL, label: "Any certainty" },
  { value: "0.6", label: "Below 60%" },
  { value: "0.8", label: "Below 80%" },
];

/** The options of one filter: "every", the names offered, and the chosen name even when no card has it now. */
function namesAsOptions(
  every: string,
  names: readonly string[],
  chosen: string | undefined,
): readonly ListboxOption[] {
  const all = chosen === undefined || names.includes(chosen) ? names : [...names, chosen];
  return [{ value: ALL, label: every }, ...all.map((name) => ({ value: name, label: name }))];
}

export function TopBar({
  filter,
  onFilter,
}: {
  readonly filter: ReviewFilter;
  readonly onFilter: (next: ReviewFilter) => void;
}) {
  const api = useApi();
  const schedule = useSchedule();
  const queue = useQuery(reviewQueueQuery(api, filter));
  const facets = facetsOf(useQuery(reviewFacetsQuery(api)).data, filter.source);

  // The figures are asked for again on the injected scheduler, so a test moves the time by hand.
  const { refetch } = queue;
  useEffect(
    () =>
      schedule.every(SHELL_REFRESH_MS, () => {
        void refetch();
      }),
    [schedule, refetch],
  );

  const figures = queue.data;
  let line: ReactNode;
  if (figures !== undefined && queue.isError) {
    // A refresh failed and the query keeps its last good answer: it is shown as the last known,
    // with when it was known, never as the current count.
    line = (
      <>
        <strong className="font-bold text-text">Last known: {countWords(figures.count)}</strong>
        {figures.count > 0 && figures.oldestWaitMs !== null
          ? ` The oldest had waited ${waitWords(figures.oldestWaitMs)} at ${timeWords(queue.dataUpdatedAt)}.`
          : ` As of ${timeWords(queue.dataUpdatedAt)}.`}{" "}
        <span role="alert">
          <StatusWord status="warning" size="small" label="The queue could not be refreshed" />
        </span>
      </>
    );
  } else if (figures !== undefined) {
    line = (
      <>
        <strong className="font-bold text-text">{countWords(figures.count)}</strong>
        {figures.count > 0 && figures.oldestWaitMs !== null
          ? ` The oldest has waited ${waitWords(figures.oldestWaitMs)}.`
          : ""}
      </>
    );
  } else {
    line = queue.isError ? "The queue could not be counted." : "Counting the cards.";
  }

  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-hairline pb-4.5 text-text-2">
      <p className="m-0">{line}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Listbox
          label="Source"
          options={namesAsOptions("Every source", facets.sources, filter.source)}
          value={filter.source ?? ALL}
          onValueChange={(value) => {
            // A question belongs to a source: choosing another source starts over on the question.
            onFilter(filterOf({ source: value === ALL ? undefined : value, below: filter.below }));
          }}
        />
        <Listbox
          label="Question"
          options={namesAsOptions("Every question", facets.questions, filter.question)}
          value={filter.question ?? ALL}
          onValueChange={(value) => {
            onFilter(filterOf({ ...filter, question: value === ALL ? undefined : value }));
          }}
        />
        <Listbox
          label="Certainty"
          options={BANDS}
          value={filter.below === undefined ? ALL : String(filter.below)}
          onValueChange={(value) => {
            onFilter(filterOf({ ...filter, below: value === ALL ? undefined : Number(value) }));
          }}
        />
      </div>
    </div>
  );
}

/** A filter of the parts that are set (the surface refuses a field it was not meant to get). */
function filterOf(parts: {
  readonly source?: string | undefined;
  readonly question?: string | undefined;
  readonly below?: number | undefined;
}): ReviewFilter {
  return {
    ...(parts.source === undefined ? {} : { source: parts.source }),
    ...(parts.question === undefined ? {} : { question: parts.question }),
    ...(parts.below === undefined ? {} : { below: parts.below }),
  };
}
