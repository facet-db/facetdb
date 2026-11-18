import { type PlanStatement, REVIEWED_COLUMN, type Refusal, STATUS_COLUMN } from "@facetdb/core";
import {
  type MysqlQuery,
  type MysqlRow,
  quoteIdent,
  quoteLiteral,
  quoteTable,
} from "../sql/index.ts";
import { type CatalogColumn, readColumns, readGrantTable, readPrimaryKey } from "./catalog.ts";
import { installRefused } from "./refusals.ts";
import {
  type CaptureSource,
  enqueue,
  NAME_LIMIT,
  OWNED_MARK,
  type OwnedColumn,
  sourceStatement,
  stateChanged,
  type TriggerDefinition,
  triggerNames,
  WORKER_USER,
} from "./sql.ts";

/**
 * Side-table mode on MySQL and MariaDB: the answer and status columns live in
 * `facetdb_<table>_answers`, keyed by the table's primary key in its own type, beside the table in
 * its database (MySQL has no schema inside a database, so FacetDB's prefix stands where Postgres
 * has the `facetdb` schema, as the queue's `facetdb_jobs` does), and the view
 * `<table>_with_answers` joins the two. The application's table gains no column: for teams whose
 * ORM manages the schema. Change capture is the inline mode's: triggers on the table queue a
 * changed record in the shared `facetdb_jobs`; in this mode they also upsert the record's side row,
 * inside the application's transaction, so a state change and the worker's guarded write meet on
 * that one row (the connector's `write`). The worker writes the side table only. This module owns
 * the names, the catalog read and the SQL pieces of the variant; the install, uninstall and prune
 * plans compose them.
 */

/** `facetdb_<table>_answers`: the side table, in the table's database. */
export function sideTableName(table: string): string {
  return `facetdb_${table}_answers`;
}

/** `<table>_with_answers`, the view's name, in the table's database. */
export function sideViewName(table: string): string {
  return `${table}_with_answers`;
}

/** The side table's foreign key to the table, named so uninstall and a reader of the catalog find it. */
export function sideKeyConstraint(table: string): string {
  return `facetdb_${table}_fk`;
}

/** The longest table name whose side table's name fits MySQL's 64 characters. */
export const SIDE_TABLE_NAME_LIMIT = NAME_LIMIT - sideTableName("").length;

/** The rights the worker holds on the side table: it reads, inserts and updates its rows (and may delete them). */
export const SIDE_TABLE_PRIVILEGES = ["select", "insert", "update", "delete"] as const;

/**
 * An account as `mysql.tables_priv` lists it: a user and a host. A MariaDB role is listed with an
 * empty host and named without one; whether it is a role is the catalog's word (`is_role`), never
 * the empty host's, since `'u'@''` is an account of its own on both engines. A MySQL 8 role is an
 * account like any other, named with its host.
 */
export type Account = { readonly user: string; readonly host: string; readonly role: boolean };

/** An account's table-level rights on one table, as `mysql.tables_priv` lists them (`Select`, `Insert`). */
export type TableGrant = {
  readonly account: Account;
  readonly table: string;
  readonly privileges: readonly string[];
};

/** A relation of the database as `information_schema.tables` shows it, or absent. */
export type Relation = {
  /** `BASE TABLE` or `VIEW`; undefined when there is none of the name. */
  readonly type: string | undefined;
  /** `InnoDB`, `MyISAM`; undefined for a view or no relation. */
  readonly engine: string | undefined;
  /** `partitioned` among them for a partitioned table. */
  readonly createOptions: string;
  readonly comment: string;
};

/** What side-table mode reads beyond the install's catalog, before it plans a statement. */
export type SideCatalog = {
  readonly schema: string;
  /** The application's table, by name. */
  readonly table: string;
  /** The application's table: its engine decides whether side-table mode may install here. */
  readonly source: Relation;
  readonly side: Relation & {
    readonly columns: readonly CatalogColumn[];
    readonly primaryKey: readonly string[];
  };
  readonly view: Relation & {
    /** `INVOKER` or `DEFINER`; undefined when there is no view of the name. */
    readonly security: string | undefined;
    /** The text the server keeps for it, every name qualified and quoted. */
    readonly definition: string;
    /** Its columns in order, as the server expanded `t.*` when the view was made. */
    readonly columns: readonly string[];
  };
  /** Every account's table-level rights on the table, the side table and the view. */
  readonly grants: readonly TableGrant[];
};

