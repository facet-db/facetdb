import { Button, buttonClasses, EmptyState, Listbox } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { DecisionFilters } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { PageHead } from "../../shell/index.ts";
import { Choices, Problem, TextFilter } from "./controls.tsx";
import { LogView } from "./LogView.tsx";
import { sourceNamesQuery } from "./queries.ts";
import { RunsView } from "./RunsView.tsx";
import {
  type DecisionsPatch,
  type DecisionsSearch,
  narrowed,
  STATUS_CHOICES,
  TIME_CHOICES,
  TIME_WORDS,
  type TimeChoice,
  timeStart,
} from "./search.ts";
import { dayKey, untilNextDay, whenWords } from "./when.ts";

/** The Time choice a digest's range shows as, pressed, beside the four. */
const RANGE = "range" as const;

/**
 * The Decisions page: the log of one source and the run log as two views, the record key, the
 * source and the status at hand, the time as four plain choices, and the question and the reviewer
 * behind "More filters". The view is the address (`search`), and a change goes back to it
 * (`onChange`): the page keeps no filter of its own.
 */

/** The listbox's word for "no source chosen" on the Runs tab: no source name can be this. */
const EVERY_SOURCE = "*";
const ANY_STATUS = "any";

const STATUS_WORDS = { decided: "Decided", needs_review: "Needs review" } as const;

