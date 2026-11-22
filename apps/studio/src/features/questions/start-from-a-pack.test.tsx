import { act, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ApiError,
  type ConfigSource,
  createApiClient,
  type ProjectConfig,
  type QuestionPack,
  type SourceDraft,
} from "../../api/index.ts";
import {
  type FakeApi,
  fakeApi,
  renderStudio,
  SAMPLE_PACKS,
  SAMPLE_PROJECT_CONFIG,
} from "../../testing/index.ts";
import { formOf } from "./draft.ts";
import { fieldsOf, firstSentence, packQuestions, withPack } from "./pack.ts";
import { PacksUnreadable } from "./StartFromAPack.tsx";

/**
 * "Start from a pack" on the Questions page on happy-dom with the fake API client: the packs of the
 * installed plugins, none chosen; a pack's questions and the fields it reads shown before anything
 * changes; the confirm filling the draft with ordinary questions, which Apply then sends as any
 * other with nothing of the pack; a name the draft has kept; a field the source lacks said without
 * blocking; no pack installed; the packs being read and unreadable; and the whole of it by
 * keyboard.
 */

const [MARKETPLACE, TRIAGE] = SAMPLE_PACKS;
if (MARKETPLACE === undefined || TRIAGE === undefined) {
  throw new Error("the sample has both first-party packs");
}

/** The sample's listings source, the first of its config. */
function sampleListings(): ConfigSource {
  const [listing] = SAMPLE_PROJECT_CONFIG.sources;
  if (listing === undefined) {
    throw new Error("the sample has the listings source");
  }
  return listing;
}

/** The sample config with its listings source changed. */
function withListings(change: Partial<ConfigSource>): ProjectConfig {
  return {
    ...SAMPLE_PROJECT_CONFIG,
    sources: SAMPLE_PROJECT_CONFIG.sources.map((source) =>
      source.name === "listings" ? { ...source, ...change } : source,
    ),
  };
}

/** The drafts a method was sent, in order, from the fake's notes. */
function sent(api: FakeApi, method: string): SourceDraft[] {
  return api.calls
    .filter((call) => call.startsWith(`${method} `))
    .map((call) => JSON.parse(call.slice(method.length + 1)) as SourceDraft);
}

/** Calls that spend or write: none may come from choosing or adding a pack. */
const SPENDS_OR_WRITES = /^(previewDraft|testEstimate|testDraft|applyDiff|applyWrite|migrate)/;

async function opened(options: { api?: FakeApi; light?: boolean } = {}) {
  const api = options.api ?? fakeApi();
  const studio = renderStudio({
    path: "/questions",
    api,
    ...(options.light === undefined ? {} : { light: options.light }),
  });
  await screen.findByRole("article", { name: "is_scam" });
  return { ...studio, api };
}

/** Opens the dialog from the source's editor. */
async function openPacks(studio: Awaited<ReturnType<typeof opened>>) {
  await studio.user.click(screen.getByRole("button", { name: "Start from a pack" }));
  return screen.findByRole("dialog", { name: "Start from a pack: listings" });
}

const confirmIn = (dialog: HTMLElement, name: string | RegExp) =>
  within(dialog).getByRole("button", { name });

/** Tab, as a person does, until the control has the focus; fails if it never comes. */
async function tabTo(studio: Awaited<ReturnType<typeof opened>>, control: HTMLElement) {
  for (let step = 0; step < 12 && document.activeElement !== control; step += 1) {
    await studio.user.tab();
  }
  expect(control).toHaveFocus();
}

/** The rows of the pack's questions, by name, with what each says. */
function questionRows(dialog: HTMLElement): HTMLElement[] {
  const section = within(dialog).getByRole("region", { name: "Questions" });
  return within(section).getAllByRole("listitem");
}

