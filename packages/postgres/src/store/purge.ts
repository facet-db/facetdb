import { quoteLiteral, type SqlQuery } from "../sql/index.ts";

/**
 * The store's part of `facetdb uninstall --purge` when the store is not the source's database: the
 * engine's plan holds the source's side only, so the CLI's store door deletes the source's decision
 * log here, after the engine's run. The script is printed before it runs and run as printed, in one
 * transaction: the source's rows, its question-set versions and the set its worker last ran (store
 * migration 8), its review cards (made from that log) and its registration, after a guard that
 * refuses while a live store source of the same id (an API or plugin source holding records) still
 * writes the log. The values reach the statements through transaction-local settings, as the
 * engine's scripts do, so no value is spliced into a `do` block. Only a table's registration (`kind
 * = 'plugin'`) is deleted: an API source's (`api`) or a plugin source's (`plugin-source`) stays,
 * and a plugin source holds records from its first change on, so the guard refuses its log as it
 * refuses an API source's.
 */

/** A source's decision log in the store, read before the purge is shown. */
export type StoreLog = {
  readonly decisions: number;
  readonly versions: number;
  /** Records of a store source under the same id: the log is live, and the purge refuses. */
  readonly records: number;
};

/** The source whose log is purged: its store id (`sourceIdOf`), its name and its project. */
export type PurgedSource = {
  readonly id: string;
  readonly name: string;
  readonly projectId: string;
};

const SOURCE = "facetdb.purge_source";
const NAME = "facetdb.purge_name";
const PROJECT = "facetdb.purge_project";

/** How the guard begins its message, so the store door reads its refusal back by its own words. */
const FACETDB = "FacetDB: ";

/** The SQLSTATE the guard raises (`object_in_use`). */
const IN_USE = "55006";

async function rowsOf(
  query: SqlQuery,
  table: "decisions" | "question_set_versions" | "records",
  sourceId: string,
): Promise<number> {
  const present = await query(`select to_regclass('facetdb.${table}') is not null as present`);
  if (present[0]?.["present"] !== true) {
    return 0;
  }
  const rows = await query(`select count(*)::int as n from facetdb.${table} where source_id = $1`, [
    sourceId,
  ]);
  return Number(rows[0]?.["n"]);
}

/** The log's size and whether a live store source writes it; 0 where a table is absent. */
export async function readStoreLog(query: SqlQuery, sourceId: string): Promise<StoreLog> {
  return {
    decisions: await rowsOf(query, "decisions", sourceId),
    versions: await rowsOf(query, "question_set_versions", sourceId),
    records: await rowsOf(query, "records", sourceId),
  };
}

/**
 * The purge's statements in order, each exactly as printed and as run. Every delete is guarded by
 * its table's presence, as the shared path's are (install/uninstall.ts): a store that never held a
 * log (no `facetdb.decisions` yet) reads as an empty log and purges as one, never as an error.
 */
export function storePurgeStatements(source: PurgedSource): readonly string[] {
  const current = (setting: string) => `current_setting('${setting}')`;
  return [
    `select set_config('${SOURCE}', ${quoteLiteral(source.id)}, true), set_config('${NAME}', ${quoteLiteral(source.name)}, true), set_config('${PROJECT}', ${quoteLiteral(source.projectId)}, true)`,
    `do $$
begin
  if to_regclass('facetdb.records') is not null then
    if exists (select 1 from facetdb.records r where r.source_id = ${current(SOURCE)}) then
      raise exception '${FACETDB}the decision log of source "%" is shared with the store source "%" of project %, which holds records and is live; nothing was changed.', ${current(NAME)}, ${current(NAME)}, ${current(PROJECT)}
        using errcode = 'object_in_use';
    end if;
  end if;
end $$`,
    `do $$
begin
  if to_regclass('facetdb.decisions') is not null then
    delete from facetdb.decisions where source_id = ${current(SOURCE)};
  end if;
  if to_regclass('facetdb.question_set_versions') is not null then
    delete from facetdb.question_set_versions where source_id = ${current(SOURCE)};
  end if;
  if to_regclass('facetdb.question_sets_in_force') is not null then
    delete from facetdb.question_sets_in_force where source_id = ${current(SOURCE)};
  end if;
  if to_regclass('facetdb.reviews') is not null then
    delete from facetdb.reviews where source_id = ${current(SOURCE)};
  end if;
  if to_regclass('facetdb.sources') is not null then
    delete from facetdb.sources where id = ${current(SOURCE)} and project_id = ${current(PROJECT)} and kind = 'plugin';
  end if;
end $$`,
  ];
}

/** The guard's refusal in its own words, read by its SQLSTATE and prefix; undefined for any other error. */
export function storePurgeRefusal(error: unknown): string | undefined {
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === IN_USE &&
    error.message.startsWith(FACETDB)
  ) {
    return error.message.slice(FACETDB.length);
  }
  return undefined;
}
