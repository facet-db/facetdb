import type { PlanStatement } from "@facetdb/core";
import { quoteName, quoteString } from "../sql/index.ts";
import type { CatalogColumn } from "./catalog.ts";
import {
  JOBS_TABLE,
  QUEUE_KEY_COLLATION,
  QUEUE_KEY_LENGTH,
  QUEUE_NAME_LENGTH,
  sourceStatement,
  type TableNames,
} from "./objects.ts";

/**
 * The database's queue, shared by every watched table of the database, as the uninstall's rule says
 * (it goes once no FacetDB trigger writes to it). A job is a table and one of its keys:
 * `table_name` is the table as `[schema].[table]`, `record_key` the key as text, so keys of two
 * tables never meet (key 1 of listings and key 1 of orders are two jobs) and a uniqueidentifier key
 * sits beside an int one. The primary key is the pair, `ignore_dup_key` on, so a key queued twice
 * at once is one job. The worker claims a job with `claim_token` under a lease on `claimed_at`,
 * reading the clustered key: a claim through the index on (`table_name`, `claimed_at`) looks each
 * row up in the clustered key afterwards, and that lookup waits on a row another transaction holds
 * where `readpast` would skip it. The index serves the worker's watch of a table's unclaimed keys
 * and doctor's counts, which it answers alone.
 */

/**
 * The longest text a key of this type reads as, or undefined for a type FacetDB does not queue: a
 * key goes into the queue and comes back as text, so only types whose text gives the same value
 * back are taken (whole numbers, decimals, uniqueidentifiers and text; never a float, whose text
 * rounds, nor a date or binary value, whose text depends on a style).
 */
export function keyTextLength(column: CatalogColumn): number | undefined {
  switch (column.type) {
    case "tinyint":
      return 3;
    case "smallint":
      return 6;
    case "int":
      return 11;
    case "bigint":
      return 20;
    case "decimal":
    case "numeric":
      // Every digit, a sign and a point.
      return column.precision + 2;
    case "uniqueidentifier":
      return 36;
    case "char":
    case "varchar":
      return column.maxLength === -1 ? undefined : column.maxLength;
    case "nchar":
    case "nvarchar":
      return column.maxLength === -1 ? undefined : column.maxLength / 2;
    default:
      return undefined;
  }
}

/**
 * A row's key as the queue keeps it, the row being `alias` (`i` for `inserted`): text, compared by
 * code point. A text key carries its own collation through the conversion, which a comparison with
 * the queue's would conflict with, so the queue's is named.
 */
export function keyText(alias: string, key: CatalogColumn): string {
  const text = `convert(nvarchar(${QUEUE_KEY_LENGTH}), ${alias}.${quoteName(key.name)})`;
  return key.collation === null ? text : `${text} collate ${QUEUE_KEY_COLLATION}`;
}

/** The queue, made by the first install in the database. */
export function queueStatement(names: TableNames): PlanStatement {
  return sourceStatement(
    "queue",
    `if object_id(${quoteString(names.jobsRelation)}, N'U') is null
begin
  create table ${names.jobsRelation} (
    [table_name] nvarchar(${QUEUE_NAME_LENGTH}) not null,
    [record_key] nvarchar(${QUEUE_KEY_LENGTH}) collate ${QUEUE_KEY_COLLATION} not null,
    [enqueued_at] datetime2(3) not null default sysutcdatetime(),
    [claimed_by] nvarchar(128) null,
    [claimed_at] datetime2(3) null,
    [claim_token] char(32) null,
    primary key ([table_name], [record_key]) with (ignore_dup_key = on)
  );
  create index [facetdb_jobs_claimed] on ${names.jobsRelation} ([table_name], [claimed_at]);
end`,
  );
}

/** Uninstall: the table's own jobs leave the queue. */
export function dequeueStatement(names: TableNames): PlanStatement {
  return sourceStatement(
    "data",
    `if object_id(${quoteString(names.jobsRelation)}, N'U') is not null
  delete from ${names.jobsRelation} where [table_name] = ${quoteString(names.relation)}`,
  );
}

/**
 * Uninstall: the queue goes once no FacetDB trigger writes to it (that table's writes would fail),
 * no other installed table is watched by Change Tracking (its worker queues there, with no trigger
 * to show it), and it holds no job. The statement checks at run time, so the first table's run of a
 * multi-table uninstall leaves it to the last (`run` scope); this table's marker row goes after it,
 * so it is left out by name. The marker's read sits in a branch of its own: a statement naming a
 * table that is not there fails when it runs, not when the batch compiles.
 */
export function queueCleanupStatement(names: TableNames): PlanStatement {
  return sourceStatement(
    "cleanup",
    `if object_id(${quoteString(names.jobsRelation)}, N'U') is not null
begin
  declare @tracked bit = 0;
  if object_id(${quoteString(names.markerRelation)}, N'U') is not null
  begin
    if exists (select 1 from ${names.markerRelation} m
                 join sys.change_tracking_tables c on c.object_id = object_id(quotename(m.[table_schema]) + N'.' + quotename(m.[table_name]), N'U')
                where not (m.[table_schema] = ${quoteString(names.schema)} and m.[table_name] = ${quoteString(names.table)}))
      set @tracked = 1;
  end
  if @tracked = 0
     and not exists (select 1 from sys.triggers t join sys.sql_modules m on m.object_id = t.object_id
                  where t.parent_class = 1 and t.name like N'facetdb[_]%'
                    and charindex(${quoteString(JOBS_TABLE)}, m.definition) > 0)
     and not exists (select 1 from ${names.jobsRelation})
    drop table ${names.jobsRelation};
end`,
  );
}
