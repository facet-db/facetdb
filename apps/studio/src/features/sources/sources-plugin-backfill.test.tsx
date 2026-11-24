import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { BackfillStatus, SourceRow } from "../../api/index.ts";
import {
  fakeApi,
  renderStudio,
  SAMPLE_BACKFILL_IDLE,
  SAMPLE_SOURCES,
  sampleBackfill,
} from "../../testing/index.ts";
import { BACKFILL_REFRESH_MS } from "./queries.ts";

/**
 * A plugin source's backfill from the Sources page: its row shows the controls a table source's
 * shows, over the same backfill endpoints; the estimate says it was counted by paging the plugin
 * and that the run pages it again; the progress is the strip with its words; a backfill part way
 * resumes with a new estimate, and every step is reached by the keyboard. An API source's row keeps
 * its words alone. Time moves only by the fake scheduler's hand.
 */

/** The GitHub plugin's issues, as GET /v1/sources says a plugin source. */
function issuesRow(backfill: SourceRow["backfill"]): SourceRow {
  return {
    name: "issues",
    kind: "plugin",
    connector: "Plugin @facetdb/github, issues",
    install: null,
    how: {
      label: "Arrives",
      words:
        "The plugin @facetdb/github reports each changed record of its issues, and the worker reads it into the FacetDB store and queues it. Last change seen 30 seconds ago.",
    },
    lastChangeAt: "2026-11-06T11:59:30.000Z",
    answers: "Kept in the FacetDB store. 3 questions, version 1. Unsure records land in Review.",
    rows: null,
    backfill,
    login: null,
  };
}

const NO_RUN: SourceRow["backfill"] = {
  state: "none",
  fraction: null,
  words: "None: no backfill has run on this source.",
};

const PART_WAY: SourceRow["backfill"] = {
  state: "part-way",
  fraction: null,
  words:
    "Part way through the whole question set, in the plugin's order: 600 records answered under version 1 so far. The next run resumes where this one stopped.",
};

/** What the page adds to a plugin source's estimate, after its figures. */
const PAGED_TWICE =
  "Counted by paging through the plugin. Start pages through it again, so the plugin's API is called twice for every page: once for this count, once for the run.";

const ISSUES = { source: "issues", version: 1 } as const;

const ESTIMATING = sampleBackfill("estimating", {
  ...ISSUES,
  surveyed: 0,
  estimate: null,
  words:
    "Counting the records of issues to price the backfill: 0 read so far, in the plugin's order. Nothing is asked until it is started.",
});

/** The estimate from a saved place: the records after the last finished page. */
function waiting(records: number): BackfillStatus {
  return sampleBackfill("waiting", {
    ...ISSUES,
    estimate: {
      records,
      sampled: 100,
      tokensPerRecord: 85,
      tokens: records * 85,
      dollars: records * 0.0000036,
      calibration: { records: 100, scale: 2.7 },
    },
    token: "token-1",
    expiresAt: "2026-11-06T12:10:00.000Z",
    words: `Estimated: ${records.toLocaleString("en-US")} records. Nothing is asked until it is started; an estimate not started within 10 minutes is dropped.`,
  });
}

function running(done: number, of: number): BackfillStatus {
  return {
    ...waiting(of),
    state: "running",
    token: null,
    expiresAt: null,
    counts: { records: done, queued: done, answered: 0, alreadyAnswered: 0, deferred: 0 },
    words: `Running under version 1, in the plugin's order, at most 50 records a second: ${done.toLocaleString("en-US")} of ${of.toLocaleString("en-US")} records done.`,
  };
}

const STOPPED_WHY =
  "Stopped on request after the page in hand; the pages done stay done, and the next backfill resumes after the last one.";

/**
 * The worker's job of issues as a test scripts it, beside the sample's listings (idle) and
 * support_tickets (an API source): every read answers the state set last, an estimate begins the
 * count, a start with the token shown runs it, a stop ends it after the page in hand.
 */
