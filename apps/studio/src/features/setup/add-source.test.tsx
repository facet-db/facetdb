import { act, screen, waitFor, within } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  type Inspection,
  type SetupDraft,
  type SetupInstalled,
} from "../../api/index.ts";
import {
  ADMIN,
  connected,
  type FakeApi,
  fakeApi,
  MARK,
  opened,
  pick,
  renderStudio,
  SAMPLE_INSTALLED,
  SAMPLE_PROJECT_CONFIG,
  SAMPLE_SELLERS,
  SAMPLE_SETUP_PLAN,
  SAMPLE_SOURCES,
  SAMPLE_TABLES,
  SELLERS_PREVIEW,
  STEPS,
  step,
  written,
} from "../../testing/index.ts";
import { PREVIEW_SETTLE_MS } from "../questions/index.ts";
import { ConnectionField } from "./fields.tsx";

/**
 * Add a source on happy-dom with the fake API client and the fake scheduler: the six steps in
 * order, each waiting for the one before; the connection string sent with each request and never on
 * screen after step one; the table's columns and rows as text; the preview filling in at step three
 * on a click and then after an edit, never for a cut line; the install button disabled until the
 * plan is on screen, and one install per click; the refusal of a table in its words; and the page's
 * word before step one when this browser may not add a source.
 */

function sent(api: FakeApi, method: string): SetupDraft[] {
  return api.calls
    .filter((call) => call.startsWith(`${method} `))
    .map((call) => JSON.parse(call.slice(method.length + 1)) as SetupDraft);
}

function advance(studio: { schedule: { advance: (ms: number) => void } }, ms: number) {
  act(() => {
    studio.schedule.advance(ms);
  });
}

