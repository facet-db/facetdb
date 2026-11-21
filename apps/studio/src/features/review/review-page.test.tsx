import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ApiError, type ReviewCard, type ReviewDecided } from "../../api/index.ts";
import {
  type FakeApi,
  fakeApi,
  renderStudio,
  SAMPLE_CARD,
  SAMPLE_QUEUE,
  signInRequired,
} from "../../testing/index.ts";
import { NOTICE_MS } from "./index.ts";

/**
 * The Review page on happy-dom with the fake API client and the fake scheduler: the card as the
 * mockup lays it out, every key and what guards it, the lock renewed on the injected clock, each
 * refusal of the surface and what the page does next, undo, leaving, the filters and the labels a
 * screen reader reads. No real timer, clock, storage or network.
 */

/** The one element of a list the test knows holds exactly one. */
function only<T>(list: readonly T[]): T {
  const [one] = list;
  if (one === undefined || list.length !== 1) {
    throw new Error("the sample card changed: expected exactly one element");
  }
  return one;
}

const URGENCY = only(SAMPLE_CARD.open.filter((one) => one.name === "urgency"));
const REFUND = only(SAMPLE_CARD.open.filter((one) => one.name === "wants_refund"));

/** The next card of the queue: another record with one yes-or-no question open. */
const NEXT_CARD: ReviewCard = {
  ...SAMPLE_CARD,
  key: "5522",
  stateHash: "h-5522",
  state: { subject: "Where is my order", body: "Nothing arrived yet." },
  open: [REFUND],
  decided: [],
};

/** Urgency decided as `value`: what the card shows once that question has an answer. */
const urgencyDecided = (value: string): ReviewCard["decided"][number] => ({
  name: "urgency",
  type: "score",
  instructions: URGENCY.instructions,
  value,
  said: value,
});

/** The same record after its state changed: a new state hash, urgency decided, one question open. */
const CHANGED_CARD: ReviewCard = {
  ...SAMPLE_CARD,
  stateHash: "h-5521b",
  open: [REFUND],
  decided: [...SAMPLE_CARD.decided, urgencyDecided("high")],
};
/** The same card at the same state after urgency was decided as low (the decision was taken). */
const TAKEN_CARD: ReviewCard = {
  ...SAMPLE_CARD,
  open: [REFUND],
  decided: [...SAMPLE_CARD.decided, urgencyDecided("low")],
};
/** ... after urgency was decided as high by someone else. */
const OTHER_CARD: ReviewCard = {
  ...SAMPLE_CARD,
  open: [REFUND],
  decided: [...SAMPLE_CARD.decided, urgencyDecided("high")],
};

const STILL_OPEN: ReviewDecided = {
  status: "needs_review",
  open: ["wants_refund"],
  failedActions: [],
};
const DONE: ReviewDecided = { status: "done", open: [], failedActions: [] };

/** Cards the fake queue hands out in turn, then none; an ApiError in the list is an open that fails. */
function scripted(...cards: readonly (ReviewCard | ApiError | null)[]) {
  let next = 0;
  return () => {
    const one = cards[next] ?? null;
    next += 1;
    return one instanceof ApiError ? Promise.reject(one) : Promise.resolve({ card: one });
  };
}

const refusal = (status: number, code: string, message: string) =>
  new ApiError(status, code, message, `Fix for ${code}.`);

function calls(api: FakeApi, name: string): string[] {
  return api.calls.filter((call) => call.startsWith(name));
}

/** The banner that says the hold is gone, found by its words (the page's own alert region is always there). */
async function lostBanner(): Promise<HTMLElement> {
  const word = await screen.findByText("This card is no longer yours");
  const banner = word.closest('[role="alert"]');
  if (!(banner instanceof HTMLElement)) {
    throw new Error("the words are not in an alert");
  }
  return banner;
}

/** Opens /review over the fake and waits for the first card. */
async function openReview(
  answers: Parameters<typeof fakeApi>[0] = {},
  options: { readonly phone?: boolean; readonly strict?: boolean } = {},
) {
  const api = fakeApi({ reviewOpen: scripted(SAMPLE_CARD, NEXT_CARD), ...answers });
  const view = renderStudio({ path: "/review", api, ...options });
  await screen.findByRole("article");
  return { ...view, api };
}

const button = (name: string) => screen.getByRole("button", { name });

/** The review card: where the focus rests when a card opens and after each decision. */
const card = () => screen.getByRole("article");

/** Puts the focus on an answer, as a reviewer who works with Tab and Enter has. */
function focusOn(name: string): void {
  act(() => {
    button(name).focus();
  });
}