describe("Start from a pack: the list", () => {
  it("lists the installed packs by name and first sentence, none chosen, the confirm disabled until one is", async () => {
    const studio = await opened();
    const dialog = await openPacks(studio);

    expect(dialog).toHaveAccessibleDescription(
      "Copies a pack's questions into this draft. Nothing is written before Apply.",
    );
    const group = await within(dialog).findByRole("group", { name: "Pack" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("aria-labelledby") === null)).toEqual([
      false,
      false,
    ]);
    const marketplace = within(group).getByRole("radio", { name: "marketplace" });
    const triage = within(group).getByRole("radio", { name: "triage" });
    // The description's first sentence, its field names set as code; the rest stays in the pack.
    expect(marketplace).toHaveAccessibleDescription(
      "Marketplace trust and safety: four yes-or-no questions on a listing's text, read from title and description (no images).",
    );
    expect(triage).toHaveAccessibleDescription(
      "GitHub issue triage for any repository: three questions about an issue or a pull request.",
    );
    expect(within(group).getByText("title", { selector: "code" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/They ask whether/)).toBeNull();
    // None chosen: nothing below the list, and nothing to confirm.
    expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
    expect(within(dialog).queryByRole("region", { name: "Questions" })).toBeNull();
    expect(confirmIn(dialog, "Add to the draft")).toBeDisabled();
    expect(studio.api.calls.filter((call) => call === "packs")).toHaveLength(1);
  });

  it("names a pack's plugin beside it only when another plugin's pack has the same name", async () => {
    const jira: QuestionPack = { ...TRIAGE, plugin: "jira", package: "facetdb-plugin-jira" };
    const studio = await opened({
      api: fakeApi({ packs: () => Promise.resolve([MARKETPLACE, TRIAGE, jira]) }),
    });
    const dialog = await openPacks(studio);
    const group = await within(dialog).findByRole("group", { name: "Pack" });

    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => document.getElementById(radio.getAttribute("aria-labelledby") ?? "")),
    ).toEqual([
      expect.objectContaining({ textContent: "marketplace" }),
      expect.objectContaining({ textContent: "triage (github)" }),
      expect.objectContaining({ textContent: "triage (jira)" }),
    ]);
    const fromJira = within(group).getByRole("radio", { name: "triage (jira)" });
    await studio.user.click(fromJira);
    expect(fromJira).toBeChecked();
    expect(within(group).getByRole("radio", { name: "triage (github)" })).not.toBeChecked();
  });
});

describe("Start from a pack: the look before the change", () => {
  it("shows the chosen pack's questions, thresholds and fields, and changes nothing before the confirm", async () => {
    const studio = await opened();
    const dialog = await openPacks(studio);
    await studio.user.click(await within(dialog).findByRole("radio", { name: "marketplace" }));

    const rows = questionRows(dialog);
    expect(
      rows.map((row) => within(row).getByText(/^[a-z_]+$/, { selector: "strong" }).textContent),
    ).toEqual(["scam", "banned_item", "off_platform", "counterfeit"]);
    const [scam, , offPlatform] = rows;
    if (scam === undefined || offPlatform === undefined) {
      throw new Error("the pack lists four questions");
    }
    expect(scam).toHaveTextContent("Yes or no, high stakes");
    expect(scam).toHaveTextContent(
      "Is the listing in title and description written to take a buyer's money or personal details without a real sale behind it?",
    );
    expect(within(scam).getByText("description", { selector: "code" })).toBeInTheDocument();
    expect(scam).toHaveTextContent("No at or below 10%, yes at or above 90%");
    expect(offPlatform).toHaveTextContent("Yes or no, low stakes");
    expect(offPlatform).toHaveTextContent("No at or below 30%, yes at or above 70%");
    expect(rows.every((row) => within(row).queryByText("New") !== null)).toBe(true);
    expect(confirmIn(dialog, "Add 4 questions")).toBeEnabled();

    // What it reads beside what the source reads.
    const fields = within(dialog).getByRole("region", { name: "Fields" });
    expect(within(fields).getByText("Pack reads").nextElementSibling).toHaveTextContent(
      "title, description",
    );
    expect(within(fields).getByText("listings reads").nextElementSibling).toHaveTextContent(
      "title, price",
    );

    // Another pack, another list: a choice question says its confidence, a pack's own cut its own.
    await studio.user.click(within(dialog).getByRole("radio", { name: "triage" }));
    const triage = questionRows(dialog);
    expect(triage.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Decides its top option when 50% confident or more"),
      expect.stringContaining("No at or below 30%, yes at or above 70%"),
      expect.stringContaining("No at or below 20%, yes at or above 80%"),
    ]);
    expect(triage[0]).toHaveTextContent("Pick one, low stakes");
    expect(confirmIn(dialog, "Add 3 questions")).toBeEnabled();

    // Nothing changed: the draft holds the file's two questions (behind the modal dialog, so out of
    // the accessible tree for now), and nothing was asked or written.
    const listings = screen.getByRole("tabpanel", { name: "listings", hidden: true });
    expect(
      within(listings)
        .getAllByRole("article", { hidden: true })
        .map((article) => article.getAttribute("aria-labelledby") !== null),
    ).toEqual([true, true]);
    expect(screen.queryByRole("article", { name: "New question: scam", hidden: true })).toBeNull();
    expect(studio.api.calls.filter((call) => SPENDS_OR_WRITES.test(call))).toEqual([]);

    // Cancel leaves the draft as it was, and the next opening starts with no pack chosen.
    await studio.user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getAllByRole("article")).toHaveLength(2);
    const again = await openPacks(studio);
    expect(
      within(again)
        .getAllByRole("radio")
        .every((radio) => !(radio as HTMLInputElement).checked),
    ).toBe(true);
    expect(confirmIn(again, "Add to the draft")).toBeDisabled();
  });

  it("leaves out the fields when the pack does not say what it reads", async () => {
    const silent: QuestionPack = { ...TRIAGE, reads: null };
    const studio = await opened({ api: fakeApi({ packs: () => Promise.resolve([silent]) }) });
    const dialog = await openPacks(studio);
    await studio.user.click(await within(dialog).findByRole("radio", { name: "triage" }));

    expect(within(dialog).getByRole("region", { name: "Questions" })).toBeInTheDocument();
    expect(within(dialog).queryByRole("region", { name: "Fields" })).toBeNull();
    expect(confirmIn(dialog, "Add 3 questions")).not.toHaveAccessibleDescription();
  });
});

