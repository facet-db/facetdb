import {
  type CardRef,
  type Clock,
  chosenWords,
  type DecidedQuestion,
  type DecideResult,
  type HumanValue,
  type KeyText,
  type OpenedCard,
  type OpenQuestion,
  type QuestionSet,
  REVIEW_LOCK_MS,
  REVIEW_RENEW_EVERY_MS,
  type ReviewActionFailure,
  type ReviewFilter,
  type ReviewService,
} from "@facetdb/core";
import { keyWords } from "../engines.ts";
import type { KeyEvent, KeySession } from "../terminal.ts";
import {
  answerKeys,
  oneLine,
  pickNames,
  renderCard,
  type Style,
  whenUtc,
  wrap,
} from "./review-card.ts";

/**
 * The terminal review's loop: one card at a time from the review service, one key at a time from
 * the terminal, until the queue is empty, the limit is reached or the reviewer quits. Everything
 * that decides, skips, undoes or locks is the service's; this file reads keys and says what
 * happened in words. No key is read while a note is being typed, a key typed while the last one was
 * being handled is dropped, and the lock is renewed every minute of the injected clock while a card
 * stays open.
 */

/** A source as the review shows it: the config's name for the store's id, and how its keys read. */
export type SourceView = {
  readonly name: string;
  readonly questionSet: QuestionSet;
  readonly keyText: KeyText | undefined;
};

export type SessionDeps = {
  readonly service: ReviewService;
  readonly keys: KeySession;
  readonly clock: Clock;
  /** Aborts when the process is asked to stop: the session ends and lets go of its card. */
  readonly stop: AbortSignal;
  readonly reviewer: string;
  /** The queue's filter; `limit` is not in it, the session counts its own cards. */
  readonly filter: ReviewFilter;
  /** The most cards this session opens. */
  readonly limit: number | undefined;
  /** Every source of the review, by the store's id for it. */
  readonly sources: ReadonlyMap<string, SourceView>;
  readonly out: (text: string) => void;
  readonly width: number;
  readonly style: Style;
};

export type SessionEnd = "empty" | "limit" | "quit" | "input";

export type SessionResult = {
  readonly ended: SessionEnd;
  /** Cards opened. */
  readonly cards: number;
  /** Questions decided. */
  readonly decisions: number;
  readonly skipped: number;
  readonly undone: number;
};

/** The card in hand: what it still asks, and when its lock was last renewed. */
type Shown = {
  card: OpenedCard;
  open: readonly OpenQuestion[];
  decided: readonly DecidedQuestion[];
  lockedUntilMs: number;
  lastRenewMs: number;
  note: string | undefined;
  /**
   * The first digit of a number over nine, waiting for its second digit or enter. It belongs to
   * this card alone: a new card in hand starts with none, so a digit typed on one card can never
   * pick an option on the next.
   */
  pendingDigit: number | undefined;
};

const STOPPED: KeyEvent = { kind: "end" };

function refOf(card: OpenedCard): CardRef {
  return { source: card.source, key: card.key, stateHash: card.stateHash };
}

/** One card at one state: the same record at another state is another card. */
function idOf(card: CardRef): string {
  return JSON.stringify([card.source, card.key, card.stateHash]);
}

function describeFailure(failure: ReviewActionFailure): string {
  const why = failure.error instanceof Error ? failure.error.message : String(failure.error);
  return `The action "${oneLine(failure.action)}" failed: ${oneLine(why)}. The decision stands.`;
}

