import { answerColumns, type QuestionSet } from "@facetdb/core";
import { ownedColumnNames } from "./columns.ts";

/**
 * Which of FacetDB's columns `migrate --prune` drops, keeps and stops reading, in the words the
 * Postgres trigger engine's prune gives them: a removed question's columns go, a choice's
 * probabilities stay when only their storing was turned off, and the worker stops reading a state
 * field `read` no longer lists. Never a status column, never a column FacetDB did not mark.
 */

/** Why a marked column stays although the set no longer owns it. */
export const KEPT_REASON = "storeProbabilities is off";

/** A column the prune drops, and why, in words the CLI prints as they are. */
export type DroppedColumn = { readonly column: string; readonly reason: string };

/**
 * The marked columns of questions still in the set that the set no longer owns: a choice
 * question's `_probabilities` after `storeProbabilities` went off. The operator turned off the
 * storing, not the question, so the column and what it holds stay.
 */
export function keptColumns(owned: readonly string[], questionSet: QuestionSet): readonly string[] {
  const current = new Set(ownedColumnNames(questionSet));
  const probabilities = new Set(
    questionSet.questions.flatMap((question) =>
      question.type === "choice"
        ? answerColumns({ ...question, storeProbabilities: true })
            .filter((column) => column.role === "probabilities")
            .map((column) => column.name)
        : [],
    ),
  );
  return owned.filter((name) => !current.has(name) && probabilities.has(name));
}

/** Every column a question of this name could have, whatever its type. */
function columnsOfAnyType(name: string): ReadonlySet<string> {
  const base = { name, instructions: "", stakes: "low" } as const;
  return new Set(
    [
      answerColumns({ ...base, type: "noul" }),
      answerColumns({ ...base, type: "choice", options: [], storeProbabilities: true }),
      answerColumns({ ...base, type: "score", levels: [] }),
    ].flatMap((columns) => columns.map((column) => column.name)),
  );
}

/** The marked columns of questions no longer in the set, with why each goes. */
export function droppedColumns(
  owned: readonly string[],
  questionSet: QuestionSet,
): readonly DroppedColumn[] {
  const current = new Set(ownedColumnNames(questionSet));
  const kept = new Set(keptColumns(owned, questionSet));
  const stillAsked = questionSet.questions.map((question) => columnsOfAnyType(question.name));
  return owned
    .filter((name) => !current.has(name) && !kept.has(name))
    .map((column) => ({
      column,
      reason: stillAsked.some((columns) => columns.has(column))
        ? "its question changed type"
        : "no question asks it any more",
    }));
}

/**
 * The columns the worker may still read that the set no longer needs: a state field removed from
 * `read`. The key, the state fields, FacetDB's own columns, the kept ones and the column FacetDB
 * polls by stay readable.
 */
export function revokedColumns(
  workerSelect: readonly string[],
  needed: {
    readonly key: string;
    readonly lastChanged: string | undefined;
    readonly owned: readonly string[];
    readonly questionSet: QuestionSet;
  },
): readonly string[] {
  const { questionSet } = needed;
  const kept = new Set([
    needed.key,
    ...questionSet.read,
    ...ownedColumnNames(questionSet),
    ...keptColumns(needed.owned, questionSet),
    ...(needed.lastChanged === undefined ? [] : [needed.lastChanged]),
  ]);
  return workerSelect.filter((name) => !kept.has(name));
}