describe("the card", () => {
  it("lays the record out for reading, with each question's answer in words, its dither and its probabilities", async () => {
    await openReview();

    // The time is the browser's local one, so the name is held to its shape.
    const card = screen.getByRole("article", {
      name: /^Review card: support_messages 5521 ?, waiting since \d{1,2}:\d{2}/,
    });
    // The state as key and value lines, the JSON column laid out, never raw.
    const record = within(card).getByRole("region", { name: "The record" });
    expect(within(record).getByText("subject")).toBeInTheDocument();
    expect(within(record).getByText("Charged twice")).toBeInTheDocument();
    expect(within(record).getByText("plan")).toBeInTheDocument();
    expect(within(record).getByText("pro")).toBeInTheDocument();
    expect(record.textContent).not.toContain('{"plan"');

    // Each open question: its words, the kind, the model's answer as a sentence with the number.
    const urgency = within(card).getByRole("region", { name: "How urgent is this message?" });
    expect(within(urgency).getByText("Rate on a scale")).toBeInTheDocument();
    expect(within(urgency).getByText("The model's pick is high, 62% sure.")).toBeInTheDocument();
    // The probabilities in one row; each strip says the option, the percent and the pick.
    const row = within(urgency).getByRole("list", {
      name: "The model's probability for each option",
    });
    expect(
      within(row)
        .getAllByRole("img")
        .map((strip) => strip.getAttribute("aria-label")),
    ).toEqual(["low, 7%", "medium, 31%", "high, 62%, the model's pick"]);

    const refund = within(card).getByRole("region", {
      name: "Is the customer asking for their money back?",
    });
    expect(within(refund).getByText("Yes or no")).toBeInTheDocument();
    expect(within(refund).getByText("The model says 84% likely yes.")).toBeInTheDocument();
    // A yes-or-no question has no probabilities row: the sentence says it.
    expect(within(refund).queryByRole("list")).toBeNull();

    // The decided question is greyed and says its value.
    const team = within(card).getByRole("region", { name: "Which team should handle it?" });
    expect(within(team).getByText("Decided")).toBeInTheDocument();
    expect(team.textContent).toContain("billing");
    expect(within(team).queryByRole("button")).toBeNull();
  });

  it("counts the queue and the oldest wait in the top bar", async () => {
    await openReview();
    expect(await screen.findByText("37 to review.")).toBeInTheDocument();
    expect(screen.getByText(/The oldest has waited 14 minutes\./)).toBeInTheDocument();
  });

  it("shows the customer's text as text, never as markup", async () => {
    const hostile = '<img src=x onerror="document.title=1"><b>bold</b>';
    const card: ReviewCard = {
      ...SAMPLE_CARD,
      state: { body: hostile, note: "<script>1</script>" },
    };
    const { container } = await openReview({ reviewOpen: scripted(card) });
    const record = screen.getByRole("region", { name: "The record" });
    expect(record.textContent).toContain(hostile);
    expect(container.querySelector("img, b, script")).toBeNull();
  });

  it("lays a JSON list out as items and keeps a sentence that opens with a bracket as text", async () => {
    const card: ReviewCard = {
      ...SAMPLE_CARD,
      state: { tags: '["vip","late"]', body: "[sic] it did not arrive", missing: null },
    };
    await openReview({ reviewOpen: scripted(card) });
    const record = screen.getByRole("region", { name: "The record" });
    expect(within(record).getByText("vip")).toBeInTheDocument();
    expect(within(record).getByText("late")).toBeInTheDocument();
    expect(within(record).getByText("[sic] it did not arrive")).toBeInTheDocument();
    expect(within(record).getByText("no value")).toBeInTheDocument();
  });

  // Seen in a real run: the focus brackets on "Yes" of a card just opened read as an answer given.
  it("puts the focus on the card when it opens, and on none of its answers", async () => {
    await openReview();
    await waitFor(() => {
      expect(card()).toHaveFocus();
    });
    expect(screen.getAllByRole("button").some((one) => one === document.activeElement)).toBe(false);
  });

  it("keeps the answered card in place, untouchable, until the next one has opened", async () => {
    const next = Promise.withResolvers<{ card: ReviewCard | null }>();
    const opens = [() => Promise.resolve({ card: NEXT_CARD }), () => next.promise];
    const { user } = await openReview({
      reviewOpen: () => (opens.shift() ?? (() => Promise.resolve({ card: null })))(),
      reviewDecide: () => Promise.resolve(DONE),
    });
    await user.keyboard("n");
    await screen.findByText(/wants_refund: no\./);
    // The stage does not blink empty: the card answered is still there, and nothing on it acts.
    expect(screen.getByText("Where is my order")).toBeInTheDocument();
    expect(card().parentElement).toHaveAttribute("inert");
    next.resolve({ card: SAMPLE_CARD });
    expect(await screen.findByText("Charged twice")).toBeInTheDocument();
    expect(card().parentElement).not.toHaveAttribute("inert");
    await waitFor(() => {
      expect(card()).toHaveFocus();
    });
  });

  it("has a label and a role on every control, and a key shown on each that a key reaches", async () => {
    await openReview();
    expect(screen.getByRole("heading", { level: 1, name: "Review" })).toBeInTheDocument();
    for (const control of screen.getAllByRole("button")) {
      expect(control, control.outerHTML).toHaveAccessibleName();
    }
    for (const control of screen.getAllByRole("combobox")) {
      expect(control).toHaveAccessibleName();
    }
    expect(screen.getByRole("textbox", { name: "Note, optional" })).toBeInTheDocument();
    // The options of a score and the two answers of a yes-or-no each announce their key.
    expect(button("low")).toHaveAttribute("aria-keyshortcuts", "1");
    expect(button("high")).toHaveAttribute("aria-keyshortcuts", "3");
    expect(button("Yes")).toHaveAttribute("aria-keyshortcuts", "y");
    expect(button("No")).toHaveAttribute("aria-keyshortcuts", "n");
    expect(button("Skip")).toHaveAttribute("aria-keyshortcuts", "s");
    expect(button("Leave")).toHaveAttribute("aria-keyshortcuts", "q");
    // Each group of answers is named by its question for a screen reader.
    expect(
      screen.getByRole("group", { name: "Pick a level: How urgent is this message?" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("list", { name: "Keys" })).toBeInTheDocument();
    expect(document.title).toBe("Review · FacetDB");
  });

  it("keeps every button reachable at phone width", async () => {
    await openReview({}, { phone: true });
    for (const name of ["low", "medium", "high", "Yes", "No", "Skip", "Leave"]) {
      expect(button(name)).toBeVisible();
      expect(button(name)).toBeEnabled();
    }
  });

  it("names the key a button shows only when the key reaches it", async () => {
    const second: ReviewCard = {
      ...SAMPLE_CARD,
      open: [REFUND, { ...REFUND, name: "is_spam", instructions: "Is it spam?" }],
    };
    await openReview({ reviewOpen: scripted(second) });
    const spam = screen.getByRole("group", { name: "Yes or no: Is it spam?" });
    // y and n answer the first yes-or-no question; the second shows no hint until its turn.
    expect(within(spam).getByRole("button", { name: "Yes" })).not.toHaveAttribute(
      "aria-keyshortcuts",
    );
  });
});

describe("the keys", () => {
  it("decides a yes-or-no question with y and n and a score with a digit, then the next card", async () => {
    const decisions = [STILL_OPEN, DONE];
    const { api, user } = await openReview({
      reviewDecide: () => Promise.resolve(decisions.shift() ?? DONE),
    });

    await user.keyboard("3");
    expect(
      await screen.findByText(/urgency: high\. Written to the record and logged for os:alex\./),
    ).toBeInTheDocument();
    expect(calls(api, "reviewDecide")).toEqual(["reviewDecide 5521 urgency=high"]);
    // The decided question greys out; the card keeps its second question and says what is left.
    const urgency = screen.queryByRole("region", { name: "How urgent is this message?" });
    expect(urgency?.querySelector("button")).toBeNull();
    expect(screen.getByText(/1 question is left on this card\./)).toBeInTheDocument();
    await waitFor(() => {
      expect(card()).toHaveFocus();
    });

    await user.keyboard("n");
    expect(await screen.findByText(/wants_refund: no\./)).toBeInTheDocument();
    expect(calls(api, "reviewDecide")).toEqual([
      "reviewDecide 5521 urgency=high",
      "reviewDecide 5521 wants_refund=false",
    ]);
    // The record is done: the next card opens.
    expect(await screen.findByText("Where is my order")).toBeInTheDocument();
    expect(screen.getByText(/The record is done and its actions run again\./)).toBeInTheDocument();

    await user.keyboard("y");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(3);
    });
    expect(calls(api, "reviewDecide")[2]).toBe("reviewDecide 5522 wants_refund=true");
    // Each decision names the card it was drawn on, state hash included.
    expect(api.refs.filter((ref) => ref.startsWith("reviewDecide"))).toEqual([
      "reviewDecide support_messages/5521@h-5521",
      "reviewDecide support_messages/5521@h-5521",
      "reviewDecide support_messages/5522@h-5522",
    ]);
  });

  it("decides with a click as well, and sends the note with the decision", async () => {
    const { api, user } = await openReview({ reviewDecide: () => Promise.resolve(STILL_OPEN) });
    await user.type(screen.getByRole("textbox", { name: "Note, optional" }), "third message");
    await user.click(button("medium"));
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toEqual([
        "reviewDecide 5521 urgency=medium note=third message",
      ]);
    });
    // The note belongs to the decision it went with.
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Note, optional" })).toHaveValue("");
    });
  });

  it("reaches the first nine options with a digit; the tenth is reached with Tab and shows no key", async () => {
    const options = Array.from({ length: 10 }, (_, index) => ({
      name: `team ${String(index + 1)}`,
      probability: 0.1,
    }));
    const many: ReviewCard = {
      ...SAMPLE_CARD,
      open: [{ ...URGENCY, type: "choice", name: "team", top: "team 1", options }],
      decided: [],
    };
    const { api, user } = await openReview({ reviewOpen: scripted(many) });
    expect(button("team 9")).toHaveAttribute("aria-keyshortcuts", "9");
    expect(button("team 10")).not.toHaveAttribute("aria-keyshortcuts");
    await user.keyboard("1");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toEqual(["reviewDecide 5521 team=team 1"]);
    });
  });

  it("skips with s, and the next card opens", async () => {
    const { api, user } = await openReview();
    await user.keyboard("s");
    expect(await screen.findByText("Where is my order")).toBeInTheDocument();
    expect(calls(api, "reviewSkip")).toEqual(["reviewSkip 5521"]);
    expect(api.refs).toContain("reviewSkip support_messages/5521@h-5521");
    expect(screen.getByText(/Skipped\. The card goes behind the rest for you/)).toBeInTheDocument();
  });

  it("says so when the skipped card is the only one waiting and comes back", async () => {
    const { user } = await openReview({ reviewOpen: scripted(SAMPLE_CARD, SAMPLE_CARD) });
    await user.keyboard("s");
    expect(
      await screen.findByText("No other card is waiting, so the card you skipped is back."),
    ).toBeInTheDocument();
  });

  it("ignores every key while the note has the focus, and leaves the field on Escape", async () => {
    const { api, user } = await openReview();
    const note = screen.getByRole("textbox", { name: "Note, optional" });
    await user.click(note);
    await user.keyboard("ysnu1q");
    expect(note).toHaveValue("ysnu1q");
    expect(api.calls.filter((call) => /^review(Decide|Skip|Undo|Release)/.test(call))).toEqual([]);
    await user.keyboard("{Escape}");
    expect(card()).toHaveFocus();
    await user.keyboard("s");
    await waitFor(() => {
      expect(calls(api, "reviewSkip")).toHaveLength(1);
    });
  });

  it("ignores a key pressed with a modifier held, or held down", async () => {
    const { api, user } = await openReview();
    await user.keyboard("{Control>}s{/Control}");
    await user.keyboard("{Meta>}y{/Meta}");
    await user.keyboard("{Alt>}1{/Alt}");
    await user.keyboard("{Shift>}s{/Shift}");
    expect(api.calls.filter((call) => /^review(Decide|Skip)/.test(call))).toEqual([]);
  });

  it("ignores a key while a dialog is open and while a listbox has the key", async () => {
    const { api, user } = await openReview();
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    document.body.append(dialog);
    await user.keyboard("s");
    dialog.remove();
    expect(calls(api, "reviewSkip")).toEqual([]);

    // A filter's listbox owns the letters (type-ahead): `s` there picks nothing for the card.
    screen.getByRole("combobox", { name: "Source" }).focus();
    await user.keyboard("s");
    await user.keyboard("{ArrowDown}");
    await user.keyboard("s");
    expect(calls(api, "reviewSkip")).toEqual([]);
  });

  it("takes a double press in flight as one decision", async () => {
    const pending = Promise.withResolvers<ReviewDecided>();
    const { api, user } = await openReview({
      reviewDecide: () => pending.promise,
      reviewOpen: scripted(SAMPLE_CARD, NEXT_CARD),
    });
    await user.keyboard("1");
    await user.keyboard("1");
    await user.keyboard("y");
    await user.keyboard("s");
    expect(calls(api, "reviewDecide")).toEqual(["reviewDecide 5521 urgency=low"]);
    expect(calls(api, "reviewSkip")).toEqual([]);
    pending.resolve(DONE);
    expect(await screen.findByText("Where is my order")).toBeInTheDocument();
    // The next card was not touched by the presses made while the first request was out.
    expect(calls(api, "reviewDecide")).toHaveLength(1);
  });

  it("shows the answer being sent as pressed until the worker has answered", async () => {
    const pending = Promise.withResolvers<ReviewDecided>();
    const { user } = await openReview({ reviewDecide: () => pending.promise });
    expect(button("low")).not.toHaveAttribute("aria-pressed");
    await user.keyboard("1");
    await waitFor(() => {
      expect(button("low")).toHaveAttribute("aria-pressed", "true");
    });
    expect(button("medium")).not.toHaveAttribute("aria-pressed");
    pending.resolve(STILL_OPEN);
    await screen.findByText(/urgency: low\. Written to the record/);
    expect(screen.queryByRole("button", { pressed: true })).toBeNull();
  });

  it("says what a key did at the foot of the window, and the words leave after a moment", async () => {
    const { schedule, user } = await openReview();
    await user.keyboard("s");
    const said = await screen.findByText(/Skipped\. The card goes behind the rest for you/);
    expect(said.closest('[role="status"]')).not.toBeNull();
    await act(async () => {
      schedule.advance(NOTICE_MS);
    });
    expect(screen.queryByText(/Skipped\./)).toBeNull();
    // The card sits right under the bar: a notice takes no room while there is none.
    expect(screen.getByRole("alert")).toBeEmptyDOMElement();
  });

  it("does not decide or skip a card whose hold is lost", async () => {
    const { api, user, schedule } = await openReview({
      reviewRenew: () => Promise.reject(refusal(409, "lock_lost", "You no longer hold this card.")),
    });
    await act(async () => {
      schedule.advance(60_000);
    });
    await screen.findByText(/You no longer hold this card\./);
    await user.keyboard("y");
    await user.keyboard("s");
    expect(api.calls.filter((call) => /^review(Decide|Skip)/.test(call))).toEqual([]);
  });
});

