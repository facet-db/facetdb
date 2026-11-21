import { screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Home } from "../../api/index.ts";
import { fakeApi, renderStudio, SAMPLE_HOME } from "../../testing/index.ts";
import { HOME_REFRESH_MS } from "./index.ts";
import { alertTime, followable, ledeOf, splitCheck } from "./wording.ts";

/**
 * The Home page on happy-dom with the fake API client: every figure in the mockup's words, the
 * queue's one link to Review, the worker's missing heartbeat in words, the alerts as ruled rows,
 * and the page at phone width. Layout itself (rules, wrapping) is CSS that happy-dom does not
 * compute; these tests hold the structure and the classes that make it.
 */

function homeWith(change: (home: Home) => Home) {
  return fakeApi({ home: () => Promise.resolve(change(SAMPLE_HOME)) });
}

async function column(name: string) {
  return within(await screen.findByRole("article", { name }));
}

describe("the Home page", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens with the project, the sources it watches and its state under the title", async () => {
    renderStudio();
    expect(await screen.findByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(
      await screen.findByText("marketplace: three sources watched, everything running."),
    ).toBeInTheDocument();
    expect(document.title).toBe("Home · FacetDB");
  });

  it("shows the four columns in the mockup's words", async () => {
    renderStudio();

    const health = await column("Health");
    expect(health.getByText("Running")).toBeInTheDocument();
    expect(health.getByText("Worker beating, 2 s ago")).toBeInTheDocument();
    expect(health.getByText("Model healthy")).toBeInTheDocument();
    expect(health.getByText("Three sources, reachable and installed")).toBeInTheDocument();

    const answered = await column("Answered today");
    expect(answered.getByText("12,480")).toBeInTheDocument();
    expect(answered.getAllByText("62% of yesterday's 20,100.")).toHaveLength(1);

    const queue = await column("Waiting for a person");
    expect(queue.getByText("37")).toBeInTheDocument();
    expect(
      queue.getByText("Oldest 14 minutes. Three reviewers decided 212 today."),
    ).toBeInTheDocument();

    const spending = await column("Spending");
    expect(spending.getByText("3.2M of 25M")).toBeInTheDocument();
    expect(
      spending.getByText(
        "Input tokens this month: 13% of the monthly cap, about $3.20 of $25. The project pauses at 100%.",
      ),
    ).toBeInTheDocument();
  });

  it("draws a strip with its words for the share of yesterday and the share of the cap", async () => {
    renderStudio();
    const answered = await column("Answered today");
    expect(answered.getByRole("img", { name: "62% of yesterday's 20,100." })).toBeInTheDocument();
    const spending = await column("Spending");
    expect(
      spending.getByRole("img", { name: /Input tokens this month: 13% of the monthly cap/ }),
    ).toBeInTheDocument();
  });

  it("shows no percentage without its words and its strip in the same column", async () => {
    renderStudio();
    await screen.findByRole("article", { name: "Spending" });
    for (const one of screen.getAllByRole("article")) {
      if (/\d%/.test(one.textContent)) {
        expect(
          within(one).getAllByRole("img", { name: /\d%/ }).length,
          one.textContent,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("draws a strip in every figure's column but an uncapped spending's, and says each in words", async () => {
    renderStudio({
      api: homeWith((home) => ({
        ...home,
        answered: {
          ...home.answered,
          today: 40,
          yesterday: 0,
          fraction: null,
          words: { figure: "40", sub: "None were answered yesterday." },
        },
        spending: {
          ...home.spending,
          status: "uncapped",
          cap: null,
          fraction: null,
          words: {
            figure: "3.2M",
            sub: "Input tokens this month, about $3.20. No monthly cap is set, so the project never pauses.",
          },
        },
      })),
    });
    const answered = await column("Answered today");
    expect(answered.getByText("None were answered yesterday.")).toBeInTheDocument();
    // The worker gives no share of a yesterday with none: the page draws the strip all the same
    // (the design has one in this column), with the sentence as its words.
    expect(
      answered.getByRole("img", { name: "None were answered yesterday." }),
    ).toBeInTheDocument();
    const spending = await column("Spending");
    expect(spending.getByText(/No monthly cap is set, so the project never pauses/)).toBeVisible();
    expect(spending.queryByRole("img")).toBeNull();
    // The queue's strip is the share of today's review work still waiting, in the column's words.
    expect(
      (await column("Waiting for a person")).getByRole("img", {
        name: "Oldest 14 minutes. Three reviewers decided 212 today.",
      }),
    ).toBeInTheDocument();
  });

  it("leads to Review from the queue column's link, the only amber text on the page", async () => {
    const { user } = renderStudio();
    const queue = await column("Waiting for a person");
    const link = queue.getByRole("link", { name: "Review them" });
    expect(link).toHaveAttribute("href", "/review");

    const main = within(await screen.findByRole("main"));
    const amber = [...document.querySelectorAll("main .text-facet-text")];
    expect(amber).toEqual([link]);
    // Every other link on the page, the alerts', is set in the text color.
    for (const other of main.getAllByRole("link", { name: /See details/ })) {
      expect(other).toHaveClass("text-text");
    }

    await user.click(link);
    expect(await screen.findByRole("heading", { level: 1, name: "Review" })).toBeInTheDocument();
  });

  it("offers no link to Review when no card waits", async () => {
    renderStudio({
      api: homeWith((home) => ({
        ...home,
        queue: {
          ...home.queue,
          waiting: 0,
          oldestWaitMs: null,
          words: { figure: "None", sub: "No card is waiting." },
        },
      })),
    });
    const queue = await column("Waiting for a person");
    expect(queue.getByText("None")).toBeInTheDocument();
    expect(queue.getByText("No card is waiting.")).toBeInTheDocument();
    expect(queue.queryByRole("link")).toBeNull();
  });

  it("says the worker is not running, in words, when no heartbeat has come", async () => {
    renderStudio({
      api: homeWith((home) => ({
        ...home,
        health: {
          ...home.health,
          status: "attention",
          words: "Worker not running",
          heartbeatAgeMs: null,
          checks: [
            {
              name: "worker",
              status: "fail",
              words:
                "Worker not running. The worker has not beaten for 5 minutes. None has beat for this project yet.",
            },
            ...home.health.checks.slice(1),
          ],
        },
      })),
    });
    const health = await column("Health");
    // The state in the large figure, and the check's first clause beside its square.
    expect(health.getAllByText("Worker not running")).toHaveLength(2);
    expect(
      health.getByText(
        "The worker has not beaten for 5 minutes. None has beat for this project yet.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByText("marketplace: three sources watched, worker not running."),
    ).toBeInTheDocument();
  });

  it("says what a warned or paused spending is, in a word beside its square", async () => {
    renderStudio({
      api: homeWith((home) => ({
        ...home,
        spending: {
          ...home.spending,
          status: "paused",
          fraction: 1,
          words: {
            figure: "25M of 25M",
            sub: "Input tokens this month: the monthly cap is reached (about $25), so the project is paused until the month resets or the cap changes.",
          },
        },
      })),
    });
    const spending = await column("Spending");
    expect(spending.getByText("Paused at the cap")).toBeInTheDocument();
    expect(
      spending.getByRole("img", { name: /the monthly cap is reached \(about \$25\)/ }),
    ).toBeVisible();
  });

  it("keeps the worker's cap in the figures, and says when the file sets another it has not taken up", async () => {
    // The file was edited by hand to 40,000,000 tokens since the last reload; the worker still
    // enforces the 25,000,000 it took up last.
    renderStudio({
      api: fakeApi({
        spendingConfig: () => Promise.resolve({ tokens: 40_000_000, onCapReached: "continue" }),
      }),
    });
    const spending = await column("Spending");
    expect(
      await spending.findByText(
        "facetdb.config.ts sets a monthly cap of 40M billable input tokens (40,000,000), and the project keeps answering past 100%, which the worker has not taken up: apply it from Settings.",
      ),
    ).toBeVisible();
    expect(
      spending.getByText(
        "Input tokens this month: 13% of the monthly cap, about $3.20 of $25. The project pauses at 100%.",
      ),
    ).toBeInTheDocument();
  });

  it("says nothing of the file when it sets the cap the worker enforces", async () => {
    renderStudio();
    const spending = await column("Spending");
    await spending.findByText("3.2M of 25M");
    await waitFor(() => {
      expect(spending.queryByText(/facetdb\.config\.ts sets/)).toBeNull();
    });
  });

  it("lists the recent alerts as rows: severity word, title, what FacetDB did, time and one link", async () => {
    renderStudio();
    const alerts = within(await screen.findByRole("region", { name: "Recent alerts" }));
    const rows = alerts.getAllByRole("listitem");
    expect(rows).toHaveLength(2);

    const first = within(rows[0] as HTMLElement);
    expect(first.getByText("Information")).toBeInTheDocument();
    expect(first.getByText("Backfill finished")).toBeInTheDocument();
    expect(first.getByText(/listings: 50,000 records in 41 minutes/)).toBeInTheDocument();
    const link = first.getByRole("link", { name: "See details of Backfill finished" });
    expect(link).toHaveAttribute("href", "https://docs.facetdb.dev/fix/backfill");
    expect(first.getAllByRole("link")).toHaveLength(1);
    const time = first.getByText(/Nov 5/);
    expect(time.tagName).toBe("TIME");
    expect(time).toHaveAttribute("datetime", "2026-11-05T14:10:00.000Z");

    const second = within(rows[1] as HTMLElement);
    expect(second.getByText("Resolved")).toBeInTheDocument();
    expect(second.getByText("Model failing")).toBeInTheDocument();
  });

  it("follows an alert's link only when it is a web address or a path of this studio", async () => {
    renderStudio({
      api: homeWith((home) => ({
        ...home,
        alerts: home.alerts.map((alert, index) => ({
          ...alert,
          link: index === 0 ? "javascript:alert(1)" : "/questions",
        })),
      })),
    });
    const alerts = within(await screen.findByRole("region", { name: "Recent alerts" }));
    const links = alerts.getAllByRole("link");
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/questions"]);
  });

  it("says so when there is no alert yet", async () => {
    renderStudio({ api: homeWith((home) => ({ ...home, alerts: [] })) });
    const alerts = within(await screen.findByRole("region", { name: "Recent alerts" }));
    expect(await alerts.findByRole("heading", { name: "No alerts yet" })).toBeInTheDocument();
    expect(alerts.queryByRole("listitem")).toBeNull();
  });

  it("stacks the columns with a rule between them at phone width", async () => {
    renderStudio({ phone: true });
    const today = await screen.findByRole("region", { name: "Today" });
    // One column below 640 px, two to 1100, four above it; the rules are the 1 px gaps over the
    // hairline, so they run between whichever columns meet.
    expect(today).toHaveClass("grid-cols-1", "gap-px", "bg-hairline");
    expect(
      within(today)
        .getAllByRole("article")
        .map((one) => one.className),
    ).toEqual(Array.from({ length: 4 }, () => expect.stringContaining("bg-canvas")));
    // The shell is the phone's: the top bar and drawer, not the rail.
    expect(screen.getByRole("button", { name: /menu/i })).toBeInTheDocument();
  });

  it("asks the worker again every 10 seconds while it is visible", async () => {
    expect(HOME_REFRESH_MS).toBe(10_000);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const api = fakeApi();
    renderStudio({ api });
    await screen.findByRole("article", { name: "Health" });
    const asked = () => api.calls.filter((call) => call === "home").length;
    const before = asked();
    await vi.advanceTimersByTimeAsync(HOME_REFRESH_MS - 1);
    expect(asked()).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    await waitFor(() => {
      expect(asked()).toBe(before + 1);
    });
  });

  it("stops presenting the old figures as current when a refresh fails after a success, and says so no longer when the next one succeeds", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    let failing = false;
    const api = fakeApi({
      home: () =>
        failing
          ? Promise.reject(
              new ApiError(
                503,
                "unavailable",
                "The store did not answer.",
                "Check that the database is running.",
              ),
            )
          : Promise.resolve(SAMPLE_HOME),
    });
    renderStudio({ api });
    expect((await column("Health")).getByText("Running")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText(/Last known/)).toBeNull();

    failing = true;
    await vi.advanceTimersByTimeAsync(HOME_REFRESH_MS);
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("The worker did not answer the last refresh.");
    expect(notice).toHaveTextContent(
      "The store did not answer. Check that the database is running.",
    );
    // Health no longer reads as the worker's state now; every column says it is the last known.
    const health = await column("Health");
    expect(health.getByText("Not known")).toBeInTheDocument();
    expect(health.queryByText("Worker beating, 2 s ago")).toBeNull();
    expect(health.queryByText("Running")).toBeNull();
    expect(screen.getAllByText(/^Last known [A-Z][a-z]{2} \d{1,2}, /)).toHaveLength(4);
    expect(
      screen.getByText(
        "marketplace: the worker cannot be reached, so these are the last figures it gave.",
      ),
    ).toBeInTheDocument();
    // The rail's instrument, on the same query, says the same.
    const foot = within(screen.getByRole("region", { name: "Worker and spending" }));
    expect(foot.getByText("Not known: the worker cannot be reached")).toBeInTheDocument();
    expect(foot.queryByText("Worker beating, 2 s ago")).toBeNull();

    failing = false;
    await vi.advanceTimersByTimeAsync(HOME_REFRESH_MS);
    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
    expect((await column("Health")).getByText("Running")).toBeInTheDocument();
    expect(screen.queryByText(/Last known/)).toBeNull();
  });

  it("announces a share once: the strip carries the sentence and its printed copy is hidden from assistive technology", async () => {
    renderStudio();
    const answered = await column("Answered today");
    expect(answered.getByText("62% of yesterday's 20,100.")).toHaveAttribute("aria-hidden", "true");
    expect(answered.getByRole("img", { name: "62% of yesterday's 20,100." })).toBeInTheDocument();
    const queue = await column("Waiting for a person");
    expect(
      queue.getByText("Oldest 14 minutes. Three reviewers decided 212 today."),
    ).toHaveAttribute("aria-hidden", "true");
    expect(
      queue.getByRole("img", { name: "Oldest 14 minutes. Three reviewers decided 212 today." }),
    ).toBeInTheDocument();
  });

  it("keeps a sentence announced where no strip carries it", async () => {
    renderStudio({
      api: homeWith((home) => ({
        ...home,
        spending: {
          ...home.spending,
          status: "uncapped",
          cap: null,
          fraction: null,
          words: {
            figure: "3.2M",
            sub: "Input tokens this month, about $3.20. No monthly cap is set, so the project never pauses.",
          },
        },
      })),
    });
    const spending = await column("Spending");
    expect(
      spending.getByText(/No monthly cap is set, so the project never pauses/),
    ).not.toHaveAttribute("aria-hidden");
  });

  it("lets a health word wrap under its square when it is a sentence", async () => {
    renderStudio();
    const health = await column("Health");
    expect(health.getByText("Model healthy").dataset["wrap"]).toBe("true");
  });

  it("keeps two alike alerts apart", async () => {
    const complaints = vi.spyOn(console, "error").mockImplementation(() => undefined);
    renderStudio({
      api: homeWith((home) => {
        const [first] = home.alerts;
        return first === undefined ? home : { ...home, alerts: [first, { ...first }] };
      }),
    });
    const alerts = within(await screen.findByRole("region", { name: "Recent alerts" }));
    expect(alerts.getAllByRole("listitem")).toHaveLength(2);
    expect(complaints).not.toHaveBeenCalled();
    complaints.mockRestore();
  });

  it("gives the worker's words and the fix when the figures do not come", async () => {
    const api = fakeApi({
      home: () =>
        Promise.reject(
          new ApiError(
            503,
            "unavailable",
            "The store did not answer.",
            "Check that the database is running.",
          ),
        ),
    });
    const { user } = renderStudio({ api });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "The store did not answer. Check that the database is running.",
    );
    const before = api.calls.filter((call) => call === "home").length;
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(api.calls.filter((call) => call === "home").length).toBeGreaterThan(before);
    });
  });
});

