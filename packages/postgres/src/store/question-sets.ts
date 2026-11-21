import { parseQuestionSet, type QuestionSet, type QuestionSetVersion } from "@facetdb/core";
import type { SqlQuery } from "../sql/index.ts";
import { fromMs, integer, text, toMs } from "./rows.ts";

/**
 * A version as the store keeps it: its number, hash and time, and the question set it was made
 * from; null, with the reason, when that set no longer parses (saved by an older FacetDB whose
 * rules this one does not share). A history is shown, never acted on, so such a row is said, not
 * guessed at, and does not take the other versions down with it.
 */
export type StoredQuestionSetVersion = QuestionSetVersion &
  (
    | { readonly questionSet: QuestionSet; readonly unreadable: null }
    | { readonly questionSet: null; readonly unreadable: string }
  );

/**
 * The set a source's worker runs, as its last loop open recorded it (store migration 8): the
 * version it runs under, the whole set (thresholds, where filter, stakes and order included, which
 * the version's content hash leaves out), and when it was recorded.
 */
export type QuestionSetInForce = {
  readonly version: number;
  readonly questionSet: QuestionSet;
  readonly recordedAt: Date;
};

function setText(raw: unknown, version: number, sourceId: string): string {
  if (typeof raw !== "string") {
    throw new Error(`question set v${version} of "${sourceId}" came back as ${typeof raw}`);
  }
  return raw;
}

function parsedSet(raw: unknown, version: number, sourceId: string): QuestionSet {
  const parsed = parseQuestionSet(JSON.parse(setText(raw, version, sourceId)));
  if (!parsed.ok) {
    throw new Error(
      `question set v${version} of "${sourceId}" in the FacetDB store cannot be read: ${parsed.errors.join("; ")}`,
    );
  }
  return parsed.questionSet;
}

/**
 * The newest `limit` versions of one source, newest first, each with the set it was made from (the
 * studio's version history). The row holds no more than that: who made a version is not kept, and a
 * version is made when a worker first runs a set whose content changed. A set that no longer parses
 * comes back as null with the parser's words.
 */
export async function readQuestionSetHistory(
  query: SqlQuery,
  sourceId: string,
  limit: number,
): Promise<readonly StoredQuestionSetVersion[]> {
  const rows = await query(
    `select version::text as version, content_hash, ${toMs("created_at", "created_ms")},
            question_set::text as question_set
       from facetdb.question_set_versions where source_id = $1
      order by version desc limit $2`,
    [sourceId, limit],
  );
  return rows.map((row): StoredQuestionSetVersion => {
    const version = integer(row, "version");
    const kept = {
      version,
      contentHash: text(row, "content_hash"),
      createdAt: new Date(integer(row, "created_ms")),
    };
    const parsed = parseQuestionSet(JSON.parse(setText(row["question_set"], version, sourceId)));
    return parsed.ok
      ? { ...kept, questionSet: parsed.questionSet, unreadable: null }
      : { ...kept, questionSet: null, unreadable: parsed.errors.join("; ") };
  });
}

/**
 * The question sets of the given versions of one source, as the store saved them: what the log's
 * entries were asked under (`facetdb explain`, the decision history). A version the store does not
 * keep is absent from the map. A saved set that no longer parses is a corrupt store, said with the
 * version and the source and never replaced by a guess.
 */
export async function readQuestionSets(
  query: SqlQuery,
  sourceId: string,
  versions: readonly number[],
): Promise<ReadonlyMap<number, QuestionSet>> {
  const kept = new Map<number, QuestionSet>();
  if (versions.length === 0) {
    return kept;
  }
  const rows = await query(
    `select version::text as version, question_set::text as question_set
       from facetdb.question_set_versions where source_id = $1 and version = any($2::int[])`,
    [sourceId, [...versions]],
  );
  for (const row of rows) {
    const version = integer(row, "version");
    kept.set(version, parsedSet(row["question_set"], version, sourceId));
  }
  return kept;
}

/**
 * The set the source's worker runs, or null when no worker has recorded one (none has started
 * since the store reached version 8). A row that no longer parses is a corrupt store, said as
 * `readQuestionSets` says it.
 */
export async function readQuestionSetInForce(
  query: SqlQuery,
  sourceId: string,
): Promise<QuestionSetInForce | null> {
  const rows = await query(
    `select version::text as version, question_set::text as question_set,
            ${toMs("recorded_at", "recorded_ms")}
       from facetdb.question_sets_in_force where source_id = $1`,
    [sourceId],
  );
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const version = integer(row, "version");
  return {
    version,
    questionSet: parsedSet(row["question_set"], version, sourceId),
    recordedAt: new Date(integer(row, "recorded_ms")),
  };
}

/** Writes the set the worker runs from now on: one row per source, replaced whole at each loop open. */
export async function writeQuestionSetInForce(
  query: SqlQuery,
  sourceId: string,
  version: number,
  questionSet: QuestionSet,
  nowMs: number,
): Promise<void> {
  await query(
    `insert into facetdb.question_sets_in_force (source_id, version, question_set, recorded_at)
     values ($1, $2, $3::jsonb, ${fromMs("$4")})
     on conflict (source_id) do update
       set version = excluded.version, question_set = excluded.question_set, recorded_at = excluded.recorded_at`,
    [sourceId, version, JSON.stringify(questionSet), nowMs],
  );
}
