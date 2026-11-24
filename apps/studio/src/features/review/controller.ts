import {
  ApiError,
  needsSignIn,
  type ReviewCard,
  type ReviewCardId,
  type ReviewDecided,
  type ReviewFilter,
  type ReviewOpened,
  type ReviewOpenTarget,
  type ReviewUndone,
} from "../../api/index.ts";
import type { Scheduler } from "../../schedule.ts";
import { plainTimes, RENEW_EVERY_MS, valueWords } from "./words.ts";

/**
 * The Review page's session: the card the reviewer holds, what they did with it, and every request
 * in between. It is plain TypeScript over injected calls and an injected scheduler, so the page
 * below it only draws a state and forwards keys, and a test moves time by hand.
 *
 * The rules it keeps:
 * - One request about a card at a time. `run` refuses a second while one is in flight, so a double
 *   press never decides the next question or the next card (the terminal review had that defect).
 * - The hold is renewed every minute while the card is open. The renewal
 *   stops when the card is left or its hold is lost, and a lost hold is said in words at once.
 * - The card is released when the reviewer leaves, quits, changes the filter or the page closes.
 * - `u` undoes only a decision this page made: the page remembers its last one and names it to the
 *   server, which refuses any but the reviewer's last decision.
 */

/** A line the page says: a confirmation, or a warning that needs reading. */
export type Notice = {
  /** Changes with every notice, so a repeated sentence is announced again. */
  readonly id: number;
  readonly tone: "information" | "warning";
  readonly text: string;
};

export type Screen =
  | { readonly kind: "opening" }
  /** Nothing waits under the filter. */
  | { readonly kind: "empty" }
  /** The next card could not be opened; the notice says why. */
  | { readonly kind: "failed" }
  /** `lost` is the words saying the hold ended; the card stays to be read, its answers disabled. */
  | { readonly kind: "card"; readonly card: ReviewCard; readonly lost: string | null };

export type ReviewState = {
  readonly screen: Screen;
  readonly notice: Notice | null;
  readonly filter: ReviewFilter;
  /** A request is in flight. */
  readonly busy: boolean;
  /** The answer being sent, while its request is in flight: its button shows as pressed. */
  readonly answering: { readonly question: string; readonly value: boolean | string } | null;
  /** This page made a decision that `u` can take back. */
  readonly canUndo: boolean;
  readonly note: string;
};

/** The calls the session makes, as the page wires them (through mutations, so a sign-in answer reaches the shell). */
export type ReviewCalls = {
  readonly open: (target: ReviewOpenTarget) => Promise<ReviewOpened>;
  readonly renew: (card: ReviewCardId) => Promise<{ readonly lockedUntil: string }>;
  readonly decide: (
    card: ReviewCardId,
    decision: {
      readonly question: string;
      readonly value: boolean | string;
      readonly note?: string;
    },
  ) => Promise<ReviewDecided>;
  readonly skip: (card: ReviewCardId) => Promise<void>;
  readonly release: (card: ReviewCardId) => Promise<void>;
  readonly undo: (card: ReviewCardId, question: string) => Promise<ReviewUndone>;
};

export type ReviewDeps = {
  readonly calls: ReviewCalls;
  /** Lets go of a card as the page closes: no answer is waited for. */
  readonly closing: (card: ReviewCardId) => void;
  readonly schedule: Scheduler;
  /** The queue's count moved: the rail and the top bar ask again. */
  readonly counted: () => void;
  /** `q`: back to Home. */
  readonly goHome: () => void;
  /** The reviewer's name, for "logged for hailey"; unknown until the project has answered. */
  readonly reviewer: () => string | undefined;
};

const NO_ANSWER = "The worker did not answer. Check that it is running and your connection.";

const FIRST_STATE: ReviewState = {
  screen: { kind: "opening" },
  notice: null,
  filter: {},
  busy: false,
  answering: null,
  canUndo: false,
  note: "",
};

type Life = {
  cancelled: boolean;
  /** The card to give back once what was in flight when the page was left has settled. */
  giveBack: ReviewCardId | null;
};
/** The page's own last decision: the card it was made on and its question, what an undo names. */
type LastDecision = {
  readonly card: ReviewCardId;
  readonly question: string;
  readonly said: string;
};

const idOf = (card: ReviewCardId): ReviewCardId => ({
  source: card.source,
  key: card.key,
  stateHash: card.stateHash,
});
type RecordRef = { readonly source: string; readonly key: string };
const sameRecord = (a: RecordRef, b: RecordRef) => a.source === b.source && a.key === b.key;
const sameCard = (a: ReviewCardId, b: ReviewCardId) =>
  sameRecord(a, b) && a.stateHash === b.stateHash;

