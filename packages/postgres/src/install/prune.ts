import { answerColumns, type QuestionSet } from "@facetdb/core";
import {
  CREATION_COLUMN,
  SIDE_TABLE_SETTING,
  sideTableName,
  sideTableRelation,
  sideTableStatements,
  sideViewName,
  VIEW_NAME_SETTING,
  VIEW_SCHEMA_SETTING,
} from "../scan/index.ts";
import {
  connectPostgres,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  type SqlConnect,
} from "../sql/index.ts";
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
  WORKER_ROLE,
} from "./sql.ts";

/**
 * `facetdb migrate --prune`: a question removed from the set keeps its columns until the operator
 * asks for them to go, so nothing is destroyed silently. This drops the answer columns of those
 * questions and nothing else: never a status column, never a column FacetDB did not mark, never
 * with `cascade` (a view of the customer's on a column makes the drop fail and the transaction roll
 * back, with Postgres's own message naming the view).
 */

/** The columns of a table on which a role holds a column-level select (grants made to that role itself). */
const WORKER_SELECT_QUERY = `select a.attname as name
  from pg_catalog.pg_attribute a
  cross join lateral pg_catalog.aclexplode(a.attacl) x
 where a.attrelid = format('%I.%I', $1::text, $2::text)::regclass
   and a.attnum > 0 and not a.attisdropped
   and x.privilege_type = 'SELECT'
   and x.grantee = (select oid from pg_catalog.pg_roles where rolname = $3)
 order by a.attnum`;

/**
 * The worker's column selects granted by a role other than the table's owner and the running role
 * (a DBA's own grant): no revoke of this prune can take them back, so they are named in its notes.
 */
const FOREIGN_GRANTS_QUERY = `select a.attname as name, pg_catalog.pg_get_userbyid(x.grantor) as grantor
  from pg_catalog.pg_attribute a
  join pg_catalog.pg_class c on c.oid = a.attrelid
  cross join lateral pg_catalog.aclexplode(a.attacl) x
 where a.attrelid = format('%I.%I', $1::text, $2::text)::regclass
   and a.attnum > 0 and not a.attisdropped
   and x.privilege_type = 'SELECT'
   and x.grantee = (select oid from pg_catalog.pg_roles where rolname = $3)
   and x.grantor not in (c.relowner, (select oid from pg_catalog.pg_roles where rolname = current_user))
 order by a.attnum, 2`;

/**
 * Who must run a revoke (proven in install.db.test.ts): Postgres takes back only the grants made by
 * the role that runs it, or by the owner when that role is the owner or a member of its role;
 * install's grants on the table are recorded as the owner's. Run by another admin, the revoke
 * changes nothing with a mere warning, so the script says so and checks the result itself. No name
 * here: a newline in one would end the comment.
 */
const REVOKE_NOTE =
  "-- A revoke takes back only grants made by the role running it, and install's grants on the table\n-- are its owner's: run this as the table's owner or a member of its role.\n";

/** The revoked columns, as a JSON array, for the check after the revokes (a `do` block takes no value). */
const REVOKED_SETTING = "facetdb.prune_revoked";

/** The SQLSTATE the check raises with, so `prune` can tell its refusal from any other failure. */
const NOT_REVOKED_STATE = "FD051";

/**
 * The check after the revokes, in the script so a hand-run script stops too: a revoke that took
 * nothing back (REVOKE_NOTE) raises, and the whole transaction, drops included, rolls back.
 */
function revokedCheck(
  source: TableSource,
  revoked: readonly string[],
): readonly InstallStatement[] {
  return [
    settingsStatement([
      [SCHEMA_SETTING, source.schema ?? "public"],
      [TABLE_SETTING, source.table],
      [REVOKED_SETTING, JSON.stringify(revoked)],
    ]),
    // Only a grant this revoke should have taken back stops it: install's (the owner's) or the
    // running role's own. Another grantor's (a DBA's) stays with a note (`FOREIGN_GRANTS_QUERY`).
    plain(`do $$
declare
  still text;
begin
  select string_agg(a.attname, ', ' order by a.attnum) into still
    from pg_catalog.pg_attribute a
    join pg_catalog.pg_class c on c.oid = a.attrelid
    cross join lateral pg_catalog.aclexplode(a.attacl) x
   where a.attrelid = format('%I.%I', current_setting('${SCHEMA_SETTING}'), current_setting('${TABLE_SETTING}'))::regclass
     and a.attnum > 0
     and a.attname in (select jsonb_array_elements_text(current_setting('${REVOKED_SETTING}')::jsonb))
     and x.privilege_type = 'SELECT'
     and x.grantee = (select oid from pg_catalog.pg_roles where rolname = ${quoteLiteral(WORKER_ROLE)})
     and x.grantor in (c.relowner, (select oid from pg_catalog.pg_roles where rolname = current_user));
  if still is not null then
    raise exception using errcode = ${quoteLiteral(NOT_REVOKED_STATE)}, message = format(${quoteLiteral(
      "FacetDB: %s.%s: the worker login still reads %s after the revoke; Postgres takes back only grants made by the role that runs it, and install's grants are the table owner's. Run migrate --prune as the table's owner or a member of its role; nothing was changed.",
    )}, current_setting('${SCHEMA_SETTING}'), current_setting('${TABLE_SETTING}'), still);
  end if;
end $$`),
  ];
}

/** The FacetDB columns the catalog shows: marked ones on the table, or the side table's. */
export type PruneCatalog = {
  readonly columns: readonly string[];
  /** The source table's columns on which the worker login holds a column-level select. */
  readonly workerSelect?: readonly string[];
};

