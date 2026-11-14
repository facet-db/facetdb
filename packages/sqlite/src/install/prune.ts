import {
  answerColumns,
  type EngineObject,
  type EngineTarget,
  type KeptObject,
  type PlanResult,
  type QuestionSet,
} from "@facetdb/core";
import {
  blockedMessage,
  dropBlockers,
  readInstalled,
  type SqliteQuery,
  sameName,
} from "./catalog.ts";
import { NOTHING, refused } from "./plan.ts";
import { dropColumnStatement, ownedColumns } from "./sql.ts";

/**
 * `facetdb migrate --prune` on a SQLite file: a question removed from the set keeps its columns
 * until the operator asks for them to go, so nothing is destroyed silently. This drops the answer
 * columns of those questions, and nothing else: never a status column, never a column without
 * FacetDB's mark (an application's column of the same name, rebuilt or added again, stays), never
 * one an application's index, view or trigger uses (refused, naming it, before anything runs).
 * SQLite has no grants, so a state field that left `read` has nothing to revoke: install's
 * triggers, planned again, stop watching it.
 */

/** Why a marked column stays although the set no longer owns it (Postgres's words). */
export const KEPT_REASON = "storeProbabilities is off";

const has = (names: readonly string[], name: string) => names.some((one) => sameName(one, name));

/**
 * The marked columns of questions still in the set that the set no longer owns: a choice
 * question's `_probabilities` after `storeProbabilities` went off. The operator turned off the
 * storing, not the question, so the column and what it holds stay.
 */
function keptColumns(questionSet: QuestionSet, marked: readonly string[]): readonly string[] {
  const owned = ownedColumns(questionSet).map(([name]) => name);
  const probabilities = questionSet.questions.flatMap((question) =>
    question.type === "choice"
      ? answerColumns({ ...question, storeProbabilities: true })
          .filter((column) => column.role === "probabilities")
          .map((column) => column.name)
      : [],
  );
  return marked.filter((name) => !has(owned, name) && has(probabilities, name));
}

/** Every column a question of this name could have, whatever its type. */
function columnsOfAnyType(name: string): readonly string[] {
  const base = { name, instructions: "", stakes: "low" } as const;
  return [
    answerColumns({ ...base, type: "noul" }),
    answerColumns({ ...base, type: "choice", options: [], storeProbabilities: true }),
    answerColumns({ ...base, type: "score", levels: [] }),
  ].flatMap((columns) => columns.map((column) => column.name));
}

/**
 * The marked columns the set no longer owns and does not keep, each with why: a column a question
 * still in the set had under another type, or one no question asks about any more.
 */
function droppedColumns(
  questionSet: QuestionSet,
  marked: readonly string[],
): readonly { readonly column: string; readonly reason: string }[] {
  const owned = ownedColumns(questionSet).map(([name]) => name);
  const kept = keptColumns(questionSet, marked);
  const stillAsked = questionSet.questions.map((question) => columnsOfAnyType(question.name));
  return marked
    .filter((name) => !has(owned, name) && !has(kept, name))
    .map((column) => ({
      column,
      reason: stillAsked.some((columns) => has(columns, column))
        ? "its question changed type"
        : "no question asks it any more",
    }));
}

export async function planPrune(target: EngineTarget, query: SqliteQuery): Promise<PlanResult> {
  const installed = await readInstalled(query, target.table);
  if ("reason" in installed) {
    // A source not installed yet has nothing to prune: an empty plan, not a refusal.
    return { ok: true, plan: NOTHING };
  }
  const { table, owner, marked } = installed;
  if (owner !== target.project.id) {
    return refused(
      "prune-refused",
      `${table.name} belongs to another project (${owner}); prune it from that project.`,
    );
  }
  const dropped = droppedColumns(target.questionSet, marked);
  const columns = dropped.map(({ column }) => column);
  const blockers = await dropBlockers(query, table, columns, []);
  if (blockers.length > 0) {
    return refused("prune-refused", blockedMessage(table.name, blockers, "migrate --prune"));
  }
  return {
    ok: true,
    plan: {
      // Each column's mark goes with it: nothing else records it.
      statements: columns.map((column) => dropColumnStatement(table.name, column)),
      transactional: true,
      removes: dropped.map(
        ({ column, reason }): EngineObject => ({
          kind: "column",
          name: column,
          of: table.name,
          scope: "source",
          reason,
        }),
      ),
      keeps: keptColumns(target.questionSet, marked).map(
        (name): KeptObject => ({
          kind: "column",
          name,
          of: table.name,
          scope: "source",
          reason: KEPT_REASON,
        }),
      ),
      notes: [],
    },
  };
}
