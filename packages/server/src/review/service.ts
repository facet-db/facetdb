import {
  type Answer,
  chosenWords,
  createReviewService,
  type HumanValue,
  type OpenedCard,
  type Question,
  type RecordStatus,
  type ReviewCard,
  type ReviewFilter,
  type ReviewServiceDeps,
  type StateValue,
  saidWords,
} from "@facetdb/core";
import { sourceIdOf } from "@facetdb/postgres";

/**
 * What the review endpoints are built from: the core review service's dependencies, every source
 * keyed by its store id, and the project's source names, because a request names a source as the
 * config does (`listings`) and the store knows it as `<project>:listings`.
 */
export type ReviewEndpointDeps = ReviewServiceDeps & {
  readonly projectId: string;
  readonly sources: readonly string[];
};

/** One model option with the probability it was given: yes and no for a noul. */
export type OptionView = {
  readonly name: string;
  readonly description?: string;
  readonly probability: number;
};

/** A question still waiting for a person, with the model's answer in words and in numbers. */
export type OpenQuestionView = {
  readonly name: string;
  readonly type: Question["type"];
  readonly instructions: string;
  /** "58% likely yes", "billing, 82% sure": the model's answer, as the screen and the terminal say it. */
  readonly said: string;
  /** The figure the thresholds and the `below` filter compare: a noul's yes probability, otherwise a confidence. */
  readonly figure: number;
  /** The option or level with the highest probability. */
  readonly top: string;
  readonly options: readonly OptionView[];
};

/** A question already decided, shown greyed out with its value. */
export type DecidedQuestionView = {
  readonly name: string;
  readonly type: Question["type"];
  readonly instructions: string;
  readonly value: HumanValue;
  /** "yes", "no", or the option or level name. */
  readonly said: string;
};

/** A card the reviewer holds: the only response in this surface that carries a record's state. */
export type CardView = {
  readonly source: string;
  readonly key: string;
  /** The version of the record the card shows; a decision is made against it and only it. */
  readonly stateHash: string;
  readonly state: Readonly<Record<string, StateValue>>;
  readonly open: readonly OpenQuestionView[];
  readonly decided: readonly DecidedQuestionView[];
  /** When the record began waiting. */
  readonly since: string;
  readonly lockedUntil: string;
};

/** A card as the queue lists it: what waits, never the record's state. */
export type QueuedCardView = {
  readonly source: string;
  readonly key: string;
  readonly stateHash: string;
  readonly since: string;
  /** This reviewer skipped it: it is listed after the cards they did not skip. */
  readonly skipped: boolean;
  /** The questions still open, with the model's figure for each. */
  readonly open: readonly { readonly name: string; readonly figure: number }[];
};

export type QueueView = {
  /** How many cards match, for this reviewer (another reviewer's live holds are not counted). */
  readonly count: number;
  /** When the oldest matching card began waiting, and how long ago in milliseconds; null on an empty queue. */
  readonly oldestSince: string | null;
  readonly oldestWaitMs: number | null;
  /** The first page, oldest first (the cards this reviewer skipped last). */
  readonly cards: readonly QueuedCardView[];
};

/** What the queue and `open` narrow to; the names are the config's, as the request wrote them. */
export type QueueFilter = {
  readonly source?: string | undefined;
  readonly question?: string | undefined;
  readonly below?: number | undefined;
};

/** A card a request refers to: its source by name and the state it was opened at. */
export type CardTarget = {
  readonly source: string;
  readonly key: string;
  readonly stateHash: string;
};

export type DecisionInput = {
  readonly question: string;
  readonly value: HumanValue;
  readonly note?: string;
};

/** Failures found before the core service is asked: a name the request wrote that this project lacks. */
type UnknownSource = {
  readonly kind: "unknown_source";
  readonly source: string;
  readonly known: readonly string[];
};
type UnknownQuestion = {
  readonly kind: "unknown_question";
  readonly source: string | undefined;
  readonly question: string;
  readonly known: readonly string[];
};
type Unknown = UnknownSource | UnknownQuestion;

export type QueueOutcome = ({ readonly kind: "queue" } & QueueView) | Unknown;

export type OpenOutcome =
  | { readonly kind: "opened"; readonly card: CardView }
  | { readonly kind: "empty" }
  | { readonly kind: "held"; readonly by: string; readonly until: string }
  | { readonly kind: "gone" }
  | Unknown;

export type RenewOutcome =
  | { readonly kind: "renewed"; readonly lockedUntil: string }
  | { readonly kind: "held"; readonly by: string; readonly until: string }
  | { readonly kind: "lost" }
  | { readonly kind: "gone" }
  | UnknownSource;

export type DecideOutcome =
  | {
      readonly kind: "decided";
      readonly status: RecordStatus;
      readonly open: readonly string[];
      /** The actions that failed after the decision, by name; the decision stands. */
      readonly failedActions: readonly string[];
    }
  | { readonly kind: "stale"; readonly reason: string }
  | { readonly kind: "held"; readonly by: string; readonly until: string }
  | { readonly kind: "lost" }
  | { readonly kind: "refused"; readonly reason: string }
  | Unknown;

