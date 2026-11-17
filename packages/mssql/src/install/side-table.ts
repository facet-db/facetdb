import { type PlanStatement, REVIEWED_COLUMN, STATUS_COLUMN } from "@facetdb/core";
import { quoteName, quoteString } from "../sql/index.ts";
import { type CatalogColumn, columnType } from "./catalog.ts";
import { COLUMN_MARK, type OwnedColumn, sourceStatement, type TableNames } from "./objects.ts";

/**
 * Side-table mode on SQL Server: the answer and status columns live in `facetdb_<table>_answers`,
 * keyed by the table's primary key, and the view `<table>_with_answers` beside the table joins the
 * two. The application's table gains no column; its change capture is the same trigger, which sets
 * the side row's status instead of the row's (`trigger.ts`). This module owns the side table's and
 * the view's SQL; the install, prune and uninstall plans compose it.
 *
 * The side table's key is the table's key in its own type and collation, so the two join on the
 * primary key's seek, and it references the table `on delete cascade on update cascade`: an
 * application delete takes the record's answers with it (a key inserted again starts fresh, as it
 * would inline: the Postgres side table's rule), and a key the application changes keeps them,
 * where `no action` would fail the application's update. The cost, which the plan's notes say: a
 * table a foreign key references cannot be truncated (error 4712) or dropped (error 3726) until
 * uninstall takes the side table away. SQL Server takes no foreign key between a memory-optimized
 * table and a disk-based one; install refuses a memory-optimized table in this mode (it could not
 * carry the trigger either: it takes only natively compiled ones).
 *
 * Both objects carry FacetDB's extended property, as its columns do inline: a later install adopts
 * them, uninstall drops them, and an object of either name without it is refused, never replaced.
 */

/**
 * The side table's columns as the view reads them, with the value of a record that has no side row
 * yet (one the trigger never saw: a row the table held before the install): pending and not
 * reviewed, as inline mode reads its NULLs.
 */
const VIEW_DEFAULTS: Readonly<Record<string, string>> = {
  [STATUS_COLUMN]: "'pending'",
  [REVIEWED_COLUMN]: "cast(0 as bit)",
};

/**
 * The side table's primary key and foreign key, named under FacetDB's prefix as every object it
 * adds (a constraint is an object of the schema, so its name counts toward the 128 characters;
 * install refuses a table whose side table leaves no room for the suffix).
 */
export function sideConstraints(names: TableNames): {
  readonly primaryKey: string;
  readonly foreignKey: string;
} {
  return { primaryKey: `${names.sideTable}_pkey`, foreignKey: `${names.sideTable}_fkey` };
}

/** The longest suffix a side-table object adds to the side table's name: `_pkey`, `_fkey`. */
export const CONSTRAINT_SUFFIX_LENGTH = "_pkey".length;

/** The key column's type as the side table repeats it: the type, and a text key's collation. */
export function sideKeyType(key: CatalogColumn): string {
  const type = columnType(key);
  return key.collation === null ? type : `${type} collate ${key.collation}`;
}

/**
 * The side table, when the database has none: the key, every column of the question set as inline
 * mode would add it to the table (the same types, nullable), the foreign key, and the mark, in one
 * guarded statement. A text key carries the table key's collation: a foreign key needs it equal.
 */
export function sideTableStatement(
  names: TableNames,
  key: CatalogColumn,
  owned: readonly OwnedColumn[],
): PlanStatement {
  const id = quoteName(key.name);
  const { primaryKey, foreignKey } = sideConstraints(names);
  return sourceStatement(
    "columns",
    `if object_id(${quoteString(names.sideRelation)}, N'U') is null
begin
  create table ${names.sideRelation} (
    ${id} ${sideKeyType(key)} not null constraint ${quoteName(primaryKey)} primary key,
${owned.map((column) => `    ${quoteName(column.name)} ${column.type} null,`).join("\n")}
    constraint ${quoteName(foreignKey)} foreign key (${id}) references ${names.relation} (${id})
      on delete cascade on update cascade
  );
  exec sys.sp_addextendedproperty @name = ${quoteString(COLUMN_MARK)}, @value = ${quoteString(COLUMN_MARK)},
    @level0type = N'SCHEMA', @level0name = ${quoteString(names.schema)},
    @level1type = N'TABLE', @level1name = ${quoteString(names.sideTable)};
end`,
  );
}

/** A column a question added later: the side table is FacetDB's whole, so no column of it is marked. */
export function sideColumnStatement(names: TableNames, column: OwnedColumn): PlanStatement {
  return sourceStatement(
    "columns",
    `if col_length(${quoteString(names.sideRelation)}, ${quoteString(column.name)}) is null
  alter table ${names.sideRelation} add ${quoteName(column.name)} ${column.type} null`,
  );
}

