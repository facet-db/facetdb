import type { ReactNode } from "react";
import type { DecisionOutcome, ExplainedEntry } from "../../api/index.ts";
import { At, Outcome, Share } from "./timeline.tsx";

/**
 * The last entry of each question, one question at a time, as the log proves it. Every entry
 * carries the state hash it saw, so the page reads the decisions as core does (packages/core,
 * log/human.ts, standingHuman): a person's decision stands over a later answer on the same state,
 * and a model answer on another state means the record changed and the decision no longer stands.
 * The record's status itself is read from the record (WhyPage.tsx).
 */

type Model = {
  readonly at: string;
  readonly said: string;
  readonly decision: string;
  readonly outcome: DecisionOutcome;
};

type Word = { readonly at: string; readonly decided: string; readonly reviewer: string };

type Person =
  | ({ readonly kind: "decided" } & Word)
  | { readonly kind: "withdrawn"; readonly at: string; readonly reviewer: string }
  /** A decision a later answer on a changed record retired: the model's answer is what holds. */
  | ({ readonly kind: "outdated" } & Word);

export type Standing = {
  readonly question: string;
  /** The model's latest answer to it, if the log has one. */
  readonly model?: Model;
  /** The latest thing a person did about it, or the decision a changed record retired. */
  readonly person?: Person;
  /** Whether the model answered again after the standing decision, on the same state. */
  readonly answeredAfter: boolean;
};

/** What the log holds about one question while it is read oldest first. */
type Reading = {
  /** The decisions still in force, oldest first, each with the state it was made on. */
  words: (Word & { stateHash: string; answeredAfter: boolean })[];
  model?: Model;
  /** Why no decision is in force, when one was: the latest withdrawal or retired decision. */
  gone?: Exclude<Person, { kind: "decided" }>;
};

/**
 * Each question's standing, in the order the questions first appear in the history (oldest first).
 * A withdrawal removes its own reviewer's latest decision at its state and no one else's, so when
 * amara decides yes, bea decides no and bea withdraws, amara's yes stands again. Any model answer at
 * another state retires every decision made before it, as core does: after A, B, A the decision
 * made at A does not return.
 */
export function standings(entries: readonly ExplainedEntry[]): readonly Standing[] {
  const readings = new Map<string, Reading>();
  const reading = (question: string): Reading => {
    const known = readings.get(question);
    if (known !== undefined) {
      return known;
    }
    const fresh: Reading = { words: [] };
    readings.set(question, fresh);
    return fresh;
  };
  for (const entry of entries) {
    if (entry.kind === "answer") {
      for (const read of readings.values()) {
        const retired = read.words.filter((word) => word.stateHash !== entry.stateHash).at(-1);
        read.words = read.words.filter((word) => word.stateHash === entry.stateHash);
        if (retired !== undefined) {
          read.gone = {
            kind: "outdated",
            at: retired.at,
            decided: retired.decided,
            reviewer: retired.reviewer,
          };
        }
        for (const word of read.words) {
          word.answeredAfter = true;
        }
      }
      for (const answer of entry.answers) {
        reading(answer.question).model = {
          at: entry.at,
          said: answer.said,
          decision: answer.decision,
          outcome: answer.outcome,
        };
      }
    } else if (entry.kind === "human") {
      reading(entry.question).words.push({
        at: entry.at,
        decided: entry.decided,
        reviewer: entry.reviewer,
        stateHash: entry.stateHash,
        answeredAfter: false,
      });
    } else {
      const read = reading(entry.question);
      const taken = read.words.findLastIndex(
        (word) => word.reviewer === entry.reviewer && word.stateHash === entry.stateHash,
      );
      if (taken !== -1) {
        read.words.splice(taken, 1);
      }
      read.gone = { kind: "withdrawn", at: entry.at, reviewer: entry.reviewer };
    }
  }
  return [...readings].map(([question, read]): Standing => {
    const word = read.words.at(-1);
    const person: Person | undefined =
      word === undefined
        ? read.gone
        : { kind: "decided", at: word.at, decided: word.decided, reviewer: word.reviewer };
    return {
      question,
      ...(read.model === undefined ? {} : { model: read.model }),
      ...(person === undefined ? {} : { person }),
      answeredAfter: word?.answeredAfter ?? false,
    };
  });
}

/** An argument as a shell reads it: plain when it is plain, else in single quotes. */
export function shellWord(text: string): string {
  return /^[A-Za-z0-9_.@:+=,/-]+$/.test(text) ? text : `'${text.replaceAll("'", "'\\''")}'`;
}

function Line({ children, share }: { readonly children: ReactNode; readonly share?: string }) {
  return (
    <p className="flex items-start gap-2.5">
      {share === undefined ? null : <Share said={share} />}
      <span>{children}</span>
    </p>
  );
}

/** "is_scam: yes, by the model. It said 92% likely yes, today 10:02." */
function ModelLine({
  name,
  model,
  now,
}: {
  readonly name: ReactNode;
  readonly model: Model;
  readonly now: Date;
}) {
  return (
    <Line share={model.said}>
      {name}
      {": "}
      <Outcome outcome={model.outcome} words={model.decision} />
      {`, by the model. It said ${model.said}, `}
      <At at={model.at} now={now} />.
    </Line>
  );
}

/** The lines of one question in the block above the history. */
export function StandingLines({
  standing,
  now,
}: {
  readonly standing: Standing;
  readonly now: Date;
}) {
  const { question, model, person } = standing;
  const name = <span className="font-semibold">{question}</span>;

  if (person === undefined) {
    return model === undefined ? null : <ModelLine name={name} model={model} now={now} />;
  }

  if (person.kind === "outdated") {
    return (
      <>
        {model === undefined ? null : <ModelLine name={name} model={model} now={now} />}
        <Line>
          {`${person.reviewer} decided ${person.decided} `}
          <At at={person.at} now={now} />
          {"; the record changed after that, so the decision no longer stands."}
        </Line>
      </>
    );
  }

  if (person.kind === "withdrawn") {
    return (
      <>
        <Line>
          {name}
          {`: the decision was withdrawn by ${person.reviewer}, `}
          <At at={person.at} now={now} />.
        </Line>
        {model === undefined ? null : (
          <Line share={model.said}>
            {`The model's last answer was ${model.said}, `}
            <At at={model.at} now={now} />
            {"; the thresholds make it "}
            <Outcome outcome={model.outcome} words={model.decision} />.
          </Line>
        )}
      </>
    );
  }

  return (
    <>
      <Line>
        {name}
        {`: ${person.decided}, by ${person.reviewer}, `}
        <At at={person.at} now={now} />.
      </Line>
      {standing.answeredAfter && model !== undefined ? (
        <>
          <Line share={model.said}>
            {"The model answered again "}
            <At at={model.at} now={now} />
            {`: it said ${model.said}, which the thresholds made `}
            <Outcome outcome={model.outcome} words={model.decision} />.
          </Line>
          <Line>
            {`The record had not changed since ${person.reviewer} decided, so the decision stands.`}
          </Line>
        </>
      ) : null}
    </>
  );
}