export function DecisionsPage({
  search,
  onChange,
}: {
  readonly search: DecisionsSearch;
  readonly onChange: (patch: DecisionsPatch) => void;
}) {
  const api = useApi();
  const schedule = useSchedule();
  const sources = useQuery(sourceNamesQuery(api));
  const runs = search.tab === "runs";
  const time = search.time ?? "today";
  const [asked, setAsked] = useState(false);
  // A filter in the address is never hidden: if one is set, its box is showing.
  const more = asked || search.question !== undefined || search.reviewer !== undefined;

  // A source the config no longer has (a stale link) is the default, never a refused request.
  const names = sources.data;
  const known =
    names !== undefined && search.source !== undefined && names.includes(search.source)
      ? search.source
      : undefined;
  const source = known ?? (runs ? undefined : names?.[0]);

  // "Today" is the day the clock says now: when midnight passes the start moves with it, so a page
  // left open does not keep showing yesterday as today. One tick, set for just after midnight; the
  // day is read again when it fires, and an unchanged day changes nothing.
  const [day, setDay] = useState(() => dayKey(new Date(schedule.now())));
  // biome-ignore lint/correctness/useExhaustiveDependencies: `day` re-arms the tick for the next midnight once this one has fired
  useEffect(
    () =>
      schedule.after(untilNextDay(new Date(schedule.now())), () => {
        setDay(dayKey(new Date(schedule.now())));
      }),
    [day, schedule],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: `day` is what turns the start over
  const start = useMemo(() => timeStart(time, new Date(schedule.now())), [time, schedule, day]);
  // A digest's link names the decision times of its records instead of a choice.
  const range =
    search.from === undefined || search.to === undefined
      ? undefined
      : { from: search.from, to: search.to };
  const filters: DecisionFilters | undefined =
    source === undefined
      ? undefined
      : {
          source,
          ...(search.q === undefined ? {} : { key: search.q }),
          ...(search.question === undefined ? {} : { question: search.question }),
          ...(search.status === undefined ? {} : { status: search.status }),
          ...(search.reviewer === undefined ? {} : { reviewer: search.reviewer }),
          ...(range ?? (start === undefined ? {} : { from: start.toISOString() })),
        };
  const rangeWords =
    range === undefined
      ? undefined
      : `${whenWords(new Date(range.from), new Date(schedule.now()), { seconds: true })} to ${whenWords(
          new Date(range.to),
          new Date(schedule.now()),
          { seconds: true },
        )}`;

  const sourceOptions = [
    ...(runs ? [{ value: EVERY_SOURCE, label: "Every source" }] : []),
    ...(names ?? []).map((name) => ({ value: name, label: name })),
  ];

  return (
    <>
      <PageHead
        title="Decisions"
        lede="Every answer and every human decision. Open a record to see why it was decided."
      />
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <Choices
          label="View"
          options={[
            { value: "decisions", label: "Decisions" },
            { value: "runs", label: "Runs" },
          ]}
          value={runs ? "runs" : "decisions"}
          onPick={(view) => {
            onChange({ tab: view === "runs" ? "runs" : undefined });
          }}
        />
        <div className="flex flex-wrap items-center gap-3">
          {runs ? null : (
            <TextFilter
              key={`q:${search.q ?? ""}`}
              search
              label="Record key"
              placeholder="Record key"
              value={search.q}
              onApply={(q) => {
                onChange({ q });
              }}
            />
          )}
          <Listbox
            label="Source"
            options={sourceOptions}
            value={source ?? EVERY_SOURCE}
            onValueChange={(value) => {
              onChange({ source: value === EVERY_SOURCE ? undefined : value });
            }}
            disabled={names === undefined}
          />
          {runs ? null : (
            <>
              <Listbox
                label="Status"
                options={[
                  { value: ANY_STATUS, label: "Any status" },
                  ...STATUS_CHOICES.map((status) => ({
                    value: status,
                    label: STATUS_WORDS[status],
                  })),
                ]}
                value={search.status ?? ANY_STATUS}
                onValueChange={(value) => {
                  onChange({ status: STATUS_CHOICES.find((status) => status === value) });
                }}
              />
              <Choices<TimeChoice | typeof RANGE>
                label="Time"
                options={[
                  ...TIME_CHOICES.map((choice) => ({
                    value: choice,
                    label: TIME_WORDS[choice],
                  })),
                  ...(rangeWords === undefined ? [] : [{ value: RANGE, label: rangeWords }]),
                ]}
                value={rangeWords === undefined ? time : RANGE}
                onPick={(choice) => {
                  if (choice !== RANGE) {
                    // A choice replaces the link's range.
                    onChange({
                      time: choice === "today" ? undefined : choice,
                      from: undefined,
                      to: undefined,
                    });
                  }
                }}
              />
              <Button
                variant="quiet"
                size="small"
                aria-expanded={more}
                onClick={() => {
                  setAsked(!more);
                }}
              >
                More filters
              </Button>
            </>
          )}
        </div>
      </div>
      {runs || !more ? null : (
        <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
          <TextFilter
            key={`question:${search.question ?? ""}`}
            label="Question"
            placeholder="Question name"
            value={search.question}
            onApply={(question) => {
              onChange({ question });
            }}
          />
          <TextFilter
            key={`reviewer:${search.reviewer ?? ""}`}
            label="Decided by"
            placeholder="Reviewer"
            value={search.reviewer}
            onApply={(reviewer) => {
              onChange({ reviewer });
            }}
          />
        </div>
      )}
      <Body
        runs={runs}
        sources={sources.error}
        names={names}
        source={source}
        filters={filters}
        page={search.page ?? 1}
        onChange={onChange}
        narrowed={narrowed(search)}
      />
    </>
  );
}

function Body({
  runs,
  sources,
  names,
  source,
  filters,
  page,
  onChange,
  narrowed: isNarrowed,
}: {
  readonly runs: boolean;
  readonly sources: Error | null;
  readonly names: readonly string[] | undefined;
  readonly source: string | undefined;
  readonly filters: DecisionFilters | undefined;
  readonly page: number;
  readonly onChange: (patch: DecisionsPatch) => void;
  readonly narrowed: boolean;
}) {
  if (sources !== null) {
    return <Problem error={sources} />;
  }
  if (names === undefined) {
    return (
      <p role="status" className="text-text-3">
        Reading the sources
      </p>
    );
  }
  if (names.length === 0) {
    return (
      <EmptyState
        title="No source yet"
        action={
          <Link
            to="/sources/new"
            className={buttonClasses()}
            data-variant="primary"
            data-size="medium"
          >
            Add a source
          </Link>
        }
      >
        The log has nothing to show until a source is answering records.
      </EmptyState>
    );
  }
  if (runs) {
    return (
      <RunsView
        source={source}
        page={page}
        onPage={(next) => {
          onChange({ page: next === 1 ? undefined : next });
        }}
      />
    );
  }
  if (source === undefined || filters === undefined) {
    return null;
  }
  return (
    <LogView
      source={source}
      filters={filters}
      narrowed={isNarrowed}
      onClear={() => {
        onChange({
          q: undefined,
          status: undefined,
          question: undefined,
          reviewer: undefined,
          time: "all",
          from: undefined,
          to: undefined,
        });
      }}
    />
  );
}
