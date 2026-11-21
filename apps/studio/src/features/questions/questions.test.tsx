import { act, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  type ApplyDiff,
  type ApplyWritten,
  type ConfigSource,
  createApiClient,
  type DraftPreview,
  type ProjectConfig,
  type SourceDraft,
  type TestResult,
} from "../../api/index.ts";
import {
  type FakeApi,
  fakeApi,
  renderStudio,
  SAMPLE_APPLIED,
  SAMPLE_APPLY_DIFF,
  SAMPLE_PREVIEW,
  SAMPLE_PROJECT_CONFIG,
  SAMPLE_TEST_RESULT,
} from "../../testing/index.ts";
import { decidedWords, figureOf, previewColumns, previewLines } from "./answers.ts";
import {
  draftOf,
  formOf,
  movedOverride,
  nameProblem,
  newQuestion,
  previewKey,
  reconcile,
  rewordedQuestions,
  type SourceForm,
  thresholdsOf,
} from "./draft.ts";
import { PREVIEW_SETTLE_MS } from "./preview.ts";
import { issuePlace } from "./words.ts";

/**
 * The Questions page on happy-dom with the fake API client and the fake scheduler: the form per
 * question, the loader's judgement one call after the typing settles, the live preview only after a
 * first click and then 1.5 s after an edit (never for a cut line, never over a newer draft), Test
 * asking the estimate before it spends, and Apply writing only the plan of the diff it showed.
 */

/** The drafts a method was sent, in order, from the fake's notes. */
function sent(api: FakeApi, method: string): SourceDraft[] {
  return api.calls
    .filter((call) => call.startsWith(`${method} `))
    .map((call) => JSON.parse(call.slice(method.length + 1)) as SourceDraft);
}

function listings(drafts: readonly SourceDraft[]): SourceDraft[] {
  return drafts.filter((draft) => draft.name === "listings");
}

/** The words the loader prints for a counting question (packages/facetdb, config/warnings.ts). */
const COUNTING = {
  source: "listings",
  question: "is_scam",
  code: "counting",
  message:
    'The question "is_scam" asks the model to count or compare an amount. The model does not count reliably and is weak on numbers.',
  fix: "Compute the number in SQL and pass it as a state field, then compare it in a view or an action condition instead of asking the model to count.",
};

async function opened(options: { api?: FakeApi; strict?: boolean; path?: string } = {}) {
  const api = options.api ?? fakeApi();
  const studio = renderStudio({
    path: options.path ?? "/questions",
    api,
    ...(options.strict === undefined ? {} : { strict: options.strict }),
  });
  await screen.findByRole("article", { name: "is_scam" });
  return { ...studio, api };
}

const question = (name: string) => screen.getByRole("article", { name });

/** The draft a form sends; the test fails if a name problem stands. */
function sendable(form: SourceForm): SourceDraft {
  const draft = draftOf(form);
  if (draft === undefined) {
    throw new Error("the form's names hold");
  }
  return draft;
}

/** The sample's listings source, the first of its config. */
function sampleListings(): ConfigSource {
  const [listing] = SAMPLE_PROJECT_CONFIG.sources;
  if (listing === undefined) {
    throw new Error("the sample has the listings source");
  }
  return listing;
}

function advance(studio: { schedule: { advance: (ms: number) => void } }, ms: number) {
  act(() => {
    studio.schedule.advance(ms);
  });
}

/** The preview asked, answered, and its fill played out. */
async function previewed(studio: Awaited<ReturnType<typeof opened>>) {
  await studio.user.click(screen.getByRole("button", { name: "Preview 20 rows" }));
  await screen.findByRole("table", { name: "Live preview of listings" });
  advance(studio, 2_000);
}

