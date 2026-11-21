import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  type ApplyReload,
  type ApplyWritten,
  type PendingSource,
  type ProjectConfig,
} from "../../api/index.ts";
import {
  type FakeApi,
  fakeApi,
  renderStudio,
  SAMPLE_APPLIED,
  SAMPLE_APPLY_DIFF,
  SAMPLE_PROJECT_CONFIG,
} from "../../testing/index.ts";
import { CONFIG_KEY } from "./queries.ts";

/**
 * A change written to facetdb.config.ts and not running on happy-dom with the fake API client: the
 * Apply dialog and the Questions page lead with what state it is and the commands to copy, only
 * while the worker's list names the source.
 */

const KEPT_WORDS =
  "the change reaches what facetdb migrate installed (a question added or removed, a type, options or levels, read, where, the table, storage or capture), so it keeps answering with version 3 until you run facetdb migrate and restart facetdb worker.";

const NOT_STARTED_WORDS =
  "new in facetdb.config.ts and not answered yet: run facetdb migrate to install it, then restart facetdb worker.";

/** A question added to listings and applied: the worker still runs version 3. */
const LISTINGS_BEHIND: PendingSource = {
  source: "listings",
  outcome: "kept",
  message: KEPT_WORDS,
  migrate: true,
  checkAgain: false,
  added: ["is_vehicle"],
  removed: [],
};

function configWith(pending: readonly PendingSource[]): ProjectConfig {
  return { ...SAMPLE_PROJECT_CONFIG, pending: [...pending] };
}

/** The worker's list as a test sets it, read on every `GET /v1/config`. */
function listed(initial: readonly PendingSource[]) {
  const state = { pending: initial };
  const api = fakeApi({ projectConfig: () => Promise.resolve(configWith(state.pending)) });
  return { api, state };
}

/** The page once it shows the form of `shows`: a question of the source the address opens on. */
async function questionsPage(api: FakeApi, options: { path?: string; shows?: string } = {}) {
  const studio = renderStudio({ path: options.path ?? "/questions", api });
  await screen.findByRole("article", { name: options.shows ?? "is_scam" });
  return studio;
}

const NOT_RUNNING_HEADING = /is written to facetdb\.config\.ts and is not running yet$/;

const applied = (reload: ApplyReload): ApplyWritten => ({
  written: true,
  path: SAMPLE_APPLIED.path,
  diff: SAMPLE_APPLY_DIFF.diff,
  reload,
});