/**
 * The view: every column of the table, in the table's order and by name, then every column of the
 * side table but the key, a record without a side row reading as pending and not reviewed. A view
 * of SQL Server keeps the column list it was made with (`select t.*` would not show a column the
 * application adds later until `sp_refreshview`), so the columns are named, and the next `facetdb
 * migrate` makes the view again when the table's columns changed. The side table's columns include
 * those of a question removed from the set, which keep their answers until `migrate --prune`: the
 * view goes on showing what the side table holds.
 *
 * Not `with schemabinding`: a bound view would refuse the application's own `alter table` on a
 * column it reads, and side-table mode is for tables whose schema an ORM manages. A view reader
 * needs `select` on the view alone: the view, the table and the side table share an owner (the
 * schema's), so SQL Server's ownership chaining checks no right on the two tables, and a reader
 * granted after the install reads it. A row-level security policy on the table still filters what
 * the reader sees: the view reads the table as the reader.
 *
 * `create or alter view` (SQL Server 2016 Service Pack 1 and later; install refuses an older
 * build) keeps the grants and the mark of a view that is there, where a drop would lose the
 * application's grants on it. It begins its batch, as `render` puts every statement in its own.
 */
export function viewText(
  names: TableNames,
  key: string,
  tableColumns: readonly string[],
  sideColumns: readonly string[],
): string {
  const id = quoteName(key);
  const answers = sideColumns.map((name) => {
    const fallback = VIEW_DEFAULTS[name];
    const column = `a.${quoteName(name)}`;
    return fallback === undefined
      ? column
      : `coalesce(${column}, ${fallback}) as ${quoteName(name)}`;
  });
  const selected = [...tableColumns.map((name) => `t.${quoteName(name)}`), ...answers];
  return `create or alter view ${names.viewRelation}
as
select ${selected.join(",\n       ")}
  from ${names.relation} t
  left join ${names.sideRelation} a on a.${id} = t.${id}`;
}

/** The view's mark, once it is made: `create view` must be alone in its batch, so it follows. */
export function viewMarkStatement(names: TableNames): PlanStatement {
  return sourceStatement(
    "columns",
    `if not exists (select 1 from sys.extended_properties where class = 1 and minor_id = 0
                 and major_id = object_id(${quoteString(names.viewRelation)}) and name = ${quoteString(COLUMN_MARK)})
  exec sys.sp_addextendedproperty @name = ${quoteString(COLUMN_MARK)}, @value = ${quoteString(COLUMN_MARK)},
    @level0type = N'SCHEMA', @level0name = ${quoteString(names.schema)},
    @level1type = N'VIEW', @level1name = ${quoteString(names.view)}`,
  );
}

/**
 * Whether a view's stored text is this one. SQL Server keeps the text it was made with, but writes
 * `create or alter view` back as `create   view` (proven on SQL Server 2022), so the words before
 * the name are set aside; line breaks, blank lines and the script's `;` as `sameTrigger` reads them.
 */
export function sameView(stored: string, wanted: string): boolean {
  const body = (text: string) =>
    text
      .replaceAll("\r\n", "\n")
      .trim()
      .replace(/;$/, "")
      .trimEnd()
      .replace(/^create\s+(or\s+alter\s+)?view\s+/i, "");
  return body(stored) === body(wanted);
}

/** The side table's columns but its key, in the table's order: what FacetDB keeps there. */
export function answerColumnsOf(
  sideColumns: readonly CatalogColumn[],
  key: string,
): readonly CatalogColumn[] {
  return sideColumns.filter((column) => column.name !== key);
}

/**
 * What a side table means for the application's own statements on its table: everything SQL Server
 * refuses on a table a foreign key references, among it what an ORM's migration does when it
 * rebuilds a table (Prisma and EF Core drop and create it again for some changes), the case
 * side-table mode is pitched at.
 */
export function foreignKeyNote(names: TableNames): string {
  return `${names.label} gains no column: its answers go in ${names.sideLabel}, whose foreign key references ${names.label}, so deleting a row there deletes its answers; until facetdb uninstall removes ${names.sideLabel}, SQL Server refuses truncate table ${names.label} (error 4712), dropping the table (error 3726), switching a partition in or out of it (error 4967) and changing its primary key, such as an int key made bigint (error 3725), and so an ORM migration that rebuilds the table (drops it and creates it again, as Prisma does for some changes) fails; uninstall before such a migration, then run facetdb migrate again`;
}

/**
 * Where an application reads the answers, and who may: ownership chaining serves a reader with
 * select on the view alone only while the view, the table and the side table have one owner, the
 * schema's; a table given an owner of its own breaks the chain at the table.
 */
export function viewNote(names: TableNames): string {
  return `read the answers through the view ${names.viewLabel} (every column of ${names.label}, then FacetDB's): a login granted select on the view alone reads it while the view, ${names.label} and ${names.sideLabel} share an owner, as they do when the table has none of its own; if ${names.label} was given an owner other than its schema's, a reader also needs select on ${names.label}; a record without an answer yet reads ${STATUS_COLUMN} 'pending'`;
}
