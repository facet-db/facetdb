import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  type ApiClient,
  ApiError,
  type BackfillStatus,
  type Home,
  type PendingSource,
  type ProjectConfig,
} from "../../api/index.ts";
import {
  fakeApi,
  renderStudio,
  SAMPLE_BACKFILL_IDLE,
  SAMPLE_HOME,
  SAMPLE_MIGRATED,
  SAMPLE_PROJECT_CONFIG,
  sampleBackfill,
} from "../../testing/index.ts";
import { BACKFILL_REFRESH_MS } from "./queries.ts";

/**
 * A source's backfill from the page on happy-dom with the fake API client and the fake scheduler:
 * the row's known backfill while no job lives; Start disabled until the estimate is on the page,
 * then the token it gave sent; the progress as a strip with its words and Stop; Resume after a
 * stop, asking for a new estimate; the cap's pause and a failure, each with why and what to do; a
 * refresh that fails leaving what is shown as the last known; a start refused in the worker's
 * words; the offer after an installed question; and every control reached by the keyboard and named
 * for a screen reader. Time moves only by the scheduler's hand.
 */

const COUNTS = (records: number): NonNullable<BackfillStatus["counts"]> => ({
  records,
  queued: records,
  answered: 0,
  alreadyAnswered: 0,
  deferred: 0,
});

const ESTIMATING = sampleBackfill("estimating", {
  surveyed: 0,
  estimate: null,
  words:
    "Counting the records of listings to price the backfill: 0 read so far, newest first. Nothing is asked until it is started.",
});

const WAITING = sampleBackfill("waiting", {
  token: "token-1",
  expiresAt: "2026-11-06T12:10:00.000Z",
  words:
    "Estimated: 1,200 records, about 102k input tokens, less than $0.01. Nothing is asked until it is started; an estimate not started within 10 minutes is dropped.",
});

function running(records: number): BackfillStatus {
  return sampleBackfill("running", {
    counts: COUNTS(records),
    words: `Running under version 3, newest first, at most 50 records a second: ${records.toLocaleString("en-US")} of 1,200 records done.`,
  });
}

const STOPPING = sampleBackfill("stopping", {
  counts: COUNTS(600),
  words: "Stopping after the page in hand: that page is settled and its place saved first.",
});

const STOPPED_WHY =
  "Stopped on request after the page in hand; the pages done stay done, and the next backfill resumes after the last one.";
const STOPPED = sampleBackfill("stopped", {
  counts: COUNTS(600),
  endedAt: "2026-11-06T12:00:40.000Z",
  why: STOPPED_WHY,
  words: STOPPED_WHY,
});

const EXPIRED_WHY =
  "The estimate was not started within 10 minutes, so it was dropped; nothing was asked.";
const EXPIRED = sampleBackfill("stopped", {
  endedAt: "2026-11-06T12:10:00.000Z",
  why: EXPIRED_WHY,
  words: EXPIRED_WHY,
});

const PAUSED_WHY =
  "The project's spending cap was reached, so the backfill paused before its next request; the page it was on is not saved, and nothing is lost. Raise spendingCap in facetdb.config.ts (Settings can change it) and restart facetdb worker, or wait for next month, then estimate again: it resumes after the last finished page.";
const PAUSED = sampleBackfill("paused", {
  counts: COUNTS(300),
  endedAt: "2026-11-06T12:00:20.000Z",
  why: PAUSED_WHY,
  words: PAUSED_WHY,
});

const FAILED_WHY =
  "1 record failed on a page (the first: the model did not answer in time), so the backfill stopped there; the earlier pages are saved. Run facetdb doctor to check the model key and the connection, then estimate again: it resumes at that page and skips what was answered.";
const FAILED = sampleBackfill("failed", {
  counts: COUNTS(900),
  endedAt: "2026-11-06T12:00:30.000Z",
  why: FAILED_WHY,
  words: FAILED_WHY,
});

const RESUME_LINE =
  "Resume asks for a new estimate from the last finished page and shows it before anything is asked.";

/**
 * The worker's job of listings as a test scripts it: every read answers the state set last, an
 * estimate begins the count, a start with the token shown runs it, a stop ends it after the page
 * in hand. `failing` makes every read refuse, as a worker that does not answer; `slow` holds every
 * read until `answer` lets them through, as a worker that takes its time.
 */
