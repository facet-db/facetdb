import {
  type Answer,
  type AnswerEntry,
  answerOutcomes,
  chosenWords,
  type DecisionLog,
  type HumanEntry,
  type HumanValue,
  isHumanDecision,
  type LogEntry,
  type LoggedUsage,
  namedValue,
  type QuestionSet,
  type RecordKey,
  type TaggedDecision,
} from "@facetdb/core";
import type { SqlClient, SqlQuery, SqlRow } from "../sql/index.ts";
import { readQuestionSets } from "./question-sets.ts";
import { fromMs, integer, json, jsonObject, text, textOrNull, toMs } from "./rows.ts";

const COLUMNS = `record_key, kind, version::text as version, state_hash, model, answers::text as answers,
  usage::text as usage, question, value::text as value, reviewer, note, ${toMs("at", "at_ms")}`;

/**
 * `facetdb.decisions` as core's `DecisionLog` for one source: one row per model call holding every
 * answer, one row per human decision. Rows are only ever inserted; a correction is a new row, and
 * "latest" is the highest id, which is the order the log was appended in.
 */
export function createDecisionLog(client: SqlClient, sourceId: string): DecisionLog {
  async function entries(whereRest: string, params: readonly unknown[]): Promise<LogEntry[]> {
    const rows = await client.query(
      `select ${COLUMNS} from facetdb.decisions where source_id = $1 ${whereRest}`,
      [sourceId, ...params],
    );
    return rows.map(toEntry);
  }

  return {
    async appendAnswer(entry) {
      await client.query(
        `insert into facetdb.decisions
           (source_id, record_key, kind, version, state_hash, model, answers, usage, at)
         values ($1, $2, 'answer', $3, $4, $5, $6::jsonb, $7::jsonb, ${fromMs("$8")})`,
        [
          sourceId,
          entry.key,
          entry.version,
          entry.stateHash,
          entry.model,
          JSON.stringify(entry.answers),
          JSON.stringify(entry.usage),
          entry.at.getTime(),
        ],
      );
    },

    async appendHuman(entry) {
      await client.query(
        `insert into facetdb.decisions
           (source_id, record_key, kind, version, state_hash, question, value, reviewer, note, at)
         values ($1, $2, 'human', $3, $4, $5, $6::jsonb, $7, $8, ${fromMs("$9")})`,
        [
          sourceId,
          entry.key,
          entry.version,
          entry.stateHash,
          entry.question,
          JSON.stringify(entry.value),
          entry.reviewer,
          entry.note ?? null,
          entry.at.getTime(),
        ],
      );
    },

    async latestAnswer(key: RecordKey) {
      const found = await entries(
        "and record_key = $2 and kind = 'answer' order by id desc limit 1",
        [key],
      );
      return found.find(isAnswer);
    },

    async latestAnswers(keys) {
      const latest = new Map<RecordKey, AnswerEntry>();
      if (keys.length === 0) {
        return latest;
      }
      // One statement for a whole page: on a far database every round trip costs about 200 ms, so a
      // lookup per record set the backfill's time instead of its pace.
      const rows = await client.query(
        `select distinct on (record_key) ${COLUMNS}
           from facetdb.decisions
          where source_id = $1 and kind = 'answer' and record_key = any($2::text[])
          order by record_key, id desc`,
        [sourceId, [...keys]],
      );
      for (const entry of rows.map(toEntry).filter(isAnswer)) {
        latest.set(entry.key, entry);
      }
      return latest;
    },

    history(key: RecordKey) {
      return entries("and record_key = $2 order by id", [key]);
    },

    async latestAnswersSince(version) {
      const rows = await client.query(
        `select * from (
           select distinct on (record_key) ${COLUMNS}
             from facetdb.decisions
            where source_id = $1 and kind = 'answer'
            order by record_key, id desc
         ) latest
          where $2::integer is null or version::integer >= $2::integer
          order by record_key`,
        [sourceId, version ?? null],
      );
      return rows.map(toEntry).filter(isAnswer);
    },

    async page(after, limit) {
      // Keyset paging on the id, the order the log was appended in: a page costs the same at the
      // millionth row as at the first, and a row appended meanwhile lands on a later page.
      const rows = await client.query(
        // The cursor column is not called `id`: `order by id` would sort by that text alias.
        `select id::text as cursor, ${COLUMNS}
           from facetdb.decisions
          where source_id = $1 and id > $2::bigint
          order by id
          limit $3::integer`,
        [sourceId, after ?? 0, limit],
      );
      const last = rows.at(-1);
      return {
        entries: rows.map(toEntry),
        next: rows.length < limit || last === undefined ? undefined : integer(last, "cursor"),
      };
    },

    async count(version) {
      const rows = await client.query(
        `select count(*)::text as entries
           from facetdb.decisions
          where source_id = $1 and ($2::integer is null or version = $2::integer)`,
        [sourceId, version ?? null],
      );
      const [row] = rows;
      if (row === undefined) {
        throw new Error("count(*) returned no row");
      }
      return integer(row, "entries");
    },
  };
}

