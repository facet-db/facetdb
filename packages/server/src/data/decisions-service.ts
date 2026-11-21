import {
  type CurrentDecision,
  type ExplainedEntry,
  explainHistory,
  isHumanDecision,
  type KeyText,
  type LogEntry,
  type QuestionSet,
  type RecordStatus,
} from "@facetdb/core";
import {
  type DecisionSearchPage,
  type DecisionStatus,
  type FoundDecision,
  type SearchCursor,
  sourceIdOf,
} from "@facetdb/postgres";

/**
 * The decision history behind the Decisions page and the why page: the log of one source searched
 * by record, question, status, reviewer and time, and one record's full history as `facetdb
 * explain` words it. Both read the store's log through `DecisionsStore` and never a source's own
 * database.
 */

/** Rows a page holds when the caller names no limit, and the most it may ask for. */
export const DECISIONS_DEFAULT_LIMIT = 50;
export const DECISIONS_MAX_LIMIT = 200;

/** The log as this service reads it: `facetdb.decisions` and the saved question-set versions. */
export type DecisionsStore = {
  search(search: {
    readonly source: string;
    readonly key?: string;
    readonly question?: string;
    readonly status?: DecisionStatus;
    readonly reviewer?: string;
    readonly from?: Date;
    readonly to?: Date;
    readonly before?: SearchCursor;
    readonly limit: number;
  }): Promise<DecisionSearchPage>;
  /** Every log entry of the record, oldest first. */
  history(sourceId: string, key: string): Promise<readonly LogEntry[]>;
  /** The saved question sets of those versions; one the store does not keep is absent. */
  questionSets(
    sourceId: string,
    versions: readonly number[],
  ): Promise<ReadonlyMap<number, QuestionSet>>;
};

export type DecisionsServiceDeps = {
  readonly store: DecisionsStore;
  /** The project the worker serves; a key of another project in the same store sees none of it. */
  readonly projectId: string;
  /** The names of the sources of the project's config: the ones whose logs can be read. */
  readonly sources: readonly string[];
  /** How a source's keys are written for a person (MongoDB's `65f1…`); undefined where a key is its own text. */
  readonly keyText: (source: string) => KeyText | undefined;
  /**
   * The record as its source holds it now, through the connector of the loop in force (what
   * `facetdb explain` prints under "Now"); undefined when the source does not run in this worker
   * or the record is gone. The key is the source's own, already read from the person's text.
   */
  readonly current: (source: string, key: string) => Promise<CurrentDecision | undefined>;
};

/** The filters of `GET /v1/decisions`, parsed; the cursor is the previous page's `next`, as text. */
export type DecisionsQuery = {
  readonly source: string;
  readonly key?: string | undefined;
  readonly question?: string | undefined;
  readonly status?: DecisionStatus | undefined;
  readonly reviewer?: string | undefined;
  readonly from?: Date | undefined;
  readonly to?: Date | undefined;
  readonly cursor?: SearchCursor | undefined;
  readonly limit: number;
};

/**
 * One log row in the export's shape (`facetdb export`, JSONL): `time`, `kind`, `record_key`,
 * `version`, `state_hash`, then `model` and `answers` for a model call, or `question`, `value`,
 * `decided_by`, `note` and `withdrawn` for a person. Every answer carries `decision`, what its
 * version's thresholds made of it, in explain's words, with `outcome` as its tag (an option may be
 * named "needs review"; the tag says which it is), and a choice or a score carries the option or
 * level it named as `value`, as the export does; a human row carries its word as `decision` too.
 */
export type DecisionRow = {
  readonly time: string;
  readonly kind: "answer" | "human";
  readonly record_key: string;
} & Readonly<Record<string, unknown>>;

export type DecisionsPage = {
  readonly decisions: readonly DecisionRow[];
  /** Pass as `cursor` for the page after this one; null on the last page. */
  readonly next: string | null;
};

export type DecisionsOutcome =
  | { readonly kind: "ok"; readonly page: DecisionsPage }
  | { readonly kind: "unknown_project" }
  | { readonly kind: "unknown_source"; readonly known: readonly string[] };

export type WhyOutcome =
  | {
      readonly kind: "history";
      readonly source: string;
      readonly key: string;
      /**
       * The record's status now, read from the record itself as `facetdb explain` reads it, and
       * whether a person ever decided a question of it; both null when the source does not run in
       * this worker or the record is gone, and the log alone is left to speak.
       */
      readonly status: RecordStatus | null;
      readonly reviewed: boolean | null;
      /** Oldest first, exactly as `facetdb explain` builds it. */
      readonly entries: readonly ExplainedEntry[];
    }
  | { readonly kind: "unknown_project" }
  | { readonly kind: "unknown_source"; readonly known: readonly string[] }
  | {
      readonly kind: "unknown_record";
      readonly source: string;
      readonly key: string;
      readonly form: string;
    };

