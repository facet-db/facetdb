import { buttonClasses, EmptyState, type StatusKind, StatusWord, Tag } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import type { SourceRow } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { PageHead } from "../../shell/index.ts";
import { Problem, whenWords } from "../decisions/index.ts";
import { projectConfigQuery } from "../questions/index.ts";
import { BackfillControls } from "./BackfillControls.tsx";
import { SOURCES_REFRESH_MS, sourcesQuery } from "./queries.ts";

/**
 * The Sources page: a ruled row per source, its connector as the tag, how a change reaches the
 * worker and when it last saw one, where its answers live, its backfill as a strip with its words,
 * and the worker login's reach in words, all as `GET /v1/sources` says them; the page computes
 * nothing. A table source's backfill line is also where one is estimated, started, stopped and
 * resumed (BackfillControls). A source the config names that the worker does not run yet (added by
 * the setup flow, before the restart) is a row of its own that says so. "Add a source" is the
 * page's one primary action.
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
        <Tag tone={source.kind === "api" ? "facet" : "yes"}>{source.connector}</Tag>
      </div>
      <dl className="m-0 grid grid-cols-[88px_minmax(0,1fr)] gap-x-4 gap-y-2.5">
        <Line label={source.how.label}>{source.how.words}</Line>
        <Line label="Answers">{source.answers}</Line>
        <Line label="Backfill">
          {source.kind === "api" ? (
            // Records arrive one by one through the check API: nothing to go back over.
            <span className="text-text-2">{backfill.words}</span>
          ) : (
            <BackfillControls source={source.name} known={backfill} />
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

/** A source in facetdb.config.ts that the worker does not run yet: what it is, and what to do. */
function NotRunning({ name }: { readonly name: string }) {
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
        <StatusWord status="pending" label="not running yet" size="small" />
      </div>
      <p className="max-w-[64ch] text-text-2">
        {`${name} is in facetdb.config.ts, and the worker that is running does not answer it: stop facetdb worker and start it again. If its install did not run, facetdb migrate --source ${name} prints the SQL and runs it.`}
      </p>
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
      lede="Each table FacetDB watches, how it notices a change, and what its login may touch."
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
          A source is a table FacetDB answers questions about: add one, and the rows fill in.
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
          <NotRunning key={name} name={name} />
        ))}
      </div>
    </>
  );
}
