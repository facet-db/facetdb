import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  ApiError,
  createApiClient,
  type DecisionFilters,
  type DecisionHistory,
  type DecisionRow,
  type DecisionsPage,
  type ExplainedEntry,
} from "../../api/index.ts";
import {
  fakeApi,
  fakeScheduler,
  renderStudio,
  SAMPLE_DECISIONS,
  SAMPLE_RUNS,
  STUDIO_NOW,
  sampleHistory,
} from "../../testing/index.ts";
import { shareOf } from "../why/index.ts";
import { logLines, saidOf } from "./log-lines.ts";
import { decisionsSearch, narrowed, patched, timeStart } from "./search.ts";
import { tookWords, whenWords } from "./when.ts";

/**
 * The Decisions page, its Runs tab and the why page on happy-dom with the fake API client: the
 * filters produce the queries, the cursor appends without repeats, a row leads to the why page, the
 * timeline words every kind of entry, the Runs tab lists the runs. The address holds the view, so
 * most tests open one. Times are asserted through their datetime attribute: the words of a time are
 * in the zone of the machine that runs the test.
 */

/** The filters the page sent, in order, from the fake's notes. */
function asked(calls: readonly string[]): Record<string, unknown>[] {
  return calls
    .filter((call) => call.startsWith("decisions "))
    .map((call) => JSON.parse(call.slice("decisions ".length)) as Record<string, unknown>);
}

function runsAsked(calls: readonly string[]): unknown[] {
  return calls
    .filter((call) => call.startsWith("runs "))
    .map((call) => JSON.parse(call.slice("runs ".length)) as unknown);
}

/** What a sighted reader reads of an element: its text without the words kept for screen readers. */
function sighted(element: Element | undefined): string {
  const copy = element?.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll(".sr-only")) {
    hidden.remove();
  }
  return copy.textContent.replace(/\s+/g, " ");
}

/** Midnight on this machine, the way the page counts today, from the test's clock. */
const MIDNIGHT = new Date(
  STUDIO_NOW.getFullYear(),
  STUDIO_NOW.getMonth(),
  STUDIO_NOW.getDate(),
).toISOString();

const DAY_MS = 24 * 60 * 60 * 1000;

function modelRow(key: string, at: string, probability: number): DecisionRow {
  return {
    kind: "answer",
    time: at,
    record_key: key,
    version: 3,
    model: "jev-1.14.0",
    answers: { is_scam: { type: "noul", probability, decision: "no", outcome: "decided" } },
  };
}

/** The log opened, with the table's fill played out (the fake scheduler steps it by hand). */
async function openedLog(path = "/decisions", api = fakeApi()) {
  const studio = renderStudio({ path, api });
  await screen.findByRole("table", { name: "Decisions of listings" });
  act(() => {
    studio.schedule.advance(2000);
  });
  return studio;
}

