import { act, screen, within } from "@testing-library/react";
import type { DraftPreview } from "../api/index.ts";
import { type FakeApi, fakeApi } from "./fake-client.ts";
import { renderStudio } from "./render.tsx";

/**
 * Drives Add a source on happy-dom through its steps, for the tests of the flow and of its last
 * step: the page opened at /sources/new over the fake client, connected with the sample admin
 * string, the sellers table picked, its one question written, the SQL shown and the install run.
 * Each step waits for the one before it, as the page does.
 */

/** A mark inside the admin string: a test proves the string appears nowhere it should not. */
export const MARK = "pw-MARK-9a7";
export const ADMIN = `postgres://admin:${MARK}@db.example.com:5432/shop?sslmode=require`;

export const STEPS = [
  "Connect",
  "Pick the table and the columns to read",
  "Write the questions",
  "Set the thresholds",
  "Choose storage, actions and alerts",
  "Turn it on",
];

/** A preview of the sellers table for the question `is_fake`: one row decided, one to review. */
export const SELLERS_PREVIEW: DraftPreview = {
  rows: [
    {
      key: "203",
      kind: "answered",
      state: { bio: "New here, cash only, <b>today</b>", country: "BE" },
      model: "jev-1.14.0",
      answers: { is_fake: { type: "noul", probability: 0.62 } },
    },
    {
      key: "202",
      kind: "answered",
      state: { bio: "Selling my old bikes", country: "NL" },
      model: "jev-1.14.0",
      answers: { is_fake: { type: "noul", probability: 0.04 } },
    },
  ],
  decided: 1,
  review: 1,
  cost: { inputTokens: 240, dollars: 0.000_01 },
  warnings: [],
};

/** The section of the step titled `title`. */
export const step = (title: string) => {
  const heading = screen.getByRole("heading", { level: 2, name: title });
  const section = heading.closest("section");
  if (section === null) {
    throw new Error(`the step ${title} is not a section`);
  }
  return section;
};

/** The page open at step one, over `api` (the sample preview answers unless given otherwise). */
export async function opened(
  api: FakeApi = fakeApi({ setupPreview: () => Promise.resolve(SELLERS_PREVIEW) }),
) {
  const studio = renderStudio({ path: "/sources/new", api });
  await screen.findByRole("textbox", { name: "Connection string" });
  return { ...studio, api };
}

export type SetupStudio = Awaited<ReturnType<typeof opened>>;

export async function connected(studio: SetupStudio) {
  await studio.user.type(screen.getByRole("textbox", { name: "Connection string" }), ADMIN);
  await studio.user.click(screen.getByRole("button", { name: "Connect" }));
  await screen.findByText("Connected: Postgres, 3 tables");
}

/** Chooses a table in step two's listbox by its place in the list. */
export async function pick(studio: SetupStudio, downs: number) {
  act(() => {
    within(step(STEPS[1] ?? ""))
      .getByRole("combobox", { name: "Table" })
      .focus();
  });
  await studio.user.keyboard("{ArrowDown}");
  for (let n = 0; n < downs; n += 1) {
    await studio.user.keyboard("{ArrowDown}");
  }
  await studio.user.keyboard("{Enter}");
}

/** Connected, the sellers table picked, its question named is_fake and written. */
export async function written(studio: SetupStudio) {
  await connected(studio);
  await pick(studio, 1);
  await screen.findByRole("checkbox", { name: /bio/ });
  const questions = step("Write the questions");
  const name = within(questions).getByRole("textbox", { name: "Name, the column's name" });
  await studio.user.clear(name);
  await studio.user.type(name, "is_fake");
  await studio.user.type(
    within(questions).getByRole("textbox", { name: "Question" }),
    "Is this seller a fake account?",
  );
}

/** Written, the SQL shown and the install run: the page's last step is on screen. */
export async function installed(studio: SetupStudio) {
  await written(studio);
  await studio.user.click(within(step("Turn it on")).getByRole("button", { name: "Show the SQL" }));
  await within(step("Turn it on")).findByText(/alter table "public"."sellers"/);
  await studio.user.click(
    within(step("Turn it on")).getByRole("button", { name: "Run the install" }),
  );
  await screen.findByRole("heading", { level: 2, name: "Installed on public.sellers" });
}
