import { Button, DitherStrip, StatusWord } from "@facetdb/ui";
import { useEffect, useId, useState } from "react";
import type { ReviewCard, ReviewCardId } from "../../api/index.ts";
import { useSchedule } from "../../deps.tsx";
import { keyedAnswers } from "./keys.ts";
import { DecidedQuestion, OpenQuestion } from "./question.tsx";
import { RecordState } from "./record-state.tsx";
import { clockWords, LOCK_MS, minutesLeftWords, sinceWords } from "./words.ts";

/**
 * The review card: the one framed rectangle on the quiet stage. The record's state laid out for
 * reading, the questions still open each with the model's answer and its buttons, the decided ones
 * greyed, a note, skip, undo and leave, and the lock's time left as a strip. Everything it shows of
 * the record is text.
 */

/** The hold's time left: a strip that empties as the ten minutes pass, and the clock beside it. */
function LockStrip({
  lockedUntil,
  lost,
}: {
  readonly lockedUntil: string;
  readonly lost: boolean;
}) {
  const schedule = useSchedule();
  const [now, setNow] = useState(() => schedule.now());
  useEffect(() => {
    // A hold that is gone has no time left to count.
    if (lost) {
      return undefined;
    }
    return schedule.every(1000, () => {
      setNow(schedule.now());
    });
  }, [schedule, lost]);
  if (lost) {
    return <span className="text-[13px] text-text-2">No longer yours</span>;
  }
  const left = Math.max(0, new Date(lockedUntil).getTime() - now);
  return (
    <span className="inline-flex items-center gap-2 text-[13px] text-text-2">
      {/* A screen reader gets one sentence, in minutes: a clock face changing each second is noise */}
      <span className="sr-only">Locked for you for {minutesLeftWords(left)}.</span>
      <span aria-hidden="true" className="inline-flex">
        <DitherStrip
          value={Math.min(1, left / LOCK_MS)}
          width={40}
          rows={4}
          label={`${minutesLeftWords(left)} left`}
        />
      </span>
      <span aria-hidden="true">Locked for you, {clockWords(left)} left</span>
    </span>
  );
}

const fieldClasses =
  "h-9 w-full border border-hairline bg-transparent px-3 text-text outline-offset-2 focus-visible:outline-2 focus-visible:outline-facet-text";

export type ReviewCardProps = {
  readonly card: ReviewCard;
  /** The words saying the hold ended, or null while it is held. */
  readonly lost: string | null;
  readonly note: string;
  readonly canUndo: boolean;
  /** The answer being sent now, if any: its button shows as pressed until the worker has answered. */
  readonly answering: { readonly question: string; readonly value: boolean | string } | null;
  readonly onNote: (note: string) => void;
  /** The card the answer was drawn on goes with it: a card that was replaced since is not decided. */
  readonly onAnswer: (card: ReviewCardId, question: string, value: boolean | string) => void;
  readonly onSkip: () => void;
  readonly onUndo: () => void;
  readonly onLeave: () => void;
  readonly onMoveOn: () => void;
};

/** The sentence under the note: what is left to do on this card. */
function leftToDo(open: number): string {
  if (open === 0) {
    return "Nothing is left to decide on this card.";
  }
  return open === 1
    ? "Decide the open question and this record is done."
    : `Decide the ${String(open)} open questions and this record is done.`;
}

export function ReviewCardView(props: ReviewCardProps) {
  const { card, lost, note } = props;
  const schedule = useSchedule();
  const header = useId();
  const noteId = useId();
  const reached = keyedAnswers(card.open);
  const locked = lost !== null;
  return (
    <article
      aria-labelledby={header}
      // The card itself takes the focus when it opens for a reviewer who answers with the keys,
      // not one of its answers: brackets around "Yes" on a card nobody has read yet look like an
      // answer already given, and Enter would give it. The keys answer from here; Tab goes on to
      // the record and the buttons (the page's focus rule: review-page.tsx).
      tabIndex={-1}
      {...(locked ? {} : { "data-autofocus": "" })}
      className="min-w-0 border border-hairline p-7 outline-hidden max-sm:p-5"
    >
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <span id={header} className="min-w-0 text-[13px] break-words text-text-2">
          <span className="sr-only">Review card: </span>
          {card.source} <span className="font-mono">{card.key}</span>, waiting since{" "}
          {sinceWords(card.since, schedule.now())}
        </span>
        <LockStrip lockedUntil={card.lockedUntil} lost={locked} />
      </div>

      {lost === null ? null : (
        <div role="alert" className="mt-4.5 grid gap-3 border-l-2 border-review pl-3">
          <p className="m-0">
            <StatusWord status="warning" label="This card is no longer yours" />
          </p>
          <p className="m-0">{lost}</p>
          <div>
            <Button variant="primary" onClick={props.onMoveOn} data-autofocus="">
              Open the next card
            </Button>
          </div>
        </div>
      )}

      <RecordState state={card.state} />

      {card.open.map((question) => (
        <OpenQuestion
          key={question.name}
          question={question}
          reached={reached}
          locked={locked}
          {...(props.answering?.question === question.name
            ? { pressed: props.answering.value }
            : {})}
          onAnswer={(question, value) => {
            props.onAnswer(
              { source: card.source, key: card.key, stateHash: card.stateHash },
              question,
              value,
            );
          }}
        />
      ))}
      {card.decided.map((question) => (
        <DecidedQuestion key={question.name} question={question} />
      ))}

      <div className="mt-5.5 grid gap-4 border-t border-hairline pt-5.5">
        <label className="grid min-w-0 gap-1.5" htmlFor={noteId}>
          <span className="text-[13px] text-text-2">Note, optional</span>
          <input
            id={noteId}
            className={fieldClasses}
            value={note}
            maxLength={2000}
            disabled={locked}
            placeholder="A few words for whoever reads the log"
            onChange={(event) => {
              props.onNote(event.target.value);
            }}
            onKeyDown={(event) => {
              // Escape leaves the field, so the answer keys work again.
              if (event.key === "Escape") {
                event.currentTarget.blur();
                document.querySelector<HTMLElement>("[data-autofocus]")?.focus();
              }
            }}
          />
        </label>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <div className="flex flex-wrap gap-2">
            <Button variant="quiet" keyHint="s" disabled={locked} onClick={props.onSkip}>
              Skip
            </Button>
            <Button variant="quiet" keyHint="u" disabled={!props.canUndo} onClick={props.onUndo}>
              Undo
            </Button>
            <Button variant="quiet" keyHint="q" onClick={props.onLeave}>
              Leave
            </Button>
          </div>
          <span className="text-[12.5px] text-text-2">{leftToDo(card.open.length)}</span>
        </div>
      </div>
    </article>
  );
}
