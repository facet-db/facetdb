import { Button, DecisionTimeline } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { Link, useLocation } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useApi, useDeps, useSchedule } from "../../deps.tsx";
import { PageHead } from "../../shell/index.ts";
import { Problem, StaleNote, ZoneNote } from "../decisions/index.ts";
import { historyQuery } from "./queries.ts";
import { StandingLines, standings } from "./standings.tsx";
import { timelineEntries } from "./timeline.tsx";

/**
 * "Why was this decided?" for one record: what the log says last about each question
 * (standings.tsx: only what the log proves, never the record's status), then the whole history as a
 * timeline, newest first, with the wording and the model of each entry. The entries are the ones
 * `facetdb explain` prints, from the same function on the worker. "Copy link" puts this address on
 * the clipboard inside the click, and where the browser refuses (a page that is not secure has no
 * clipboard) selects it for the reader.
 */

type CopyState = "idle" | "copied" | "select";

/** The clipboard first, in the click itself; the selected text when it says no. */
function useCopyLink() {
  const { clipboard, origin } = useDeps();
  const href = useLocation({ select: (location) => location.href });
  const url = new URL(href, origin).toString();
  const [state, setState] = useState<CopyState>("idle");
  const copy = () => {
    let copying: Promise<void>;
    try {
      copying = clipboard(url);
    } catch {
      // No clipboard at all on this page: the same road as one that refuses.
      copying = Promise.reject(new Error("the clipboard is not available"));
    }
    void copying.then(
      () => {
        setState("copied");
      },
      () => {
        setState("select");
      },
    );
  };
  return { url, state, copy };
}

function CopyNote({ state, url }: { readonly state: CopyState; readonly url: string }) {
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (state === "select") {
      field.current?.focus();
      field.current?.select();
    }
  }, [state]);
  if (state === "idle") {
    return null;
  }
  if (state === "copied") {
    return (
      <p role="status" className="mb-6 text-text-2">
        Link copied. Anyone with access to this studio can open this page; the same history prints
        with facetdb explain.
      </p>
    );
  }
  return (
    <div role="status" className="mb-6 grid max-w-[64ch] gap-2 text-text-2">
      <label htmlFor="why-link">
        This browser did not allow copying. The link is selected: press Ctrl+C or Cmd+C.
      </label>
      <input
        id="why-link"
        ref={field}
        readOnly
        value={url}
        className="h-9 w-full border border-hairline bg-transparent px-3 text-text outline-offset-2 focus-visible:outline-2 focus-visible:outline-facet-text"
      />
    </div>
  );
}

export function WhyPage({
  source,
  recordKey,
}: {
  readonly source: string;
  /** The key as the log shows it, already decoded from the path. */
  readonly recordKey: string;
}) {
  const api = useApi();
  const schedule = useSchedule();
  const history = useQuery(historyQuery(api, source, recordKey));
  const link = useCopyLink();
  const now = new Date(schedule.now());

  return (
    <>
      <nav aria-label="Breadcrumb" className="mb-3 text-[13px] text-text-2">
        <Link to="/decisions" search={{ source }}>
          Decisions
        </Link>
        {`, ${recordKey}`}
      </nav>
      <PageHead
        title="Why was this decided?"
        lede={`The history of ${recordKey} in ${source}: every answer and decision, with the wording and question set version of each, and the model of each answer.`}
      >
        <Button onClick={link.copy}>Copy link</Button>
      </PageHead>
      <CopyNote state={link.state} url={link.url} />
      {history.isPending ? (
        <p role="status" className="text-text-3">
          Reading the history
        </p>
      ) : history.data === undefined ? (
        <Problem error={history.error} />
      ) : (
        <div className="grid gap-5">
          {/* A failed read after a good one keeps the history, marked as last read. */}
          {history.isError ? (
            <>
              <Problem error={history.error} />
              <StaleNote what="This history was" readAt={history.dataUpdatedAt} now={now} />
            </>
          ) : null}
          <article className="grid gap-3 border-y border-hairline py-4.5">
            <h2 className="text-base font-bold">What the log says last</h2>
            <p className="text-text-2">
              The last entry for each question, read from the log alone. It is not the record's
              status: that is read from the record itself by facetdb explain.
            </p>
            <ul className="grid gap-3">
              {standings(history.data.entries).map((standing) => (
                <li key={standing.question} className="grid gap-1.5">
                  <StandingLines
                    standing={standing}
                    source={source}
                    recordKey={history.data.key}
                    now={now}
                  />
                </li>
              ))}
            </ul>
          </article>
          <section className="grid gap-3">
            <h2 className="text-base font-bold">History, newest first</h2>
            <DecisionTimeline
              label={`Decisions for record ${history.data.key}`}
              entries={timelineEntries(history.data.entries, now)}
            />
            <ZoneNote />
          </section>
        </div>
      )}
    </>
  );
}