export type DecisionsService = {
  search(projectId: string, query: DecisionsQuery): Promise<DecisionsOutcome>;
  why(projectId: string, source: string, key: string): Promise<WhyOutcome>;
};

/** A cursor as the caller sees it: opaque text, the pair `SearchCursor` holds. */
export function cursorText(cursor: SearchCursor): string {
  return `${cursor.atMs}.${cursor.id}`;
}

/** The cursor a `cursorText` made, or undefined for text that is not one. */
export function parseCursor(text: string): SearchCursor | undefined {
  const match = /^(\d{1,16})\.(\d{1,16})$/.exec(text);
  const atMs = Number(match?.[1]);
  const id = Number(match?.[2]);
  return match === null || !Number.isSafeInteger(atMs) || !Number.isSafeInteger(id)
    ? undefined
    : { atMs, id };
}

function rowOf(found: FoundDecision, shown: (key: string) => string): DecisionRow {
  const { entry, decisions } = found;
  const common = {
    time: entry.at.toISOString(),
    kind: entry.kind,
    record_key: shown(entry.key),
    version: entry.version,
    state_hash: entry.stateHash,
  };
  if (entry.kind === "human") {
    const value = decisions[entry.question]?.words ?? String(entry.value);
    return {
      ...common,
      question: entry.question,
      value,
      decision: value,
      decided_by: entry.reviewer,
      // A reviewer's undo is told by this, never by the word "withdrawn", which an option may be
      // called.
      withdrawn: !isHumanDecision(entry),
      ...(entry.note === undefined ? {} : { note: entry.note }),
    };
  }
  return {
    ...common,
    model: entry.model,
    answers: Object.fromEntries(
      Object.entries(entry.answers).map(([name, answer]) => {
        const found = decisions[name] ?? { words: "unknown", outcome: "unknown", value: "" };
        return [
          name,
          {
            ...answer,
            // A noul's answer is its probability; a name is for the option or level it chose.
            ...(answer.type === "noul" ? {} : { value: found.value }),
            decision: found.words,
            outcome: found.outcome,
          },
        ];
      }),
    ),
  };
}

export function createDecisionsService(deps: DecisionsServiceDeps): DecisionsService {
  const { store } = deps;
  const ours = (projectId: string) => projectId === deps.projectId;
  const known = (source: string) => deps.sources.includes(source);

  return {
    async search(projectId, query) {
      if (!ours(projectId)) {
        return { kind: "unknown_project" };
      }
      if (!known(query.source)) {
        return { kind: "unknown_source", known: deps.sources };
      }
      const keyText = deps.keyText(query.source);
      const shown = (key: string) => keyText?.toText(key) ?? key;
      const found = await store.search({
        source: sourceIdOf(deps.projectId, query.source),
        ...(query.key === undefined
          ? {}
          : { key: keyText === undefined ? query.key : keyText.fromText(query.key) }),
        ...(query.question === undefined ? {} : { question: query.question }),
        ...(query.status === undefined ? {} : { status: query.status }),
        ...(query.reviewer === undefined ? {} : { reviewer: query.reviewer }),
        ...(query.from === undefined ? {} : { from: query.from }),
        ...(query.to === undefined ? {} : { to: query.to }),
        ...(query.cursor === undefined ? {} : { before: query.cursor }),
        limit: query.limit,
      });
      return {
        kind: "ok",
        page: {
          decisions: found.found.map((row) => rowOf(row, shown)),
          next: found.next === undefined ? null : cursorText(found.next),
        },
      };
    },

    async why(projectId, source, typed) {
      if (!ours(projectId)) {
        return { kind: "unknown_project" };
      }
      if (!known(source)) {
        return { kind: "unknown_source", known: deps.sources };
      }
      const keyText = deps.keyText(source);
      const key = keyText === undefined ? typed : keyText.fromText(typed);
      const sourceId = sourceIdOf(deps.projectId, source);
      const history = await store.history(sourceId, key);
      if (history.length === 0) {
        return {
          kind: "unknown_record",
          source,
          key: typed,
          form: keyText?.form ?? "the table's primary key, as text",
        };
      }
      // Each version once, however many entries ran under it (explain reads them the same way).
      const versions = await store.questionSets(sourceId, [
        ...new Set(history.map((entry) => entry.version)),
      ]);
      const current = await deps.current(source, key);
      return {
        kind: "history",
        source,
        key: keyText?.toText(key) ?? key,
        status: current?.status ?? null,
        reviewed: current?.reviewed ?? null,
        entries: explainHistory(history, versions),
      };
    },
  };
}
