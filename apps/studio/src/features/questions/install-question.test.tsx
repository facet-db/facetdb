import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  type ApplyReload,
  type ApplyWritten,
  type Migrated,
  type MigratePlan,
  type PendingSource,
  type ProjectConfig,
} from "../../api/index.ts";
import {
  type FakeApi,
  fakeApi,
  renderStudio,
  SAMPLE_APPLIED,
  SAMPLE_APPLY_DIFF,
  SAMPLE_MIGRATE_PLAN,
  SAMPLE_MIGRATED,
  SAMPLE_PROJECT_CONFIG,
} from "../../testing/index.ts";

/**
 * An added question installed from the page on happy-dom with the fake API client: offered in the
 * block of a source the worker keeps on its old set where the worker's operator routes are open to
 * this browser, and nowhere else; the admin string in the setup's masked box, the SQL shown before
 * the one button is enabled, the run, and the outcome in the reload's words (running with version N
 * and the block gone; stopped; not known); the string dropped when the panel or the dialog closes.
 */

const ADMIN = "postgres://owner:Adm1n-MARK@localhost:5432/app";

const KEPT_WORDS =
  "the question is_vehicle needs its columns, and the worker's checks of Postgres cannot tell whether the worker login may write them, so it keeps answering with version 3 until you run facetdb migrate --source listings and restart facetdb worker.";

/** A question added to listings and applied: the worker still runs version 3. */
const LISTINGS_ADDED: PendingSource = {
  source: "listings",
  outcome: "kept",
  message: KEPT_WORDS,
  migrate: true,
  checkAgain: false,
  added: ["is_vehicle"],
  removed: [],
};

const NOT_RUNNING_HEADING = /is written to facetdb\.config\.ts and is not running yet$/;

function configWith(pending: readonly PendingSource[]): ProjectConfig {
  return { ...SAMPLE_PROJECT_CONFIG, pending: [...pending] };
}

