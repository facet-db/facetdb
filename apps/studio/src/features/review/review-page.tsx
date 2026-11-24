import { Button, EmptyState, Kbd, StatusWord } from "@facetdb/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { type RefObject, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { projectQuery, type ReviewCardId, type ReviewOpenTarget } from "../../api/index.ts";
import { useApi, useSchedule } from "../../deps.tsx";
import { ReviewCardView } from "./card.tsx";
import {
  createReviewController,
  type Notice,
  type ReviewController,
  type ReviewDeps,
  type ReviewState,
  type Screen,
} from "./controller.ts";
import { keyedAnswers, pressedKey } from "./keys.ts";
import { REVIEW_QUEUE_KEY } from "./queries.ts";
import { TopBar } from "./top-bar.tsx";

/**
 * The Review page: one card on a quiet stage, the queue count and the filters in a thin bar over
 * it, the keys at the bottom, and nothing else. The session (controller.ts) holds the card and
 * every request; this file wires its calls, draws its state and hears the keys.
 */

/** The session over the page's dependencies: the API through mutations, the scheduler, the router. */
function useReviewController(): ReviewController {
  const api = useApi();
  const schedule = useSchedule();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const reviewer = useQuery(projectQuery(api)).data?.reviewer;
  // Through mutations, so a "sign in" answer to any call reaches the shell's rule (studio.tsx).
  const open = useMutation({ mutationFn: (target: ReviewOpenTarget) => api.reviewOpen(target) });
  const renew = useMutation({ mutationFn: (card: ReviewCardId) => api.reviewRenew(card) });
  const decide = useMutation({
    mutationFn: (ask: {
      readonly card: ReviewCardId;
      readonly decision: Parameters<typeof api.reviewDecide>[1];
    }) => api.reviewDecide(ask.card, ask.decision),
  });
  const skip = useMutation({ mutationFn: (card: ReviewCardId) => api.reviewSkip(card) });
  const release = useMutation({ mutationFn: (card: ReviewCardId) => api.reviewRelease(card) });
  const undo = useMutation({
    mutationFn: (ask: { readonly card: ReviewCardId; readonly question: string }) =>
      api.reviewUndo(ask.card, ask.question),
  });

  const latest: ReviewDeps = {
    calls: {
      open: open.mutateAsync,
      renew: renew.mutateAsync,
      decide: (card, decision) => decide.mutateAsync({ card, decision }),
      skip: skip.mutateAsync,
      release: release.mutateAsync,
      undo: (card, question) => undo.mutateAsync({ card, question }),
    },
    // A page that is closing cannot wait for the answer: the call asks the browser to finish it.
    closing: (card) => {
      void api.reviewRelease(card).catch(() => undefined);
    },
    schedule,
    // The queue's figures ask again: the rail's count and this page's are one prefix.
    counted: () => {
      void queryClient.invalidateQueries({ queryKey: REVIEW_QUEUE_KEY });
    },
    goHome: () => {
      void navigate({ to: "/" });
    },
    reviewer: () => reviewer,
  };
  const depsRef = useRef(latest);
  depsRef.current = latest;
  const [controller] = useState(() => createReviewController(() => depsRef.current));

  useEffect(() => {
    controller.start();
    // Closing the tab gives the card back where the browser lets a request out (keepalive).
    const onPageHide = () => {
      controller.closing();
    };
    // A page restored from the browser's back-forward cache shows a card that was given back: it
    // opens one again instead of showing a hold it no longer has.
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        controller.restored();
      }
    };
    window.addEventListener("pagehide", onPageHide);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
      window.removeEventListener("pageshow", onPageShow);
      controller.stop();
    };
  }, [controller]);
  return controller;
}

/**
 * The keys: `y` and `n`, `1` to `9`, `s`, `u`, `q`. The listener asks `pressedKey` first (no key
 * under a modifier, in a text field, a listbox or a dialog), and the session refuses a key while
 * a request about the card is in flight, so a double press decides one thing.
 */
function useReviewKeys(session: ReviewController): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = pressedKey(event);
      if (key === undefined) {
        return;
      }
      // The session's own state at the press, not what was last drawn: the answer is for the card
      // held now, and its identity goes with the decision.
      const { screen } = session.getState();
      const live = screen.kind === "card" && screen.lost === null ? screen.card : null;
      let act: (() => void) | undefined;
      if (key === "q") {
        act = () => {
          session.leave();
        };
      } else if (key === "u") {
        act = () => {
          session.undo();
        };
      } else if (key === "s" && live !== null) {
        act = () => {
          session.skip();
        };
      } else if (live !== null) {
        const answer = keyedAnswers(live.open).find((one) => one.key === key);
        if (answer !== undefined) {
          act = () => {
            session.decide(
              { source: live.source, key: live.key, stateHash: live.stateHash },
              answer.question,
              answer.value,
            );
          };
        }
      }
      if (act !== undefined) {
        event.preventDefault();
        act();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [session]);
}

/** The keys that click a focused button. */
const ACTIVATES: ReadonlySet<string> = new Set(["Enter", " "]);

