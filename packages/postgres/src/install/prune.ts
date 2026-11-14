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
  type SqlQuery,
} from "../sql/index.ts";
import { type NotInstalled, readInstalled, SCRIPT_HEADER, settingsStatement } from "./catalog.ts";
import {
  type InstallStatement,
  installOwnedColumns,
  ownedColumnDefinitions,
  type ProjectRef,
  plain,
  type RoleSuffix,
  renderSql,
  SCHEMA_SETTING,
  TABLE_SETTING,
  type TableSource,
  workerRole,
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
  worker: string,
): readonly InstallStatement[] {
  return [
    settingsStatement([
      [SCHEMA_SETTING, source.schema ?? "public"],
      [TABLE_SETTING, source.table],
      [REVOKED_SETTING, JSON.stringify(revoked)],
    ]),
    // Only a grant this revoke should have taken back stops it: install's (the owner's) or the
    // running role's own. Another grantor's (a DBA's) stays with a note (`FOREIGN_GRANTS_QUERY`).
    plain(
      "grants",
      `do $$
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
     and x.grantee = (select oid from pg_catalog.pg_roles where rolname = ${quoteLiteral(worker)})
     and x.grantor in (c.relowner, (select oid from pg_catalog.pg_roles where rolname = current_user));
  if still is not null then
    raise exception using errcode = ${quoteLiteral(NOT_REVOKED_STATE)}, message = format(${quoteLiteral(
      "FacetDB: %s.%s: the worker login still reads %s after the revoke; Postgres takes back only grants made by the role that runs it, and install's grants are the table owner's. Run migrate --prune as the table's owner or a member of its role; nothing was changed.",
    )}, current_setting('${SCHEMA_SETTING}'), current_setting('${TABLE_SETTING}'), still);
  end if;
end $$`,
    ),
  ];
}

/**
 * The check above, which rolls the whole prune back (`NOT_REVOKED_STATE`), as the refusal it is, in
 * its own words; undefined for any other error. The driver's error is a boundary, read by its code.
 */
export function pruneRefusal(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && error.code === NOT_REVOKED_STATE
    ? error.message.replace(/^FacetDB: /, "")
    : undefined;
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

/** Why a marked column stays although the set no longer owns it: the engine's keep says it. */
export const KEPT_REASON = "storeProbabilities is off";

/** What the output says about a marked column that stays although the set no longer owns it. */
export const KEPT_NOTE = `kept (${KEPT_REASON})`;

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

/** A worker grant on a revoked column made by another role: only that role can take it back. */
export type ForeignGrant = { readonly column: string; readonly grantor: string };

/** A column the prune drops, and why, in words the CLI prints as they are. */
export type DroppedColumn = { readonly column: string; readonly reason: string };

/** Every column a question of this name could have, whatever its type (`answerColumns` of each). */
function columnsOfAnyType(name: string): ReadonlySet<string> {
  const base = { name, instructions: "", stakes: "low" } as const;
  return new Set(
    [
      answerColumns({ ...base, type: "noul" }),
      answerColumns({ ...base, type: "choice", options: [], storeProbabilities: true }),
      answerColumns({ ...base, type: "score", levels: [] }),
    ].flatMap((columns) => columns.map((column) => column.name)),
  );
}

/**
 * Why a pruned column goes: a column a question still in the set had under another type (its
 * question changed type), or one no question of the set asks about any more.
 */
export function droppedColumns(
  source: Pick<TableSource, "key">,
  questionSet: QuestionSet,
  catalog: PruneCatalog,
): readonly DroppedColumn[] {
  const stillAsked = questionSet.questions.map((question) => columnsOfAnyType(question.name));
  return prunedColumns(source, questionSet, catalog).map((column) => ({
    column,
    reason: stillAsked.some((columns) => columns.has(column))
      ? "its question changed type"
      : "no question asks it any more",
  }));
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
  options: { readonly roleSuffix?: RoleSuffix } = {},
): readonly InstallStatement[] {
  const removed = prunedColumns(source, questionSet, catalog);
  const revoked = revokedColumns(source, questionSet, catalog);
  if (removed.length === 0 && revoked.length === 0) {
    return [];
  }
  const table = quoteTable({ schema: source.schema, name: source.table });
  const worker = workerRole(options.roleSuffix);
  const revokes = [
    ...revoked.map((name, index) =>
      plain(
        "grants",
        `${index === 0 ? REVOKE_NOTE : ""}revoke select (${quoteIdent(name)}) on ${table} from ${quoteIdent(worker)}`,
      ),
    ),
    ...(revoked.length === 0 ? [] : revokedCheck(source, revoked, worker)),
  ];
  if (removed.length === 0) {
    return [...SCRIPT_HEADER, ...revokes];
  }
  if (source.storage !== "side-table") {
    return [
      ...SCRIPT_HEADER,
      ...revokes,
      ...removed.map((name) =>
        plain("columns", `alter table ${table} drop column ${quoteIdent(name)}`),
      ),
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
    }).map((text) => plain("columns", text)),
  ];
}

/** @deprecated as an export: `EngineTarget` (core) with `postgresEngine.planPrune`. */
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
  /** The install's own role names (`RoleSuffix`); tests only. */
  readonly roleSuffix?: RoleSuffix;
};

/**
 * @deprecated as an export: the `EnginePlan` of `postgresEngine.planPrune` (its removes, keeps and
 * notes) and the `RunResult` of `run`.
 */