/** The worker as a test sets it: its list, and a run that empties the list once it reloads. */
function worker(
  answers: {
    readonly open?: boolean;
    readonly pending?: readonly PendingSource[];
    readonly plan?: () => Promise<MigratePlan>;
    readonly run?: (state: { pending: readonly PendingSource[] }) => Promise<Migrated>;
  } = {},
) {
  const state: { pending: readonly PendingSource[] } = {
    pending: answers.pending ?? [LISTINGS_ADDED],
  };
  const api = fakeApi({
    projectConfig: () => Promise.resolve(configWith(state.pending)),
    setupAccess: () =>
      Promise.resolve(
        answers.open === false
          ? {
              open: false,
              code: "operator_only",
              message:
                "Adding a source connects to your database with an admin connection string, so it is done only in the studio on the machine that runs facetdb worker, opened there with no sign-in.",
              fix: "Open the studio on that machine (facetdb studio), or run facetdb init and facetdb migrate there.",
            }
          : { open: true },
      ),
    migratePlan: answers.plan ?? (() => Promise.resolve(SAMPLE_MIGRATE_PLAN)),
    migrateRun:
      answers.run === undefined
        ? () => {
            state.pending = [];
            return Promise.resolve(SAMPLE_MIGRATED);
          }
        : () => answers.run?.(state) ?? Promise.reject(new Error("no run")),
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

/** Opens the install in the block and pastes the admin string into its masked box. */
async function opened(studio: Awaited<ReturnType<typeof questionsPage>>) {
  await studio.user.click(
    await within(block()).findByRole("button", { name: "Install from this page" }),
  );
  const panel = within(block()).getByRole("region", { name: "Install is_vehicle from this page" });
  const field = within(panel).getByLabelText("Connection string");
  await studio.user.click(field);
  await studio.user.paste(ADMIN);
  return { panel, field };
}

describe("installing an added question from the Questions page", () => {
  it("shows the SQL before the one button runs it, then says the source runs version 4 and the block goes", async () => {
    const { api } = worker();
    const studio = await questionsPage(api);
    const { panel, field } = await opened(studio);

    // Masked as the setup's box: a text box the browser masks, never remembered or corrected.
    expect(field).toHaveAttribute("data-masked", "true");
    expect(field).toHaveAttribute("autocomplete", "off");
    const install = within(panel).getByRole("button", { name: "Install is_vehicle" });
    expect(install).toBeDisabled();

    await studio.user.click(within(panel).getByRole("button", { name: "Show the SQL" }));

    const sql = await within(panel).findByRole("region", {
      name: /^This runs once on public\.listings/,
    });
    expect(sql.textContent).toBe(SAMPLE_MIGRATE_PLAN.sql);
    expect(
      within(panel).getByText(/it is the text facetdb migrate --source listings --dry-run prints/),
    ).toBeVisible();
    expect(install).toBeEnabled();

    await studio.user.click(install);

    expect(
      await screen.findByText(
        /^Installed on public\.listings\. listings answers with version 4 now: the columns of the question is_vehicle are in its database/,
      ),
    ).toBeVisible();
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    });
    expect(api.calls).toContain("migratePlan listings");
    expect(api.calls).toContain(`migrateRun listings ${SAMPLE_MIGRATE_PLAN.token}`);
    // The string went with the two requests and nowhere else: not into the page once it ran.
    expect(api.admins).toEqual([ADMIN, ADMIN]);
    expect(document.body.innerHTML).not.toContain("Adm1n-MARK");
  });

  it("takes the SQL off the page when the string changes after it was shown", async () => {
    const { api } = worker();
    const studio = await questionsPage(api);
    const { panel, field } = await opened(studio);
    await studio.user.click(within(panel).getByRole("button", { name: "Show the SQL" }));
    await within(panel).findByRole("region", { name: /^This runs once on public\.listings/ });

    await studio.user.type(field, "x");

    expect(within(panel).queryByRole("region", { name: /^This runs once on/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Install is_vehicle" })).toBeDisabled();
    expect(api.calls.filter((call) => call.startsWith("migrateRun"))).toEqual([]);
  });

  it("drops the string when the panel is closed", async () => {
    const { api } = worker();
    const studio = await questionsPage(api);
    const { panel } = await opened(studio);

    await studio.user.click(within(panel).getByRole("button", { name: "Cancel" }));
    await studio.user.click(
      within(block()).getByRole("button", { name: "Install from this page" }),
    );

    expect(within(block()).getByLabelText("Connection string")).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("Adm1n-MARK");
    expect(api.calls.filter((call) => call.startsWith("migrate"))).toEqual([]);
  });

  it("offers nothing where the operator's routes are not open: the commands stay as they are", async () => {
    const { api } = worker({ open: false });
    await questionsPage(api);

    await waitFor(() => {
      expect(api.calls).toContain("setupAccess");
    });
    expect(within(block()).getByText("facetdb migrate --source listings")).toBeVisible();
    expect(within(block()).queryByRole("button", { name: "Install from this page" })).toBeNull();
  });

  it("offers nothing for a change but questions added, nor for a source not started", async () => {
    for (const pending of [
      { ...LISTINGS_ADDED, removed: ["is_scam"] },
      { ...LISTINGS_ADDED, added: [] },
      { ...LISTINGS_ADDED, outcome: "not-started" as const, added: [] },
    ]) {
      const { api } = worker({ pending: [pending] });
      const studio = await questionsPage(api);
      expect(within(block()).getByText("facetdb migrate --source listings")).toBeVisible();
      expect(within(block()).queryByRole("button", { name: "Install from this page" })).toBeNull();
      studio.unmount();
    }
  });

  it("says a refusal ran nothing, and asks for the SQL again before anything may run", async () => {
    const { api } = worker({
      run: () =>
        Promise.reject(
          new ApiError(
            409,
            "database_changed",
            "The database or facetdb.config.ts changed since the SQL was shown: planned again, the install is not the script you read, so nothing ran.",
            "Show the SQL again, read the new script, and install that.",
          ),
        ),
    });
    const studio = await questionsPage(api);
    const { panel } = await opened(studio);
    await studio.user.click(within(panel).getByRole("button", { name: "Show the SQL" }));
    await studio.user.click(
      await within(panel).findByRole("button", { name: "Install is_vehicle" }),
    );

    expect(await within(panel).findByText("Nothing ran.")).toBeVisible();
    expect(
      within(panel).getByText(/planned again, the install is not the script you read/),
    ).toBeVisible();
    expect(within(panel).queryByRole("region", { name: /^This runs once on/ })).toBeNull();
    expect(within(panel).getByRole("button", { name: "Install is_vehicle" })).toBeDisabled();
    expect(block()).toBeVisible();
  });

  it("says what a stopped install left, keeps the block, and never says nothing changed", async () => {
    const { api } = worker({
      run: () =>
        Promise.reject(
          new ApiError(
            409,
            "install_stopped",
            "The install stopped at statement 2 (columns): the database said: permission denied. 1 statement(s) before it ran and stay in the database on public.listings. listings keeps answering with the version it ran.",
            "Show the SQL again: the install plans afresh from what is in the database and finishes it. Or run facetdb migrate --source listings on this machine, then restart facetdb worker.",
          ),
        ),
    });
    const studio = await questionsPage(api);
    const { panel } = await opened(studio);
    await studio.user.click(within(panel).getByRole("button", { name: "Show the SQL" }));
    const install = await within(panel).findByRole("button", { name: "Install is_vehicle" });
    await studio.user.click(install);

    expect(await within(panel).findByText("The install stopped.")).toBeVisible();
    expect(within(panel).getByText(/keeps answering with the version it ran/)).toBeVisible();
    expect(within(panel).queryByText(/^Nothing ran\./)).toBeNull();
    // One confirmation, one run: the same plan is not sent twice.
    expect(install).toBeDisabled();
    expect(block()).toBeVisible();

    // Shown again, the page still says an install was started here.
    await studio.user.click(within(panel).getByRole("button", { name: "Show the SQL" }));
    expect(
      await within(panel).findByText(/^An install was started here and did not finish as asked/),
    ).toBeVisible();
  });

  it("says when whether the install ran is not known, with what to look at", async () => {
    const { api } = worker({ run: () => Promise.reject(new TypeError("Failed to fetch")) });
    const studio = await questionsPage(api);
    const { panel } = await opened(studio);
    await studio.user.click(within(panel).getByRole("button", { name: "Show the SQL" }));
    await studio.user.click(
      await within(panel).findByRole("button", { name: "Install is_vehicle" }),
    );

    expect(await within(panel).findByText("Whether the install ran is not known.")).toBeVisible();
    expect(within(panel).getByText(/it may have run, in whole or not at all/)).toBeVisible();
    expect(
      within(panel).getByText(/run facetdb migrate --source listings --dry-run on the machine/),
    ).toBeVisible();
    expect(within(panel).queryByText(/^Nothing ran\./)).toBeNull();
  });

  it("says what the reload said when it kept the source after the install", async () => {
    const still =
      "the question is_vehicle is not installed in its database yet (public.listings lacks the column is_vehicle), so it keeps answering with version 3. Install it from the Questions page, or run facetdb migrate --source listings, then Check again.";
    const { api } = worker({
      run: () =>
        Promise.resolve({
          migrated: true,
          table: "public.listings",
          reload: {
            loaded: true,
            sources: [{ source: "listings", outcome: "kept", version: 3, message: still }],
            notes: [],
          },
        }),
    });
    const studio = await questionsPage(api);
    const { panel } = await opened(studio);
    await studio.user.click(within(panel).getByRole("button", { name: "Show the SQL" }));
    await studio.user.click(
      await within(panel).findByRole("button", { name: "Install is_vehicle" }),
    );

    expect(
      await within(panel).findByText(
        /^Installed on public\.listings\. The question is_vehicle is not installed in its database yet/,
      ),
    ).toBeVisible();
    expect(block()).toBeVisible();
  });
});

describe("installing an added question from the Apply dialog", () => {
  const KEPT_RELOAD: ApplyReload = {
    loaded: true,
    sources: [
      { source: "listings", outcome: "kept", version: 3, message: KEPT_WORDS },
      { source: "support_messages", outcome: "unchanged", version: 1, message: null },
    ],
    notes: [],
  };

  const applied = (reload: ApplyReload): ApplyWritten => ({
    written: true,
    path: SAMPLE_APPLIED.path,
    diff: SAMPLE_APPLY_DIFF.diff,
    reload,
  });

  function applying() {
    const state: { pending: readonly PendingSource[] } = { pending: [] };
    const api = fakeApi({
      projectConfig: () => Promise.resolve(configWith(state.pending)),
      applyWrite: () => {
        state.pending = [LISTINGS_ADDED];
        return Promise.resolve(applied(KEPT_RELOAD));
      },
      migrateRun: () => {
        state.pending = [];
        return Promise.resolve(SAMPLE_MIGRATED);
      },
    });
    return { api, state };
  }

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

  it("installs from the block in the dialog and says the source runs version 4 once the block goes", async () => {
    const { api } = applying();
    const { studio, dialog } = await applyDialog(api);
    const inDialog = await within(dialog).findByRole("region", { name: NOT_RUNNING_HEADING });

    await studio.user.click(
      within(inDialog).getByRole("button", { name: "Install from this page" }),
    );
    await studio.user.click(within(inDialog).getByLabelText("Connection string"));
    await studio.user.paste(ADMIN);
    await studio.user.click(within(inDialog).getByRole("button", { name: "Show the SQL" }));
    await studio.user.click(
      await within(inDialog).findByRole("button", { name: "Install is_vehicle" }),
    );

    expect(
      await within(dialog).findByText(
        /^Installed on public\.listings\. listings answers with version 4 now/,
      ),
    ).toBeVisible();
    await waitFor(() => {
      expect(within(dialog).queryByRole("region", { name: NOT_RUNNING_HEADING })).toBeNull();
    });
  });

  it("drops the string when the dialog closes", async () => {
    const { api } = applying();
    const { studio, dialog } = await applyDialog(api);
    const inDialog = await within(dialog).findByRole("region", { name: NOT_RUNNING_HEADING });
    await studio.user.click(
      within(inDialog).getByRole("button", { name: "Install from this page" }),
    );
    await studio.user.click(within(inDialog).getByLabelText("Connection string"));
    await studio.user.paste(ADMIN);

    await studio.user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Apply this draft" })).toBeNull();
    });

    expect(document.body.innerHTML).not.toContain("Adm1n-MARK");
    // The page's own block opens with an empty box.
    await studio.user.click(
      within(block()).getByRole("button", { name: "Install from this page" }),
    );
    expect(within(block()).getByLabelText("Connection string")).toHaveValue("");
    expect(api.calls.filter((call) => call.startsWith("migrate"))).toEqual([]);
  });
});
