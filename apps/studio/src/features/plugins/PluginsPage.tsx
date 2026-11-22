import { Button, EmptyState } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { useId, useRef } from "react";
import { useApi } from "../../deps.tsx";
import { PageHead } from "../../shell/index.ts";
import { Gallery } from "./Gallery.tsx";
import { InstalledList } from "./InstalledList.tsx";
import { installedPluginsQuery } from "./queries.ts";
import { WorkerProblem } from "./WorkerProblem.tsx";

/**
 * The Plugins page: the plugins the worker hosts, each on one line with its settings behind it, and
 * the registry's gallery under them. Its states are the mockup's: installed, nothing installed (one
 * empty state over the gallery), loading, the registry unreachable (the gallery says so; the
 * installed list stands), and the worker not answering (the page says so, and shows no gallery,
 * which the worker serves too).
 */

/** Both parts being read: each says so under its own heading. */
function Reading() {
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-2">
      <h2 id={id} className="text-lg font-bold tracking-tight">
        Installed
      </h2>
      <p role="status" className="m-0 text-text-2">
        Reading the installed plugins.
      </p>
    </section>
  );
}

export function PluginsPage() {
  const api = useApi();
  const installed = useQuery(installedPluginsQuery(api));
  const search = useRef<HTMLInputElement>(null);
  const galleryHeading = useRef<HTMLHeadingElement>(null);
  const data = installed.data;
  const unreadable = installed.isError && data === undefined;
  return (
    <>
      <PageHead
        title="Plugins"
        lede="Sources, actions, alert channels and question packs added to this project."
      />
      {installed.isError ? (
        <WorkerProblem
          what="The installed plugins"
          error={installed.error}
          stale={data !== undefined}
          retry={() => {
            void installed.refetch();
          }}
        />
      ) : null}
      {data === undefined ? (
        unreadable ? null : (
          <Reading />
        )
      ) : data.plugins.length === 0 ? (
        <EmptyState
          title="No plugin installed"
          action={
            <Button
              onClick={() => {
                (search.current ?? galleryHeading.current)?.focus();
              }}
            >
              Search the gallery
            </Button>
          }
        >
          Add sources, actions, alert channels and question packs from the gallery below.
        </EmptyState>
      ) : (
        <InstalledList installed={data} />
      )}
      {unreadable ? null : (
        <Gallery facetdb={data?.facetdb ?? ""} searchRef={search} headingRef={galleryHeading} />
      )}
    </>
  );
}
