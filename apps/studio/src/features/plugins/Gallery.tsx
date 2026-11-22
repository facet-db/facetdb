import { Button, focusBrackets, StatusWord, Tag } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { type Ref, useId, useRef, useState } from "react";
import type { GalleryEntry } from "../../api/index.ts";
import { useApi, useDeps } from "../../deps.tsx";
import { BOX, Bracketed } from "./box.tsx";
import { galleryQuery } from "./queries.ts";
import { WorkerProblem } from "./WorkerProblem.tsx";
import { addCommand, countWords, kindsWords, notMadeForWords, registryFailure } from "./words.ts";

/**
 * The gallery: the registry's entries as a full grid of ruled cells, never filled cards, under a
 * search the worker answers (every word, anywhere in an entry). Each cell: the name, "Verified" on
 * a verified entry alone, what it provides, the registry's description (text from outside, shown as
 * text), its npm downloads last month, and "Installed", or a range that does not hold, or the
 * `facetdb add` command with Copy. Nothing installs from the page. A registry that cannot be read
 * says so with the address tried and the terminal's way.
 */

const SEARCH_MAX = 100;

type CopyState = "idle" | "copied" | "select";

/**
 * The command in a ruled box, Copy against it (the mockup's `.cmd`). Copy says it copied in its own
 * words and to a screen reader; where the browser refuses the clipboard the command is selected.
 */
function CopyCommand({ command }: { readonly command: string }) {
  const { clipboard } = useDeps();
  const field = useRef<HTMLElement>(null);
  const [state, setState] = useState<CopyState>("idle");
  const copy = () => {
    let copying: Promise<void>;
    try {
      copying = clipboard(command);
    } catch {
      copying = Promise.reject(new Error("the clipboard is not available"));
    }
    void copying.then(
      () => {
        setState("copied");
      },
      () => {
        setState("select");
        if (field.current !== null) {
          window.getSelection()?.selectAllChildren(field.current);
        }
      },
    );
  };
  return (
    <div className="grid gap-1.5">
      <div className="flex min-w-0 items-stretch">
        <code
          ref={field}
          className="flex min-w-0 items-center border border-r-0 border-hairline px-2.5 wrap-anywhere"
        >
          {command}
        </code>
        <Button
          size="small"
          aria-label={`${state === "copied" ? "Copied" : "Copy"} ${command}`}
          onClick={copy}
        >
          {state === "copied" ? "Copied" : "Copy"}
        </Button>
      </div>
      <p role="status" className={state === "select" ? "m-0 text-[12.5px] text-text-2" : "sr-only"}>
        {state === "copied"
          ? `Copied ${command}`
          : state === "select"
            ? "This browser did not allow copying. The command is selected: press Ctrl+C or Cmd+C."
            : ""}
      </p>
    </div>
  );
}

function Cell({ entry, facetdb }: { readonly entry: GalleryEntry; readonly facetdb: string }) {
  const id = useId();
  // Built from the name alone, never the answer's own command line: what is copied runs in a shell.
  const command = addCommand(entry.name);
  return (
    <article
      aria-labelledby={id}
      className="grid min-w-0 content-start gap-2 border-r border-b border-hairline px-5 pt-4.5 pb-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 id={id} className="text-[16px] font-bold wrap-anywhere">
          {entry.name}
        </h3>
        {entry.verified ? <Tag>Verified</Tag> : null}
      </div>
      <span className="text-[12.5px] text-text-2">{kindsWords(entry.kinds)}</span>
      <p className="m-0 wrap-anywhere">{entry.description}</p>
      <span className="text-[12.5px] text-text-2">
        <span className="font-mono">{countWords(entry.downloads)}</span> downloads last month
      </span>
      <div className="mt-1.5">
        {entry.installed ? (
          <StatusWord status="done" label="Installed" size="small" />
        ) : !entry.holds ? (
          <StatusWord status="error" label={notMadeForWords(facetdb)} size="small" />
        ) : command === null ? null : (
          <CopyCommand command={command} />
        )}
      </div>
    </article>
  );
}

