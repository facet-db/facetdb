import { OWNED_MARK, type PlanStatement, type QuestionSet, STATE_HASH_COLUMN } from "@facetdb/core";
import type { LoginRule, SqlDialect, TableRef } from "../dialect/index.ts";
import { ownedColumns, projectMark } from "./columns.ts";

/**
 * The statements of a polling install, uninstall and prune, from what the catalog showed: pure text
 * in the dialect's SQL, every identifier quoted and every value a literal, as a plan prints and
 * runs them. Every statement serves the source's own database: polling never touches the store.
 */

/** A statement of a polling plan; its database is always the source's. */
export type Statement = Omit<PlanStatement, "database">;

const of =
  (purpose: Statement["purpose"]) =>
  (text: string): Statement => ({ purpose, text });

/**
 * What a plan with statements starts with: the dialect's settings (Postgres's lock timeout, as the
 * trigger scripts have it) and the table's lock, after which `run` reads the mark again. The lock
 * is a setting the statements after it rely on, as the contract's purposes name one, so a run
 * stopped by its lock timeout says "(settings)". Prefixed to a plan's own statements only when it
 * has some: a plan with nothing to do stays empty.
 */
export function withHeader(
  dialect: SqlDialect,
  table: TableRef,
  statements: readonly Statement[],
): readonly Statement[] {
  return statements.length === 0
    ? []
    : [
        ...dialect.header.map(of("settings")),
        ...(dialect.lock === undefined ? [] : [of("settings")(dialect.lock(table))]),
        ...statements,
      ];
}

/** The statements that leave `text` as the mark of `column`: its comment, or its row. */
function markColumn(dialect: SqlDialect, table: TableRef, column: string, text: string) {
  const { ownership } = dialect;
  return ownership.kind === "comment"
    ? [ownership.commentOn(table, column, text)]
    : ownership.markColumn(table, column, text);
}

/**
 * The answer and status columns and the state hash, each marked as FacetDB's: all of them in one
 * statement where the dialect adds a column only if it is missing, the missing ones (`present` is
 * what the catalog shows) otherwise. A dialect without transactional DDL marks each column right
 * after adding it, so a run that stops never leaves a column of FacetDB's unmarked, which the next
 * install would refuse as the application's; with transactional DDL a stop leaves nothing.
 */
export function columnStatements(
  dialect: SqlDialect,
  table: TableRef,
  questionSet: QuestionSet,
  present: ReadonlySet<string>,
): readonly Statement[] {
  const columns = ownedColumns(dialect, questionSet);
  const missing = (name: string) => dialect.addColumn === "if-not-exists" || !present.has(name);
  const mark = (name: string) => markColumn(dialect, table, name, OWNED_MARK).map(of("columns"));
  const { ownership } = dialect;
  // Where the marks are rows, their table is made first, before anything needs marking.
  const marksTable = ownership.kind === "table" ? ownership.create().map(of("marker")) : [];
  if (dialect.transactionalDdl) {
    const adding = columns.filter(([name]) => missing(name));
    return [
      ...marksTable,
      ...(adding.length === 0 ? [] : dialect.addColumns(table, adding).map(of("columns"))),
      ...columns.flatMap(([name]) => mark(name)),
    ];
  }
  return [
    ...marksTable,
    ...columns.flatMap((column) => [
      ...(missing(column[0]) ? dialect.addColumns(table, [column]).map(of("columns")) : []),
      ...mark(column[0]),
    ]),
  ];
}

/**
 * Everything an install puts on the table: the columns, each marked, and the table's project mark.
 * A dialect with transactional DDL or a lock gets `columnStatements` then `markStatements`. One
 * with `atomic` groups (CockroachDB: no lock, DDL committing statement by statement) claims the
 * table first: `facetdb_state_hash` added with the project's mark in one group that fails when the
 * column exists (or the mark alone on a table that has it), then each other column in a group
 * with its own mark, so neither a second project's install nor a run stopped half-way can leave a
 * table carrying FacetDB columns that no mark explains.
 */