const RELATION = `select table_type as type, engine as engine, create_options as create_options, table_comment as table_comment
  from information_schema.tables where table_schema = ? and table_name = ?`;

const VIEW = `select security_type as security_type, view_definition as definition
  from information_schema.views where table_schema = ? and table_name = ?`;

/**
 * Who holds what on the three tables, every account (the readers the view must serve among them).
 * `mysql.tables_priv` rather than `information_schema.table_privileges`, whose `grantee` is one
 * quoted text a name with a quote in it would make ambiguous; the admin reads the `mysql` schema
 * already (`workerHosts`).
 */
const TABLE_GRANTS = `select user as user_name, host as host_name, table_name as table_name, table_priv as privileges
  from mysql.tables_priv where db = ? and table_name in (?, ?, ?)
 order by table_name, user, host`;

/**
 * MariaDB's roles: `mysql.user` says which names are roles (a column MySQL 8 does not have). Compared
 * by character code: the column's collation is not the connection's, and `=` on the two texts is
 * refused (error 1267, "Illegal mix of collations").
 */
const MARIADB_ROLES = "select user as user_name from mysql.user where ord(is_role) = ord('Y')";

function text(value: unknown): string {
  return value === null || value === undefined ? "" : String(value);
}

function optional(value: unknown): string | undefined {
  return value === null || value === undefined ? undefined : String(value);
}

/**
 * A relation of the database as the login sees it: the side catalog's three, the inline install's
 * look for a side table, and the worker's look at the table's engine at `open` and in doctor
 * (`engineRefusal`).
 */
export async function readRelation(
  query: MysqlQuery,
  schema: string,
  name: string,
): Promise<Relation> {
  const [row] = await query(RELATION, [schema, name]);
  return {
    type: optional(row?.["type"]),
    engine: optional(row?.["engine"]),
    createOptions: text(row?.["create_options"]),
    comment: text(row?.["table_comment"]),
  };
}

function tableGrant(row: MysqlRow, roles: ReadonlySet<string>): TableGrant {
  const user = text(row["user_name"]);
  const host = text(row["host_name"]);
  return {
    account: { user, host, role: host === "" && roles.has(user) },
    table: text(row["table_name"]),
    // A SET column: the privileges as one comma-separated text.
    privileges: text(row["privileges"])
      .split(",")
      .filter((privilege) => privilege !== "")
      .map((privilege) => privilege.toUpperCase()),
  };
}

/**
 * The table, its side table and its view as side-table mode needs them. Nothing is changed.
 * `mariadb`: whether the server is MariaDB (`isMariaDb`), whose roles the catalog names apart.
 */
export async function readSideCatalog(
  query: MysqlQuery,
  schema: string,
  table: string,
  mariadb: boolean,
): Promise<SideCatalog> {
  const sideName = sideTableName(table);
  const viewName = sideViewName(table);
  const source = await readRelation(query, schema, table);
  const side = await readRelation(query, schema, sideName);
  const view = await readRelation(query, schema, viewName);
  const [viewRow] = view.type === "VIEW" ? await query(VIEW, [schema, viewName]) : [];
  const roles = new Set(
    mariadb
      ? (await readGrantTable(query, "user", MARIADB_ROLES)).map((row) => text(row["user_name"]))
      : [],
  );
  return {
    schema,
    table,
    source,
    side: {
      ...side,
      columns: side.type === undefined ? [] : await readColumns(query, schema, sideName),
      primaryKey: side.type === undefined ? [] : await readPrimaryKey(query, schema, sideName),
    },
    view: {
      ...view,
      security: optional(viewRow?.["security_type"])?.toUpperCase(),
      definition: text(viewRow?.["definition"]),
      columns:
        view.type === undefined
          ? []
          : (await readColumns(query, schema, viewName)).map((column) => column.name),
    },
    grants: (
      await readGrantTable(query, "tables_priv", TABLE_GRANTS, [schema, table, sideName, viewName])
    ).map((row) => tableGrant(row, roles)),
  };
}

