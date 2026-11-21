import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, type Locator, type Page, test } from "@playwright/test";

/**
 * The studio smoke: one walk through the studio `facetdb dev` serves on the listings example
 * (playwright.config.ts starts it, smoke/dev.ts builds it), as it is run once before a release.
 * Home and its four columns; Add a source on the embedded database through the six steps, the
 * install SQL shown and run; Questions with the live preview filling; Review decided with the keys
 * (`y`, then `s` on the next card, `u` to take the decision back, `y` again so one stands);
 * Decisions holding that record's log. Each page is photographed in both themes into
 * smoke/screenshots/. Every wait is on what the page shows; the names are the pages' own (the
 * studio's tests use the same ones).
 */

const here = dirname(fileURLToPath(import.meta.url));
const SCREENSHOTS = resolve(here, "screenshots");

/** The eight pages, in the rail's order. */
const PAGES = [
  "Home",
  "Sources",
  "Questions",
  "Review",
  "Decisions",
  "Plugins",
  "Alerts",
  "Settings",
] as const;

/** Home's four columns. */
const COLUMNS = ["Health", "Answered today", "Waiting for a person", "Spending"] as const;

/** Add a source's six steps, as their headings read. */
const STEPS = {
  connect: "Connect",
  pick: "Pick the table and the columns to read",
  write: "Write the questions",
  thresholds: "Set the thresholds",
  choose: "Choose storage, actions and alerts",
  turnOn: "Turn it on",
} as const;

/** Dev's one admin connection string, which it prints when it starts. */
const DEV_URL = "pglite://facetdb-dev";

/** The rail's link to a page; Review's name carries its count ("Review 103 waiting"). */
function railLink(page: Page, name: string): Locator {
  return page
    .getByRole("navigation", { name: "Pages" })
    .getByRole("link", { name: new RegExp(`^${name}\\b`) });
}

/** A button by its whole name: "Connect" is not "Show the connection string". */
function button(scope: Page | Locator, name: string): Locator {
  return scope.getByRole("button", { name, exact: true });
}

/** The section of the setup step titled `title`: the innermost section holding that heading. */
function step(page: Page, title: string): Locator {
  return page
    .locator("section", { has: page.getByRole("heading", { level: 2, name: title, exact: true }) })
    .last();
}

/**
 * The page as it stands, in the dark theme (the run's system preference), then in the light one
 * through the rail's switch, then dark again so every page starts the same way.
 */
async function photograph(page: Page, name: string): Promise<void> {
  const root = page.locator("html");
  await expect(root).not.toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: join(SCREENSHOTS, `${name}-dark.png`), animations: "disabled" });
  await button(page, "Switch to the light theme").click();
  await expect(root).toHaveAttribute("data-theme", "light");
  await page.screenshot({ path: join(SCREENSHOTS, `${name}-light.png`), animations: "disabled" });
  await button(page, "Switch to the dark theme").click();
  await expect(root).toHaveAttribute("data-theme", "dark");
}

type CardName = { readonly source: string; readonly key: string };

const cardWords = (card: CardName) => `${card.source} ${card.key},`;

/**
 * The card on the Review page once the page is ready for the next key, and the source and key
 * its header names. A key that moves the card (`y` on its last question, `s`, `u`) shows its
 * notice before the next card is opened, and the page drops any key pressed while that request
 * is out (controller.ts `run`: one request at a time; the stage is `aria-busy` meanwhile, with
 * the card just answered kept on it), so the wait is on the stage: not busy, and showing `after`
 * when one is named (the card brought back by `u`), else no longer the card `before`; the first
 * look at the page names neither.
 */
async function cardOnScreen(
  page: Page,
  moved?: { readonly before: CardName } | { readonly after: CardName },
): Promise<CardName> {
  const card = page.getByRole("article", { name: /^Review card: / });
  await expect(card).toBeVisible();
  if (moved !== undefined && "after" in moved) {
    await expect(card).toContainText(cardWords(moved.after));
  } else if (moved !== undefined) {
    await expect(card).not.toContainText(cardWords(moved.before));
  }
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  const header =
    (await card
      .locator("span", { hasText: /^Review card: / })
      .first()
      .textContent()) ?? "";
  const named = /^Review card: (\S+) (\S+), waiting since /.exec(header);
  if (named === null) {
    throw new Error(`the card's header reads "${header}", which names no source and key`);
  }
  return { source: named[1] ?? "", key: named[2] ?? "" };
}