export async function reviewSession(deps: SessionDeps): Promise<SessionResult> {
  const { service, keys, clock, reviewer, out } = deps;
  const skippedHere = new Set<string>();
  const stopped = new Promise<KeyEvent>((resolve) => {
    if (deps.stop.aborted) {
      resolve(STOPPED);
    } else {
      deps.stop.addEventListener("abort", () => resolve(STOPPED), { once: true });
    }
  });

  // In an object, not two locals: the handlers below assign them and the loop reads them.
  const state: { current: Shown | undefined; ended: SessionEnd | undefined } = {
    current: undefined,
    ended: undefined,
  };
  let cards = 0;
  let decisions = 0;
  let skipped = 0;
  let undone = 0;
  // The decision of this session that `u` can still take back, named to the service by its card and
  // question: a decision made in another window under the same name is not this one.
  let lastDecision: { readonly card: CardRef; readonly question: string } | undefined;
  // A key typed while the last one was handled must not decide the next question.
  let settle = true;

  /** A line or two of news between cards, wrapped to the terminal's width. */
  const say = (text: string): void => {
    out(`${wrap(text.trimEnd(), deps.width).join("\n")}\n`);
  };

  const viewOf = (card: CardRef): SourceView => {
    const view = deps.sources.get(card.source);
    if (view === undefined) {
      throw new Error(`"${card.source}" is not a source this review was given`);
    }
    return view;
  };

  function show(shown: Shown): void {
    const view = viewOf(shown.card);
    out(
      renderCard({
        sourceName: view.name,
        keyText: keyWords(view.keyText, shown.card.key),
        card: shown.card,
        open: shown.open,
        decided: shown.decided.map((entry) => ({
          question: entry.question,
          value: entry.value,
        })),
        questionSet: view.questionSet,
        nowMs: clock.now(),
        lockedUntilMs: shown.lockedUntilMs,
        note: shown.note,
        width: deps.width,
        style: deps.style,
      }),
    );
  }

  function hold(card: OpenedCard): Shown {
    return {
      card,
      open: card.open,
      decided: card.decided,
      lockedUntilMs: card.lockedUntil.getTime(),
      lastRenewMs: clock.now(),
      note: undefined,
      pendingDigit: undefined,
    };
  }

  /**
   * The review is over because the queue is empty or the limit is reached. If a decision of this
   * session can still be taken back, the keys are offered once more first: `u` brings that card
   * back, `q` or the end of the input finishes.
   */
  async function finish(end: SessionEnd): Promise<void> {
    if (lastDecision === undefined) {
      state.ended = end;
      return;
    }
    say(
      "That is the end of this review. Press u to take back your last decision, or q to finish.\n",
    );
    keys.flush();
    for (;;) {
      const event = await Promise.race([keys.next(REVIEW_RENEW_EVERY_MS), stopped]);
      if (event.kind === "end") {
        state.ended = end;
        return;
      }
      if (event.kind === "idle") {
        continue;
      }
      const typed = event.key.toLowerCase();
      if (typed === "u") {
        const stillUndoable = await undo(undefined);
        // A card that came back is in hand and the review goes on; a decision still there to take
        // back (another reviewer held its card) is offered again; otherwise it is over.
        if (state.current !== undefined) {
          return;
        }
        if (stillUndoable) {
          continue;
        }
        state.ended = end;
        return;
      }
      if (typed === "q" || typed === "ctrl-c" || typed === "ctrl-d") {
        state.ended = end;
        return;
      }
      say("Press u to take back your last decision, or q to finish.\n");
    }
  }

  async function openNext(): Promise<void> {
    if (deps.limit !== undefined && cards >= deps.limit) {
      await finish("limit");
      return;
    }
    const card = await service.open(reviewer, deps.filter);
    settle = true;
    if (card === null) {
      await finish("empty");
      return;
    }
    if (skippedHere.has(idOf(card))) {
      // Only cards this session skipped are left: the queue lists them last, and they come round.
      await service.release(reviewer, card);
      await finish("empty");
      return;
    }
    cards += 1;
    state.current = hold(card);
    show(state.current);
  }

  /**
   * Renews the lock when a minute has passed (or at once, `force`). False when the card is no
   * longer the reviewer's: it is let go of, and the session moves on to the next one.
   */
  async function renewIfDue(shown: Shown, force = false): Promise<boolean> {
    const now = clock.now();
    if (!force && now - shown.lastRenewMs < REVIEW_RENEW_EVERY_MS) {
      return true;
    }
    const result = await service.renew(reviewer, refOf(shown.card));
    if (result.kind === "locked") {
      shown.lockedUntilMs = result.until.getTime();
      shown.lastRenewMs = now;
      return true;
    }
    state.current = undefined;
    say(
      result.kind === "held"
        ? `${oneLine(result.by)} holds this card now, so it is no longer yours. Moving on to the next one.\n`
        : "This card is no longer yours: its lock ended or it left the queue. Moving on to the next one.\n",
    );
    return false;
  }

  function msUntilRenewal(shown: Shown): number {
    return Math.max(0, REVIEW_RENEW_EVERY_MS - (clock.now() - shown.lastRenewMs));
  }

  async function decide(shown: Shown, value: HumanValue): Promise<void> {
    const next = shown.open[0];
    if (next === undefined) {
      state.current = undefined;
      return;
    }
    const name = next.question.name;
    const result: DecideResult = await service.decide(
      reviewer,
      refOf(shown.card),
      name,
      value,
      shown.note,
    );
    settle = true;
    switch (result.kind) {
      case "decided": {
        decisions += 1;
        lastDecision = { card: refOf(shown.card), question: name };
        const words = `${name}: ${chosenWords(value)}. Written to the record and logged for ${reviewer}.`;
        say(`${words}\n`);
        for (const failure of result.failures) {
          say(`${describeFailure(failure)}\n`);
        }
        if (result.open.length === 0) {
          say("Every question on this card is decided: the record is done.\n");
          state.current = undefined;
          return;
        }
        const now = clock.now();
        shown.decided = [...shown.decided, { question: next.question, value }];
        shown.open = shown.open.filter((entry) => result.open.includes(entry.question.name));
        shown.note = undefined;
        shown.lockedUntilMs = now + REVIEW_LOCK_MS;
        shown.lastRenewMs = now;
        say(
          `${result.open.length === 1 ? "One question is" : `${result.open.length} questions are`} still open on this card.\n`,
        );
        show(shown);
        return;
      }
      case "stale":
        say(`Not saved: ${result.reason}. Moving on to the next card.\n`);
        state.current = undefined;
        return;
      case "held":
        say(
          `Not saved: ${oneLine(result.by)} holds this card until ${whenUtc(result.until)}. Moving on to the next card.\n`,
        );
        state.current = undefined;
        return;
      case "lost":
        say("Not saved: your lock on this card ended. Moving on to the next card.\n");
        state.current = undefined;
        return;
      case "refused":
        say(`Not saved: ${result.reason}.\n`);
        return;
    }
  }

  async function skip(shown: Shown): Promise<void> {
    await service.skip(reviewer, refOf(shown.card));
    settle = true;
    skipped += 1;
    skippedHere.add(idOf(shown.card));
    say(
      "Skipped. The card goes behind the rest for you, and other reviewers still see it in its place.\n",
    );
    state.current = undefined;
  }

  /**
   * `shown` is the card in hand, if any: it is let go of when undo brings another one back. True
   * when the decision can still be taken back: another reviewer held its card, so nothing was.
   */
  async function undo(shown: Shown | undefined): Promise<boolean> {
    const named = lastDecision;
    if (named === undefined) {
      say(
        "Nothing to undo: only your last decision of this session can be taken back, and only once.\n",
      );
      return false;
    }
    const result = await service.undo(reviewer, named.card, named.question);
    settle = true;
    if (result.kind === "held") {
      // Nothing was written, and the decision can still be taken back once their hold ends.
      say(
        `Not undone: ${oneLine(result.by)} holds this card until ${whenUtc(result.until)}. Press u again after that.\n`,
      );
      return true;
    }
    // Whatever else it said, the decision can no longer be taken back: only the last one, once.
    lastDecision = undefined;
    switch (result.kind) {
      case "nothing":
        say(
          "Nothing to undo: only your last decision of this session can be taken back, and only once.\n",
        );
        return false;
      case "stale":
        say(`Nothing to undo: ${result.reason}.\n`);
        return false;
      case "undone": {
        undone += 1;
        say("Took back your last decision. It is logged as withdrawn.\n");
        for (const failure of result.failures) {
          say(`${describeFailure(failure)}\n`);
        }
        if (result.card === null) {
          say(
            "The card did not come back to you: the thresholds decide it now, or another reviewer has it.\n",
          );
          return false;
        }
        if (shown !== undefined && idOf(result.card) !== idOf(shown.card)) {
          await service.release(reviewer, shown.card);
        }
        state.current = hold(result.card);
        show(state.current);
        return false;
      }
    }
  }

  async function takeNote(shown: Shown): Promise<void> {
    const typed = await keys.line("Note for the log (empty to clear): ");
    // Typing a note can take longer than the lock lasts: it is renewed when the prompt closes, and
    // if the card was lost meanwhile the reviewer hears it now, not at the decision.
    if (!(await renewIfDue(shown, true))) {
      say("The note was not kept.\n");
      return;
    }
    if (typed === undefined) {
      say("No note taken.\n");
      return;
    }
    const note = typed.trim();
    shown.note = note === "" ? undefined : note;
    say(
      note === ""
        ? "Note cleared.\n"
        : "Note kept: it goes with your next decision on this card.\n",
    );
    show(shown);
  }

  /** The number `n` (counted from 1) picks, or says why not. */
  async function pick(shown: Shown, number: number): Promise<void> {
    const next = shown.open[0];
    const names = next === undefined ? [] : pickNames(next.question);
    const chosen = names[number - 1];
    if (chosen === undefined) {
      say(`There is no option ${number}: pick 1 to ${names.length}.\n`);
      return;
    }
    await decide(shown, chosen);
  }

  async function onDigit(shown: Shown, digit: number): Promise<void> {
    const next = shown.open[0];
    if (next === undefined || next.question.type === "noul") {
      say("This is a yes-or-no question: press y for yes or n for no.\n");
      return;
    }
    const count = pickNames(next.question).length;
    if (shown.pendingDigit !== undefined) {
      const number = shown.pendingDigit * 10 + digit;
      shown.pendingDigit = undefined;
      await pick(shown, number);
      return;
    }
    // Over nine options a first digit may start a second: "1" is option 1 or 10 to 19.
    if (digit >= 1 && digit * 10 <= count) {
      shown.pendingDigit = digit;
      say(`${digit}: press another digit to pick ${digit}0 or more, or enter to pick ${digit}.\n`);
      return;
    }
    await pick(shown, digit);
  }

  async function onKey(shown: Shown, key: string): Promise<void> {
    const typed = key.toLowerCase();
    const waiting = shown.pendingDigit;
    if (waiting !== undefined) {
      if (typed === "enter") {
        shown.pendingDigit = undefined;
        await pick(shown, waiting);
        return;
      }
      if (!/^[0-9]$/.test(typed)) {
        shown.pendingDigit = undefined;
      }
    }
    switch (typed) {
      case "q":
      case "ctrl-c":
      case "ctrl-d":
        state.ended = "quit";
        return;
      case "s":
        await skip(shown);
        return;
      case "u":
        await undo(shown);
        return;
      case ":":
        await takeNote(shown);
        return;
      case "y":
      case "n": {
        const next = shown.open[0];
        if (next === undefined || next.question.type !== "noul") {
          say(
            next === undefined
              ? "Nothing is open on this card.\n"
              : `${next.question.name} is not a yes-or-no question: press ${answerKeys(next.question)}.\n`,
          );
          return;
        }
        await decide(shown, typed === "y");
        return;
      }
      case "enter":
        return;
      default:
        if (/^[0-9]$/.test(typed)) {
          await onDigit(shown, Number(typed));
          return;
        }
        say(
          "That key does nothing here. Keys: y n or a number to answer, : note, s skip, u undo, q quit.\n",
        );
    }
  }

  try {
    while (state.ended === undefined) {
      if (deps.stop.aborted) {
        state.ended = "input";
        break;
      }
      if (state.current === undefined) {
        await openNext();
        continue;
      }
      const shown = state.current;
      if (!(await renewIfDue(shown))) {
        continue;
      }
      if (settle) {
        keys.flush();
        settle = false;
      }
      const event = await Promise.race([keys.next(msUntilRenewal(shown)), stopped]);
      if (event.kind === "end") {
        state.ended = "input";
      } else if (event.kind === "key") {
        await onKey(shown, event.key);
      }
    }
  } finally {
    if (state.current !== undefined) {
      // The lock would end by itself in ten minutes; a failure here must not hide the real error.
      await service.release(reviewer, refOf(state.current.card)).catch(() => undefined);
    }
  }
  return { ended: state.ended, cards, decisions, skipped, undone };
}