describe("the lock", () => {
  it("shows the time left as a strip and in words", async () => {
    await openReview();
    expect(screen.getByText("Locked for you, 10:00 left")).toBeInTheDocument();
    expect(screen.getByText(/Locked for you for 10 minutes\./)).toBeInTheDocument();
  });

  it("is renewed every 60 seconds while the card is open, and the time left follows the answer", async () => {
    const { api, schedule } = await openReview();
    await act(async () => {
      schedule.advance(59_000);
    });
    expect(calls(api, "reviewRenew")).toEqual([]);
    expect(screen.getByText("Locked for you, 9:01 left")).toBeInTheDocument();

    await act(async () => {
      schedule.advance(1_000);
    });
    await waitFor(() => {
      expect(calls(api, "reviewRenew")).toEqual(["reviewRenew 5521"]);
    });
    expect(api.refs).toContain("reviewRenew support_messages/5521@h-5521");
    // The fake answers a hold until 12:11, a minute after the renewal.
    await waitFor(() => {
      expect(screen.getByText("Locked for you, 10:00 left")).toBeInTheDocument();
    });

    await act(async () => {
      schedule.advance(60_000);
    });
    await waitFor(() => {
      expect(calls(api, "reviewRenew")).toHaveLength(2);
    });
  });

  it("stops being renewed after the last decision, and runs no timer on an empty queue", async () => {
    const { api, schedule, user } = await openReview({
      reviewOpen: scripted(SAMPLE_CARD, null),
      reviewDecide: () => Promise.resolve(DONE),
    });
    // The renewal, the lock strip's tick and the top bar's refresh.
    expect(schedule.running()).toBe(3);
    await user.keyboard("1");
    await screen.findByText("Nothing to review");
    // The top bar's refresh is left, and the confirmation at the foot of the window until it leaves.
    expect(schedule.running()).toBe(2);
    await act(async () => {
      schedule.advance(180_000);
    });
    expect(calls(api, "reviewRenew")).toEqual([]);
    expect(schedule.running()).toBe(1);
  });

  it("is given back when the reviewer leaves the page, and renewed no more", async () => {
    const { api, schedule, user } = await openReview();
    await user.click(
      within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name: "Home" }),
    );
    await waitFor(() => {
      expect(calls(api, "reviewRelease")).toEqual(["reviewRelease 5521"]);
    });
    await act(async () => {
      schedule.advance(120_000);
    });
    expect(calls(api, "reviewRenew")).toEqual([]);
  });

  it("is given back as the page closes", async () => {
    const { api } = await openReview();
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(calls(api, "reviewRelease")).toEqual(["reviewRelease 5521"]);
  });

  it("says at once, in words, that the hold was lost, and offers the next card", async () => {
    const { api, user, schedule } = await openReview({
      reviewRenew: () =>
        Promise.reject(
          refusal(
            409,
            "lock_lost",
            "You no longer hold this card: it was released, skipped, replaced by a newer card, or its hold ended.",
          ),
        ),
    });
    await act(async () => {
      schedule.advance(60_000);
    });
    const banner = await lostBanner();
    expect(banner.textContent).toContain("You no longer hold this card");
    expect(banner.textContent).toContain("Open the next card to carry on.");
    // The record stays to be read; the answers wait, and no timer runs for a hold that is gone.
    expect(screen.getByText("Charged twice")).toBeInTheDocument();
    expect(button("low")).toBeDisabled();
    expect(button("Yes")).toBeDisabled();
    // Only the top bar's refresh runs: no renewal, no countdown for a hold that is gone.
    expect(schedule.running()).toBe(1);
    expect(screen.getByText("No longer yours")).toBeInTheDocument();

    await user.click(within(banner).getByRole("button", { name: "Open the next card" }));
    expect(await screen.findByText("Where is my order")).toBeInTheDocument();
    // The lost card is not released again: it is not ours.
    expect(calls(api, "reviewRelease")).toEqual([]);
  });

  it("says who holds the card when another reviewer has it", async () => {
    const { schedule } = await openReview({
      reviewRenew: () =>
        Promise.reject(
          refusal(409, "card_held", "maya is reviewing this card until 2026-11-06T12:30:00.000Z."),
        ),
    });
    await act(async () => {
      schedule.advance(60_000);
    });
    const banner = await lostBanner();
    expect(banner.textContent).toMatch(/maya is reviewing this card until \d{1,2}:\d{2}/);
    expect(banner.textContent).not.toContain("2026-11-06T");
  });

  it("keeps the card and says so when the worker does not answer a renewal", async () => {
    const { schedule } = await openReview({
      reviewRenew: () => Promise.reject(new Error("offline")),
    });
    await act(async () => {
      schedule.advance(60_000);
    });
    expect(
      await screen.findByText(
        /your hold on this card was not renewed\. The next try is in a minute\./,
      ),
    ).toBeInTheDocument();
    expect(button("low")).toBeEnabled();
  });
});