describe("Start from a pack: the draft after it", () => {
  it("adds the pack's questions as ordinary new questions with their stakes and thresholds; Apply sends them with nothing of the pack", async () => {
    const studio = await opened();
    const dialog = await openPacks(studio);
    await studio.user.click(await within(dialog).findByRole("radio", { name: "marketplace" }));
    await studio.user.click(confirmIn(dialog, "Add 4 questions"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    // The focus is back on the control that opened the dialog, and the page says what was added.
    expect(screen.getByRole("button", { name: "Start from a pack" })).toHaveFocus();
    expect(
      screen.getByText("Added to the draft: scam, banned_item, off_platform, counterfeit."),
    ).toHaveAttribute("role", "status");

    // Ordinary new questions, after the file's own: a name, a kind, the wording and the criteria to
    // edit, the stakes, the slider, and Remove.
    const articles = screen.getAllByRole("article");
    expect(articles.map((article) => article.getAttribute("aria-labelledby") !== null)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    const scam = screen.getByRole("article", { name: "New question: scam" });
    expect(within(scam).getByRole("textbox", { name: "Name, the column's name" })).toHaveValue(
      "scam",
    );
    expect(within(scam).getByRole("textbox", { name: "Question" })).toHaveValue(
      "Is the listing in `title` and `description` written to take a buyer's money or personal details without a real sale behind it?",
    );
    expect(
      (within(scam).getByRole("textbox", { name: "Yes when" }) as HTMLTextAreaElement).value,
    ).toMatch(/^The listing asks for money or personal details/);
    expect(within(scam).getByText("Yes or no, high stakes")).toBeInTheDocument();
    expect(within(scam).getByRole("button", { name: "Remove scam" })).toBeInTheDocument();
    const offPlatform = screen.getByRole("article", { name: "New question: off_platform" });
    expect(offPlatform).toHaveTextContent(
      "Decides on its own at 70% or more (yes) and 30% or less (no)",
    );

    // Edited as any other question.
    const box = within(scam).getByRole("textbox", { name: "Question" });
    await studio.user.clear(box);
    await studio.user.type(box, "Is this listing a scam?");
    // The status said what was added; an edit since makes it stale, so it goes.
    expect(screen.queryByText(/^Added to the draft/)).toBeNull();

    // Nothing was written: Apply asks the diff of the draft first, and writes on its own confirm.
    expect(studio.api.calls.filter((call) => /^apply/.test(call))).toEqual([]);
    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    const apply = await screen.findByRole("dialog", { name: "Apply this draft" });
    await within(apply).findByRole("region", { name: "Changes to facetdb.config.ts" });
    const [draft] = sent(studio.api, "applyDiff");
    expect(Object.keys(draft?.questions ?? {})).toEqual([
      "is_scam",
      "category",
      "scam",
      "banned_item",
      "off_platform",
      "counterfeit",
    ]);
    // The file's real form for a yes or no question's criteria: `criteria: { true, false }`.
    expect(draft?.questions["scam"]).toEqual({
      type: "noul",
      instructions: "Is this listing a scam?",
      criteria: {
        true: expect.stringMatching(/^The listing asks for money/),
        false: expect.stringMatching(
          /^The listing describes a real sale of an item the seller has/,
        ),
      },
      stakes: "high",
    });
    expect(draft?.questions["off_platform"]).toMatchObject({ stakes: "low" });
    // The marketplace pack sets no thresholds of its own: the stakes defaults, nothing pinned.
    expect(draft?.thresholds).toEqual({});
    // Nothing points back to the pack, its plugin or its package (the wording speaks of a
    // marketplace, so the pack's name is looked for as a key or a package, not as a word).
    expect(JSON.stringify(draft)).not.toMatch(/@facetdb\/packs|"(pack|packs|plugin|package)"/);
    for (const question of Object.values(draft?.questions ?? {})) {
      expect(Object.keys(question).sort()).toEqual(
        question.type === "noul"
          ? ["criteria", "instructions", "stakes", "type"]
          : expect.arrayContaining(["instructions", "stakes", "type"]),
      );
    }
    expect(studio.api.calls.filter((call) => call.startsWith("applyWrite"))).toEqual([]);

    await studio.user.click(within(apply).getByRole("button", { name: "Apply" }));
    await within(apply).findByText("Applied.");
    expect(studio.api.calls.filter((call) => call.startsWith("applyWrite "))).toHaveLength(1);
  });

  it("carries a pack's own thresholds into the draft, and a choice question's options", async () => {
    const studio = await opened();
    const dialog = await openPacks(studio);
    await studio.user.click(await within(dialog).findByRole("radio", { name: "triage" }));
    await studio.user.click(confirmIn(dialog, "Add 3 questions"));

    const notPriority = await screen.findByRole("article", {
      name: "New question: not_priority",
    });
    expect(notPriority).toHaveTextContent("Set by hand: yes at 80% or more, no at 20% or less.");
    const kind = screen.getByRole("article", { name: "New question: kind" });
    expect(within(kind).getAllByRole("textbox", { name: /^option \d+, its name$/ })).toHaveLength(
      5,
    );

    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("dialog", { name: "Apply this draft" });
    const [draft] = sent(studio.api, "applyDiff");
    expect(draft?.thresholds).toEqual({ not_priority: { yesAbove: 0.8, noBelow: 0.2 } });
    expect(draft?.questions["kind"]).toMatchObject({
      type: "choice",
      stakes: "low",
      storeProbabilities: false,
      options: TRIAGE.questions["kind"]?.type === "choice" ? TRIAGE.questions["kind"].options : [],
    });
    // The triage pack stores no probabilities, so the dialog said nothing of them.
    expect(screen.queryByText("Stores probabilities")).toBeNull();
  });

  it("says a choice question stores its probabilities before the confirm, and keeps it so in the draft", async () => {
    const kind = TRIAGE.questions["kind"];
    if (kind?.type !== "choice") {
      throw new Error("the triage pack's kind is a choice");
    }
    const storing: QuestionPack = {
      ...TRIAGE,
      questions: { ...TRIAGE.questions, kind: { ...kind, storeProbabilities: true } },
    };
    const studio = await opened({ api: fakeApi({ packs: () => Promise.resolve([storing]) }) });
    const dialog = await openPacks(studio);
    await studio.user.click(await within(dialog).findByRole("radio", { name: "triage" }));

    const [kindRow, ...others] = questionRows(dialog);
    expect(within(kindRow as HTMLElement).getByText("Stores probabilities")).toBeInTheDocument();
    expect(others.every((row) => within(row).queryByText("Stores probabilities") === null)).toBe(
      true,
    );
    await studio.user.click(confirmIn(dialog, "Add 3 questions"));
    await screen.findByRole("article", { name: "New question: kind" });

    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("dialog", { name: "Apply this draft" });
    const [draft] = sent(studio.api, "applyDiff");
    expect(draft?.questions["kind"]).toMatchObject({ type: "choice", storeProbabilities: true });
  });
});

describe("Start from a pack: a name clash", () => {
  it("keeps a question whose name the draft has, adds the rest, and has nothing to add once all are there", async () => {
    const own = {
      type: "noul" as const,
      instructions: "Is this listing our kind of scam?",
      stakes: "low" as const,
    };
    const api = fakeApi({
      projectConfig: () =>
        Promise.resolve(withListings({ questions: { ...sampleListings().questions, scam: own } })),
    });
    const studio = await opened({ api });
    const dialog = await openPacks(studio);
    await studio.user.click(await within(dialog).findByRole("radio", { name: "marketplace" }));

    const [scam, ...others] = questionRows(dialog);
    expect(scam).toHaveTextContent("Already in the draft");
    expect(others.every((row) => within(row).queryByText("New") !== null)).toBe(true);
    await studio.user.click(confirmIn(dialog, "Add 3 questions"));

    expect(
      await screen.findByText("Added to the draft: banned_item, off_platform, counterfeit."),
    ).toBeInTheDocument();
    // The draft's own scam is kept as it was, never replaced by the pack's.
    const kept = screen.getByRole("article", { name: "scam" });
    expect(within(kept).getByRole("textbox", { name: "Question" })).toHaveValue(own.instructions);
    expect(screen.queryByRole("article", { name: "New question: scam" })).toBeNull();

    // Every name is in the draft now: listed as kept, nothing to add.
    const again = await openPacks(studio);
    await studio.user.click(await within(again).findByRole("radio", { name: "marketplace" }));
    expect(
      questionRows(again).every((row) => within(row).queryByText("Already in the draft") !== null),
    ).toBe(true);
    expect(confirmIn(again, "Nothing to add")).toBeDisabled();
  });

  it("keeps a question the file has though the draft does not, after the file changed under an edited draft", async () => {
    let answer = () => Promise.resolve(SAMPLE_PROJECT_CONFIG);
    const studio = await opened({ api: fakeApi({ projectConfig: () => answer() }) });
    const box = within(screen.getByRole("article", { name: "is_scam" })).getByRole("textbox", {
      name: "Question",
    });
    await studio.user.clear(box);
    await studio.user.type(box, "My own words");

    // Someone else applied a `scam` question meanwhile: the edited draft is kept as typed.
    const fileScam = {
      type: "noul" as const,
      instructions: "Is it a scam?",
      stakes: "high" as const,
    };
    answer = () =>
      Promise.resolve(
        withListings({ questions: { ...sampleListings().questions, scam: fileScam } }),
      );
    act(() => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await screen.findByText(/The configuration of listings changed since this draft started/);
    expect(screen.queryByRole("article", { name: "scam" })).toBeNull();

    const dialog = await openPacks(studio);
    await studio.user.click(await within(dialog).findByRole("radio", { name: "marketplace" }));
    const [scam, ...others] = questionRows(dialog);
    expect(scam).toHaveTextContent("Already in the file");
    expect(scam).not.toHaveTextContent("New");
    expect(others.every((row) => within(row).queryByText("New") !== null)).toBe(true);
    await studio.user.click(confirmIn(dialog, "Add 3 questions"));

    expect(
      await screen.findByText("Added to the draft: banned_item, off_platform, counterfeit."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "New question: scam" })).toBeNull();
    // What Apply sends holds no `scam`, so the file's question of that name stays as it is.
    await studio.user.click(screen.getByRole("button", { name: "Apply" }));
    await screen.findByRole("dialog", { name: "Apply this draft" });
    const [draft] = sent(studio.api, "applyDiff");
    expect(Object.keys(draft?.questions ?? {})).toEqual([
      "is_scam",
      "category",
      "banned_item",
      "off_platform",
      "counterfeit",
    ]);
  });
});

describe("Start from a pack: a missing field", () => {
  it("says which fields the source lacks before the confirm, and lets the person add the pack anyway", async () => {
    const studio = await opened();
    const dialog = await openPacks(studio);
    await studio.user.click(await within(dialog).findByRole("radio", { name: "triage" }));

    const fields = within(dialog).getByRole("region", { name: "Fields" });
    const warning = within(fields).getByText(/^listings has no/);
    expect(warning).toHaveTextContent(
      "listings has no body, labels or changed_files: these questions would see only title.",
    );
    // A warning, not a block: the confirm stays open and carries it for a screen reader.
    const confirm = confirmIn(dialog, "Add 3 questions");
    expect(confirm).toBeEnabled();
    expect(warning.id).not.toBe("");
    expect(confirm).toHaveAttribute("aria-describedby", warning.id);
    await studio.user.click(confirm);
    expect(await screen.findByRole("article", { name: "New question: kind" })).toBeInTheDocument();
  });

  it("says when the source has none of them, and says nothing when it has them all", async () => {
    const none = fakeApi({
      projectConfig: () => Promise.resolve(withListings({ read: ["price", "seller_age_days"] })),
    });
    const studio = await opened({ api: none });
    const dialog = await openPacks(studio);
    await studio.user.click(await within(dialog).findByRole("radio", { name: "marketplace" }));
    expect(
      within(dialog).getByText(
        "listings has none of the fields the pack reads: these questions would have nothing to read.",
      ),
    ).toBeInTheDocument();
    studio.unmount();

    const all = fakeApi({
      projectConfig: () =>
        Promise.resolve(withListings({ read: ["title", "description", "price"] })),
    });
    const second = await opened({ api: all });
    const next = await openPacks(second);
    await second.user.click(await within(next).findByRole("radio", { name: "marketplace" }));
    const fields = within(next).getByRole("region", { name: "Fields" });
    expect(within(fields).queryByText(/listings has no/)).toBeNull();
    expect(confirmIn(next, "Add 4 questions")).not.toHaveAccessibleDescription();
  });
});

describe("Start from a pack: the empty case", () => {
  it("with no pack installed, says which plugins bring one and shows each `facetdb add` command with Copy", async () => {
    const studio = await opened({
      api: fakeApi({ packs: () => Promise.resolve([]) }),
      light: true,
    });
    const dialog = await openPacks(studio);

    expect(
      await within(dialog).findByText(
        "No installed plugin has a pack. Run one of these in the project's folder:",
      ),
    ).toBeInTheDocument();
    const rows = within(dialog).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/^(marketplace|triage)$/).textContent)).toEqual([
      "marketplace",
      "triage",
    ]);
    expect(rows[0]).toHaveTextContent("Trust and safety for listings");
    expect(rows[1]).toHaveTextContent("GitHub issue triage");
    expect(within(dialog).getByText("facetdb add packs", { selector: "code" })).toBeInTheDocument();
    expect(
      within(dialog).getByText("facetdb add github", { selector: "code" }),
    ).toBeInTheDocument();
    await studio.user.click(
      within(dialog).getByRole("button", { name: "Copy facetdb add github" }),
    );
    expect(studio.copied).toEqual(["facetdb add github"]);
    // Nothing installs from the page, and there is nothing to add.
    expect(within(dialog).queryByRole("radio")).toBeNull();
    expect(confirmIn(dialog, "Add to the draft")).toBeDisabled();
  });
});