function worker(known: SourceRow["backfill"], initial: BackfillStatus) {
  const job = { status: initial };
  const api = fakeApi({
    sources: () => Promise.resolve([...SAMPLE_SOURCES, issuesRow(known)]),
    backfillStatus: (source) =>
      Promise.resolve(source === "issues" ? job.status : { ...SAMPLE_BACKFILL_IDLE, source }),
    backfillEstimate: () => {
      job.status = ESTIMATING;
      return Promise.resolve(job.status);
    },
    backfillStart: () => {
      job.status = running(0, job.status.estimate?.records ?? 0);
      return Promise.resolve(job.status);
    },
    backfillStop: () => {
      job.status = { ...job.status, state: "stopping", words: "Stopping after the page in hand." };
      return Promise.resolve(job.status);
    },
  });
  return { api, job };
}

async function sourcesPage(api: ReturnType<typeof worker>["api"]) {
  const studio = renderStudio({ path: "/sources", api });
  const row = await screen.findByRole("article", { name: "issues" });
  const group = await within(row).findByRole("group", { name: "Backfill of issues" });
  return { studio, row, group };
}

const button = (group: HTMLElement, name: string) => within(group).getByRole("button", { name });

/** The scheduler's next tick: the controls ask the worker again while a job lives. */
async function refreshed(studio: ReturnType<typeof renderStudio>, text: RegExp | string) {
  studio.schedule.advance(BACKFILL_REFRESH_MS);
  return screen.findByText(text);
}

/** Tab, as a person does, until `target` has the focus: the keyboard alone reaches it. */
async function tabTo(studio: ReturnType<typeof renderStudio>, target: HTMLElement) {
  for (let presses = 0; presses < 80 && document.activeElement !== target; presses += 1) {
    await studio.user.tab();
  }
  expect(target).toHaveFocus();
}