describe("what the page does on each refusal", () => {
  it("moves to the next card when opening one says another reviewer holds it", async () => {
    const { api } = await openReview({
      reviewOpen: scripted(
        refusal(409, "card_held", "maya is reviewing this card until 2026-11-06T12:30:00.000Z."),
        SAMPLE_CARD,
      ),
    });
    expect(await screen.findByText(/maya is reviewing this card until/)).toBeInTheDocument();
    expect(screen.getByText(/Opening the next card\./)).toBeInTheDocument();
    expect(calls(api, "reviewOpen")).toHaveLength(2);
    expect(screen.getByText("Charged twice")).toBeInTheDocument();
  });

  it("shows the reason and moves on when the record changed (card_stale)", async () => {
    const { api, user } = await openReview({
      reviewDecide: () =>
        Promise.reject(
          refusal(
            409,
            "card_stale",
            "Nothing was decided: the record was edited while the card was open.",
          ),
        ),
    });
    await user.keyboard("y");
    expect(
      await screen.findByText(
        /Nothing was decided: the record was edited while the card was open\. Opening the next card\./,
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText("Where is my order")).toBeInTheDocument();
    // The surface took the card out of the queue itself: there is nothing to give back.
    expect(calls(api, "reviewRelease")).toEqual([]);
  });

  it("shows the reason and opens this same card again, by its key, when a decision is refused (422)", async () => {
    const { api, user } = await openReview({
      reviewDecide: () =>
        Promise.reject(
          refusal(
            422,
            "decision_refused",
            'The decision was not taken: "urgency" is already decided on this card.',
          ),
        ),
      reviewOpen: scripted(SAMPLE_CARD, CHANGED_CARD, NEXT_CARD),
    });
    await user.keyboard("1");
    expect(
      await screen.findByText(/already decided on this card\. Opening this card again/),
    ).toBeInTheDocument();
    // The same record, as it stands now: urgency is decided, one question is open. Not the next card.
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "low" })).toBeNull();
    });
    expect(screen.getByRole("region", { name: "How urgent is this message?" })).toBeInTheDocument();
    expect(screen.queryByText("Where is my order")).toBeNull();
    expect(calls(api, "reviewOpen")).toEqual([
      "reviewOpen",
      "reviewOpen source=support_messages key=5521",
    ]);
    // The hold is the reviewer's still: nothing is given back first.
    expect(calls(api, "reviewRelease")).toEqual([]);
  });

  it("falls back to the next card when the named record cannot be opened again", async () => {
    const { api, user } = await openReview({
      reviewDecide: () =>
        Promise.reject(refusal(422, "decision_refused", "The decision was not taken: stale.")),
      reviewOpen: scripted(
        SAMPLE_CARD,
        refusal(404, "card_gone", "No card of this record waits in the review queue."),
        NEXT_CARD,
      ),
    });
    await user.keyboard("1");
    expect(await screen.findByText("Where is my order")).toBeInTheDocument();
    expect(screen.getByText(/No card of this record waits/)).toBeInTheDocument();
    expect(calls(api, "reviewOpen")).toEqual([
      "reviewOpen",
      "reviewOpen source=support_messages key=5521",
      "reviewOpen",
    ]);
  });

  it("does not send the note of one card with the decision of another (card_stale)", async () => {
    const decisions = [
      () =>
        Promise.reject(refusal(409, "card_stale", "Nothing was decided: the record was edited.")),
      () => Promise.resolve(DONE),
    ];
    let decided = 0;
    const { api, user } = await openReview({
      reviewDecide: () => decisions[decided++]?.() ?? Promise.resolve(DONE),
      reviewOpen: scripted(SAMPLE_CARD, NEXT_CARD),
    });
    await user.type(screen.getByRole("textbox", { name: "Note, optional" }), "about 5521");
    await user.click(button("Yes"));
    await screen.findByText("Where is my order");
    expect(screen.getByRole("textbox", { name: "Note, optional" })).toHaveValue("");
    await user.click(button("Yes"));
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(2);
    });
    expect(calls(api, "reviewDecide")).toEqual([
      "reviewDecide 5521 wants_refund=true note=about 5521",
      "reviewDecide 5522 wants_refund=true",
    ]);
  });

  it("does not send the note of one card with the decision of another (card_gone)", async () => {
    const decisions = [
      () => Promise.reject(refusal(404, "card_gone", "No card of this record waits.")),
      () => Promise.resolve(DONE),
    ];
    let decided = 0;
    const { api, user } = await openReview({
      reviewDecide: () => decisions[decided++]?.() ?? Promise.resolve(DONE),
      reviewOpen: scripted(SAMPLE_CARD, NEXT_CARD),
    });
    await user.type(screen.getByRole("textbox", { name: "Note, optional" }), "about 5521");
    await user.click(button("Yes"));
    await screen.findByText("Where is my order");
    await user.click(button("Yes"));
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(2);
    });
    expect(calls(api, "reviewDecide")[1]).toBe("reviewDecide 5522 wants_refund=true");
  });

  it("does not send the note of a card that was refused along with the next decision (422)", async () => {
    const decisions = [
      () => Promise.reject(refusal(422, "decision_refused", "The decision was not taken.")),
      () => Promise.resolve(STILL_OPEN),
    ];
    let decided = 0;
    const { api, user } = await openReview({
      reviewDecide: () => decisions[decided++]?.() ?? Promise.resolve(DONE),
      reviewOpen: scripted(SAMPLE_CARD, CHANGED_CARD),
    });
    await user.type(screen.getByRole("textbox", { name: "Note, optional" }), "about urgency");
    await user.click(button("low"));
    await waitFor(() => {
      expect(calls(api, "reviewOpen")).toHaveLength(2);
    });
    await screen.findByRole("region", { name: "How urgent is this message?" });
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Note, optional" })).toHaveValue("");
    });
    await user.click(button("Yes"));
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(2);
    });
    expect(calls(api, "reviewDecide")[1]).toBe("reviewDecide 5521 wants_refund=true");
  });

  it("marks the card lost when the decision finds the hold gone (lock_lost)", async () => {
    const { user } = await openReview({
      reviewDecide: () =>
        Promise.reject(refusal(409, "lock_lost", "You no longer hold this card.")),
    });
    await user.keyboard("n");
    const banner = await lostBanner();
    expect(banner.textContent).toContain("You no longer hold this card.");
    expect(button("Yes")).toBeDisabled();
  });

  it("moves on when the card is gone (card_gone) as a decision is made", async () => {
    const { user } = await openReview({
      reviewDecide: () =>
        Promise.reject(
          refusal(404, "card_gone", "No card of this record waits in the review queue."),
        ),
    });
    await user.keyboard("y");
    expect(await screen.findByText(/No card of this record waits/)).toBeInTheDocument();
    expect(await screen.findByText("Where is my order")).toBeInTheDocument();
  });

  it("asks for a reload when the request itself was invalid (400)", async () => {
    const { user } = await openReview({
      reviewDecide: () => Promise.reject(refusal(400, "invalid_request", "The body is not valid.")),
    });
    await user.keyboard("y");
    expect(await screen.findByText(/The body is not valid\. Reload the page/)).toBeInTheDocument();
    // The card is still there to decide again.
    expect(button("Yes")).toBeEnabled();
  });

  it("opens the card again by its key when a decision gets no answer, and says it was not taken", async () => {
    const { api, user } = await openReview({
      reviewDecide: () => Promise.reject(new Error("offline")),
      reviewOpen: scripted(SAMPLE_CARD, SAMPLE_CARD),
    });
    await user.keyboard("y");
    expect(
      await screen.findByText(/The worker did not answer\..*The decision was not taken/),
    ).toBeInTheDocument();
    expect(calls(api, "reviewOpen")).toEqual([
      "reviewOpen",
      "reviewOpen source=support_messages key=5521",
    ]);
    expect(button("Yes")).toBeEnabled();
    expect(button("Undo")).toBeDisabled();
  });

  it("finds a decision that was taken after all, says so, and lets u cover it", async () => {
    const { api, user } = await openReview({
      reviewDecide: () => Promise.reject(new Error("offline")),
      reviewOpen: scripted(SAMPLE_CARD, TAKEN_CARD),
    });
    await user.keyboard("1");
    expect(
      await screen.findByText(/The decision was taken after all: urgency is low\./),
    ).toBeInTheDocument();
    expect(button("Undo")).toBeEnabled();
    await user.keyboard("u");
    expect(await screen.findByText(/Undid your decision on urgency \(low\)/)).toBeInTheDocument();
    expect(calls(api, "reviewUndo")).toEqual(["reviewUndo"]);
  });

  it("does not send the note of a decision that was taken after all with the next question's", async () => {
    const answers = [() => Promise.reject(new Error("offline")), () => Promise.resolve(DONE)];
    let asked = 0;
    const { api, user } = await openReview({
      reviewDecide: () => answers[asked++]?.() ?? Promise.resolve(DONE),
      reviewOpen: scripted(SAMPLE_CARD, TAKEN_CARD),
    });
    await user.type(screen.getByRole("textbox", { name: "Note, optional" }), "about urgency");
    await user.click(button("low"));
    expect(await screen.findByText(/The decision was taken after all/)).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByRole("textbox", { name: "Note, optional" })).toHaveValue("");
    });
    await user.click(button("Yes"));
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(2);
    });
    expect(calls(api, "reviewDecide")).toEqual([
      "reviewDecide 5521 urgency=low note=about urgency",
      "reviewDecide 5521 wants_refund=true",
    ]);
  });

  it("says when the question now stands decided as something else", async () => {
    const { user } = await openReview({
      reviewDecide: () => Promise.reject(new Error("offline")),
      reviewOpen: scripted(SAMPLE_CARD, OTHER_CARD),
    });
    await user.keyboard("1");
    expect(
      await screen.findByText(/urgency stands decided as high, which is not what this page sent\./),
    ).toBeInTheDocument();
    expect(button("Undo")).toBeDisabled();
  });

  it("says the card could not be checked when the worker still does not answer", async () => {
    const { user } = await openReview({
      reviewDecide: () => Promise.reject(new Error("offline")),
      reviewOpen: (target) =>
        target !== undefined && "key" in target
          ? Promise.reject(new Error("offline"))
          : Promise.resolve({ card: SAMPLE_CARD }),
    });
    await user.keyboard("y");
    expect(await screen.findByText(/the card could not be checked/)).toBeInTheDocument();
    expect(button("Yes")).toBeEnabled();
  });

  it("sends the browser to sign in when any call says so", async () => {
    const { user, history } = await openReview({
      reviewDecide: () => Promise.reject(signInRequired()),
    });
    await user.keyboard("y");
    await waitFor(() => {
      expect(history.location.pathname).toBe("/sign-in");
    });
  });

  it("offers to try again when the next card cannot be opened", async () => {
    const api = fakeApi({
      reviewOpen: scripted(refusal(500, "internal", "The queue could not be read."), SAMPLE_CARD),
    });
    const { user } = renderStudio({ path: "/review", api });
    expect(await screen.findByText("The next card did not open")).toBeInTheDocument();
    expect(
      screen.getByText(/The queue could not be read\. Fix for internal\./),
    ).toBeInTheDocument();
    await user.click(button("Try again"));
    expect(await screen.findByRole("article")).toBeInTheDocument();
  });

  it("shows every card again when the filter names a source the project no longer has", async () => {
    const { api, user } = await openReview({
      reviewOpen: scripted(
        SAMPLE_CARD,
        refusal(404, "unknown_source", 'This project has no source called "listings".'),
        NEXT_CARD,
      ),
    });
    const source = screen.getByRole("combobox", { name: "Source" });
    source.focus();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("option", { name: "listings" });
    await user.keyboard("{ArrowDown}{Enter}");
    expect(await screen.findByText(/Showing every card instead\./)).toBeInTheDocument();
    expect(await screen.findByText("Where is my order")).toBeInTheDocument();
    expect(calls(api, "reviewOpen")).toEqual([
      "reviewOpen",
      "reviewOpen source=listings",
      "reviewOpen",
    ]);
    expect(screen.getByRole("combobox", { name: "Source" })).toHaveTextContent("Every source");
  });

  it("tells the decision's failed actions apart: the decision stands", async () => {
    const { user } = await openReview({
      reviewDecide: () =>
        Promise.resolve({ status: "done", open: [], failedActions: ["notify_billing"] }),
    });
    await user.keyboard("y");
    expect(
      await screen.findByText(/The decision stands, but these actions failed: notify_billing\./),
    ).toBeInTheDocument();
  });
});