export type PruneResult =
  | {
      readonly ok: true;
      /** The columns dropped (or to drop, on a dry run), each with why; empty when nothing was left to prune. */
      readonly dropped: readonly DroppedColumn[];
      /** Marked columns that stay, one line each with the reason: `<column>: kept (storeProbabilities is off)`. */
      readonly kept: readonly string[];
      /**
       * The source table's columns whose select the worker loses (a state column `read` no longer
       * lists), the same list the script's `revoke` statements are made from.
       */
      readonly revoked: readonly string[];
      /**
       * What the prune could not do, one line each: a worker grant on a removed state column made by
       * another role (`<column>: a grant by <role> remains; only that role can revoke it`).
       */
      readonly notes: readonly string[];
      /** The grants the notes are about: a revoked column the worker still reads through another role. */
      readonly foreignGrants: readonly ForeignGrant[];
      readonly statements: readonly InstallStatement[];
      /** The printed script; empty, and nothing printed or run, when there is nothing to prune. */
      readonly sql: string;
      readonly applied: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/** The prune as planned, before anything is printed or run: `prune`'s and the engine's. */
export type PruneDraft =
  | {
      readonly ok: true;
      /** The table as the catalog shows it, `schema.table`. */
      readonly table: string;
      readonly dropped: readonly DroppedColumn[];
      /** The marked columns that stay, each for `KEPT_REASON`. */
      readonly keptColumns: readonly string[];
      /** The source table's columns whose select the worker loses. */
      readonly revoked: readonly string[];
      /** One line per grant another role made on a revoked column, which only that role can take back. */
      readonly notes: readonly string[];
      readonly foreignGrants: readonly ForeignGrant[];
      /** Empty when there is nothing to prune. */
      readonly statements: readonly InstallStatement[];
    }
  | ({ readonly ok: false } & NotInstalled);

/**
 * Reads the catalog with `query` and writes the prune script, or says in plain words why the table
 * cannot be pruned (`absent` when nothing of FacetDB's is on it yet). Nothing is changed. The
 * storage mode comes from what install left (a marked side table means side-table mode), so a
 * config that changed its mind cannot point the drops at the wrong relation.
 */
export async function draftPrune(
  query: SqlQuery,
  options: Pick<PruneOptions, "source" | "questionSet" | "project" | "roleSuffix">,
): Promise<PruneDraft> {
  const installed = await readInstalled(query, options.source);
  if ("reason" in installed) {
    return { ok: false, ...installed };
  }
  if (installed.project.id !== options.project.id) {
    return {
      ok: false,
      reason: `${installed.schema}.${installed.table} belongs to another project (${installed.project.id}); prune it from that project.`,
      absent: false,
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
  const worker = workerRole(options.roleSuffix);
  const catalog = {
    columns: installed.sideColumns ?? installed.marked,
    // One row per grantor: a column two roles granted is one column to revoke, listed once.
    workerSelect: [
      ...new Set(
        (await query(WORKER_SELECT_QUERY, [installed.schema, installed.table, worker])).map((row) =>
          String(row["name"]),
        ),
      ),
    ],
  };
  const revoked = revokedColumns(source, options.questionSet, catalog);
  const foreignGrants = (
    await query(FOREIGN_GRANTS_QUERY, [installed.schema, installed.table, worker])
  )
    .map((row) => ({ column: String(row["name"]), grantor: String(row["grantor"]) }))
    .filter((grant) => revoked.includes(grant.column));
  return {
    ok: true,
    table: `${installed.schema}.${installed.table}`,
    dropped: droppedColumns(source, options.questionSet, catalog),
    keptColumns: keptColumns(source, options.questionSet, catalog),
    revoked,
    notes: foreignGrants.map(
      ({ column, grantor }) =>
        `${column}: a grant by ${grantor} remains; only that role can revoke it`,
    ),
    foreignGrants,
    statements: pruneSql(
      source,
      options.questionSet,
      catalog,
      options.roleSuffix === undefined ? {} : { roleSuffix: options.roleSuffix },
    ),
  };
}

/**
 * Reads the catalog, prints the prune script and runs exactly its statements in one transaction.
 *
 * @deprecated as an export: `postgresEngine.planPrune`, `render` and `run`.
 */
export async function prune(options: PruneOptions): Promise<PruneResult> {
  const client = (options.connect ?? connectPostgres)(options.adminUrl);
  try {
    const draft = await draftPrune(client.query, options);
    if (!draft.ok) {
      return { ok: false, reason: draft.reason };
    }
    const { dropped, revoked, notes, foreignGrants, statements } = draft;
    const kept = draft.keptColumns.map((name) => `${name}: ${KEPT_NOTE}`);
    const listed = { dropped, kept, revoked, notes, foreignGrants };
    if (statements.length === 0) {
      return { ok: true, ...listed, statements, sql: "", applied: false };
    }
    const sql = renderSql(statements);
    options.print(sql);
    if (options.dryRun === true) {
      return { ok: true, ...listed, statements, sql, applied: false };
    }
    try {
      await client.transaction(async (query) => {
        for (const statement of statements) {
          await query(statement.text, statement.params);
        }
      });
    } catch (error) {
      // The script's own check (`revokedCheck`) rolled everything back: a refusal, in its words.
      const refused = pruneRefusal(error);
      if (refused !== undefined) {
        return { ok: false, reason: refused };
      }
      throw error;
    }
    return { ok: true, ...listed, statements, sql, applied: true };
  } finally {
    await client.close();
  }
}