describe("Add a source", () => {
  it("shows the six steps in order, each after the one before it waits", async () => {
    await opened();
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((heading) => heading.textContent);
    expect(headings).toEqual(STEPS);
    expect(
      within(step("Pick the table and the columns to read")).getByText(/After step one/),
    ).toBeVisible();
    expect(within(step("Turn it on")).getByText(/After the steps above/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run the install" })).toBeNull();
  });

  it("connects with the string, then never shows it again; it rides in each request and nowhere else", async () => {
    const studio = await opened();
    await written(studio);
    await studio.user.click(screen.getByRole("button", { name: "Preview 20 rows" }));
    await screen.findByRole("table", { name: "Live preview of sellers" });
    await studio.user.click(screen.getByRole("button", { name: "Show the SQL" }));
    await screen.findByText(/the text facetdb migrate --dry-run prints/);

    expect(screen.queryByRole("textbox", { name: "Connection string" })).toBeNull();
    expect(document.body.textContent).not.toContain(MARK);
    for (const input of document.querySelectorAll("input, textarea")) {
      expect((input as HTMLInputElement).value).not.toContain(MARK);
    }
    // Every setup request carried the string, and the call log, which a failing test prints, holds none of it.
    expect(studio.api.admins.length).toBe(4);
    expect(studio.api.admins.every((admin) => admin === ADMIN)).toBe(true);
    expect(JSON.stringify(studio.api.calls)).not.toContain(MARK);
    // Nor does the query cache: what the mutations kept is the table and the drafts.
    const cache = JSON.stringify(
      studio.queryClient
        .getMutationCache()
        .getAll()
        .map((mutation) => mutation.state),
    );
    expect(cache).not.toContain(MARK);
    expect(
      JSON.stringify(
        studio.queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.state),
      ),
    ).not.toContain(MARK);
  });

  it("keeps what was typed when the connection fails, with the worker's words", async () => {
    const api = fakeApi({
      setupInspect: () =>
        Promise.reject(
          new ApiError(
            502,
            "login_refused",
            "The database refused the login in the connection string.",
            "Check the user and the password in the connection string, then connect again.",
          ),
        ),
    });
    const studio = await opened(api);
    await studio.user.type(screen.getByRole("textbox", { name: "Connection string" }), ADMIN);
    await studio.user.click(screen.getByRole("button", { name: "Connect" }));
    expect(
      await screen.findByText("The database refused the login in the connection string."),
    ).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Connection string" })).toHaveValue(ADMIN);
    expect(screen.getByRole("textbox", { name: "Connection string" })).toHaveAttribute(
      "spellcheck",
      "false",
    );
  });

  it("shows the table's columns and five rows as text, the text columns checked", async () => {
    const studio = await opened();
    await connected(studio);
    await pick(studio, 1);
    expect(await screen.findByRole("checkbox", { name: /bio/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /country/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /joined/ })).not.toBeChecked();
    expect(studio.api.calls).toContain("setupInspect sellers");
    const rows = screen.getByRole("table", { name: "3 sample rows, as the model will see them" });
    // A value from the database is text, never markup.
    expect(within(rows).getByText("New here, cash only, <b>today</b>")).toBeVisible();
    expect(rows.querySelector("b")).toBeNull();
    expect(within(rows).queryByRole("columnheader", { name: "joined" })).toBeNull();
    expect(
      screen.getByRole("textbox", { name: "The source's name in facetdb.config.ts" }),
    ).toHaveValue("sellers");
    // The database's estimate of 4,137 rows, rounded as an estimate reads.
    expect(screen.getByText("about 4,100 rows")).toBeVisible();
  });

  it("names no size for a table the database has no estimate of", async () => {
    const sellers = SAMPLE_SELLERS.table;
    if (sellers === null) {
      throw new Error("the sample inspects the sellers table");
    }
    const unanalysed: Inspection = {
      ...SAMPLE_SELLERS,
      table: { ...sellers, estimatedRows: null },
    };
    const api = fakeApi({
      setupInspect: (_admin, table) =>
        Promise.resolve(table === undefined ? SAMPLE_TABLES : unanalysed),
    });
    const studio = await opened(api);
    await connected(studio);
    await pick(studio, 1);
    expect(await screen.findByRole("checkbox", { name: /bio/ })).toBeChecked();
    expect(screen.queryByText(/^about .* rows?$/)).toBeNull();
  });

  // Seen in a real run: the list opened on nothing, and "clicking choose table doesn't do
  // anything".
  it("shuts the table list and says what to do when the connection can read no table", async () => {
    const api = fakeApi({
      setupInspect: () =>
        Promise.resolve({ database: "Postgres", tables: [], table: null, sharedWith: null }),
    });
    const studio = await opened(api);
    await studio.user.type(screen.getByRole("textbox", { name: "Connection string" }), ADMIN);
    await studio.user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Connected: Postgres, 0 tables");
    const list = within(step(STEPS[1] ?? "")).getByRole("combobox", { name: "Table" });
    expect(list).toBeDisabled();
    expect(list).toHaveTextContent("No table to choose");
    expect(screen.getByText("This connection can read no table")).toBeVisible();
    expect(screen.getByText(/Use another connection string above/)).toBeVisible();
    await studio.user.click(list);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("says why a table the engine refuses cannot be set up, and goes no further", async () => {
    const api = fakeApi({
      setupInspect: (_admin, table) =>
        table === undefined
          ? Promise.resolve({
              database: "Postgres",
              tables: ["events", "sellers"],
              table: null,
              sharedWith: null,
            })
          : Promise.reject(
              new ApiError(
                409,
                "no-table",
                "there is no table events this connection can read",
                "pick one of the tables listed, or check that the connection string's role may select from it",
              ),
            ),
    });
    const studio = await opened(api);
    await studio.user.type(screen.getByRole("textbox", { name: "Connection string" }), ADMIN);
    await studio.user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("Connected: Postgres, 2 tables");
    await pick(studio, 0);
    expect(
      await screen.findByText("there is no table events this connection can read"),
    ).toBeVisible();
    expect(
      screen.getByText(
        "pick one of the tables listed, or check that the connection string's role may select from it",
      ),
    ).toBeVisible();
    expect(within(step("Write the questions")).getByText(/After step two/)).toBeVisible();
  });

  it("says a table without a single-column key cannot be set up", async () => {
    const keyless: Inspection = {
      ...SAMPLE_SELLERS,
      table: {
        ...(SAMPLE_SELLERS.table ?? { name: "", columns: [], rows: [], estimatedRows: null }),
        name: "sellers",
        key: null,
      },
    };
    const api = fakeApi({
      setupInspect: (_admin, table) =>
        Promise.resolve(table === undefined ? { ...keyless, table: null } : keyless),
    });
    const studio = await opened(api);
    await connected(studio);
    await pick(studio, 1);
    expect(await screen.findByText(/sellers has no single-column primary key/)).toBeVisible();
    expect(within(step("Write the questions")).getByText(/After step two/)).toBeVisible();
  });

  it("fills the preview at step three on a click, then 1.5 seconds after an edit, never for a cut line", async () => {
    const studio = await opened();
    await written(studio);
    expect(sent(studio.api, "setupPreview")).toEqual([]);
    await studio.user.click(screen.getByRole("button", { name: "Preview 20 rows" }));
    const table = await screen.findByRole("table", { name: "Live preview of sellers" });
    advance(studio, 2_000);
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    const first = sent(studio.api, "setupPreview")[0];
    expect(first).toMatchObject({
      name: "sellers",
      table: "sellers",
      read: ["bio", "country"],
      storage: "inline",
      database: { env: "DATABASE_URL" },
      questions: { is_fake: { type: "noul", instructions: "Is this seller a fake account?" } },
    });

    // A cut line moved at step four re-decides the rows on the page and asks nothing.
    const thresholds = step("Set the thresholds");
    act(() => {
      within(thresholds).getByRole("slider", { name: "Yes at or above" }).focus();
    });
    await studio.user.keyboard("{ArrowLeft}");
    advance(studio, PREVIEW_SETTLE_MS * 2);
    expect(sent(studio.api, "setupPreview")).toHaveLength(1);

    // An edit of the question asks again once the typing has stood still.
    await studio.user.type(
      within(step("Write the questions")).getByRole("textbox", { name: "Yes when" }),
      "A brand-new account",
    );
    advance(studio, PREVIEW_SETTLE_MS - 1);
    expect(sent(studio.api, "setupPreview")).toHaveLength(1);
    advance(studio, 1);
    await waitFor(() => {
      expect(sent(studio.api, "setupPreview")).toHaveLength(2);
    });
  });

  it("drops the preview's answers when the rows change, and asks again only on a click", async () => {
    const studio = await opened();
    await written(studio);
    await studio.user.click(screen.getByRole("button", { name: "Preview 20 rows" }));
    await screen.findByRole("table", { name: "Live preview of sellers" });
    await studio.user.click(screen.getByRole("checkbox", { name: /country/ }));
    expect(screen.queryByRole("table", { name: "Live preview of sellers" })).toBeNull();
    expect(screen.getByRole("button", { name: "Preview 20 rows" })).toBeEnabled();
    advance(studio, PREVIEW_SETTLE_MS * 2);
    expect(sent(studio.api, "setupPreview")).toHaveLength(1);
    // The questions written are kept.
    expect(
      within(step("Write the questions")).getByRole("textbox", { name: "Question" }),
    ).toHaveValue("Is this seller a fake account?");
  });

  it("keeps the install button disabled until the plan is shown, then installs once", async () => {
    const studio = await opened();
    await written(studio);
    const turnOn = () => step("Turn it on");
    expect(within(turnOn()).getByRole("button", { name: "Run the install" })).toBeDisabled();
    expect(sent(studio.api, "setupInstall")).toEqual([]);

    await studio.user.click(within(turnOn()).getByRole("button", { name: "Show the SQL" }));
    const sql = await within(turnOn()).findByText(/alter table "public"."sellers"/);
    expect(sql.tagName).toBe("PRE");
    expect(sql.textContent).toBe(SAMPLE_SETUP_PLAN.sql);
    // A source not yet installed has no billed answer to scale its estimate by: the cost is a
    // floor, said so before the tokens and the dollars.
    expect(
      within(turnOn()).getByText(
        "The backfill of the rows already there: about 50,000 records (the database's own estimate of the table's size; nothing was counted), newest first, at most 50 a second, about 17 minutes and at least $0.08 (at least 2,000,000 input tokens). Start it with facetdb backfill --source sellers once the worker runs the source: it counts exactly and shows its estimate first.",
      ),
    ).toBeVisible();
    const run = within(turnOn()).getByRole("button", { name: "Run the install" });
    expect(run).toBeEnabled();

    // A change after the plan was shown hides it: the install acts only on what is on screen.
    await studio.user.type(
      within(step("Write the questions")).getByRole("textbox", { name: "Question" }),
      " Really?",
    );
    expect(within(turnOn()).getByRole("button", { name: "Run the install" })).toBeDisabled();
    expect(within(turnOn()).getByText(/The source changed since the SQL was shown/)).toBeVisible();
    await studio.user.click(within(turnOn()).getByRole("button", { name: "Show the SQL" }));
    await within(turnOn()).findByText(/alter table "public"."sellers"/);

    await studio.user.dblClick(within(turnOn()).getByRole("button", { name: "Run the install" }));
    expect(
      await screen.findByRole("heading", { level: 2, name: "Installed on public.sellers" }),
    ).toBeVisible();
    const installs = studio.api.calls.filter((call) => call.startsWith("setupInstall "));
    expect(installs).toHaveLength(1);
    expect(JSON.parse(installs[0]?.slice("setupInstall ".length) ?? "{}")).toMatchObject({
      token: "plan-token-1",
      force: false,
      draft: { name: "sellers" },
    });
    expect(screen.getByText(/stop facetdb worker \(Ctrl\+C\) and start it again/)).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to Sources" })).toHaveAttribute(
      "href",
      "/sources",
    );
  });

  it("asks before replacing a config file git keeps no copy of", async () => {
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupPlan: () =>
        Promise.resolve({
          ...SAMPLE_SETUP_PLAN,
          uncommitted: {
            state: "modified",
            message:
              "facetdb.config.ts has changes git has not committed, and Apply would replace them",
            fix: 'commit them, or apply again with force ("force": true) to replace them',
          },
        }),
    });
    const studio = await opened(api);
    await written(studio);
    await studio.user.click(screen.getByRole("button", { name: "Show the SQL" }));
    // The page's own plain words for the state; the terminal's (force, commit) are not shown.
    await screen.findByText("This file has changes git has not saved.");
    expect(screen.queryByText(/"force": true|git commit/)).toBeNull();
    expect(screen.getByRole("button", { name: "Run the install" })).toBeDisabled();
    await studio.user.click(screen.getByRole("checkbox", { name: "Replace it anyway" }));
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    await screen.findByRole("heading", { level: 2, name: "Installed on public.sellers" });
    expect(studio.api.calls.find((call) => call.startsWith("setupInstall "))).toContain(
      '"force":true',
    );
  });

  it("asks for the SQL again when the install is refused, and shows the worker's words", async () => {
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () =>
        Promise.reject(
          new ApiError(
            409,
            "database_changed",
            "The database changed since the SQL was shown: planned again, the install is not the script you read, so nothing was written and nothing ran.",
            "Show the SQL again, read the new script, and install that.",
          ),
        ),
    });
    const studio = await opened(api);
    await written(studio);
    await studio.user.click(screen.getByRole("button", { name: "Show the SQL" }));
    await studio.user.click(await screen.findByRole("button", { name: "Run the install" }));
    expect(await screen.findByText(/The database changed since the SQL was shown/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Run the install" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Show the SQL" })).toBeEnabled();
  });

  it("says before step one that only the worker's machine adds a source", async () => {
    const api = fakeApi({
      setupAccess: () =>
        Promise.resolve({
          open: false,
          code: "operator_only",
          message:
            "Adding a source connects to your database with an admin connection string, so it is done only in the studio on the machine that runs facetdb worker, opened there with no sign-in.",
          fix: "Open the studio on that machine (facetdb studio), or run facetdb init and facetdb migrate there.",
        }),
    });
    renderStudio({ path: "/sources/new", api });
    expect(
      await screen.findByText(
        /it is done only in the studio on the machine that runs facetdb worker/,
      ),
    ).toBeVisible();
    expect(screen.getByText(/run facetdb init and facetdb migrate there/)).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Connection string" })).toBeNull();
  });
});

