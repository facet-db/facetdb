import {
  Button,
  DitherStrip,
  EmptyState,
  focusBrackets,
  type StatusKind,
  StatusWord,
} from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { ApiError, type Home, type HomeAlert, homeQuery, projectQuery } from "../../api/index.ts";
import { useApi, useDeps } from "../../deps.tsx";
import { PageHead, SPENDING_STATE } from "../../shell/index.ts";
import { alertTime, followable, ledeOf, splitCheck, unreachableLede } from "./wording.ts";

/**
 * The Home page: four ruled columns, over the recent alerts. Health as three checks in words, the
 * records answered today, the review queue with the page's one action, and spending against the
 * cap, each figure in the measured face with its words and its dither strip. Every figure and
 * sentence is what `GET /v1/home` says; the page works out only two strips the endpoint has no
 * share for, from counts the endpoint gives (the queue's, and answered today when yesterday had
 * none).
 */

/** How often the page asks the worker again while it is visible (the rail's own poll is slower). */
export const HOME_REFRESH_MS = 10_000;

/** A strip as wide as the narrowest column holds at the page's four-column width. */
const STRIP_WIDTH = 144;

const CHECK_STATUS: Readonly<Record<Home["health"]["checks"][number]["status"], StatusKind>> = {
  ok: "done",
  warn: "warning",
  fail: "error",
};