export function installStatements(
  dialect: SqlDialect,
  table: TableRef,
  questionSet: QuestionSet,
  present: ReadonlySet<string>,
  projectId: string,
): readonly Statement[] {
  const { atomic } = dialect;
  if (atomic === undefined || dialect.transactionalDdl || dialect.lock !== undefined) {
    return [
      ...columnStatements(dialect, table, questionSet, present),
      ...markStatements(dialect, table, projectId),
    ];
  }
  const columns = ownedColumns(dialect, questionSet);
  const claimMark = markColumn(dialect, table, STATE_HASH_COLUMN, projectMark(projectId));
  const hash = columns.find(([name]) => name === STATE_HASH_COLUMN);
  const claim =
    present.has(STATE_HASH_COLUMN) || hash === undefined
      ? claimMark
      : [atomic.group([atomic.addStrict(table, hash[0], hash[1]), ...claimMark])];
  return [
    ...claim.map(of("marker")),
    ...columns
      .filter(([name]) => name !== STATE_HASH_COLUMN)
      .flatMap(([name, definition]) =>
        present.has(name)
          ? markColumn(dialect, table, name, OWNED_MARK)
          : [
              atomic.group([
                ...dialect.addColumns(table, [[name, definition]]),
                ...markColumn(dialect, table, name, OWNED_MARK),
              ]),
            ],
      )
      .map(of("columns")),
  ];
}

/** The table's mark: the project that installed it, on `facetdb_state_hash`. */
export function markStatements(
  dialect: SqlDialect,
  table: TableRef,
  projectId: string,
): readonly Statement[] {
  return markColumn(dialect, table, STATE_HASH_COLUMN, projectMark(projectId)).map(of("marker"));
}

/**
 * The worker login, created by the install that finds it missing: the password's statement, printed
 * as a comment and bound by `run`, then the creation. An existing login keeps its password.
 */
export function loginStatements(login: LoginRule): readonly Statement[] {
  return [
    { purpose: "login", text: login.secretText, secret: true },
    ...login.create().map(of("login")),
  ];
}

/** The worker's least rights on the table: read the key, the state and its own columns; write its own. */
export function grantStatements(
  login: LoginRule,
  table: TableRef,
  select: readonly string[],
  update: readonly string[],
): readonly Statement[] {
  return login.grants(table, select, update).map(of("grants"));
}

/**
 * What uninstall removes from the table: the worker's rights on it (its policies first), then
 * FacetDB's marked columns, which takes their comments and the table's mark with them; a dialect
 * that keeps its marks in a table deletes the table's rows there.
 */
export function uninstallStatements(
  dialect: SqlDialect,
  table: TableRef,
  owned: readonly string[],
  rights: { readonly login: LoginRule; readonly policies: readonly string[] } | undefined,
): readonly Statement[] {
  const { ownership } = dialect;
  return [
    ...(rights === undefined ? [] : rights.login.revoke(table, rights.policies).map(of("grants"))),
    ...(owned.length === 0 ? [] : dialect.dropColumns(table, owned).map(of("columns"))),
    ...(ownership.kind === "table" ? ownership.unmarkTable(table).map(of("marker")) : []),
  ];
}

/**
 * What `migrate --prune` removes: the dropped columns (and their marks' rows, where the dialect
 * keeps its marks in a table: a comment goes with its column), and the worker's read of the
 * revoked ones.
 */
export function pruneStatements(
  dialect: SqlDialect,
  table: TableRef,
  dropped: readonly string[],
  revoked: { readonly login: LoginRule; readonly columns: readonly string[] } | undefined,
): readonly Statement[] {
  const { ownership } = dialect;
  return [
    ...(dropped.length === 0
      ? []
      : [
          ...dialect.dropColumns(table, dropped).map(of("columns")),
          ...(ownership.kind === "table"
            ? ownership.unmarkColumns(table, dropped).map(of("marker"))
            : []),
        ]),
    ...(revoked === undefined || revoked.columns.length === 0
      ? []
      : revoked.login.revokeSelect(table, revoked.columns).map(of("grants"))),
  ];
}
