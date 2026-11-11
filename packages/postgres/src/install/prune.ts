import type { QuestionSet } from "@facetdb/core";
import {
  SIDE_TABLE_SETTING,
  sideTableName,
  sideTableRelation,
  sideTableStatements,
  sideViewName,
  VIEW_NAME_SETTING,
  VIEW_SCHEMA_SETTING,
} from "../scan/index.ts";
import { connectPostgres, quoteIdent, quoteTable, type SqlConnect } from "../sql/index.ts";
import { plain, readInstalled, SCRIPT_HEADER, settingsStatement } from "./catalog.ts";
import {
  type InstallStatement,
  installOwnedColumns,
  ownedColumnDefinitions,
  type ProjectRef,
  renderSql,
  SCHEMA_SETTING,
  TABLE_SETTING,
  type TableSource,
} from "./sql.ts";

/**
 * `facetdb migrate --prune`: a question removed from the set keeps its columns until the operator
 * asks for them to go, so nothing is destroyed silently. This drops the answer columns of those
 * questions and nothing else: never a status column, never a column FacetDB did not mark, never
 * with `cascade` (a view of the customer's on a column makes the drop fail and the transaction roll
 * back, with Postgres's own message naming the view).
 */

/** The FacetDB columns the catalog shows: marked ones on the table, or the side table's. */
export type PruneCatalog = {
  readonly columns: readonly string[];
};

/** The catalog's columns that the question set no longer owns: the ones `prune` drops. */
export function prunedColumns(
  source: Pick<TableSource, "key">,
  questionSet: QuestionSet,
  catalog: PruneCatalog,
): readonly string[] {
  const kept = new Set(installOwnedColumns(questionSet));
  return catalog.columns.filter((name) => name !== source.key && !kept.has(name));
}

/**
 * The prune script: one `drop column` per answer column of a removed question, or no statement at
 * all when there is none. In side-table mode the columns are on `facetdb.<table>_answers` and the
 * view reads them by name, so the drops run while the view is down: its grants are saved, it is
 * dropped, the columns go, and it is created again over the columns that remain (the same pieces
 * install uses, with the same marks and the grants put back).
 */
export function pruneSql(
  source: TableSource,
  questionSet: QuestionSet,
  catalog: PruneCatalog,
): readonly InstallStatement[] {
  const removed = prunedColumns(source, questionSet, catalog);
  if (removed.length === 0) {
    return [];
  }
  if (source.storage !== "side-table") {
    const table = quoteTable({ schema: source.schema, name: source.table });
    return [
      ...SCRIPT_HEADER,
      ...removed.map((name) => plain(`alter table ${table} drop column ${quoteIdent(name)}`)),
    ];
  }
  const side = sideTableRelation(source);
  const present = new Set(catalog.columns);
  const remaining = ownedColumnDefinitions(questionSet).filter(([name]) => present.has(name));
  return [
    ...SCRIPT_HEADER,
    settingsStatement([
      [VIEW_SCHEMA_SETTING, source.schema ?? "public"],
      [VIEW_NAME_SETTING, sideViewName(source.table)],
      [SIDE_TABLE_SETTING, sideTableName(source.table)],
      [SCHEMA_SETTING, source.schema ?? "public"],
      [TABLE_SETTING, source.table],
    ]),
    ...sideTableStatements(source, remaining, {
      whileViewDropped: removed.map(
        (name) => `alter table ${side} drop column ${quoteIdent(name)}`,
      ),
    }).map(plain),
  ];
}

export type PruneOptions = {
  /** The admin connection string; used for this call and not retained. */
  readonly adminUrl: string;
  readonly source: { readonly table: string; readonly schema?: string };
  /** The question set as the config now has it: columns of questions not in it are dropped. */
  readonly questionSet: QuestionSet;
  /** The project running the prune; a table another project installed on is refused. */
  readonly project: ProjectRef;
  /** Receives the complete script before anything runs. */
  readonly print: (sql: string) => void;
  /** Print and stop, touching nothing. */
  readonly dryRun?: boolean;
  readonly connect?: SqlConnect;
};

export type PruneResult =
  | {
      readonly ok: true;
      /** The columns dropped (or that would be, on a dry run); empty when nothing was left to prune. */
      readonly dropped: readonly string[];
      readonly statements: readonly InstallStatement[];
      /** The printed script; empty, and nothing printed or run, when there is nothing to prune. */
      readonly sql: string;
      readonly applied: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Reads the catalog, prints the prune script and runs exactly its statements in one transaction.
 * The storage mode comes from what install left (a marked side table means side-table mode), so a
 * config that changed its mind cannot point the drops at the wrong relation.
 */
export async function prune(options: PruneOptions): Promise<PruneResult> {
  const client = (options.connect ?? connectPostgres)(options.adminUrl);
  try {
    const installed = await readInstalled(client.query, options.source);
    if ("reason" in installed) {
      return { ok: false, reason: installed.reason };
    }
    if (installed.project.id !== options.project.id) {
      return {
        ok: false,
        reason: `${installed.schema}.${installed.table} belongs to another project (${installed.project.id}); prune it from that project.`,
      };
    }
    const side = installed.sideColumns !== undefined;
    const source: TableSource = {
      table: installed.table,
      schema: installed.schema,
      key: installed.key,
      keyType: installed.keyType,
      storage: side ? "side-table" : "inline",
    };
    const catalog = { columns: installed.sideColumns ?? installed.marked };
    const dropped = prunedColumns(source, options.questionSet, catalog);
    const statements = pruneSql(source, options.questionSet, catalog);
    if (statements.length === 0) {
      return { ok: true, dropped, statements, sql: "", applied: false };
    }
    const sql = renderSql(statements);
    options.print(sql);
    if (options.dryRun === true) {
      return { ok: true, dropped, statements, sql, applied: false };
    }
    await client.transaction(async (query) => {
      for (const statement of statements) {
        await query(statement.text, statement.params);
      }
    });
    return { ok: true, dropped, statements, sql, applied: true };
  } finally {
    await client.close();
  }
}