/** One column: a label as the heading, the figure and its words under it. */
function Column({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  const id = useId();
  return (
    <article
      aria-labelledby={id}
      className="grid content-start gap-2.5 bg-canvas p-6 min-[1100px]:first:pl-0"
    >
      <h2 id={id} className="text-[13px] font-medium text-text-2">
        {title}
      </h2>
      {children}
    </article>
  );
}

/** The large figure: the measured face, at 30 px, wrapping when it is words (a failed check). */
function Figure({ children }: { readonly children: ReactNode }) {
  return (
    <p className="font-mono text-[30px] leading-none font-semibold tracking-tight text-balance break-words">
      {children}
    </p>
  );
}

/**
 * The line under a figure. When a strip beside it carries the same sentence as its text
 * equivalent, this copy is hidden from assistive technology so the figure is announced once.
 */
function Sub({
  children,
  spokenByStrip = false,
}: {
  readonly children: ReactNode;
  readonly spokenByStrip?: boolean;
}) {
  return (
    <p
      aria-hidden={spokenByStrip ? true : undefined}
      className="text-[13px] leading-snug text-text-2"
    >
      {children}
    </p>
  );
}

/**
 * Shown on every column while the worker cannot be reached: the figures below are the last the
 * page was given, and it says when, rather than presenting them as current.
 */
function LastKnown({ at }: { readonly at: string | null }) {
  return at === null ? null : (
    <p className="text-[13px] font-medium text-text-2">Last known {at}</p>
  );
}

function HealthColumn({
  health,
  lastKnown,
}: {
  readonly health: Home["health"];
  readonly lastKnown: string | null;
}) {
  if (lastKnown !== null) {
    // The old checks ("Worker beating, 2 s ago") would read as the worker's state now: they are
    // not shown, only what the state was.
    return (
      <Column title="Health">
        <Figure>Not known</Figure>
        <LastKnown at={lastKnown} />
        <Sub>{`It read: ${health.words}.`}</Sub>
      </Column>
    );
  }
  return (
    <Column title="Health">
      <Figure>{health.words}</Figure>
      <ul className="grid gap-2">
        {health.checks.map((check) => {
          const { line, rest } = splitCheck(check.words);
          return (
            <li key={check.name}>
              <StatusWord status={CHECK_STATUS[check.status]} size="small" label={line} wrap />
              {rest === "" ? null : <Sub>{rest}</Sub>}
            </li>
          );
        })}
      </ul>
    </Column>
  );
}

function AnsweredColumn({
  answered,
  lastKnown,
}: {
  readonly answered: Home["answered"];
  readonly lastKnown: string | null;
}) {
  // The endpoint gives no share when nothing was answered yesterday. Today's count is then past
  // all of yesterday's as soon as one record is answered, so the strip is full, or empty at none.
  const share = answered.fraction ?? (answered.today > 0 ? 1 : 0);
  return (
    <Column title="Answered today">
      <Figure>{answered.words.figure}</Figure>
      <LastKnown at={lastKnown} />
      <DitherStrip value={share} width={STRIP_WIDTH} rows={4} label={answered.words.sub} />
      <Sub spokenByStrip>{answered.words.sub}</Sub>
    </Column>
  );
}

/**
 * The page's one action: the link to Review, in the review amber as text, and only when a card
 * waits. The strip is the share of today's review work still waiting: the cards waiting, out of
 * those and the ones a person decided today (both figures are in the words beside it).
 */
function QueueColumn({
  queue,
  lastKnown,
}: {
  readonly queue: Home["queue"];
  readonly lastKnown: string | null;
}) {
  const work = queue.waiting + queue.decidedToday;
  const share = work === 0 ? 0 : queue.waiting / work;
  return (
    <Column title="Waiting for a person">
      <Figure>{queue.words.figure}</Figure>
      <LastKnown at={lastKnown} />
      <DitherStrip value={share} width={STRIP_WIDTH} rows={4} label={queue.words.sub} />
      <Sub spokenByStrip>{queue.words.sub}</Sub>
      {queue.waiting === 0 ? null : (
        <Link
          to="/review"
          className={`${focusBrackets} justify-self-start font-semibold text-facet-text underline decoration-1 underline-offset-4`}
        >
          Review them
        </Link>
      )}
    </Column>
  );
}

/** What spending says besides its sentence when the gate has warned, paused or let it pass. */
function SpendingColumn({
  spending,
  lastKnown,
}: {
  readonly spending: Home["spending"];
  readonly lastKnown: string | null;
}) {
  const state = SPENDING_STATE[spending.status];
  return (
    <Column title="Spending">
      <Figure>{spending.words.figure}</Figure>
      <LastKnown at={lastKnown} />
      {spending.fraction === null ? null : (
        <DitherStrip
          value={spending.fraction}
          width={STRIP_WIDTH}
          rows={4}
          label={spending.words.sub}
        />
      )}
      <Sub spokenByStrip={spending.fraction !== null}>{spending.words.sub}</Sub>
      {state === undefined ? null : (
        <div>
          <StatusWord status={state.status} size="small" label={state.label} wrap />
        </div>
      )}
    </Column>
  );
}

/** An alert as every alert reads: what happened, where, what FacetDB did, one link. */
function AlertRow({ alert }: { readonly alert: HomeAlert }) {
  const { origin } = useDeps();
  const href = followable(alert.link, origin);
  return (
    <li className="grid gap-x-4 gap-y-2 border-t border-hairline py-4 first:border-t-0 first:pt-0 sm:grid-cols-[130px_minmax(0,1fr)_auto]">
      <div>
        <StatusWord
          status={alert.phase === "resolved" ? "resolved" : alert.severity}
          size="small"
          label={alert.badge}
        />
      </div>
      <div className="grid gap-1">
        <strong>{alert.title}</strong>
        <span className="text-text-2">{alert.words}</span>
        {href === null ? null : (
          <a
            href={href}
            className={`${focusBrackets} justify-self-start text-text underline decoration-1 underline-offset-4`}
          >
            See details<span className="sr-only"> of {alert.title}</span>
          </a>
        )}
      </div>
      <time dateTime={alert.at} className="text-[13px] text-text-2">
        {alertTime(alert.at)}
      </time>
    </li>
  );
}

function RecentAlerts({ alerts }: { readonly alerts: Home["alerts"] }) {
  return (
    <section aria-labelledby="recent-alerts" className="mt-10">
      <h2 id="recent-alerts" className="mb-4 text-lg font-bold tracking-tight">
        Recent alerts
      </h2>
      {alerts.length === 0 ? (
        <EmptyState title="No alerts yet" level={3}>
          Nothing has gone wrong and nothing has finished since this project started.
        </EmptyState>
      ) : (
        <ol className="grid">
          {alerts.map((alert, index) => (
            // Two sources can raise the same kind in the same millisecond: the index tells them apart.
            <AlertRow
              key={`${alert.at}-${alert.phase}-${alert.title}-${String(index)}`}
              alert={alert}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * Why the figures are not current: the worker's own words and the fix when it refused, plain words
 * when the studio could not reach it at all, and a way to ask again. Shown whether or not an
 * earlier answer is on the page (a refresh that fails after a success is not a quiet event).
 */
function Unreachable({
  error,
  retry,
  hasFigures,
}: {
  readonly error: Error;
  readonly retry: () => void;
  readonly hasFigures: boolean;
}) {
  return (
    <div role="alert" className="mb-6 grid justify-items-start gap-3 border-y border-hairline py-6">
      <p className="font-bold">
        {hasFigures
          ? "The worker did not answer the last refresh."
          : "The worker did not give today's figures."}
      </p>
      <p className="max-w-[64ch] text-text-2">
        {error instanceof ApiError
          ? `${error.message} ${error.fix}`
          : "The studio cannot reach the worker. Check that the worker is still running and that this computer is online."}
      </p>
      <Button size="small" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

export function HomePage() {
  const api = useApi();
  const home = useQuery({ ...homeQuery(api), refetchInterval: HOME_REFRESH_MS });
  const project = useQuery(projectQuery(api)).data?.project;
  const data = home.data;
  const retry = () => {
    void home.refetch();
  };
  // The query keeps its last good answer when a later refresh fails: the page then says so, and
  // marks every figure as the last known rather than current.
  const lastKnown =
    home.isError && data !== undefined
      ? alertTime(new Date(home.dataUpdatedAt).toISOString())
      : null;
  const lede =
    data === undefined
      ? "Health, records answered today, the review queue, spending against the cap and recent alerts."
      : lastKnown === null
        ? ledeOf(project, data.health)
        : unreachableLede(project);
  return (
    <>
      <PageHead title="Home" lede={lede} />
      {home.isError ? (
        <Unreachable error={home.error} retry={retry} hasFigures={data !== undefined} />
      ) : null}
      {data === undefined ? (
        home.isError ? null : (
          <p role="status" className="text-text-2">
            Asking the worker for today's figures.
          </p>
        )
      ) : (
        <>
          <section
            aria-label="Today"
            className="grid grid-cols-1 gap-px border-y border-hairline bg-hairline min-[640px]:grid-cols-2 min-[1100px]:grid-cols-4"
          >
            <HealthColumn health={data.health} lastKnown={lastKnown} />
            <AnsweredColumn answered={data.answered} lastKnown={lastKnown} />
            <QueueColumn queue={data.queue} lastKnown={lastKnown} />
            <SpendingColumn spending={data.spending} lastKnown={lastKnown} />
          </section>
          <RecentAlerts alerts={data.alerts} />
        </>
      )}
    </>
  );
}
