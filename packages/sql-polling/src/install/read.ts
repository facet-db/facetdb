import { type QuestionSet, type Refusal, STATE_HASH_COLUMN } from "@facetdb/core";
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
 * catalog can tell (the migrate note says so). The guess is only for a source whose config leaves
 * `lastChanged` out: a name there is used, or refused, and `false` reads the whole table every hour
 * on purpose.
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

/**
 * The column FacetDB polls by, or none (the hourly full scan). `named`: the config's `lastChanged`
 * names the column, rather than the guess by `LAST_CHANGED_NAMES`. `chosen`: the config says
 * `lastChanged: false`, so the scan is on purpose and nothing warns of it. `nullable` names the
 * column the guess would have used but for its NULLs.
 */
export type LastChanged =
  | { readonly column: string; readonly named?: true }
  | { readonly column?: undefined; readonly chosen?: true; readonly nullable?: string };

/** The refusal's code wherever a named last-changed column cannot be polled by: migrate, prune, open, doctor. */
export const LAST_CHANGED_CODE = "last-changed-column";

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
  /**
   * Why the column the config's `lastChanged` names cannot be polled by (`last-changed-column`):
   * the table lacks it, it holds no time, it may be NULL, or it is FacetDB's own. Install, prune,
   * `open` and doctor refuse on it; `lastChanged` is then `{}`. Undefined otherwise.
   */
  readonly lastChangedRefusal: Refusal | undefined;
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

/**
 * The column the config's `lastChanged` names, as the catalog spells it, or why FacetDB cannot poll
 * by it. The name is matched exactly, else without case when one column alone matches (Oracle keeps
 * an unquoted `changed_on` as `CHANGED_ON`); several such columns are refused by name, and the
 * exact spelling asked for. It must not be FacetDB's own (its writes bump them),
 * and it must hold a point in time and refuse NULL, as the guess's must: a row whose value is NULL
 * is never read again after the worker's first poll.
 */
export function namedLastChanged(
  table: TableRef,
  columns: readonly ColumnFacts[],
  name: string,
  isOwn: (column: string) => boolean,
): { readonly column: string } | { readonly refusal: Refusal } {
  const label = labelOf(table);
  const otherwise = "or write lastChanged: false to read the whole table every hour on purpose";
  const refused = (message: string, fix: string) => ({
    refusal: { code: LAST_CHANGED_CODE, message, fix },
  });
  const anyCase = columns.filter((column) => column.name.toLowerCase() === name.toLowerCase());
  const found =
    columns.find((column) => column.name === name) ??
    (anyCase.length === 1 ? anyCase[0] : undefined);
  const spelled = found?.name ?? name;
  if (isOwn(spelled)) {
    return refused(
      `${spelled}, which lastChanged names, is FacetDB's own column on ${label}, and FacetDB's own writes change it`,
      `name the application's own last-changed column of ${label} in lastChanged, ${otherwise}`,
    );
  }
  if (found === undefined && anyCase.length > 1) {
    // Several columns differ from the name only in case (Postgres keeps quoted names as written):
    // none is picked by guess, and none is said to be missing.
    const candidates = anyCase.map((column) => column.name).join(", ");
    return refused(
      `${label} has no column spelled ${name} exactly, and ${anyCase.length} columns that differ from it only in case (${candidates}), so FacetDB cannot tell which one lastChanged means`,
      `write the column's exact spelling in lastChanged (one of ${candidates}), ${otherwise}`,
    );
  }
  if (found === undefined) {
    return refused(
      `${label} has no column ${name}, which lastChanged names as the column FacetDB polls by`,
      `name a column of ${label} that holds a time, NOT NULL, set by the application on every insert and every update, in lastChanged, ${otherwise}`,
    );
  }
  if (!found.time) {
    return refused(
      `${label}'s ${found.name}, which lastChanged names, holds ${found.type}, not a point in time, so FacetDB cannot tell which rows changed since its last poll`,
      `name a column of ${label} that holds a time (a timestamp or a date), NOT NULL, set by the application on every insert and every update, in lastChanged, ${otherwise}`,
    );
  }
  if (found.nullable) {
    return refused(
      `${label}'s ${found.name}, which lastChanged names, may be NULL, and a row whose ${found.name} is NULL would never be read again`,
      `make ${found.name} NOT NULL and set it on every insert and every update, ${otherwise}`,
    );
  }
  return { column: found.name };
}

/** Reads the table, or undefined when it does not exist. Nothing is changed. */
export async function readTable(
  dialect: SqlDialect,
  query: PollingQuery,
  target: {
    readonly table: string;
    readonly schema?: string;
    readonly questionSet: QuestionSet;
    /** The config's `lastChanged`: a column's name, `false` for the hourly scan, absent for the guess. */
    readonly lastChanged?: string | false;
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
  const setting = target.lastChanged;
  const named =
    typeof setting === "string"
      ? namedLastChanged(
          table,
          facts.columns,
          setting,
          (name) => ownedNames.has(name) || wanted.has(name),
        )
      : undefined;
  let lastChanged: LastChanged;
  if (named !== undefined) {
    lastChanged = "column" in named ? { column: named.column, named: true } : {};
  } else if (setting === false) {
    lastChanged = { chosen: true };
  } else {
    // FacetDB's own columns are never the application's last-changed one: its writes bump them.
    lastChanged = lastChangedOf(facts.columns.filter((column) => !ownedNames.has(column.name)));
  }
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
    lastChanged,
    lastChangedRefusal: named !== undefined && "refusal" in named ? named.refusal : undefined,
  };
}