/**
 * The columns the worker may still read that the question set no longer asks about: a state column
 * removed from `read`. The key, FacetDB's own columns and the creation marker `scan` orders by stay.
 */
export function revokedColumns(
  source: Pick<TableSource, "key">,
  questionSet: QuestionSet,
  catalog: PruneCatalog,
): readonly string[] {
  const kept = new Set([
    source.key,
    CREATION_COLUMN,
    ...questionSet.read,
    ...installOwnedColumns(questionSet),
    // A column that stays (see `keptColumns`) is left exactly as it is, its grants included.
    ...keptColumns(source, questionSet, catalog),
  ]);
  return (catalog.workerSelect ?? []).filter((name) => !kept.has(name));
}

/** What the output says about a marked column that stays although the set no longer owns it. */
export const KEPT_NOTE = "kept (storeProbabilities is off)";

/**
 * The marked columns of questions still in the set that the set no longer owns: a choice
 * question's `_probabilities` column after `storeProbabilities` went off. The operator turned off
 * the storing, not the question, so the column and what it holds stay.
 */
export function keptColumns(
  source: Pick<TableSource, "key">,
  questionSet: QuestionSet,
  catalog: PruneCatalog,
): readonly string[] {
  const owned = new Set(installOwnedColumns(questionSet));
  const probabilities = new Set(
    questionSet.questions.flatMap((question) =>
      question.type === "choice"
        ? answerColumns({ ...question, storeProbabilities: true })
            .filter((column) => column.role === "probabilities")
            .map((column) => column.name)
        : [],
    ),
  );
  return catalog.columns.filter(
    (name) => name !== source.key && !owned.has(name) && probabilities.has(name),
  );
}

/** The catalog's columns of questions no longer in the set: the ones `prune` drops. */
export function prunedColumns(
  source: Pick<TableSource, "key">,
  questionSet: QuestionSet,
  catalog: PruneCatalog,
): readonly string[] {
  const owned = new Set(installOwnedColumns(questionSet));
  const kept = new Set(keptColumns(source, questionSet, catalog));
  return catalog.columns.filter(
    (name) => name !== source.key && !owned.has(name) && !kept.has(name),
  );
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
  const revoked = revokedColumns(source, questionSet, catalog);
  if (removed.length === 0 && revoked.length === 0) {
    return [];
  }
  const table = quoteTable({ schema: source.schema, name: source.table });
  const revokes = [
    ...revoked.map((name, index) =>
      plain(
        `${index === 0 ? REVOKE_NOTE : ""}revoke select (${quoteIdent(name)}) on ${table} from ${quoteIdent(WORKER_ROLE)}`,
      ),
    ),
    ...(revoked.length === 0 ? [] : revokedCheck(source, revoked)),
  ];
  if (removed.length === 0) {
    return [...SCRIPT_HEADER, ...revokes];
  }
  if (source.storage !== "side-table") {
    return [
      ...SCRIPT_HEADER,
      ...revokes,
      ...removed.map((name) => plain(`alter table ${table} drop column ${quoteIdent(name)}`)),
    ];
  }
  const side = sideTableRelation(source);
  const present = new Set(catalog.columns);
  const keptNames = new Set(keptColumns(source, questionSet, catalog));
  const remaining = [
    ...ownedColumnDefinitions(questionSet).filter(([name]) => present.has(name)),
    ...catalog.columns
      .filter((name) => keptNames.has(name))
      .map((name): readonly [string, string] => [name, "jsonb"]),
  ];
  return [
    ...SCRIPT_HEADER,
    ...revokes,
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
      /** Marked columns that stay, one line each with the reason: `<column>: kept (storeProbabilities is off)`. */
      readonly kept: readonly string[];
      /**
       * What the prune could not do, one line each: a worker grant on a removed state column made by
       * another role (`<column>: a grant by <role> remains; only that role can revoke it`).
       */
      readonly notes: readonly string[];
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
    const catalog = {
      columns: installed.sideColumns ?? installed.marked,
      workerSelect: (
        await client.query(WORKER_SELECT_QUERY, [installed.schema, installed.table, WORKER_ROLE])
      ).map((row) => String(row["name"])),
    };
    const dropped = prunedColumns(source, options.questionSet, catalog);
    const kept = keptColumns(source, options.questionSet, catalog).map(
      (name) => `${name}: ${KEPT_NOTE}`,
    );
    const revoked = new Set(revokedColumns(source, options.questionSet, catalog));
    const notes = (
      await client.query(FOREIGN_GRANTS_QUERY, [installed.schema, installed.table, WORKER_ROLE])
    )
      .filter((row) => revoked.has(String(row["name"])))
      .map(
        (row) =>
          `${String(row["name"])}: a grant by ${String(row["grantor"])} remains; only that role can revoke it`,
      );
    const statements = pruneSql(source, options.questionSet, catalog);
    if (statements.length === 0) {
      return { ok: true, dropped, kept, notes, statements, sql: "", applied: false };
    }
    const sql = renderSql(statements);
    options.print(sql);
    if (options.dryRun === true) {
      return { ok: true, dropped, kept, notes, statements, sql, applied: false };
    }
    try {
      await client.transaction(async (query) => {
        for (const statement of statements) {
          await query(statement.text, statement.params);
        }
      });
    } catch (error) {
      // The script's own check (`revokedCheck`) rolled everything back: a refusal, in its words.
      if (error instanceof Error && "code" in error && error.code === NOT_REVOKED_STATE) {
        return { ok: false, reason: error.message.replace(/^FacetDB: /, "") };
      }
      throw error;
    }
    return { ok: true, dropped, kept, notes, statements, sql, applied: true };
  } finally {
    await client.close();
  }
}