describe("the Home page's wording", () => {
  it("splits a check at its first clause", () => {
    expect(splitCheck("Model healthy")).toEqual({ line: "Model healthy", rest: "" });
    expect(splitCheck("Worker not running. It has not beaten. None yet.")).toEqual({
      line: "Worker not running",
      rest: "It has not beaten. None yet.",
    });
    expect(
      splitCheck(
        "Three sources, reachable and installed; listings: the database answers in 149 ms; run the worker in the same region for fast answers",
      ),
    ).toEqual({
      line: "Three sources, reachable and installed",
      rest: "listings: the database answers in 149 ms; run the worker in the same region for fast answers",
    });
  });

  it("words the lede for no source, one source and a failing state", () => {
    const base = { status: "running", words: "Running", checks: [] } as const;
    expect(ledeOf("shop", { ...base, sources: [] })).toBe(
      "shop: no source is installed yet, everything running.",
    );
    expect(ledeOf("shop", { ...base, sources: [{}] })).toBe(
      "shop: one source watched, everything running.",
    );
    expect(
      ledeOf(undefined, {
        status: "attention",
        words: "Model failing",
        sources: [{}, {}],
        checks: [],
      }),
    ).toBe("Two sources watched, model failing.");
  });

  it("claims only what is true: a warning is named, not called everything running", () => {
    const health = {
      status: "running",
      words: "Running",
      sources: [{}, {}, {}],
      checks: [
        { name: "worker", status: "ok" },
        { name: "model", status: "warn" },
        { name: "sources", status: "warn" },
      ],
    } as const;
    expect(ledeOf("shop", health)).toBe(
      "shop: three sources watched, running, with a warning about the model and the sources.",
    );
  });

  it("follows web addresses and own paths only", () => {
    const origin = "http://127.0.0.1:4040";
    expect(followable("https://docs.facetdb.dev/x", origin)).toBe("https://docs.facetdb.dev/x");
    expect(followable("/questions", origin)).toBe("/questions");
    expect(followable("javascript:alert(1)", origin)).toBeNull();
    expect(followable("data:text/html,x", origin)).toBeNull();
  });

  it("words a time in the viewer's zone without saying today", () => {
    expect(alertTime("2026-11-05T14:10:00.000Z")).toMatch(/^Nov [45], \d{1,2}:\d{2}\s[AP]M$/);
  });
});