describe("undo", () => {
  it("offers u only for a decision this page made, and says so when there is none", async () => {
    const { api, user } = await openReview();
    expect(button("Undo")).toBeDisabled();
    await user.keyboard("u");
    expect(await screen.findByText(/Nothing to undo/)).toBeInTheDocument();
    expect(calls(api, "reviewUndo")).toEqual([]);
  });

  it("takes the last decision back and brings the card back", async () => {
    const { api, user } = await openReview({
      reviewOpen: scripted(SAMPLE_CARD, NEXT_CARD),
      reviewDecide: () => Promise.resolve(DONE),
    });
    await user.keyboard("1");
    await screen.findByText("Where is my order");
    expect(button("Undo")).toBeEnabled();

    await user.keyboard("u");
    expect(
      await screen.findByText(/Undid your decision on urgency \(low\) for support_messages 5521\./),
    ).toBeInTheDocument();
    expect(calls(api, "reviewUndo")).toEqual(["reviewUndo"]);
    // The card is back with both questions open, and the card shown before is given back.
    expect(await screen.findByText("Charged twice")).toBeInTheDocument();
    expect(calls(api, "reviewRelease")).toEqual(["reviewRelease 5522"]);
    // Once only: nothing more to undo.
    expect(button("Undo")).toBeDisabled();
  });

  it("says when the card is not the reviewer's to hold any more", async () => {
    const { user } = await openReview({
      reviewDecide: () => Promise.resolve(STILL_OPEN),
      reviewUndo: () => Promise.resolve({ status: "needs_review", card: null, failedActions: [] }),
    });
    await user.keyboard("3");
    await screen.findByText(/1 question is left/);
    await user.keyboard("u");
    expect(await screen.findByText(/The card is not yours to hold now/)).toBeInTheDocument();
  });

  it("says when the surface undid a decision made in another window", async () => {
    const { user } = await openReview({
      reviewDecide: () => Promise.resolve(STILL_OPEN),
      reviewUndo: () =>
        Promise.resolve({ status: "needs_review", card: NEXT_CARD, failedActions: [] }),
    });
    await user.keyboard("3");
    await screen.findByText(/1 question is left/);
    await user.keyboard("u");
    expect(await screen.findByText(/it was made in another window/)).toBeInTheDocument();
  });

  it("shows the surface's refusal and offers no second undo", async () => {
    const { user } = await openReview({
      reviewDecide: () => Promise.resolve(STILL_OPEN),
      reviewUndo: () =>
        Promise.reject(
          refusal(409, "cannot_undo", "Your last decision stands: the record changed."),
        ),
    });
    await user.keyboard("3");
    await screen.findByText(/1 question is left/);
    await user.keyboard("u");
    expect(
      await screen.findByText(/Your last decision stands: the record changed\./),
    ).toBeInTheDocument();
    expect(button("Undo")).toBeDisabled();
  });
});