function isAnswer(entry: LogEntry): entry is AnswerEntry {
  return entry.kind === "answer";
}

/** What a log entry came to: a human decision always stands; an answer needs review while any question does. */
export type DecisionStatus = "decided" | "needs_review";

/**
 * Where a search page ends: the `at` and `id` of its last row. The order is `at desc, id` (rows of
 * one instant oldest first, as the index `decisions_by_time (source_id, at desc, id)` holds them),
 * so the pair is a total order and a page never repeats or skips a row, even when two rows share a
 * millisecond or a row was appended with an earlier time than the one before it.
 */
export type SearchCursor = { readonly atMs: number; readonly id: number };

/** The filters of the Decisions page; every one but `source` and `limit` is optional. */
export type DecisionSearch = {
  /** The source's id in the store (`sourceIdOf`): the time index leads with it. */
  readonly source: string;
  readonly key?: string;
  /** Answers to this question, and human decisions on it. */
  readonly question?: string;
  readonly status?: DecisionStatus;
  /** Human decisions by this reviewer. */
  readonly reviewer?: string;
  /** Inclusive. */
  readonly from?: Date;
  /** Exclusive. */
  readonly to?: Date;
  /** The `next` of the previous page; absent for the first. */
  readonly before?: SearchCursor;
  readonly limit: number;
};

/**
 * What one question of a found entry came to: the decision in `facetdb explain`'s words with its
 * tag (packages/core, log/explain.ts), and the option or level the model named, as the export's
 * `value` column has it (empty for a noul, and for a score whose version the store no longer keeps).
 */
export type FoundAnswer = TaggedDecision & { readonly value: string };

/** One log entry as the export has it, with what each of its answers led to. */
export type FoundDecision = {
  readonly cursor: SearchCursor;
  readonly entry: LogEntry;
  /**
   * By question name. A human entry holds its one question's chosen value, decided, as a person's
   * word always stands; a reviewer's undo reads "withdrawn", as the export prints it, and the entry
   * itself says it is one (`isHumanDecision`).
   */
  readonly decisions: Readonly<Record<string, FoundAnswer>>;
};

export type DecisionSearchPage = {
  readonly found: readonly FoundDecision[];
  /** The cursor of the page after this one; undefined when the log holds nothing older. */
  readonly next: SearchCursor | undefined;
};

/** Raw rows read per query while a status is looked for (it is decided after the read). */
export const SEARCH_SCAN_BATCH = 200;

/**
 * The most raw rows one search reads while looking for a status: a page may come back short, with
 * a `next`, instead of reading a whole log for a status that is rare.
 */
export const SEARCH_MAX_SCAN = 5000;

/**
 * The SQL of one search batch, newest first over `decisions_by_time (source_id, at desc, id)`: the
 * source and the time range are the index's prefix, the cursor continues it, and the other filters
 * are applied to rows the index already ordered. Values are parameters, never text.
 */
export function searchStatement(
  search: Omit<DecisionSearch, "limit" | "status">,
  rows: number,
): { readonly sql: string; readonly params: readonly unknown[] } {
  const params: unknown[] = [search.source];
  const where = ["source_id = $1"];
  const param = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (search.from !== undefined) {
    where.push(`at >= ${fromMs(param(search.from.getTime()))}`);
  }
  if (search.to !== undefined) {
    where.push(`at < ${fromMs(param(search.to.getTime()))}`);
  }
  if (search.before !== undefined) {
    // Not a row comparison: the time runs down and the id up, as `decisions_by_time` does.
    const atMs = param(search.before.atMs);
    const id = param(search.before.id);
    where.push(`(at < ${fromMs(atMs)} or (at = ${fromMs(atMs)} and id > ${id}::bigint))`);
  }
  if (search.key !== undefined) {
    where.push(`record_key = ${param(search.key)}`);
  }
  if (search.question !== undefined) {
    const name = param(search.question);
    where.push(
      `((kind = 'answer' and jsonb_exists(answers, ${name})) or (kind = 'human' and question = ${name}))`,
    );
  }
  if (search.reviewer !== undefined) {
    where.push(`(kind = 'human' and reviewer = ${param(search.reviewer)})`);
  }
  const limit = param(rows);
  return {
    sql: `select id::text as cursor, ${COLUMNS}
            from facetdb.decisions
           where ${where.join(" and ")}
           order by at desc, id
           limit ${limit}::integer`,
    params,
  };
}

/**
 * By the tag, never the words: an option may be named "needs review", and an answer that decided
 * it is decided.
 */
