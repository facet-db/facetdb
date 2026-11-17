import {
  answerColumns,
  type EngineDeps,
  type EngineObject,
  type EnginePlan,
  type EngineTarget,
  type KeptObject,
  type PlanResult,
  type QuestionSet,
} from "@facetdb/core";
import { adminUrlRefusal, type MssqlConnect, quoteName } from "../sql/index.ts";
import {
  readColumns,
  readGrants,
  readKey,
  readMarker,
  readObjects,
  sideTableOf,
  viewOf,
  withAdmin,
} from "./catalog.ts";
import {
  CREATION_COLUMN,
  ownedColumns,
  sourceStatement,
  type TableNames,
  tableNames,
  WORKER_USER,
} from "./objects.ts";
import { answerColumnsOf, viewText } from "./side-table.ts";

/**
 * `facetdb migrate --prune` on SQL Server: a question removed from the set keeps its columns until
 * the operator asks for them to go, so nothing is destroyed silently. This drops the marked columns
 * of questions the set no longer has, and nothing else: never a status column, never a column
 * FacetDB did not mark, never a choice's `_probabilities` column while its question is still asked
 * (`storeProbabilities` went off, not the question). It also takes back the worker's read of a
 * state column `read` no longer lists. In side-table mode the columns are the side table's, and the
 * view is made again without them first. A source not installed yet has nothing to prune: an empty
 * plan, not a refusal.
 */

/** How long a statement waits for a lock, as install waits (`alter table` takes the table's lock). */
const LOCK_TIMEOUT_MS = 10_000;

/** Why a marked column stays although the set no longer owns it: the engine's keep says it. */
export const KEPT_REASON = "storeProbabilities is off";

const NOTHING: EnginePlan = {
  statements: [],
  transactional: true,
  removes: [],
  keeps: [],
  notes: [],
};

/**
 * The marked columns of questions still in the set that the set no longer owns: a choice
 * question's `_probabilities` column after `storeProbabilities` went off.
 */