describe("leaving", () => {
  it("releases the card and returns to Home on q", async () => {
    const { api, user, history } = await openReview();
    await user.keyboard("q");
    await waitFor(() => {
      expect(history.location.pathname).toBe("/");
    });
    expect(calls(api, "reviewRelease")).toEqual(["reviewRelease 5521"]);
    expect(api.refs).toContain("reviewRelease support_messages/5521@h-5521");
  });

  it("waits for a decision in flight before giving the card back when the page is left", async () => {
    const pending = Promise.withResolvers<ReviewDecided>();
    const { api, user, history } = await openReview({ reviewDecide: () => pending.promise });
    await user.keyboard("1");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(1);
    });
    await user.click(
      within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name: "Home" }),
    );
    await waitFor(() => {
      expect(history.location.pathname).toBe("/");
    });
    // The release must not reach the server ahead of the decision.
    expect(calls(api, "reviewRelease")).toEqual([]);
    pending.resolve(STILL_OPEN);
    await waitFor(() => {
      expect(calls(api, "reviewRelease")).toEqual(["reviewRelease 5521"]);
    });
    expect(api.calls.findIndex((call) => call.startsWith("reviewDecide"))).toBeLessThan(
      api.calls.findIndex((call) => call.startsWith("reviewRelease")),
    );
  });

  it("gives nothing back after a decision in flight finished the record", async () => {
    const pending = Promise.withResolvers<ReviewDecided>();
    const { api, user } = await openReview({ reviewDecide: () => pending.promise });
    await user.keyboard("1");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(1);
    });
    await user.click(
      within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name: "Home" }),
    );
    pending.resolve(DONE);
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls(api, "reviewRelease")).toEqual([]);
  });

  it("opens a card again when the page comes back from the browser's cache", async () => {
    const { api } = await openReview({ reviewOpen: scripted(SAMPLE_CARD, NEXT_CARD) });
    act(() => {
      window.dispatchEvent(new Event("pagehide"));
    });
    expect(calls(api, "reviewRelease")).toEqual(["reviewRelease 5521"]);
    // A pageshow that is not a restore changes nothing.
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: false }));
    });
    expect(calls(api, "reviewOpen")).toHaveLength(1);
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });
    expect(await screen.findByText("Where is my order")).toBeInTheDocument();
    expect(calls(api, "reviewOpen")).toHaveLength(2);
  });

  it("does the same from the Leave button", async () => {
    const { api, user, history } = await openReview();
    await user.click(button("Leave"));
    await waitFor(() => {
      expect(history.location.pathname).toBe("/");
    });
    expect(calls(api, "reviewRelease")).toEqual(["reviewRelease 5521"]);
  });
});

