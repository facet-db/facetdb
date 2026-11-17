import { type QuestionSet, STATE_HASH_COLUMN } from "@facetdb/core";
import type {
  ColumnFacts,
  PollingQuery,
  SqlDialect,
  TableFacts,
  TableRef,
} from "../dialect/index.ts";
import { isOwnedMark, markedProject, ownedColumnNames } from "./columns.ts";

/**
 * A source's table as polling reads it from the catalog, through the dialect: which columns are
 * FacetDB's (they carry its mark), which ones the application made under FacetDB's names, whether a
 * polling install is there and for which project, the key, and the column FacetDB can poll by.
 */

/**
 * The names an application's last-changed column goes by, compared without case, in the order one
 * is preferred. It must hold a point in time and refuse NULL (a row whose value is NULL is never
 * read again after the worker's first poll), and the application must set it on every insert and
 * every update: one set on insert only stops change detection silently, which nothing in the
 * catalog can tell (the migrate note says so). A config field that names the column, or forces the
 * hourly scan, is not there yet.
 */
export const LAST_CHANGED_NAMES: readonly string[] = [
  "updated_at",
  "updatedat",
  "modified_at",
  "modifiedat",
  "last_modified",
  "lastmodified",
  "last_modified_at",
  "last_updated",
  "lastupdated",
  "last_updated_at",
  "updated_on",
  "modified_on",
];

/** The column FacetDB polls by, or none; `nullable` names the one it would have used but for its NULLs. */
export type LastChanged =
  | { readonly column: string }
  | { readonly column?: undefined; readonly nullable?: string };

export type PollingTable = {
  readonly table: TableRef;
  readonly facts: TableFacts;
  /** FacetDB's own columns on the table, in table order: the ones that carry its mark. */
  readonly owned: readonly string[];
  /** Columns this question set would own that the application made: install refuses them. */
  readonly collisions: readonly string[];
  /** Whether a polling install is there: FacetDB's own `facetdb_state_hash`. */
  readonly installed: boolean;
  /**
   * The project the table's mark names. Undefined without one: not installed, or a polling install
   * from an earlier version, which carries the bare column mark until the next migrate marks it.
   */
  readonly project: string | undefined;
  /** The single-column primary key, or undefined: none, or a composite one. */
  readonly key: string | undefined;
  readonly lastChanged: LastChanged;
};

/** The table a source reads, in the dialect's default schema when the config names none. */
export function tableOf(
  dialect: Pick<SqlDialect, "defaultSchema">,
  target: { readonly table: string; readonly schema?: string },
): TableRef {
  return { schema: target.schema ?? dialect.defaultSchema, name: target.table };
}

/** `schema.table`, as the words name it; the table alone where the dialect has no default schema (Oracle). */
export function labelOf(table: TableRef): string {
  return table.schema === "" ? table.name : `${table.schema}.${table.name}`;
}

/** The column FacetDB can poll by among the table's: the first name of `LAST_CHANGED_NAMES` that fits. */
export function lastChangedOf(columns: readonly ColumnFacts[]): LastChanged {
  const named = LAST_CHANGED_NAMES.flatMap((wanted) =>
    columns.filter((column) => column.time && column.name.toLowerCase() === wanted),
  );
  const usable = named.find((column) => !column.nullable);
  if (usable !== undefined) {
    return { column: usable.name };
  }
  const [nullable] = named;
  return nullable === undefined ? {} : { nullable: nullable.name };
}

/** Reads the table, or undefined when it does not exist. Nothing is changed. */
export async function readTable(
  dialect: SqlDialect,
  query: PollingQuery,
  target: {
    readonly table: string;
    readonly schema?: string;
    readonly questionSet: QuestionSet;
  },
): Promise<PollingTable | undefined> {
  const table = tableOf(dialect, target);
  const facts = await dialect.table(query, table, dialect.login?.name ?? "");
  if (facts === undefined) {
    return undefined;
  }
  const { ownership } = dialect;
  const rows = ownership.kind === "table" ? await ownership.marks(query, table) : undefined;
  const markOf = (column: ColumnFacts): string | null =>
    rows === undefined ? column.comment : (rows.get(column.name) ?? null);
  const owned = facts.columns.filter((column) => isOwnedMark(markOf(column)));
  const ownedNames = new Set(owned.map((column) => column.name));
  const wanted = new Set(ownedColumnNames(target.questionSet));
  const hash = owned.find((column) => column.name === STATE_HASH_COLUMN);
  const [key, ...more] = facts.key;
  return {
    table,
    facts,
    owned: owned.map((column) => column.name),
    collisions: facts.columns
      .filter((column) => wanted.has(column.name) && !ownedNames.has(column.name))
      .map((column) => column.name),
    installed: hash !== undefined,
    project: hash === undefined ? undefined : markedProject(markOf(hash)),
    key: more.length === 0 ? key : undefined,
    // FacetDB's own columns are never the application's last-changed one: its writes bump them.
    lastChanged: lastChangedOf(facts.columns.filter((column) => !ownedNames.has(column.name))),
  };
}
