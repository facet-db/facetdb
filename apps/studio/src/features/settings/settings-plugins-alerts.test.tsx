import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Alerts,
  ApiError,
  type Home,
  type ReviewerAccounts,
  SHELL_REFRESH_MS,
  type SpendingConfig,
} from "../../api/index.ts";
import {
  fakeApi,
  renderStudio,
  SAMPLE_ACCESS,
  SAMPLE_ALERTS,
  SAMPLE_HOME,
  SAMPLE_PROJECT,
  SAMPLE_REVIEWERS,
  SAMPLE_SPENDING_APPLIED,
} from "../../testing/index.ts";
import { Unreachable } from "./index.ts";

/**
 * The Plugins, Alerts and Settings pages on happy-dom with the fake API client: the Plugins page's
 * honest empty state, the channels as the config names them and the events in the same shape, the
 * reviewers and the form that adds one (the password's whole life), the spending cap as the worker
 * runs it, studio access in words and the way out, and the Cloud tag on the parts that are Cloud's.
 * Times are built in the machine's zone (the fake's own), and "now" is a local afternoon, so the
 * words of a time do not depend on where a test runs.
 */

/** The afternoon the pages are opened in: Friday 6 November 2026, 3 pm on this machine. */
const NOW = new Date(2026, 10, 6, 15, 0);

afterEach(() => {
  vi.useRealTimers();
});

describe("the Plugins page", () => {
  it("says plainly that nothing is installed and that plugins arrive in a later version", async () => {
    const api = fakeApi();
    renderStudio({ path: "/plugins", api, now: NOW });

    expect(await screen.findByRole("heading", { level: 1, name: "Plugins" })).toBeInTheDocument();
    expect(document.title).toBe("Plugins · FacetDB");
    expect(screen.getByRole("heading", { level: 2, name: "Nothing installed yet" })).toBeVisible();
    expect(
      screen.getByText(
        /Plugins arrive in a later version, and nothing can be installed before then/,
      ),
    ).toBeInTheDocument();
    // It promises no date, and it reads nothing from the worker beyond the rail's own figures.
    expect(document.body.textContent).not.toMatch(/\b20\d\d\b|\bQ[1-4]\b|\bweeks?\b/);
    expect(api.calls.filter((call) => /alerts|reviewers|studioAccess/.test(call))).toEqual([]);
  });

  it("has one action, which says what the gallery will be and when it opens", async () => {
    const { user } = renderStudio({ path: "/plugins", now: NOW });
    const browse = await screen.findByRole("button", { name: "Browse the gallery" });
    expect(screen.getAllByRole("button", { name: "Browse the gallery" })).toHaveLength(1);
    expect(screen.queryByText(/The gallery opens in a later version/)).toBeNull();

    await user.click(browse);

    expect(screen.getByRole("status")).toHaveTextContent(
      "The gallery opens in a later version: the registry's index with search, a verified badge and install counts.",
    );
  });
});