/** Which card a screen shows: its source, key and state hash, or nothing. */
function cardKey(screen: Screen): string | null {
  return screen.kind === "card"
    ? `${screen.card.source}\n${screen.card.key}\n${screen.card.stateHash}`
    : null;
}

/** The surface's refusal in words, or the plain fact that nothing answered. */
function describe(error: unknown): string {
  return error instanceof ApiError ? `${plainTimes(error.message)} ${error.fix}` : NO_ANSWER;
}

const codeOf = (error: unknown) => (error instanceof ApiError ? error.code : undefined);

export type ReviewController = ReturnType<typeof createReviewController>;

export function createReviewController(deps: () => ReviewDeps) {
  let state: ReviewState = FIRST_STATE;
  const listeners = new Set<() => void>();
  let life: Life = { cancelled: true, giveBack: null };
  let busy = false;
  /** The request in flight, if any: leaving the page waits for it before giving the card back. */
  let inflight: Promise<void> | null = null;
  let held: ReviewCardId | null = null;
  let last: LastDecision | null = null;
  let noticeCount = 0;
  let renewalFor: string | null = null;
  let stopRenewal: (() => void) | null = null;

  /** The renewal runs while a card with a live hold is shown, and for no other card. */
  function syncRenewal(): void {
    const { screen } = state;
    const wanted = screen.kind === "card" && screen.lost === null ? cardKey(screen) : null;
    if (wanted === renewalFor) {
      return;
    }
    stopRenewal?.();
    stopRenewal = null;
    renewalFor = wanted;
    if (wanted !== null && !life.cancelled) {
      stopRenewal = deps().schedule.every(RENEW_EVERY_MS, () => {
        void renewHeld();
      });
    }
  }

  function set(patch: Partial<ReviewState>): void {
    if (life.cancelled) {
      return;
    }
    // The note belongs to the card on screen: whatever shows a different card (or none) starts
    // with an empty one, by whichever path, so it can never go out with another record's decision.
    const shown = patch.screen ?? state.screen;
    const changed = cardKey(shown) !== cardKey(state.screen);
    state = { ...state, ...patch, ...(changed ? { note: "" } : {}) };
    syncRenewal();
    for (const listener of listeners) {
      listener();
    }
  }

  function notify(tone: Notice["tone"], text: string): void {
    noticeCount += 1;
    set({ notice: { id: noticeCount, tone, text } });
  }

  function remember(next: LastDecision | null): void {
    last = next;
    set({ canUndo: next !== null });
  }

  /** One request at a time, from whichever key, button or timer asked first. */
  async function run(task: (mine: Life) => Promise<void>): Promise<void> {
    if (busy || life.cancelled) {
      return;
    }
    const mine = life;
    busy = true;
    set({ busy: true });
    const working = task(mine);
    const settled = working.then(
      () => undefined,
      () => undefined,
    );
    inflight = settled;
    try {
      await working;
    } finally {
      if (inflight === settled) {
        inflight = null;
      }
      if (life === mine) {
        busy = false;
        set({ busy: false, answering: null });
      }
    }
  }

  /** Gives the card back without waiting: the page is closing or being left. */
  function closeCard(): void {
    const card = held;
    held = null;
    if (card !== null) {
      deps().closing(card);
    }
  }

  async function releaseHeld(): Promise<void> {
    const card = held;
    held = null;
    if (card === null) {
      return;
    }
    try {
      await deps().calls.release(card);
    } catch {
      // A hold that is not given back ends by itself ten minutes after its last renewal.
    }
  }

  /** The hold is gone: the card stays on the screen to be read and says so, with a way on. */
  function markLost(card: ReviewCard, words: string): void {
    held = null;
    set({ screen: { kind: "card", card, lost: words } });
  }

  const onward = "Open the next card to carry on.";

  /**
   * Opens the next card under `filter`, or, when `named` is given, that record again. A named
   * record that cannot be opened (held by someone else, gone) says why and falls back to the next.
   */
  async function openNext(
    mine: Life,
    filter: ReviewFilter,
    tries = 0,
    named?: RecordRef,
  ): Promise<ReviewCard | null> {
    set({ screen: { kind: "opening" } });
    try {
      const { card } = await deps().calls.open(
        named === undefined ? filter : { source: named.source, key: named.key },
      );
      if (mine.cancelled) {
        if (card !== null) {
          deps().closing(idOf(card));
        }
        return null;
      }
      if (card === null) {
        held = null;
        set({ screen: { kind: "empty" } });
        return null;
      }
      held = idOf(card);
      set({ screen: { kind: "card", card, lost: null } });
      return card;
    } catch (error) {
      if (mine.cancelled || needsSignIn(error)) {
        return null;
      }
      const code = codeOf(error);
      if (
        named !== undefined &&
        error instanceof ApiError &&
        ["card_held", "card_gone", "unknown_source"].includes(error.code)
      ) {
        held = null;
        notify("warning", `${plainTimes(error.message)} Opening the next card.`);
        return openNext(mine, filter, tries);
      }
      if (code === "card_held" && tries < 3 && error instanceof ApiError) {
        // Someone else holds it: say who, and take the next card.
        notify("warning", `${plainTimes(error.message)} Opening the next card.`);
        return openNext(mine, filter, tries + 1);
      }
      if (
        (code === "unknown_source" || code === "unknown_question") &&
        error instanceof ApiError &&
        Object.keys(filter).length > 0
      ) {
        // The filter names something the project no longer has: show every card instead.
        set({ filter: {} });
        notify("warning", `${plainTimes(error.message)} Showing every card instead.`);
        return openNext(mine, {}, tries + 1);
      }
      set({ screen: { kind: "failed" } });
      notify("warning", describe(error));
      return null;
    }
  }

  async function renewHeld(): Promise<void> {
    const shown = state.screen;
    // A request in flight about this card renews it too (a decision renews first).
    if (shown.kind !== "card" || shown.lost !== null || busy || life.cancelled) {
      return;
    }
    const mine = life;
    const id = idOf(shown.card);
    try {
      const { lockedUntil } = await deps().calls.renew(id);
      const now = state.screen;
      if (mine.cancelled || now.kind !== "card" || !sameCard(now.card, id) || now.lost !== null) {
        return;
      }
      set({ screen: { kind: "card", card: { ...now.card, lockedUntil }, lost: null } });
    } catch (error) {
      const now = state.screen;
      if (mine.cancelled || now.kind !== "card" || !sameCard(now.card, id) || needsSignIn(error)) {
        return;
      }
      const code = codeOf(error);
      if (
        error instanceof ApiError &&
        (code === "lock_lost" || code === "card_held" || code === "card_gone")
      ) {
        markLost(now.card, `${plainTimes(error.message)} ${onward}`);
        return;
      }
      notify(
        "warning",
        error instanceof ApiError
          ? describe(error)
          : "The worker did not answer, so your hold on this card was not renewed. The next try is in a minute.",
      );
    }
  }

  /**
   * A decision got no answer, so nobody knows whether it was taken. Ask for the card again by its
   * key and show what stands: if the question now shows the value that was sent, the decision was
   * taken, and `u` covers it.
   */
  async function checkDecision(
    mine: Life,
    card: ReviewCard,
    question: string,
    value: boolean | string,
  ): Promise<void> {
    const unknown = `${NO_ANSWER} The decision may not have been taken, and the card could not be checked; look at it before deciding again.`;
    let again: ReviewCard | null;
    try {
      ({ card: again } = await deps().calls.open({ source: card.source, key: card.key }));
    } catch (error) {
      if (mine.cancelled || needsSignIn(error)) {
        return;
      }
      if (error instanceof ApiError) {
        await afterDecisionError(mine, card, error, { question, value });
        return;
      }
      notify("warning", unknown);
      return;
    }
    if (mine.cancelled) {
      if (again !== null) {
        deps().closing(idOf(again));
      }
      return;
    }
    if (again === null) {
      notify("warning", unknown);
      return;
    }
    held = idOf(again);
    const standing = again.decided.find((one) => one.name === question);
    const wasDecided = card.decided.some((one) => one.name === question);
    const taken = standing !== undefined && !wasDecided && standing.value === value;
    if (taken) {
      remember({ card: idOf(card), question, said: valueWords(value) });
      deps().counted();
      notify(
        "information",
        `The decision was taken after all: ${question} is ${valueWords(value)}. Press u to take it back.`,
      );
    } else if (standing !== undefined && !wasDecided) {
      notify(
        "warning",
        `${question} stands decided as ${standing.said}, which is not what this page sent.`,
      );
    } else {
      notify("warning", `${NO_ANSWER} The decision was not taken; the card is as it stood.`);
    }
    // A decision that stands used its note, as after any decision: it must not go out again with
    // the next question's (the same card keeps its note otherwise, for a retry).
    set({ screen: { kind: "card", card: again, lost: null }, ...(taken ? { note: "" } : {}) });
  }

  async function afterDecisionError(
    mine: Life,
    card: ReviewCard,
    error: unknown,
    sent?: { readonly question: string; readonly value: boolean | string },
  ): Promise<void> {
    if (mine.cancelled || needsSignIn(error)) {
      return;
    }
    if (!(error instanceof ApiError)) {
      if (sent === undefined) {
        return;
      }
      await checkDecision(mine, card, sent.question, sent.value);
      return;
    }
    const words = plainTimes(error.message);
    switch (error.code) {
      case "lock_lost":
      case "card_held":
        markLost(card, `${words} ${onward}`);
        return;
      case "card_stale":
      case "card_gone":
        // Nothing was decided and the card left the queue: say why, and take the next one.
        held = null;
        notify("warning", `${words} Opening the next card.`);
        await openNext(mine, state.filter);
        return;
      case "decision_refused":
      case "unknown_source":
      case "unknown_question":
        // The card no longer matches the record: open this record again, by its key, and show it
        // as it stands now (the hold is the reviewer's still, so nothing is given back first).
        notify("warning", `${words} Opening this card again as it stands now.`);
        await openNext(mine, state.filter, 0, card);
        return;
      case "invalid_request":
      case "invalid_json":
        notify(
          "warning",
          `${words} Reload the page; if it keeps failing, the studio and the worker are different versions.`,
        );
        return;
      default:
        notify("warning", describe(error));
    }
  }

  /**
   * Decides one question of a card. The caller names the card it means (the one it drew the answer
   * on); a decision for any other card than the one held is refused here, so a key or a click that
   * was drawn on a card that has since been replaced decides nothing.
   */
  function decide(on: ReviewCardId, question: string, value: boolean | string): void {
    void run(async (mine) => {
      const shown = state.screen;
      if (shown.kind !== "card" || shown.lost !== null || !sameCard(shown.card, on)) {
        return;
      }
      const { card } = shown;
      const asked = card.open.find((one) => one.name === question);
      if (asked === undefined) {
        return;
      }
      const note = state.note.trim();
      set({ answering: { question, value } });
      let result: ReviewDecided;
      try {
        result = await deps().calls.decide(idOf(card), {
          question,
          value,
          ...(note === "" ? {} : { note }),
        });
      } catch (error) {
        await afterDecisionError(mine, card, error, { question, value });
        return;
      }
      if (mine.cancelled) {
        // The page was left while the decision was out: a finished record has no hold to give back.
        if (card.open.every((one) => !result.open.includes(one.name))) {
          mine.giveBack = null;
        }
        return;
      }
      remember({ card: idOf(card), question, said: valueWords(value) });
      deps().counted();
      const reviewer = deps().reviewer();
      let words = `${question}: ${valueWords(value)}. Written to the record and logged for ${reviewer ?? "you"}.`;
      const left = card.open.filter((one) => result.open.includes(one.name));
      const finished = left.length === 0;
      if (finished) {
        words += result.status === "done" ? " The record is done and its actions run again." : "";
      } else {
        words += ` ${String(left.length)} ${left.length === 1 ? "question is" : "questions are"} left on this card.`;
      }
      const failed = result.failedActions.length > 0;
      if (failed) {
        words += ` The decision stands, but these actions failed: ${result.failedActions.join(", ")}.`;
      }
      notify(failed ? "warning" : "information", words);
      if (finished) {
        held = null;
        set({ note: "" });
        await openNext(mine, state.filter);
        return;
      }
      const decided = {
        name: asked.name,
        type: asked.type,
        instructions: asked.instructions,
        value,
        said: valueWords(value),
      };
      set({
        note: "",
        screen: {
          kind: "card",
          card: { ...card, open: left, decided: [...card.decided, decided] },
          lost: null,
        },
      });
    });
  }

  function skip(): void {
    void run(async (mine) => {
      const shown = state.screen;
      if (shown.kind !== "card" || shown.lost !== null) {
        return;
      }
      const { card } = shown;
      try {
        await deps().calls.skip(idOf(card));
      } catch (error) {
        if (!mine.cancelled && !needsSignIn(error)) {
          notify("warning", describe(error));
        }
        return;
      }
      if (mine.cancelled) {
        // A skipped card is already given back.
        mine.giveBack = null;
        return;
      }
      held = null;
      deps().counted();
      set({ note: "" });
      notify(
        "information",
        "Skipped. The card goes behind the rest for you and stays visible to other reviewers.",
      );
      const next = await openNext(mine, state.filter);
      if (next !== null && sameRecord(next, card)) {
        notify("information", "No other card is waiting, so the card you skipped is back.");
      }
    });
  }

  function undo(): void {
    void run(async (mine) => {
      const before = last;
      if (before === null) {
        notify("information", "Nothing to undo: you have not decided anything on this page yet.");
        return;
      }
      let result: ReviewUndone;
      try {
        result = await deps().calls.undo(before.card, before.question);
      } catch (error) {
        if (mine.cancelled || needsSignIn(error)) {
          return;
        }
        if (error instanceof ApiError && error.code === "card_held") {
          // Nothing was taken back, and the decision still can be once their hold ends.
          notify("warning", `${plainTimes(error.message)} Press u again after that.`);
          return;
        }
        if (error instanceof ApiError && ["nothing_to_undo", "cannot_undo"].includes(error.code)) {
          remember(null);
          notify("warning", plainTimes(error.message));
          return;
        }
        notify("warning", describe(error));
        return;
      }
      if (mine.cancelled) {
        // The undone card was locked for this reviewer: it goes back with the page.
        mine.giveBack = result.card === null ? null : idOf(result.card);
        return;
      }
      remember(null);
      deps().counted();
      const { card } = result;
      // The server takes back only the decision named, so the words are this page's own.
      let words = `Undid your decision on ${before.question} (${before.said}) for ${before.card.source} ${before.card.key}. The record is back in review.`;
      if (result.failedActions.length > 0) {
        words += ` These actions failed afterwards: ${result.failedActions.join(", ")}.`;
      }
      if (card === null) {
        words +=
          " The card is not yours to hold now: another reviewer opened it, or the thresholds decide it.";
        notify(result.failedActions.length > 0 ? "warning" : "information", words);
        if (state.screen.kind === "empty") {
          await openNext(mine, state.filter);
        }
        return;
      }
      notify(result.failedActions.length > 0 ? "warning" : "information", words);
      if (held !== null && !sameRecord(held, card)) {
        // The card on screen is given back; the undone one is the reviewer's again.
        await releaseHeld();
      }
      held = idOf(card);
      set({ note: "", screen: { kind: "card", card, lost: null } });
    });
  }

  function leave(): void {
    void run(async (mine) => {
      await releaseHeld();
      if (!mine.cancelled) {
        deps().goHome();
      }
    });
  }

  /** From the lost-hold banner and the failed screen: give the card back and open the next. */
  function moveOn(): void {
    void run(async (mine) => {
      await releaseHeld();
      set({ note: "" });
      await openNext(mine, state.filter);
    });
  }

  function filterTo(filter: ReviewFilter): void {
    if (busy || life.cancelled) {
      return;
    }
    set({ filter, note: "" });
    void run(async (mine) => {
      await releaseHeld();
      await openNext(mine, filter);
    });
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getState: (): ReviewState => state,
    /** Opens the first card. Safe to call again after `stop` (a development remount). */
    start(): void {
      life = { cancelled: false, giveBack: null };
      state = FIRST_STATE;
      busy = false;
      held = null;
      last = null;
      renewalFor = null;
      const mine = life;
      // A turn later, so a development remount (start, stop, start in one go) asks only once.
      void Promise.resolve().then(() =>
        mine.cancelled
          ? undefined
          : run(async () => {
              await openNext(mine, {});
            }),
      );
    },
    /**
     * The page is left: the timers stop and the card is given back. A request still in flight is
     * waited for first, so the release cannot reach the server ahead of a decision and have it
     * refused with nobody told; what the request leaves held is what is given back.
     */
    stop(): void {
      const leaving = life;
      leaving.cancelled = true;
      busy = false;
      stopRenewal?.();
      stopRenewal = null;
      renewalFor = null;
      leaving.giveBack = held;
      held = null;
      const giveBack = () => {
        const card = leaving.giveBack;
        leaving.giveBack = null;
        if (card !== null) {
          deps().closing(card);
        }
      };
      if (inflight === null) {
        giveBack();
      } else {
        void inflight.then(giveBack);
      }
    },
    /** The reviewer is back on a page restored from the browser's cache, whose card was given back. */
    restored: moveOn,
    /** The page is closing: give the card back without waiting for the answer. */
    closing: closeCard,
    setNote(note: string): void {
      set({ note });
    },
    decide,
    skip,
    undo,
    leave,
    moveOn,
    filterTo,
  };
}