function worker(initial: BackfillStatus = SAMPLE_BACKFILL_IDLE, more: Partial<ApiClient> = {}) {
  const held: ((status: BackfillStatus) => void)[] = [];
  const job: {
    status: BackfillStatus;
    failing: Error | null;
    slow: boolean;
    /** Answers every read held while slow, with the state set last. */
    answer: () => void;
  } = {
    status: initial,
    failing: null,
    slow: false,
    answer: () => {
      for (const resolve of held.splice(0)) {
        resolve(job.status);
      }
    },
  };
  const api = fakeApi({
    backfillStatus: () => {
      if (job.failing !== null) {
        return Promise.reject(job.failing);
      }
      if (job.slow) {
        return new Promise<BackfillStatus>((resolve) => {
          held.push(resolve);
        });
      }
      return Promise.resolve(job.status);
    },
    backfillEstimate: (_source, questions) => {
      job.status = { ...ESTIMATING, questions: questions === undefined ? null : [...questions] };
      return Promise.resolve(job.status);
    },
    backfillStart: (_source, token) => {
      if (token !== job.status.token) {
        job.status = EXPIRED;
        return Promise.reject(
          new ApiError(
            409,
            "estimate_expired",
            'The estimate of "listings" was not started in time, so it was dropped; nothing was asked.',
            "Ask for a new estimate (POST /v1/sources/listings/backfill/estimate), look at the cost, then start it with the token it gives.",
          ),
        );
      }
      job.status = running(0);
      return Promise.resolve(job.status);
    },
    backfillStop: () => {
      job.status = STOPPING;
      return Promise.resolve(job.status);
    },
    ...more,
  });
  return { api, job };
}

async function sourcesPage(api: ReturnType<typeof worker>["api"]) {
  const studio = renderStudio({ path: "/sources", api });
  const row = await screen.findByRole("article", { name: "listings" });
  const group = await within(row).findByRole("group", { name: "Backfill of listings" });
  return { studio, row, group };
}

const button = (group: HTMLElement, name: string) => within(group).getByRole("button", { name });

/** The fake scheduler's next tick: the controls ask the worker again while a job lives. */
async function refreshed(studio: ReturnType<typeof renderStudio>, text: RegExp | string) {
  studio.schedule.advance(BACKFILL_REFRESH_MS);
  return screen.findByText(text);
}

