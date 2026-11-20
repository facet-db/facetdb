import type { Question, QuestionSet } from "@facetdb/core";

/**
 * A source's question-set versions as the studio's Questions page shows them: each version's
 * number, when it was made, and what changed from the one before it in words. A version row of the
 * store holds its number, its content hash, the time a worker first ran it and the set it was made
 * from; nothing names who made it, so the history says what and when, never who.
 */

/** How many versions `GET /v1/config` carries per source, newest first. */
export const VERSION_HISTORY_SHOWN = 20;

/** One version as the store keeps it; its set null when it no longer parses. */
export type StoredVersion = {
  readonly version: number;
  readonly createdAt: Date;
  readonly questionSet: QuestionSet | null;
};

/** A source's history as the worker hands it in: the version it runs now, the stored ones newest first. */
export type SourceHistory = {
  /** The version the worker's loop answers under; null when this worker does not run the source. */
  readonly inForce: number | null;
  readonly versions: readonly StoredVersion[];
};

/**
 * The worker's door to the history: the sources of the config in force with the version each runs,
 * and a read of one source's stored versions. The read touches the store, so it may fail; the
 * config itself is answered from memory whatever the store does.
 */
export type HistoryDoor = {
  sources(): readonly { readonly name: string; readonly inForce: number | null }[];
  read(source: string, limit: number): Promise<readonly StoredVersion[]>;
};

/** One version in the reply. */
export type VersionWords = {
  readonly version: number;
  /** ISO 8601: when a worker first ran it, which is when the store made it. */
  readonly createdAt: string;
  /** What changed from the version before, in a sentence: "The wording of is_scam; category added". */
  readonly changes: string;
};

export type VersionHistory = {
  readonly inForce: number | null;
  /** Newest first, at most `VERSION_HISTORY_SHOWN`. */
  readonly versions: readonly VersionWords[];
  /** Older versions are kept than the ones listed. */
  readonly earlier: boolean;
  /** What could not be read, in words; null when the whole history was read. */
  readonly note: string | null;
};

const TYPE_WORDS: Record<Question["type"], string> = {
  noul: "Yes or no",
  choice: "Pick one",
  score: "Rate on a scale",
};

function names(questions: readonly Question[]): string {
  const listed = questions.map((question) => question.name);
  if (listed.length <= 1) {
    return listed.join("");
  }
  return `${listed.slice(0, -1).join(", ")} and ${listed.at(-1) ?? ""}`;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** What the model reads of one question changed, in the words of its parts. */
function questionParts(before: Question, after: Question): string[] {
  const parts: string[] = [];
  if (before.instructions !== after.instructions) {
    parts.push("the wording");
  }
  if (before.type === "noul" && after.type === "noul" && !same(before.criteria, after.criteria)) {
    parts.push("the criteria");
  }
  if (before.type === "choice" && after.type === "choice" && !same(before.options, after.options)) {
    parts.push("the options");
  }
  if (before.type === "score" && after.type === "score" && !same(before.levels, after.levels)) {
    parts.push("the levels");
  }
  return parts;
}

/** What made `after` a new version of `before`: the parts the content hash covers, in words. */
export function versionChanges(before: QuestionSet, after: QuestionSet): string {
  const changes: string[] = [];
  if (before.model !== after.model) {
    changes.push(`the model, from ${before.model} to ${after.model}`);
  }
  const added = after.read.filter((field) => !before.read.includes(field));
  const dropped = before.read.filter((field) => !after.read.includes(field));
  if (added.length > 0 || dropped.length > 0) {
    changes.push(
      `the fields read: ${[
        ...added.map((field) => `${field} added`),
        ...dropped.map((field) => `${field} removed`),
      ].join(", ")}`,
    );
  } else if (!same(before.read, after.read)) {
    changes.push("the order of the fields read");
  }
  for (const question of after.questions) {
    const previous = before.questions.find((candidate) => candidate.name === question.name);
    if (previous === undefined) {
      changes.push(`${question.name} added`);
    } else if (previous.type !== question.type) {
      changes.push(`${question.name} is now ${TYPE_WORDS[question.type]}`);
    } else {
      const parts = questionParts(previous, question);
      if (parts.length > 0) {
        changes.push(`${parts.join(" and ")} of ${question.name}`);
      }
    }
  }
  for (const question of before.questions) {
    if (!after.questions.some((candidate) => candidate.name === question.name)) {
      changes.push(`${question.name} removed`);
    }
  }
  const sentence = changes.length === 0 ? "the question set's content" : changes.join("; ");
  // A sentence opening on a question's name keeps the name as it is written: `category added`.
  return sentence.startsWith("the ") ? `The ${sentence.slice(4)}` : sentence;
}

/**
 * The history the reply carries: `stored` is read one longer than shown, so the oldest version
 * listed is still compared with the one before it.
 */
export function versionHistory(history: SourceHistory): VersionHistory {
  const shown = history.versions.slice(0, VERSION_HISTORY_SHOWN);
  const unreadable = shown
    .filter((entry) => entry.questionSet === null)
    .map((entry) => entry.version);
  return {
    inForce: history.inForce,
    earlier: history.versions.length > shown.length,
    // A set that no longer parses is left out of the list, and said.
    versions: shown.flatMap((entry, index) => {
      if (entry.questionSet === null) {
        return [];
      }
      const before = history.versions[index + 1];
      return [
        {
          version: entry.version,
          createdAt: entry.createdAt.toISOString(),
          changes: changesFrom(before, entry.questionSet, entry.version),
        },
      ];
    }),
    note:
      unreadable.length === 0
        ? null
        : `${unreadable.length === 1 ? "Version" : "Versions"} ${unreadable.join(", ")} ${unreadable.length === 1 ? "is" : "are"} kept in a form this worker cannot read, so ${unreadable.length === 1 ? "it is" : "they are"} left out.`,
  };
}

function changesFrom(before: StoredVersion | undefined, set: QuestionSet, version: number): string {
  if (before === undefined) {
    return `${version === 1 ? "Created" : "The oldest version kept"}, with ${names(set.questions)}`;
  }
  if (before.questionSet === null) {
    return `What changed from version ${String(before.version)} cannot be said: that version cannot be read`;
  }
  return versionChanges(before.questionSet, set);
}

/** A history the store could not give: the versions are empty, and the note says why. */
export function unreadHistory(source: string, inForce: number | null): VersionHistory {
  // Fixed words only: the store's own error can name its host or role, and this goes to every
  // signed-in studio; the reason is the worker's log's (service.ts).
  return {
    inForce,
    earlier: false,
    versions: [],
    note: `The version history of ${source} could not be read from the store. The questions shown are the worker's own, as it runs them; the worker's output says why.`,
  };
}
