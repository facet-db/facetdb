import { Button, Dither, DitherStrip, StatusWord, Tag } from "@facetdb/ui";
import { useId } from "react";
import type { ReviewDecidedQuestion, ReviewOpenQuestion } from "../../api/index.ts";
import { hintFor, type KeyedAnswer } from "./keys.ts";
import { decidesWords, kindWords, modelSays, percent, pickWords } from "./words.ts";

/**
 * One question of the card (the review card): the question and its kind, the model's answer in
 * words beside its dither, for a choice or a score the probability of every option in one row with
 * the model's pick named, and the answers as buttons carrying the word and the key. Yes and No
 * weigh the same; nothing but the words names the model's pick.
 */

function Probabilities({ question }: { readonly question: ReviewOpenQuestion }) {
  return (
    <ul
      aria-label="The model's probability for each option"
      className="m-0 flex list-none flex-wrap items-center gap-x-5.5 gap-y-2 p-0"
    >
      {question.options.map((option) => {
        const pick = option.name === question.top;
        return (
          <li key={option.name} className="inline-flex min-w-0 items-center gap-2.5">
            {/* The strip says the option, its percent and the pick once; the text beside it is the sighted copy */}
            <DitherStrip
              value={option.probability}
              width={40}
              rows={6}
              label={`${option.name}, ${percent(option.probability)}${pick ? ", the model's pick" : ""}`}
            />
            <span aria-hidden="true" className="font-mono text-xs text-text-2">
              {percent(option.probability)}
            </span>
            <span aria-hidden="true" className="min-w-0 break-words">
              {option.name}
              {pick ? <span className="text-text-2">, the model's pick</span> : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function OpenQuestion({
  question,
  reached,
  locked,
  pressed,
  onAnswer,
}: {
  readonly question: ReviewOpenQuestion;
  /** The answers the keys reach on this card: a button shows the hint of its own key. */
  readonly reached: readonly KeyedAnswer[];
  /** The hold is lost: the answers wait for a new card. */
  readonly locked: boolean;
  /**
   * The answer of this question being sent now, by a key or a click: its button shows as pressed
   * (the mockups' answer to a key) until the worker has answered.
   */
  readonly pressed?: boolean | string;
  readonly onAnswer: (question: string, value: boolean | string) => void;
}) {
  const heading = useId();
  const answers: readonly { readonly label: string; readonly value: boolean | string }[] =
    question.type === "noul"
      ? [
          { label: "Yes", value: true },
          { label: "No", value: false },
        ]
      : question.options.map((option) => ({ label: option.name, value: option.name }));
  const described = new Map(question.options.map((option) => [option.name, option.description]));
  return (
    <section
      aria-labelledby={heading}
      className="mt-5.5 grid gap-3.5 border-t border-hairline pt-5.5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <h2 id={heading} className="min-w-0 text-base font-bold break-words">
          {question.instructions}
        </h2>
        <span className="inline-flex items-center gap-2.5">
          <span className="font-mono text-xs text-text-3">{question.name}</span>
          {/* The stakes travel in the words; the tag keeps its neutral square (no role names them) */}
          <Tag>{kindWords(question)}</Tag>
        </span>
      </div>
      <div className="flex items-center gap-2.5">
        <span aria-hidden="true" className="inline-flex">
          <Dither value={question.figure} size={40} label={modelSays(question)} />
        </span>
        {/* The thresholds follow the answer in a quieter voice, as the mockup's review card has them */}
        <p className="m-0 min-w-0">
          {modelSays(question)}
          <span className="text-text-2"> {decidesWords(question)}</span>
        </p>
      </div>
      {question.type === "noul" ? null : <Probabilities question={question} />}
      <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
        <legend className="sr-only">
          {pickWords(question.type)}: {question.instructions}
        </legend>
        {answers.map((answer) => {
          const hint = hintFor(reached, question.name, answer.value);
          const description = described.get(String(answer.value));
          return (
            <Button
              key={answer.label}
              disabled={locked}
              {...(hint === undefined ? {} : { keyHint: hint })}
              {...(description === undefined ? {} : { title: description })}
              {...(pressed === answer.value ? { "aria-pressed": true } : {})}
              // Marks the answers for the page's focus rule (review-page.tsx): a reviewer who
              // answers from a focused button finds the focus on the next question's first answer.
              data-answer=""
              onClick={() => {
                onAnswer(question.name, answer.value);
              }}
            >
              {answer.label}
            </Button>
          );
        })}
      </fieldset>
    </section>
  );
}

/** A question already decided, greyed out with its value: the thresholds' or a person's. */
export function DecidedQuestion({ question }: { readonly question: ReviewDecidedQuestion }) {
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      className="mt-5.5 grid gap-3.5 border-t border-hairline pt-5.5 text-text-2"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5">
        <h2 id={heading} className="min-w-0 text-base font-bold break-words">
          {question.instructions}
        </h2>
        <span className="inline-flex items-center gap-2.5">
          <span className="font-mono text-xs text-text-3">{question.name}</span>
          <StatusWord status="done" size="small" label="Decided" />
        </span>
      </div>
      <p className="m-0">
        <span className="sr-only">Decided as </span>
        <span className="font-semibold">{question.said}</span>
      </p>
    </section>
  );
}