describe("a source's backfill from the Sources page", () => {
  it("shows the row's known backfill while no job lives, and Start only once the estimate is on the page", async () => {
    const { api, job } = worker();
    const { studio, group } = await sourcesPage(api);

    // No job since the worker started: the cursor's own words and strip, as GET /v1/sources says.
    expect(within(group).getByText("Finished")).toBeVisible();
    expect(within(group).getByRole("img", { name: "Backfill 100% done" })).toBeInTheDocument();
    expect(
      within(group).getByText(
        "Finished the whole question set: 41,200 records answered under version 3.",
      ),
    ).toBeVisible();
    expect(button(group, "Answer existing records")).toBeEnabled();
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Stop")).toBeDisabled();

    await studio.user.click(button(group, "Answer existing records"));

    // The count runs: nothing is asked, and Start still waits for the estimate.
    expect(await within(group).findByText("Counting the records")).toBeVisible();
    expect(within(group).getByText(/^Counting the records of listings to price/)).toBeVisible();
    expect(api.calls).toContain("backfillEstimate listings");
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Answer existing records")).toBeDisabled();
    expect(button(group, "Stop")).toBeEnabled();
    expect(api.calls.filter((call) => call.startsWith("backfillStart"))).toEqual([]);

    // The estimate lands on the scheduler's tick: the figures with their words, then Start.
    job.status = WAITING;
    await refreshed(
      studio,
      "Estimated: 1,200 records, about $0.004 (102k input tokens), at 50 records a second: about 24 seconds.",
    );
    expect(within(group).getByText("Estimated, not started")).toBeVisible();
    expect(
      within(group).getByText(
        /^Nothing is asked until you press Start\. It is dropped at \d{1,2}:\d{2} [ap]m if it is not started\.$/,
      ),
    ).toBeVisible();
    expect(button(group, "Start")).toBeEnabled();

    await studio.user.click(button(group, "Start"));

    expect(await within(group).findByText("Running")).toBeVisible();
    expect(api.calls).toContain("backfillStart listings token-1");
    expect(within(group).getByRole("img", { name: "Backfill 0% done" })).toBeInTheDocument();
    expect(within(group).getByText(/0 of 1,200 records done\.$/)).toBeVisible();
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Answer existing records")).toBeDisabled();
    expect(button(group, "Stop")).toBeEnabled();
  });

  it("moves the strip as pages settle, stops after the page in hand, then resumes with a new estimate", async () => {
    const { api, job } = worker(running(0));
    const { studio, group } = await sourcesPage(api);
    expect(await within(group).findByText("Running")).toBeVisible();

    job.status = running(600);
    await refreshed(studio, /600 of 1,200 records done\.$/);
    expect(within(group).getByRole("img", { name: "Backfill 50% done" })).toBeInTheDocument();

    await studio.user.click(button(group, "Stop"));

    expect(await within(group).findByText("Stopping")).toBeVisible();
    expect(api.calls).toContain("backfillStop listings");
    expect(within(group).getByText(/^Stopping after the page in hand/)).toBeVisible();
    expect(button(group, "Stop")).toBeDisabled();

    job.status = STOPPED;
    await refreshed(studio, STOPPED_WHY);
    // Where it got to, in words beside the strip as well as on it.
    expect(within(group).getByText("Stopped, 600 of 1,200 records done")).toBeVisible();
    expect(within(group).getByText(RESUME_LINE)).toBeVisible();
    // Where it got to stays on the strip; nothing runs, so Start and Stop wait.
    expect(within(group).getByRole("img", { name: "Backfill 50% done" })).toBeInTheDocument();
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Stop")).toBeDisabled();
    expect(within(group).queryByRole("button", { name: "Answer existing records" })).toBeNull();

    // Ended, the job is not asked for again until the page acts.
    const reads = api.calls.filter((call) => call === "backfillStatus listings").length;
    studio.schedule.advance(3 * BACKFILL_REFRESH_MS);
    expect(api.calls.filter((call) => call === "backfillStatus listings")).toHaveLength(reads);

    await studio.user.click(button(group, "Resume"));

    expect(await within(group).findByText("Counting the records")).toBeVisible();
    expect(api.calls.filter((call) => call === "backfillEstimate listings")).toHaveLength(1);
    expect(button(group, "Start")).toBeDisabled();
  });

  it("says why it paused at the spending cap and what to do, with Resume", async () => {
    const { api } = worker(PAUSED);
    const { group } = await sourcesPage(api);

    expect(
      await within(group).findByText("Paused at the spending cap, 300 of 1,200 records done"),
    ).toBeVisible();
    expect(within(group).getByText(PAUSED_WHY)).toBeVisible();
    expect(within(group).getByText(RESUME_LINE)).toBeVisible();
    expect(within(group).getByRole("img", { name: "Backfill 25% done" })).toBeInTheDocument();
    expect(button(group, "Resume")).toBeEnabled();
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Stop")).toBeDisabled();
  });

  it("says the worker is paused at the cap beside a whole-set backfill, whose queued records wait", async () => {
    const finished = sampleBackfill("finished", {
      counts: COUNTS(1_200),
      endedAt: "2026-11-06T12:01:00.000Z",
      words: "Finished: 1,200 records queued for the worker, 0 already answered.",
    });
    const paused: Home = {
      ...SAMPLE_HOME,
      spending: { ...SAMPLE_HOME.spending, status: "paused" },
    };
    const { api } = worker(finished, { home: () => Promise.resolve(paused) });
    const { group } = await sourcesPage(api);
    expect(await within(group).findByText("Finished")).toBeVisible();
    expect(
      await within(group).findByText(
        /^The worker is paused at the spending cap, so the records queued for it wait: raise the cap in Settings, which applies at once, or they are answered when the month resets\./,
      ),
    ).toBeVisible();
  });

  it("sets the estimate against what is left of the month's cap, so a crossing is said before Start", async () => {
    const nearTheCap: Home = {
      ...SAMPLE_HOME,
      spending: { ...SAMPLE_HOME.spending, inputTokens: 24_950_000 },
    };
    const { api, job } = worker(SAMPLE_BACKFILL_IDLE, { home: () => Promise.resolve(nearTheCap) });
    const { studio, group } = await sourcesPage(api);
    await studio.user.click(button(group, "Answer existing records"));
    job.status = WAITING;
    expect(
      await refreshed(
        studio,
        "Estimated: 1,200 records, about $0.004 (102k input tokens), at 50 records a second: about 24 seconds. That is more than what is left this month under the cap the worker runs with (50k input tokens), so the answering pauses at the cap, part way.",
      ),
    ).toBeVisible();
    // Start stays the person's call: the worker's state enforces the cap, not the page.
    expect(button(group, "Start")).toBeEnabled();
  });

  it("says at least before the figures when no billed answer scaled the estimate", async () => {
    const { api, job } = worker(SAMPLE_BACKFILL_IDLE);
    const { studio, group } = await sourcesPage(api);
    await studio.user.click(button(group, "Answer existing records"));
    const estimate = WAITING.estimate;
    if (estimate === null) {
      throw new Error("the waiting job has its estimate");
    }
    job.status = { ...WAITING, estimate: { ...estimate, dollars: 0.0047, calibration: null } };
    // $0.0047 rounded down, never up to $0.005, so the floor stays one.
    expect(
      await refreshed(
        studio,
        "Estimated: 1,200 records, at least $0.004 (at least 102k input tokens), at 50 records a second: about 24 seconds.",
      ),
    ).toBeVisible();
    expect(within(group).queryByText(/about \$/)).toBeNull();
  });

  it("says a cap set to keep answering is crossed, not paused at", async () => {
    const continuing: Home = {
      ...SAMPLE_HOME,
      spending: {
        ...SAMPLE_HOME.spending,
        inputTokens: 24_950_000,
        cap: { inputTokens: 25_000_000, dollars: 25, onCapReached: "continue" },
      },
    };
    const { api, job } = worker(SAMPLE_BACKFILL_IDLE, { home: () => Promise.resolve(continuing) });
    const { studio, group } = await sourcesPage(api);
    await studio.user.click(button(group, "Answer existing records"));
    job.status = WAITING;
    expect(
      await refreshed(
        studio,
        /That is more than what is left this month under the cap the worker runs with \(50k input tokens\), so it goes past the cap, as the worker was started to do\.$/,
      ),
    ).toBeVisible();
  });

  it("keeps the note off a job of some questions, which asks the model itself and pauses on its own", async () => {
    const subset = sampleBackfill("finished", {
      questions: ["is_vehicle"],
      counts: COUNTS(1_200),
      endedAt: "2026-11-06T12:01:00.000Z",
      words: "Finished: 1,200 answered.",
    });
    const paused: Home = {
      ...SAMPLE_HOME,
      spending: { ...SAMPLE_HOME.spending, status: "paused" },
    };
    const { api } = worker(subset, { home: () => Promise.resolve(paused) });
    const { group } = await sourcesPage(api);
    expect(await within(group).findByText("Finished")).toBeVisible();
    expect(within(group).queryByText(/paused at the spending cap/)).toBeNull();
  });

  it("says nothing of the cap beside a backfill while the project is under it", async () => {
    const finished = sampleBackfill("finished", {
      counts: COUNTS(1_200),
      endedAt: "2026-11-06T12:01:00.000Z",
      words: "Finished: 1,200 records queued for the worker, 0 already answered.",
    });
    const { api } = worker(finished);
    const { group } = await sourcesPage(api);
    expect(await within(group).findByText("Finished")).toBeVisible();
    expect(within(group).queryByText(/paused at the spending cap/)).toBeNull();
  });

  it("says why it failed and what to do, with Resume", async () => {
    const { api } = worker(FAILED);
    const { group } = await sourcesPage(api);

    expect(await within(group).findByText("Failed, 900 of 1,200 records done")).toBeVisible();
    expect(within(group).getByText(FAILED_WHY)).toBeVisible();
    expect(within(group).getByText(RESUME_LINE)).toBeVisible();
    expect(within(group).getByRole("img", { name: "Backfill 75% done" })).toBeInTheDocument();
    expect(button(group, "Resume")).toBeEnabled();
    expect(button(group, "Start")).toBeDisabled();
  });

  it("keeps what is shown as the last known when a refresh fails, and asks again", async () => {
    const { api, job } = worker(running(600));
    const { studio, group } = await sourcesPage(api);
    expect(await within(group).findByText(/600 of 1,200 records done\.$/)).toBeVisible();
    const status = within(group).getByRole("status");
    expect(status).toHaveTextContent("");

    job.failing = new ApiError(
      503,
      "worker_busy",
      "The worker did not answer in time.",
      "Try again in a moment.",
    );
    studio.schedule.advance(BACKFILL_REFRESH_MS);

    await waitFor(() => {
      expect(status).toHaveTextContent(
        /^Last known \d{1,2}:\d{2}:\d{2} [ap]m\. The worker could not be asked again: The worker did not answer in time\.$/,
      );
    });
    // The last answer stands, said as such, and Stop is still offered: the job may well run on.
    expect(within(group).getByText("Running")).toBeVisible();
    expect(within(group).getByText(/600 of 1,200 records done\.$/)).toBeVisible();
    expect(within(group).getByRole("img", { name: "Backfill 50% done" })).toBeInTheDocument();
    expect(button(group, "Stop")).toBeEnabled();

    job.failing = null;
    job.status = running(900);
    await refreshed(studio, /900 of 1,200 records done\.$/);
    expect(status).toHaveTextContent("");
    expect(within(group).getByRole("img", { name: "Backfill 75% done" })).toBeInTheDocument();
  });

  it("shows a start the worker refused in its words, and reads what stands now", async () => {
    const { api, job } = worker(WAITING);
    const { studio, group } = await sourcesPage(api);
    expect(await within(group).findByText("Estimated, not started")).toBeVisible();
    // Another estimate replaced the one shown: the start carries the token this page saw.
    job.status = { ...WAITING, token: "token-2" };

    await studio.user.click(button(group, "Start"));

    const refusal = await within(group).findByRole("alert");
    expect(refusal).toHaveTextContent(
      /was not started in time, so it was dropped; nothing was asked\./,
    );
    expect(refusal).toHaveTextContent(/Ask for a new estimate/);
    expect(api.calls).toContain("backfillStart listings token-1");
    expect(await within(group).findByText("Stopped, 0 of 1,200 records done")).toBeVisible();
    expect(within(group).getByText(EXPIRED_WHY)).toBeVisible();
    expect(button(group, "Resume")).toBeEnabled();
    expect(button(group, "Start")).toBeDisabled();
  });

  it("says when the worker runs no backfill from the studio, with nothing to press", async () => {
    const { api } = worker(SAMPLE_BACKFILL_IDLE, {
      backfillStatus: () =>
        Promise.reject(
          new ApiError(
            409,
            "backfill_unavailable",
            "This worker runs no backfill from the studio: facetdb worker --once answers what is queued and exits.",
            "Run facetdb worker, then backfill from the studio; or run facetdb backfill --source <name> on this machine.",
          ),
        ),
    });
    const { group } = await sourcesPage(api);

    expect(await within(group).findByText("No backfill from this worker")).toBeVisible();
    expect(within(group).getByText(/^This worker runs no backfill from the studio/)).toBeVisible();
    expect(
      within(group).getByText(/^Run facetdb worker, then backfill from the studio/),
    ).toBeVisible();
    expect(within(group).queryByRole("button")).toBeNull();
    expect(within(group).queryByRole("alert")).toBeNull();
  });

  it("offers nothing for an API source: its records arrive one by one", async () => {
    const { api } = worker();
    await sourcesPage(api);
    const tickets = screen.getByRole("article", { name: "support_tickets" });

    expect(within(tickets).getByText("None: records arrive one by one.")).toBeVisible();
    expect(within(tickets).queryByRole("group", { name: /^Backfill of/ })).toBeNull();
    expect(api.calls.filter((call) => call.startsWith("backfillStatus"))).toEqual([
      "backfillStatus listings",
    ]);
  });

  it("marks the last known when the worker is down (the read rejects, not refuses), keeping the answer and its controls", async () => {
    const { api, job } = worker(running(600));
    const { studio, group } = await sourcesPage(api);
    expect(await within(group).findByText(/600 of 1,200 records done\.$/)).toBeVisible();
    const status = within(group).getByRole("status");

    // The browser's own failure, which the studio's query client would retry twice on its own:
    // here the tick is the retry, so the failure settles at once.
    job.failing = new TypeError("Failed to fetch");
    studio.schedule.advance(BACKFILL_REFRESH_MS);

    await waitFor(() => {
      expect(status).toHaveTextContent(
        /^Last known \d{1,2}:\d{2}:\d{2} [ap]m\. The worker could not be asked again: it did not answer\.$/,
      );
    });
    expect(within(group).getByText("Running")).toBeVisible();
    expect(within(group).getByText(/600 of 1,200 records done\.$/)).toBeVisible();
    expect(within(group).getByRole("img", { name: "Backfill 50% done" })).toBeInTheDocument();
    expect(button(group, "Stop")).toBeEnabled();
    expect(button(group, "Start")).toBeDisabled();

    // Still down on the next tick: the line stays, and the worker is asked each time.
    const reads = api.calls.filter((call) => call === "backfillStatus listings").length;
    studio.schedule.advance(BACKFILL_REFRESH_MS);
    await waitFor(() => {
      expect(api.calls.filter((call) => call === "backfillStatus listings")).toHaveLength(
        reads + 1,
      );
    });
    expect(status).toHaveTextContent(/^Last known/);

    job.failing = null;
    job.status = running(1_200);
    await refreshed(studio, /1,200 of 1,200 records done\.$/);
    expect(status).toHaveTextContent("");
  });

  it("never cancels a read still in flight when the next tick comes: one request at a time", async () => {
    const { api, job } = worker(running(600));
    const { studio, group } = await sourcesPage(api);
    expect(await within(group).findByText(/600 of 1,200 records done\.$/)).toBeVisible();
    const reads = () => api.calls.filter((call) => call === "backfillStatus listings").length;
    const before = reads();

    // A worker that takes longer than a tick to answer: the tick waits on the read in flight
    // instead of dropping it and asking anew, which would never let an answer land.
    job.slow = true;
    studio.schedule.advance(BACKFILL_REFRESH_MS);
    studio.schedule.advance(BACKFILL_REFRESH_MS);
    studio.schedule.advance(BACKFILL_REFRESH_MS);
    expect(reads()).toBe(before + 1);
    expect(within(group).getByText(/600 of 1,200 records done\.$/)).toBeVisible();

    job.slow = false;
    job.status = running(900);
    job.answer();

    expect(await within(group).findByText(/900 of 1,200 records done\.$/)).toBeVisible();
    expect(within(group).getByRole("status")).toHaveTextContent("");
  });

  it("names the time of the last read that landed, not the first answer's", async () => {
    const { api, job } = worker(WAITING);
    const { studio, group } = await sourcesPage(api);
    expect(await within(group).findByText("Estimated, not started")).toBeVisible();
    const reads = () => api.calls.filter((call) => call === "backfillStatus listings").length;

    // Two ticks answer the same estimate (the same object to the cache): 2 s and 4 s after noon.
    studio.schedule.advance(BACKFILL_REFRESH_MS);
    await waitFor(() => {
      expect(reads()).toBe(2);
    });
    studio.schedule.advance(BACKFILL_REFRESH_MS);
    await waitFor(() => {
      expect(reads()).toBe(3);
    });

    job.failing = new TypeError("Failed to fetch");
    studio.schedule.advance(BACKFILL_REFRESH_MS);

    // The time named is the third read's, 4 seconds past the start, by the studio's clock.
    await waitFor(() => {
      expect(within(group).getByRole("status")).toHaveTextContent(
        /^Last known \d{1,2}:\d{2}:04 [ap]m\./,
      );
    });
    expect(within(group).getByText("Estimated, not started")).toBeVisible();
    expect(button(group, "Start")).toBeEnabled();
  });

  it("resumes a stopped job with its own questions, not the row's whole set", async () => {
    const { api } = worker({
      ...STOPPED,
      questions: ["is_vehicle"],
      counts: COUNTS(600),
    });
    const { studio, group } = await sourcesPage(api);
    expect(await within(group).findByText("Stopped, 600 of 1,200 records done")).toBeVisible();

    await studio.user.click(button(group, "Resume"));

    // The worker keeps a place per question subset: the estimate asks for the job's own.
    expect(await within(group).findByText("Counting the records")).toBeVisible();
    expect(api.calls.filter((call) => call.startsWith("backfillEstimate"))).toEqual([
      "backfillEstimate listings is_vehicle",
    ]);
  });

  it("says a first read that failed in words, with what to do, and asks again", async () => {
    const { api, job } = worker(running(600));
    job.failing = new TypeError("Failed to fetch");
    const { studio, group } = await sourcesPage(api);

    expect(await within(group).findByText("Could not be read")).toBeVisible();
    expect(
      within(group).getByText(
        "The worker did not answer when asked where this source's backfill stands.",
      ),
    ).toBeVisible();
    expect(
      within(group).getByText(
        "Check that facetdb studio or facetdb worker still runs; this row asks again every 2 seconds.",
      ),
    ).toBeVisible();
    expect(button(group, "Answer existing records")).toBeDisabled();
    expect(button(group, "Start")).toBeDisabled();
    expect(button(group, "Stop")).toBeDisabled();
    expect(within(group).queryByRole("alert")).toBeNull();

    // The worker's own refusal is shown in its words too.
    job.failing = new ApiError(
      503,
      "worker_busy",
      "The worker did not answer in time.",
      "Try again in a moment.",
    );
    await refreshed(studio, "The worker did not answer in time.");
    expect(within(group).getByText("Try again in a moment.")).toBeVisible();

    job.failing = null;
    await refreshed(studio, /600 of 1,200 records done\.$/);
    expect(within(group).getByText("Running")).toBeVisible();
    expect(button(group, "Stop")).toBeEnabled();
    expect(within(group).getByRole("status")).toHaveTextContent("");
  });

  it("is keyboard-complete: every control is reached by Tab and named for a screen reader", async () => {
    const { api } = worker(WAITING);
    const { studio, row, group } = await sourcesPage(api);
    const start = await within(group).findByRole("button", { name: "Start" });
    expect(start).toBeEnabled();

    // Reading order: Start, Stop, then the row's Questions link; the estimate's button waits.
    start.focus();
    await studio.user.tab();
    expect(button(group, "Stop")).toHaveFocus();
    await studio.user.tab();
    expect(within(row).getByRole("link", { name: "Questions" })).toHaveFocus();
    await studio.user.tab({ shift: true });
    await studio.user.tab({ shift: true });
    expect(start).toHaveFocus();

    await studio.user.keyboard("{Enter}");

    expect(await within(group).findByText("Running")).toBeVisible();
    // The strip carries its words for a screen reader, and the group is named for the source.
    expect(within(group).getByRole("img", { name: "Backfill 0% done" })).toBeInTheDocument();
    expect(group.tagName).toBe("FIELDSET");
    expect(within(group).getByRole("status")).toBeInTheDocument();
    expect(
      within(group)
        .getAllByRole("button")
        .map((control) => control.textContent),
    ).toEqual(["Answer existing records", "Start", "Stop"]);
  });
});

