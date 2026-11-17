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
import {
  adminUrlRefusal,
  type MysqlConnect,
  quoteIdent,
  quoteTable,
  withClient,
} from "../sql/index.ts";
import {
  droppedColumnsNote,
  isMariaDb,
  readCatalog,
  readSession,
  readViews,
  readWorkerRights,
  rightsOn,
  workerExists,
} from "./catalog.ts";
import { noDatabaseRefusal, pruneRefused } from "./refusals.ts";
import {
  createViewStatement,
  readSideCatalog,
  sideTableIsOurs,
  sideTableName,
  viewIsOurs,
} from "./side-table.ts";
import {
  OWNED_MARK,
  ownedColumns,
  revokeStatement,
  SETTINGS,
  sourceStatement,
  WORKER_ACCOUNT,
} from "./sql.ts";

/**
 * `facetdb migrate --prune` on MySQL and MariaDB: a question removed from the set keeps its columns
 * until the operator asks for them to go, so nothing is destroyed silently. This drops the marked
 * columns of questions the set no longer has, never a status column and never a `_probabilities`
 * column of a question still asked, and takes back the worker's read of a state column `read` no
 * longer lists. In side-table mode the columns are the side table's, and the view that reads them
 * is made again without them first. A source not installed yet has nothing to prune: an empty plan,
 * not a refusal.
 */

/** The plan's note for a run that stops part way. */
export const PRUNE_RERUN_NOTE =
  "MySQL runs these statements one by one, with no transaction around them: if one fails, the ones before it stay done, and running facetdb migrate --prune again completes it.";

/** Why a marked column stays although the set no longer owns it, in Postgres's words. */
export const KEPT_REASON = "storeProbabilities is off";

const NOTHING: EnginePlan = {
  statements: [],
  transactional: false,
  removes: [],
  keeps: [],
  notes: [],
};

/**
 * The marked columns of questions still in the set that the set no longer owns: a choice question's
 * `_probabilities` column after `storeProbabilities` went off. The operator turned off the storing,
 * not the question, so the column and what it holds stay.
 */