export type LetGoOutcome = { readonly kind: "done" } | UnknownSource;

export type UndoOutcome =
  | {
      readonly kind: "undone";
      readonly status: RecordStatus;
      /** The card, back in the queue and held by this reviewer; null when it is not theirs to hold now. */
      readonly card: CardView | null;
      readonly failedActions: readonly string[];
    }
  | { readonly kind: "nothing" }
  | { readonly kind: "stale"; readonly reason: string };

/**
 * The review endpoints' one service. The `viewer` of every call is the reviewer's name from the
 * session (`maya`, `os:alex`), which the core service writes into the log entry, and locks, skips
 * and the undo memory belong to.
 */
export type ReviewEndpointService = {
  queue(viewer: string, filter: QueueFilter, limit: number): Promise<QueueOutcome>;
  /** The next card under `filter`, or the card of `key` when one is named (its source then is `filter.source`). */
  open(viewer: string, filter: QueueFilter, key: string | undefined): Promise<OpenOutcome>;
  renew(viewer: string, card: CardTarget): Promise<RenewOutcome>;
  decide(viewer: string, card: CardTarget, decision: DecisionInput): Promise<DecideOutcome>;
  skip(viewer: string, card: CardTarget): Promise<LetGoOutcome>;
  release(viewer: string, card: CardTarget): Promise<LetGoOutcome>;
  undo(viewer: string): Promise<UndoOutcome>;
};

const iso = (at: Date) => at.toISOString();