describe("the Questions page", () => {
  it("shows a tab per source and the form per question: kind and stakes in words, the question, its criteria or options, the versions", async () => {
    await opened();
    expect(screen.getAllByRole("tab").map((tab) => tab.textContent)).toEqual([
      "listings",
      "support_messages",
    ]);
    expect(screen.getByRole("tab", { name: "listings" })).toHaveAttribute("aria-selected", "true");

    const scam = question("is_scam");
    expect(within(scam).getByText("Yes or no, high stakes")).toBeInTheDocument();
    expect(within(scam).getByRole("textbox", { name: "Question" })).toHaveValue(
      "Is this listing likely a scam?",
    );
    expect(within(scam).getByRole("textbox", { name: "Yes when" })).toHaveValue(
      "A price far below market, payment outside the platform, a seller a few days old, urgency.",
    );
    expect(within(scam).getByRole("textbox", { name: "No when" })).toHaveValue(
      "A plausible price, a seller with history, ordinary payment.",
    );
    expect(
      within(scam).getByRole("combobox", { name: "What happens when the answer is wrong?" }),
    ).toHaveTextContent("high stakes, decide only when 90% sure");
    expect(within(scam).getByRole("slider", { name: "Yes at or above" })).toHaveAttribute(
      "aria-valuetext",
      "90%",
    );

    const category = question("category");
    expect(within(category).getByText("Pick one, low stakes")).toBeInTheDocument();
    expect(within(category).getByRole("textbox", { name: "option 1, its name" })).toHaveValue(
      "electronics",
    );
    expect(
      within(category).getByRole("textbox", { name: "option 5, the line the model reads" }),
    ).toHaveValue("anything that fits none of the above");
    expect(
      within(category).getByRole("slider", { name: "Decide when confident at least" }),
    ).toHaveAttribute("aria-valuetext", "50%");

    const versions = screen.getByRole("list", { name: "Question-set versions of listings" });
    const entries = within(versions).getAllByRole("listitem");
    expect(entries.map((entry) => entry.textContent)).toEqual([
      expect.stringContaining("Version 3, in force"),
      expect.stringContaining("Version 2"),
      expect.stringContaining("Version 1"),
    ]);
    expect(entries[0]).toHaveTextContent("The wording and the criteria of is_scam");
    expect(entries[1]).toHaveTextContent("category added");
    expect(entries[0]?.querySelector("time")).toHaveAttribute(
      "datetime",
      "2026-11-02T09:40:00.000Z",
    );
  });

  it("keeps the open tab in the address and the drafts of the others while the tabs change", async () => {
    const studio = await opened();
    const box = within(question("is_scam")).getByRole("textbox", { name: "Question" });
    await studio.user.clear(box);
    await studio.user.type(box, "Is it a scam?");

    await studio.user.click(screen.getByRole("tab", { name: "support_messages" }));
    expect(await screen.findByRole("article", { name: "urgency" })).toBeInTheDocument();
    expect(studio.history.location.search).toContain("source=support_messages");
    expect(
      within(question("urgency")).getByText("Rate on a scale, low stakes"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "is_scam" })).toBeNull();

    // The arrows move along the tabs, and the typed draft is still there.
    screen.getByRole("tab", { name: "support_messages" }).focus();
    await studio.user.keyboard("{ArrowLeft}");
    expect(screen.getByRole("tab", { name: "listings" })).toHaveFocus();
    expect(within(question("is_scam")).getByRole("textbox", { name: "Question" })).toHaveValue(
      "Is it a scam?",
    );
  });

  it("asks the loader once after the typing settles, and shows its warning in the words facetdb preview prints", async () => {
    const api = fakeApi({
      validateDraft: (draft) =>
        Promise.resolve(
          JSON.stringify(draft).includes("How many")
            ? { valid: true, issues: [], warnings: [COUNTING] }
            : { valid: true, issues: [], warnings: [] },
        ),
    });
    const studio = await opened({ api });
    await screen.findByText("No warnings.");
    const before = listings(sent(api, "validateDraft")).length;

    const box = within(question("is_scam")).getByRole("textbox", { name: "Question" });
    await studio.user.clear(box);
    await studio.user.type(box, "How many photos does it have?");
    advance(studio, PREVIEW_SETTLE_MS - 1);
    expect(listings(sent(api, "validateDraft"))).toHaveLength(before);
    advance(studio, 1);

    await waitFor(() => {
      expect(listings(sent(api, "validateDraft"))).toHaveLength(before + 1);
    });
    expect(listings(sent(api, "validateDraft")).at(-1)?.questions["is_scam"]).toMatchObject({
      instructions: "How many photos does it have?",
    });
    expect(await screen.findByText(COUNTING.message)).toBeInTheDocument();
    expect(screen.getByText(`Fix: ${COUNTING.fix}`)).toBeInTheDocument();
    expect(screen.getByText("One warning.")).toBeInTheDocument();
    // The model was never asked: the judgement is the loader's.
    expect(sent(api, "previewDraft")).toEqual([]);
  });

  it("ties a problem to its field and says the count once", async () => {
    const api = fakeApi({
      validateDraft: () =>
        Promise.resolve({
          valid: false,
          issues: [
            {
              path: "sources[0].questions.is_scam.instructions",
              message: "instructions must not be blank",
            },
          ],
          warnings: [],
        }),
    });
    await opened({ api });
    const box = within(question("is_scam")).getByRole("textbox", { name: "Question" });
    await waitFor(() => {
      expect(box).toHaveAttribute("aria-invalid", "true");
    });
    expect(box).toHaveAccessibleDescription("instructions must not be blank");
    // The open tab's panel: the other source's panel is hidden.
    expect(
      within(screen.getByRole("tabpanel")).getByText(
        "The draft has one problem: fix it before testing or applying.",
      ),
    ).toHaveAttribute("role", "status");
  });

  it("marks a new question named like one in the file under its name, and sends nothing while it stands", async () => {
    const studio = await opened();
    await previewed(studio);
    const asked = () =>
      studio.api.calls.filter(
        (call) =>
          !call.startsWith("project") && !call.startsWith("home") && !call.startsWith("review"),
      ).length;
    const before = asked();

    await studio.user.click(screen.getByRole("button", { name: "Add a question" }));
    const added = screen.getByRole("article", { name: "New question: question_3" });
    const name = within(added).getByRole("textbox", { name: "Name, the column's name" });
    await studio.user.clear(name);
    await studio.user.type(name, "is_scam");
    const words =
      '"is_scam" is already the name of another question of this source: give this one a name of its own.';
    expect(name).toHaveAttribute("aria-invalid", "true");
    expect(name).toHaveAccessibleDescription(words);
    // The question in the file is untouched, and nothing can be asked, tested or written.
    expect(within(question("is_scam")).getByRole("textbox", { name: "Question" })).toHaveValue(
      "Is this listing likely a scam?",
    );
    expect(screen.getByRole("button", { name: "Preview again" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply" })).toHaveAccessibleDescription(
      "Test and Apply wait until every question has a name of its own and its cut lines in order: see the question marked in the form.",
    );
    advance(studio, 10_000);
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked()).toBe(before);

    // An empty name is marked the same way, and still nothing is sent.
    await studio.user.clear(name);
    expect(name).toHaveAccessibleDescription(
      "Give the question a name: it becomes the name of its column.",
    );
    advance(studio, 10_000);
    await act(async () => {
      await Promise.resolve();
    });
    expect(asked()).toBe(before);

    // A name of its own opens the way again.
    await studio.user.type(name, "is_fake");
    expect(name).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("keeps a cut set by hand through a change of the stakes, says it overrides them, and goes back to the default only when asked", async () => {
    const [listing, ...others] = SAMPLE_PROJECT_CONFIG.sources;
    if (listing === undefined) {
      throw new Error("the sample has the listings source");
    }
    const handSet: ProjectConfig = {
      ...SAMPLE_PROJECT_CONFIG,
      sources: [{ ...listing, thresholds: { is_scam: { yesAbove: 0.95 } } }, ...others],
    };
    const api = fakeApi({ projectConfig: () => Promise.resolve(handSet) });
    const studio = await opened({ api });
    await previewed(studio);
    const scam = () => question("is_scam");
    const stakes = async (key: "{ArrowDown}" | "{ArrowUp}") => {
      act(() => {
        within(scam())
          .getByRole("combobox", { name: "What happens when the answer is wrong?" })
          .focus();
      });
      await studio.user.keyboard("{ArrowDown}");
      await studio.user.keyboard(key);
      await studio.user.keyboard("{Enter}");
    };
    expect(
      within(scam()).getByText(/A cut set by hand overrides the stakes' default/),
    ).toHaveTextContent(
      "A cut set by hand overrides the stakes' default: yes at or above 95%. At high stakes the default is yes at or above 90%, no at or below 10%.",
    );

    await stakes("{ArrowDown}");
    expect(within(scam()).getByText("Yes or no, low stakes")).toBeInTheDocument();
    expect(within(scam()).getByRole("slider", { name: "Yes at or above" })).toHaveAttribute(
      "aria-valuetext",
      "95%",
    );
    expect(within(scam()).getByText(/A cut set by hand/)).toHaveTextContent(
      "A cut set by hand overrides the stakes' default: yes at or above 95%. At low stakes the default is yes at or above 70%, no at or below 30%.",
    );
    // The stakes are not read by the model: choosing them asks no preview.
    advance(studio, 10_000);
    expect(sent(api, "previewDraft")).toHaveLength(1);

    await stakes("{ArrowUp}");
    expect(within(scam()).getByText("Yes or no, high stakes")).toBeInTheDocument();
    // High, then low, then high again: the draft is the file's, the override untouched.
    expect(screen.queryByRole("button", { name: "Discard my edits" })).toBeNull();
    advance(studio, PREVIEW_SETTLE_MS);
    await waitFor(() => {
      expect(listings(sent(api, "validateDraft")).at(-1)?.thresholds).toEqual({
        is_scam: { yesAbove: 0.95 },
      });
    });

    await studio.user.click(
      within(scam()).getByRole("button", { name: "Use the stakes' default" }),
    );
    expect(within(scam()).getByRole("slider", { name: "Yes at or above" })).toHaveAttribute(
      "aria-valuetext",
      "90%",
    );
    expect(within(scam()).queryByText(/A cut set by hand/)).toBeNull();
  });

  it("sends no preview when the config changes under a draft nobody edited; the rows say so and wait", async () => {
    let answer: ProjectConfig = SAMPLE_PROJECT_CONFIG;
    const api = fakeApi({ projectConfig: () => Promise.resolve(answer) });
    const studio = await opened({ api });
    await previewed(studio);
    const listing = sampleListings();
    answer = {
      ...SAMPLE_PROJECT_CONFIG,
      sources: [
        {
          ...listing,
          questions: {
            ...listing.questions,
            is_scam: { type: "noul", instructions: "Is it a fake?", stakes: "high" },
          },
        },
        ...SAMPLE_PROJECT_CONFIG.sources.slice(1),
      ],
    };
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
    });
    await waitFor(() => {
      expect(within(question("is_scam")).getByRole("textbox", { name: "Question" })).toHaveValue(
        "Is it a fake?",
      );
    });
    advance(studio, 10_000);
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent(api, "previewDraft")).toHaveLength(1);
    expect(
      screen.getByText(
        'These rows were answered for an earlier configuration of listings; "Preview again" answers them for the questions as they are now.',
      ),
    ).toBeInTheDocument();

    // A cut line moved now is an edit of the person's, but not of what the model reads: the wording
    // the config brought is still not sent.
    act(() => {
      within(question("is_scam")).getByRole("slider", { name: "No at or below" }).focus();
    });
    await studio.user.keyboard("{ArrowRight}");
    advance(studio, 10_000);
    await act(async () => {
      await Promise.resolve();
    });
    expect(sent(api, "previewDraft")).toHaveLength(1);
  });

  it("flags cut lines a stakes change crossed at once: no rows decided under them, nothing sent until they are in order", async () => {
    const listing = sampleListings();
    const handSet: ProjectConfig = {
      ...SAMPLE_PROJECT_CONFIG,
      sources: [
        { ...listing, thresholds: { is_scam: { yesAbove: 0.2 } } },
        ...SAMPLE_PROJECT_CONFIG.sources.slice(1),
      ],
    };
    const api = fakeApi({ projectConfig: () => Promise.resolve(handSet) });
    const studio = await opened({ api });
    await previewed(studio);
    const scam = () => question("is_scam");
    const callsBefore = api.calls.length;

    // High stakes to low: the default no at or below 30% now sits above the hand-set yes at 20%.
    act(() => {
      within(scam())
        .getByRole("combobox", { name: "What happens when the answer is wrong?" })
        .focus();
    });
    await studio.user.keyboard("{ArrowDown}");
    await studio.user.keyboard("{ArrowDown}");
    await studio.user.keyboard("{Enter}");

    expect(
      within(scam()).getByText(
        "The cut lines cross: no at or below 30% is not lower than yes at or above 20%. A cut set by hand stays when the stakes change: use the stakes' default, or choose the stakes again.",
      ),
    ).toBeInTheDocument();
    expect(within(scam()).queryByRole("slider")).toBeNull();
    expect(screen.getByRole("button", { name: "Test" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Apply" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Preview again" })).toBeDisabled();
    const table = screen.getByRole("table", { name: "Live preview of listings" });
    const first = within(within(table).getAllByRole("row")[1] as HTMLElement).getAllByRole("cell");
    expect(first[2]).toHaveTextContent("");
    expect(first[6]).toHaveTextContent("pending");
    expect(
      screen.getByText(
        "Nothing is decided under cut lines that cross: the rows are decided again once they are in order.",
      ),
    ).toBeInTheDocument();
    advance(studio, 10_000);
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      api.calls
        .slice(callsBefore)
        .filter((call) => /^(validateDraft|previewDraft|testEstimate|applyDiff) /.test(call)),
    ).toEqual([]);

    await studio.user.click(
      within(scam()).getByRole("button", { name: "Use the stakes' default" }),
    );
    expect(within(scam()).getByRole("slider", { name: "Yes at or above" })).toHaveAttribute(
      "aria-valuetext",
      "70%",
    );
    expect(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
  });

  it("shows a history the store could not give as the worker's note", async () => {
    const api = fakeApi({
      projectConfig: () =>
        Promise.resolve({
          ...SAMPLE_PROJECT_CONFIG,
          versions: {
            ...SAMPLE_PROJECT_CONFIG.versions,
            listings: {
              inForce: 3,
              earlier: false,
              versions: [],
              note: "The version history of listings could not be read from the store. The questions shown are the worker's own, as it runs them; the worker's output says why.",
            },
          },
        }),
    });
    await opened({ api });
    expect(
      within(screen.getByRole("tabpanel")).getByText(
        "The version history of listings could not be read from the store. The questions shown are the worker's own, as it runs them; the worker's output says why.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/No version yet/)).toBeNull();
  });

  it("sends no preview from a mount, a StrictMode remount or the clock; the first is the person's click, with its cost", async () => {
    const studio = await opened({ strict: true });
    advance(studio, 60_000);
    expect(sent(studio.api, "previewDraft")).toEqual([]);
    expect(screen.queryByRole("table", { name: "Live preview of listings" })).toBeNull();

    await previewed(studio);
    expect(listings(sent(studio.api, "previewDraft"))).toHaveLength(1);
    const table = screen.getByRole("table", { name: "Live preview of listings" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((header) => header.textContent),
    ).toEqual(["title", "price", "is_scam", "Likely yes", "category", "Sure", "Status"]);
    const rows = within(table).getAllByRole("row").slice(1);
    const first = within(rows[0] as HTMLElement).getAllByRole("cell");
    expect(first[0]).toHaveTextContent("iPhone 15 Pro");
    expect(first[2]).toHaveTextContent("unsure");
    expect(first[3]).toHaveTextContent("58%");
    expect(first[4]).toHaveTextContent("electronics");
    expect(first[6]).toHaveTextContent("needs review");
    expect(within(rows[5] as HTMLElement).getAllByRole("cell")[0]).toHaveTextContent(
      "48140: left out by the source's where filter",
    );
    expect(screen.getByText(/answered for \$0\.0002 \(3,750 input tokens\)/)).toBeInTheDocument();
    expect(screen.getByText(/2 of 5 answered rows decided automatically/)).toBeInTheDocument();
  });

  it("moves a cut line on the page: the counts and the rows change, and nothing asks the model", async () => {
    const studio = await opened();
    await previewed(studio);
    const scam = question("is_scam");
    expect(
      within(scam).getByText("of 5 decided automatically", { exact: false }),
    ).toHaveTextContent("3 of 5 decided automatically");

    // No at or below 10% → 13%: the 12% answer is now decided no.
    act(() => {
      within(scam).getByRole("slider", { name: "No at or below" }).focus();
    });
    await studio.user.keyboard("{ArrowRight}{ArrowRight}{ArrowRight}");
    expect(within(scam).getByRole("slider", { name: "No at or below" })).toHaveAttribute(
      "aria-valuetext",
      "13%",
    );
    expect(
      within(scam).getByText("of 5 decided automatically", { exact: false }),
    ).toHaveTextContent("4 of 5 decided automatically");
    const table = screen.getByRole("table", { name: "Live preview of listings" });
    const ps5 = within(table).getAllByRole("row")[4] as HTMLElement;
    expect(within(ps5).getAllByRole("cell")[2]).toHaveTextContent("no");
    expect(within(ps5).getAllByRole("cell")[6]).toHaveTextContent("done");

    advance(studio, 10_000);
    expect(sent(studio.api, "previewDraft")).toHaveLength(1);
    // The draft carries the moved line alone (the other stays the stakes' default, unwritten), and
    // the loader judged it: free, no model.
    await waitFor(() => {
      expect(listings(sent(studio.api, "validateDraft")).at(-1)?.thresholds["is_scam"]).toEqual({
        noBelow: 0.13,
      });
    });
  });

  it("previews again 1.5 s after an edit once the first was asked, and never paints an older draft's rows over a newer one", async () => {
    const pending: ((preview: DraftPreview) => void)[] = [];
    const api = fakeApi({
      previewDraft: () =>
        new Promise((resolve) => {
          pending.push(resolve);
        }),
    });
    const studio = await opened({ api });
    await studio.user.click(screen.getByRole("button", { name: "Preview 20 rows" }));
    expect(pending).toHaveLength(1);

    const box = within(question("is_scam")).getByRole("textbox", { name: "Question" });
    await studio.user.type(box, " Really?");
    // The first run answers after the draft moved on: counted, never painted.
    await act(async () => {
      pending[0]?.(SAMPLE_PREVIEW);
      await Promise.resolve();
    });
    expect(screen.queryByRole("table", { name: "Live preview of listings" })).toBeNull();

    // A mutation calls its function after a few microtasks: flush them before counting.
    advance(studio, PREVIEW_SETTLE_MS - 1);
    await act(async () => {
      await Promise.resolve();
    });
    expect(pending).toHaveLength(1);
    advance(studio, 1);
    await waitFor(() => {
      expect(pending).toHaveLength(2);
    });
    expect(listings(sent(api, "previewDraft")).at(-1)?.questions["is_scam"]).toMatchObject({
      instructions: "Is this listing likely a scam? Really?",
    });

    const second: DraftPreview = {
      ...SAMPLE_PREVIEW,
      rows: [SAMPLE_PREVIEW.rows[1]].flatMap((row) => (row === undefined ? [] : [row])),
      cost: { inputTokens: 600, dollars: 0.00003 },
    };
    await act(async () => {
      pending[1]?.(second);
      await Promise.resolve();
    });
    const table = await screen.findByRole("table", { name: "Live preview of listings" });
    advance(studio, 2_000);
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(table).toHaveTextContent("Oak dining table");
    expect(screen.getByText(/Previews of listings on this page so far: 2/)).toBeInTheDocument();
  });

  it("keeps the last rows, marked with their time, when a preview is refused at the spending cap, and says why and what to do", async () => {
    let capped = false;
    const api = fakeApi({
      previewDraft: () =>
        capped
          ? Promise.reject(
              new ApiError(
                429,
                "spending_cap_reached",
                "The project reached its monthly spending cap.",
                "Raise spendingCap in facetdb.config.ts, or wait for the month to reset.",
              ),
            )
          : Promise.resolve(SAMPLE_PREVIEW),
    });
    const studio = await opened({ api });
    await previewed(studio);
    capped = true;
    await studio.user.click(screen.getByRole("button", { name: "Preview again" }));
    expect(
      await screen.findByText("The project reached its monthly spending cap."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Raise spendingCap in facetdb.config.ts, or wait for the month to reset."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/from the last preview that answered, were last read/),
    ).toBeInTheDocument();
    expect(screen.getByRole("table", { name: "Live preview of listings" })).toHaveTextContent(
      "Oak dining table",
    );
    // What the person typed is untouched.
    expect(within(question("is_scam")).getByRole("textbox", { name: "Question" })).toHaveValue(
      "Is this listing likely a scam?",
    );
  });

  it("Test asks the estimate first, spends only on the person's yes, shows the result and leads to Apply", async () => {
    const running: ((result: TestResult) => void)[] = [];
    const api = fakeApi({
      testDraft: () =>
        new Promise((resolve) => {
          running.push(resolve);
        }),
    });
    const studio = await opened({ api });
    await studio.user.click(screen.getByRole("button", { name: "Test" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Test: this draft against version 3",
    });
    await within(dialog).findByText(/asks the model 1,212 times with the draft/);
    expect(within(dialog).getByText(/about \$0\.04, under the spending cap/)).toBeInTheDocument();
    expect(sent(api, "testEstimate")).toHaveLength(1);
    expect(sent(api, "testDraft")).toEqual([]);

    // The person's yes, given twice while the test runs: one run.
    const run = within(dialog).getByRole("button", { name: "Run the test for about $0.04" });
    await studio.user.click(run);
    await studio.user.click(run);
    expect(run).toBeDisabled();
    expect(sent(api, "testDraft")).toHaveLength(1);
    await act(async () => {
      running[0]?.(SAMPLE_TEST_RESULT);
      await Promise.resolve();
    });
    await within(dialog).findByRole("table", { name: "What the draft would change" });
    expect(sent(api, "testDraft")).toHaveLength(1);
    const rows = within(dialog).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("is_scam");
    expect(rows[0]).toHaveTextContent("41 of 1,000");
    expect(rows[0]).toHaveTextContent("91%now");
    expect(rows[0]).toHaveTextContent("96%with the draft");
    expect(rows[1]).toHaveTextContent("nobody decided this question yet");
    expect(
      within(dialog).getByText(
        "is_scam: of the 41, 29 move from unsure to a decision, 12 the other way.",
      ),
    ).toBeInTheDocument();

    await studio.user.click(within(dialog).getByRole("button", { name: "Apply this draft" }));
    const apply = await screen.findByRole("dialog", { name: "Apply this draft" });
    await within(apply).findByRole("region", { name: "The changes to facetdb.config.ts" });
    expect(sent(api, "applyDiff")).toHaveLength(1);
    expect(screen.queryByRole("dialog", { name: /^Test/ })).toBeNull();
  });

  it("Apply shows the diff before anything is written, writes that plan once on the person's yes, and says what the reload did", async () => {
    const writing: ((written: ApplyWritten) => void)[] = [];
    const api = fakeApi({
      applyWrite: () =>
        new Promise((resolve) => {
          writing.push(resolve);
        }),
    });
    const studio = await opened({ api });
    const box = within(question("is_scam")).getByRole("textbox", { name: "Question" });
    await studio.user.clear(box);
    await studio.user.type(box, "Is this listing a scam or a fake?");

    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply this draft" });
    const diff = await within(dialog).findByRole("region", {
      name: "The changes to facetdb.config.ts",
    });
    // Text content as a reader gets it: runs of spaces read as one.
    expect(diff).toHaveTextContent('+ "is_scam": noul("Is this listing a scam or a fake?"');
    expect(
      within(dialog).getByText(/comments and\s+code of your own in it do not stay/),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(/facetdb backfill --source listings --question is_scam\./),
    ).toBeInTheDocument();
    // The diff was asked with the draft as typed; nothing is written yet.
    expect(sent(studio.api, "applyDiff")[0]?.questions["is_scam"]).toMatchObject({
      instructions: "Is this listing a scam or a fake?",
    });
    expect(studio.api.calls.filter((call) => call.startsWith("applyWrite"))).toEqual([]);

    const configReads = studio.api.calls.filter((call) => call === "projectConfig").length;
    // The person's yes, given twice while the write runs: one write.
    const write = within(dialog).getByRole("button", { name: "Write facetdb.config.ts" });
    await studio.user.click(write);
    await studio.user.click(write);
    expect(write).toBeDisabled();
    await act(async () => {
      writing[0]?.(SAMPLE_APPLIED);
      await Promise.resolve();
    });
    await within(dialog).findByText(/Written\. facetdb\.config\.ts holds the draft/);
    const writes = studio.api.calls.filter((call) => call.startsWith("applyWrite "));
    expect(writes).toHaveLength(1);
    expect(JSON.parse(writes[0]?.slice("applyWrite ".length) ?? "{}")).toMatchObject({
      plan: "plan-1",
      force: false,
      draft: { name: "listings" },
    });
    expect(within(dialog).getByText("restarted with the new question set")).toBeInTheDocument();
    expect(within(dialog).getByText(/then answers with version 4/)).toBeInTheDocument();
    // The worker reloaded: the config is read again.
    await waitFor(() => {
      expect(studio.api.calls.filter((call) => call === "projectConfig").length).toBeGreaterThan(
        configReads,
      );
    });
  });

  it("shows the refusal of a write over uncommitted changes with the force choice, and sends force only once it is chosen", async () => {
    const uncommitted = {
      message: "facetdb.config.ts has changes git has not committed, and Apply would replace them",
      fix: 'commit them (git add facetdb.config.ts && git commit), or apply again with force ("force": true) to replace them',
    };
    const forces: boolean[] = [];
    const api = fakeApi({
      applyDiff: () => Promise.resolve({ ...SAMPLE_APPLY_DIFF, uncommitted }),
      applyWrite: (_draft, confirm) => {
        forces.push(confirm.force);
        return confirm.force
          ? Promise.resolve(SAMPLE_APPLIED)
          : Promise.reject(
              new ApiError(
                409,
                "uncommitted_changes",
                `${uncommitted.message}. Nothing was written.`,
                uncommitted.fix,
              ),
            );
      },
    });
    const studio = await opened({ api });
    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply this draft" });
    await within(dialog).findByText(uncommitted.message);
    const choice = within(dialog).getByRole("checkbox", {
      name: "Replace facetdb.config.ts anyway: git keeps no copy of it as it is now",
    });
    expect(choice).not.toBeChecked();

    await studio.user.click(
      within(dialog).getByRole("button", { name: "Write facetdb.config.ts" }),
    );
    expect(
      await within(dialog).findByText(`${uncommitted.message}. Nothing was written.`),
    ).toBeInTheDocument();
    expect(within(dialog).getByText(uncommitted.fix)).toBeInTheDocument();
    expect(forces).toEqual([false]);

    await studio.user.click(choice);
    await studio.user.click(
      within(dialog).getByRole("button", { name: "Write facetdb.config.ts" }),
    );
    await within(dialog).findByText(/Written\./);
    expect(forces).toEqual([false, true]);
  });

  it("shows the new diff when the file changed since the one confirmed, and the next write sends its plan", async () => {
    const plans: string[] = [];
    let diffs = 0;
    const api = fakeApi({
      applyDiff: () => {
        diffs += 1;
        const next: ApplyDiff = {
          ...SAMPLE_APPLY_DIFF,
          plan: `plan-${String(diffs)}`,
          diff: `${SAMPLE_APPLY_DIFF.diff}${diffs === 2 ? "+// a line someone added\n" : ""}`,
        };
        return Promise.resolve(next);
      },
      applyWrite: (_draft, confirm): Promise<ApplyWritten> => {
        plans.push(confirm.plan);
        return confirm.plan === "plan-1"
          ? Promise.reject(
              new ApiError(
                409,
                "plan_changed",
                "facetdb.config.ts or the draft changed since the diff that was confirmed, so nothing was written.",
                "Ask for the diff again (POST /v1/apply without confirm), look at it, and confirm the plan it answers with.",
              ),
            )
          : Promise.resolve(SAMPLE_APPLIED);
      },
    });
    const studio = await opened({ api });
    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply this draft" });
    await studio.user.click(
      await within(dialog).findByRole("button", { name: "Write facetdb.config.ts" }),
    );
    await within(dialog).findByText(/changed since the diff you read, so nothing was written/);
    expect(
      within(dialog).getByRole("region", { name: "The changes to facetdb.config.ts" }),
    ).toHaveTextContent("+// a line someone added");

    await studio.user.click(
      within(dialog).getByRole("button", { name: "Write facetdb.config.ts" }),
    );
    await within(dialog).findByText(/Written\./);
    expect(plans).toEqual(["plan-1", "plan-2"]);
  });

  it("writes again after a changed file whose new diff comes back under the same plan name", async () => {
    let writes = 0;
    const api = fakeApi({
      applyWrite: (): Promise<ApplyWritten> => {
        writes += 1;
        return writes === 1
          ? Promise.reject(
              new ApiError(409, "plan_changed", "facetdb.config.ts changed.", "Ask again."),
            )
          : Promise.resolve(SAMPLE_APPLIED);
      },
    });
    const studio = await opened({ api });
    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply this draft" });
    await studio.user.click(
      await within(dialog).findByRole("button", { name: "Write facetdb.config.ts" }),
    );
    await within(dialog).findByText(/changed since the diff you read/);
    await studio.user.click(
      within(dialog).getByRole("button", { name: "Write facetdb.config.ts" }),
    );
    await within(dialog).findByText(/Written\./);
    expect(writes).toBe(2);
  });

  it("reads the config again after a write nobody answered, and says the file now says what was written", async () => {
    let answer: ProjectConfig = SAMPLE_PROJECT_CONFIG;
    const api = fakeApi({
      projectConfig: () => Promise.resolve(answer),
      applyWrite: (draft) => {
        // The write landed, and the answer was lost on the way back.
        const listing = sampleListings();
        answer = {
          ...SAMPLE_PROJECT_CONFIG,
          sources: [
            { ...listing, questions: draft.questions, thresholds: draft.thresholds },
            ...SAMPLE_PROJECT_CONFIG.sources.slice(1),
          ],
        };
        return Promise.reject(new TypeError("Failed to fetch"));
      },
    });
    const studio = await opened({ api });
    const box = within(question("is_scam")).getByRole("textbox", { name: "Question" });
    await studio.user.clear(box);
    await studio.user.type(box, "Is it a fake?");
    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply this draft" });
    await studio.user.click(
      await within(dialog).findByRole("button", { name: "Write facetdb.config.ts" }),
    );
    expect(
      await within(dialog).findByText(
        "The configuration the worker runs now says what you wrote: the write went through, and the page shows it.",
      ),
    ).toBeInTheDocument();
    await studio.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    // The draft follows the config it now equals: nothing is left marked as edited.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Discard my edits" })).toBeNull();
    });
  });

  it("says a test nobody answered may have spent already, and runs again only on a second, separate yes", async () => {
    let runs = 0;
    const api = fakeApi({
      testDraft: () => {
        runs += 1;
        return runs === 1
          ? Promise.reject(new TypeError("Failed to fetch"))
          : Promise.resolve(SAMPLE_TEST_RESULT);
      },
    });
    const studio = await opened({ api });
    await studio.user.click(screen.getByRole("button", { name: "Test" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Test: this draft against version 3",
    });
    await studio.user.click(
      await within(dialog).findByRole("button", { name: "Run the test for about $0.04" }),
    );
    expect(
      await within(dialog).findByText(
        "The worker did not answer, so whether the model was asked is not known: the test may already have asked it up to 1,212 times, about $0.04. Running it again may spend the same again.",
      ),
    ).toBeInTheDocument();
    expect(
      within(dialog).queryByRole("button", { name: "Run the test for about $0.04" }),
    ).toBeNull();
    const again = within(dialog).getByRole("button", {
      name: "Run it again, spending up to about $0.04 more",
    });
    await studio.user.dblClick(again);
    await within(dialog).findByRole("table", { name: "What the draft would change" });
    expect(runs).toBe(2);
  });

  it("shows a known refusal of the test with its message and fix alone, and offers no second run", async () => {
    const api = fakeApi({
      testDraft: () =>
        Promise.reject(
          new ApiError(
            429,
            "spending_cap_reached",
            "The project reached its monthly spending cap.",
            "Raise spendingCap in facetdb.config.ts, or wait for the month to reset.",
          ),
        ),
    });
    const studio = await opened({ api });
    await studio.user.click(screen.getByRole("button", { name: "Test" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Test: this draft against version 3",
    });
    await studio.user.click(
      await within(dialog).findByRole("button", { name: "Run the test for about $0.04" }),
    );
    expect(
      await within(dialog).findByText("The project reached its monthly spending cap."),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText(
        "Raise spendingCap in facetdb.config.ts, or wait for the month to reset.",
      ),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Run/ })).toBeNull();
    expect(within(dialog).queryByText(/may have asked the model already/)).toBeNull();
    expect(sent(api, "testDraft")).toHaveLength(1);
  });

  it("shows the endpoint's message and fix when this worker cannot apply, and offers no write", async () => {
    const api = fakeApi({
      applyDiff: () =>
        Promise.reject(
          new ApiError(
            409,
            "apply_unavailable",
            "This worker does not write facetdb.config.ts: facetdb worker --once never does.",
            "Run facetdb worker to apply from the studio, or edit facetdb.config.ts and restart the worker.",
          ),
        ),
    });
    const studio = await opened({ api });
    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    const dialog = await screen.findByRole("dialog", { name: "Apply this draft" });
    await within(dialog).findByText(/facetdb worker --once never does/);
    expect(
      within(dialog).getByText(/Run facetdb worker to apply from the studio/),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: /^Write/ })).toBeNull();
  });

  it("keeps an edited draft through a failed read of the config, says the read is old, and says a config changed under it", async () => {
    let answer: () => Promise<ProjectConfig> = () => Promise.resolve(SAMPLE_PROJECT_CONFIG);
    const api = fakeApi({ projectConfig: () => answer() });
    const studio = await opened({ api });
    const box = () => within(question("is_scam")).getByRole("textbox", { name: "Question" });
    await studio.user.clear(box());
    await studio.user.type(box(), "My own words");

    answer = () =>
      Promise.reject(
        new ApiError(503, "unreachable", "The worker did not answer.", "Start facetdb worker."),
      );
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await screen.findByText(/The configuration shown was last read/);
    expect(screen.getByText("The worker did not answer.")).toBeInTheDocument();
    expect(box()).toHaveValue("My own words");

    const listing = sampleListings();
    const others = SAMPLE_PROJECT_CONFIG.sources.slice(1);
    const changed: ProjectConfig = {
      ...SAMPLE_PROJECT_CONFIG,
      sources: [
        {
          ...listing,
          questions: {
            ...listing.questions,
            is_scam: { type: "noul", instructions: "Is it a fake?", stakes: "high" },
          },
        },
        ...others,
      ],
    };
    answer = () => Promise.resolve(changed);
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await screen.findByText(/The configuration of listings changed since this draft started/);
    expect(box()).toHaveValue("My own words");
    expect(screen.queryByText(/last read/)).toBeNull();

    await studio.user.click(
      screen.getByRole("button", { name: "Load the new configuration and drop my edits" }),
    );
    expect(box()).toHaveValue("Is it a fake?");
  });
});

describe("the Questions calls of the API client", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("sends each draft as { source } in JSON, Test's estimate first, and Apply's plan and force as chosen", async () => {
    const sentRequests: { path: string; init: RequestInit | undefined }[] = [];
    const answers: Record<string, unknown> = {
      "GET /v1/config": SAMPLE_PROJECT_CONFIG,
      "POST /v1/config/validate": { valid: true, issues: [], warnings: [] },
      "POST /v1/preview": { ...SAMPLE_PREVIEW, rows: [{ ...SAMPLE_PREVIEW.rows[0], usage: {} }] },
    };
    const api = createApiClient((path, init) => {
      sentRequests.push({ path, init });
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const key = `${init?.method ?? "GET"} ${path}`;
      if (path === "/v1/test") {
        return Promise.resolve(
          json(
            body["estimate"] === true
              ? { estimate: SAMPLE_TEST_RESULT.estimate, warnings: [] }
              : SAMPLE_TEST_RESULT,
          ),
        );
      }
      if (path === "/v1/apply") {
        return Promise.resolve(
          json(body["confirm"] === undefined ? SAMPLE_APPLY_DIFF : SAMPLE_APPLIED),
        );
      }
      return Promise.resolve(json(answers[key]));
    });
    const draft = sendable(formOf(sampleListings()));

    expect(await api.projectConfig()).toEqual(SAMPLE_PROJECT_CONFIG);
    expect((await api.validateDraft(draft)).valid).toBe(true);
    // A field the page does not read (a row's usage) is dropped, never refused.
    expect((await api.previewDraft(draft)).rows).toEqual([SAMPLE_PREVIEW.rows[0]]);
    expect((await api.testEstimate(draft)).dollars).toBeCloseTo(0.038);
    expect((await api.testDraft(draft)).questions).toHaveLength(2);
    expect((await api.applyDiff(draft)).plan).toBe("plan-1");
    expect((await api.applyWrite(draft, { plan: "plan-1", force: false })).written).toBe(true);

    expect(
      sentRequests.map(({ path, init }) => [
        init?.method,
        path,
        init?.body === undefined ? undefined : Object.keys(JSON.parse(String(init.body)) as object),
      ]),
    ).toEqual([
      ["GET", "/v1/config", undefined],
      ["POST", "/v1/config/validate", ["source"]],
      ["POST", "/v1/preview", ["source"]],
      ["POST", "/v1/test", ["source", "estimate"]],
      ["POST", "/v1/test", ["source", "estimate"]],
      ["POST", "/v1/apply", ["source"]],
      ["POST", "/v1/apply", ["source", "confirm", "force"]],
    ]);
    const [, , , estimate, run, , write] = sentRequests;
    expect(JSON.parse(String(estimate?.init?.body))).toMatchObject({ estimate: true });
    expect(JSON.parse(String(run?.init?.body))).toMatchObject({ estimate: false });
    expect(JSON.parse(String(write?.init?.body))).toEqual({
      source: draft,
      confirm: "plan-1",
      force: false,
    });
    // Apply takes only a JSON body declared as such.
    expect(new Headers(write?.init?.headers).get("content-type")).toBe("application/json");
  });

  it("reads one GET /v1/config answer, history included, as the Questions, Decisions and Settings pages each need it", async () => {
    // The worker's answer: the project JSON with its cap, and the history beside the sources. Each
    // reader keeps the keys it names and drops the others, never refusing them.
    const answer = { ...SAMPLE_PROJECT_CONFIG, spendingCap: 25_000_000, onCapReached: "pause" };
    const api = createApiClient(() => Promise.resolve(json(answer)));
    expect(await api.projectConfig()).toEqual(SAMPLE_PROJECT_CONFIG);
    expect(await api.sourceNames()).toEqual(["listings", "support_messages"]);
    expect(await api.spendingConfig()).toEqual({ tokens: 25_000_000, onCapReached: "pause" });
  });
});

