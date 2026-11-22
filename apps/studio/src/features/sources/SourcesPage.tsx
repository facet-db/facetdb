import { buttonClasses, EmptyState, type StatusKind, StatusWord, Tag } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import type { PendingSource, SourceRow } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { PageHead } from "../../shell/index.ts";
import { Problem, whenWords } from "../decisions/index.ts";
import { NotRunning, projectConfigQuery } from "../questions/index.ts";
import { BackfillControls } from "./BackfillControls.tsx";
import { SOURCES_REFRESH_MS, sourcesQuery } from "./queries.ts";
import { aboutRows } from "./rows.ts";

/**
 * The Sources page: a ruled row per source, its connector as the tag, how a change reaches the
 * worker and when it last saw one, where its answers live, its backfill as a strip with its words,
 * and the worker login's reach in words, all as `GET /v1/sources` says them; the page computes
 * nothing. A table or plugin source's backfill line is also where one is estimated, started,
 * stopped and resumed (BackfillControls); an API source's says in words that its records arrive one
 * by one. A source the config names that the worker does not run yet (added to the file and not
 * started) is a row of its own that says why in the reload's own words, with the steps: the
 * Questions page's block, so the two pages never disagree. "Add a source" is the page's one primary
 * action.
 */

/** The install line under the worker login, as a status word and its square. */
const INSTALL_STATUS: Readonly<Record<NonNullable<SourceRow["install"]>["status"], StatusKind>> = {
  ok: "done",
  warn: "warning",
  fail: "error",
  skip: "pending",
};

function Line({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <>
      <dt className="text-[13px] text-text-2">{label}</dt>
      <dd className="m-0 min-w-0">{children}</dd>
    </>
  );
}

function Row({ source }: { readonly source: SourceRow }) {
  const id = useId();
  const { backfill } = source;
  return (
    <article
      aria-labelledby={id}
      className="grid gap-4 border-t border-hairline py-6 first:border-t-0 min-[900px]:grid-cols-[220px_minmax(0,1fr)_auto]"
    >
      <div className="grid content-start justify-items-start gap-2">
        <h2 id={id} className="text-lg font-bold tracking-tight">
          {source.name}
        </h2>
        <Tag tone={source.kind === "table" ? "yes" : "facet"}>{source.connector}</Tag>
      </div>
      <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-2.5">
        <Line label={source.how.label}>{source.how.words}</Line>
        <Line label="Answers">
          {source.answers}
          {source.rows === null ? null : (
            <span className="text-text-2">{` · ${aboutRows(source.rows)}`}</span>
          )}
        </Line>
        <Line label="Backfill">
          {source.kind === "api" ? (
            // Records arrive one by one through the check API: nothing to page through, and the
            // words say so.
            <span className="text-text-2">{backfill.words}</span>
          ) : (
            // A table pages through its rows, a plugin source through its plugin's scan: the same
            // controls over the same endpoints.
            <BackfillControls source={source.name} pages={source.kind} known={backfill} />
          )}
        </Line>
        {source.login === null ? null : (
          <Line label={source.login.label}>{source.login.words}</Line>
        )}
        {source.install === null ? null : (
          <Line label="Install">
            <StatusWord
              status={INSTALL_STATUS[source.install.status]}
              label={source.install.words}
              size="small"
              wrap
            />
          </Line>
        )}
      </dl>
      <div className="flex flex-wrap content-start gap-2">
        <Link
          to="/questions"
          search={{ source: source.name }}
          className={buttonClasses()}
          data-variant="secondary"
          data-size="small"
        >
          Questions
        </Link>
      </div>
    </article>
  );
}

/**
 * A source the file names that the worker does not run: why, in the reload's own words, with the
 * steps and Check again where a reload can start it (the Questions page's block, so the two pages
 * never disagree). The worker's config names every such source in `pending`; a name in the file
 * with no entry there is one the worker runs that this page's list of sources, read on its own
 * clock, does not show yet, so the row says it is starting and nothing more.
 */
function WaitingRow({
  name,
  pending,
}: {
  readonly name: string;
  readonly pending: PendingSource | undefined;
}) {
  const id = useId();
  return (
    <article
      aria-labelledby={id}
      className="grid gap-4 border-t border-hairline py-6 first:border-t-0 min-[900px]:grid-cols-[220px_minmax(0,1fr)]"
    >
      <div className="grid content-start justify-items-start gap-2">
        <h2 id={id} className="text-lg font-bold tracking-tight">
          {name}
        </h2>
        <StatusWord
          status="pending"
          label={pending === undefined ? "starting" : "not running yet"}
          size="small"
        />
      </div>
      {pending === undefined ? (
        <p className="max-w-[64ch] text-text-2">
          {`${name} is in facetdb.config.ts and the worker runs it: the sources are read again every ${String(SOURCES_REFRESH_MS / 1000)} seconds, and its row appears with the next reading.`}
        </p>
      ) : (
        <NotRunning
          source={pending.source}
          outcome={pending.outcome}
          why={pending.message}
          migrate={pending.migrate}
          added={pending.added}
          removed={pending.removed}
          checkAgain={pending.checkAgain}
        />
      )}
    </article>
  );
}

export function SourcesPage() {
  const api = useApi();
  const schedule = useSchedule();
  const sources = useQuery(sourcesQuery(api));
  const config = useQuery(projectConfigQuery(api));
  const now = new Date(schedule.now());
  const head = (
    <PageHead
      title="Sources"
      lede="Each source FacetDB answers questions about, how its records arrive, and what a table's login may touch."
    >
      <Link to="/sources/new" className={buttonClasses()} data-variant="primary" data-size="medium">
        Add a source
      </Link>
    </PageHead>
  );
  if (sources.data === undefined) {
    return (
      <>
        {head}
        {sources.isError ? (
          <Problem error={sources.error} />
        ) : (
          <p role="status" className="text-text-2">
            Reading the sources from the worker
          </p>
        )}
      </>
    );
  }
  const running = new Set(sources.data.map((source) => source.name));
  const waiting = (config.data?.sources ?? [])
    .map((source) => source.name)
    .filter((name) => !running.has(name));
  if (sources.data.length === 0 && waiting.length === 0) {
    return (
      <>
        {head}
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
          A source is the records FacetDB answers questions about, from a table, a plugin or your
          own code: add one, and the answers fill in.
        </EmptyState>
      </>
    );
  }
  return (
    <>
      {head}
      {sources.isError ? (
        // The rows below are the last the worker gave; they say so, with when.
        <div className="mb-4 grid gap-2">
          <Problem error={sources.error} />
          <p className="text-[13px] font-medium text-text-2">
            {`Last known ${whenWords(new Date(sources.dataUpdatedAt), now)}: the worker could not be asked again; the page asks every ${String(SOURCES_REFRESH_MS / 1000)} seconds.`}
          </p>
        </div>
      ) : null}
      <div className="grid">
        {sources.data.map((source) => (
          <Row key={source.name} source={source} />
        ))}
        {waiting.map((name) => (
          <WaitingRow
            key={name}
            name={name}
            pending={config.data?.pending.find((entry) => entry.source === name)}
          />
        ))}
      </div>
    </>
  );
}
