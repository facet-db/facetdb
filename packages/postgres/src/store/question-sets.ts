import { parseQuestionSet, type QuestionSet } from "@facetdb/core";
import type { SqlQuery } from "../sql/index.ts";
import { integer } from "./rows.ts";

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
    const raw = row["question_set"];
    if (typeof raw !== "string") {
      throw new Error(`question set v${version} of "${sourceId}" came back as ${typeof raw}`);
    }
    const parsed = parseQuestionSet(JSON.parse(raw));
    if (!parsed.ok) {
      throw new Error(
        `question set v${version} of "${sourceId}" in the FacetDB store cannot be read: ${parsed.errors.join("; ")}`,
      );
    }
    kept.set(version, parsed.questionSet);
  }
  return kept;
}