/** An account as a grant or a revoke names it: `'user'@'host'` (an empty host quoted too), a MariaDB role by its name. */
export function accountSql(account: Account): string {
  return account.role
    ? quoteLiteral(account.user)
    : `${quoteLiteral(account.user)}@${quoteLiteral(account.host)}`;
}

/**
 * A view's text in a form both engines' stored texts reduce to: outside quoted names and string
 * literals, no whitespace and no parentheses, in lower case. MySQL keeps `on((a = b))` where
 * MariaDB keeps `on(a = b)`; the names and literals, where a customer's text would differ, stay.
 */
export function normalizedDefinition(definition: string): string {
  let out = "";
  let index = 0;
  while (index < definition.length) {
    const char = definition[index] ?? "";
    if (char === "`" || char === "'") {
      // A quoted name or literal, its doubled quotes and (in a literal) backslash escapes kept whole.
      let end = index + 1;
      while (end < definition.length) {
        const at = definition[end];
        if (at === "\\" && char === "'") {
          end += 2;
          continue;
        }
        if (at === char) {
          if (definition[end + 1] === char) {
            end += 2;
            continue;
          }
          break;
        }
        end += 1;
      }
      out += definition.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (!/[\s()]/.test(char)) {
      out += char.toLowerCase();
    }
    index += 1;
  }
  return out;
}

/** What a column of the side table reads as for a record without a side row: inline mode's defaults. */
const NO_ROW: Readonly<Record<string, string>> = {
  [STATUS_COLUMN]: "'pending'",
  // `0` and not `false`: MariaDB stores `false` as `0` in a view's text, so `0` reads back alike on both.
  [REVIEWED_COLUMN]: "0",
};

/**
 * The text a server keeps for the view the plan makes over these columns (its `t.*` expanded),
 * as MySQL prints it: every column through its alias, the tables qualified, the join's condition.
 */
export function storedViewDefinition(
  schema: string,
  table: string,
  key: string,
  tableColumns: readonly string[],
  answerColumns: readonly string[],
): string {
  const selected = [
    ...tableColumns.map((name) => `\`t\`.${quoteIdent(name)} AS ${quoteIdent(name)}`),
    ...answerColumns.map((name) => {
      const fallback = NO_ROW[name];
      const column = `\`a\`.${quoteIdent(name)}`;
      return fallback === undefined
        ? `${column} AS ${quoteIdent(name)}`
        : `coalesce(${column},${fallback}) AS ${quoteIdent(name)}`;
    }),
  ];
  return `select ${selected.join(",")} from (${quoteTable(schema, table)} \`t\` left join ${quoteTable(schema, sideTableName(table))} \`a\` on((\`a\`.${quoteIdent(key)} = \`t\`.${quoteIdent(key)})))`;
}

/**
 * Whether the view of the name is FacetDB's: a view whose stored text is, but for the engine's
 * spacing and parentheses, the one the plan makes over the columns it lists now (the table's,
 * then the side table's marked ones), so a customer's view of the name, even one that reads the
 * side table, is never replaced or dropped. A view FacetDB made before the application added a
 * column still lists the columns of then, and is still recognised.
 */
export function viewIsOurs(side: SideCatalog): boolean {
  if (side.view.type !== "VIEW") {
    return false;
  }
  const [key] = side.side.primaryKey;
  if (key === undefined) {
    return false;
  }
  const answers = new Set(
    side.side.columns
      .filter((column) => column.comment === OWNED_MARK)
      .map((column) => column.name),
  );
  const expected = storedViewDefinition(
    side.schema,
    side.table,
    key,
    side.view.columns.filter((name) => !answers.has(name)),
    side.view.columns.filter((name) => answers.has(name)),
  );
  return normalizedDefinition(side.view.definition) === normalizedDefinition(expected);
}

/** Whether a relation is a table FacetDB made: a base table carrying the mark. */
export function markedTable(relation: Relation): boolean {
  return relation.type === "BASE TABLE" && relation.comment === OWNED_MARK;
}

/** Whether the side table of the name is FacetDB's: a base table carrying the mark. */
export function sideTableIsOurs(side: SideCatalog): boolean {
  return markedTable(side.side);
}

/**
 * Whether the side table may reference the table: always, on the InnoDB table side-table mode
 * requires (`engineRefusal`), but a partitioned one, which InnoDB's foreign keys refuse on MySQL
 * and MariaDB alike.
 */
export function foreignKeyAllowed(side: SideCatalog): boolean {
  return !side.source.createOptions.toLowerCase().includes("partitioned");
}

/**
 * Side-table mode needs an InnoDB table. The worker's write holds the side row's InnoDB lock while
 * it reads the table; on a MyISAM or Aria table an application update takes the table's own write
 * lock, changes the row (with nothing to roll back) and waits in its trigger for that side row,
 * while the worker's read waits for the table lock: InnoDB's deadlock detection cannot see a table
 * lock, so both wait out `innodb_lock_wait_timeout`, every reader of the table stalls meanwhile,
 * and the application's statement fails with its change kept and never queued. Install refuses such
 * a table; doctor and the connector's `open` read the engine again, since a table converted after
 * install brings the wait back, and say it in these words.
 */
export function engineRefusal(tableEngine: string | undefined, label: string): Refusal | undefined {
  const engine = tableEngine ?? "";
  return engine.toLowerCase() === "innodb"
    ? undefined
    : {
        code: "table-engine",
        message: `${label} is a ${engine === "" ? "non-InnoDB" : engine} table; side-table mode keeps the answers in an InnoDB table beside it and serializes the worker's write with the application's on InnoDB's row locks, which a ${engine === "" ? "non-InnoDB" : engine} table does not take, so the two could wait on each other until a lock timeout`,
        fix: `convert the table to InnoDB (alter table ${label} engine = InnoDB), or set storage "inline" for this source, then run facetdb migrate again`,
      };
}

/** A name FacetDB means to give an object of its own, taken by someone else's. */
function nameTaken(message: string): Refusal {
  return {
    code: "name-taken",
    message,
    fix: "rename or drop that object if nothing uses it, or rename the table, then run facetdb migrate again",
  };
}

/**
 * Why side-table mode must not install here, beyond inline mode's refusals of the table itself;
 * undefined when it may. The column checks of the side table's own columns are inline mode's
 * `columnsRefusal`, which the planner runs on them.
 */
export function sideRefusal(
  catalogColumns: readonly CatalogColumn[],
  side: SideCatalog,
  schema: string,
  table: string,
  key: string,
  owned: readonly OwnedColumn[],
): Refusal | undefined {
  const label = `${schema}.${table}`;
  const sideLabel = `${schema}.${sideTableName(table)}`;
  const viewLabel = `${schema}.${sideViewName(table)}`;
  const engine = engineRefusal(side.source.engine, label);
  if (engine !== undefined) {
    return engine;
  }
  const inline = catalogColumns.filter((column) => column.comment === OWNED_MARK);
  if (inline.length > 0) {
    return installRefused(
      `${label} carries FacetDB's columns ${inline.map((column) => column.name).join(", ")} from an install in inline mode; side-table mode leaves the table alone. Set storage "inline" back and run facetdb uninstall, then set "side-table" and run facetdb migrate; or keep storage "inline".`,
    );
  }
  const ownedNames = new Set(owned.map((column) => column.name));
  const clashing = catalogColumns.filter((column) => ownedNames.has(column.name));
  if (clashing.length > 0) {
    return installRefused(
      `${label} has a column named ${clashing.map((column) => column.name).join(", ")}, a name the view ${viewLabel} gives one of FacetDB's columns; rename the question or the column.`,
    );
  }
  if (side.side.type !== undefined && !sideTableIsOurs(side)) {
    return nameTaken(
      `${sideLabel} exists and is not FacetDB's side table (it is not a table with the comment '${OWNED_MARK}'); side-table mode keeps the answers of ${label} under that name`,
    );
  }
  if (side.side.type !== undefined && side.side.primaryKey.join(", ") !== key) {
    return installRefused(
      `${sideLabel} is keyed by (${side.side.primaryKey.join(", ")}), not by ${key}, the primary key of ${label}; it holds FacetDB's answers only, so drop it and run facetdb migrate again.`,
    );
  }
  if (side.view.type !== undefined && !viewIsOurs(side)) {
    return nameTaken(
      `${viewLabel} exists and is not the view FacetDB makes (its text is not the join of ${label} and ${sideLabel} FacetDB writes); side-table mode gives that name to its view`,
    );
  }
  return undefined;
}

/** A name a catalog returned, written into a column definition: a plain word or nothing at all. */
function plainWord(value: string, what: string): string {
  if (!/^\w+$/.test(value)) {
    throw new Error(`information_schema gave the ${what} "${value}", not a plain name`);
  }
  return value;
}

/**
 * The key column of the side table: the table's key in its own type, character set and collation
 * (a foreign key needs them equal, and a join on equal types uses the index), never its
 * `auto_increment`: the side row takes the record's key.
 */
function keyDefinition(key: CatalogColumn): string {
  const text =
    key.charset === undefined || key.collation === undefined
      ? ""
      : ` character set ${plainWord(key.charset, "character set")} collate ${plainWord(key.collation, "collation")}`;
  return `${quoteIdent(key.name)} ${key.type}${text} not null primary key`;
}

/**
 * The side table: the key, then the columns inline mode adds to the table (same definitions, same
 * marks, same order), InnoDB as the table is (`engineRefusal`), since the worker's write locks its
 * row in a transaction. With `foreignKey`, the key references the table `on delete cascade` (a
 * deleted record takes its answers with it, so a record inserted again under the key starts fresh,
 * as in inline mode; the Postgres side table's rule) and `on update cascade` (an application that
 * changes a record's key keeps its answers, and its update is never refused for a row FacetDB
 * owns). Without it the plan says what a delete leaves.
 */
export function createSideTableStatement(
  schema: string,
  table: string,
  key: CatalogColumn,
  owned: readonly OwnedColumn[],
  foreignKey: boolean,
): PlanStatement {
  const lines = [
    `  ${keyDefinition(key)}`,
    ...owned.map(
      (column) =>
        `  ${quoteIdent(column.name)} ${column.definition} comment ${quoteLiteral(OWNED_MARK)}`,
    ),
    ...(foreignKey
      ? [
          `  constraint ${quoteIdent(sideKeyConstraint(table))} foreign key (${quoteIdent(key.name)}) references ${quoteTable(schema, table)} (${quoteIdent(key.name)})\n    on delete cascade on update cascade`,
        ]
      : []),
  ];
  return sourceStatement(
    "columns",
    `create table if not exists ${quoteTable(schema, sideTableName(table))} (
${lines.join(",\n")}
) engine = InnoDB default charset = utf8mb4 comment = ${quoteLiteral(OWNED_MARK)}`,
  );
}

/** What the insert trigger writes into a side row it finds left over: the columns' own defaults. */
const FRESH: Readonly<Record<string, string>> = {
  [STATUS_COLUMN]: "'pending'",
  [REVIEWED_COLUMN]: "false",
};

/**
 * The view: the table's columns, then FacetDB's, by a left join on the key, so a record without a
 * side row (one there before the install) reads as pending and unreviewed. `sql security invoker`:
 * whoever reads it needs select on the table and on the side table, so the view shows no account
 * more than the table already does (a definer's view would let anyone granted the view read the
 * table through its creator's rights). MySQL expands `t.*` when it creates the view, so the plan
 * re-creates it, `create or replace`, whenever the columns it lists are not the table's now.
 * `columns` are FacetDB's, by name, in the side table's order.
 */
export function createViewStatement(
  schema: string,
  table: string,
  key: string,
  columns: readonly string[],
): PlanStatement {
  const selected = columns.map((name) => {
    const fallback = NO_ROW[name];
    const column = `a.${quoteIdent(name)}`;
    return fallback === undefined
      ? column
      : `coalesce(${column}, ${fallback}) as ${quoteIdent(name)}`;
  });
  return sourceStatement(
    "columns",
    `create or replace sql security invoker view ${quoteTable(schema, sideViewName(table))} as
select t.*,
  ${selected.join(",\n  ")}
  from ${quoteTable(schema, table)} t
  left join ${quoteTable(schema, sideTableName(table))} a on a.${quoteIdent(key)} = t.${quoteIdent(key)}`,
  );
}

/** The view's columns as the plan would make it: the table's, then FacetDB's. */
export function viewColumns(
  catalogColumns: readonly CatalogColumn[],
  owned: readonly OwnedColumn[],
): readonly string[] {
  return [...catalogColumns.map((column) => column.name), ...owned.map((column) => column.name)];
}

/** Whether the view of the name is the one the plan makes: invoker's rights, the columns of now. */
export function viewCurrent(
  side: SideCatalog,
  table: string,
  catalogColumns: readonly CatalogColumn[],
  owned: readonly OwnedColumn[],
): boolean {
  return (
    viewIsOurs(side) &&
    side.view.security === "INVOKER" &&
    side.view.columns.join("\n") === viewColumns(catalogColumns, owned).join("\n")
  );
}

/** What each of FacetDB's columns holds before the first answer: what a record inserted again starts from. */
function freshValue(column: OwnedColumn): string {
  return FRESH[column.name] ?? "null";
}

/**
 * The side row's upsert inside a trigger. On insert the record is new: its side row starts fresh,
 * a leftover row of a deleted record under the same key included (one the foreign key could not
 * take with it). On a state change with `reset` the row goes back to pending, as inline mode's
 * `set new.facetdb_status` does; with `keep` it keeps its status and the update assigns the status
 * to itself, which still locks the row: that lock is what the worker's `write` serializes on, so a
 * state change waits for a write in flight and a write that comes after it sees the new state.
 */
function upsertSideRow(
  source: CaptureSource,
  owned: readonly OwnedColumn[],
  on: "insert" | "update",
  indent: string,
): string {
  const status = quoteIdent(STATUS_COLUMN);
  const assignments =
    on === "insert"
      ? owned.map((column) => `${quoteIdent(column.name)} = ${freshValue(column)}`).join(", ")
      : source.onChange === "reset"
        ? `${status} = 'pending'`
        : `${status} = ${status}`;
  return `${indent}insert into ${quoteTable(source.schema, sideTableName(source.table))} (${quoteIdent(source.key)}) values (new.${quoteIdent(source.key)})
${indent}  on duplicate key update ${assignments}`;
}

/**
 * The triggers of a table in side-table mode (as inline mode's `triggerDefinitions`): after an
 * insert, the record's side row and its job; after an update that changed a state column, the same.
 * Both run after the row is written, so the side row's foreign key finds the record, a new key
 * included; they read no column FacetDB writes and set none on the table, so no `_new` trigger and
 * nothing of the worker's (it writes the side table only) can fire them. Inside the application's
 * transaction: the side row, the job and the record commit together.
 */
export function sideTriggerDefinitions(
  source: CaptureSource,
  owned: readonly OwnedColumn[],
): readonly TriggerDefinition[] {
  const names = triggerNames(source.table);
  return [
    {
      name: names.insert,
      timing: "after",
      event: "insert",
      body: `begin\n${upsertSideRow(source, owned, "insert", "  ")};\n${enqueue(source, "  ")};\nend`,
    },
    {
      name: names.update,
      timing: "after",
      event: "update",
      body: `begin\n  if ${stateChanged(source)} then\n${upsertSideRow(source, owned, "update", "    ")};\n${enqueue(source, "    ")};\n  end if;\nend`,
    },
  ];
}

/** A table-level grant to other accounts than the worker: a reader of the view. */
export function readerGrantStatement(
  schema: string,
  table: string,
  accounts: readonly Account[],
): PlanStatement {
  return sourceStatement(
    "grants",
    `grant select on ${quoteTable(schema, table)} to ${accounts.map(accountSql).join(", ")}`,
  );
}

/** Whether an account holds a table-level privilege on a table, as `mysql.tables_priv` lists it. */
export function heldBy(
  grants: readonly TableGrant[],
  account: Account,
  table: string,
  privilege: string,
): boolean {
  return grants.some(
    (grant) =>
      grant.table === table &&
      grant.account.user === account.user &&
      grant.account.host === account.host &&
      grant.privileges.includes(privilege.toUpperCase()),
  );
}

/**
 * The accounts that read the table (a table-level select on it), the worker aside: the view runs
 * with their rights, so each needs select on the view and on the side table to read it. Accounts
 * that read the whole database or the server need nothing more.
 */
export function readersOf(side: SideCatalog, table: string): readonly Account[] {
  return side.grants
    .filter(
      (grant) =>
        grant.table === table &&
        grant.account.user !== WORKER_USER &&
        grant.privileges.includes("SELECT"),
    )
    .map((grant) => grant.account);
}

/**
 * Every account's rights on one of FacetDB's two side objects, taken back exactly as listed. A right
 * held `with grant option` is listed as the privilege `Grant`, which no `revoke <privileges>` names:
 * it is taken back by a `revoke grant option` of its own, after the privileges, so neither statement
 * names a right the account does not hold (a revoke of one fails on MySQL and MariaDB alike).
 */
export function revokeAllStatements(
  schema: string,
  table: string,
  grants: readonly TableGrant[],
): readonly {
  readonly account: Account;
  readonly table: string;
  readonly statements: readonly PlanStatement[];
}[] {
  const on = quoteTable(schema, table);
  return grants
    .filter((grant) => grant.table === table && grant.privileges.length > 0)
    .map((grant) => {
      const account = accountSql(grant.account);
      const privileges = grant.privileges.filter((privilege) => privilege !== "GRANT");
      return {
        account: grant.account,
        table,
        statements: [
          ...(privileges.length === 0
            ? []
            : [
                sourceStatement(
                  "grants",
                  `revoke ${privileges.map((privilege) => privilege.toLowerCase()).join(", ")}\n  on ${on} from ${account}`,
                ),
              ]),
          ...(grant.privileges.includes("GRANT")
            ? [sourceStatement("grants", `revoke grant option\n  on ${on} from ${account}`)]
            : []),
        ],
      };
    });
}

/** The view's note, said whenever the plan makes it. */
export function viewNote(label: string, schema: string, table: string): string {
  return `${schema}.${sideViewName(table)} lists the columns ${label} has now: after the application adds, renames or drops one of them, run facetdb migrate again to re-create the view (until then a dropped column makes it fail with error 1356).`;
}

/** Who may read the view, said whenever the plan makes it or grants it. */
export function readersNote(label: string, schema: string, table: string): string {
  return `${schema}.${sideViewName(table)} runs with the rights of whoever reads it (SQL SECURITY INVOKER), so it shows no account more than ${label} does: the accounts that hold select on ${label} now get select on the view and on ${schema}.${sideTableName(table)}, and one given select on ${label} later reads the view once facetdb migrate runs again (or after the same two grants by hand).`;
}

/**
 * What the foreign key asks of the application, said when the plan creates it ("Show before
 * doing"): an ORM's migration or a test's cleanup may truncate or drop the table.
 */
export function foreignKeyNote(label: string, schema: string, table: string): string {
  return `${schema}.${sideTableName(table)} references ${label} by its key, so a deleted record takes its answers with it; while it stands, MySQL and MariaDB refuse truncate table and drop table on ${label} and a change of its key column's type (delete from works, and facetdb uninstall removes the reference), and online schema-change tools need telling: gh-ost refuses a table another table references, and pt-online-schema-change needs --alter-foreign-keys-method.`;
}

/**
 * What a delete leaves where the side table cannot reference the table (a partitioned InnoDB
 * table, the one kind side-table mode installs on without a foreign key), said when it is created.
 */
export function noForeignKeyNote(label: string, schema: string, table: string): string {
  return `${label} is a partitioned table, which an InnoDB foreign key cannot reference: when the application deletes a record, its row in ${schema}.${sideTableName(table)} stays (the view and facetdb explain no longer show it), and a record inserted again under the same key starts fresh.`;
}