describe("Start from a pack: reading the packs", () => {
  it("says the packs are being read, then why they could not be, and reads them again on Try again", async () => {
    let answer: (packs: readonly QuestionPack[]) => void = () => undefined;
    let calls = 0;
    const api = fakeApi({
      packs: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(
              new ApiError(
                500,
                "plugins_unreadable",
                "The worker could not list the plugins' packs.",
                "Look at the worker's output, then try again.",
              ),
            )
          : new Promise((resolve) => {
              answer = resolve;
            });
      },
    });
    const studio = await opened({ api });
    const dialog = await openPacks(studio);

    const alert = await within(dialog).findByRole("alert");
    expect(alert).toHaveTextContent("The packs could not be read.");
    expect(alert).toHaveTextContent(
      "The worker could not list the plugins' packs. Look at the worker's output, then try again.",
    );
    expect(confirmIn(dialog, "Add to the draft")).toBeDisabled();

    await studio.user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("Reading the packs.")).toHaveAttribute("role", "status");
    expect(within(dialog).queryByRole("alert")).toBeNull();
    answer(SAMPLE_PACKS);
    expect(await within(dialog).findByRole("radio", { name: "marketplace" })).toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it("says in plain words that the worker could not be reached", () => {
    let retried = 0;
    render(
      <PacksUnreadable
        error={new TypeError("Failed to fetch")}
        retry={() => {
          retried += 1;
        }}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(
      "The studio cannot reach the worker. Check that it is running (facetdb worker) and that this computer is online.",
    );
    expect(within(alert).getByText("facetdb worker", { selector: "code" })).toBeInTheDocument();
    within(alert).getByRole("button", { name: "Try again" }).click();
    expect(retried).toBe(1);
  });
});

describe("Start from a pack: the keyboard", () => {
  it("opens, chooses, confirms and cancels without a pointer", async () => {
    const studio = await opened();
    screen.getByRole("button", { name: "Start from a pack" }).focus();
    await studio.user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", { name: "Start from a pack: listings" });
    const marketplace = await within(dialog).findByRole("radio", { name: "marketplace" });

    // The focus is held in the dialog; Tab reaches the list of packs, none chosen until a key
    // chooses one (the disabled confirm is no stop).
    await tabTo(studio, marketplace);
    expect(marketplace).not.toBeChecked();
    await studio.user.keyboard(" ");
    expect(marketplace).toBeChecked();
    await studio.user.keyboard("{ArrowDown}");
    const triage = within(dialog).getByRole("radio", { name: "triage" });
    expect(triage).toBeChecked();
    expect(triage).toHaveFocus();

    // Escape leaves the draft as it was.
    await studio.user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Start from a pack" })).toHaveFocus();

    // Again, to the end: choose, tab to the confirm, Enter.
    await studio.user.keyboard("{Enter}");
    const again = await screen.findByRole("dialog", { name: "Start from a pack: listings" });
    const first = await within(again).findByRole("radio", { name: "marketplace" });
    await tabTo(studio, first);
    await studio.user.keyboard(" ");
    const confirm = confirmIn(again, "Add 4 questions");
    await tabTo(studio, confirm);
    await studio.user.keyboard("{Enter}");
    expect(
      await screen.findByRole("article", { name: "New question: counterfeit" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start from a pack" })).toHaveFocus();
  });
});

describe("Start from a pack: the pieces", () => {
  it("cuts a description to its first sentence, whatever ends it", () => {
    expect(firstSentence("One line. Two lines.")).toBe("One line.");
    expect(firstSentence("Is it? Yes.")).toBe("Is it?");
    expect(firstSentence("  No full stop at all  ")).toBe("No full stop at all");
    expect(firstSentence("Reads `a.b` and `c`. Then more.")).toBe("Reads `a.b` and `c`.");
  });

  it("adds only the names neither the draft nor the file has, after the draft's own, and compares fields only when the pack says them", () => {
    const form = formOf({
      ...sampleListings(),
      questions: {
        ...sampleListings().questions,
        counterfeit: { type: "noul", instructions: "Fake?", stakes: "low" },
      },
    });
    const next = withPack(form, MARKETPLACE, ["is_scam", "category", "counterfeit"]);
    expect(next.added).toEqual(["scam", "banned_item", "off_platform"]);
    expect(next.form.questions.map((question) => [question.name, question.existing])).toEqual([
      ["is_scam", true],
      ["category", true],
      ["counterfeit", true],
      ["scam", false],
      ["banned_item", false],
      ["off_platform", false],
    ]);
    // A name only the file has (it changed under the draft) is kept too, said as the file's.
    expect(
      packQuestions(MARKETPLACE, form, ["is_scam", "banned_item"]).map((entry) => [
        entry.question.name,
        entry.kept,
      ]),
    ).toEqual([
      ["scam", null],
      ["banned_item", "file"],
      ["off_platform", null],
      ["counterfeit", "draft"],
    ]);
    expect(withPack(form, MARKETPLACE, ["banned_item"]).added).toEqual(["scam", "off_platform"]);
    expect(next.form.thresholdOrder).toEqual(form.thresholdOrder);
    expect(fieldsOf(TRIAGE, ["title", "price"])).toEqual({
      missing: ["body", "labels", "changed_files"],
      present: ["title"],
    });
    expect(fieldsOf({ ...TRIAGE, reads: null }, ["title"])).toBeUndefined();
  });
});

describe("the packs call", () => {
  it("asks GET /v1/packs and refuses an answer whose pack is not in a draft's shape", async () => {
    const paths: string[] = [];
    const answering = (body: unknown) =>
      createApiClient((path, init) => {
        paths.push(`${init?.method ?? "GET"} ${path}`);
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      });

    expect(await answering({ packs: SAMPLE_PACKS }).packs()).toEqual(SAMPLE_PACKS);
    expect(paths).toEqual(["GET /v1/packs"]);
    await expect(
      answering({ packs: [{ ...MARKETPLACE, reads: "title" }] }).packs(),
    ).rejects.toMatchObject({ code: "unexpected-answer" });
    await expect(
      answering({
        packs: [{ ...MARKETPLACE, questions: { scam: { type: "box", instructions: "?" } } }],
      }).packs(),
    ).rejects.toMatchObject({ code: "unexpected-answer" });
  });
});