function statusOfDecisions(decisions: Readonly<Record<string, FoundAnswer>>): DecisionStatus {
  return Object.values(decisions).some((decision) => decision.outcome === "needs_review")
    ? "needs_review"
    : "decided";
}

/** Each answer of a model call, tagged, with the option or level it named under the version's set. */
function foundAnswers(
  entry: AnswerEntry,
  set: QuestionSet | undefined,
): Readonly<Record<string, FoundAnswer>> {
  const outcomes = answerOutcomes(entry, set);
  return Object.fromEntries(
    Object.entries(entry.answers).map(([name, answer]) => {
      const question = set?.questions.find((candidate) => candidate.name === name);
      return [
        name,
        {
          ...(outcomes[name] ?? { words: "unknown", outcome: "unknown" }),
          value: namedValue(question, answer),
        },
      ];
    }),
  );
}

/**
 * A person's word on one question, as the export prints it. A person never leaves a question to
 * review, so it files under decided, a withdrawal too; the API row's `withdrawn` tells that apart.
 */
function foundHuman(entry: HumanEntry): Readonly<Record<string, FoundAnswer>> {
  const words = isHumanDecision(entry) ? chosenWords(entry.value) : "withdrawn";
  return { [entry.question]: { words, outcome: "decided", value: words } };
}

/**
 * Searches one source's log, newest first (the Decisions page). The question sets of the versions
 * found are read once each, so every answer carries the decision its own version's thresholds made
 * of it. A status is a property of those decisions, so it is applied after the read: the search
 * keeps reading batches until the page is full, the log is spent, or `SEARCH_MAX_SCAN` rows were
 * looked at, and `next` always continues from the last row looked at.
 */
export async function searchDecisions(
  query: SqlQuery,
  search: DecisionSearch,
): Promise<DecisionSearchPage> {
  const { status, limit, ...filters } = search;
  const versions = new Map<number, QuestionSet>();
  const asked = new Set<number>();
  const found: FoundDecision[] = [];
  let before = search.before;
  let scanned = 0;
  for (;;) {
    // Without a status the page is exactly the rows asked for, plus one to know whether more follow.
    const size = status === undefined ? limit + 1 : SEARCH_SCAN_BATCH;
    const { sql, params } = searchStatement(
      { ...filters, ...(before === undefined ? {} : { before }) },
      size,
    );
    const rows = await query(sql, params);
    const entries = rows.map((row) => ({
      cursor: { atMs: integer(row, "at_ms"), id: integer(row, "cursor") },
      entry: toEntry(row),
    }));
    const missing = [...new Set(entries.map(({ entry }) => entry.version))].filter(
      (version) => !asked.has(version),
    );
    for (const [version, set] of await readQuestionSets(query, search.source, missing)) {
      versions.set(version, set);
    }
    for (const version of missing) {
      asked.add(version);
    }
    const full = rows.length === size;
    for (const [index, { cursor, entry }] of entries.entries()) {
      const decisions =
        entry.kind === "answer"
          ? foundAnswers(entry, versions.get(entry.version))
          : foundHuman(entry);
      if (status === undefined || statusOfDecisions(decisions) === status) {
        found.push({ cursor, entry, decisions });
      }
      if (found.length === limit) {
        // Another row exists when the batch holds one after this, or was full and so may.
        const more = index < entries.length - 1 || full;
        return { found, next: more ? cursor : undefined };
      }
    }
    const last = entries.at(-1);
    scanned += rows.length;
    if (!full || last === undefined) {
      return { found, next: undefined };
    }
    if (scanned >= SEARCH_MAX_SCAN) {
      return { found, next: last.cursor };
    }
    before = last.cursor;
  }
}

/** A row of `facetdb.decisions` becomes a log entry; a row of neither kind is a corrupt store. */
function toEntry(row: SqlRow): LogEntry {
  const common = {
    key: text(row, "record_key"),
    version: integer(row, "version"),
    stateHash: text(row, "state_hash"),
    at: new Date(Number(text(row, "at_ms"))),
  };
  const kind = text(row, "kind");
  if (kind === "answer") {
    return {
      kind,
      ...common,
      model: text(row, "model"),
      answers: jsonObject(row, "answers") as Readonly<Record<string, Answer>>,
      usage: jsonObject(row, "usage") as LoggedUsage,
    };
  }
  if (kind === "human") {
    const note = textOrNull(row, "note");
    return {
      kind,
      ...common,
      question: text(row, "question"),
      value: json(row, "value") as HumanValue,
      reviewer: text(row, "reviewer"),
      ...(note === null ? {} : { note }),
    } satisfies HumanEntry;
  }
  throw new Error(`a decision row has kind "${kind}", expected "answer" or "human"`);
}
