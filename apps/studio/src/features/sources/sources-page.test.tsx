import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { PendingSource, ProjectConfig } from "../../api/index.ts";
import { fakeApi, renderStudio, SAMPLE_PROJECT_CONFIG } from "../../testing/index.ts";
import { aboutRows } from "./rows.ts";

/**
 * The Sources page's row for a source the file names and the worker does not run (a real run, where
 * the row hid why): it says why in the reload's own words with the steps, the Questions page's
 * block, and keeps the one fixed sentence only while the worker's list has no entry for the source.
 */

const [LISTINGS] = SAMPLE_PROJECT_CONFIG.sources;
if (LISTINGS === undefined) {
  throw new Error("the sample config has a source");
}
/** The file's new source: listings' shape under another name. */
const AGENTS = { ...LISTINGS, name: "agents" };

const AGENTS_NOT_STARTED: PendingSource = {
  source: "agents",
  outcome: "not-started",
  message:
    "the worker's checks of 127.0.0.1:5432/facetdb_demo cannot tell whether the worker login may write them, so it is not started: restart facetdb worker",
  migrate: true,
  added: [],
  removed: [],
  checkAgain: false,
};

/** The file with agents added, which the worker's sources (the fake's listings and support_messages) do not run. */
function configWith(pending: readonly PendingSource[]): ProjectConfig {
  return {
    ...SAMPLE_PROJECT_CONFIG,
    sources: [...SAMPLE_PROJECT_CONFIG.sources, AGENTS],
    pending: [...pending],
  };
}

describe("a source the file names that the worker does not run", () => {
  it("says why in the reload's own words, with the steps", async () => {
    const api = fakeApi({
      projectConfig: () => Promise.resolve(configWith([AGENTS_NOT_STARTED])),
    });
    renderStudio({ path: "/sources", api });

    const row = await screen.findByRole("article", { name: "agents" });
    expect(within(row).getByText("not running yet")).toBeVisible();
    const block = within(row).getByRole("region", {
      name: "agents is not running yet.",
    });
    expect(
      within(block).getByText(
        /^The worker's checks of 127\.0\.0\.1:5432\/facetdb_demo cannot tell whether the worker login may write them/,
      ),
    ).toBeVisible();
    expect(within(block).getByText("facetdb migrate --source agents")).toBeVisible();
    expect(within(block).getByText(/^Restart the worker/)).toBeVisible();
    expect(within(block).queryByRole("button", { name: "Check again" })).toBeNull();
    expect(within(row).queryByText(/does not answer it/)).toBeNull();
  });

  it("offers Check again inside the row where a reload can start the source", async () => {
    const api = fakeApi({
      projectConfig: () =>
        Promise.resolve(
          configWith([
            {
              ...AGENTS_NOT_STARTED,
              message:
                "new in facetdb.config.ts and not answered yet: its install is not in its database (the columns of is_scam are missing)",
              checkAgain: true,
            },
          ]),
        ),
    });
    renderStudio({ path: "/sources", api });

    const row = await screen.findByRole("article", { name: "agents" });
    const block = within(row).getByRole("region", {
      name: "agents is not running yet.",
    });
    expect(within(block).getByText(/^Press Check again on this page/)).toBeVisible();
    expect(within(block).getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("says a source the worker runs is starting while the list of sources lags the file", async () => {
    const api = fakeApi({ projectConfig: () => Promise.resolve(configWith([])) });
    renderStudio({ path: "/sources", api });

    const row = await screen.findByRole("article", { name: "agents" });
    expect(within(row).getByText("starting")).toBeVisible();
    expect(
      within(row).getByText(/^agents is in facetdb\.config\.ts and the worker runs it/),
    ).toBeVisible();
    expect(within(row).queryByRole("region")).toBeNull();
    expect(within(row).queryByText(/restart|stop facetdb worker/)).toBeNull();
  });
});

describe("a source's size", () => {
  it("is the database's estimate beside its answers, rounded, and nothing where there is none", async () => {
    renderStudio({ path: "/sources" });

    // The fake's listings: 41,237 rows by the database's statistics.
    const listings = await screen.findByRole("article", { name: "listings" });
    expect(within(listings).getByText(/^Inline columns on public\.listings/)).toHaveTextContent(
      "Inline columns on public.listings. 2 questions, version 3. · about 41,000 rows",
    );
    const api = await screen.findByRole("article", { name: "support_tickets" });
    expect(within(api).queryByText(/rows/)).toBeNull();
  });

  it("is said in plain words at every size", () => {
    expect(aboutRows(4_137)).toBe("about 4,100 rows");
    expect(aboutRows(41_237)).toBe("about 41,000 rows");
    expect(aboutRows(1_250_000)).toBe("about 1,300,000 rows");
    expect(aboutRows(47)).toBe("about 47 rows");
    expect(aboutRows(1)).toBe("about 1 row");
    expect(aboutRows(0)).toBe("no rows");
  });
});
