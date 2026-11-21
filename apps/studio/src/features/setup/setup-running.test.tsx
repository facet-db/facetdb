import { act, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApiClient, SetupInstalled } from "../../api/index.ts";
import {
  fakeApi,
  installed,
  opened,
  SAMPLE_BACKFILL_IDLE,
  SAMPLE_INSTALLED,
  SAMPLE_INSTALLED_RUNNING,
  SELLERS_PREVIEW,
  sampleBackfill,
} from "../../testing/index.ts";

/**
 * The last step of Add a source once the install ran: when the worker's reload started the source,
 * the step says it is running with its version and offers its backfill (with the cost shown first)
 * in place of the words to restart the worker; when it did not, the reload's own why with the
 * command, then the restart and the backfill command. On happy-dom with the fake client; nothing
 * moves but by the person's hand.
 */

function api(reply: SetupInstalled, more: Partial<ApiClient> = {}) {
  return fakeApi({
    setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
    setupInstall: () => Promise.resolve(reply),
    ...more,
  });
}

const RUNNING_WORDS =
  "sellers is running with version 1: it answers every change to public.sellers from now on.";

describe("the last step, once the install ran", () => {
  it("says the source is running with its version and offers its backfill, with no restart words", async () => {
    const studio = await opened(
      api(SAMPLE_INSTALLED_RUNNING, {
        backfillStatus: (source) => Promise.resolve({ ...SAMPLE_BACKFILL_IDLE, source }),
        backfillEstimate: (source) =>
          Promise.resolve(sampleBackfill("estimating", { source, estimate: null })),
      }),
    );
    await installed(studio);

    expect(screen.getByText(RUNNING_WORDS)).toBeVisible();
    expect(
      screen.getByText(/The records already in public\.sellers have no answer yet/),
    ).toBeVisible();
    const backfill = await screen.findByRole("group", { name: "Backfill of sellers" });
    await within(backfill).findByText("No backfill yet");
    const answer = within(backfill).getByRole("button", { name: "Answer existing records" });
    expect(answer).toBeEnabled();
    expect(within(backfill).getByRole("button", { name: "Start" })).toBeDisabled();
    // Nothing says to restart, and the CLI's backfill command is not the way offered here.
    expect(screen.queryByText(/stop facetdb worker \(Ctrl\+C\) and start it again/)).toBeNull();
    expect(screen.queryByText(/facetdb backfill --source sellers/)).toBeNull();
    // The keyboard goes from the one enabled control to Back to Sources, the one filled action
    // (Start and Stop, disabled, are passed over).
    act(() => {
      answer.focus();
    });
    expect(answer).toHaveFocus();
    await studio.user.tab();
    expect(screen.getByRole("link", { name: "Back to Sources" })).toHaveFocus();
    expect(screen.getByRole("link", { name: "Back to Sources" })).toHaveAttribute(
      "data-variant",
      "primary",
    );
    // The estimate is asked for the new source's whole set, as from its row on Sources.
    await studio.user.click(answer);
    expect(studio.api.calls).toContain("backfillEstimate sellers");
    await within(backfill).findByText("Counting the records");
  });

  it("says why the source was not started and the command, then the restart and the backfill command", async () => {
    const studio = await opened(api(SAMPLE_INSTALLED));
    await installed(studio);

    expect(
      screen.getByText(
        "New in facetdb.config.ts and not answered yet: its database could not be read to check its install (connect ECONNREFUSED 10.0.0.5:5432). Check again once the database answers; facetdb doctor says what is wrong.",
      ),
    ).toBeVisible();
    expect(screen.getByText(/stop facetdb worker \(Ctrl\+C\) and start it again/)).toBeVisible();
    expect(screen.getByText(/facetdb backfill --source sellers shows its estimate/)).toBeVisible();
    expect(screen.queryByRole("group", { name: "Backfill of sellers" })).toBeNull();
    expect(screen.queryByText(/is running with version/)).toBeNull();
    expect(screen.getByRole("link", { name: "Back to Sources" })).toHaveAttribute(
      "href",
      "/sources",
    );
  });

  it("keeps a why that begins with a file name as the worker wrote it", async () => {
    const why =
      "facetdb.config.ts was written but does not load, so the worker keeps running on the config it had. Fix each line named in facetdb.config.ts, then apply again or restart facetdb worker.";
    const studio = await opened(
      api({
        ...SAMPLE_INSTALLED,
        worker: { running: false, why, restart: "Restart facetdb worker when the file loads." },
      }),
    );
    await installed(studio);

    expect(screen.getByText(why)).toBeVisible();
    expect(screen.queryByText(/^Facetdb/)).toBeNull();
  });
});