/**
 * A key held down must not decide what the reviewer has not read. After each decision the focus
 * moves to the next answer, and a button does not filter the repeats of a held Enter, so a held
 * key would click through the questions and on to the next card. Two rules, in the capture phase
 * on the document and only for what happens on the stage:
 * - a repeated Enter or Space keydown is stopped before it can click;
 * - a click that comes from a key (detail 0, with a key in play) acts only if the keydown that
 *   began the press was seen on that same button while the card on screen was the one it is now.
 *   A key held across the focus move, or across a new card, does nothing until it is released.
 * A click with no key in play (a pointer's, an assistive technology's) is left alone.
 */
function useHeldKeyGuard(stage: RefObject<HTMLElement | null>, screenKey: string): void {
  const now = useRef(screenKey);
  now.current = screenKey;
  useEffect(() => {
    type Press = {
      readonly key: string;
      readonly origin: EventTarget | null;
      readonly screen: string;
    };
    let down: Press | null = null;
    let released: Press | null = null;
    const onStage = (event: Event) =>
      event.target instanceof Node && stage.current?.contains(event.target) === true;
    // Only a button on the stage is guarded: a text field, the record's scroll region and every
    // control outside the stage keep what a key does natively (a held Space repeats in the note).
    const buttonOnStage = (target: EventTarget | null) => {
      const button = target instanceof Element ? target.closest("button") : null;
      return button !== null && stage.current?.contains(button) === true;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // A finished press is forgotten by any key that comes after it.
      released = null;
      if (!ACTIVATES.has(event.key)) {
        return;
      }
      if (event.repeat) {
        if (buttonOnStage(event.target)) {
          event.preventDefault();
        }
        return;
      }
      down = buttonOnStage(event.target)
        ? { key: event.key, origin: event.target, screen: now.current }
        : null;
    };
    // Focus leaving the stage ends whatever press the stage was holding.
    const onFocusIn = (event: FocusEvent) => {
      if (!onStage(event)) {
        down = null;
        released = null;
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (down?.key === event.key) {
        released = down;
        down = null;
      }
    };
    const onPointerDown = () => {
      released = null;
    };
    const onClick = (event: MouseEvent) => {
      if (event.detail !== 0 || !onStage(event)) {
        return;
      }
      const began = down ?? released;
      released = null;
      if (began === null) {
        return;
      }
      if (began.origin !== event.target || began.screen !== now.current) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("focusin", onFocusIn, true);
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("focusin", onFocusIn, true);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("click", onClick, true);
    };
  }, [stage]);
}

/** What changes which control should take the focus: a new card, a new set of open questions, a lost hold. */
function focusKey(screen: Screen): string {
  if (screen.kind !== "card") {
    return screen.kind;
  }
  const { card } = screen;
  const names = card.open.map((question) => question.name).join(",");
  return `card ${card.source} ${card.key} ${card.stateHash} ${names} ${screen.lost === null ? "held" : "lost"}`;
}

/** How long a confirmation stays at the foot of the window before it leaves. */
export const NOTICE_MS = 5000;

/**
 * The page speaks in two places that stay in the page from the start, so a change is announced:
 * a polite status for confirmations and an alert for what needs reading. A decision is said once.
 *
 * A confirmation (an answer written, a skip, an undo) is the mockups' toast: a ruled box at the
 * foot of the window that leaves after a moment, so every key shows what it did and the card sits
 * right under the bar. A warning needs reading, so it stays over the card until the next notice,
 * and takes no room while there is none.
 */
function Notices({ notice }: { readonly notice: Notice | null }) {
  const schedule = useSchedule();
  const confirmation = notice?.tone === "information" ? notice : null;
  const warning = notice?.tone === "warning" ? notice : null;
  const [left, setLeft] = useState<number | null>(null);
  const shownId = confirmation?.id ?? null;
  useEffect(() => {
    if (shownId === null) {
      return undefined;
    }
    return schedule.after(NOTICE_MS, () => {
      setLeft(shownId);
    });
  }, [shownId, schedule]);
  const toast = confirmation !== null && confirmation.id !== left ? confirmation : null;
  return (
    <>
      <p role="alert" className={warning === null ? "m-0" : "m-0 mb-4"}>
        {warning === null ? null : (
          <span key={warning.id} className="inline-flex flex-wrap items-baseline gap-x-2.5">
            <StatusWord status="warning" size="small" />
            <span>{warning.text}</span>
          </span>
        )}
      </p>
      <div className="pointer-events-none fixed bottom-[max(24px,env(safe-area-inset-bottom,0px))] left-1/2 z-[8] w-[min(520px,calc(100%-32px))] -translate-x-1/2">
        <p role="status" className="m-0">
          {toast === null ? null : (
            <span
              key={toast.id}
              className="pointer-events-auto block border border-hairline bg-canvas px-4 py-3 font-medium text-text"
            >
              {toast.text}
            </span>
          )}
        </p>
      </div>
    </>
  );
}

/** The keys, at the bottom of the stage. */
function KeysBar() {
  return (
    <ul
      aria-label="Keys"
      className="m-0 mt-6.5 flex list-none flex-wrap justify-center gap-x-5 gap-y-3.5 p-0 text-[13px] text-text-3"
    >
      <li className="inline-flex items-center gap-1.5">
        <Kbd>y</Kbd> yes
      </li>
      <li className="inline-flex items-center gap-1.5">
        <Kbd>n</Kbd> no
      </li>
      <li className="inline-flex items-center gap-1.5">
        <Kbd>1</Kbd> to <Kbd>9</Kbd> pick
      </li>
      <li className="inline-flex items-center gap-1.5">
        <Kbd>s</Kbd> skip
      </li>
      <li className="inline-flex items-center gap-1.5">
        <Kbd>u</Kbd> undo
      </li>
      <li className="inline-flex items-center gap-1.5">
        <Kbd>q</Kbd> quit
      </li>
    </ul>
  );
}

function Stage({
  controller,
  state,
}: {
  readonly controller: ReviewController;
  readonly state: ReviewState;
}) {
  const { screen, filter } = state;
  // While the next card is on its way, the one just answered stays where it is, untouchable, with
  // the answer that was pressed still marked: the stage does not blink empty between two cards.
  const last = useRef<Extract<Screen, { kind: "card" }> | null>(null);
  if (screen.kind === "card") {
    last.current = screen;
  } else if (screen.kind !== "opening") {
    last.current = null;
  }
  const shown = screen.kind === "card" ? screen : screen.kind === "opening" ? last.current : null;
  if (shown !== null) {
    const waiting = screen.kind !== "card";
    return (
      <div inert={waiting} aria-busy={waiting}>
        <ReviewCardView
          card={shown.card}
          lost={shown.lost}
          note={state.note}
          canUndo={state.canUndo}
          answering={state.answering}
          onNote={controller.setNote}
          onAnswer={controller.decide}
          onSkip={controller.skip}
          onUndo={controller.undo}
          onLeave={controller.leave}
          onMoveOn={controller.moveOn}
        />
      </div>
    );
  }
  switch (screen.kind) {
    case "opening":
    case "card":
      return <p className="m-0 py-10 text-center text-text-2">Opening the next card.</p>;
    case "empty":
      return (
        <EmptyState
          title="Nothing to review"
          action={
            Object.keys(filter).length > 0 ? (
              <Button
                variant="primary"
                data-autofocus=""
                onClick={() => {
                  controller.filterTo({});
                }}
              >
                Show every card
              </Button>
            ) : (
              <Button variant="primary" data-autofocus="" onClick={controller.moveOn}>
                Check again
              </Button>
            )
          }
        >
          {Object.keys(filter).length > 0
            ? "No card waits under this filter. A card appears here when the model is unsure about a record."
            : "Every record is decided. A card appears here when the model is unsure about a record."}
        </EmptyState>
      );
    case "failed":
      return (
        <EmptyState
          title="The next card did not open"
          action={
            <Button variant="primary" data-autofocus="" onClick={controller.moveOn}>
              Try again
            </Button>
          }
        >
          The reason is above. Nothing was decided.
        </EmptyState>
      );
  }
}

export function ReviewPage() {
  const controller = useReviewController();
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  useReviewKeys(controller);

  useEffect(() => {
    document.title = "Review · FacetDB";
  }, []);

  // Where the focus goes when a card opens and after each decision, unless the reviewer is typing
  // in the note:
  // - on the card (or the way-on button of a lost hold or an empty stage) for a reviewer who
  //   answers with the letter keys. Never on an answer then: brackets on "Yes" of a card nobody
  //   has read look like an answer given, and Enter would give it.
  // - on the first answer of the next open question for a reviewer who answers from a focused
  //   button with Enter or Space: they carry on from where the last answer left them.
  // Which one is known from how the last answer was given: a click that came from a key (detail
  // 0) on an answer says the second, a letter key or a pointer's click says the first.
  const stage = useRef<HTMLDivElement>(null);
  const fromAnswer = useRef(false);
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      const answer =
        event.target instanceof Element ? event.target.closest("button[data-answer]") : null;
      if (answer !== null && stage.current?.contains(answer) === true) {
        fromAnswer.current = event.detail === 0;
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (pressedKey(event) !== undefined) {
        fromAnswer.current = false;
      }
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);
  const focusOn = focusKey(state.screen);
  useHeldKeyGuard(stage, focusOn);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key is what asks for the move
  useEffect(() => {
    const active = document.activeElement;
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      return;
    }
    const next = fromAnswer.current
      ? stage.current?.querySelector<HTMLElement>("button[data-answer]:not(:disabled)")
      : null;
    (next ?? stage.current?.querySelector<HTMLElement>("[data-autofocus]"))?.focus();
  }, [focusOn]);

  return (
    <div ref={stage} className="mx-auto w-full max-w-[760px] min-w-0">
      <h1 className="sr-only">Review</h1>
      <TopBar filter={state.filter} onFilter={controller.filterTo} />
      <Notices notice={state.notice} />
      <Stage controller={controller} state={state} />
      <KeysBar />
    </div>
  );
}