export function keptColumns(
  marked: readonly string[],
  questionSet: QuestionSet,
): readonly string[] {
  const owned = new Set(ownedColumns(questionSet).map((column) => column.name));
  const probabilities = new Set(
    questionSet.questions.flatMap((question) =>
      question.type === "choice"
        ? answerColumns({ ...question, storeProbabilities: true })
            .filter((column) => column.role === "probabilities")
            .map((column) => column.name)
        : [],
    ),
  );
  return marked.filter((name) => !owned.has(name) && probabilities.has(name));
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

/** A column the prune drops, and why, in the words the CLI prints. */
export type DroppedColumn = { readonly column: string; readonly reason: string };

/**
 * The marked columns the set no longer owns and does not keep, each with why: a column a question
 * still in the set had under another type (its question changed type), or one no question asks.
 */
export function droppedColumns(
  marked: readonly string[],
  questionSet: QuestionSet,
): readonly DroppedColumn[] {
  const owned = new Set(ownedColumns(questionSet).map((column) => column.name));
  const kept = new Set(keptColumns(marked, questionSet));
  const stillAsked = questionSet.questions.map((question) => columnsOfAnyType(question.name));
  return marked
    .filter((name) => !owned.has(name) && !kept.has(name))
    .map((column) => ({
      column,
      reason: stillAsked.some((columns) => columns.has(column))
        ? "its question changed type"
        : "no question asks it any more",
    }));
}

/**
 * Where FacetDB's columns are: on the table (inline), or in its side table, whose every column but
 * the key is FacetDB's. In side-table mode the view names each column, so it is made again without
 * the dropped ones before they go (a view of SQL Server is not bound to its columns, and would fail
 * every read after the drop): `view` makes it from the columns that stay.
 */
type PruneAt = {
  readonly relation: string;
  readonly label: string;
  readonly view?: (stay: readonly string[]) => string;
};

function prunePlan(
  names: TableNames,
  at: PruneAt,
  key: string,
  questionSet: QuestionSet,
  marked: readonly string[],
  selectable: readonly string[],
): EnginePlan {
  const dropped = droppedColumns(marked, questionSet);
  const kept = keptColumns(marked, questionSet);
  const gone = new Set(dropped.map(({ column }) => column));
  // The worker keeps reading the key, the state, FacetDB's columns and the creation marker; a
  // marked column it reads goes with its right when it is dropped.
  const stays = new Set([
    key,
    CREATION_COLUMN,
    ...questionSet.read,
    ...ownedColumns(questionSet).map((column) => column.name),
    ...kept,
    ...marked,
  ]);
  const revoked = selectable.filter((column) => !stays.has(column));
  if (dropped.length === 0 && revoked.length === 0) {
    return { ...NOTHING, keeps: keptObjects(at, kept) };
  }
  return {
    statements: [
      sourceStatement("settings", `set lock_timeout ${LOCK_TIMEOUT_MS}`),
      ...revoked.map((column) =>
        sourceStatement(
          "grants",
          `revoke select (${quoteName(column)}) on ${names.relation} from ${quoteName(WORKER_USER)}`,
        ),
      ),
      ...(at.view === undefined || dropped.length === 0
        ? []
        : [sourceStatement("columns", at.view(marked.filter((column) => !gone.has(column))))]),
      ...dropped.map(({ column }) =>
        sourceStatement(
          "columns",
          `alter table ${at.relation} drop column if exists ${quoteName(column)}`,
        ),
      ),
    ],
    transactional: true,
    removes: [
      ...dropped.map(
        ({ column, reason }): EngineObject => ({
          kind: "column",
          name: column,
          of: at.label,
          scope: "source",
          reason,
        }),
      ),
      ...revoked.map(
        (column): EngineObject => ({
          kind: "grant",
          name: WORKER_USER,
          of: column,
          scope: "source",
          reason: "read no longer lists it",
        }),
      ),
    ],
    keeps: keptObjects(at, kept),
    notes: [],
  };
}

function keptObjects(at: PruneAt, kept: readonly string[]): readonly KeptObject[] {
  return kept.map((name) => ({
    kind: "column",
    name,
    of: at.label,
    scope: "source",
    reason: KEPT_REASON,
  }));
}

export async function planPrune(
  connect: MssqlConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<PlanResult> {
  const insecure = adminUrlRefusal(url, deps.allowInsecure);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  const names = tableNames(target);
  return withAdmin(connect, url, async (query): Promise<PlanResult> => {
    const columns = await readColumns(query, names.schema, names.table);
    if (columns.length === 0) {
      return { ok: true, plan: NOTHING };
    }
    const objects = await readObjects(query, names);
    const marker = await readMarker(query, names, objects);
    const row = marker?.find((one) => one.schema === names.schema && one.table === names.table);
    if (row === undefined) {
      return { ok: true, plan: NOTHING };
    }
    if (row.projectId !== target.project.id) {
      return {
        ok: false,
        refusal: {
          code: "another-project",
          message: `${names.label} belongs to another project (${row.projectId}); prune it from that project`,
          fix: "run facetdb migrate --prune from the project that installed on the table",
        },
      };
    }
    const key = await readKey(query, names.schema, names.table);
    const [keyName] = key;
    if (keyName === undefined || key.length > 1) {
      return {
        ok: false,
        refusal: {
          code: "primary-key",
          message: `${names.label} no longer has a single-column primary key, which FacetDB installed by`,
          fix: "restore the table's single-column primary key, then run facetdb migrate --prune again",
        },
      };
    }
    const reads = new Set(
      (await readGrants(query, names))
        .filter(
          (grant) =>
            grant.schema === names.schema &&
            grant.object === names.table &&
            grant.permission === "SELECT",
        )
        .flatMap((grant) => (grant.column === undefined ? [] : [grant.column])),
    );
    const selectable = columns.filter((column) => reads.has(column.name)).map(({ name }) => name);
    // The mode is what install left, not what the config says now (a marked side table is
    // side-table mode), so a prune never looks for columns where none were put.
    if (sideTableOf(objects, names) !== undefined) {
      const view = viewOf(objects, names);
      const tableColumns = columns.map((column) => column.name);
      const side = answerColumnsOf(
        await readColumns(query, names.schema, names.sideTable),
        keyName,
      ).map((column) => column.name);
      return {
        ok: true,
        plan: prunePlan(
          names,
          {
            relation: names.sideRelation,
            label: names.sideLabel,
            ...(view === undefined
              ? {}
              : { view: (stay) => viewText(names, keyName, tableColumns, stay) }),
          },
          keyName,
          target.questionSet,
          side,
          selectable,
        ),
      };
    }
    return {
      ok: true,
      plan: prunePlan(
        names,
        { relation: names.relation, label: names.label },
        keyName,
        target.questionSet,
        columns.filter((column) => column.marked).map((column) => column.name),
        selectable,
      ),
    };
  });
}