describe("the empty queue and the filters", () => {
  it("says there is nothing to review and offers to check again", async () => {
    const api = fakeApi({ reviewOpen: scripted(null, SAMPLE_CARD) });
    const { user } = renderStudio({ path: "/review", api });
    expect(await screen.findByText("Nothing to review")).toBeInTheDocument();
    await user.click(button("Check again"));
    expect(await screen.findByRole("article")).toBeInTheDocument();
  });

  it("opens the next card under a filter, giving the card in hand back", async () => {
    const { api, user } = await openReview({ reviewOpen: scripted(SAMPLE_CARD, NEXT_CARD) });
    const source = screen.getByRole("combobox", { name: "Source" });
    source.focus();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("option", { name: "listings" });
    await user.keyboard("{ArrowDown}{Enter}");
    await screen.findByText("Where is my order");
    expect(calls(api, "reviewRelease")).toEqual(["reviewRelease 5521"]);
    expect(calls(api, "reviewOpen")).toEqual(["reviewOpen", "reviewOpen source=listings"]);
    // The queue figures ask under the same filter.
    await waitFor(() => {
      expect(api.calls).toContain("reviewQueue");
    });
  });

  it("offers a certainty band, and a band narrows the open", async () => {
    const { api, user } = await openReview({ reviewOpen: scripted(SAMPLE_CARD, NEXT_CARD) });
    const band = screen.getByRole("combobox", { name: "Certainty" });
    band.focus();
    await user.keyboard("{ArrowDown}");
    await screen.findByRole("option", { name: "Below 60%" });
    await user.keyboard("{ArrowDown}{Enter}");
    await screen.findByText("Where is my order");
    expect(calls(api, "reviewOpen")).toEqual(["reviewOpen", "reviewOpen below=0.6"]);
  });
});

describe("a key held down", () => {
  /**
   * What a browser does with a held Enter once the focus has moved to `target`: it sends a
   * repeated keydown, and clicks the button unless that keydown was cancelled. (user-event only
   * marks the repeats inside one keyboard call, so the repeat is sent by hand.) A second kind of
   * engine sends the click with no keydown the page saw at all; both must decide nothing.
   */
  function keyRepeatsOn(target: HTMLElement): void {
    const proceeds = fireEvent.keyDown(target, { key: "Enter", repeat: true });
    expect(proceeds).toBe(false);
    if (proceeds) {
      fireEvent.click(target, { detail: 0 });
    }
    fireEvent.click(target, { detail: 0 });
  }

  const THIRD_CARD: ReviewCard = { ...NEXT_CARD, key: "5523", stateHash: "h-5523" };

  it("decides once when Enter is held across a decision, and again only after it is released", async () => {
    const { api, user } = await openReview({
      reviewDecide: () => Promise.resolve(STILL_OPEN),
      reviewOpen: scripted(SAMPLE_CARD, NEXT_CARD),
    });
    focusOn("low");
    await user.keyboard("{Enter>}");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toEqual(["reviewDecide 5521 urgency=low"]);
    });
    // The focus has moved to the next question's first answer, with the key still down: this
    // reviewer answers from a focused button, and carries on from there.
    await waitFor(() => {
      expect(button("Yes")).toHaveFocus();
    });
    keyRepeatsOn(button("Yes"));
    expect(calls(api, "reviewDecide")).toEqual(["reviewDecide 5521 urgency=low"]);
    await user.keyboard("{/Enter}");
    expect(calls(api, "reviewDecide")).toHaveLength(1);

    // A new press, on the answer the reviewer has now seen, decides.
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(2);
    });
    expect(calls(api, "reviewDecide")[1]).toBe("reviewDecide 5521 wants_refund=true");
  });

  it("decides once when Enter is held across a decision and a card change", async () => {
    const { api, user } = await openReview({
      reviewDecide: () => Promise.resolve(DONE),
      reviewOpen: scripted(NEXT_CARD, THIRD_CARD),
    });
    focusOn("Yes");
    await user.keyboard("{Enter>}");
    await screen.findByRole("article");
    await waitFor(() => {
      expect(calls(api, "reviewOpen")).toHaveLength(2);
    });
    await waitFor(() => {
      expect(button("Yes")).toHaveFocus();
    });
    keyRepeatsOn(button("Yes"));
    await user.keyboard("{/Enter}");
    expect(calls(api, "reviewDecide")).toEqual(["reviewDecide 5522 wants_refund=true"]);

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toEqual([
        "reviewDecide 5522 wants_refund=true",
        "reviewDecide 5523 wants_refund=true",
      ]);
    });
  });

  it("does nothing for a Space released on an answer the press did not begin on", async () => {
    const { api, user } = await openReview({ reviewDecide: () => Promise.resolve(STILL_OPEN) });
    // Space goes down on "low"; the focus moves to "Yes" while it is down; it comes up there.
    focusOn("low");
    await user.keyboard("[Space>]");
    act(() => {
      button("Yes").focus();
    });
    await user.keyboard("[/Space]");
    expect(calls(api, "reviewDecide")).toEqual([]);

    // A whole press on "Yes" decides.
    await user.keyboard("[Space]");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toEqual(["reviewDecide 5521 wants_refund=true"]);
    });
  });

  it("leaves a repeated Space alone in the note and in the record's scroll region", async () => {
    await openReview();
    const note = screen.getByRole("textbox", { name: "Note, optional" });
    // fireEvent returns false when the keydown was cancelled.
    expect(fireEvent.keyDown(note, { key: " ", repeat: true })).toBe(true);
    expect(fireEvent.keyDown(note, { key: "Enter", repeat: true })).toBe(true);
    const record = screen.getByRole("region", { name: "The record" });
    expect(fireEvent.keyDown(record, { key: " ", repeat: true })).toBe(true);
    // On an answer button the same repeat is cancelled.
    expect(fireEvent.keyDown(button("low"), { key: " ", repeat: true })).toBe(false);
  });

  it("does not swallow an assistive technology's click after Enter was pressed outside the stage", async () => {
    const { api, user } = await openReview({ reviewDecide: () => Promise.resolve(STILL_OPEN) });
    // Enter goes down and up on a control outside the stage (the theme switch in the rail).
    const theme = screen.getByRole("button", { name: /Switch to the/ });
    act(() => {
      theme.focus();
    });
    await user.keyboard("{Enter}");
    // A screen reader then activates an answer: a click with no key in play.
    fireEvent.click(button("low"), { detail: 0 });
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toEqual(["reviewDecide 5521 urgency=low"]);
    });
  });

  it("forgets a finished press on the stage too, once any other key or focus has come after it", async () => {
    const { api, user } = await openReview({ reviewDecide: () => Promise.resolve(STILL_OPEN) });
    act(() => {
      button("low").focus();
    });
    await user.keyboard("{Enter}");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(1);
    });
    await waitFor(() => {
      expect(button("Yes")).toHaveFocus();
    });
    // The press was finished and then a key came: a click with no key in play is not cancelled.
    await user.keyboard("a");
    fireEvent.click(button("Yes"), { detail: 0 });
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(2);
    });
  });

  it("decides once when Space is repeated while held, and a click of the pointer is left alone", async () => {
    const { api, user } = await openReview({ reviewDecide: () => Promise.resolve(STILL_OPEN) });
    focusOn("low");
    await user.keyboard("[Space>3/]");
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(1);
    });
    await user.click(button("Yes"));
    await waitFor(() => {
      expect(calls(api, "reviewDecide")).toHaveLength(2);
    });
  });
});

