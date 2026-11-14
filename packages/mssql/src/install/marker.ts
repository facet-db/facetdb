import type { EngineTarget, PlanStatement } from "@facetdb/core";
import { quoteString } from "../sql/index.ts";
import { sourceStatement, type TableNames } from "./objects.ts";

/** The project that owns an install, as the target names it. */
type ProjectRef = EngineTarget["project"];

/**
 * The project marker: `dbo.facetdb_table_owners`, one per database, records which project installed
 * on which table; one table belongs to one project. Install claims the table's row and then checks
 * it in the script itself, so the printed script, run by hand after another project claimed the
 * table, stops there and changes nothing (the Postgres script's owner check).
 */

/** The error number the scripts' own checks raise with (`throw 51000, …`; 50000 and up are a user's). */
export const SCRIPT_ERROR = 51000;

/** How the scripts' own errors begin their messages, so `run` tells them from the server's. */
export const SCRIPT_PREFIX = "FacetDB: ";

/** The refusal when another project claimed the table first, in the Postgres engine's words. */
export function anotherProject(table: string, owner: string): string {
  return `${table} already carries FacetDB columns from another project (${owner}); one table belongs to one project. Uninstall there first, or point this project at another table.`;
}

/**
 * The project a message of `anotherProject` names for this table, or undefined when the message is
 * any other: `run` reads the script's own owner check by it, never by a guess at the words.
 */
export function anotherProjectOwner(table: string, message: string): string | undefined {
  const marker = "\u0000";
  const template = anotherProject(table, marker);
  const at = template.indexOf(marker);
  const before = template.slice(0, at);
  const after = template.slice(at + marker.length);
  return message.length > before.length + after.length &&
    message.startsWith(before) &&
    message.endsWith(after)
    ? message.slice(before.length, message.length - after.length)
    : undefined;
}

/** The marker's rows: small, one per installed table of the database. */
export function markerQuery(names: TableNames): string {
  return `select [table_schema] as table_schema, [table_name] as table_name, [project_id] as project_id, [project_name] as project_name
  from ${names.markerRelation}
 order by [table_schema], [table_name]`;
}

/** Where the table's row is, as a `where` clause of the marker. */
function thisTable(names: TableNames): string {
  return `[table_schema] = ${quoteString(names.schema)} and [table_name] = ${quoteString(names.table)}`;
}

/** The marker table, made by the first install in the database. */
export function markerTableStatement(names: TableNames): PlanStatement {
  return sourceStatement(
    "marker",
    `if object_id(${quoteString(names.markerRelation)}, N'U') is null
  create table ${names.markerRelation} (
    [table_schema] sysname not null,
    [table_name] sysname not null,
    [project_id] nvarchar(256) not null,
    [project_name] nvarchar(256) not null,
    [installed_at] datetime2(3) not null default sysutcdatetime(),
    primary key ([table_schema], [table_name])
  )`,
  );
}

/**
 * The claim: the table's row for this project, unless the table has one. `updlock, holdlock` makes a
 * racing install wait for this one's commit and then find the row, so it stops at its owner check.
 */
export function claimStatement(names: TableNames, project: ProjectRef): PlanStatement {
  return sourceStatement(
    "marker",
    `if not exists (select 1 from ${names.markerRelation} with (updlock, holdlock) where ${thisTable(names)})
  insert into ${names.markerRelation} ([table_schema], [table_name], [project_id], [project_name])
  values (${quoteString(names.schema)}, ${quoteString(names.table)}, ${quoteString(project.id)}, ${quoteString(project.name)})`,
  );
}

/**
 * The owner check, right after the claim and inside the same transaction: a table another project
 * claimed (since the plan was read, or before a hand run of the printed script) stops the script,
 * and the whole transaction rolls back.
 */
export function ownerCheckStatement(names: TableNames, project: ProjectRef): PlanStatement {
  const [before, after] = anotherProject(names.label, "\u0000").split("\u0000");
  return sourceStatement(
    "marker",
    `declare @owner nvarchar(256) = (select [project_id] from ${names.markerRelation} where ${thisTable(names)});
if @owner <> ${quoteString(project.id)}
begin
  declare @refused nvarchar(2048) = concat(${quoteString(`${SCRIPT_PREFIX}${before ?? ""}`)}, @owner, ${quoteString(after ?? "")});
  throw ${SCRIPT_ERROR}, @refused, 1;
end`,
  );
}

/** The table's row goes; the marker table stays while another table of the database is installed. */
export function releaseStatement(names: TableNames): PlanStatement {
  return sourceStatement(
    "marker",
    `if object_id(${quoteString(names.markerRelation)}, N'U') is not null
  delete from ${names.markerRelation} where ${thisTable(names)}`,
  );
}

/**
 * The marker table, once it is empty: the statement checks at run time, so the first table's run of
 * a multi-table uninstall keeps it for the next (`run` scope).
 */
export function markerCleanupStatement(names: TableNames): PlanStatement {
  return sourceStatement(
    "cleanup",
    `if object_id(${quoteString(names.markerRelation)}, N'U') is not null
begin
  if not exists (select 1 from ${names.markerRelation})
    drop table ${names.markerRelation};
end`,
  );
}
