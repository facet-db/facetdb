import { type EngineTarget, type OnChange, STATUS_COLUMN } from "@facetdb/core";
import { quoteName, quoteString } from "../sql/index.ts";
import type { CatalogColumn } from "./catalog.ts";
import type { TableNames } from "./objects.ts";
import { keyText } from "./queue.ts";

/** Where a source keeps its answers. */
export type Storage = EngineTarget["storage"];

/**
 * The change capture: one trigger per table, `after insert, update`, run with the rights of the
 * table's owner (`with execute as owner`), so the application's own login needs no right on the
 * queue or on FacetDB's columns. SQL Server fires a trigger once per statement, with every affected
 * row in `inserted` and their old values in `deleted`, so the body is set-based.
 *
 * It fires for a statement that changed no row too, and returns at once then: its own status
 * update can change no row (an app's update of a row already pending, or of a decided one under
 * `onChange: keep`; an update-then-insert upsert's update of nothing), and with RECURSIVE_TRIGGERS
 * on (a supported option, on Azure SQL too) that empty update fires the trigger again, which would
 * act again, to the 32-level nesting limit (error 217), failing the application's write. The same
 * holds for an empty firing reached through another trigger of the table.
 *
 * It acts on an update whose `set` names a state column, and on an insert: `update(<column>)` is
 * true for a column a statement sets, whatever the value, and for every column of an insert. The
 * worker's own update sets FacetDB's columns only, so it never queues a row again, and a recursive
 * firing on the trigger's own status update finds nothing to do for the same reason.
 *
 * For those rows it puts the status back to pending, on the row or in side-table mode on its side
 * row (`pendingText`; `onChange: keep` sets it only on a row that has none yet, a new one), then clears the claim of every key already queued, so the worker holding
 * one asks the new state too: its ack deletes only the jobs it still holds, by its token (the
 * Postgres trigger's `on conflict (record_key) do update set claimed_at = null, claimed_by = null`).
 * Then it queues the keys not queued yet; the queue's primary key ignores a duplicate
 * (`ignore_dup_key`), so a key two writers queue between the two statements is still one job.
 *
 * Its own statements run at read committed: an application transaction at serializable, the default
 * of .NET's TransactionScope, would otherwise take key-range locks in the `not exists` reads of the
 * queue and the side table, so two transactions inserting new keys at the end of a range wait on
 * each other and close a deadlock whose victim is an application's transaction (proven on SQL
 * Server 2022: the second insert waited on the first). SQL Server puts back the caller's level when
 * a trigger returns, so the application's own statements keep theirs (the db suite reads it back);
 * the trigger's reads of FacetDB's own tables need no more than read committed, its writes lock as
 * they always do.
 */
export function triggerText(
  names: TableNames,
  key: CatalogColumn,
  state: readonly string[],
  onChange: OnChange,
  storage: Storage,
): string {
  const table = quoteString(names.relation);
  const queued = keyText("i", key);
  const changed = state.map((column) => `update(${quoteName(column)})`);
  return `create trigger ${names.triggerRelation} on ${names.relation}
with execute as owner
after insert, update
as
begin
  set nocount on;
  -- FacetDB's reads here run at read committed whatever the application's level; SQL Server gives
  -- the application its own level back when the trigger returns.
  set transaction isolation level read committed;
  -- A statement that changed no row has nothing to queue: its firing ends here, before any write.
  if not exists (select 1 from inserted) return;
  -- An update that sets a state column, or an insert (which sets every column): the worker's own
  -- update sets none of them.
  if ${changed.join("\n     or ")}
  begin
${pendingText(names, key, onChange, storage)}
    -- A key already queued keeps its job, its claim cleared, so the new state is asked too.
    update j set [claimed_by] = null, [claimed_at] = null, [claim_token] = null
      from ${names.jobsRelation} j
      join inserted i on j.[table_name] = ${table} and j.[record_key] = ${queued};
    -- A key not queued yet is queued.
    insert into ${names.jobsRelation} ([table_name], [record_key])
    select ${table}, ${queued}
      from inserted i
     where not exists (select 1 from ${names.jobsRelation} j
                        where j.[table_name] = ${table} and j.[record_key] = ${queued});
  end
end`;
}

/**
 * Where the trigger puts the changed rows' status back to pending: the storage half of the trigger,
 * the capture half being the rest of `triggerText`. A capture without a trigger (Change Tracking)
 * would take this half alone.
 *
 * Inline, the status is a column of the row itself. In side-table mode the table is never written:
 * the status lives in the record's side row, and a record without one (a new record, or one the
 * table held before the install) gets one, pending, so the view and `current` say pending once its
 * change is queued. Two set-based statements, the update of the side rows there and the insert of
 * those missing, rather than one `merge`: every writer of a side row holds a lock on its source row
 * first (this trigger runs inside the application's statement, which holds an exclusive lock on
 * each row of `inserted`; the worker's write takes an update lock on the source row before it
 * touches the side row; a delete cascades under the delete's own lock), so no other transaction can
 * insert the same side row between the two statements, and `merge` with `holdlock` would add range
 * locks for nothing, beside its catalogue of known defects. The `not exists` is a locking read
 * (`readcommittedlock`): under READ_COMMITTED_SNAPSHOT a version read could miss a side row another
 * session committed while this statement waited, and the insert would fail with a duplicate key
 * (2627), rolling the application's transaction back (SQL Server 2022 takes each trigger
 * statement's snapshot after the wait, so the db suite's race passes either way, and the hint keeps
 * it so wherever that differs). The side table has no trigger, so neither statement fires anything,
 * and an empty firing never reaches them (the return above).
 */
function pendingText(
  names: TableNames,
  key: CatalogColumn,
  onChange: OnChange,
  storage: Storage,
): string {
  const id = quoteName(key.name);
  const status = quoteName(STATUS_COLUMN);
  const alias = storage === "side-table" ? "a" : "t";
  const unsettled =
    onChange === "reset"
      ? `${alias}.${status} is null or ${alias}.${status} <> 'pending'`
      : `${alias}.${status} is null`;
  if (storage === "inline") {
    return `    update t set ${status} = 'pending'
      from ${names.relation} t
      join inserted i on i.${id} = t.${id}
     where ${unsettled};`;
  }
  return `    -- The record's side row back to pending; the table itself is never written.
    update a set ${status} = 'pending'
      from ${names.sideRelation} a
      join inserted i on i.${id} = a.${id}
     where ${unsettled};
    -- A record without a side row gets one, pending.
    insert into ${names.sideRelation} (${id}, ${status})
    select i.${id}, 'pending'
      from inserted i
     where not exists (select 1 from ${names.sideRelation} a with (readcommittedlock) where a.${id} = i.${id});`;
}

/**
 * Whether a trigger's stored text is this one: the catalog keeps the text it was created with, from
 * a run or from the printed script run by hand (a batch may carry line breaks of another system,
 * blank lines around it and the script's `;`).
 */
export function sameTrigger(stored: string, wanted: string): boolean {
  const plain = (text: string) => text.replaceAll("\r\n", "\n").trim().replace(/;$/, "").trimEnd();
  return plain(stored) === plain(wanted);
}