/** A promise the test settles by hand: a reply still in flight. */
function deferred<T>() {
  let settle: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/** Written, previewed, the SQL shown: one click from an install. */
async function planShown(studio: Awaited<ReturnType<typeof opened>>) {
  await written(studio);
  await studio.user.click(screen.getByRole("button", { name: "Preview 20 rows" }));
  await screen.findByRole("table", { name: "Live preview of sellers" });
  advance(studio, 2_000);
  await studio.user.click(screen.getByRole("button", { name: "Show the SQL" }));
  await screen.findByText(/alter table "public"."sellers"/);
}

const installs = (api: FakeApi) => api.calls.filter((call) => call.startsWith("setupInstall "));

describe("the connection string's box", () => {
  it("masks the string until it is shown, and masks it again after a failed connection", async () => {
    const api = fakeApi({
      setupInspect: () =>
        Promise.reject(new ApiError(502, "login_refused", "The login was refused.", "Check it.")),
    });
    const studio = await opened(api);
    const box = screen.getByRole("textbox", { name: "Connection string" });
    await studio.user.type(box, ADMIN);
    expect(box).toHaveAttribute("data-masked", "true");
    expect(box).toHaveAttribute("autocomplete", "off");
    expect(box.closest("form")).toBeNull();
    const toggle = screen.getByRole("button", { name: "Show the connection string" });
    expect(toggle).toHaveTextContent("Show");
    act(() => {
      toggle.focus();
    });
    await studio.user.keyboard("{Enter}");
    // The name holds the word on the button in both states.
    expect(toggle).toHaveAccessibleName("Hide the connection string");
    expect(toggle).toHaveTextContent("Hide");
    expect(box).toHaveAttribute("data-masked", "false");
    await studio.user.click(screen.getByRole("button", { name: "Connect" }));
    await screen.findByText("The login was refused.");
    expect(screen.getByRole("textbox", { name: "Connection string" })).toHaveAttribute(
      "data-masked",
      "true",
    );
  });
});

describe("the box's masking is in its markup", () => {
  it("is an inline style a browser receives with the element, so no stylesheet build can drop it", () => {
    // happy-dom keeps no style it does not know; the markup React writes is what a browser gets.
    const masked = renderToStaticMarkup(
      <ConnectionField
        value="postgres://u:p@h/db"
        onChange={() => undefined}
        problem={undefined}
        onEnter={() => undefined}
        revealed={false}
        onReveal={() => undefined}
      />,
    );
    expect(masked).toContain('style="-webkit-text-security:disc"');
    const shown = renderToStaticMarkup(
      <ConnectionField
        value="postgres://u:p@h/db"
        onChange={() => undefined}
        problem={undefined}
        onEnter={() => undefined}
        revealed
        onReveal={() => undefined}
      />,
    );
    expect(shown).not.toContain("text-security");
  });
});

describe("an install that failed", () => {
  it("after install_stopped: the worker's words alone, the config and sources read again, no second install until the person ran the command", async () => {
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () =>
        Promise.reject(
          new ApiError(
            409,
            "install_stopped",
            "The install stopped at statement 2 (grants): the database said: permission denied. 1 statement(s) before it ran and stay in the database on public.sellers. facetdb.config.ts keeps the source sellers, so the install can be finished.",
            "Run facetdb migrate --source sellers on this machine: it plans afresh from what is in the database and finishes the install. To take it out instead, run facetdb uninstall --source sellers.",
          ),
        ),
    });
    const studio = await opened(api);
    await planShown(studio);
    const readsBefore = api.calls.filter((call) => call === "projectConfig").length;
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    expect(await screen.findByRole("heading", { name: "The install stopped" })).toBeVisible();
    expect(screen.getByText(/1 statement\(s\) before it ran and stay/)).toBeVisible();
    expect(screen.getByText(/Run facetdb migrate --source sellers on this machine/)).toBeVisible();
    expect(screen.queryByText(/has changed yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Run the install" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Show the SQL" })).toBeNull();
    await waitFor(() => {
      expect(api.calls.filter((call) => call === "projectConfig").length).toBeGreaterThan(
        readsBefore,
      );
    });
    expect(api.calls).toContain("sources");
    expect(installs(api)).toHaveLength(1);
    // The file was put back (the fake config does not name sellers): the SQL is planned afresh,
    // and the page never says nothing changed.
    await studio.user.click(screen.getByRole("button", { name: "I have run it: read again" }));
    expect(await screen.findByRole("button", { name: "Show the SQL" })).toBeEnabled();
    expect(
      screen.getByText(/The SQL is planned afresh from what the database holds now/),
    ).toBeVisible();
    expect(
      screen.getByText(
        "Read again just now: facetdb.config.ts does not name sellers, and the Sources page does not list sellers (a worker started after an install lists it).",
      ),
    ).toBeVisible();
    expect(screen.queryByText(/has changed yet/)).toBeNull();
    expect(installs(api)).toHaveLength(1);
  });

  it("after a network failure: not known, where to look, and no second install", async () => {
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    expect(
      await screen.findByRole("heading", { name: "How the install ended is not known" }),
    ).toBeVisible();
    expect(
      screen.getByText(/no answer came back from the worker, so whether it ran is not known/),
    ).toBeVisible();
    expect(screen.getByText("facetdb migrate --source sellers --dry-run")).toBeVisible();
    expect(screen.getByRole("link", { name: "Sources page" })).toHaveAttribute("href", "/sources");
    expect(screen.queryByText(/has changed yet/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Run the install" })).toBeNull();
    expect(installs(api)).toHaveLength(1);
  });

  it("after the worker says it could not learn the outcome: its words, the same holds", async () => {
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () =>
        Promise.reject(
          new ApiError(
            502,
            "install_outcome_unknown",
            "The install of sellers was started, and the worker could not learn how it ended.",
            "Look before anything else: run facetdb migrate --source sellers --dry-run.",
          ),
        ),
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    expect(await screen.findByText(/the worker could not learn how it ended/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Run the install" })).toBeNull();
    expect(installs(api)).toHaveLength(1);
  });

  it.each([
    [
      "I have run it: read again",
      new ApiError(
        409,
        "install_stopped",
        "The install stopped at statement 1.",
        "Run facetdb migrate --source sellers.",
      ),
    ],
    ["I have looked: read again", new TypeError("Failed to fetch")],
  ])(
    "after %s with the file naming the source: what was read, no install again under any name for the table",
    async (button, failure) => {
      // The config as the worker reads it once the file names sellers.
      const named = {
        ...SAMPLE_PROJECT_CONFIG,
        sources: [
          ...SAMPLE_PROJECT_CONFIG.sources,
          { name: "sellers", table: "sellers", read: ["bio"], questions: {}, thresholds: {} },
        ],
      };
      let failed = false;
      const api = fakeApi({
        setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
        setupInstall: () => {
          failed = true;
          return Promise.reject(failure);
        },
        projectConfig: () => Promise.resolve(failed ? named : SAMPLE_PROJECT_CONFIG),
      });
      const studio = await opened(api);
      await planShown(studio);
      await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
      await studio.user.click(await screen.findByRole("button", { name: button }));
      expect(
        await screen.findByText(
          "Read again just now: facetdb.config.ts names sellers, and the Sources page does not list sellers (a worker started after an install lists it).",
        ),
      ).toBeVisible();
      expect(
        screen.getByText(
          /sellers is in facetdb.config.ts, so sellers is not installed again from here/,
        ),
      ).toBeVisible();
      expect(screen.getByText("facetdb migrate --source sellers")).toBeVisible();
      expect(screen.queryByText(/has changed yet/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Show the SQL" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Run the install" })).toBeNull();
      // Under another name for the same table: still not offered.
      const name = screen.getByRole("textbox", { name: "The source's name in facetdb.config.ts" });
      await studio.user.clear(name);
      await studio.user.type(name, "sellers_two");
      expect(screen.queryByRole("button", { name: "Run the install" })).toBeNull();
      expect(installs(api)).toHaveLength(1);
    },
  );

  it("after a network failure and 'I have looked' with the file put back: planned afresh, never nothing changed", async () => {
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () => Promise.reject(new TypeError("Failed to fetch")),
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    await studio.user.click(
      await screen.findByRole("button", { name: "I have looked: read again" }),
    );
    expect(
      await screen.findByText(/The SQL is planned afresh from what the database holds now/),
    ).toBeVisible();
    expect(screen.getByText(/facetdb.config.ts does not name sellers/)).toBeVisible();
    expect(screen.queryByText(/has changed yet/)).toBeNull();
    expect(installs(api)).toHaveLength(1);
  });

  it("after a refusal that ran nothing: nothing has changed, and the SQL is shown again first", async () => {
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () =>
        Promise.reject(
          new ApiError(409, "plan_not_shown", "This install names no plan.", "Show the SQL again."),
        ),
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    expect(await screen.findByText("This install names no plan.")).toBeVisible();
    expect(
      screen.getByText(/Nothing in your database or in facetdb.config.ts has changed yet/),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Run the install" })).toBeDisabled();
    expect(installs(api)).toHaveLength(1);
  });
});

describe("leaving while an install runs", () => {
  it("keeps Cancel off, and holds a rail link with a question until the person chooses", async () => {
    const reply = deferred<SetupInstalled>();
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () => reply.promise,
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: "Cancel" })).toBeNull();

    const nav = await screen.findByRole("navigation", { name: "Pages" });
    const sources = within(nav)
      .getAllByRole("link")
      .find((link) => link.getAttribute("href") === "/sources");
    if (sources === undefined) {
      throw new Error("the rail has no link to Sources");
    }
    await studio.user.click(sources);
    const prompt = await screen.findByRole("alertdialog", { name: "An install is running" });
    expect(within(prompt).getByText(/its outcome will not be shown/)).toBeVisible();
    expect(studio.history.location.pathname).toBe("/sources/new");
    await studio.user.click(within(prompt).getByRole("button", { name: "Stay on this page" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(studio.history.location.pathname).toBe("/sources/new");

    await act(async () => {
      reply.settle(SAMPLE_INSTALLED);
      await reply.promise;
    });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Installed on public.sellers" }),
    ).toBeVisible();
    // Done: nothing holds the way out any more.
    await studio.user.click(screen.getByRole("link", { name: "Back to Sources" }));
    await waitFor(() => {
      expect(studio.history.location.pathname).toBe("/sources");
    });
  });

  it("lets the person leave anyway, when they choose to", async () => {
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () => new Promise<SetupInstalled>(() => undefined),
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    const nav = await screen.findByRole("navigation", { name: "Pages" });
    const home = within(nav)
      .getAllByRole("link")
      .find((link) => link.getAttribute("href") === "/");
    if (home === undefined) {
      throw new Error("the rail has no link to Home");
    }
    await studio.user.click(home);
    await studio.user.click(await screen.findByRole("button", { name: "Leave anyway" }));
    await waitFor(() => {
      expect(studio.history.location.pathname).toBe("/");
    });
  });
});

describe("reading again after an install that started", () => {
  it("shows why a read-again failed, under the button, with Try again", async () => {
    let configFails = false;
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () => {
        configFails = true;
        return Promise.reject(new TypeError("Failed to fetch"));
      },
      projectConfig: () =>
        configFails
          ? Promise.reject(
              new ApiError(503, "unreachable", "The worker did not answer.", "Start it."),
            )
          : Promise.resolve(SAMPLE_PROJECT_CONFIG),
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    await studio.user.click(
      await screen.findByRole("button", { name: "I have looked: read again" }),
    );
    expect(await screen.findByText("The worker did not answer.")).toBeVisible();
    expect(screen.getByText(/could not be read again, so nothing above has changed/)).toBeVisible();
    // Still held: no install offered.
    expect(screen.queryByRole("button", { name: "Run the install" })).toBeNull();
    configFails = false;
    await studio.user.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      await screen.findByText(/The SQL is planned afresh from what the database holds now/),
    ).toBeVisible();
  });

  it("offers a read-again where the file names the source, so an uninstall shows without a reload", async () => {
    const named = {
      ...SAMPLE_PROJECT_CONFIG,
      sources: [
        ...SAMPLE_PROJECT_CONFIG.sources,
        { name: "sellers", table: "sellers", read: ["bio"], questions: {}, thresholds: {} },
      ],
    };
    const state = { failed: false, uninstalled: false };
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () => {
        state.failed = true;
        return Promise.reject(new TypeError("Failed to fetch"));
      },
      projectConfig: () =>
        Promise.resolve(state.failed && !state.uninstalled ? named : SAMPLE_PROJECT_CONFIG),
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    await studio.user.click(
      await screen.findByRole("button", { name: "I have looked: read again" }),
    );
    expect(await screen.findByText(/sellers is in facetdb.config.ts/)).toBeVisible();
    state.uninstalled = true;
    await studio.user.click(screen.getByRole("button", { name: "Read again" }));
    expect(await screen.findByText(/facetdb.config.ts does not name sellers/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Show the SQL" })).toBeEnabled();
    expect(installs(api)).toHaveLength(1);
  });
});

describe("a table the file already reads", () => {
  it("shows the worker's words when the plan is refused", async () => {
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupPlan: () =>
        Promise.reject(
          new ApiError(
            409,
            "table-taken",
            'public.sellers is already the table of the source "sellers" in facetdb.config.ts, so it is not set up again under another name',
            "that source is sellers; finish or check its install with facetdb migrate --source sellers, or take it out with facetdb uninstall --source sellers",
          ),
        ),
    });
    const studio = await opened(api);
    await written(studio);
    await studio.user.click(screen.getByRole("button", { name: "Show the SQL" }));
    expect(await screen.findByText(/is already the table of the source "sellers"/)).toBeVisible();
    expect(screen.getByText(/take it out with facetdb uninstall --source sellers/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Run the install" })).toBeDisabled();
  });
});

describe("an install's reply is never dropped", () => {
  it("keeps 'Use another connection string' off while a request is in flight, and shows a success that arrives after the attempt", async () => {
    const reply = deferred<SetupInstalled>();
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () => reply.promise,
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    const startOver = screen.getByRole("button", { name: "Use another connection string" });
    expect(startOver).toBeDisabled();
    await studio.user.click(startOver);
    await act(async () => {
      reply.settle(SAMPLE_INSTALLED);
      await reply.promise;
    });
    expect(
      await screen.findByRole("heading", { level: 2, name: "Installed on public.sellers" }),
    ).toBeVisible();
    expect(screen.queryByRole("textbox", { name: "Connection string" })).toBeNull();
  });

  it("shows a failure that arrives after the attempt, and reads again", async () => {
    let fail: (error: Error) => void = () => undefined;
    const api = fakeApi({
      setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
      setupInstall: () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    });
    const studio = await opened(api);
    await planShown(studio);
    await studio.user.click(screen.getByRole("button", { name: "Run the install" }));
    await studio.user.click(screen.getByRole("button", { name: "Use another connection string" }));
    const readsBefore = api.calls.filter((call) => call === "projectConfig").length;
    await act(async () => {
      fail(new ApiError(409, "install_stopped", "The install stopped at statement 1.", "Run it."));
      await Promise.resolve();
    });
    expect(await screen.findByRole("heading", { name: "The install stopped" })).toBeVisible();
    await waitFor(() => {
      expect(api.calls.filter((call) => call === "projectConfig").length).toBeGreaterThan(
        readsBefore,
      );
    });
    expect(installs(api)).toHaveLength(1);
  });
});

describe("the flow keeps to what is on screen", () => {
  it("starts over only once no request of the connection is in flight, and then drops everything of it", async () => {
    const reply = deferred<Inspection>();
    const api = fakeApi({
      setupInspect: (_admin, table) =>
        table === undefined ? Promise.resolve(SAMPLE_SELLERS) : reply.promise,
    });
    const studio = await opened(api);
    await connected(studio);
    await pick(studio, 1);
    const startOver = screen.getByRole("button", { name: "Use another connection string" });
    expect(startOver).toBeDisabled();
    await act(async () => {
      reply.settle(SAMPLE_SELLERS);
      await reply.promise;
    });
    await screen.findByRole("checkbox", { name: /bio/ });
    expect(startOver).toBeEnabled();
    await studio.user.click(startOver);
    expect(screen.getByRole("textbox", { name: "Connection string" })).toHaveValue("");
    expect(within(step(STEPS[1] ?? "")).getByText(/After step one/)).toBeVisible();
    expect(screen.queryByRole("checkbox", { name: /bio/ })).toBeNull();
  });

  it("hides the plan when a cut line or the variable changes after it was shown", async () => {
    const studio = await opened();
    await planShown(studio);
    act(() => {
      within(step("Set the thresholds")).getByRole("slider", { name: "Yes at or above" }).focus();
    });
    await studio.user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("button", { name: "Run the install" })).toBeDisabled();
    expect(screen.getByText(/The source changed since the SQL was shown/)).toBeVisible();

    await studio.user.click(screen.getByRole("button", { name: "Show the SQL" }));
    await screen.findByText(/alter table "public"."sellers"/);
    const variable = screen.getByRole("textbox", {
      name: "The variable that holds the worker's connection string",
    });
    await studio.user.type(variable, "_2");
    expect(screen.getByRole("button", { name: "Run the install" })).toBeDisabled();
    expect(installs(studio.api)).toHaveLength(0);
  });

  it("names each question's sliders in step four, and marks step four current once the preview answered", async () => {
    const studio = await opened();
    await written(studio);
    await studio.user.click(screen.getByRole("button", { name: "Preview 20 rows" }));
    await screen.findByRole("table", { name: "Live preview of sellers" });
    const group = within(step("Set the thresholds")).getByRole("group", { name: "is_fake" });
    expect(within(group).getByRole("slider", { name: "Yes at or above" })).toBeInTheDocument();
    const current = document.querySelector('[aria-current="step"]');
    expect(current?.textContent).toContain("Set the thresholds");
  });
});

describe("the Sources page", () => {
  it("keeps the rows it last read when the worker cannot be asked again, and says when they are from", async () => {
    let calls = 0;
    const api = fakeApi({
      sources: () => {
        calls += 1;
        return calls === 1
          ? Promise.resolve(SAMPLE_SOURCES)
          : Promise.reject(
              new ApiError(
                503,
                "unreachable",
                "The worker did not answer.",
                "Start facetdb worker.",
              ),
            );
      },
    });
    const studio = renderStudio({ path: "/sources", api });
    await screen.findByRole("article", { name: "listings" });
    // The page's own poll asks again (TanStack's interval); the test asks the same query now.
    await act(async () => {
      await studio.queryClient.refetchQueries({ queryKey: ["sources", "rows"] });
    });
    expect(await screen.findByText(/^Last known /)).toBeVisible();
    expect(screen.getByText("The worker did not answer.")).toBeVisible();
    expect(screen.getByRole("article", { name: "listings" })).toBeVisible();
  });

  it("shows a ruled row per source in the endpoint's words, and a source the worker does not run yet", async () => {
    const api = fakeApi({
      projectConfig: async () => ({
        model: "jev-1.14.0",
        sources: [
          { name: "listings", read: ["title"], questions: {}, thresholds: {} },
          { name: "support_tickets", read: ["body"], questions: {}, thresholds: {} },
          { name: "sellers", read: ["bio"], questions: {}, thresholds: {} },
        ],
        // The worker names every source of the file it does not run, with the reload's own words.
        pending: [
          {
            source: "sellers",
            outcome: "not-started",
            message:
              "new in facetdb.config.ts and not answered yet: its install is not in its database (the columns of is_fake are missing)",
            migrate: true,
            added: [],
            removed: [],
            checkAgain: true,
          },
        ],
        versions: {},
      }),
    });
    renderStudio({ path: "/sources", api });
    const listings = await screen.findByRole("article", { name: "listings" });
    expect(within(listings).getByText("Postgres, trigger")).toBeVisible();
    expect(within(listings).getByText(SAMPLE_SOURCES[0]?.how.words ?? "")).toBeVisible();
    expect(within(listings).getByText(/facetdb_worker reads title and price/)).toBeVisible();
    expect(within(listings).getByRole("img", { name: "Backfill 100% done" })).toBeInTheDocument();
    const api_ = screen.getByRole("article", { name: "support_tickets" });
    expect(within(api_).getByText("None: records arrive one by one.")).toBeVisible();
    const sellers = await screen.findByRole("article", { name: "sellers" });
    expect(within(sellers).getByText("not running yet")).toBeVisible();
    // The reload's own words and steps, the Questions page's block: never a fixed sentence.
    expect(
      within(sellers).getByText(/^New in facetdb\.config\.ts and not answered yet: its install/),
    ).toBeVisible();
    expect(within(sellers).getByText("facetdb migrate --source sellers")).toBeVisible();
    expect(within(sellers).getByRole("button", { name: "Check again" })).toBeEnabled();
    expect(screen.getByRole("link", { name: "Add a source" })).toHaveAttribute(
      "href",
      "/sources/new",
    );
  });
});

describe("the variable the setup suggests", () => {
  it("is the one of a source already reading this database, with why, and stays the person's to change", async () => {
    // Seen in a real run: a second variable holding the first's string left Apply unable to tell
    // which source reads which. The worker names the source and its variable.
    const studio = await opened(
      fakeApi({
        setupPreview: () => Promise.resolve(SELLERS_PREVIEW),
        setupInspect: (_admin, table) =>
          Promise.resolve({
            ...(table === undefined ? SAMPLE_TABLES : SAMPLE_SELLERS),
            sharedWith: { source: "listings", variable: "SHOP_URL" },
          }),
      }),
    );
    await connected(studio);
    await pick(studio, 1);
    const where = step("Choose storage, actions and alerts");
    const variable = within(where).getByRole("textbox", {
      name: "The variable that holds the worker's connection string",
    });
    expect(variable).toHaveValue("SHOP_URL");
    expect(
      within(where).getByText(
        /^listings already reads this database through SHOP_URL, so the same variable is suggested/,
      ),
    ).toBeVisible();
    await studio.user.clear(variable);
    await studio.user.type(variable, "SELLERS_URL");
    expect(variable).toHaveValue("SELLERS_URL");
  });

  it("is the file's first variable where no source reads this database, with nothing said", async () => {
    const studio = await opened();
    await connected(studio);
    await pick(studio, 1);
    const where = step("Choose storage, actions and alerts");
    expect(
      within(where).getByRole("textbox", {
        name: "The variable that holds the worker's connection string",
      }),
    ).toHaveValue("DATABASE_URL");
    expect(within(where).queryByText(/already reads this database/)).toBeNull();
  });
});
