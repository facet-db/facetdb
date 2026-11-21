import { Button } from "@facetdb/ui";
import { useId, useState } from "react";
import type { SourceVersions } from "../../api/index.ts";
import { Moment } from "../decisions/index.ts";

/**
 * The source's question-set versions, one line until asked: the version in force and since when.
 * "Show versions" lists them newest first, one line each: its number, when a worker first ran it,
 * and what changed from the one before in the server's words. The store keeps no author for a
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
  const [open, setOpen] = useState(false);
  const versions = history?.versions ?? [];
  // What of the history the store could not give, said in the worker's words.
  const note = history?.note ?? null;
  const current = versions.find((entry) => entry.version === history?.inForce);
  return (
    <section className="grid min-w-0 gap-3" aria-labelledby={`${id}-title`}>
      <h2 id={`${id}-title`} className="m-0 text-[17px] font-bold">
        Versions
      </h2>
      {note === null ? null : <p className="m-0 border-l-2 border-review pl-3">{note}</p>}
      {versions.length === 0 ? (
        note === null ? (
          <p className="m-0 text-text-2">No version yet</p>
        ) : null
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="m-0">
            {current === undefined ? (
              // No version in force (the worker does not run the source): the newest, with no
              // "since", which would say it is answering.
              `Version ${String(versions[0]?.version)}`
            ) : (
              <>
                {`Version ${String(current.version)} since `}
                <Moment at={current.createdAt} now={now} />
              </>
            )}
            {versions.length > 1 ? (
              <span className="text-text-2">{` · ${String(versions.length)} versions`}</span>
            ) : null}
          </p>
          <Button
            variant="quiet"
            size="small"
            aria-expanded={open}
            onClick={() => {
              setOpen(!open);
            }}
          >
            Show versions
          </Button>
        </div>
      )}
      {open && versions.length > 0 ? (
        <div className="grid gap-2">
          <ol
            aria-label={`Question-set versions of ${source}`}
            className="m-0 grid list-none gap-1.5 p-0"
          >
            {versions.map((entry) => (
              <li key={entry.version} className="text-text-2">
                <span className="text-text">{`Version ${String(entry.version)}`}</span>
                {" · "}
                <Moment at={entry.createdAt} now={now} />
                {` · ${entry.changes}`}
                {entry.version === history?.inForce ? (
                  <span className="text-text">{" · in force"}</span>
                ) : null}
              </li>
            ))}
          </ol>
          {history?.earlier === true ? (
            <p className="m-0 text-[12.5px] text-text-3">
              Older versions are kept in the store and not listed here.
            </p>
          ) : null}
          <p className="m-0 text-[12.5px] text-text-3">
            A new version is made when a question's wording, fields or model change. Thresholds make
            none.
          </p>
        </div>
      ) : null}
    </section>
  );
}
