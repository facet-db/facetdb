import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type ApiClient,
  ApiError,
  type BackfillStatus,
  type PendingSource,
  type ProjectConfig,
} from "../../api/index.ts";
import {
  fakeApi,
  renderStudio,
  SAMPLE_BACKFILL_IDLE,
  SAMPLE_MIGRATED,
  SAMPLE_PROJECT_CONFIG,
  sampleBackfill,
} from "../../testing/index.ts";
import { CONFIG_KEY } from "./queries.ts";

/**
 * The offer after an added question is installed asks that question alone: a job of the whole set
 * that the install's reload stopped is never resumed from the offer, a whole-set estimate waiting
 * is never started from it, and a stopped job of the same question resumes. The Sources row of a
 * source past its first version says, before its estimate, that a backfill of the whole set asks
 * every question again for records answered under an earlier version.
 */

const ADMIN = "postgres://owner:Adm1n-MARK@localhost:5432/app";

const LISTINGS_ADDED: PendingSource = {
  source: "listings",
  outcome: "kept",
  message:
    "the question is_vehicle needs its columns, and the worker's checks of Postgres cannot tell whether the worker login may write them, so it keeps answering with version 3 until you run facetdb migrate --source listings and restart facetdb worker.",
  migrate: true,
  checkAgain: false,
  added: ["is_vehicle"],
  removed: [],
};

const NOT_RUNNING_HEADING = /is not running yet\.$/;

const ASKS_EVERY_QUESTION =
  "Records answered under an earlier version of the questions are asked every question again.";

/** How often the controls ask the worker again while a job lives (sources' BACKFILL_REFRESH_MS). */
const REFRESH_MS = 2_000;

const COUNTS = { records: 600, queued: 600, answered: 0, alreadyAnswered: 0, deferred: 0 };

/** The whole set's job, stopped by the install's reload part way through. */
const RELOAD_WHY =
  "listings restarted under version 4 after a reload, so the backfill under version 3 stopped after the page in hand. A backfill under version 4 is a new one: estimate again, and it starts from the newest record.";
const STOPPED_WHOLE_SET = sampleBackfill("stopped", {
  counts: COUNTS,
  endedAt: "2026-11-06T12:00:40.000Z",
  why: RELOAD_WHY,
  words: RELOAD_WHY,
});

const WAITING = (questions: readonly string[] | null): BackfillStatus =>
  sampleBackfill("waiting", {
    questions: questions === null ? null : [...questions],
    token: questions === null ? "token-whole-set" : "token-is-vehicle",
    expiresAt: "2026-11-06T12:10:00.000Z",
  });

/**
 * The worker's job of listings as the test sets it; an estimate becomes a wait for Start at once,
 * and a stop answers "stopping", then the next read finds the job stopped, its page in hand settled.
 */
function worker(initial: BackfillStatus, more: Partial<ApiClient> = {}) {
  const job: { status: BackfillStatus; settling: BackfillStatus | null } = {
    status: initial,
    settling: null,
  };
  const config: { pending: readonly PendingSource[] } = { pending: [LISTINGS_ADDED] };
  const api = fakeApi({
    backfillStatus: () => {
      if (job.settling !== null) {
        job.status = job.settling;
        job.settling = null;
      }
      return Promise.resolve(job.status);
    },
    backfillEstimate: (_source, questions) => {
      job.status = WAITING(questions ?? null);
      return Promise.resolve(job.status);
    },
    backfillStart: (_source, token) => {
      job.status = sampleBackfill("running", {
        questions: token === "token-is-vehicle" ? ["is_vehicle"] : null,
      });
      return Promise.resolve(job.status);
    },
    backfillStop: () => {
      const { questions } = job.status;
      job.status = sampleBackfill("stopping", { questions, counts: null });
      job.settling = { ...STOPPED_WHOLE_SET, questions, counts: null };
      return Promise.resolve(job.status);
    },
    projectConfig: (): Promise<ProjectConfig> =>
      Promise.resolve({ ...SAMPLE_PROJECT_CONFIG, pending: [...config.pending] }),
    migrateRun: () => {
      config.pending = [];
      return Promise.resolve(SAMPLE_MIGRATED);
    },
    ...more,
  });
  return { api, job };
}

