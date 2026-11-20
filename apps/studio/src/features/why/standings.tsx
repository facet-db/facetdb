import type { ReactNode } from "react";
import type { ExplainedEntry } from "../../api/index.ts";
import { At, Share } from "./timeline.tsx";

/**
 * "What the log says last", one question at a time. The page says only what the log proves. The
 * history carries no state hash, so it cannot tell a model answer on the state a person decided
 * from one on a changed state; core keeps a person's decision over a later answer on the same state
 * (packages/core, record-decisions.ts), so a later answer is never drawn above the decision as if
 * it replaced it. Whether the person's decision still holds is the record's to say, which
 * `facetdb explain` reads.
 */

type Model = { readonly at: string; readonly said: string; readonly decision: string };

type Person =
  | {
      readonly kind: "decided";
      readonly at: string;
      readonly decided: string;
      readonly reviewer: string;
    }
  | { readonly kind: "withdrawn"; readonly at: string; readonly reviewer: string };

export type Standing = {
  readonly question: string;
  /** The model's latest answer to it, if the log has one. */
  readonly model?: Model;
  /** The latest thing a person did about it: a decision, or taking one back. */
  readonly person?: Person;
  /** Whether the model's latest answer is later than the person's latest act. */
  readonly answeredAfter: boolean;
};

/** What the log holds about one question while it is read oldest first. */
type Reading = {
  /** The decisions not taken back, oldest first, each with whether the model answered after it. */
  words: { at: string; decided: string; reviewer: string; answeredAfter: boolean }[];
  model?: Model;
  /** The latest withdrawal, for when it took back the only decision there was. */
  withdrawal?: { at: string; reviewer: string };
};

/**
 * Each question's standing, in the order the questions first appear in the history (oldest first).
 * The decisions are kept per question as core keeps them (packages/core, log/human.ts,
 * standingHuman): a withdrawal removes its own reviewer's latest decision and no one else's, so
 * when amara decides yes, bea decides no and bea withdraws, amara's yes stands again. The page
 * cannot see state hashes, so unlike core it never retires a decision for a later answer: it shows
 * both and lets `facetdb explain` say which holds.
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
      for (const answer of entry.answers) {
        const read = reading(answer.question);
        read.model = { at: entry.at, said: answer.said, decision: answer.decision };
        for (const word of read.words) {
          word.answeredAfter = true;
        }
      }
    } else if (entry.kind === "human") {
      reading(entry.question).words.push({
        at: entry.at,
        decided: entry.decided,
        reviewer: entry.reviewer,
        answeredAfter: false,
      });
    } else {
      const read = reading(entry.question);
      const taken = read.words.findLastIndex((word) => word.reviewer === entry.reviewer);
      if (taken !== -1) {
        read.words.splice(taken, 1);
      }
      read.withdrawal = { at: entry.at, reviewer: entry.reviewer };
    }
  }
  return [...readings].map(([question, read]): Standing => {
    const word = read.words.at(-1);
    return {
      question,
      ...(read.model === undefined ? {} : { model: read.model }),
      ...(word !== undefined
        ? { person: { kind: "decided" as const, ...word } }
        : read.withdrawal === undefined
          ? {}
          : { person: { kind: "withdrawn" as const, ...read.withdrawal } }),
      answeredAfter: word?.answeredAfter ?? false,
    };
  });
}

/** An argument as a shell reads it: plain when it is plain, else in single quotes. */
function shellWord(text: string): string {
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

/** The lines of one question under "What the log says last". */
export function StandingLines({
  standing,
  source,
  recordKey,
  now,
}: {
  readonly standing: Standing;
  readonly source: string;
  readonly recordKey: string;
  readonly now: Date;
}) {
  const { question, model, person } = standing;
  const name = <span className="font-semibold">{question}</span>;

  if (person === undefined) {
    return model === undefined ? null : (
      <Line share={model.said}>
        {name}
        {`: ${model.decision}, by the model. It said ${model.said}, `}
        <At at={model.at} now={now} />.
      </Line>
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
            {`; the thresholds make it ${model.decision}.`}
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
            {`: it said ${model.said}, which the thresholds made ${model.decision}.`}
          </Line>
          <Line>
            {`${person.reviewer}'s decision still holds unless the record changed in between. `}
            <code>{`facetdb explain ${shellWord(source)} ${shellWord(recordKey)}`}</code>
            {" reads the record itself."}
          </Line>
        </>
      ) : null}
    </>
  );
}
