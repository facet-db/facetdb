import { DecisionTimeline, type TimelineEntry } from "@facetdb/ui";
import { useId } from "react";
import type { SourceVersions } from "../../api/index.ts";
import { Moment } from "../decisions/index.ts";

/**
 * The source's question-set versions as a timeline, newest first: each one's number, when a worker
 * first ran it, and what changed from the one before in words. The store keeps no author for a
 * version, so none is named; a threshold change makes no version, so none is listed for one.
 */
export function Versions({
  source,
  history,
  now,
}: {
  readonly source: string;
  /** Undefined when the worker sent none for this source (it has never run it). */
  readonly history: SourceVersions | undefined;
  readonly now: Date;
}) {
  const id = useId();
  const versions = history?.versions ?? [];
  // What of the history the store could not give, said in the worker's words.
  const note = history?.note ?? null;
  return (
    <section className="grid min-w-0 gap-3" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="m-0 text-[17px] font-bold">
        Versions
      </h2>
      {note === null ? null : <p className="m-0 border-l-2 border-review pl-3">{note}</p>}
      {versions.length === 0 ? (
        note === null ? (
          <p className="m-0 text-text-2">
            No version yet: the worker makes the first one when it first answers with this source.
          </p>
        ) : null
      ) : (
        <DecisionTimeline
          label={`Question-set versions of ${source}`}
          entries={versions.map((entry): TimelineEntry => {
            const inForce = entry.version === history?.inForce;
            return {
              id: `v${String(entry.version)}`,
              kind: "version",
              when: (
                <>
                  {`Version ${String(entry.version)}${inForce ? ", in force" : ""}, first run `}
                  <Moment at={entry.createdAt} now={now} />
                </>
              ),
              what: entry.changes,
              ...(inForce
                ? {
                    detail:
                      "The worker answers with it from now on; records answered under an earlier version keep their answers.",
                  }
                : {}),
            };
          })}
        />
      )}
      {history?.earlier === true ? (
        <p className="m-0 text-[12.5px] text-text-3">
          Older versions are kept in the store and not listed here.
        </p>
      ) : null}
      <p className="m-0 text-[12.5px] text-text-3">
        A version is made when the worker first answers with new wording, fields or model; a
        threshold change makes none.
      </p>
    </section>
  );
}
