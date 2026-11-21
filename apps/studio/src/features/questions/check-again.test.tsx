import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  type ApplyReload,
  type PendingSource,
  type ProjectConfig,
} from "../../api/index.ts";
import { type FakeApi, fakeApi, renderStudio, SAMPLE_PROJECT_CONFIG } from "../../testing/index.ts";

/**
 * Check again on the Questions page on happy-dom with the fake API client: a source whose only
 * change is questions added waits for the worker's own reading of its database, and Check again
 * asks the worker for that reload, says the source's outcome in the reload's words, and the block
 * goes once the worker's list no longer names the source.
 */

const MISSING_WORDS =
  "the question is_vehicle is not installed in its database yet (the column is_vehicle is missing), so it keeps answering with version 3. Install it from the Questions page, or run facetdb migrate --source listings, then Check again.";

const SWITCHED_WORDS =
  "the columns of the question is_vehicle are in its database and the worker login may write them: it finishes the batch in hand, then answers with version 4; nothing already answered is asked again.";

/** A question added to listings, applied, and not installed yet: the worker still runs version 3. */
const LISTINGS_ADDED: PendingSource = {
  source: "listings",
  outcome: "kept",
  message: MISSING_WORDS,
  migrate: true,
  checkAgain: true,
  added: ["is_vehicle"],
  removed: [],
};

const NOT_RUNNING_HEADING = /is not running yet\.$/;

function configWith(pending: readonly PendingSource[]): ProjectConfig {
  return { ...SAMPLE_PROJECT_CONFIG, pending: [...pending] };
}

/** The worker's list and its reload as a test sets them; Check again answers with `state.reload`. */
function worker(reload: (state: { pending: readonly PendingSource[] }) => Promise<ApplyReload>) {
  const state: { pending: readonly PendingSource[] } = { pending: [LISTINGS_ADDED] };
  const api = fakeApi({
    projectConfig: () => Promise.resolve(configWith(state.pending)),
    reload: () => reload(state),
  });
  return { api, state };
}

async function questionsPage(api: FakeApi) {
  const studio = renderStudio({ path: "/questions", api });
  await screen.findByRole("article", { name: "is_scam" });
  return studio;
}

function block() {
  return screen.getByRole("region", { name: NOT_RUNNING_HEADING });
}

describe("Check again on the Questions page", () => {
  it("offers Check again in place of the restart for a source the worker switches on its own reading of the database", async () => {
    const studio = await questionsPage(worker(() => Promise.reject(new Error("not asked"))).api);

    await studio.user.click(
      await within(block()).findByRole("button", { name: "Show terminal steps" }),
    );
    const steps = within(block()).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent("facetdb migrate --source listings");
    expect(steps[1]).toHaveTextContent(/^Press Check again/);
    expect(within(block()).queryByText(/Restart the worker/)).toBeNull();
    expect(steps[2]).toHaveTextContent("facetdb backfill --source listings --question is_vehicle");
    expect(within(block()).getByRole("button", { name: "Check again" })).toBeEnabled();
  });

  it("shows no Check again for a change that only a restart takes up", async () => {
    const { api, state } = worker(() => Promise.reject(new Error("not asked")));
    state.pending = [{ ...LISTINGS_ADDED, checkAgain: false }];
    const studio = await questionsPage(api);

    await studio.user.click(
      await within(block()).findByRole("button", { name: "Show terminal steps" }),
    );
    expect(within(block()).queryByRole("button", { name: "Check again" })).toBeNull();
    expect(within(block()).getByText(/^Restart the worker/)).toBeVisible();
  });

  it("asks the worker to reload, says the source's outcome in the reload's words, and keeps the block while it is kept", async () => {
    const still =
      "the question is_vehicle is not installed in its database yet (listings lacks the answer column is_vehicle), so it keeps answering with version 3. Install it from the Questions page, or run facetdb migrate --source listings, then Check again.";
    const { api } = worker(() =>
      Promise.resolve({
        loaded: true,
        sources: [
          { source: "listings", outcome: "kept", version: 3, message: still },
          { source: "support_messages", outcome: "unchanged", version: 2, message: null },
        ],
        notes: [],
      }),
    );
    const studio = await questionsPage(api);

    await studio.user.click(within(block()).getByRole("button", { name: "Check again" }));

    expect(
      await within(block()).findByText(
        /^The question is_vehicle is not installed in its database yet \(listings lacks the answer column is_vehicle\)/,
      ),
    ).toBeVisible();
    expect(api.calls.filter((call) => call === "reload")).toHaveLength(1);
    expect(block()).toBeVisible();
  });

  it("removes the block once the reload switched the source and the worker's list no longer names it", async () => {
    const { api } = worker((state) => {
      state.pending = [];
      return Promise.resolve({
        loaded: true,
        sources: [
          { source: "listings", outcome: "restarted", version: 4, message: SWITCHED_WORDS },
        ],
        notes: [],
      });
    });
    const studio = await questionsPage(api);

    await studio.user.click(within(block()).getByRole("button", { name: "Check again" }));

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    });
    expect(api.calls).toContain("reload");
  });

  it("says why when this worker does not reload, and keeps the block", async () => {
    const { api } = worker(() =>
      Promise.reject(
        new ApiError(
          409,
          "reload_unavailable",
          "This worker does not reload facetdb.config.ts: facetdb worker --once never does.",
          "Restart the worker to run the file as it is, or run facetdb worker to check again from the studio.",
        ),
      ),
    );
    const studio = await questionsPage(api);

    await studio.user.click(within(block()).getByRole("button", { name: "Check again" }));

    expect(
      await within(block()).findByText(
        /^This worker does not reload facetdb\.config\.ts: facetdb worker --once never does\. Restart the worker/,
      ),
    ).toBeVisible();
    expect(block()).toBeVisible();
  });

  it("says when the file did not load", async () => {
    const { api } = worker(() =>
      Promise.resolve({
        loaded: false,
        message: "facetdb.config.ts did not load: sources.0.questions.2.name is missing.",
        fix: "Fix facetdb.config.ts, then Check again.",
      }),
    );
    const studio = await questionsPage(api);

    await studio.user.click(within(block()).getByRole("button", { name: "Check again" }));

    expect(
      await within(block()).findByText(
        "facetdb.config.ts did not load: sources.0.questions.2.name is missing. Fix facetdb.config.ts, then Check again.",
      ),
    ).toBeVisible();
  });

  it("says when the worker did not answer", async () => {
    const { api } = worker(() => Promise.reject(new TypeError("Failed to fetch")));
    const studio = await questionsPage(api);

    await studio.user.click(within(block()).getByRole("button", { name: "Check again" }));

    expect(await within(block()).findByText(/^The worker did not answer\./)).toBeVisible();
  });
});