describe("the draft and the answers", () => {
  const listing = sampleListings();

  it("turns the config into the form and back into the same draft", () => {
    const form = formOf(listing);
    expect(draftOf(form)).toEqual({
      name: "listings",
      questions: listing.questions,
      thresholds: listing.thresholds,
    });
  });

  it("re-applies the thresholds inclusively on every side, as core decides", () => {
    const form = formOf(listing);
    const scam = form.questions[0];
    if (scam === undefined) {
      throw new Error("the form has is_scam");
    }
    const at = (yesAbove: number, noBelow: number) =>
      ({ kind: "cuts", yesAbove, noBelow }) as const;
    const answer = (probability: number) => ({ type: "noul", probability }) as const;
    expect(decidedWords(scam, at(0.9, 0.1), answer(0.9))).toBe("yes");
    expect(decidedWords(scam, at(0.9, 0.1), answer(0.1))).toBe("no");
    expect(decidedWords(scam, at(0.9, 0.1), answer(0.5))).toBeNull();
    expect(thresholdsOf(scam)).toEqual(at(0.9, 0.1));
    // A pick-one's confidence: (0.95 - 1/5) / (1 - 1/5).
    expect(
      figureOf({
        type: "choice",
        top: "electronics",
        probabilities: [0.95, 0.0125, 0.0125, 0.0125, 0.0125],
      }),
    ).toBeCloseTo(0.9375);
  });

  it("decides each preview row under the draft's thresholds now, and a skipped row is skipped", () => {
    const form = formOf(listing);
    const lines = previewLines(SAMPLE_PREVIEW.rows, previewColumns(form, form));
    expect(lines.map((line) => line.status)).toEqual([
      "needs_review",
      "done",
      "done",
      "needs_review",
      "needs_review",
      "skipped",
    ]);
    expect(lines[0]?.cells.get("is_scam")?.label).toBe("is_scam: 58% likely yes");
  });

  it("follows the config while the draft is unedited, keeps an edited one, and names what a backfill would re-answer", () => {
    const fresh = formOf(listing);
    const kept = reconcile(new Map(), [listing]);
    expect(kept.get("listings")?.form).toEqual(fresh);
    const scam = fresh.questions[0];
    if (scam === undefined) {
      throw new Error("the form has is_scam");
    }
    const editedForm = {
      ...fresh,
      questions: [{ ...scam, instructions: "Mine" }, ...fresh.questions.slice(1)],
    };
    const drafts = new Map([["listings", { base: fresh, form: editedForm }]]);
    const moved = {
      ...listing,
      model: "jev-1.15.0",
      thresholds: { category: { confidenceAtLeast: 0.6 } },
    };
    expect(reconcile(drafts, [moved]).get("listings")?.form).toBe(editedForm);
    expect(rewordedQuestions({ base: fresh, form: editedForm })).toEqual(["is_scam"]);
    expect(
      rewordedQuestions({
        base: fresh,
        form: { ...fresh, questions: [{ ...scam, stakes: "low" }, ...fresh.questions.slice(1)] },
      }),
    ).toEqual([]);
  });

  it("places a loader's problem under its field by the path the config file writes", () => {
    expect(
      issuePlace({ path: "sources[0].questions.category.options[1].description", message: "x" }),
    ).toEqual({ question: "category", field: "options" });
    expect(issuePlace({ path: "sources[0].thresholds.is_scam.yesAbove", message: "x" })).toEqual({
      question: "is_scam",
      field: "thresholds",
    });
    expect(issuePlace({ path: "sources[0].questions.is_scam", message: "x" })).toEqual({
      question: "is_scam",
      field: "question",
    });
    expect(issuePlace({ path: "model", message: "x" })).toBeUndefined();
  });

  it("never builds a draft from two questions of one name, nor from a name a column cannot take", () => {
    const fresh = formOf(listing);
    const named = (name: string): SourceForm => ({
      ...fresh,
      questions: [...fresh.questions, { ...newQuestion(fresh), name }],
    });
    // A new question named like one in the file would replace it in the draft's object: no draft.
    expect(draftOf(named("is_scam"))).toBeUndefined();
    expect(nameProblem(named("is_scam"), 2)).toBe(
      '"is_scam" is already the name of another question of this source: give this one a name of its own.',
    );
    // The question in the file keeps its name and is not the one marked.
    expect(nameProblem(named("is_scam"), 0)).toBeUndefined();
    expect(draftOf(named(""))).toBeUndefined();
    expect(nameProblem(named(""), 2)).toBe(
      "Give the question a name: it becomes the name of its column.",
    );
    expect(draftOf(named("Is Scam"))).toBeUndefined();
    expect(draftOf(named("facetdb_status"))).toBeUndefined();
    expect(Object.keys(sendable(named("is_fake")).questions)).toEqual([
      "is_scam",
      "category",
      "is_fake",
    ]);
  });

  it("takes the config as the form once the draft says what it says, so a question just applied is a column of the file", () => {
    const fresh = formOf(listing);
    const added = { ...newQuestion(fresh), name: "is_fake", instructions: "Is it a fake?" };
    const editedForm = { ...fresh, questions: [...fresh.questions, added] };
    const applied: ConfigSource = {
      ...listing,
      questions: {
        ...listing.questions,
        is_fake: { type: "noul", instructions: "Is it a fake?", stakes: "low" },
      },
    };
    const after = reconcile(new Map([["listings", { base: fresh, form: editedForm }]]), [applied]);
    const form = after.get("listings")?.form;
    expect(form?.questions.map((question) => [question.name, question.existing])).toEqual([
      ["is_scam", true],
      ["category", true],
      ["is_fake", true],
    ]);
  });

  it("keeps the file's order of thresholds, a new key after them", () => {
    const outOfOrder: ConfigSource = {
      ...listing,
      thresholds: { category: { confidenceAtLeast: 0.6 }, is_scam: { yesAbove: 0.95 } },
    };
    const fresh = formOf(outOfOrder);
    const [scam, ...rest] = fresh.questions;
    if (scam === undefined) {
      throw new Error("the form has is_scam");
    }
    const reworded = sendable({
      ...fresh,
      questions: [{ ...scam, instructions: "Is this listing likely a fraud?" }, ...rest],
    });
    expect(reworded.thresholds).toEqual(outOfOrder.thresholds);
    expect(Object.keys(reworded.thresholds)).toEqual(["category", "is_scam"]);
    const withNew = sendable({
      ...fresh,
      questions: [
        ...fresh.questions,
        { ...newQuestion(fresh), name: "is_fake", thresholds: { yesAbove: 0.8 } },
      ],
    });
    expect(Object.keys(withNew.thresholds)).toEqual(["category", "is_scam", "is_fake"]);
  });

  it("writes only the cut line that moved, and takes a default the file does not hold out again", () => {
    const [scam] = formOf(listing).questions;
    if (scam === undefined) {
      throw new Error("the form has is_scam");
    }
    // High stakes: yes at 90%, no at 10%; the file holds no override.
    const lower = movedOverride(scam, {}, { kind: "cuts", yesAbove: 0.9, noBelow: 0.13 });
    expect(lower).toEqual({ noBelow: 0.13 });
    const back = movedOverride(
      { ...scam, thresholds: lower },
      {},
      { kind: "cuts", yesAbove: 0.9, noBelow: 0.1 },
    );
    expect(back).toEqual({});
    // A side the file holds stays written, even at the default.
    expect(
      movedOverride(
        { ...scam, thresholds: { noBelow: 0.13 } },
        { noBelow: 0.13 },
        { kind: "cuts", yesAbove: 0.9, noBelow: 0.1 },
      ),
    ).toEqual({ noBelow: 0.1 });
  });

  it("leaves the stakes, which the model does not read, out of what asks a preview again", () => {
    const fresh = formOf(listing);
    const [scam, ...rest] = fresh.questions;
    if (scam === undefined) {
      throw new Error("the form has is_scam");
    }
    const lowered = { ...fresh, questions: [{ ...scam, stakes: "low" as const }, ...rest] };
    expect(previewKey(lowered)).toBe(previewKey(fresh));
    expect(
      previewKey({ ...fresh, questions: [{ ...scam, instructions: "Other words" }, ...rest] }),
    ).not.toBe(previewKey(fresh));
  });
});
