import { describe, expect, it } from "vitest";
import type { ReviewCard } from "../../api/index.ts";
import { fakeScheduler, SAMPLE_CARD } from "../../testing/index.ts";
import { createReviewController, type ReviewCalls, type ReviewDeps } from "./controller.ts";

/**
 * The Review session on its own: the decision for a card is refused unless the card named is the
 * card held, whatever was drawn when a key or a click was made.
 */

const NEXT: ReviewCard = { ...SAMPLE_CARD, key: "5522", stateHash: "h-5522" };

/** Lets every promise the session has chained settle. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) {
    await Promise.resolve();
  }
}

function session(cards: readonly ReviewCard[]) {
  const sent: string[] = [];
  let next = 0;
  const calls: ReviewCalls = {
    open: () => {
      const card = cards[next] ?? null;
      next += 1;
      return Promise.resolve({ card });
    },
    renew: () => Promise.resolve({ lockedUntil: SAMPLE_CARD.lockedUntil }),
    decide: (card, decision) => {
      sent.push(`${card.key}@${card.stateHash} ${decision.question}`);
      return Promise.resolve({ status: "done", open: [], failedActions: [] });
    },
    skip: () => Promise.resolve(),
    release: () => Promise.resolve(),
    undo: () => Promise.resolve({ status: "needs_review", card: null, failedActions: [] }),
  };
  const deps: ReviewDeps = {
    calls,
    closing: () => undefined,
    schedule: fakeScheduler(),
    counted: () => undefined,
    goHome: () => undefined,
    reviewer: () => "os:alex",
  };
  const controller = createReviewController(() => deps);
  return { controller, sent };
}

describe("a decision names the card it was drawn on", () => {
  it("is refused for a card that has been replaced since it was drawn", async () => {
    const { controller, sent } = session([SAMPLE_CARD, NEXT]);
    controller.start();
    await settle();
    const drawn = {
      source: SAMPLE_CARD.source,
      key: SAMPLE_CARD.key,
      stateHash: SAMPLE_CARD.stateHash,
    };

    // Another card takes the screen (a skip), and then the answer drawn on the old one is pressed.
    controller.skip();
    await settle();
    expect(controller.getState().screen).toMatchObject({ kind: "card", card: { key: "5522" } });
    controller.decide(drawn, "wants_refund", true);
    await settle();
    expect(sent).toEqual([]);

    controller.decide(
      { source: NEXT.source, key: NEXT.key, stateHash: NEXT.stateHash },
      "wants_refund",
      true,
    );
    await settle();
    expect(sent).toEqual(["5522@h-5522 wants_refund"]);
  });

  it("is refused for the same record at another state, and for no card at all", async () => {
    const { controller, sent } = session([SAMPLE_CARD]);
    controller.start();
    await settle();
    controller.decide(
      { source: SAMPLE_CARD.source, key: SAMPLE_CARD.key, stateHash: "h-older" },
      "wants_refund",
      true,
    );
    await settle();
    expect(sent).toEqual([]);

    controller.stop();
    controller.decide(
      { source: SAMPLE_CARD.source, key: SAMPLE_CARD.key, stateHash: SAMPLE_CARD.stateHash },
      "wants_refund",
      true,
    );
    await settle();
    expect(sent).toEqual([]);
  });
});