describe("the offer after an installed question", () => {
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

  it("says the records that were there have no answer for the question, with its estimate first and Start", async () => {
    const config: { pending: readonly PendingSource[] } = { pending: [LISTINGS_ADDED] };
    const { api, job } = worker(SAMPLE_BACKFILL_IDLE, {
      projectConfig: (): Promise<ProjectConfig> =>
        Promise.resolve({ ...SAMPLE_PROJECT_CONFIG, pending: [...config.pending] }),
      migrateRun: () => {
        config.pending = [];
        return Promise.resolve(SAMPLE_MIGRATED);
      },
    });
    const studio = renderStudio({ path: "/questions", api });
    await screen.findByRole("article", { name: "is_scam" });
    const block = screen.getByRole("region", { name: NOT_RUNNING_HEADING });
    await studio.user.click(
      await within(block).findByRole("button", { name: "Install from this page" }),
    );
    await studio.user.click(within(block).getByLabelText("Connection string"));
    await studio.user.paste(ADMIN);
    await studio.user.click(within(block).getByRole("button", { name: "Show the SQL" }));
    await studio.user.click(
      await within(block).findByRole("button", { name: "Install is_vehicle" }),
    );

    expect(
      await screen.findByText("Installed. listings now answers with is_vehicle."),
    ).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    });
    // The block went and the offer stays: one sentence, then the same controls for the question.
    expect(
      screen.getByText("Records from before have no answer for is_vehicle yet."),
    ).toBeVisible();
    const group = screen.getByRole("group", { name: "Backfill of listings" });
    expect(button(group, "Start")).toBeDisabled();

    await studio.user.click(button(group, "Answer existing records"));

    expect(await within(group).findByText("Counting the records")).toBeVisible();
    expect(api.calls).toContain("backfillEstimate listings is_vehicle");
    job.status = { ...WAITING, questions: ["is_vehicle"] };
    await refreshed(
      studio,
      "Estimated for is_vehicle: 1,200 records, about $0.004 (102k input tokens), at 50 records a second: about 24 seconds.",
    );
    expect(button(group, "Start")).toBeEnabled();

    await studio.user.click(button(group, "Start"));

    expect(await within(group).findByText("Running")).toBeVisible();
    expect(api.calls).toContain("backfillStart listings token-1");
    expect(document.body.innerHTML).not.toContain("Adm1n-MARK");
  });

  it("offers no backfill when the reload kept the source on its old set", async () => {
    const config: { pending: readonly PendingSource[] } = { pending: [LISTINGS_ADDED] };
    const { api } = worker(SAMPLE_BACKFILL_IDLE, {
      projectConfig: (): Promise<ProjectConfig> =>
        Promise.resolve({ ...SAMPLE_PROJECT_CONFIG, pending: [...config.pending] }),
      migrateRun: () =>
        Promise.resolve({
          migrated: true,
          table: "public.listings",
          reload: {
            loaded: true,
            sources: [
              {
                source: "listings",
                outcome: "kept",
                version: 3,
                message:
                  "the question is_vehicle is not installed in its database yet (public.listings lacks the column is_vehicle), so it keeps answering with version 3.",
              },
            ],
            notes: [],
          },
        }),
    });
    const studio = renderStudio({ path: "/questions", api });
    await screen.findByRole("article", { name: "is_scam" });
    const block = screen.getByRole("region", { name: NOT_RUNNING_HEADING });
    await studio.user.click(
      await within(block).findByRole("button", { name: "Install from this page" }),
    );
    await studio.user.click(within(block).getByLabelText("Connection string"));
    await studio.user.paste(ADMIN);
    await studio.user.click(within(block).getByRole("button", { name: "Show the SQL" }));
    await studio.user.click(
      await within(block).findByRole("button", { name: "Install is_vehicle" }),
    );

    expect(
      await screen.findByText("Installed. listings does not answer with is_vehicle yet."),
    ).toBeVisible();
    expect(screen.queryByText(/have no answer for is_vehicle yet/)).toBeNull();
    expect(screen.queryByRole("group", { name: "Backfill of listings" })).toBeNull();
  });

  describe("a finished job of the added question that skipped records", () => {
    // The worker's words for such a job: they send the reader to the Sources page by name.
    const SKIPPED_WORDS =
      "Finished: 1,180 answered. 20 skipped (changed or never fully answered): use Answer existing records on the Sources page to queue them with every question.";
    const FINISHED_SKIPPING = sampleBackfill("finished", {
      questions: ["is_vehicle"],
      counts: { records: 1_200, queued: 0, answered: 1_180, alreadyAnswered: 0, deferred: 20 },
      endedAt: "2026-11-06T12:01:00.000Z",
      words: SKIPPED_WORDS,
    });

    it("on the Sources page, Answer existing records asks the whole set, which queues the skipped records", async () => {
      const { api } = worker(FINISHED_SKIPPING);
      const { studio, group } = await sourcesPage(api);
      expect(await within(group).findByText(SKIPPED_WORDS)).toBeVisible();

      await studio.user.click(button(group, "Answer existing records"));

      expect(await within(group).findByText("Counting the records")).toBeVisible();
      // No questions sent: the whole set, as the words promise.
      expect(api.calls.filter((call) => call.startsWith("backfillEstimate"))).toEqual([
        "backfillEstimate listings",
      ]);
    });

    it("in the install's offer, the control of the same name asks the added question alone again, so the words name the page", async () => {
      const config: { pending: readonly PendingSource[] } = { pending: [LISTINGS_ADDED] };
      const { api } = worker(FINISHED_SKIPPING, {
        projectConfig: (): Promise<ProjectConfig> =>
          Promise.resolve({ ...SAMPLE_PROJECT_CONFIG, pending: [...config.pending] }),
        migrateRun: () => {
          config.pending = [];
          return Promise.resolve(SAMPLE_MIGRATED);
        },
      });
      const studio = renderStudio({ path: "/questions", api });
      await screen.findByRole("article", { name: "is_scam" });
      const block = screen.getByRole("region", { name: NOT_RUNNING_HEADING });
      await studio.user.click(
        await within(block).findByRole("button", { name: "Install from this page" }),
      );
      await studio.user.click(within(block).getByLabelText("Connection string"));
      await studio.user.paste(ADMIN);
      await studio.user.click(within(block).getByRole("button", { name: "Show the SQL" }));
      await studio.user.click(
        await within(block).findByRole("button", { name: "Install is_vehicle" }),
      );
      const group = await screen.findByRole("group", { name: "Backfill of listings" });
      // The offer shows the job of its own question, words and all.
      expect(await within(group).findByText(SKIPPED_WORDS)).toBeVisible();

      await studio.user.click(button(group, "Answer existing records"));

      expect(await within(group).findByText("Counting the records")).toBeVisible();
      // The added question alone: it would skip the same records again.
      expect(api.calls.filter((call) => call.startsWith("backfillEstimate"))).toEqual([
        "backfillEstimate listings is_vehicle",
      ]);
    });
  });
});