describe("the top bar when the worker cannot be reached", () => {
  function queueThatFails() {
    const state = { failing: false };
    const reviewQueue = () =>
      state.failing
        ? Promise.reject(refusal(503, "unavailable", "The worker could not read the queue."))
        : Promise.resolve(SAMPLE_QUEUE);
    return { state, reviewQueue };
  }

  it("marks the count as last known, with the time, and says it could not be refreshed", async () => {
    const { state, reviewQueue } = queueThatFails();
    const { schedule } = await openReview({ reviewQueue });
    expect(await screen.findByText("37 to review.")).toBeInTheDocument();

    state.failing = true;
    for (let refresh = 0; refresh < 3; refresh += 1) {
      await act(async () => {
        schedule.advance(15_000);
      });
    }
    expect(await screen.findByText("Last known: 37 to review.")).toBeInTheDocument();
    expect(screen.queryByText("37 to review.")).toBeNull();
    expect(
      screen.getByText(/The oldest had waited 14 minutes at \d{1,2}:\d{2}/),
    ).toBeInTheDocument();
    expect(screen.getByText("The queue could not be refreshed")).toBeInTheDocument();
    expect(screen.queryByText(/The oldest has waited/)).toBeNull();
  });

  it("clears at the next good refresh", async () => {
    const { state, reviewQueue } = queueThatFails();
    const { schedule } = await openReview({ reviewQueue });
    await screen.findByText("37 to review.");
    state.failing = true;
    await act(async () => {
      schedule.advance(15_000);
    });
    await screen.findByText("The queue could not be refreshed");

    state.failing = false;
    await act(async () => {
      schedule.advance(15_000);
    });
    expect(await screen.findByText("37 to review.")).toBeInTheDocument();
    expect(screen.queryByText("The queue could not be refreshed")).toBeNull();
    expect(screen.queryByText(/Last known/)).toBeNull();
  });

  it("says the queue could not be counted when it never answered", async () => {
    const api = fakeApi({
      reviewQueue: () => Promise.reject(refusal(503, "unavailable", "No queue.")),
    });
    renderStudio({ path: "/review", api });
    expect(await screen.findByText("The queue could not be counted.")).toBeInTheDocument();
  });

  it("offers only the 'every' choices when the filter choices never loaded", async () => {
    const api = fakeApi({
      reviewQueue: (options) =>
        options?.limit === 200
          ? Promise.reject(refusal(503, "unavailable", "No queue."))
          : Promise.resolve(SAMPLE_QUEUE),
    });
    const { user } = renderStudio({ path: "/review", api });
    await screen.findByRole("article");
    screen.getByRole("combobox", { name: "Source" }).focus();
    await user.keyboard("{ArrowDown}");
    expect(await screen.findAllByRole("option")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "Every source" })).toBeInTheDocument();
  });
});

describe("undo names what the surface undid", () => {
  it("names another question of the same record when the surface undid that one", async () => {
    const spam = { ...REFUND, name: "is_spam", instructions: "Is it spam?" };
    const undone: ReviewCard = { ...SAMPLE_CARD, open: [REFUND, spam] };
    const { user } = await openReview({
      reviewDecide: () => Promise.resolve(STILL_OPEN),
      reviewUndo: () =>
        Promise.resolve({ status: "needs_review", card: undone, failedActions: [] }),
    });
    await user.keyboard("3");
    await screen.findByText(/1 question is left/);
    await user.keyboard("u");
    expect(
      await screen.findByText(/Undid the decision on is_spam of support_messages 5521\./),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Undid your decision on urgency/)).toBeNull();
  });
});

describe("under StrictMode, as main.tsx mounts it", () => {
  it("opens one card and keeps one renewal timer", async () => {
    const { api, schedule } = await openReview({}, { strict: true });
    // Let a development remount's second start settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls(api, "reviewOpen")).toEqual(["reviewOpen"]);
    await act(async () => {
      schedule.advance(60_000);
    });
    await waitFor(() => {
      expect(calls(api, "reviewRenew")).toEqual(["reviewRenew 5521"]);
    });
    expect(api.refs).toContain("reviewRenew support_messages/5521@h-5521");
    expect(calls(api, "reviewRelease")).toEqual([]);
  });
});

describe("the rail's count", () => {
  it("follows a decision", async () => {
    let waiting = 37;
    const { user } = await openReview({
      reviewQueue: () => Promise.resolve({ ...SAMPLE_QUEUE, count: waiting }),
      reviewDecide: () => {
        waiting = 36;
        return Promise.resolve(DONE);
      },
    });
    const rail = screen.getByRole("navigation", { name: "Pages" });
    await waitFor(() => {
      expect(within(rail).getByRole("link", { name: /Review/ }).textContent).toContain("37");
    });
    await user.keyboard("1");
    await waitFor(() => {
      expect(within(rail).getByRole("link", { name: /Review/ }).textContent).toContain("36");
    });
  });
});
