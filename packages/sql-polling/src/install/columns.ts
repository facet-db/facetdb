import {
  answerColumns,
  OWNED_MARK,
  PROJECT_MARK_PREFIX,
  type QuestionSet,
  REVIEWED_COLUMN,
  STATE_HASH_COLUMN,
  STATUS_COLUMN,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import type { SqlDialect } from "../dialect/index.ts";

/**
 * What a polling install adds to the source's table: the answer and status columns plus core's
 * `STATE_HASH_COLUMN`, no trigger and no jobs table, each column marked with core's `OWNED_MARK` (a
 * comment where the database has them, the dialect's table of marks otherwise), and the table's
 * project on the state-hash column. The mark is how a later install tells FacetDB's own columns
 * from the application's; uninstall and prune drop marked columns only.
 */

/**
 * The table's own mark, on `facetdb_state_hash` in place of the bare column mark: the project that
 * installed the table, so uninstall asks that project's name back and another project's install is
 * refused; the trigger install reads it too and refuses the table. A polling table installed by an
 * earlier version has the bare mark there; the next migrate writes this one.
 */
export function projectMark(projectId: string): string {
  return `${PROJECT_MARK_PREFIX}${projectId}`;
}

/** Whether a column's mark is FacetDB's: the column mark, or the project mark it carries on the state hash. */
export function isOwnedMark(mark: string | null): boolean {
  return mark !== null && (mark === OWNED_MARK || mark.startsWith(PROJECT_MARK_PREFIX));
}

/** The project a mark names, or undefined for the bare column mark (and for anything else). */
export function markedProject(mark: string | null): string | undefined {
  return mark?.startsWith(PROJECT_MARK_PREFIX) === true
    ? mark.slice(PROJECT_MARK_PREFIX.length)
    : undefined;
}

/** Every column FacetDB owns on the table under this question set, answers first, in install order. */
export function ownedColumnNames(questionSet: QuestionSet): readonly string[] {
  return [
    ...questionSet.questions.flatMap((question) => answerColumns(question).map(({ name }) => name)),
    STATUS_COLUMN,
    UPDATED_AT_COLUMN,
    REVIEWED_COLUMN,
    STATE_HASH_COLUMN,
  ];
}

/** The owned columns with their definitions in the dialect's types, in install order. */
export function ownedColumns(
  dialect: SqlDialect,
  questionSet: QuestionSet,
): readonly (readonly [name: string, definition: string])[] {
  const { types } = dialect;
  return [
    ...questionSet.questions.flatMap((question) =>
      answerColumns(question).map(({ name, kind }): readonly [string, string] => [
        name,
        types[kind],
      ]),
    ),
    [STATUS_COLUMN, types.text],
    [UPDATED_AT_COLUMN, types.timestamp],
    [REVIEWED_COLUMN, `${types.boolean} default ${dialect.falseValue}`],
    [STATE_HASH_COLUMN, types.hash],
  ];
}