describe("the Alerts page", () => {
  it("names the channels of the config and says they do not deliver yet", async () => {
    const { user } = renderStudio({ path: "/alerts", now: NOW });

    expect(await screen.findByRole("heading", { level: 1, name: "Alerts" })).toBeInTheDocument();
    const slack = within(await screen.findByRole("article", { name: "Slack #ops" }));
    expect(slack.getByText("Not delivering yet")).toBeInTheDocument();
    expect(slack.getByText(/delivery to a channel arrives in a later version/)).toBeInTheDocument();
    expect(
      slack.getByText("Arrive in a later version, with the channel plugins."),
    ).toBeInTheDocument();
    expect(screen.getByRole("article", { name: "Email ops@example.com" })).toBeInTheDocument();

    // The test button is there, operable, and says it arrives in a later version and that nothing
    // was sent.
    await user.click(slack.getByRole("button", { name: "Send a test" }));
    expect(slack.getByRole("status")).toHaveTextContent(
      "Test messages arrive in a later version, with the channel plugins. Nothing was sent.",
    );
  });

  it("lists the events newest first in the same shape, in a table with a full grid", async () => {
    renderStudio({ path: "/alerts", now: NOW });

    const table = await screen.findByRole("table", { name: "Alerts, newest first" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["When", "Event", "Severity", "Where", "What FacetDB did", "State"]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(4);

    const [finished, failing, down, spending] = rows.map((row) => within(row));
    // What happened, where, what FacetDB did, one link; and how it stands.
    expect(finished?.getByText("11:10 am")).toBeInTheDocument();
    expect(finished?.getByText("Backfill finished")).toBeInTheDocument();
    expect(finished?.getByText("information")).toBeInTheDocument();
    expect(finished?.getByText("listings")).toBeInTheDocument();
    expect(finished?.getByText("Every page was settled; the cursor is cleared.")).toBeVisible();
    expect(finished?.getByRole("link", { name: /See details/ })).toHaveAttribute(
      "href",
      "https://docs.facetdb.dev/fix/backfill",
    );
    // Nothing resolves a finished backfill, so the row says it was raised and claims no more.
    expect(finished?.getByText("raised")).toBeInTheDocument();
    expect(finished?.queryByText("not resolved")).toBeNull();

    expect(failing?.getByText("yesterday 11:02 pm")).toBeInTheDocument();
    expect(failing?.getByText("Model failing")).toBeInTheDocument();
    expect(failing?.getByText("critical")).toBeInTheDocument();
    expect(failing?.getByText("support_messages")).toBeInTheDocument();
    expect(failing?.getByText(/^6 of 100 model calls failed/)).toBeInTheDocument();
    expect(failing?.getByText(/^Retrying with backoff/)).toBeInTheDocument();
    expect(failing?.getByText("resolved yesterday 11:09 pm")).toBeInTheDocument();

    expect(down?.getByText("Nov 2, 8:15 am")).toBeInTheDocument();
    expect(down?.getByText("all sources")).toBeInTheDocument();
    // Worker not running is raised once by another worker and nothing resolves it.
    expect(down?.getByText("raised")).toBeInTheDocument();
    expect(down?.queryByText("not resolved")).toBeNull();

    // A spending warning has no resolve path in the worker, so it is never "not resolved" for ever;
    // a link to a page of this studio is followed.
    expect(spending?.getByText("warning")).toBeInTheDocument();
    expect(spending?.getByText("raised")).toBeInTheDocument();
    expect(spending?.queryByText("not resolved")).toBeNull();
    expect(spending?.getByRole("link", { name: /See details/ })).toHaveAttribute(
      "href",
      "/settings",
    );

    expect(
      screen.getByText(
        "One alert per event every 30 minutes until it resolves, then a resolved message.",
      ),
    ).toBeInTheDocument();
  });

  it("states a status as a word and never by color alone", async () => {
    renderStudio({ path: "/alerts", now: NOW });
    const table = await screen.findByRole("table", { name: "Alerts, newest first" });
    for (const status of within(table).getAllByText(/^(critical|warning|information|resolved)/)) {
      expect(status.closest("[data-status]")).not.toBeNull();
      expect(status.textContent).not.toBe("");
    }
  });

  it("follows a link only when it is an http(s) address or a path of this studio", async () => {
    const hostile: Alerts = {
      ...SAMPLE_ALERTS,
      events: SAMPLE_ALERTS.events.slice(0, 3).map((event, index) => ({
        ...event,
        link: ["javascript:alert(1)", "data:text/html,x", "http://docs.example/fix"][index] ?? "",
      })),
    };
    renderStudio({ path: "/alerts", api: fakeApi({ alerts: () => Promise.resolve(hostile) }) });

    const table = await screen.findByRole("table", { name: "Alerts, newest first" });
    const links = within(table).getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["http://docs.example/fix"]);
  });

  it("has an honest empty state for each of an empty config and an empty history", async () => {
    const empty: Alerts = {
      channels: [],
      fileChannelsDiffer: false,
      events: [],
      limit: 100,
      capped: false,
    };
    renderStudio({ path: "/alerts", api: fakeApi({ alerts: () => Promise.resolve(empty) }) });

    expect(await screen.findByRole("heading", { name: "No channel is named" })).toBeVisible();
    expect(screen.getByText(/add it to alerts.channels in facetdb.config.ts/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "No alerts yet" })).toBeVisible();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("shows a channel whose name the worker withheld by its kind alone", async () => {
    const withheld: Alerts = {
      ...SAMPLE_ALERTS,
      channels: [
        {
          kind: "webhook",
          name: null,
          address: null,
          sends: "everything",
          quiet: null,
          bound: true,
          delivering: null,
          last: null,
        },
      ],
    };
    renderStudio({ path: "/alerts", api: fakeApi({ alerts: () => Promise.resolve(withheld) }) });
    expect(await screen.findByRole("article", { name: "Webhook" })).toBeInTheDocument();
  });

  it("tells an alert still being delivered from one no channel took", async () => {
    const [first, second] = SAMPLE_ALERTS.events;
    if (first === undefined || second === undefined) {
      throw new Error("the sample has two events");
    }
    const lines: Alerts = {
      ...SAMPLE_ALERTS,
      events: [
        { ...first, delivered: false, pending: true },
        { ...second, delivered: false, pending: false },
      ],
    };
    renderStudio({ path: "/alerts", api: fakeApi({ alerts: () => Promise.resolve(lines) }) });
    expect(await screen.findByText("not yet known whether a channel took it")).toBeInTheDocument();
    expect(screen.getAllByText("no channel took it")).toHaveLength(1);
  });

  it("says an alert the worker does resolve is not resolved while it is open", async () => {
    const [first, second] = SAMPLE_ALERTS.events;
    const open: Alerts = {
      ...SAMPLE_ALERTS,
      events: [second, first].flatMap((event, index) =>
        event === undefined
          ? []
          : [index === 0 ? { ...event, standing: { phase: "open" as const } } : event],
      ),
    };
    renderStudio({
      path: "/alerts",
      api: fakeApi({ alerts: () => Promise.resolve(open) }),
      now: NOW,
    });
    const table = await screen.findByRole("table", { name: "Alerts, newest first" });
    expect(within(table).getAllByText("not resolved")).toHaveLength(1);
    expect(within(table).getByText("Model failing")).toBeInTheDocument();
  });

  it("says a resolved message whose alert was raised before the history shown was", async () => {
    const [, second] = SAMPLE_ALERTS.events;
    if (second === undefined) {
      throw new Error("the sample has a second event");
    }
    const orphan: Alerts = {
      ...SAMPLE_ALERTS,
      events: [{ ...second, raisedBeforeHistory: true }],
    };
    renderStudio({
      path: "/alerts",
      api: fakeApi({ alerts: () => Promise.resolve(orphan) }),
      now: NOW,
    });
    const table = await screen.findByRole("table", { name: "Alerts, newest first" });
    expect(within(table).getByText("raised before the history shown")).toBeInTheDocument();
    expect(within(table).getByText("resolved yesterday 11:09 pm")).toBeInTheDocument();
  });

  it("says when the file names other channels than the worker runs with, and which it lists", async () => {
    const differ: Alerts = { ...SAMPLE_ALERTS, fileChannelsDiffer: true };
    renderStudio({ path: "/alerts", api: fakeApi({ alerts: () => Promise.resolve(differ) }) });

    const note = await screen.findByText(/^facetdb\.config\.ts names other channels/);
    expect(note).toHaveTextContent(
      "facetdb.config.ts names other channels than the ones listed, which are the ones the worker runs with. Restart the worker to apply the file's.",
    );
    // The channels listed are still the worker's.
    expect(screen.getByRole("article", { name: "Slack #ops" })).toBeInTheDocument();
  });

  it("says nothing of the file when it names the channels the worker runs with", async () => {
    renderStudio({ path: "/alerts", now: NOW });
    await screen.findByRole("article", { name: "Slack #ops" });
    expect(screen.queryByText(/names other channels/)).toBeNull();
  });

  it("says when the history is cut at its newest lines, and that two alerts are Cloud's", async () => {
    const cut: Alerts = { ...SAMPLE_ALERTS, capped: true, limit: 100 };
    renderStudio({ path: "/alerts", api: fakeApi({ alerts: () => Promise.resolve(cut) }) });

    expect(
      await screen.findByText(/The newest 100 lines of the history are read; older events/),
    ).toBeInTheDocument();
    const cloud = screen.getByText(/review-queue and answer-drift alerts are FacetDB Cloud's/);
    expect(cloud.parentElement).toContainElement(screen.getByText("Cloud"));
    expect(screen.getByText("Cloud")).toHaveAttribute("data-tone", "cloud");
  });

  it("says the worker could not be reached, and when the list was last known, when a refresh fails", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let failing = false;
    const api = fakeApi({
      alerts: () =>
        failing
          ? Promise.reject(
              new ApiError(503, "unavailable", "The store did not answer.", "Start the database."),
            )
          : Promise.resolve(SAMPLE_ALERTS),
    });
    renderStudio({ path: "/alerts", api, now: NOW });
    await screen.findByRole("table", { name: "Alerts, newest first" });
    expect(screen.queryByRole("alert")).toBeNull();

    failing = true;
    await vi.advanceTimersByTimeAsync(SHELL_REFRESH_MS);
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("The worker refused the last refresh. Last known");
    expect(notice).toHaveTextContent("The store did not answer. Start the database.");
    // The rows stay, marked as the last known rather than shown as current.
    expect(screen.getByRole("table", { name: "Alerts, newest first" })).toBeInTheDocument();
  });

  it("says a first read that fails could not be read, with the worker's words and the way to ask again", async () => {
    let attempts = 0;
    const api = fakeApi({
      alerts: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(
              new ApiError(500, "internal_error", "Something went wrong.", "Try again."),
            )
          : Promise.resolve(SAMPLE_ALERTS);
      },
    });
    const { user } = renderStudio({ path: "/alerts", api, now: NOW });

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("The alerts could not be read.");
    expect(notice).toHaveTextContent("Something went wrong. Try again.");
    await user.click(within(notice).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("table", { name: "Alerts, newest first" })).toBeVisible();
  });
});

describe("the Settings page", () => {
  it("lists the reviewers: this computer's user, and the accounts", async () => {
    renderStudio({ path: "/settings", now: NOW });

    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
    const reviewers = within(await screen.findByRole("list", { name: "Reviewers" }));
    const items = reviewers.getAllByRole("listitem");
    expect(items.map((item) => item.textContent)).toEqual([
      "alex, you, from this computerdecides as os:alex",
      "sam, accountadded Nov 3, 10:00 am",
      "maya, account" + "added Nov 4, 9:30 am",
    ]);
  });

  it("marks the signed-in account as you", async () => {
    const api = fakeApi({
      project: () => Promise.resolve({ ...SAMPLE_PROJECT, reviewer: "sam" }),
    });
    renderStudio({ path: "/settings", api, now: NOW });

    const reviewers = within(await screen.findByRole("list", { name: "Reviewers" }));
    await waitFor(() => {
      expect(reviewers.getAllByRole("listitem")[0]).toHaveTextContent(
        "sam, account, youdecides as sam",
      );
    });
    expect(reviewers.queryByText(/from this computer/)).toBeNull();
  });

  it("says no account exists yet in the CLI's words", async () => {
    renderStudio({
      path: "/settings",
      api: fakeApi({ reviewers: () => Promise.resolve([]) }),
      now: NOW,
    });
    expect(
      await screen.findByText(
        "No reviewer accounts yet, so only this computer can open the studio.",
      ),
    ).toBeInTheDocument();
  });

  describe("adding a reviewer", () => {
    /** The form as a person fills it. */
    async function fill(
      user: ReturnType<typeof renderStudio>["user"],
      values: { name?: string; password?: string; again?: string },
    ) {
      if (values.name !== undefined) {
        await user.type(await screen.findByLabelText("Name"), values.name);
      }
      if (values.password !== undefined) {
        await user.type(screen.getByLabelText("Password"), values.password);
      }
      if (values.again !== undefined) {
        await user.type(screen.getByLabelText("Password again"), values.again);
      }
    }

    it("sends the name and the password once, empties the boxes, and refreshes the list", async () => {
      const sent: { name: string; password: string }[] = [];
      let accounts: ReviewerAccounts = SAMPLE_REVIEWERS;
      const api = fakeApi({
        reviewers: () => Promise.resolve(accounts),
        addReviewer: (name, password) => {
          sent.push({ name, password });
          accounts = [
            ...accounts,
            { name, createdAt: new Date(2026, 10, 6, 14, 55).toISOString() },
          ];
          return Promise.resolve();
        },
      });
      const { user, history } = renderStudio({ path: "/settings", api, now: NOW });
      await fill(user, { name: "lee", password: "correct horse", again: "correct horse" });

      await user.click(screen.getByRole("button", { name: "Add a reviewer" }));

      await screen.findByText(
        'Added the reviewer account "lee". Reviewers sign in with this name and password when the studio is opened on any address but this machine\'s.',
      );
      expect(sent).toEqual([{ name: "lee", password: "correct horse" }]);
      expect(screen.getByLabelText("Password")).toHaveValue("");
      expect(screen.getByLabelText("Password again")).toHaveValue("");
      expect(screen.getByLabelText("Name")).toHaveValue("");
      // The list was read again and shows the new account; the count in studio access too.
      await waitFor(() => {
        const items = within(screen.getByRole("list", { name: "Reviewers" })).getAllByRole(
          "listitem",
        );
        expect(items.at(-1)).toHaveTextContent(/^lee, accountadded 2:55 pm$/);
      });
      expect(api.calls.filter((call) => call === "reviewers").length).toBeGreaterThanOrEqual(2);
      expect(api.calls.filter((call) => call === "studioAccess").length).toBeGreaterThanOrEqual(2);
      // The password is in no address, no call note and nowhere on the page.
      expect(history.location.href).not.toContain("correct");
      expect(api.calls.join("\n")).not.toContain("correct");
      expect(document.body.textContent).not.toContain("correct horse");
    });

    it("makes its password boxes new-password boxes with labels, and reaches them by keyboard", async () => {
      const { user } = renderStudio({ path: "/settings", now: NOW });
      const name = await screen.findByLabelText("Name");
      const password = screen.getByLabelText("Password");
      const again = screen.getByLabelText("Password again");
      expect(password).toHaveAttribute("type", "password");
      expect(password).toHaveAttribute("autocomplete", "new-password");
      expect(again).toHaveAttribute("type", "password");
      expect(again).toHaveAttribute("autocomplete", "new-password");

      await user.click(name);
      await user.tab();
      expect(password).toHaveFocus();
      await user.tab();
      expect(again).toHaveFocus();
      await user.tab();
      expect(screen.getByRole("button", { name: "Add a reviewer" })).toHaveFocus();
    });

    it("sends nothing when the two passwords differ, and says so at the box", async () => {
      const api = fakeApi();
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      await fill(user, { name: "lee", password: "correct horse", again: "correct hors" });

      await user.click(screen.getByRole("button", { name: "Add a reviewer" }));

      const again = screen.getByLabelText("Password again");
      expect(again).toHaveAttribute("aria-invalid", "true");
      const problem = document.getElementById(again.getAttribute("aria-describedby") ?? "");
      expect(problem).toHaveTextContent("The two passwords are not the same, so nothing was sent.");
      expect(problem).toHaveAttribute("role", "alert");
      expect(api.calls.some((call) => call.startsWith("addReviewer"))).toBe(false);
    });

    it("asks for a name and for a password before sending anything", async () => {
      const api = fakeApi();
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      const add = await screen.findByRole("button", { name: "Add a reviewer" });

      await user.click(add);
      expect(screen.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
      expect(screen.getAllByRole("alert")).toHaveLength(1);

      await user.type(screen.getByLabelText("Name"), "lee");
      await user.click(add);
      expect(screen.getByLabelText("Password")).toHaveAttribute("aria-invalid", "true");
      expect(api.calls.some((call) => call.startsWith("addReviewer"))).toBe(false);
    });

    it("shows the endpoint's refusal of a short password at the password box and keeps the name", async () => {
      const api = fakeApi({
        addReviewer: () =>
          Promise.reject(
            new ApiError(
              400,
              "weak-password",
              "The password is shorter than 8 characters; nothing was changed.",
              "Choose a password of at least 8 characters, and send it again.",
            ),
          ),
      });
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      await fill(user, { name: "lee", password: "short", again: "short" });

      await user.click(screen.getByRole("button", { name: "Add a reviewer" }));

      const password = screen.getByLabelText("Password");
      await waitFor(() => {
        expect(password).toHaveAttribute("aria-invalid", "true");
      });
      expect(password).toHaveAccessibleDescription(
        expect.stringContaining("The password is shorter than 8 characters"),
      );
      expect(password).toHaveAccessibleDescription(
        expect.stringContaining("Choose a password of at least 8 characters"),
      );
      // One alert, and the password is not kept for a retry: it is typed again.
      expect(screen.getAllByRole("alert")).toHaveLength(1);
      expect(password).toHaveValue("");
      expect(screen.getByLabelText("Password again")).toHaveValue("");
      expect(screen.getByLabelText("Name")).toHaveValue("lee");
    });

    it("shows a name already taken at the name box with the endpoint's fix", async () => {
      const api = fakeApi({
        addReviewer: () =>
          Promise.reject(
            new ApiError(
              409,
              "user-exists",
              'A reviewer account named "sam" already exists; nothing was changed.',
              "Choose another name, or to change its password run facetdb users remove sam and then facetdb users add sam.",
            ),
          ),
      });
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      await fill(user, { name: "sam", password: "correct horse", again: "correct horse" });

      await user.click(screen.getByRole("button", { name: "Add a reviewer" }));

      const name = screen.getByLabelText("Name");
      await waitFor(() => {
        expect(name).toHaveAttribute("aria-invalid", "true");
      });
      expect(name).toHaveAccessibleDescription(
        expect.stringContaining("facetdb users remove sam and then facetdb users add sam"),
      );
    });

    it("shows a store that cannot be written with its words and the fix, which is facetdb users add", async () => {
      const api = fakeApi({
        addReviewer: () =>
          Promise.reject(
            new ApiError(
              403,
              "users-not-writable",
              "The login in DATABASE_URL may read the reviewer accounts but not change them, which is how the worker login is made; nothing was changed.",
              "Make the account from a terminal with DATABASE_URL set to the store's owner login, for example DATABASE_URL=<that url> facetdb users add <name>.",
            ),
          ),
      });
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      await fill(user, { name: "lee", password: "correct horse", again: "correct horse" });

      await user.click(screen.getByRole("button", { name: "Add a reviewer" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("may read the reviewer accounts but not change them");
      expect(alert).toHaveTextContent("facetdb users add <name>");
      expect(screen.getByLabelText("Name")).not.toHaveAttribute("aria-invalid");
    });

    it("says the worker could not be reached when the request never arrived, and keeps no password", async () => {
      const api = fakeApi({ addReviewer: () => Promise.reject(new Error("fetch failed")) });
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      await fill(user, { name: "lee", password: "correct horse", again: "correct horse" });

      await user.click(screen.getByRole("button", { name: "Add a reviewer" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "The studio could not reach the worker, so no account was made.",
      );
      expect(screen.getByLabelText("Password")).toHaveValue("");
      expect(document.body.textContent).not.toContain("correct horse");
    });

    it("sends once under StrictMode and disables the button while the request is out", async () => {
      let release: () => void = () => undefined;
      const api = fakeApi({
        addReviewer: () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      });
      const { user } = renderStudio({ path: "/settings", api, now: NOW, strict: true });
      await fill(user, { name: "lee", password: "correct horse", again: "correct horse" });

      await user.click(screen.getByRole("button", { name: "Add a reviewer" }));

      expect(await screen.findByRole("button", { name: "Adding" })).toBeDisabled();
      release();
      await screen.findByText(/^Added the reviewer account "lee"/);
      expect(api.calls.filter((call) => call.startsWith("addReviewer"))).toEqual([
        "addReviewer lee",
      ]);
    });

    it("shows the terminal command with the name filled in, and no form, when this login cannot make accounts", async () => {
      // The default install: the worker's login may read facetdb.users and not write it, which GET
      // /v1/studio says before anything is typed.
      const api = fakeApi({
        studioAccess: () => Promise.resolve({ ...SAMPLE_ACCESS, accountsWritable: false }),
      });
      const { user, copied } = renderStudio({ path: "/settings", api, now: NOW });

      const section = within(await screen.findByRole("region", { name: "Reviewers" }));
      expect(
        await section.findByText(/Reviewer accounts are made from a terminal\./),
      ).toBeInTheDocument();
      expect(section.getByText("Local accounts, made with facetdb users add.")).toBeInTheDocument();
      // No password boxes and no Add: nothing that can only refuse.
      expect(section.queryByLabelText("Password")).toBeNull();
      expect(section.queryByRole("button", { name: "Add a reviewer" })).toBeNull();
      // The command follows the name as it is typed, and copies.
      expect(section.getByText("DATABASE_URL=<owner-url> facetdb users add <name>")).toBeVisible();
      await user.type(section.getByLabelText("Name"), "maya");
      const command = "DATABASE_URL=<owner-url> facetdb users add maya";
      expect(section.getByText(command)).toBeVisible();
      await user.click(section.getByRole("button", { name: `Copy ${command}` }));
      expect(copied).toEqual([command]);
      expect(await section.findByText("Copied. Paste it into the terminal.")).toBeVisible();
      expect(api.calls.some((call) => call.startsWith("addReviewer"))).toBe(false);
      // A name the CLI would refuse is refused at the box, and never spliced into the command.
      await user.type(section.getByLabelText("Name"), " smith");
      expect(section.getByText("DATABASE_URL=<owner-url> facetdb users add <name>")).toBeVisible();
      expect(section.getByLabelText("Name")).toHaveAttribute("aria-invalid", "true");
      expect(section.getByText('"maya smith" is not a name an account can have.')).toBeVisible();
    });

    it("shows the terminal route, never the form, when how accounts are made could not be read", async () => {
      // A refusal in the worker's words is not retried, so the read settles as failed at once.
      const api = fakeApi({
        studioAccess: () =>
          Promise.reject(
            new ApiError(500, "internal_error", "Something went wrong.", "Try again."),
          ),
      });
      renderStudio({ path: "/settings", api, now: NOW });
      const section = within(await screen.findByRole("region", { name: "Reviewers" }));
      expect(
        await section.findByText(/Reviewer accounts are made from a terminal\./),
      ).toBeInTheDocument();
      expect(section.queryByLabelText("Password")).toBeNull();
    });
  });

  it("says the list was last known when a refresh after an account was made fails", async () => {
    let reads = 0;
    const api = fakeApi({
      reviewers: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve(SAMPLE_REVIEWERS)
          : Promise.reject(
              new ApiError(503, "unavailable", "The store did not answer.", "Start the database."),
            );
      },
    });
    const { user } = renderStudio({ path: "/settings", api, now: NOW });
    await user.type(await screen.findByLabelText("Name"), "lee");
    await user.type(screen.getByLabelText("Password"), "correct horse");
    await user.type(screen.getByLabelText("Password again"), "correct horse");

    await user.click(screen.getByRole("button", { name: "Add a reviewer" }));

    const section = within(await screen.findByRole("region", { name: "Reviewers" }));
    const notice = await section.findByText(/^The worker refused the last refresh\. Last known/);
    expect(notice).toBeInTheDocument();
    expect(section.getByText("The store did not answer. Start the database.")).toBeInTheDocument();
    // The accounts already read stay on the page, and the notice is the one alert there.
    expect(section.getAllByRole("listitem")).toHaveLength(3);
    expect(section.getAllByRole("alert")).toHaveLength(1);
  });

  it("says a worker that cannot be reached at all could not be reached, with the last good time", () => {
    render(
      <Unreachable
        what="The reviewer accounts"
        error={new Error("fetch failed")}
        lastKnownAt={new Date(2026, 10, 6, 14, 31).getTime()}
        now={NOW}
        retry={() => undefined}
      />,
    );
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("The worker could not be reached. Last known 2:31 pm.");
    expect(notice).toHaveTextContent("The studio cannot reach the worker.");
    expect(within(notice).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });

  describe("the spending cap", () => {
    /** The figures the worker enforces, apart from the form that offers the same choices. */
    const inForce = async () =>
      within(
        await screen.findByRole("region", {
          name: "The cap the worker enforces",
        }),
      );

    it("shows the cap, what happens at 100% and the month's spending as the worker enforces them", async () => {
      const api = fakeApi();
      renderStudio({ path: "/settings", api, now: NOW });

      const cap = await inForce();
      expect(await cap.findByText("25M")).toBeInTheDocument();
      expect(
        cap.getByText(/billable input tokens \(25,000,000\), \$25 at the model.s price/),
      ).toBeInTheDocument();
      expect(cap.getByText("Pause the project; records wait as pending")).toBeInTheDocument();
      expect(cap.getByText("3.2M of 25M")).toBeInTheDocument();
      expect(
        cap.getByRole("img", {
          name: "Input tokens this month: 13% of the monthly cap, about $3.20 of $25. The project pauses at 100%.",
        }),
      ).toBeInTheDocument();
      // The form starts from the file, which sets the same cap.
      const section = within(screen.getByRole("region", { name: "Spending cap" }));
      expect(
        await section.findByRole("textbox", { name: "Monthly cap, in billable input tokens" }),
      ).toHaveValue("25M");
      expect(
        section.getByRole("radio", { name: "Pause the project; records wait as pending" }),
      ).toBeChecked();
      expect(section.getByRole("checkbox", { name: "No monthly cap" })).not.toBeChecked();
      expect(section.getByText(/the worker enforces the new cap at once/)).toHaveTextContent(
        "facetdb.config.ts",
      );
    });

    it("Save opens the diff and nothing is written before confirm; the write puts the cap in force, and the figures show it", async () => {
      // The file as the worker reads it: the sample until the write, then what was written; the
      // worker takes the written cap up in the write's reload, so Home's cap follows the file.
      let file: SpendingConfig = { tokens: 25_000_000, onCapReached: "pause" };
      const api = fakeApi({
        spendingConfig: () => Promise.resolve(file),
        home: () =>
          Promise.resolve({
            ...SAMPLE_HOME,
            spending: {
              ...SAMPLE_HOME.spending,
              cap:
                file.tokens === null
                  ? null
                  : {
                      inputTokens: file.tokens,
                      dollars: (file.tokens * 0.042) / 1_000_000,
                      onCapReached: file.onCapReached,
                    },
            },
          }),
        applySpendingWrite: () => {
          file = { tokens: 40_000_000, onCapReached: "continue" };
          return Promise.resolve(SAMPLE_SPENDING_APPLIED);
        },
      });
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      const section = within(await screen.findByRole("region", { name: "Spending cap" }));
      const box = await section.findByRole("textbox", {
        name: "Monthly cap, in billable input tokens",
      });

      await user.clear(box);
      await user.type(box, "40,000,000");
      await user.click(
        section.getByRole("radio", {
          name: "Keep answering past the cap; the warning at 80% still goes out",
        }),
      );
      await user.click(section.getByRole("button", { name: "Save" }));

      const dialog = within(await screen.findByRole("dialog", { name: "Save the spending cap" }));
      expect(
        await dialog.findByRole("region", { name: "Changes to facetdb.config.ts" }),
      ).toHaveTextContent('+ spendingCap: 40000000,+ onCapReached: "continue",');
      expect(
        dialog.getByText("The worker uses this cap as soon as it is applied."),
      ).toBeInTheDocument();
      expect(api.calls).toContain(
        'applySpendingDiff {"spendingCap":40000000,"onCapReached":"continue"}',
      );
      // Shown, not written.
      expect(api.calls.some((call) => call.startsWith("applySpendingWrite"))).toBe(false);
      expect(api.calls.some((call) => call.startsWith("applyDiff"))).toBe(false);

      await user.click(dialog.getByRole("button", { name: "Apply" }));

      expect(
        await dialog.findByText("Applied. The worker uses the new cap now."),
      ).toBeInTheDocument();
      expect(api.calls).toContain(
        'applySpendingWrite {"plan":"plan-spending","force":false,"draft":{"spendingCap":40000000,"onCapReached":"continue"}}',
      );
      // No restart note: the reload took the cap up.
      expect(dialog.queryByText(/restart/)).toBeNull();
      // One write per plan: the button is gone once written.
      expect(dialog.queryByRole("button", { name: "Apply" })).toBeNull();

      // The file and the cap in force are read again, and agree: the figures show the new cap,
      // and nothing says the file sets another.
      await user.click(dialog.getByRole("button", { name: "Close" }));
      expect(await (await inForce()).findByText("40M")).toBeInTheDocument();
      expect(
        (await inForce()).getByText(
          "Keep answering past the cap; the warning at 80% still goes out",
        ),
      ).toBeInTheDocument();
      expect(section.queryByText(/facetdb\.config\.ts sets a monthly cap/)).toBeNull();
      expect(api.calls.filter((call) => call.startsWith("applySpendingWrite"))).toHaveLength(1);
    });

    it("says before the write when this month's usage is already past the cap saved", async () => {
      // 3,200,000 spent this month (the sample); a cap of 3,000,000 pauses the project on landing.
      const { user } = renderStudio({ path: "/settings", api: fakeApi(), now: NOW });
      const section = within(await screen.findByRole("region", { name: "Spending cap" }));
      const box = await section.findByRole("textbox", {
        name: "Monthly cap, in billable input tokens",
      });
      await user.clear(box);
      await user.type(box, "3M");
      await user.click(section.getByRole("button", { name: "Save" }));
      const dialog = within(await screen.findByRole("dialog", { name: "Save the spending cap" }));
      expect(
        await dialog.findByText(
          "The worker uses this cap as soon as it is applied. This month's usage is already past this cap, so the project pauses as soon as it is applied, until the month resets or the cap is raised.",
        ),
      ).toBeInTheDocument();
    });

    it("saves no cap as null, and refuses a cap that is not a whole number before asking the worker", async () => {
      const api = fakeApi();
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      const section = within(await screen.findByRole("region", { name: "Spending cap" }));
      const box = await section.findByRole("textbox", {
        name: "Monthly cap, in billable input tokens",
      });

      await user.clear(box);
      await user.type(box, "lots");
      await user.click(section.getByRole("button", { name: "Save" }));
      expect(await section.findByRole("alert")).toHaveTextContent(
        "The cap is a whole number of billable input tokens.",
      );
      expect(box).toHaveAttribute("aria-invalid", "true");
      expect(screen.queryByRole("dialog")).toBeNull();

      await user.click(section.getByRole("checkbox", { name: "No monthly cap" }));
      expect(box).toBeDisabled();
      await user.click(section.getByRole("button", { name: "Save" }));
      await screen.findByRole("dialog", { name: "Save the spending cap" });
      expect(api.calls).toContain('applySpendingDiff {"spendingCap":null,"onCapReached":"pause"}');
      expect(api.calls.some((call) => call.startsWith("applySpendingWrite"))).toBe(false);
    });

    /**
     * Home with the cap the worker started with (null for none), and the file as it reads now:
     * the same unless `file` says otherwise.
     */
    function homeWithCap(cap: NonNullable<Home["spending"]["cap"]> | null, file?: SpendingConfig) {
      return fakeApi({
        home: () =>
          Promise.resolve({
            ...SAMPLE_HOME,
            spending: {
              ...SAMPLE_HOME.spending,
              cap,
              ...(cap === null
                ? {
                    status: "uncapped" as const,
                    fraction: null,
                    words: {
                      figure: "$3.20",
                      sub: "No monthly cap is set, so the project never pauses.",
                    },
                  }
                : {}),
            },
          }),
        spendingConfig: () =>
          Promise.resolve(
            file ?? {
              tokens: cap?.inputTokens ?? null,
              onCapReached: cap?.onCapReached ?? "pause",
            },
          ),
      });
    }

    it("words the choice to keep going, and a project with no cap, as the worker runs them", async () => {
      const { unmount } = renderStudio({
        path: "/settings",
        api: homeWithCap({ inputTokens: 25_000_000, dollars: 25, onCapReached: "continue" }),
        now: NOW,
      });
      expect(
        (await inForce()).getByText(
          "Keep answering past the cap; the warning at 80% still goes out",
        ),
      ).toBeInTheDocument();
      unmount();

      renderStudio({ path: "/settings", api: homeWithCap(null), now: NOW });
      const none = await inForce();
      expect(await none.findByText("None set, so the project never pauses.")).toBeInTheDocument();
      expect(none.queryByText("At 100%")).toBeNull();
      // The form says the file has no cap either.
      expect(await screen.findByRole("checkbox", { name: "No monthly cap" })).toBeChecked();
    });

    it("says nothing of the file when it sets the cap the worker enforces", async () => {
      renderStudio({ path: "/settings", now: NOW });
      const cap = within(await screen.findByRole("region", { name: "Spending cap" }));
      await cap.findByText("25M");
      expect(cap.queryByText(/the worker still enforces the cap above/)).toBeNull();
      expect(cap.queryByRole("status")).toBeNull();
    });

    it("shows the cap the worker enforces, says when the file sets another it has not taken up, and applies it on a click", async () => {
      // The operator lowered spendingCap in the file by hand since the last reload: the file reads
      // 1,000,000 now, the worker still spends up to the 5,000,000 it took up last.
      const api = homeWithCap(
        { inputTokens: 5_000_000, dollars: 5, onCapReached: "pause" },
        { tokens: 1_000_000, onCapReached: "continue" },
      );
      const { user } = renderStudio({ path: "/settings", api, now: NOW });

      const cap = within(await screen.findByRole("region", { name: "Spending cap" }));
      const enforced = await inForce();
      expect(await enforced.findByText("5M")).toBeInTheDocument();
      // The cap and the choice in force, not the file's.
      expect(
        enforced.getByText(/billable input tokens \(5,000,000\), \$5 at the model.s price/),
      ).toBeInTheDocument();
      expect(enforced.getByText("Pause the project; records wait as pending")).toBeInTheDocument();
      expect(
        enforced.queryByText("Keep answering past the cap; the warning at 80% still goes out"),
      ).toBeNull();
      // The form edits the file, so it starts from the file's.
      expect(
        await cap.findByRole("textbox", { name: "Monthly cap, in billable input tokens" }),
      ).toHaveValue("1M");
      // The file's, in words, with the reload that applies it.
      expect(cap.getByRole("status")).toHaveTextContent(
        "facetdb.config.ts sets a monthly cap of 1M billable input tokens (1,000,000), and the project keeps answering past 100%; the worker still enforces the cap above.",
      );
      await user.click(cap.getByRole("button", { name: "Apply the file's cap" }));
      expect(
        await cap.findByText("Applied: the worker enforces the file's cap now."),
      ).toBeInTheDocument();
      expect(api.calls).toContain("reload");
    });

    it("says the file sets no cap, or sets one where the worker has none", async () => {
      const none = homeWithCap(
        { inputTokens: 5_000_000, dollars: 5, onCapReached: "pause" },
        { tokens: null, onCapReached: "pause" },
      );
      const { unmount } = renderStudio({ path: "/settings", api: none, now: NOW });
      expect(
        await screen.findByText(
          /^facetdb\.config\.ts sets no monthly cap; the worker still enforces the cap above\./,
        ),
      ).toBeInTheDocument();
      unmount();

      const added = homeWithCap(null, { tokens: 2_000_000, onCapReached: "pause" });
      renderStudio({ path: "/settings", api: added, now: NOW });
      expect(
        await screen.findByText(
          /^facetdb\.config\.ts sets a monthly cap of 2M billable input tokens \(2,000,000\), and the project pauses at 100%; the worker still enforces the cap above\./,
        ),
      ).toBeInTheDocument();
    });

    it("says it could not read the cap, with the worker's words, rather than show a blank", async () => {
      const api = fakeApi({
        home: () =>
          Promise.reject(
            new ApiError(500, "internal_error", "Something went wrong.", "Try again."),
          ),
      });
      renderStudio({ path: "/settings", api, now: NOW });
      const cap = within(await screen.findByRole("region", { name: "Spending cap" }));
      const notice = await cap.findByRole("alert");
      expect(notice).toHaveTextContent("The spending cap could not be read.");
      expect(notice).toHaveTextContent("Something went wrong. Try again.");
    });

    it("keeps the cap in force on the page when only the file's cap could not be read", async () => {
      const api = fakeApi({
        spendingConfig: () =>
          Promise.reject(
            new ApiError(500, "internal_error", "Something went wrong.", "Try again."),
          ),
      });
      renderStudio({ path: "/settings", api, now: NOW });
      const cap = within(await screen.findByRole("region", { name: "Spending cap" }));
      expect(await cap.findByRole("alert")).toHaveTextContent(
        "The cap in facetdb.config.ts could not be read.",
      );
      expect(cap.getByText("25M")).toBeInTheDocument();
    });
  });

  describe("studio access", () => {
    it("says in words that the studio is this computer only, with no login", async () => {
      renderStudio({ path: "/settings", now: NOW });

      const access = within(await screen.findByRole("region", { name: "Studio access" }));
      expect(await access.findByText("Loopback only")).toBeInTheDocument();
      expect(access.getByText("127.0.0.1:4040")).toBeInTheDocument();
      expect(access.getByText(/this computer only, no login/)).toBeInTheDocument();
      expect(access.getByText(/--host 0\.0\.0\.0/)).toBeInTheDocument();
      expect(access.getByText(/There are 2 reviewer accounts now/)).toBeInTheDocument();
    });

    it("says there is nothing to sign out of on this computer, with no dead button", async () => {
      renderStudio({ path: "/settings", now: NOW });
      const access = within(await screen.findByRole("region", { name: "Studio access" }));
      expect(await access.findByText(/so there is nothing to sign out of/)).toBeInTheDocument();
      expect(access.queryByRole("button", { name: "Sign out" })).toBeNull();
    });

    it("says a studio open to the network asks other computers to sign in", async () => {
      const api = fakeApi({
        studioAccess: () =>
          Promise.resolve({
            host: "0.0.0.0",
            loopback: false,
            reviewers: 1,
            accountsWritable: true,
          }),
      });
      renderStudio({ path: "/settings", api, now: NOW });

      const access = within(await screen.findByRole("region", { name: "Studio access" }));
      expect(await access.findByText("Open to the network")).toBeInTheDocument();
      expect(access.getByText(/0\.0\.0\.0, every network interface/)).toBeInTheDocument();
      expect(access.getByText(/there is one reviewer account/)).toBeInTheDocument();
      expect(access.queryByText("Loopback only")).toBeNull();
    });

    it("signs a signed-in reviewer out, clears what was read as them and goes to the sign-in page", async () => {
      let account = true;
      const api = fakeApi({
        project: () =>
          account
            ? Promise.resolve({ ...SAMPLE_PROJECT, reviewer: "sam" })
            : Promise.reject(
                new ApiError(401, "sign-in", "This request is not signed in.", "Sign in."),
              ),
        signOut: () => {
          account = false;
          return Promise.resolve();
        },
      });
      const { user, history, queryClient } = renderStudio({ path: "/settings", api, now: NOW });
      const access = within(await screen.findByRole("region", { name: "Studio access" }));
      expect(await access.findByText("sam")).toBeInTheDocument();
      // What the pages read as this reviewer is in the cache until they sign out.
      const cached = (key: readonly string[]) =>
        queryClient.getQueryCache().find({ queryKey: key });
      await waitFor(() => {
        expect(cached(["reviewers"])).toBeDefined();
        expect(cached(["studio", "access"])).toBeDefined();
      });

      await user.click(access.getByRole("button", { name: "Sign out" }));

      expect(await screen.findByRole("heading", { level: 1, name: "Sign in" })).toBeInTheDocument();
      expect(api.calls).toContain("signOut");
      expect(history.location.pathname).toBe("/sign-in");
      // None of it outlives the session: the cache holds nothing the signed-in reviewer read.
      expect(cached(["reviewers"])).toBeUndefined();
      expect(cached(["studio", "access"])).toBeUndefined();
      expect(queryClient.getQueryCache().getAll()).toEqual([]);
    });

    it("says in plain words that a sign-out which never reached the worker did not sign them out", async () => {
      const api = fakeApi({
        project: () => Promise.resolve({ ...SAMPLE_PROJECT, reviewer: "sam" }),
        signOut: () => Promise.reject(new TypeError("Failed to fetch")),
      });
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      await user.click(await screen.findByRole("button", { name: "Sign out" }));

      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent(
        "The worker could not be reached, so you are still signed in.",
      );
      expect(alert).toHaveTextContent("then sign out again");
      expect(alert).not.toHaveTextContent("Failed to fetch");
    });

    it("says why a sign-out failed", async () => {
      const api = fakeApi({
        project: () => Promise.resolve({ ...SAMPLE_PROJECT, reviewer: "sam" }),
        signOut: () =>
          Promise.reject(
            new ApiError(500, "internal_error", "Something went wrong.", "Try again."),
          ),
      });
      const { user } = renderStudio({ path: "/settings", api, now: NOW });
      await user.click(await screen.findByRole("button", { name: "Sign out" }));
      const alert = await screen.findByRole("alert");
      expect(alert).toHaveTextContent("Something went wrong.");
      expect(alert).toHaveTextContent("Try again.");
    });
  });

  it("marks the Cloud-only parts with the dashed tag, and only those", async () => {
    renderStudio({ path: "/settings", now: NOW });

    const cloud = within(
      await screen.findByRole("region", { name: "Members, environments, billing, retention" }),
    );
    expect(cloud.getByText("Cloud")).toHaveAttribute("data-tone", "cloud");
    expect(cloud.getByText(/are FacetDB Cloud features/)).toBeInTheDocument();
    for (const name of ["Reviewers", "Spending cap", "Studio access"]) {
      const section = within(await screen.findByRole("region", { name }));
      expect(section.queryByText("Cloud")).toBeNull();
    }
  });

  it("has no primary action on the page and a heading for each section in order", async () => {
    renderStudio({ path: "/settings", now: NOW });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual([
      "Reviewers",
      "Spending cap",
      "Studio access",
      "Members, environments, billing, retention",
    ]);
    for (const button of screen.getAllByRole("button")) {
      expect(button).not.toHaveAttribute("data-variant", "primary");
    }
  });

  it("renders at phone width with every section", async () => {
    renderStudio({ path: "/settings", phone: true, now: NOW });
    await screen.findByRole("heading", { level: 1, name: "Settings" });
    for (const name of ["Reviewers", "Spending cap", "Studio access"]) {
      expect(await screen.findByRole("region", { name })).toBeInTheDocument();
    }
  });
});

describe("the rail", () => {
  it("opens a page with content or an honest empty state from each of the three entries", async () => {
    const { user } = renderStudio({ path: "/plugins", now: NOW });
    await screen.findByRole("heading", { level: 1, name: "Plugins" });
    const rail = within(screen.getByRole("navigation", { name: "Pages" }));

    await user.click(rail.getByRole("link", { name: /Alerts/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Alerts" })).toBeVisible();
    expect(await screen.findByRole("table", { name: "Alerts, newest first" })).toBeVisible();

    await user.click(rail.getByRole("link", { name: /Settings/ }));
    expect(await screen.findByRole("heading", { level: 1, name: "Settings" })).toBeVisible();
    expect(await screen.findByRole("list", { name: "Reviewers" })).toBeVisible();
  });
});