export function createReviewEndpointService(deps: ReviewEndpointDeps): ReviewEndpointService {
  const { clock } = deps;
  const core = createReviewService(deps);
  const idOf = new Map(deps.sources.map((name) => [name, sourceIdOf(deps.projectId, name)]));
  const nameOf = new Map([...idOf].map(([name, id]) => [id, name]));

  function sourceName(id: string): string {
    const name = nameOf.get(id);
    if (name === undefined) {
      throw new Error(
        `the review queue holds a card of "${id}", which is not a source of this project`,
      );
    }
    return name;
  }

  function questionNames(sourceId: string): readonly string[] {
    return (
      deps.questionSets.get(sourceId)?.questionSet.questions.map((question) => question.name) ?? []
    );
  }

  /** The source and question a request names, resolved, or what is wrong with them. */
  function resolve(filter: QueueFilter): { readonly source: string | undefined } | Unknown {
    let source: string | undefined;
    if (filter.source !== undefined) {
      source = idOf.get(filter.source);
      if (source === undefined) {
        return { kind: "unknown_source", source: filter.source, known: deps.sources };
      }
    }
    if (filter.question !== undefined) {
      const known = (source === undefined ? [...idOf.values()] : [source]).flatMap(questionNames);
      if (!known.includes(filter.question)) {
        return {
          kind: "unknown_question",
          source: filter.source,
          question: filter.question,
          known: [...new Set(known)],
        };
      }
    }
    return { source };
  }

  function reviewFilter(filter: QueueFilter, source: string | undefined): ReviewFilter {
    return {
      ...(source === undefined ? {} : { source }),
      ...(filter.question === undefined ? {} : { question: filter.question }),
      ...(filter.below === undefined ? {} : { below: filter.below }),
    };
  }

  function cardRef(card: CardTarget, source: string) {
    return { source, key: card.key, stateHash: card.stateHash };
  }

  async function queue(viewer: string, filter: QueueFilter, limit: number): Promise<QueueOutcome> {
    const resolved = resolve(filter);
    if ("kind" in resolved) {
      return resolved;
    }
    // The queue's contract has no count, so the whole matching listing is read once and sliced.
    const nowMs = clock.now();
    const listed = await deps.queue.list(reviewFilter(filter, resolved.source), viewer, nowMs);
    const oldest = listed.reduce<Date | undefined>(
      (found, card) => (found === undefined || card.since < found ? card.since : found),
      undefined,
    );
    return {
      kind: "queue",
      count: listed.length,
      oldestSince: oldest === undefined ? null : iso(oldest),
      oldestWaitMs: oldest === undefined ? null : Math.max(0, nowMs - oldest.getTime()),
      cards: listed.slice(0, limit).map(queuedView),
    };
  }

  function queuedView(card: ReviewCard): QueuedCardView {
    return {
      source: sourceName(card.source),
      key: card.key,
      stateHash: card.stateHash,
      since: iso(card.since),
      skipped: card.skipped,
      open: card.openQuestions.map((name) => ({ name, figure: card.numbers[name] ?? 0 })),
    };
  }

  function cardView(card: OpenedCard): CardView {
    return {
      source: sourceName(card.source),
      key: card.key,
      stateHash: card.stateHash,
      state: card.state,
      open: card.open.map(({ question, answer, figure }) => ({
        name: question.name,
        type: question.type,
        instructions: question.instructions,
        said: saidWords(question, answer),
        figure,
        ...optionsOf(question, answer),
      })),
      decided: card.decided.map(({ question, value }) => ({
        name: question.name,
        type: question.type,
        instructions: question.instructions,
        value,
        said: chosenWords(value),
      })),
      since: iso(card.since),
      lockedUntil: iso(card.lockedUntil),
    };
  }

  async function open(
    viewer: string,
    filter: QueueFilter,
    key: string | undefined,
  ): Promise<OpenOutcome> {
    const resolved = resolve(filter);
    if ("kind" in resolved) {
      return resolved;
    }
    if (key !== undefined) {
      if (resolved.source === undefined) {
        // The route requires a source with a key; a caller that skips the route has a bug.
        throw new Error("a named card needs its source");
      }
      const opened = await core.openKey(viewer, resolved.source, key);
      switch (opened.kind) {
        case "opened":
          return { kind: "opened", card: cardView(opened.card) };
        case "held":
          return { kind: "held", by: opened.by, until: iso(opened.until) };
        case "gone":
          return opened;
      }
    }
    const card = await core.open(viewer, reviewFilter(filter, resolved.source));
    return card === null ? { kind: "empty" } : { kind: "opened", card: cardView(card) };
  }

  /** The source of a card a request names, resolved, or what is wrong with it. */
  function target(card: CardTarget): { readonly source: string } | UnknownSource {
    const source = idOf.get(card.source);
    return source === undefined
      ? { kind: "unknown_source", source: card.source, known: deps.sources }
      : { source };
  }

  async function renew(viewer: string, card: CardTarget): Promise<RenewOutcome> {
    const resolved = target(card);
    if ("kind" in resolved) {
      return resolved;
    }
    const result = await core.renew(viewer, cardRef(card, resolved.source));
    switch (result.kind) {
      case "locked":
        return { kind: "renewed", lockedUntil: iso(result.until) };
      case "held":
        return { kind: "held", by: result.by, until: iso(result.until) };
      case "lost":
      case "gone":
        return result;
    }
  }

  async function decide(
    viewer: string,
    card: CardTarget,
    decision: DecisionInput,
  ): Promise<DecideOutcome> {
    const resolved = target(card);
    if ("kind" in resolved) {
      return resolved;
    }
    const known = questionNames(resolved.source);
    if (!known.includes(decision.question)) {
      return {
        kind: "unknown_question",
        source: card.source,
        question: decision.question,
        known,
      };
    }
    const result = await core.decide(
      viewer,
      cardRef(card, resolved.source),
      decision.question,
      decision.value,
      decision.note,
    );
    switch (result.kind) {
      case "decided":
        return {
          kind: "decided",
          status: result.status,
          open: result.open,
          failedActions: result.failures.map((failure) => failure.action),
        };
      case "held":
        return { kind: "held", by: result.by, until: iso(result.until) };
      case "stale":
      case "lost":
      case "refused":
        return result;
    }
  }

  async function skip(viewer: string, card: CardTarget): Promise<LetGoOutcome> {
    const resolved = target(card);
    if ("kind" in resolved) {
      return resolved;
    }
    await core.skip(viewer, cardRef(card, resolved.source));
    return { kind: "done" };
  }

  async function release(viewer: string, card: CardTarget): Promise<LetGoOutcome> {
    const resolved = target(card);
    if ("kind" in resolved) {
      return resolved;
    }
    await core.release(viewer, cardRef(card, resolved.source));
    return { kind: "done" };
  }

  async function undo(viewer: string): Promise<UndoOutcome> {
    const result = await core.undo(viewer);
    switch (result.kind) {
      case "undone":
        return {
          kind: "undone",
          status: result.status,
          card: result.card === null ? null : cardView(result.card),
          failedActions: result.failures.map((failure) => failure.action),
        };
      case "nothing":
      case "stale":
        return result;
    }
  }

  return { queue, open, renew, decide, skip, release, undo };
}

/** The top option and every option with the probability the model gave it. */
function optionsOf(
  question: Question,
  answer: Answer,
): { readonly top: string; readonly options: readonly OptionView[] } {
  switch (answer.type) {
    case "noul":
      return {
        top: answer.probability >= 0.5 ? "yes" : "no",
        options: [
          { name: "yes", probability: answer.probability },
          { name: "no", probability: 1 - answer.probability },
        ],
      };
    case "choice": {
      const options = question.type === "choice" ? question.options : [];
      return {
        top: answer.top,
        options: options.map((option, index) => ({
          name: option.name,
          description: option.description,
          probability: answer.probabilities[index] ?? 0,
        })),
      };
    }
    case "score": {
      const levels = question.type === "score" ? question.levels : [];
      const options = levels.map((level, index) => ({
        name: level.name,
        ...(level.description === undefined ? {} : { description: level.description }),
        probability: answer.probabilities[index] ?? 0,
      }));
      const best = Math.max(...answer.probabilities);
      return { top: options[answer.probabilities.indexOf(best)]?.name ?? "", options };
    }
  }
}
