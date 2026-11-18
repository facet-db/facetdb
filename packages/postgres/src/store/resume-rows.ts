import { BACKFILL_RUN_PREFIX, BACKFILL_RUN_SUFFIX } from "@facetdb/core";
import { quoteLiteral, type SqlQuery } from "../sql/index.ts";

/**
 * A source's resume rows in `facetdb.cursors`: where the source picks up again after a restart,
 * each under a run key that begins with its kind and carries the source's store id
 * `<project>:<source>` (`sourceIdOf`):
 *
 * - `backfill:<project>:<source>:all@v<n>` and `…:only@v<n>:<names>`, a backfill's place (core's
 *   `backfillRun`);
 * - `mongo:<project>:<source>`, a MongoDB change stream's resume token (`tokenRun`);
 * - `ct:<project>:<source>`, SQL Server Change Tracking's version (`versionRun`).
 *
 * They belong to the source and go with its uninstall, with or without `--purge`: left behind, a
 * reinstalled source would resume from a stale place and skip records. They are never an unfinished
 * backfill that keeps the store's shared tables (only a row that names no source is, one written by
 * an earlier version). The values reach the statements through a transaction-local setting, as
 * every uninstall script's do (a `$$` body never holds a value).
 */

/** The kinds of run key a source's resume rows have, each the start of its key. */
export const RESUME_RUN_PREFIXES: readonly string[] = [BACKFILL_RUN_PREFIX, "mongo:", "ct:"];

/** The setting the delete reads the source's store id from. */
const RESUME_SOURCE = "facetdb.resume_source";

/**
 * The rows of `facetdb.cursors` that are one source's, as an SQL condition on its `run` column:
 * `id` is an SQL expression for the source's store id (a parameter or a setting, never a value).
 * The stream's and Change Tracking's keys are compared whole. A backfill's key is anchored at
 * both ends: it begins with `backfill:<id>:`, compared as text (the id is never read as a
 * pattern, so nothing in it needs escaping), and the rest of it is a whole `BACKFILL_RUN_SUFFIX`.
 * A prefix alone would not do: a project id is a directory's name and may hold `:all@v`, so project
 * `p`'s source `a` would take `backfill:p:a:all@v2:x:all@v1`, project `p:a:all@v2`'s source `x`.
 */
export function resumeRowsOf(id: string): string {
  const scope = `${quoteLiteral(BACKFILL_RUN_PREFIX)} || ${id} || ':'`;
  return `(run in ('mongo:' || ${id}, 'ct:' || ${id})
        or (starts_with(run, ${scope})
            and substr(run, char_length(${scope}) + 1) ~ ${quoteLiteral(BACKFILL_RUN_SUFFIX)}))`;
}

/**
 * A row of `facetdb.cursors` that is no source's resume row, as an SQL condition on `run`: what
 * uninstall may still count as an unfinished backfill (a key from an earlier version, which names
 * no source and keeps every project).
 */
export const NOT_A_RESUME_ROW = `not (${RESUME_RUN_PREFIXES.map(
  (prefix) => `starts_with(run, ${quoteLiteral(prefix)})`,
).join(" or ")})`;

/**
 * The statements that delete one source's resume rows, in order, each exactly as printed and as
 * run: the setting, then the delete, guarded by the table's presence (a database whose store
 * predates the cursors, or a sweep that already dropped them, reads as no rows, never as an error).
 */
export function resumeRowsStatements(sourceId: string): readonly [string, string] {
  return [
    `select set_config('${RESUME_SOURCE}', ${quoteLiteral(sourceId)}, true)`,
    `do $$
begin
  if to_regclass('facetdb.cursors') is not null then
    delete from facetdb.cursors where ${resumeRowsOf(`current_setting('${RESUME_SOURCE}')`)};
  end if;
end $$`,
  ];
}

/**
 * The statement that deletes these rows of `facetdb.cursors` by their run keys, for the words that
 * tell an operator how to finish by hand what a run could not (every key written as a literal).
 */
export function deleteCursorsSql(runs: readonly string[]): string {
  return `delete from facetdb.cursors where run in (${runs.map(quoteLiteral).join(", ")});`;
}

/** The run keys of one source's resume rows, in order; none while the store has no cursors. */
export async function readResumeRows(
  query: SqlQuery,
  sourceId: string,
): Promise<readonly string[]> {
  const present = await query("select to_regclass('facetdb.cursors') is not null as present");
  if (present[0]?.["present"] !== true) {
    return [];
  }
  const rows = await query(
    `select run from facetdb.cursors where ${resumeRowsOf("$1::text")} order by run`,
    [sourceId],
  );
  return rows.map((row) => String(row["run"]));
}