describe("the Questions page when a source does not run the file", () => {
  it("leads the source's panel with the state in words and the commands, in the order they are run", async () => {
    await questionsPage(listed([LISTINGS_BEHIND]).api);

    const panel = screen.getByRole("tabpanel");
    const block = within(panel).getByRole("region", {
      name: "listings is written to facetdb.config.ts and is not running yet",
    });
    expect(
      within(block).getByText(/^The change reaches what facetdb migrate installed/),
    ).toBeVisible();
    expect(within(block).getByText(/it keeps answering with version 3/)).toBeVisible();
    expect(
      within(block).getByText(
        "In a terminal, in the folder that holds facetdb.config.ts, one after the other:",
      ),
    ).toBeVisible();
    const steps = within(block).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps[0]).toHaveTextContent("facetdb migrate --source listings");
    expect(steps[1]).toHaveTextContent(
      "Restart the worker: press Ctrl+C in the terminal where facetdb studio or facetdb worker runs, then start it again.",
    );
    expect(steps[2]).toHaveTextContent("facetdb backfill --source listings --question is_vehicle");
    // The block comes before the form it explains.
    const form = within(panel).getByRole("article", { name: "is_scam" });
    expect(block.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("names every added question in the backfill command, separated by commas", async () => {
    await questionsPage(listed([{ ...LISTINGS_BEHIND, added: ["is_vehicle", "is_new"] }]).api);

    expect(
      screen.getByText("facetdb backfill --source listings --question is_vehicle,is_new"),
    ).toBeVisible();
    expect(screen.getByText(/with the new questions\./)).toBeVisible();
  });

  it("gives a source that was never started the install and the restart, and no backfill", async () => {
    const { api } = listed([
      {
        source: "support_messages",
        outcome: "not-started",
        message: NOT_STARTED_WORDS,
        migrate: true,
        checkAgain: false,
        added: [],
        removed: [],
      },
    ]);
    const studio = await questionsPage(api, {
      path: "/questions?source=support_messages",
      shows: "urgency",
    });

    const block = screen.getByRole("region", {
      name: "support_messages is written to facetdb.config.ts and is not running yet",
    });
    expect(
      within(block).getByText(
        /^New in facetdb\.config\.ts and not answered yet: run facetdb migrate to install it/,
      ),
    ).toBeVisible();
    expect(within(block).getByText("facetdb migrate --source support_messages")).toBeVisible();
    expect(within(block).queryByText(/facetdb backfill/)).toBeNull();
    expect(studio.copied).toEqual([]);
  });

  it("shows only the restart for a source that answers through the check API: nothing to migrate, and no table to backfill for a question added with it", async () => {
    await questionsPage(
      listed([
        {
          // The fields it reads changed and a question was added, in one edit of the file.
          ...LISTINGS_BEHIND,
          message:
            "the fields it reads changed, so it keeps answering with version 3 until you restart facetdb worker.",
          migrate: false,
          added: ["is_vehicle"],
        },
      ]).api,
    );

    const block = screen.getByRole("region", { name: NOT_RUNNING_HEADING });
    expect(within(block).getAllByRole("listitem")).toHaveLength(1);
    expect(within(block).queryByText(/facetdb migrate/)).toBeNull();
    expect(within(block).queryByText(/facetdb backfill/)).toBeNull();
  });

  it("shows nothing for a source whose loop runs the file", async () => {
    await questionsPage(listed([]).api);

    expect(screen.queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    expect(screen.queryByText(/facetdb migrate --source/)).toBeNull();
  });

  it("shows the block in the panel of the source it is about, and in no other", async () => {
    const studio = await questionsPage(listed([LISTINGS_BEHIND]).api);

    await studio.user.click(screen.getByRole("tab", { name: "support_messages" }));

    expect(screen.queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    await studio.user.click(screen.getByRole("tab", { name: "listings" }));
    expect(screen.getByRole("region", { name: NOT_RUNNING_HEADING })).toBeVisible();
  });

  it("goes when the worker's list no longer names the source", async () => {
    const { api, state } = listed([LISTINGS_BEHIND]);
    const studio = await questionsPage(api);
    expect(screen.getByRole("region", { name: NOT_RUNNING_HEADING })).toBeVisible();

    state.pending = [];
    await act(async () => {
      await studio.queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
    });

    await waitFor(() => {
      expect(screen.queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    });
  });
});

describe("Copy in the block", () => {
  it("puts the command on the clipboard and says that it copied, on that line only", async () => {
    const studio = await questionsPage(listed([LISTINGS_BEHIND]).api);

    await studio.user.click(
      screen.getByRole("button", { name: "Copy facetdb migrate --source listings" }),
    );

    expect(studio.copied).toEqual(["facetdb migrate --source listings"]);
    const copied = await screen.findByRole("button", {
      name: "Copied facetdb migrate --source listings",
    });
    expect(copied).toHaveTextContent("Copied");
    expect(screen.getByText("Copied. Paste it into the terminal.")).toBeVisible();
    // The other line still offers its own Copy.
    expect(
      screen.getByRole("button", {
        name: "Copy facetdb backfill --source listings --question is_vehicle",
      }),
    ).toHaveTextContent("Copy");
  });

  it("copies the backfill line as printed, with the questions' names", async () => {
    const studio = await questionsPage(listed([LISTINGS_BEHIND]).api);

    await studio.user.click(
      screen.getByRole("button", {
        name: "Copy facetdb backfill --source listings --question is_vehicle",
      }),
    );

    expect(studio.copied).toEqual(["facetdb backfill --source listings --question is_vehicle"]);
  });

  it("says so, and selects the command, when the browser refuses the clipboard", async () => {
    const api = listed([LISTINGS_BEHIND]).api;
    const studio = renderStudio({
      path: "/questions",
      api,
      clipboard: () => Promise.reject(new Error("denied")),
    });
    await screen.findByRole("article", { name: "is_scam" });

    await studio.user.click(
      screen.getByRole("button", { name: "Copy facetdb migrate --source listings" }),
    );

    expect(
      await screen.findByText(
        "This browser did not allow copying. The command is selected: press Ctrl+C or Cmd+C.",
      ),
    ).toBeVisible();
    expect(window.getSelection()?.toString()).toBe("facetdb migrate --source listings");
    expect(screen.queryByText("Copied. Paste it into the terminal.")).toBeNull();
  });
});

describe("the Apply dialog when the file is written and the worker does not run it", () => {
  async function applyDialog(api: FakeApi) {
    const studio = await questionsPage(api);
    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply this draft" });
    await studio.user.click(
      await within(dialog).findByRole("button", { name: "Write facetdb.config.ts" }),
    );
    await within(dialog).findByText(/Written\. facetdb\.config\.ts holds the draft/);
    return { studio, dialog };
  }

  const KEPT_RELOAD: ApplyReload = {
    loaded: true,
    sources: [
      { source: "listings", outcome: "kept", version: 3, message: KEPT_WORDS },
      { source: "support_messages", outcome: "unchanged", version: 1, message: null },
    ],
    notes: [],
  };

  /**
   * A read of the list the worker refuses, which the studio takes as an answer at once; a worker
   * that does not answer at all is asked twice more first, over three seconds, to the same end.
   */
  const refused = () =>
    Promise.reject(
      new ApiError(
        500,
        "internal_error",
        "The worker could not read the configuration.",
        "Look at the worker's output, then reload the page.",
      ),
    );

  it("leads with the block above the list of sources, and keeps the list's words", async () => {
    // The file is written and the worker's list names the source once the dialog reads it again.
    const state = { pending: [] as readonly PendingSource[] };
    const api = fakeApi({
      projectConfig: () => Promise.resolve(configWith(state.pending)),
      applyWrite: () => {
        state.pending = [LISTINGS_BEHIND];
        return Promise.resolve(applied(KEPT_RELOAD));
      },
    });
    const { dialog } = await applyDialog(api);

    const block = await within(dialog).findByRole("region", {
      name: "listings is written to facetdb.config.ts and is not running yet",
    });
    expect(within(block).getByText("facetdb migrate --source listings")).toBeVisible();
    expect(
      within(block).getByText("facetdb backfill --source listings --question is_vehicle"),
    ).toBeVisible();
    const tag = within(dialog).getByText("kept running what it ran");
    expect(block.compareDocumentPosition(tag) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The block fits the dialog: its commands wrap, they are not scrolled sideways.
    expect(within(dialog).queryAllByRole("region", { name: /^The changes to/ })).toHaveLength(1);
  });

  it("copies a command from the dialog", async () => {
    const state = { pending: [] as readonly PendingSource[] };
    const api = fakeApi({
      projectConfig: () => Promise.resolve(configWith(state.pending)),
      applyWrite: () => {
        state.pending = [LISTINGS_BEHIND];
        return Promise.resolve(applied(KEPT_RELOAD));
      },
    });
    const { studio, dialog } = await applyDialog(api);

    await studio.user.click(
      await within(dialog).findByRole("button", { name: "Copy facetdb migrate --source listings" }),
    );

    expect(studio.copied).toEqual(["facetdb migrate --source listings"]);
    expect(within(dialog).getByText("Copied. Paste it into the terminal.")).toBeVisible();
  });

  it("shows no block when the reload restarted the source: it runs the file", async () => {
    const api = fakeApi({ applyWrite: () => Promise.resolve(SAMPLE_APPLIED) });
    const { dialog } = await applyDialog(api);

    expect(within(dialog).getByText("restarted with the new question set")).toBeVisible();
    expect(within(dialog).queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    expect(within(dialog).queryByText(/facetdb migrate --source/)).toBeNull();
  });

  it("shows no block for a source the list no longer names, whatever the reload said", async () => {
    const api = fakeApi({ applyWrite: () => Promise.resolve(applied(KEPT_RELOAD)) });
    const { dialog } = await applyDialog(api);

    expect(within(dialog).getByText("kept running what it ran")).toBeVisible();
    expect(within(dialog).queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
  });

  it("falls back to the reload's words with the install and restart when the list cannot be read", async () => {
    let reads = 0;
    const api = fakeApi({
      projectConfig: () => {
        reads += 1;
        return reads === 1 ? Promise.resolve(configWith([])) : refused();
      },
      applyWrite: () => Promise.resolve(applied(KEPT_RELOAD)),
    });
    const { dialog } = await applyDialog(api);

    const block = await within(dialog).findByRole("region", { name: NOT_RUNNING_HEADING });
    expect(within(block).getByText("facetdb migrate --source listings")).toBeVisible();
    expect(within(block).queryByText(/facetdb backfill/)).toBeNull();
  });

  it("does not take the list held before the write for the answer when the read after it fails", async () => {
    // An earlier Apply already left listings waiting with one question; this one adds another.
    let reads = 0;
    const api = fakeApi({
      projectConfig: () => {
        reads += 1;
        return reads === 1 ? Promise.resolve(configWith([LISTINGS_BEHIND])) : refused();
      },
      applyWrite: () => Promise.resolve(applied(KEPT_RELOAD)),
    });
    const { dialog } = await applyDialog(api);

    const block = await within(dialog).findByRole("region", { name: NOT_RUNNING_HEADING });
    expect(within(block).getByText("facetdb migrate --source listings")).toBeVisible();
    // Which questions to answer again is not known: the older list would name one of two.
    expect(within(block).queryByText(/facetdb backfill/)).toBeNull();
  });

  it("does not bring the block back when a read fails after one that no longer named the source", async () => {
    const state = { pending: [] as readonly PendingSource[], down: false };
    const api = fakeApi({
      projectConfig: () => (state.down ? refused() : Promise.resolve(configWith(state.pending))),
      applyWrite: () => {
        state.pending = [LISTINGS_BEHIND];
        return Promise.resolve(applied(KEPT_RELOAD));
      },
    });
    const { studio, dialog } = await applyDialog(api);
    await within(dialog).findByRole("region", { name: NOT_RUNNING_HEADING });

    // Migrated and restarted: the worker runs the file, and the list says so.
    state.pending = [];
    await act(async () => {
      await studio.queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
    });
    await waitFor(() => {
      expect(within(dialog).queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    });

    // Then the worker stops answering: the page says so, and the dialog claims nothing new.
    state.down = true;
    await act(async () => {
      await studio.queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
    });
    expect(
      await screen.findByText("The worker could not be reached for the configuration just now."),
    ).toBeVisible();
    expect(within(dialog).queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
  });

  it("keeps the block in place while the list is read again: a command copied meanwhile stays copied", async () => {
    const state = { pending: [] as readonly PendingSource[] };
    // A later read of the list, held until the test lets it answer.
    let answer: () => void = () => undefined;
    let held: Promise<void> = Promise.resolve();
    const api = fakeApi({
      projectConfig: async () => {
        await held;
        return configWith(state.pending);
      },
      applyWrite: () => {
        state.pending = [LISTINGS_BEHIND];
        return Promise.resolve(applied(KEPT_RELOAD));
      },
    });
    const { studio, dialog } = await applyDialog(api);
    const copy = await within(dialog).findByRole("button", {
      name: "Copy facetdb migrate --source listings",
    });

    // The window is focused again (back from the terminal): the list is read anew, and the person
    // copies a command while that read is under way.
    held = new Promise<void>((resolve) => {
      answer = resolve;
    });
    act(() => {
      void studio.queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
    });
    await studio.user.click(copy);

    expect(studio.queryClient.isFetching({ queryKey: CONFIG_KEY })).toBe(1);
    expect(studio.copied).toEqual(["facetdb migrate --source listings"]);
    expect(within(dialog).getByText("Copied. Paste it into the terminal.")).toBeVisible();

    // The read lands and still names the source: the same block, its line still marked as copied.
    await act(async () => {
      answer();
      await held;
    });
    await waitFor(() => {
      expect(studio.queryClient.isFetching({ queryKey: CONFIG_KEY })).toBe(0);
    });
    expect(within(dialog).getByText("Copied. Paste it into the terminal.")).toBeVisible();

    // A read that no longer names the source takes the block away: the worker runs the file.
    state.pending = [];
    await act(async () => {
      await studio.queryClient.invalidateQueries({ queryKey: CONFIG_KEY });
    });
    await waitFor(() => {
      expect(within(dialog).queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    });
  });

  it("shows the block for a source that was never started", async () => {
    const state = { pending: [] as readonly PendingSource[] };
    const api = fakeApi({
      projectConfig: () => Promise.resolve(configWith(state.pending)),
      applyWrite: () => {
        state.pending = [
          {
            source: "support_messages",
            outcome: "not-started",
            message: NOT_STARTED_WORDS,
            migrate: true,
            checkAgain: false,
            added: [],
            removed: [],
          },
        ];
        return Promise.resolve(
          applied({
            loaded: true,
            sources: [
              { source: "listings", outcome: "unchanged", version: 3, message: null },
              {
                source: "support_messages",
                outcome: "not-started",
                version: null,
                message: NOT_STARTED_WORDS,
              },
            ],
            notes: [],
          }),
        );
      },
    });
    const { dialog } = await applyDialog(api);

    const block = await within(dialog).findByRole("region", {
      name: "support_messages is written to facetdb.config.ts and is not running yet",
    });
    expect(within(block).getByText("facetdb migrate --source support_messages")).toBeVisible();
    expect(within(dialog).getByText("not started")).toBeVisible();
  });
});