/** is_vehicle installed from the Questions page's block: the offer that follows, as a group. */
async function offer(api: ReturnType<typeof worker>["api"]) {
  const studio = renderStudio({ path: "/questions", api });
  await screen.findByRole("article", { name: "is_scam" });
  const block = screen.getByRole("region", { name: NOT_RUNNING_HEADING });
  await studio.user.click(
    await within(block).findByRole("button", { name: "Install from this page" }),
  );
  await studio.user.click(within(block).getByLabelText("Connection string"));
  await studio.user.paste(ADMIN);
  await studio.user.click(within(block).getByRole("button", { name: "Show the SQL" }));
  await studio.user.click(await within(block).findByRole("button", { name: "Install is_vehicle" }));
  expect(await screen.findByText("Installed. listings now answers with is_vehicle.")).toBeVisible();
  await waitFor(() => {
    expect(screen.queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
  });
  const group = screen.getByRole("group", { name: "Backfill of listings" });
  return { studio, group };
}

const button = (group: HTMLElement, name: string) => within(group).getByRole("button", { name });
const estimates = (api: { readonly calls: readonly string[] }) =>
  api.calls.filter((call) => call.startsWith("backfillEstimate"));
const starts = (api: { readonly calls: readonly string[] }) =>
  api.calls.filter((call) => call.startsWith("backfillStart"));

describe("the offer after an added question", () => {
  it("asks for the added question alone when the whole set's job stopped part way, never resuming it", async () => {
    const { api } = worker(STOPPED_WHOLE_SET);
    const { studio, group } = await offer(api);

    // The whole set's stopped job is not the offer's: no Resume, none of its words or progress.
    expect(await within(group).findByText("No backfill yet")).toBeVisible();
    expect(within(group).queryByRole("button", { name: "Resume" })).toBeNull();
    expect(within(group).queryByText(RELOAD_WHY)).toBeNull();
    expect(within(group).queryByRole("img")).toBeNull();
    expect(button(group, "Start")).toBeDisabled();

    await studio.user.click(button(group, "Answer existing records"));

    expect(
      await within(group).findByText(/^Estimated for is_vehicle: 1,200 records/),
    ).toBeVisible();
    expect(estimates(api)).toEqual(["backfillEstimate listings is_vehicle"]);

    await studio.user.click(button(group, "Start"));

    expect(await within(group).findByText("Running")).toBeVisible();
    expect(starts(api)).toEqual(["backfillStart listings token-is-vehicle"]);
  });

  it("never starts a waiting estimate of the whole set: Stop ends it, then the added question is asked alone", async () => {
    const { api } = worker(WAITING(null));
    const { studio, group } = await offer(api);

    expect(await within(group).findByText("Estimated, not started")).toBeVisible();
    expect(
      within(group).getByText(
        "This backfill asks every question. Stop it to ask is_vehicle alone.",
      ),
    ).toBeVisible();
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Answer existing records")).toBeDisabled();

    await studio.user.click(button(group, "Stop"));

    // Stopping: nothing to press, and the line about Stop goes with it.
    expect(await within(group).findByText("Stopping")).toBeVisible();
    expect(within(group).queryByText(/Stop it to ask is_vehicle alone\.$/)).toBeNull();
    expect(button(group, "Stop")).toBeDisabled();
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Answer existing records")).toBeDisabled();

    // The page in hand settles: the whole set's stopped job is not the offer's.
    studio.schedule.advance(REFRESH_MS);
    expect(await within(group).findByText("No backfill yet")).toBeVisible();
    await studio.user.click(button(group, "Answer existing records"));
    expect(
      await within(group).findByText(/^Estimated for is_vehicle: 1,200 records/),
    ).toBeVisible();
    expect(estimates(api)).toEqual(["backfillEstimate listings is_vehicle"]);
    expect(starts(api)).toEqual([]);
  });

  it("beside a running job of other questions, names them and offers Stop alone: no estimate, no start", async () => {
    const { api } = worker(sampleBackfill("running", { questions: ["category"], counts: COUNTS }));
    const { group } = await offer(api);

    expect(await within(group).findByText("Running")).toBeVisible();
    expect(
      within(group).getByText("This backfill asks category. Stop it to ask is_vehicle alone."),
    ).toBeVisible();
    expect(button(group, "Stop")).toBeEnabled();
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Answer existing records")).toBeDisabled();
    expect(estimates(api)).toEqual([]);
    expect(starts(api)).toEqual([]);
  });

  it("resumes a stopped job of the same added question", async () => {
    const { api } = worker({
      ...STOPPED_WHOLE_SET,
      questions: ["is_vehicle"],
      why: "Stopped on request after the page in hand.",
      words: "Stopped on request after the page in hand.",
    });
    const { studio, group } = await offer(api);

    expect(await within(group).findByText("Stopped, 600 of 1,200 records done")).toBeVisible();

    await studio.user.click(button(group, "Resume"));

    expect(
      await within(group).findByText(/^Estimated for is_vehicle: 1,200 records/),
    ).toBeVisible();
    expect(estimates(api)).toEqual(["backfillEstimate listings is_vehicle"]);
  });
});

describe("the Sources row's backfill under a later version", () => {
  /** GET /v1/config with listings at `inForce`. */
  function configAt(inForce: number): ProjectConfig {
    const listings = SAMPLE_PROJECT_CONFIG.versions["listings"];
    if (listings === undefined) {
      throw new Error("SAMPLE_PROJECT_CONFIG names no versions of listings");
    }
    return {
      ...SAMPLE_PROJECT_CONFIG,
      versions: {
        ...SAMPLE_PROJECT_CONFIG.versions,
        listings: {
          ...listings,
          inForce,
          versions: listings.versions.filter((entry) => entry.version <= inForce),
        },
      },
    };
  }

  /** The Sources page and listings' backfill group, the job read from `job.status` on each read. */
  async function sourcesPage(
    projectConfig: ApiClient["projectConfig"],
    job: { status: BackfillStatus } = { status: SAMPLE_BACKFILL_IDLE },
  ) {
    const api = fakeApi({ backfillStatus: () => Promise.resolve(job.status), projectConfig });
    const studio = renderStudio({ path: "/sources", api });
    const row = await screen.findByRole("article", { name: "listings" });
    const group = await within(row).findByRole("group", { name: "Backfill of listings" });
    await within(group).findByRole("button", { name: /^(Answer existing records|Resume)$/ });
    return { api, studio, group };
  }

  /** As `sourcesPage`, once the config is on the page at `inForce`. */
  async function sourcesRow(inForce: number, job?: { status: BackfillStatus }) {
    const page = await sourcesPage(() => Promise.resolve(configAt(inForce)), job);
    // The config is on the page: support_messages, in the file and not run, is its row, drawn in
    // the same render that hands listings' row its version.
    await screen.findByRole("article", { name: "support_messages" });
    return page;
  }

  /** The row's lines of words, in reading order. */
  const lines = (group: HTMLElement) =>
    within(group)
      .getAllByText(/./, { selector: "p" })
      .map((line) => line.textContent);

  it("says, before the estimate, that the whole set is asked again at its second version, and keeps it through the count", async () => {
    const job = { status: SAMPLE_BACKFILL_IDLE };
    const { studio, group } = await sourcesRow(2, job);
    expect(await within(group).findByText(ASKS_EVERY_QUESTION)).toBeVisible();
    expect(lines(group).indexOf(ASKS_EVERY_QUESTION)).toBe(0);

    // The whole set counted: the line stays where it was, so the row does not move.
    await studio.user.click(button(group, "Answer existing records"));
    expect(await within(group).findByText("Counting the records")).toBeVisible();
    expect(lines(group).indexOf(ASKS_EVERY_QUESTION)).toBe(0);

    // The estimate lands, under the line.
    job.status = WAITING(null);
    studio.schedule.advance(REFRESH_MS);
    expect(await within(group).findByText(/^Estimated: 1,200 records/)).toBeVisible();
    expect(lines(group).indexOf(ASKS_EVERY_QUESTION)).toBe(0);
  });

  it("says nothing of it while the config is being read", async () => {
    const { api, group } = await sourcesPage(() => new Promise<ProjectConfig>(() => undefined));
    expect(api.calls).toContain("projectConfig");
    expect(button(group, "Answer existing records")).toBeEnabled();
    expect(within(group).queryByText(ASKS_EVERY_QUESTION)).toBeNull();
  });

  it("says nothing of it when the config could not be read", async () => {
    const { studio, group } = await sourcesPage(() =>
      Promise.reject(
        new ApiError(503, "store_unreadable", "The store did not answer.", "Try again."),
      ),
    );
    await waitFor(() => {
      expect(studio.queryClient.getQueryState(CONFIG_KEY)?.status).toBe("error");
    });
    expect(button(group, "Answer existing records")).toBeEnabled();
    expect(within(group).queryByText(ASKS_EVERY_QUESTION)).toBeNull();
  });

  it("says nothing of it at the first version", async () => {
    const { group } = await sourcesRow(1);
    expect(button(group, "Answer existing records")).toBeEnabled();
    expect(within(group).queryByText(ASKS_EVERY_QUESTION)).toBeNull();
  });

  it("says nothing of it when Resume asks a stopped job's added question alone", async () => {
    const { group } = await sourcesRow(2, {
      status: { ...STOPPED_WHOLE_SET, questions: ["is_vehicle"] },
    });
    expect(button(group, "Resume")).toBeEnabled();
    expect(within(group).queryByText(ASKS_EVERY_QUESTION)).toBeNull();
  });
});