function keptColumns(questionSet: QuestionSet, marked: readonly string[]): readonly string[] {
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

/** The marked columns that go, each with why, in table order. */
function droppedColumns(
  questionSet: QuestionSet,
  marked: readonly string[],
): readonly { readonly column: string; readonly reason: string }[] {
  const owned = new Set(ownedColumns(questionSet).map((column) => column.name));
  const kept = new Set(keptColumns(questionSet, marked));
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

export async function planPrune(
  connect: MysqlConnect,
  target: EngineTarget,
  url: string,
  deps: EngineDeps,
): Promise<PlanResult> {
  const insecure = adminUrlRefusal(url, deps.allowInsecure);
  if (insecure !== undefined) {
    return { ok: false, refusal: insecure };
  }
  return withClient(connect, url, async (query): Promise<PlanResult> => {
    const session = await readSession(query);
    const schema = target.schema ?? session.database;
    if (schema === undefined) {
      return { ok: false, refusal: noDatabaseRefusal(target) };
    }
    const catalog = await readCatalog(query, schema, target.table);
    const { table } = target;
    const label = `${schema}.${table}`;
    const owner = catalog.owners.find((row) => row.table === table);
    if (catalog.tableType === undefined || owner === undefined) {
      return { ok: true, plan: NOTHING };
    }
    if (owner.projectId !== target.project.id) {
      return {
        ok: false,
        refusal: pruneRefused(
          `${label} belongs to another project (${owner.projectId}); prune it from that project.`,
        ),
      };
    }
    const [key, ...rest] = catalog.primaryKey;
    if (key === undefined || rest.length > 0) {
      return {
        ok: false,
        refusal: pruneRefused(
          `${label} no longer has a single-column primary key, which FacetDB installed by; restore it first.`,
        ),
      };
    }
    const { questionSet } = target;
    // Where FacetDB's columns are: the table inline, the side table in side-table mode, whose view
    // reads them by name.
    const side =
      target.storage === "side-table"
        ? await readSideCatalog(query, schema, table, isMariaDb(session))
        : undefined;
    const holder = side === undefined ? table : sideTableName(table);
    const holderLabel = `${schema}.${holder}`;
    const holderColumns =
      side === undefined ? catalog.columns : sideTableIsOurs(side) ? side.side.columns : [];
    const marked = holderColumns
      .filter((column) => column.comment === OWNED_MARK && column.name !== key)
      .map((column) => column.name);
    const dropped = droppedColumns(questionSet, marked);
    const kept = keptColumns(questionSet, marked);
    const droppedNames = new Set(dropped.map(({ column }) => column));
    // The worker keeps its read of the key, the state, FacetDB's columns and a kept column; a
    // column that goes loses every right first, since MySQL keeps a dropped column's grants.
    const stays = new Set([
      key,
      ...questionSet.read,
      ...ownedColumns(questionSet).map((column) => column.name),
      ...kept,
    ]);
    const held = (await workerExists(query))
      ? rightsOn(
          await readWorkerRights(query, schema),
          table,
          new Set(catalog.columns.map((column) => column.name)),
        )
      : [];
    const taken = held.filter(
      ({ column, privilege }) =>
        column !== undefined &&
        (droppedNames.has(column) || (privilege === "SELECT" && !stays.has(column))),
    );
    const revoke = revokeStatement(schema, table, taken);
    const unread = [
      ...new Set(
        taken.flatMap(({ column }) =>
          column === undefined || droppedNames.has(column) ? [] : [column],
        ),
      ),
    ];
    if (revoke === undefined && dropped.length === 0) {
      return {
        ok: true,
        plan: {
          ...NOTHING,
          keeps: kept.map(
            (name): KeptObject => ({
              kind: "column",
              name,
              of: holderLabel,
              scope: "source",
              reason: KEPT_REASON,
            }),
          ),
        },
      };
    }
    // Inline, the application's views may read a dropped column, and the note names them. The
    // side table is read by FacetDB's own view, made again first without the columns that go, from
    // what stays on the side table (the install that follows the prune adds a new question's).
    const viewsNote =
      dropped.length === 0 || side !== undefined
        ? undefined
        : droppedColumnsNote(label, await readViews(query, schema, table));
    const remade =
      side !== undefined &&
      viewIsOurs(side) &&
      side.view.columns.some((column) => droppedNames.has(column))
        ? [
            createViewStatement(
              schema,
              table,
              key,
              marked.filter((column) => !droppedNames.has(column)),
            ),
          ]
        : [];
    return {
      ok: true,
      plan: {
        statements: [
          SETTINGS,
          ...(revoke === undefined ? [] : [revoke]),
          ...remade,
          // In one statement: MySQL and MariaDB drop a column a view reads without a word, and the
          // view fails with error 1356 afterwards, which the note says.
          ...(dropped.length === 0
            ? []
            : [
                sourceStatement(
                  "columns",
                  `alter table ${quoteTable(schema, holder)}\n${dropped.map(({ column }) => `  drop column ${quoteIdent(column)}`).join(",\n")}`,
                ),
              ]),
        ],
        transactional: false,
        removes: [
          ...dropped.map(
            ({ column, reason }): EngineObject => ({
              kind: "column",
              name: column,
              of: holderLabel,
              scope: "source",
              reason,
            }),
          ),
          ...unread.map(
            (column): EngineObject => ({
              kind: "grant",
              name: WORKER_ACCOUNT,
              of: column,
              scope: "source",
              reason: "read no longer lists it",
            }),
          ),
        ],
        keeps: kept.map(
          (name): KeptObject => ({
            kind: "column",
            name,
            of: holderLabel,
            scope: "source",
            reason: KEPT_REASON,
          }),
        ),
        notes: [PRUNE_RERUN_NOTE, ...(viewsNote === undefined ? [] : [viewsNote])],
      },
    };
  });
}