describe("a plugin source's backfill from the Sources page (sources-plugin-backfill)", () => {
  it("shows a table source's controls on a plugin source's row and starts its backfill through the same endpoints", async () => {
    const { api, job } = worker(NO_RUN, { ...SAMPLE_BACKFILL_IDLE, source: "issues" });
    const { studio, row, group } = await sourcesPage(api);

    expect(within(row).getByText("Plugin @facetdb/github, issues")).toBeVisible();
    expect(await within(group).findByText("No backfill yet")).toBeVisible();
    expect(within(group).getByText("None: no backfill has run on this source.")).toBeVisible();
    expect(button(group, "Answer existing records")).toBeEnabled();
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Stop")).toBeDisabled();
    expect(api.calls).toContain("backfillStatus issues");

    await studio.user.click(button(group, "Answer existing records"));

    // The count pages the plugin and asks nothing of the model: Start waits for its estimate.
    expect(await within(group).findByText("Counting the records")).toBeVisible();
    expect(api.calls).toContain("backfillEstimate issues");
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Stop")).toBeEnabled();

    // The estimate's figures, then how they were counted and what the run costs the plugin.
    job.status = waiting(1_200);
    expect(
      await refreshed(
        studio,
        `Estimated: 1,200 records, about $0.004 (102k input tokens), at 50 records a second: about 24 seconds. ${PAGED_TWICE}`,
      ),
    ).toBeVisible();
    expect(within(group).getByText("Estimated, not started")).toBeVisible();
    expect(button(group, "Start")).toBeEnabled();
    expect(api.calls.filter((call) => call.startsWith("backfillStart"))).toEqual([]);

    await studio.user.click(button(group, "Start"));

    expect(await within(group).findByText("Running")).toBeVisible();
    expect(api.calls).toContain("backfillStart issues token-1");
    // The pace, in the worker's words, and the progress on the strip.
    expect(
      within(group).getByText(/at most 50 records a second: 0 of 1,200 records done\.$/),
    ).toBeVisible();
    expect(within(group).getByRole("img", { name: "Backfill 0% done" })).toBeInTheDocument();

    job.status = running(600, 1_200);
    await refreshed(studio, /600 of 1,200 records done\.$/);
    expect(within(group).getByRole("img", { name: "Backfill 50% done" })).toBeInTheDocument();
  });

  it("says an estimate of nothing to answer asks the model nothing, and still pages the plugin again", async () => {
    // Core's backfill runs at zero records all the same: a source whose records are all left out
    // can still be many pages, each called again by the run.
    const { api } = worker(NO_RUN, waiting(0));
    const { group } = await sourcesPage(api);

    expect(
      await within(group).findByText(
        `Estimated: no records to answer from here, so starting it asks the model nothing. ${PAGED_TWICE}`,
      ),
    ).toBeVisible();
    expect(button(group, "Start")).toBeEnabled();
  });

  it("keeps an API source's row to its words: records arrive one by one, nothing to page through", async () => {
    const { api } = worker(NO_RUN, { ...SAMPLE_BACKFILL_IDLE, source: "issues" });
    await sourcesPage(api);
    const tickets = screen.getByRole("article", { name: "support_tickets" });

    expect(within(tickets).getByText("None: records arrive one by one.")).toBeVisible();
    expect(within(tickets).queryByRole("group")).toBeNull();
    expect(within(tickets).queryByRole("button")).toBeNull();
    expect(
      within(tickets)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Questions"]);
    expect(api.calls.filter((call) => call.startsWith("backfillStatus")).sort()).toEqual([
      "backfillStatus issues",
      "backfillStatus listings",
    ]);
  });

  it("resumes a plugin backfill part way with a new estimate and shows its progress, by the keyboard alone in the light theme", async () => {
    // The worker restarted since the run stopped: no job, and the cursor says part way.
    const { api, job } = worker(PART_WAY, { ...SAMPLE_BACKFILL_IDLE, source: "issues" });
    const { studio, group } = await sourcesPage(api);
    // The other theme, switched by the keyboard as well: the controls are the tokens' in both.
    await tabTo(studio, screen.getByRole("button", { name: "Switch to the light theme" }));
    await studio.user.keyboard("{Enter}");
    expect(document.documentElement).toHaveAttribute("data-theme", "light");

    expect(await within(group).findByText("Part way, not running")).toBeVisible();
    expect(within(group).getByText(/^Part way through the whole question set/)).toBeVisible();

    await tabTo(studio, button(group, "Resume"));
    await studio.user.keyboard("{Enter}");

    expect(await within(group).findByText("Counting the records")).toBeVisible();
    expect(api.calls.filter((call) => call.startsWith("backfillEstimate"))).toEqual([
      "backfillEstimate issues",
    ]);

    // Counted from the saved place: the records after the last finished page.
    job.status = waiting(600);
    expect(
      await refreshed(
        studio,
        `Estimated: 600 records, about $0.002 (51k input tokens), at 50 records a second: about 12 seconds. ${PAGED_TWICE}`,
      ),
    ).toBeVisible();

    await tabTo(studio, button(group, "Start"));
    await studio.user.keyboard("{Enter}");

    expect(await within(group).findByText("Running")).toBeVisible();
    expect(api.calls).toContain("backfillStart issues token-1");

    job.status = running(150, 600);
    await refreshed(studio, /150 of 600 records done\.$/);
    expect(within(group).getByRole("img", { name: "Backfill 25% done" })).toBeInTheDocument();
    job.status = running(450, 600);
    await refreshed(studio, /450 of 600 records done\.$/);
    expect(within(group).getByRole("img", { name: "Backfill 75% done" })).toBeInTheDocument();

    // Stopped by the keyboard too, and offered again as a resume where it got to.
    await tabTo(studio, button(group, "Stop"));
    await studio.user.keyboard("{Enter}");
    expect(await within(group).findByText("Stopping")).toBeVisible();
    expect(api.calls).toContain("backfillStop issues");

    job.status = {
      ...running(450, 600),
      state: "stopped",
      endedAt: "2026-11-06T12:00:40.000Z",
      why: STOPPED_WHY,
      words: STOPPED_WHY,
    };
    await refreshed(studio, STOPPED_WHY);
    expect(within(group).getByText("Stopped, 450 of 600 records done")).toBeVisible();
    expect(within(group).getByRole("img", { name: "Backfill 75% done" })).toBeInTheDocument();
    expect(button(group, "Resume")).toBeEnabled();
  });
});
