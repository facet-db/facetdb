import { type OnChange, STATUS_COLUMN } from "@facetdb/core";
import { quoteName, quoteString } from "../sql/index.ts";
import type { CatalogColumn } from "./catalog.ts";
import type { TableNames } from "./objects.ts";
import { keyText } from "./queue.ts";

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
 * For those rows it puts the status back to pending (`onChange: keep` sets it only on a row that has
 * none yet, a new one), then clears the claim of every key already queued, so the worker holding
 * one asks the new state too: its ack deletes only the jobs it still holds, by its token (the
 * Postgres trigger's `on conflict (record_key) do update set claimed_at = null, claimed_by = null`).
 * Then it queues the keys not queued yet; the queue's primary key ignores a duplicate
 * (`ignore_dup_key`), so a key two writers queue between the two statements is still one job.
 */
export function triggerText(
  names: TableNames,
  key: CatalogColumn,
  state: readonly string[],
  onChange: OnChange,
): string {
  const id = quoteName(key.name);
  const status = quoteName(STATUS_COLUMN);
  const table = quoteString(names.relation);
  const queued = keyText("i", key);
  const unsettled =
    onChange === "reset"
      ? `t.${status} is null or t.${status} <> 'pending'`
      : `t.${status} is null`;
  const changed = state.map((column) => `update(${quoteName(column)})`);
  return `create trigger ${names.triggerRelation} on ${names.relation}
with execute as owner
after insert, update
as
begin
  set nocount on;
  -- A statement that changed no row has nothing to queue: its firing ends here, before any write.
  if not exists (select 1 from inserted) return;
  -- An update that sets a state column, or an insert (which sets every column): the worker's own
  -- update sets none of them.
  if ${changed.join("\n     or ")}
  begin
    update t set ${status} = 'pending'
      from ${names.relation} t
      join inserted i on i.${id} = t.${id}
     where ${unsettled};
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
 * Whether a trigger's stored text is this one: the catalog keeps the text it was created with, from
 * a run or from the printed script run by hand (a batch may carry line breaks of another system,
 * blank lines around it and the script's `;`).
 */
export function sameTrigger(stored: string, wanted: string): boolean {
  const plain = (text: string) => text.replaceAll("\r\n", "\n").trim().replace(/;$/, "").trimEnd();
  return plain(stored) === plain(wanted);
}