/** The registry's failure with the address tried, its why, and the terminal's way to list it. */
function RegistryProblem({
  address,
  why,
  retry,
}: {
  readonly address: string;
  readonly why: string;
  readonly retry: () => void;
}) {
  // The mockup's words where nothing answered; otherwise the worker's reason, the address in place
  // of "the registry" so that it is not said twice. A file's address is words, not code.
  const failure = registryFailure(why);
  const where = URL.canParse(address) ? <code>{address}</code> : address;
  const said =
    address === "" ? (
      `${why.slice(0, 1).toUpperCase()}${why.slice(1).replace(/\.$/, "")}.`
    ) : failure.kind === "no-answer" ? (
      <>
        No answer from {where}
        {failure.seconds === null ? "" : ` within ${failure.seconds} seconds`}.
      </>
    ) : (
      <>
        Tried {where}: {failure.words}.
      </>
    );
  return (
    <div role="alert" className="grid justify-items-start gap-2 border-l-2 border-no pl-3">
      <p className="m-0 font-bold">The registry could not be reached.</p>
      <p className="m-0 max-w-[68ch] text-text-2">
        {said} From a terminal, <code>facetdb add</code> lists the registry.
      </p>
      <Button size="small" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

export function Gallery({
  facetdb,
  searchRef,
  headingRef,
}: {
  /** The FacetDB the worker runs, for an entry whose range does not hold; empty when unknown. */
  readonly facetdb: string;
  /** The search box, which "Search the gallery" of the empty state focuses. */
  readonly searchRef: Ref<HTMLInputElement>;
  /** The heading, focused instead while there is no search box. */
  readonly headingRef: Ref<HTMLHeadingElement>;
}) {
  const api = useApi();
  const headingId = useId();
  const searchId = useId();
  const [search, setSearch] = useState("");
  const gallery = useQuery(galleryQuery(api, search));
  const data = gallery.data;
  const retry = () => {
    void gallery.refetch();
  };
  return (
    <section aria-labelledby={headingId} className="mt-10">
      <h2
        ref={headingRef}
        id={headingId}
        tabIndex={-1}
        className={`${focusBrackets} w-fit text-lg font-bold tracking-tight`}
      >
        Gallery
      </h2>
      {data === undefined ? (
        gallery.isError ? (
          <div className="mt-2">
            <WorkerProblem what="The gallery" error={gallery.error} stale={false} retry={retry} />
          </div>
        ) : (
          <p role="status" className="mt-2 text-text-2">
            Reading the registry.
          </p>
        )
      ) : (
        <>
          <div className="mt-1.5 mb-4.5 grid max-w-[68ch] gap-1 text-text-2">
            <p className="m-0">
              To install one, run its command in the project's folder, then add the lines it prints
              to facetdb.config.ts.
            </p>
            <p className="m-0">
              A plugin runs inside your worker with its access. Verified ones were reviewed by the
              FacetDB team.
            </p>
          </div>
          {data.reachable ? (
            <div className="grid gap-4">
              <div className="grid max-w-[420px] gap-1.5">
                <label htmlFor={searchId} className="text-[13px] text-text-2">
                  Search
                </label>
                <Bracketed full>
                  <input
                    ref={searchRef}
                    id={searchId}
                    type="search"
                    className={BOX}
                    autoComplete="off"
                    maxLength={SEARCH_MAX}
                    value={search}
                    onChange={(event) => {
                      setSearch(event.target.value);
                    }}
                  />
                </Bracketed>
              </div>
              {data.plugins.length === 0 ? (
                <p role="status" className="m-0 text-text-2">
                  {search.trim() === ""
                    ? "The registry lists no plugin yet."
                    : `No plugin matches "${search.trim()}".`}
                </p>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] border-t border-l border-hairline">
                  {data.plugins.map((entry) => (
                    <Cell key={entry.name} entry={entry} facetdb={facetdb} />
                  ))}
                </div>
              )}
            </div>
          ) : (
            <RegistryProblem address={data.address} why={data.why} retry={retry} />
          )}
        </>
      )}
    </section>
  );
}