describe("the Decisions page", () => {
  it("lists the log newest first, one line per question: when, record, question, the model said, in words, decided, by", async () => {
    await openedLog();
    const table = screen.getByRole("table", { name: "Decisions of listings" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["When", "Record", "Question", "The model said", "In words", "Decided", "By"]);
    const rows = within(table).getAllByRole("row").slice(1);
    // A person's decision, then one model call answering two questions, then another record.
    expect(rows.map((row) => within(row).getAllByRole("cell")[2]?.textContent)).toEqual([
      "is_scam",
      "is_scam",
      "category",
      "is_scam",
    ]);
    const person = within(rows[0] as HTMLElement).getAllByRole("cell");
    expect(person[1]?.textContent).toBe("48213");
    expect(person[5]?.textContent).toBe("yes");
    expect(person[6]?.textContent).toBe("hailey");
    expect(person[3]?.textContent).toBe("");

    const model = within(rows[1] as HTMLElement).getAllByRole("cell");
    expect(model[3]).toHaveTextContent("58%");
    expect(model[4]).toHaveTextContent("likely yes");
    expect(model[5]).toHaveTextContent("needs review");
    expect(model[6]).toHaveTextContent("the model");
    const choice = within(rows[2] as HTMLElement).getAllByRole("cell");
    expect(choice[3]).toHaveTextContent("93%");
    expect(choice[4]).toHaveTextContent("electronics");
    expect(choice[5]).toHaveTextContent("electronics");
    expect(within(rows[0] as HTMLElement).getByText("yes")).toBeInTheDocument();
    expect(table.querySelector("time")).toHaveAttribute("datetime", "2026-11-06T14:31:00.000Z");
  });

  it("says a status as a word beside its square, and a probability as strip, number and words", async () => {
    await openedLog();
    const review = screen.getByText("needs review");
    expect(review).toHaveAttribute("data-status", "needs_review");
    // The strip has a text equivalent: its label names the figure in words.
    expect(screen.getByRole("img", { name: "58% likely yes" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "electronics, 93% sure" })).toBeInTheDocument();
  });

  it("reads what a line came to by the tag, so an option named like a status is a decided value", async () => {
    const page: DecisionsPage = {
      decisions: [
        {
          kind: "human",
          time: "2026-11-06T14:40:00.000Z",
          record_key: "U-1",
          version: 3,
          question: "is_scam",
          value: "withdrawn",
          decision: "withdrawn",
          decided_by: "hailey",
          withdrawn: true,
        },
        {
          kind: "answer",
          time: "2026-11-06T14:30:00.000Z",
          record_key: "O-1",
          version: 3,
          model: "jev-1.14.0",
          answers: {
            listing_state: {
              type: "choice",
              top: "withdrawn",
              probabilities: [0.9, 0.1],
              decision: "withdrawn",
              outcome: "decided",
            },
            queue: {
              type: "choice",
              top: "needs review",
              probabilities: [0.9, 0.1],
              decision: "needs review",
              outcome: "decided",
            },
            seller: {
              type: "choice",
              top: "unknown",
              probabilities: [0.9, 0.1],
              decision: "unknown",
              outcome: "decided",
            },
            // The lines below are the levels' names, by the version the worker keeps.
            urgency: {
              type: "score",
              probabilities: [0.1, 0.2, 0.7],
              confidence: 0.6,
              value: "high",
              decision: "high",
              outcome: "decided",
            },
          },
        },
      ],
      next: null,
    };
    await openedLog("/decisions?time=all", fakeApi({ decisions: () => Promise.resolve(page) }));
    const table = screen.getByRole("table", { name: "Decisions of listings" });
    const decided = within(table)
      .getAllByRole("row")
      .slice(1)
      .map((row) => within(row).getAllByRole("cell")[5]?.querySelector("[data-status]"));
    expect(decided.map((cell) => [cell?.textContent, cell?.getAttribute("data-status")])).toEqual([
      // The person's undo, told by the row's flag.
      ["withdrawn", "skipped"],
      // Options named "withdrawn", "needs review" and "unknown", each decided by the model.
      ["withdrawn", "done"],
      ["needs review", "done"],
      ["unknown", "done"],
      ["high", "done"],
    ]);
    expect(screen.getByRole("img", { name: "high, 60% sure" })).toBeInTheDocument();
  });

  it("asks for the first source's log from today's midnight, and for nothing else", async () => {
    const api = fakeApi();
    await openedLog("/decisions", api);
    expect(asked(api.calls)).toEqual([{ source: "listings", from: MIDNIGHT }]);
  });

  it("fills the answer cells in after the rows arrive, and not before", async () => {
    const { schedule } = renderStudio({ path: "/decisions" });
    const table = await screen.findByRole("table", { name: "Decisions of listings" });
    expect(within(table).queryByText("likely yes")).not.toBeInTheDocument();
    // The record and the question arrive with the row.
    expect(within(table).getAllByText("48213").length).toBeGreaterThan(0);
    // Cells land 40 ms apart, in reading order: the first has landed after one step.
    act(() => {
      schedule.advance(40);
    });
    act(() => {
      schedule.advance(2000);
    });
    expect(within(table).getAllByText("likely yes").length).toBeGreaterThan(0);
  });

  it("changes only the query when a time is chosen, and keeps the choice in the address", async () => {
    const api = fakeApi();
    const { user, history, schedule } = await openedLog("/decisions", api);
    const times = screen.getByRole("group", { name: "Time" });
    expect(within(times).getByRole("button", { name: "Today" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await user.click(within(times).getByRole("button", { name: "7 days" }));
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({
        source: "listings",
        from: new Date(schedule.now() - 7 * DAY_MS).toISOString(),
      });
    });
    expect(history.location.search).toContain("time=week");
    await user.click(within(times).getByRole("button", { name: "30 days" }));
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({
        source: "listings",
        from: new Date(schedule.now() - 30 * DAY_MS).toISOString(),
      });
    });
    await user.click(within(times).getByRole("button", { name: "All" }));
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({ source: "listings" });
    });
    await user.click(within(times).getByRole("button", { name: "Today" }));
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({ source: "listings", from: MIDNIGHT });
    });
    expect(history.location.search).not.toContain("time");
    // A time asks the log and nothing else: no source is read again, no record asked about.
    expect(api.calls.filter((call) => !call.startsWith("decisions "))).not.toContain(
      "decisionHistory",
    );
    expect(api.calls.filter((call) => call.startsWith("sourceNames"))).toHaveLength(1);
  });

  it("asks for a digest's range of decision times, shown pressed, until a choice replaces it", async () => {
    const api = fakeApi();
    const from = new Date(STUDIO_NOW.getTime() - 50_000).toISOString();
    const to = new Date(STUDIO_NOW.getTime() - 1_000).toISOString();
    const { user, history } = await openedLog(
      `/decisions?source=listings&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
      api,
    );
    expect(asked(api.calls)).toEqual([{ source: "listings", from, to }]);
    const times = screen.getByRole("group", { name: "Time" });
    const now = new Date(STUDIO_NOW.getTime());
    const words = `${whenWords(new Date(from), now, { seconds: true })} to ${whenWords(new Date(to), now, { seconds: true })}`;
    expect(within(times).getByRole("button", { name: words })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(within(times).getByRole("button", { name: "Today" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await user.click(within(times).getByRole("button", { name: "All" }));
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({ source: "listings" });
    });
    expect(history.location.search).not.toContain("from");
    expect(within(times).queryByRole("button", { name: words })).not.toBeInTheDocument();
  });

  it("searches a record key on Enter, and the address holds it", async () => {
    const api = fakeApi();
    const { user, history } = await openedLog("/decisions?time=all", api);
    await user.type(screen.getByRole("textbox", { name: "Record key" }), "abc{Enter}");
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({ source: "listings", key: "abc" });
    });
    expect(history.location.search).toContain("q=abc");
    // Not one request per letter.
    expect(asked(api.calls)).toHaveLength(2);
  });

  it("filters by status and by source through the listboxes", async () => {
    const api = fakeApi();
    const { user, history } = await openedLog("/decisions?time=all", api);
    await user.click(screen.getByRole("combobox", { name: "Status" }));
    await user.click(await screen.findByRole("option", { name: "Needs review" }));
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({ source: "listings", status: "needs_review" });
    });
    expect(history.location.search).toContain("status=needs_review");

    await user.click(screen.getByRole("combobox", { name: "Source" }));
    await user.click(await screen.findByRole("option", { name: "support_messages" }));
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({
        source: "support_messages",
        status: "needs_review",
      });
    });
    expect(history.location.search).toContain("source=support_messages");
  });

  it("keeps the question and the reviewer behind More filters", async () => {
    const api = fakeApi();
    const { user } = await openedLog("/decisions?time=all", api);
    expect(screen.queryByRole("textbox", { name: "Question" })).not.toBeInTheDocument();
    const more = screen.getByRole("button", { name: "More filters" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    await user.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");
    await user.type(screen.getByRole("textbox", { name: "Question" }), "is_scam{Enter}");
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({ source: "listings", question: "is_scam" });
    });
    await user.type(screen.getByRole("textbox", { name: "Decided by" }), "hailey{Enter}");
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({
        source: "listings",
        question: "is_scam",
        reviewer: "hailey",
      });
    });
  });

  it("opens with More filters showing when the address names a question", async () => {
    const api = fakeApi();
    await openedLog("/decisions?time=all&question=category", api);
    expect(screen.getByRole("textbox", { name: "Question" })).toHaveValue("category");
    // Only the lines of that question: the model call's other question is left out.
    const table = screen.getByRole("table", { name: "Decisions of listings" });
    expect(within(table).queryByText("is_scam")).not.toBeInTheDocument();
    expect(within(table).getByText("category")).toBeInTheDocument();
  });

  it("shows the same view from a shared link as from the clicks", async () => {
    const api = fakeApi();
    renderStudio({
      path: "/decisions?source=support_messages&status=needs_review&time=month&q=T-1&question=urgency&reviewer=sam",
      api,
    });
    // None of the sample's lines is an urgency one, so the page says nothing matches.
    await screen.findByRole("heading", { name: "No decisions match" });
    expect(asked(api.calls)).toEqual([
      {
        source: "support_messages",
        key: "T-1",
        question: "urgency",
        status: "needs_review",
        reviewer: "sam",
        from: new Date(STUDIO_NOW.getTime() - 30 * DAY_MS).toISOString(),
      },
    ]);
  });

  it("falls back to the defaults for values that are not choices, and asks nothing the server refuses", async () => {
    const api = fakeApi();
    renderStudio({
      path: "/decisions?source=Not%20A%20Source&status=bogus&time=fortnight&page=-3&tab=sideways&q=%20%20",
      api,
    });
    await screen.findByRole("table", { name: "Decisions of listings" });
    expect(asked(api.calls)).toEqual([{ source: "listings", from: MIDNIGHT }]);
    expect(runsAsked(api.calls)).toEqual([]);
    expect(screen.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
  });

  it("falls back to the first source when the link names one the config does not have", async () => {
    const api = fakeApi();
    await openedLog("/decisions?source=gone_source&time=all", api);
    expect(asked(api.calls)).toEqual([{ source: "listings" }]);
  });

  it("appends the next page with the cursor the worker gave, without repeats", async () => {
    const first: DecisionsPage = {
      decisions: [modelRow("A-1", "2026-11-06T14:00:00.000Z", 0.1)],
      next: "1793973600000.7",
    };
    const second: DecisionsPage = {
      decisions: [modelRow("A-2", "2026-11-06T13:00:00.000Z", 0.2)],
      next: null,
    };
    const api = fakeApi({
      decisions: (_filters: DecisionFilters, cursor?: string) =>
        Promise.resolve(cursor === undefined ? first : second),
    });
    const { user } = await openedLog("/decisions?time=all", api);
    const table = screen.getByRole("table", { name: "Decisions of listings" });
    expect(
      within(table)
        .getAllByText(/^A-/)
        .map((cell) => cell.textContent),
    ).toEqual(["A-1"]);
    expect(screen.getByText("1 decision, newest first.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show more" }));
    await waitFor(() => {
      expect(
        within(table)
          .getAllByText(/^A-/)
          .map((cell) => cell.textContent),
      ).toEqual(["A-1", "A-2"]);
    });
    expect(asked(api.calls).map((call) => call["cursor"])).toEqual([undefined, "1793973600000.7"]);
    expect(screen.getByText("2 decisions, newest first. Nothing older.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show more" })).not.toBeInTheDocument();
  });

  it("offers Show more on a short page that still has an older part of the log to read", async () => {
    const api = fakeApi({
      decisions: () => Promise.resolve({ decisions: [], next: "1.1" }),
    });
    renderStudio({ path: "/decisions?status=needs_review&time=all", api });
    expect(
      await screen.findByText("Nothing yet in the part of the log read so far."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show more" })).toBeInTheDocument();
  });

  it("says when nothing matches, and clears the filters in one click", async () => {
    const api = fakeApi({
      decisions: (filters) =>
        Promise.resolve(
          filters.key === undefined ? SAMPLE_DECISIONS : { decisions: [], next: null },
        ),
    });
    const { user } = renderStudio({ path: "/decisions?q=nope&status=decided", api });
    expect(await screen.findByRole("heading", { name: "No decisions match" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Clear the filters" }));
    await screen.findByRole("table", { name: "Decisions of listings" });
    expect(asked(api.calls).at(-1)).toEqual({ source: "listings" });
  });

  it("leads a row to the why page of its record", async () => {
    const api = fakeApi();
    const { user, history } = await openedLog("/decisions?time=all", api);
    const table = screen.getByRole("table", { name: "Decisions of listings" });
    await user.click(within(table).getAllByRole("link", { name: "48190" })[0] as HTMLElement);
    expect(
      await screen.findByRole("heading", { level: 1, name: "Why was this decided?" }),
    ).toBeVisible();
    expect(history.location.pathname).toBe("/decisions/listings/48190");
    expect(api.calls).toContain(
      `decisionHistory ${JSON.stringify({ source: "listings", key: "48190" })}`,
    );
  });

  it("reaches a record whose key holds a slash, a space and a percent sign, encoded once", async () => {
    const key = "a/b c%25d";
    const api = fakeApi({
      decisions: () =>
        Promise.resolve({
          decisions: [modelRow(key, "2026-11-06T14:00:00.000Z", 0.3)],
          next: null,
        }),
    });
    const { user, history } = await openedLog("/decisions?time=all", api);
    await user.click(screen.getByRole("link", { name: key }));
    expect(
      await screen.findByRole("heading", { level: 1, name: "Why was this decided?" }),
    ).toBeVisible();
    expect(history.location.pathname).toBe("/decisions/listings/a%2Fb%20c%2525d");
    expect(api.calls).toContain(`decisionHistory ${JSON.stringify({ source: "listings", key })}`);
    expect(screen.getByText(`The history of ${key} in listings`, { exact: false })).toBeVisible();
  });

  it("places a key and a note as text, never as markup", async () => {
    const key = "<img src=x onerror=alert(1)>";
    const api = fakeApi({
      decisions: () =>
        Promise.resolve({
          decisions: [modelRow(key, "2026-11-06T14:00:00.000Z", 0.3)],
          next: null,
        }),
    });
    const { container } = await openedLog("/decisions?time=all", api);
    expect(screen.getByText(key)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("says a failure in the surface's own words", async () => {
    const api = fakeApi({
      decisions: () =>
        Promise.reject(
          new ApiError(
            404,
            "unknown_source",
            'This project has no source called "listings".',
            "Use one of: orders.",
          ),
        ),
    });
    renderStudio({ path: "/decisions", api });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('This project has no source called "listings".');
    expect(alert).toHaveTextContent("Use one of: orders.");
  });

  it("points at the Sources page when the project has no source", async () => {
    const api = fakeApi({ sourceNames: () => Promise.resolve([]) });
    renderStudio({ path: "/decisions", api });
    expect(await screen.findByRole("heading", { name: "No source yet" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Add a source" })).toHaveAttribute(
      "href",
      "/sources/new",
    );
  });
});

describe("the Runs tab", () => {
  it("lists the runs of every source, a backfill's page named as one", async () => {
    const api = fakeApi();
    const { user, history } = renderStudio({ path: "/decisions", api });
    await screen.findByRole("table", { name: "Decisions of listings" });
    await user.click(screen.getByRole("button", { name: "Runs" }));
    const table = await screen.findByRole("table", { name: "Runs of every source" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual([
      "Started",
      "Source",
      "Claimed",
      "Answered",
      "To review",
      "Errors",
      "Discarded",
      "Tokens",
      "Took",
    ]);
    const rows = within(table).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(SAMPLE_RUNS.runs.length);
    const pass = within(rows[0] as HTMLElement).getAllByRole("cell");
    expect(pass.map((cell) => cell.textContent).slice(1)).toEqual([
      "listings",
      "20",
      "18",
      "2",
      "0",
      "0",
      "14,900",
      "2.0 s",
    ]);
    const backfill = within(rows[1] as HTMLElement).getAllByRole("cell");
    expect(backfill[1]).toHaveTextContent("listings, a backfill page");
    expect(backfill[7]).toHaveTextContent("361,000");
    expect(backfill[8]).toHaveTextContent("11.4 s");
    expect(runsAsked(api.calls)).toEqual([{ page: 1 }]);
    expect(history.location.search).toContain("tab=runs");
  });

  it("narrows to one source and pages with Older runs and Newer runs", async () => {
    const api = fakeApi({
      runs: ({ page }) => Promise.resolve({ ...SAMPLE_RUNS, page, more: page < 2 }),
    });
    const { user, history } = renderStudio({ path: "/decisions?tab=runs", api });
    await screen.findByRole("table", { name: "Runs of every source" });
    await user.click(screen.getByRole("combobox", { name: "Source" }));
    await user.click(await screen.findByRole("option", { name: "support_messages" }));
    await screen.findByRole("table", { name: "Runs of support_messages" });
    expect(runsAsked(api.calls).at(-1)).toEqual({ source: "support_messages", page: 1 });

    await user.click(screen.getByRole("button", { name: "Older runs" }));
    await waitFor(() => {
      expect(runsAsked(api.calls).at(-1)).toEqual({ source: "support_messages", page: 2 });
    });
    expect(history.location.search).toContain("page=2");
    expect(screen.queryByRole("button", { name: "Older runs" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Newer runs" }));
    await waitFor(() => {
      expect(runsAsked(api.calls).at(-1)).toEqual({ source: "support_messages", page: 1 });
    });
    expect(history.location.search).not.toContain("page");
  });

  it("opens a shared page of the run log, and names errors in words", async () => {
    const api = fakeApi({
      runs: ({ page }) =>
        Promise.resolve({
          ...SAMPLE_RUNS,
          page,
          runs: [{ ...(SAMPLE_RUNS.runs[0] as (typeof SAMPLE_RUNS.runs)[number]), errors: 12 }],
        }),
    });
    renderStudio({ path: "/decisions?tab=runs&page=3&source=listings", api });
    expect(await screen.findByText("12 errors")).toHaveAttribute("data-status", "error");
    expect(runsAsked(api.calls)).toEqual([{ source: "listings", page: 3 }]);
  });

  it("says when the worker has not run anything yet", async () => {
    const api = fakeApi({
      runs: () => Promise.resolve({ ...SAMPLE_RUNS, runs: [], more: false }),
    });
    renderStudio({ path: "/decisions?tab=runs", api });
    expect(await screen.findByRole("heading", { name: "No runs yet" })).toBeVisible();
  });
});

describe("the why page", () => {
  it("words every kind of entry, newest first, as facetdb explain does", async () => {
    const sample = sampleHistory("listings", "48213");
    const history = {
      ...sample,
      entries: [
        ...sample.entries,
        {
          kind: "withdrawal" as const,
          at: "2026-11-06T14:40:00.000Z",
          version: 3,
          stateHash: "hash-at-390",
          question: "is_scam",
          wording: "Is this listing a scam?",
          reviewer: "hailey",
        },
      ],
    };
    const api = fakeApi({ decisionHistory: () => Promise.resolve(history) });
    renderStudio({ path: "/decisions/listings/48213", api });
    const timeline = await screen.findByRole("list", { name: "Decisions for record 48213" });
    const entries = [...timeline.querySelectorAll<HTMLElement>(":scope > li")];
    // Newest first: the withdrawal, the person, the second answer, the first answer.
    expect(entries.map((entry) => entry.getAttribute("data-kind"))).toEqual([
      "human",
      "human",
      "answer",
      "answer",
    ]);
    expect(entries[0]).toHaveTextContent('"Is this listing a scam?" decision withdrawn');
    expect(entries[0]).toHaveTextContent(
      "hailey took back their own decision. Both stay in the log.",
    );
    expect(entries[1]).toHaveTextContent('"Is this listing a scam?" decided yes');
    expect(entries[1]).toHaveTextContent("Note: gift-card payment, two-day-old seller");
    expect(entries[1]).toHaveTextContent("hailey, question set v3");
    // Another state and another version than the answer before: both reasons are said.
    expect(entries[2]).toHaveTextContent("Asked again: the record changed, under question set v3");
    expect(entries[2]).toHaveTextContent("jev-1.14.0, question set v3");
    expect(sighted(entries[2])).toContain(
      '"Is this listing a scam?" 58% likely yes → needs review',
    );
    expect(within(entries[2] as HTMLElement).getByText("needs review")).toHaveAttribute(
      "data-status",
      "needs_review",
    );
    expect(entries[3]).toHaveTextContent("First answer");
    expect(entries[3]).toHaveTextContent("jev-1.14.0, question set v2");
    expect(sighted(entries[3])).toContain('"Is this listing a scam?" 27% likely yes → no');
    expect(sighted(entries[3])).toContain(
      '"Which category is this listing?" electronics, 93% sure → electronics',
    );
    // For a screen reader the arrow is a word.
    expect(entries[3]).toHaveTextContent("27% likely yes → , so no");
    // Each kind of entry says what it is in a word, not only in the square's color.
    expect(within(entries[1] as HTMLElement).getByText("Human decision")).toBeVisible();
    expect(within(entries[2] as HTMLElement).getByText("Model answer")).toBeVisible();
    expect(within(timeline).getAllByText(/^20|^Nov|^yesterday|^\d/).length).toBeGreaterThan(0);
    expect(timeline.querySelectorAll("time")).toHaveLength(4);
  });

  it("keeps the explain entries in the order the worker sent, reversed and nothing else", async () => {
    const api = fakeApi();
    renderStudio({ path: "/decisions/listings/48213", api });
    const timeline = await screen.findByRole("list", { name: "Decisions for record 48213" });
    const times = [...timeline.querySelectorAll("time")].map((time) =>
      time.getAttribute("datetime"),
    );
    expect(times).toEqual(
      sampleHistory("listings", "48213")
        .entries.map((entry) => entry.at)
        .reverse(),
    );
  });

  it("opens with the record's status and the latest of each question under Now, and the title line", async () => {
    renderStudio({ path: "/decisions/listings/48213" });
    const now = (await screen.findByRole("heading", { level: 2, name: "Now" })).closest("article");
    expect(now).not.toBeNull();
    // Read from the record by the worker, as facetdb explain reads it: the mockup's "Done, reviewed".
    expect(within(now as HTMLElement).getByText("done, reviewed")).toHaveAttribute(
      "data-status",
      "done",
    );
    expect(now).not.toHaveTextContent("It is not the record's status");
    const lines = within(now as HTMLElement).getAllByRole("listitem");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("is_scam: yes, by hailey");
    expect(lines[1]).toHaveTextContent(
      "category: electronics, by the model. It said electronics, 93% sure",
    );
    const breadcrumb = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(breadcrumb).toHaveTextContent("Decisions, 48213");
    expect(within(breadcrumb).getByRole("link", { name: "Decisions" })).toHaveAttribute(
      "href",
      "/decisions?source=listings",
    );
    expect(document.title).toBe("Why was this decided? · FacetDB");
  });

  it("says an unknown record with the fix the worker gave", async () => {
    const api = fakeApi({
      decisionHistory: () =>
        Promise.reject(
          new ApiError(
            404,
            "unknown_record",
            'FacetDB has no history for record 9 of "listings".',
            "Check the source and the key.",
          ),
        ),
    });
    renderStudio({ path: "/decisions/listings/9", api });
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent('FacetDB has no history for record 9 of "listings".');
    expect(alert).toHaveTextContent("Check the source and the key.");
  });

  it("copies the link inside the click", async () => {
    const { user, copied } = renderStudio({ path: "/decisions/listings/a%2Fb" });
    await screen.findByRole("heading", { level: 2, name: "Now" });
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByText(/Link copied/)).toBeVisible();
    expect(copied).toEqual(["http://127.0.0.1:4040/decisions/listings/a%2Fb"]);
  });

  it("selects the link for the reader when the clipboard refuses", async () => {
    const { user } = renderStudio({
      path: "/decisions/listings/48213",
      clipboard: () => Promise.reject(new Error("denied")),
    });
    await screen.findByRole("heading", { level: 2, name: "Now" });
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    const field = await screen.findByRole("textbox");
    expect(field).toHaveValue("http://127.0.0.1:4040/decisions/listings/48213");
    expect(field).toHaveFocus();
    expect(screen.getByText(/press Ctrl\+C or Cmd\+C/)).toBeVisible();
  });

  it("selects the link too when there is no clipboard at all", async () => {
    const { user } = renderStudio({
      path: "/decisions/listings/48213",
      clipboard: () => {
        throw new TypeError("clipboard is undefined");
      },
    });
    await screen.findByRole("heading", { level: 2, name: "Now" });
    await user.click(screen.getByRole("button", { name: "Copy link" }));
    expect(await screen.findByRole("textbox")).toHaveValue(
      "http://127.0.0.1:4040/decisions/listings/48213",
    );
  });

  it("places the key and the note as text", async () => {
    const api = fakeApi({
      decisionHistory: () =>
        Promise.resolve({
          source: "listings",
          key: "<b>1</b>",
          status: null,
          reviewed: null,
          entries: [
            {
              kind: "human",
              at: "2026-11-06T14:31:00.000Z",
              version: 1,
              stateHash: "h1",
              question: "q",
              wording: "<i>Q?</i>",
              decided: "yes",
              reviewer: "<u>sam</u>",
              note: "<script>alert(1)</script>",
            },
          ],
        }),
    });
    const { container } = renderStudio({ path: "/decisions/listings/%3Cb%3E1%3C%2Fb%3E", api });
    expect(await screen.findByText(/Note: <script>alert\(1\)<\/script>/)).toBeVisible();
    expect(container.querySelector("script,b,i,u")).toBeNull();
  });
});

const SCAM = "Is this listing a scam?";

/**
 * A model answer to is_scam at a state (the hash the model was shown). The tag is the worker's;
 * these fixtures decide nothing but a noul's yes or no, so "needs review" here is only ever that.
 */
function answered(
  at: string,
  said: string,
  decision: string,
  version = 1,
  stateHash = "h1",
): ExplainedEntry {
  return {
    kind: "answer",
    at,
    model: "jev-1.14.0",
    version,
    stateHash,
    answers: [
      {
        question: "is_scam",
        wording: SCAM,
        said,
        decision,
        outcome: decision === "needs review" ? "needs_review" : "decided",
      },
    ],
  };
}

function decided(at: string, value: string, reviewer: string, stateHash = "h1"): ExplainedEntry {
  return {
    kind: "human",
    at,
    version: 1,
    stateHash,
    question: "is_scam",
    wording: SCAM,
    decided: value,
    reviewer,
  };
}

function withdrawn(at: string, reviewer: string, stateHash = "h1"): ExplainedEntry {
  return {
    kind: "withdrawal",
    at,
    version: 1,
    stateHash,
    question: "is_scam",
    wording: SCAM,
    reviewer,
  };
}

/**
 * The lines of the block above the history for a history, as a sighted reader reads them. The
 * record's status is not readable here (a source the worker does not run), unless one is given.
 */
async function standing(
  entries: readonly ExplainedEntry[],
  key = "48213",
  now: Pick<DecisionHistory, "status" | "reviewed"> = { status: null, reviewed: null },
) {
  const api = fakeApi({
    decisionHistory: (source, asked) =>
      Promise.resolve({ source, key: asked, ...now, entries: [...entries] }),
  });
  renderStudio({ path: `/decisions/listings/${encodeURIComponent(key)}`, api });
  const heading = now.status === null ? "What the log says last" : "Now";
  const block = (await screen.findByRole("heading", { level: 2, name: heading })).closest(
    "article",
  );
  const item = within(block as HTMLElement).getByRole("listitem");
  return {
    block: block as HTMLElement,
    item,
    text: sighted(item),
    lines: [...item.querySelectorAll("p")].map((line) => sighted(line)),
  };
}

describe("what the log says last", () => {
  it("shows a person's decision first when the model answered again on the same state", async () => {
    const { text, lines } = await standing([
      answered("2026-11-03T10:00:00.000Z", "58% likely yes", "needs review"),
      decided("2026-11-03T11:00:00.000Z", "yes", "hailey"),
      answered("2026-11-05T09:00:00.000Z", "58% likely yes", "needs review", 2),
    ]);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^is_scam: yes, by hailey, /);
    expect(lines[1]).toMatch(
      /^The model answered again .*: it said 58% likely yes, which the thresholds made needs review\.$/,
    );
    // The state hashes match: the decision stands over the answer, as core keeps it.
    expect(lines[2]).toBe(
      "The record had not changed since hailey decided, so the decision stands.",
    );
    // The answer is never drawn above the decision as if it had replaced it.
    expect(text).not.toContain("is_scam: needs review");
    expect(text).not.toContain("by the model");
  });

  it("puts the model's answer first when the record changed after the decision", async () => {
    const { lines } = await standing([
      answered("2026-11-03T10:00:00.000Z", "58% likely yes", "needs review"),
      decided("2026-11-03T11:00:00.000Z", "yes", "hailey"),
      answered("2026-11-05T09:00:00.000Z", "12% likely yes", "no", 1, "h2"),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^is_scam: no, by the model\. It said 12% likely yes, /);
    expect(lines[1]).toMatch(
      /^hailey decided yes .*; the record changed after that, so the decision no longer stands\.$/,
    );
  });

  it("does not bring back a decision when the record changes back (A, B, A), as core does not", async () => {
    const { lines } = await standing([
      answered("2026-11-03T10:00:00.000Z", "58% likely yes", "needs review"),
      decided("2026-11-03T11:00:00.000Z", "yes", "hailey"),
      answered("2026-11-04T09:00:00.000Z", "58% likely yes", "needs review", 1, "h2"),
      answered("2026-11-05T09:00:00.000Z", "58% likely yes", "needs review", 1, "h1"),
    ]);
    expect(lines[0]).toMatch(/^is_scam: needs review, by the model\./);
    expect(lines[1]).toMatch(/^hailey decided yes .*no longer stands\.$/);
  });

  it("says the record's status when the worker reads it, and that a person decided", async () => {
    const { block } = await standing(
      [answered("2026-11-03T10:00:00.000Z", "58% likely yes", "needs review")],
      "48213",
      { status: "needs_review", reviewed: false },
    );
    // The record's badge, beside the small one the model's answer carries in its line.
    const status = within(block).getByText("needs review", { selector: "[data-size='default']" });
    expect(status).toHaveAttribute("data-status", "needs_review");
    expect(block).not.toHaveTextContent("reviewed");
    expect(block).toHaveTextContent("read from the record itself as facetdb explain reads it");
  });

  it("says when it speaks from the log alone, with the explain command quoted for the shell", async () => {
    const { block } = await standing(
      [answered("2026-11-03T10:00:00.000Z", "27% likely yes", "no")],
      "it's a key",
    );
    expect(screen.queryByRole("heading", { level: 2, name: "Now" })).not.toBeInTheDocument();
    expect(block).toHaveTextContent("The record's status cannot be read here");
    expect(block).toHaveTextContent(
      "facetdb explain listings 'it'\\''s a key' reads the record itself.",
    );
  });

  it("reads a withdrawal as withdrawn, then what the thresholds make of the model's last answer", async () => {
    const { text, lines } = await standing([
      answered("2026-11-03T10:00:00.000Z", "58% likely yes", "needs review"),
      decided("2026-11-03T11:00:00.000Z", "yes", "hailey"),
      withdrawn("2026-11-03T12:00:00.000Z", "hailey"),
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^is_scam: the decision was withdrawn by hailey, /);
    expect(lines[1]).toMatch(
      /^The model's last answer was 58% likely yes, .*; the thresholds make it needs review\.$/,
    );
    expect(text).not.toContain("yes, by hailey");
  });

  it("reads the later of two decisions with an answer between them, and only that one", async () => {
    const { text, lines } = await standing([
      answered("2026-11-03T10:00:00.000Z", "58% likely yes", "needs review"),
      decided("2026-11-03T11:00:00.000Z", "yes", "hailey"),
      answered("2026-11-05T09:00:00.000Z", "40% likely yes", "needs review", 2),
      decided("2026-11-05T10:00:00.000Z", "no", "sam"),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^is_scam: no, by sam, /);
    expect(text).not.toContain("answered again");
    expect(text).not.toContain("hailey");
  });

  it("brings back an earlier reviewer's decision when a later one withdraws their own", async () => {
    const { text, lines } = await standing([
      answered("2026-11-03T10:00:00.000Z", "58% likely yes", "needs review"),
      decided("2026-11-03T11:00:00.000Z", "yes", "amara"),
      decided("2026-11-03T12:00:00.000Z", "no", "bea"),
      withdrawn("2026-11-03T13:00:00.000Z", "bea"),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^is_scam: yes, by amara, /);
    expect(text).not.toContain("withdrawn");
    expect(text).not.toContain("bea");
    expect(text).not.toContain("the thresholds make it");
  });

  it("takes a withdrawal from its own reviewer only", async () => {
    // amara decides, bea withdraws a decision of her own that was never made: amara's yes stands.
    const { lines } = await standing([
      answered("2026-11-03T10:00:00.000Z", "58% likely yes", "needs review"),
      decided("2026-11-03T11:00:00.000Z", "yes", "amara"),
      withdrawn("2026-11-03T13:00:00.000Z", "bea"),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^is_scam: yes, by amara, /);
  });

  it("reads a model answer with no person's decision as the model's", async () => {
    const { lines } = await standing([
      answered("2026-11-03T10:00:00.000Z", "27% likely yes", "no"),
      answered("2026-11-05T09:00:00.000Z", "58% likely yes", "needs review", 2),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^is_scam: needs review, by the model\. It said 58% likely yes, /);
  });

  it("reads an option named 'needs review' that the model decided as a value, not a status", async () => {
    const queue: ExplainedEntry = {
      kind: "answer",
      at: "2026-11-03T10:00:00.000Z",
      model: "jev-1.14.0",
      version: 1,
      stateHash: "h1",
      answers: [
        {
          question: "queue",
          wording: "Which queue should take it?",
          said: "needs review, 80% sure",
          decision: "needs review",
          outcome: "decided",
        },
      ],
    };
    const { item } = await standing([queue]);
    expect(sighted(item)).toMatch(/^queue: needs review, by the model\./);
    expect(item.querySelector("[data-status]")).toBeNull();
    const timeline = screen.getByRole("list", { name: "Decisions for record 48213" });
    expect(timeline.querySelector("[data-status]")).toBeNull();
  });
});

describe("why a record was asked again", () => {
  /** The headline of each model answer in the timeline, oldest first. */
  async function headlines(entries: readonly ExplainedEntry[]) {
    await standing(entries);
    const timeline = screen.getByRole("list", { name: "Decisions for record 48213" });
    return [...timeline.querySelectorAll<HTMLElement>(":scope > li[data-kind='answer']")]
      .reverse()
      .map((entry) => entry.textContent);
  }

  it("says the record changed, the version changed, both, or neither, from the answer before", async () => {
    const said = await headlines([
      answered("2026-11-01T10:00:00.000Z", "27% likely yes", "no", 1, "h1"),
      answered("2026-11-02T10:00:00.000Z", "28% likely yes", "no", 1, "h2"),
      answered("2026-11-03T10:00:00.000Z", "29% likely yes", "no", 2, "h2"),
      // A person's decision between two answers is not the answer before.
      decided("2026-11-03T11:00:00.000Z", "yes", "hailey", "h2"),
      answered("2026-11-04T10:00:00.000Z", "30% likely yes", "no", 3, "h3"),
      answered("2026-11-05T10:00:00.000Z", "31% likely yes", "no", 3, "h3"),
    ]);
    expect(said[0]).toContain("First answer");
    expect(said[1]).toContain("Asked again: the record changed");
    expect(said[1]).not.toContain("under question set");
    expect(said[2]).toContain("Asked again under question set v2");
    expect(said[3]).toContain("Asked again: the record changed, under question set v3");
    expect(said[4]).toMatch(/Asked again(?!:| under)/);
  });
});

describe("a read that fails after a good one", () => {
  const down = () =>
    Promise.reject(
      new ApiError(
        503,
        "unavailable",
        "The worker could not read the log.",
        "Try again in a moment.",
      ),
    );

  it("keeps the log's rows as last read, above them says why, and claims no count or end", async () => {
    let reads = 0;
    const api = fakeApi({
      decisions: () => {
        reads += 1;
        return reads === 1
          ? Promise.resolve({
              decisions: [modelRow("A-1", "2026-11-06T14:00:00.000Z", 0.1)],
              next: null,
            })
          : down();
      },
    });
    const { user } = await openedLog("/decisions?time=all", api);
    expect(screen.getByText("1 decision, newest first. Nothing older.")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Runs" }));
    await screen.findByRole("table", { name: "Runs of every source" });
    await user.click(screen.getByRole("button", { name: "Decisions" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The worker could not read the log.");
    expect(alert).toHaveTextContent("Try again in a moment.");
    const table = screen.getByRole("table", { name: "Decisions of listings" });
    expect(within(table).getByText("A-1")).toBeInTheDocument();
    // The problem is above the table, not below it.
    expect(alert.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/These rows were last read .* and may be out of date\./)).toBeVisible();
    expect(screen.queryByText(/Nothing older/)).not.toBeInTheDocument();
    expect(screen.queryByText(/1 decision/)).not.toBeInTheDocument();
  });

  it("does the same when Show more fails, and Show more tries again", async () => {
    const first: DecisionsPage = {
      decisions: [modelRow("A-1", "2026-11-06T14:00:00.000Z", 0.1)],
      next: "1.1",
    };
    let more = 0;
    const api = fakeApi({
      decisions: (_filters: DecisionFilters, cursor?: string) => {
        if (cursor === undefined) {
          return Promise.resolve(first);
        }
        more += 1;
        return more === 1
          ? down()
          : Promise.resolve({
              decisions: [modelRow("A-2", "2026-11-06T13:00:00.000Z", 0.2)],
              next: null,
            });
      },
    });
    const { user } = await openedLog("/decisions?time=all", api);
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("could not read the log");
    expect(screen.getByText(/These rows were last read/)).toBeVisible();
    expect(screen.queryByText(/decisions?, newest first/)).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByText("2 decisions, newest first. Nothing older.");
    // The next good answer clears the problem.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/last read/)).not.toBeInTheDocument();
  });

  it("keeps the runs as last read", async () => {
    let reads = 0;
    const api = fakeApi({
      runs: () => {
        reads += 1;
        return reads === 1 ? Promise.resolve(SAMPLE_RUNS) : down();
      },
    });
    const { user } = renderStudio({ path: "/decisions?tab=runs", api });
    await screen.findByRole("table", { name: "Runs of every source" });
    await user.click(screen.getByRole("button", { name: "Decisions" }));
    await screen.findByRole("table", { name: "Decisions of listings" });
    await user.click(screen.getByRole("button", { name: "Runs" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The worker could not read the log.");
    const table = screen.getByRole("table", { name: "Runs of every source" });
    expect(within(table).getAllByRole("row")).toHaveLength(SAMPLE_RUNS.runs.length + 1);
    expect(alert.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/These runs were last read .* and may be out of date\./)).toBeVisible();
    expect(screen.queryByText(/newest first/)).not.toBeInTheDocument();
  });

  it("keeps the history as last read", async () => {
    let reads = 0;
    const api = fakeApi({
      decisionHistory: (source, key) => {
        reads += 1;
        return reads === 1 ? Promise.resolve(sampleHistory(source, key)) : down();
      },
    });
    const { user } = renderStudio({ path: "/decisions/listings/48213", api });
    await screen.findByRole("heading", { level: 2, name: "Now" });
    await user.click(
      within(screen.getByRole("navigation", { name: "Breadcrumb" })).getByRole("link", {
        name: "Decisions",
      }),
    );
    const table = await screen.findByRole("table", { name: "Decisions of listings" });
    await user.click(within(table).getAllByRole("link", { name: "48213" })[0] as HTMLElement);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The worker could not read the log.");
    expect(screen.getByRole("heading", { level: 2, name: "Now" })).toBeVisible();
    expect(screen.getByRole("list", { name: "Decisions for record 48213" })).toBeVisible();
    expect(
      screen.getByText(/This history was last read .* and may be out of date\./),
    ).toBeVisible();
  });
});

describe("the scheduler's one-shots (the fake the pages are tested on)", () => {
  it("runs each once, in order, at its time, and counts the ones still waiting", () => {
    const schedule = fakeScheduler(0);
    const ran: string[] = [];
    schedule.after(300, () => ran.push("late"));
    schedule.after(100, () => ran.push("early"));
    const stopped = schedule.after(200, () => ran.push("stopped"));
    schedule.every(150, () => ran.push("tick"));
    expect(schedule.running()).toBe(4);
    stopped();
    schedule.advance(99);
    expect(ran).toEqual([]);
    schedule.advance(1);
    expect(ran).toEqual(["early"]);
    schedule.advance(400);
    // The interval at 150, 300 (after "late"'s own time: ties run in the order they were set), 450.
    expect(ran.filter((name) => name === "tick")).toHaveLength(3);
    expect(ran.filter((name) => name === "late")).toHaveLength(1);
    expect(ran).not.toContain("stopped");
    expect(schedule.now()).toBe(500);
    // The one-shots are spent; the interval still runs.
    expect(schedule.running()).toBe(1);
  });
});

describe("today moves with the clock", () => {
  it("starts again from the new midnight once the day turns, without a reload", async () => {
    const api = fakeApi();
    const { schedule } = renderStudio({
      path: "/decisions",
      api,
      now: new Date(2026, 10, 6, 23, 50),
    });
    await screen.findByRole("table", { name: "Decisions of listings" });
    expect(asked(api.calls).at(-1)).toEqual({
      source: "listings",
      from: new Date(2026, 10, 6).toISOString(),
    });
    // One tick is set for a second past midnight: ten minutes and a second away.
    act(() => {
      schedule.advance(10 * 60_000);
    });
    expect(asked(api.calls)).toHaveLength(1);
    act(() => {
      schedule.advance(1000);
    });
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({
        source: "listings",
        from: new Date(2026, 10, 7).toISOString(),
      });
    });
  });
});

describe("a key as the person wrote it", () => {
  it.each(["1e3", "1.0", "9007199254740993", "true", "null", "0042"])(
    "searches %s as the text it is",
    async (written) => {
      const api = fakeApi();
      renderStudio({ path: `/decisions?time=all&q=${written}`, api });
      await screen.findByRole("table", { name: "Decisions of listings" });
      expect(asked(api.calls)).toEqual([{ source: "listings", key: written }]);
      expect(screen.getByRole("textbox", { name: "Record key" })).toHaveValue(written);
    },
  );

  it("reads the question and the reviewer as written too", async () => {
    const api = fakeApi();
    renderStudio({ path: "/decisions?time=all&question=1e3&reviewer=true", api });
    await screen.findByRole("textbox", { name: "Question" });
    await waitFor(() => {
      expect(asked(api.calls)).toEqual([{ source: "listings", question: "1e3", reviewer: "true" }]);
    });
  });

  it("keeps a typed number-like key through the address and back", async () => {
    const api = fakeApi();
    const { user } = await openedLog("/decisions?time=all", api);
    await user.type(screen.getByRole("textbox", { name: "Record key" }), "1e3{Enter}");
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toEqual({ source: "listings", key: "1e3" });
    });
    expect(screen.getByRole("textbox", { name: "Record key" })).toHaveValue("1e3");
    // Another change keeps the key, as written.
    await user.click(screen.getByRole("button", { name: "30 days" }));
    await waitFor(() => {
      expect(asked(api.calls).at(-1)).toMatchObject({ source: "listings", key: "1e3" });
    });
  });
});

describe("the run log's pages", () => {
  const empty = ({ page }: { readonly page: number }) =>
    Promise.resolve({ ...SAMPLE_RUNS, page, runs: [], more: false });

  it("offers the first page from one past the end, and from further back", async () => {
    const api = fakeApi({ runs: empty });
    const { user, history } = renderStudio({ path: "/decisions?tab=runs&page=7", api });
    expect(await screen.findByText("No runs on this page.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "First page" }));
    await waitFor(() => {
      expect(runsAsked(api.calls).at(-1)).toEqual({ page: 1 });
    });
    expect(history.location.search).not.toContain("page");
  });

  it("offers no first page on the second page, where Newer runs is the first page", async () => {
    const api = fakeApi({
      runs: ({ page }) => Promise.resolve({ ...SAMPLE_RUNS, page, more: true }),
    });
    renderStudio({ path: "/decisions?tab=runs&page=2", api });
    await screen.findByRole("table", { name: "Runs of every source" });
    expect(screen.queryByRole("button", { name: "First page" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Newer runs" })).toBeVisible();
  });

  it("offers it from the fourth page, with data", async () => {
    const api = fakeApi({
      runs: ({ page }) => Promise.resolve({ ...SAMPLE_RUNS, page, more: true }),
    });
    renderStudio({ path: "/decisions?tab=runs&page=4", api });
    expect(await screen.findByRole("button", { name: "First page" })).toBeVisible();
  });

  it("lists two runs that share a start, a source and a kind as two rows", async () => {
    const run = SAMPLE_RUNS.runs[0] as (typeof SAMPLE_RUNS.runs)[number];
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const api = fakeApi({ runs: () => Promise.resolve({ ...SAMPLE_RUNS, runs: [run, run] }) });
      renderStudio({ path: "/decisions?tab=runs", api });
      const table = await screen.findByRole("table", { name: "Runs of every source" });
      expect(within(table).getAllByRole("row")).toHaveLength(3);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("times and their zone", () => {
  const ZONE = /Times are in your time zone \(.+\); hold the pointer on one to read it in UTC/;

  it("titles each time with the UTC time explain prints, and names the zone once under the table", async () => {
    await openedLog();
    const table = screen.getByRole("table", { name: "Decisions of listings" });
    expect(table.querySelector("time")).toHaveAttribute("title", "2026-11-06 14:31 UTC");
    expect(screen.getAllByText(ZONE)).toHaveLength(1);
  });

  it("does the same for the runs", async () => {
    renderStudio({ path: "/decisions?tab=runs" });
    const table = await screen.findByRole("table", { name: "Runs of every source" });
    expect(table.querySelector("time")).toHaveAttribute("title", "2026-11-06 14:14 UTC");
    expect(screen.getAllByText(ZONE)).toHaveLength(1);
  });

  it("does the same for the timeline, which says it reads newest first", async () => {
    renderStudio({ path: "/decisions/listings/48213" });
    const timeline = await screen.findByRole("list", { name: "Decisions for record 48213" });
    const titles = [...timeline.querySelectorAll("time")].map((time) => time.getAttribute("title"));
    expect(titles).toEqual([
      "2026-11-06 14:31 UTC",
      "2026-11-06 14:14 UTC",
      "2026-11-03 10:02 UTC",
    ]);
    expect(screen.getAllByText(ZONE)).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 2, name: "History, newest first" })).toBeVisible();
  });

  it("says in the lede what the page shows", async () => {
    renderStudio({ path: "/decisions/listings/48213" });
    const lede = await screen.findByText(/^The history of 48213 in listings:/);
    expect(lede).toHaveTextContent(
      "the wording and question set version of each, and the model of each answer",
    );
    expect(lede).not.toHaveTextContent("thresholds in force");
  });
});

describe("the client", () => {
  it("reads the source names from the config, which touches no source database", async () => {
    const urls: string[] = [];
    const client = createApiClient((input) => {
      urls.push(input);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "jev-1.14.0",
            sources: [{ name: "listings" }, { name: "orders" }],
          }),
          {
            status: 200,
          },
        ),
      );
    });
    expect(await client.sourceNames()).toEqual(["listings", "orders"]);
    expect(urls).toEqual(["/v1/config"]);
  });

  it("encodes the log's filters and a record key once", async () => {
    const urls: string[] = [];
    const answer = (body: unknown) =>
      Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
    const client = createApiClient((input) => {
      urls.push(input);
      if (input.includes("/runs")) {
        return answer({ ...SAMPLE_RUNS });
      }
      if (input.startsWith("/v1/decisions/")) {
        return answer(sampleHistory("listings", "x"));
      }
      return answer(SAMPLE_DECISIONS);
    });
    await client.decisions(
      {
        source: "listings",
        key: "a b&c",
        status: "needs_review",
        from: "2026-11-06T00:00:00.000Z",
      },
      "1.2",
    );
    await client.decisionHistory("listings", "a/b c%25d");
    await client.runs({ source: "listings", page: 2 });
    await client.runs({ page: 1 });
    expect(urls).toEqual([
      "/v1/decisions?source=listings&key=a%20b%26c&status=needs_review&from=2026-11-06T00%3A00%3A00.000Z&cursor=1.2",
      "/v1/decisions/listings/a%2Fb%20c%2525d",
      "/v1/runs?source=listings&page=2",
      "/v1/runs?page=1",
    ]);
  });

  it("refuses an answer that is not the shape the page reads", async () => {
    const client = createApiClient(() =>
      Promise.resolve(
        new Response(JSON.stringify({ decisions: [{ kind: "answer" }] }), { status: 200 }),
      ),
    );
    await expect(client.decisions({ source: "listings" })).rejects.toMatchObject({
      code: "unexpected-answer",
    });
  });
});

describe("the view in the address", () => {
  it("keeps only values that are choices", () => {
    expect(
      decisionsSearch({
        tab: "runs",
        source: "listings",
        q: "48213",
        status: "decided",
        time: "week",
        question: "  is_scam ",
        reviewer: "",
        page: "4",
      }),
    ).toEqual({
      tab: "runs",
      source: "listings",
      q: "48213",
      status: "decided",
      time: "week",
      question: "is_scam",
      page: 4,
    });
    expect(
      decisionsSearch({
        tab: 3,
        source: "../etc",
        q: { a: 1 },
        status: "gone",
        time: "today",
        page: 1.5,
      }),
    ).toEqual({});
    // The router hands the text keys over as written; a number or a flag there is not text.
    expect(decisionsSearch({ q: 1000, question: true })).toEqual({});
    // A page only means something on the run log.
    expect(decisionsSearch({ page: 3 })).toEqual({});
    expect(decisionsSearch({ tab: "runs", page: 1e20 })).toEqual({ tab: "runs" });
  });

  it("keeps a range of two times in order, setting the time choice aside, and nothing else", () => {
    const from = "2026-11-14T09:30:00.000Z";
    const to = "2026-11-14T09:31:00.000Z";
    expect(decisionsSearch({ time: "week", from, to })).toEqual({ from, to });
    expect(decisionsSearch({ from: "2026-11-14T11:30:00+02:00", to })).toEqual({ from, to });
    expect(narrowed({ from, to })).toBe(true);
    for (const raw of [
      { from },
      { from: to, to: from },
      { from, to: from },
      { from: "yesterday", to },
      { from: "2026-11-14", to },
      { from: 1_700_000_000_000, to },
    ]) {
      expect(decisionsSearch(raw)).toEqual({});
    }
  });

  it("goes back to the first page when anything but the page changes", () => {
    const runs = { tab: "runs" as const, source: "listings", page: 3 };
    expect(patched(runs, { source: "orders" })).toEqual({ tab: "runs", source: "orders" });
    expect(patched(runs, { page: 4 })).toEqual({ ...runs, page: 4 });
    expect(patched(runs, { tab: undefined })).toEqual({ source: "listings" });
    expect(narrowed({})).toBe(true);
    expect(narrowed({ time: "all" })).toBe(false);
    expect(narrowed({ time: "all", reviewer: "sam" })).toBe(true);
  });

  it("counts the four time choices from the clock", () => {
    const now = new Date(2026, 10, 6, 14, 40);
    expect(timeStart("today", now)).toEqual(new Date(2026, 10, 6));
    expect(timeStart("week", now)?.getTime()).toBe(now.getTime() - 7 * DAY_MS);
    expect(timeStart("month", now)?.getTime()).toBe(now.getTime() - 30 * DAY_MS);
    expect(timeStart("all", now)).toBeUndefined();
  });
});

describe("the words of the table", () => {
  it("says a time in the zone of the machine, relative to now", () => {
    const now = new Date(2026, 10, 6, 14, 40);
    expect(whenWords(new Date(2026, 10, 6, 14, 31), now)).toBe("2:31 pm");
    expect(whenWords(new Date(2026, 10, 6, 14, 31, 7), now, { seconds: true })).toBe("2:31:07 pm");
    expect(whenWords(new Date(2026, 10, 5, 23, 2), now)).toBe("yesterday 11:02 pm");
    expect(whenWords(new Date(2026, 10, 3, 10, 2), now)).toBe("Nov 3, 10:02 am");
    expect(whenWords(new Date(2025, 11, 31, 0, 5), now)).toBe("Dec 31, 2025, 12:05 am");
  });

  it("says how long a run took", () => {
    const at = new Date(2026, 10, 6, 14, 0, 0);
    expect(tookWords(at, new Date(at.getTime() + 800))).toBe("0.8 s");
    expect(tookWords(at, new Date(at.getTime() + 11_400))).toBe("11.4 s");
    expect(tookWords(at, new Date(at.getTime() + 125_000))).toBe("2 min 5 s");
  });

  it("says what the model said as explain does", () => {
    expect(
      saidOf({
        type: "noul",
        probability: 0.58,
        decision: "needs review",
        outcome: "needs_review",
      }),
    ).toEqual({
      figure: 0.58,
      words: "likely yes",
      label: "58% likely yes",
    });
    // Three options, the top at 0.95: (0.95 - 1/3) / (2/3) = 0.925, 93% sure.
    expect(
      saidOf({
        type: "choice",
        top: "electronics",
        probabilities: [0.95, 0.03, 0.02],
        decision: "electronics",
        outcome: "decided",
      }).label,
    ).toBe("electronics, 93% sure");
    expect(
      saidOf({
        type: "score",
        probabilities: [0.1, 0.2, 0.7],
        confidence: 0.48,
        value: "high",
        decision: "high",
        outcome: "decided",
      }).label,
    ).toBe("high, 48% sure");
    // The row names the most likely level even when the thresholds left it to a person.
    expect(
      saidOf({
        type: "score",
        probabilities: [0.1, 0.2, 0.7],
        confidence: 0.48,
        value: "high",
        decision: "needs review",
        outcome: "needs_review",
      }).words,
    ).toBe("high");
    // A version the worker no longer keeps has no levels to name it by: only its place.
    expect(
      saidOf({
        type: "score",
        probabilities: [0.1, 0.2, 0.7],
        confidence: 0.48,
        value: "",
        decision: "unknown",
        outcome: "unknown",
      }).words,
    ).toBe("leans to level 3 of 3");
  });

  it("makes lines of a model call per question and of a person's decision as it is", () => {
    const lines = logLines(SAMPLE_DECISIONS.decisions, undefined);
    expect(lines.map((line) => line.id)).toEqual([
      "0:is_scam",
      "1:is_scam",
      "1:category",
      "2:is_scam",
    ]);
    expect(lines.at(0)?.by).toEqual({ kind: "person", reviewer: "hailey" });
    expect(logLines(SAMPLE_DECISIONS.decisions, "category").map((line) => line.id)).toEqual([
      "1:category",
    ]);
    expect(lines.map((line) => line.outcome)).toEqual([
      "decided",
      "needs_review",
      "decided",
      "decided",
    ]);
  });

  it("reads the share at the end of a said sentence", () => {
    expect(shareOf("58% likely yes")).toBe(0.58);
    expect(shareOf("billing, 82% sure")).toBe(0.82);
    expect(shareOf("50% off, 82% sure")).toBe(0.82);
    expect(shareOf("unknown")).toBeUndefined();
  });
});