test("the studio on facetdb dev: Home, Add a source, Questions, Review with the keys, Decisions", async ({
  page,
}) => {
  await mkdir(SCREENSHOTS, { recursive: true });

  // Home: the four columns and the rail's eight pages.
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1, name: "Home" })).toBeVisible();
  for (const title of COLUMNS) {
    await expect(page.getByRole("article", { name: title })).toBeVisible();
  }
  for (const name of PAGES) {
    await expect(railLink(page, name)).toBeVisible();
  }
  await photograph(page, "home");

  // Sources, then Add a source through its six steps on the embedded database.
  await railLink(page, "Sources").click();
  await expect(page.getByRole("heading", { level: 1, name: "Sources" })).toBeVisible();
  await photograph(page, "sources");
  await page.getByRole("link", { name: "Add a source" }).click();
  const admin = page.getByRole("textbox", { name: "Connection string" });
  await expect(admin).toBeVisible();
  await admin.fill(DEV_URL);
  await button(step(page, STEPS.connect), "Connect").click();
  await expect(page.getByText("Connected: PGlite, 2 tables")).toBeVisible();

  await step(page, STEPS.pick).getByRole("combobox", { name: "Table" }).click();
  await page.getByRole("option", { name: "sellers" }).click();
  await expect(step(page, STEPS.pick).getByRole("checkbox", { name: /bio/ })).toBeVisible();

  const questions = step(page, STEPS.write);
  await questions.getByRole("textbox", { name: "Name, the column's name" }).fill("is_fake");
  await questions.getByRole("textbox", { name: "Question" }).fill("Is this seller a fake account?");
  await expect(step(page, STEPS.thresholds)).toBeVisible();
  await expect(
    step(page, STEPS.choose).getByRole("textbox", {
      name: "The variable that holds the worker's connection string",
    }),
  ).toHaveValue("DATABASE_URL");

  const turnOn = step(page, STEPS.turnOn);
  await button(turnOn, "Show the SQL").click();
  await expect(turnOn.getByText(/alter table "public"\."sellers"/)).toBeVisible();
  // The copy lives under packages/facetdb/build/, which git ignores, so the page says git keeps no
  // copy of facetdb.config.ts to bring back and asks before replacing it: the tick a person gives.
  await turnOn.getByRole("checkbox", { name: "Replace it anyway" }).check();
  await button(turnOn, "Run the install").click();
  await expect(
    page.getByRole("heading", { level: 2, name: "Installed on public.sellers" }),
  ).toBeVisible();
  await photograph(page, "add-source");

  // Questions: the listings source's questions, the live preview filling, Apply offered.
  await railLink(page, "Questions").click();
  await expect(page.getByRole("heading", { level: 1, name: "Questions" })).toBeVisible();
  await expect(page.getByRole("tab", { name: "listings" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(page.getByRole("tab", { name: "sellers" })).toBeVisible();
  await button(page, "Preview 20 rows").click();
  const preview = page.getByRole("table", { name: "Live preview of listings" });
  await expect(preview).toBeVisible();
  await expect(preview.locator("tbody tr")).toHaveCount(20);
  await expect(page.getByText(/of 20 decided automatically/).first()).toBeVisible();
  await expect(button(page, "Apply")).toBeVisible();
  await photograph(page, "questions");

  // Review: y decides the first card, s skips the next, u brings the first back, y decides it.
  await railLink(page, "Review").click();
  const first = await cardOnScreen(page);
  await photograph(page, "review");
  const status = page.getByRole("status");
  await page.keyboard.press("y");
  await expect(status).toContainText(/\b(\w+): yes\. Written to the record/);
  const said = (await status.textContent()) ?? "";
  const decided = /\b(\w+): yes\. Written to the record/.exec(said);
  if (decided?.[1] === undefined) {
    throw new Error(`the notice reads "${said}", which names no question`);
  }
  const question = decided[1];
  const second = await cardOnScreen(page, { before: first });
  expect(second).not.toEqual(first);
  await page.keyboard.press("s");
  await expect(status).toContainText("Skipped. The card goes behind the rest for you");
  const third = await cardOnScreen(page, { before: second });
  expect(third).not.toEqual(second);
  await page.keyboard.press("u");
  await expect(status).toContainText(
    `Undid your decision on ${question} (yes) for ${first.source} ${first.key}. The record is back in review.`,
  );
  expect(await cardOnScreen(page, { after: first })).toEqual(first);
  await page.keyboard.press("y");
  await expect(status).toContainText(`${question}: yes. Written to the record`);
  await cardOnScreen(page, { before: first });

  // Decisions: the log of that record alone (the Record key filter) holds the model's answers,
  // the decision that stands and the one taken back.
  await railLink(page, "Decisions").click();
  await expect(page.getByRole("heading", { level: 1, name: "Decisions" })).toBeVisible();
  if (first.source !== "listings") {
    await page.getByRole("combobox", { name: "Source" }).click();
    await page.getByRole("option", { name: first.source }).click();
  }
  await page.getByRole("textbox", { name: "Record key" }).fill(first.key);
  await page.keyboard.press("Enter");
  const log = page.getByRole("table", { name: `Decisions of ${first.source}` });
  await expect(log).toBeVisible();
  // The filtered log is the whole of it ("Nothing older"), every line is this record's, and the
  // walk's three decisions are there: two that stand and the one taken back. The unfiltered log
  // of listings holds thousands of lines and many a "yes", so none of this holds by accident.
  await expect(page.getByText(/^\d+ decisions, newest first\. Nothing older\.$/)).toBeVisible();
  const lines = await log.locator("tbody tr").count();
  expect(lines).toBeGreaterThanOrEqual(4);
  await expect(log.getByRole("link", { name: first.key, exact: true })).toHaveCount(lines);
  await expect(log.getByText("yes", { exact: true })).toHaveCount(2);
  await expect(log.getByText("withdrawn", { exact: true })).toHaveCount(1);
  await photograph(page, "decisions");
});
