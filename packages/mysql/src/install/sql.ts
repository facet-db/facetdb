import {
  type AnswerColumnKind,
  answerColumns,
  type EnginePlan,
  type OnChange,
  type PlanStatement,
  type QuestionSet,
  REVIEWED_COLUMN,
  STATUS_COLUMN,
  type StatementPurpose,
  UPDATED_AT_COLUMN,
} from "@facetdb/core";
import { quoteIdent, quoteLiteral, quoteTable } from "../sql/index.ts";

/**
 * The SQL FacetDB writes into a MySQL 8 or MariaDB 10.5 database: one text for both engines, every
 * name through `quoteIdent`, every value through `quoteLiteral`, every object qualified by its
 * schema so the script runs in any session. MySQL commits each DDL statement on its own, so no
 * statement relies on another having run in the same transaction; the plans emit only what the
 * catalog shows missing (MySQL 8 has no `add column if not exists`), so planning again completes a
 * stopped run.
 */

/** The one login FacetDB creates in a customer's database, the only credential it keeps. */
export const WORKER_USER = "facetdb_worker";

/** Any host: the worker runs wherever the operator runs it, over TLS (`tlsProblem`). */
export const WORKER_HOST = "%";

/** The worker login as MySQL writes an account, and as information_schema's `grantee` spells it. */
export const WORKER_ACCOUNT = `${quoteLiteral(WORKER_USER)}@${quoteLiteral(WORKER_HOST)}`;

/** The queue: the triggers put a changed record's key in it, the worker claims from it. */
export const JOBS_TABLE = "facetdb_jobs";

/** The marker: which project installed on which table of the database. */
export const OWNERS_TABLE = "facetdb_table_owners";

/**
 * The comment on every column FacetDB adds, the word Postgres's install marks its columns with: a
 * later install adopts a marked column and refuses an unmarked one of the same name, and uninstall
 * and prune drop marked columns only.
 */
export const OWNED_MARK = "facetdb";

/** MySQL's limit on the length of a table, column or trigger name. */
export const NAME_LIMIT = 64;

/**
 * How long a statement waits for the table's metadata lock: `alter table` and the trigger
 * statements need it, and while one waits every query of the application on the table queues
 * behind it, so a migrate that fails after ten seconds is better (Postgres's `lock_timeout`).
 */
export const LOCK_WAIT_SECONDS = 10;

/** One column FacetDB owns on a table: how `add column` writes it, how the catalog reads it back. */
export type OwnedColumn = {
  readonly name: string;
  /** The definition `add column` writes, before the mark. */
  readonly definition: string;
  /** The `data_type` values that mean this definition: MariaDB's `json` is a checked `longtext`. */
  readonly dataTypes: readonly string[];
};

/** The question types, in MySQL's types: `float` is the 4-byte `real`. */
const ANSWER_TYPES: Readonly<Record<AnswerColumnKind, Omit<OwnedColumn, "name">>> = {
  boolean: { definition: "boolean", dataTypes: ["tinyint"] },
  text: { definition: "varchar(255)", dataTypes: ["varchar"] },
  real: { definition: "float", dataTypes: ["float"] },
  json: { definition: "json", dataTypes: ["json", "longtext"] },
};

/**
 * FacetDB's own columns on every record, after the answers. `facetdb_status` is not null with the
 * pending default, as on Postgres: the generated types declare it non-null, and a row the
 * application inserts reads as pending from its first moment.
 */
const STATUS_COLUMNS: readonly OwnedColumn[] = [
  {
    name: STATUS_COLUMN,
    definition: "varchar(16) not null default 'pending'",
    dataTypes: ["varchar"],
  },
  { name: UPDATED_AT_COLUMN, definition: "datetime(3)", dataTypes: ["datetime"] },
  { name: REVIEWED_COLUMN, definition: "boolean not null default false", dataTypes: ["tinyint"] },
];

/** Every column FacetDB owns on the table under this question set, answers first, in install order. */
export function ownedColumns(questionSet: QuestionSet): readonly OwnedColumn[] {
  return [
    ...questionSet.questions.flatMap((question) =>
      answerColumns(question).map(
        ({ name, kind }): OwnedColumn => ({ name, ...ANSWER_TYPES[kind] }),
      ),
    ),
    ...STATUS_COLUMNS,
  ];
}

/** A statement of the source's database: every statement of a MySQL plan is one. */
export function sourceStatement(purpose: StatementPurpose, text: string): PlanStatement {
  return { database: "source", purpose, text };
}

/**
 * MariaDB's part of the settings, in its executable comment (one opened by `/*M!`), which MariaDB
 * runs and MySQL reads as a comment: `NO_AUTO_CREATE_USER` added to the session's sql_mode, so a
 * grant to an account that does not exist fails rather than create it with no password, whatever
 * mode the session of a hand run starts in. The plan still refuses a server without it, since a
 * client that strips comments would not send this; MySQL 8 never creates a user from a grant, and
 * has no such mode to set.
 */
const MARIADB_SETTINGS = `/*M! , sql_mode = concat_ws(',', nullif(@@session.sql_mode, ''), 'NO_AUTO_CREATE_USER') */`;

/** The first statement of every script that does anything (`LOCK_WAIT_SECONDS`, `MARIADB_SETTINGS`). */
export const SETTINGS: PlanStatement = sourceStatement(
  "settings",
  `set session lock_wait_timeout = ${LOCK_WAIT_SECONDS} ${MARIADB_SETTINGS}`,
);

/** The triggers FacetDB may put on a table, by what they do. */
export type TriggerNames = {
  /** Before insert, `onChange: reset` only: a new row starts pending. */
  readonly pending: string;
  /** After insert: a new row is queued. */
  readonly insert: string;
  /** Before update: a row whose state changed is queued (and set pending with `reset`). */
  readonly update: string;
};

/** The names of the triggers on a table: FacetDB's prefix, the table, four letters for the role. */
export function triggerNames(table: string): TriggerNames {
  return {
    pending: `facetdb_${table}_new`,
    insert: `facetdb_${table}_ins`,
    update: `facetdb_${table}_upd`,
  };
}

/** What the change capture of one table needs to know. */
export type CaptureSource = {
  readonly schema: string;
  readonly table: string;
  /** The single-column primary key. */
  readonly key: string;
  /** The state columns (`read`), in config order. */
  readonly state: readonly string[];
  readonly onChange: OnChange;
};

/** A trigger as install creates it and as `information_schema.triggers` shows it. */
export type TriggerDefinition = {
  readonly name: string;
  readonly timing: "before" | "after";
  readonly event: "insert" | "update";
  /** The statement after `for each row`, as `action_statement` keeps it. */
  readonly body: string;
};

/**
 * The record into the queue the database's tables share: the table's name, and the key as text in
 * utf8mb4, whatever the session's character set (a key in its own type would make key 1 of two
 * tables one job, and two key types one column). One row per record: several changes before a
 * worker arrives are asked once. A change while a worker holds the job clears the claim, as
 * Postgres's `on conflict … do update` does, so that worker's `ack` (by its claim token) leaves the
 * job for the new state to be asked; `insert ignore` would let the ack delete it.
 */
export function enqueue(source: CaptureSource, indent: string): string {
  const columns = ["table_name", "record_key"].map(quoteIdent).join(", ");
  const key = `cast(new.${quoteIdent(source.key)} as char character set utf8mb4)`;
  return `${indent}insert into ${quoteTable(source.schema, JOBS_TABLE)} (${columns}) values (${quoteLiteral(source.table)}, ${key})
${indent}  on duplicate key update ${["claimed_at", "claimed_by", "claim_token"].map((column) => `${quoteIdent(column)} = null`).join(", ")}`;
}

/**
 * Whether any state column changed, byte for byte. MySQL has no `update of <columns>` on a trigger,
 * so the body compares old and new itself; `<=>` is equal for two nulls. The binary cast keeps the
 * column's collation out of it: under the usual `_ai_ci` collations `'Scam' <=> 'scam'` is true, and
 * a change the state hash sees would not queue the record.
 */
export function stateChanged(source: CaptureSource): string {
  return source.state
    .map(
      (column) =>
        `not (cast(old.${quoteIdent(column)} as binary) <=> cast(new.${quoteIdent(column)} as binary))`,
    )
    .join("\n     or ");
}

/**
 * The triggers of a table. They run as their definer, the account that created them, so the
 * application's own account needs no right on the queue. The insert is queued after it: before it,
 * an `auto_increment` key still reads 0, and every new row would queue as 0. With `onChange: reset`
 * a trigger before the insert sets the new row pending, whatever status the application wrote, as
 * Postgres's `enqueue()` does (`enqueue_keep` leaves it, and so does `keep` here); it reads no key,
 * so it may run before one is given. The update trigger runs before the update, the only time it
 * may set the row's status, and acts only when a state column changed: FacetDB's own writes change
 * no state column, so they never queue the record again.
 */
export function triggerDefinitions(source: CaptureSource): readonly TriggerDefinition[] {
  const names = triggerNames(source.table);
  const reset = source.onChange === "reset";
  const pending = `set new.${quoteIdent(STATUS_COLUMN)} = 'pending'`;
  return [
    ...(reset
      ? [{ name: names.pending, timing: "before", event: "insert", body: pending } as const]
      : []),
    { name: names.insert, timing: "after", event: "insert", body: enqueue(source, "") },
    {
      name: names.update,
      timing: "before",
      event: "update",
      body: `begin\n  if ${stateChanged(source)} then\n${reset ? `    ${pending};\n` : ""}${enqueue(source, "    ")};\n  end if;\nend`,
    },
  ];
}

/**
 * The trigger as one statement. `definer = current_user` names the account running it, whoever that
 * is, so the printed script reads the same for every admin; MySQL triggers always run with their
 * definer's rights.
 */
export function createTrigger(source: CaptureSource, trigger: TriggerDefinition): string {
  return `create definer = current_user trigger ${quoteTable(source.schema, trigger.name)} ${trigger.timing} ${trigger.event} on ${quoteTable(source.schema, source.table)} for each row
${trigger.body}`;
}

/** `drop trigger if exists`: before a `create trigger`, it makes the pair safe to run again. */
export function dropTrigger(schema: string, name: string): PlanStatement {
  return sourceStatement("capture", `drop trigger if exists ${quoteTable(schema, name)}`);
}

/**
 * The marker table: one row per installed table of the database. Binary collation, so a project or
 * table name compares exactly as written.
 */
export function ownersTableStatement(schema: string): PlanStatement {
  return sourceStatement(
    "marker",
    `create table if not exists ${quoteTable(schema, OWNERS_TABLE)} (
  ${quoteIdent("table_name")} varchar(${NAME_LIMIT}) not null primary key,
  ${quoteIdent("project_id")} varchar(255) not null,
  ${quoteIdent("source")} varchar(255) not null,
  ${quoteIdent("installed_at")} datetime(3) not null default current_timestamp(3)
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_bin`,
  );
}

/** What claiming a table for a project writes into the marker. */
export type Claim = {
  readonly schema: string;
  readonly table: string;
  readonly projectId: string;
  readonly source: string;
};

/**
 * The claim: the table's row, when it has none. On a row already there it changes nothing (as
 * Postgres's `on conflict do nothing`, without `insert ignore`'s turning of other errors into
 * warnings), and the guard after it reads whose row it is.
 */
export function claimStatement(claim: Claim): PlanStatement {
  const names = ["table_name", "project_id", "source"].map(quoteIdent).join(", ");
  const values = [claim.table, claim.projectId, claim.source].map(quoteLiteral).join(", ");
  return sourceStatement(
    "marker",
    `insert into ${quoteTable(claim.schema, OWNERS_TABLE)} (${names}) values (${values})
  on duplicate key update ${quoteIdent("table_name")} = ${quoteIdent("table_name")}`,
  );
}

/** How the owner guard begins, so `run` knows the statement that stopped it. */
export const OWNER_GUARD_COMMENT =
  "-- stops the script here (Subquery returns more than 1 row) when another project owns this table";

/**
 * Stops the script, before it touches the table, when the table's row names another project: run by
 * `run` (which reads it as the `another-project` refusal) and by hand alike. MySQL has no anonymous
 * block to raise an error from, so the guard is a scalar subquery that returns two rows exactly
 * then, which MySQL and MariaDB refuse whatever the sql_mode (error 1242). It is a `select`: MariaDB
 * turns the errors of a `do`'s expression into warnings. The comment holds no name: a newline in one
 * would end the comment and run the rest as SQL.
 */
export function ownerGuardStatement(claim: Claim): PlanStatement {
  return sourceStatement(
    "marker",
    `${OWNER_GUARD_COMMENT}
select (select 1 from ${quoteTable(claim.schema, OWNERS_TABLE)} where ${quoteIdent("table_name")} = ${quoteLiteral(claim.table)} and ${quoteIdent("project_id")} <> ${quoteLiteral(claim.projectId)}
        union all select 1) as ${quoteIdent("facetdb_owner_guard")}`,
  );
}

/** FacetDB's answer and status columns, marked as FacetDB's, in one statement: all or none. */
export function addColumnsStatement(
  schema: string,
  table: string,
  columns: readonly OwnedColumn[],
): PlanStatement {
  return sourceStatement(
    "columns",
    `alter table ${quoteTable(schema, table)}
${columns.map((column) => `  add column ${quoteIdent(column.name)} ${column.definition} comment ${quoteLiteral(OWNED_MARK)}`).join(",\n")}`,
  );
}

/**
 * The longest key, as text, the queue holds: 255 characters hold the common text keys (a
 * `varchar(255)`, the string column of most ORMs). Install refuses a longer key.
 */
export const RECORD_KEY_LENGTH = 255;

/**
 * The bytes the queue keeps a key in: 255 characters of utf8mb4, 4 bytes each. With the table's name
 * (64 characters, 256 bytes) beside it the primary key takes 1,276 of the 3,072 bytes InnoDB allows a
 * key in its `dynamic` row format, which the table states rather than leave to a server whose
 * default is still `compact` (767 bytes a column).
 *
 * Bytes and not a `varchar`: every utf8mb4 collation MySQL 8 and MariaDB 10.5 share is PAD SPACE,
 * under which `'a'` and `'a '` are one value, while MySQL 8's default `utf8mb4_0900_ai_ci` is NO
 * PAD and keeps them two keys of the table: with a `varchar` they would be one job, and the second
 * record never asked. The NO PAD binary collations are `utf8mb4_0900_bin` on MySQL alone and
 * `utf8mb4_nopad_bin` on MariaDB alone, so one text for both takes the key's text as its exact
 * utf8mb4 bytes; a `varbinary` keeps trailing spaces and compares byte for byte.
 */
export const RECORD_KEY_BYTES = RECORD_KEY_LENGTH * 4;

/**
 * The queue every table of the database shares: one row per record, keyed by the table's name and
 * the key's text (`RECORD_KEY_BYTES`), so key 1 of two tables is two jobs. The claim columns serve
 * the connector's update-claim; the token is indexed because `ack`, `release` and the claim's
 * read-back find rows by it, and an unindexed `delete … where claim_token = ?` would lock every row
 * it scans, the triggers' inserts included.
 */
export function jobsTableStatement(schema: string): PlanStatement {
  return sourceStatement(
    "queue",
    `create table if not exists ${quoteTable(schema, JOBS_TABLE)} (
  ${quoteIdent("table_name")} varchar(${NAME_LIMIT}) not null,
  ${quoteIdent("record_key")} varbinary(${RECORD_KEY_BYTES}) not null,
  ${quoteIdent("enqueued_at")} datetime(3) not null default current_timestamp(3),
  ${quoteIdent("claimed_by")} varchar(64),
  ${quoteIdent("claimed_at")} datetime(3),
  ${quoteIdent("claim_token")} char(32),
  primary key (${quoteIdent("table_name")}, ${quoteIdent("record_key")}),
  index ${quoteIdent("facetdb_jobs_claimed_at")} (${quoteIdent("claimed_at")}),
  index ${quoteIdent("facetdb_jobs_claim_token")} (${quoteIdent("claim_token")})
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_bin row_format = dynamic`,
  );
}

/** A table's own rows of the shared queue, which its uninstall deletes. */
export function deleteJobsStatement(schema: string, table: string): PlanStatement {
  return sourceStatement(
    "data",
    `delete from ${quoteTable(schema, JOBS_TABLE)} where ${quoteIdent("table_name")} = ${quoteLiteral(table)}`,
  );
}

/**
 * How the `secret` statement begins: where the password goes, without it, and what a hand-run must
 * do there. Run by hand as printed, the statement fails at its `?`; a client that goes on past an
 * error (`source`, a paste) would then run the grants after it, and a grant to an account that does
 * not exist creates it, with no password, where the sql_mode allows it (install refuses such a
 * MariaDB server). Like every comment of a script it holds no quote, `;` or `?`: the driver's
 * placeholder is the statement's only one, and no reader of the script has to know where a comment
 * ends.
 */
export const WORKER_PASSWORD_COMMENT = [
  "-- the worker password: facetdb migrate sends the one in the connection string of the source in",
  "-- place of the placeholder and never prints it. Run by hand, write the password into this one",
  "-- statement as a quoted literal, and never go on past an error: mysql --batch stops at the first",
  "-- one, the source command and a paste do not.",
].join("\n");

/**
 * The worker login, created once (`secret` statement): `run` binds the password in place of the `?`
 * through the driver's escaping, since DDL takes no server-side parameter. Its password never
 * expires: a server whose `default_password_lifetime` is set would otherwise lock the worker out
 * one day. An existing login keeps its password, which other projects on the server may share; the
 * plan then has no such statement.
 */
export const WORKER_LOGIN_STATEMENT: PlanStatement = {
  ...sourceStatement(
    "login",
    `${WORKER_PASSWORD_COMMENT}\ncreate user if not exists ${WORKER_ACCOUNT} identified by ? password expire never`,
  ),
  secret: true,
};

/** A column-level grant on the source table to the worker. */
export function columnGrantStatement(
  privilege: "select" | "update",
  schema: string,
  table: string,
  columns: readonly string[],
): PlanStatement {
  return sourceStatement(
    "grants",
    `grant ${privilege} (${columns.map(quoteIdent).join(", ")})\n  on ${quoteTable(schema, table)} to ${WORKER_ACCOUNT}`,
  );
}

/** A table-level grant on one of FacetDB's own tables to the worker. */
export function tableGrantStatement(
  privileges: readonly string[],
  schema: string,
  table: string,
): PlanStatement {
  return sourceStatement(
    "grants",
    `grant ${privileges.join(", ")} on ${quoteTable(schema, table)} to ${WORKER_ACCOUNT}`,
  );
}

/** One right the worker holds on a table, or on one of its columns. */
export type HeldRight = { readonly privilege: string; readonly column?: string };

/**
 * The worker's rights on one table, taken back exactly as the catalog lists them, column rights
 * grouped by privilege: a `revoke` of a right not held fails on MySQL, and MariaDB 10.5 has no
 * `revoke if exists`. Undefined when there is nothing to take back.
 */
export function revokeStatement(
  schema: string,
  table: string,
  rights: readonly HeldRight[],
): PlanStatement | undefined {
  const columns = new Map<string, string[]>();
  const whole: string[] = [];
  for (const { privilege, column } of rights) {
    const name = privilege.toLowerCase();
    if (column === undefined) {
      whole.push(name);
    } else {
      columns.set(name, [...(columns.get(name) ?? []), column]);
    }
  }
  const parts = [
    ...[...columns].map(([name, held]) => `${name} (${held.map(quoteIdent).join(", ")})`),
    ...whole,
  ];
  return parts.length === 0
    ? undefined
    : sourceStatement(
        "grants",
        `revoke ${parts.join(", ")}\n  on ${quoteTable(schema, table)} from ${WORKER_ACCOUNT}`,
      );
}

/**
 * The script's first words, before any statement: what a stop leaves and how to finish, since MySQL
 * commits each statement as it runs; and how to run it by hand, since the owner guard and the
 * login's placeholder stop it only in a client that stops at an error.
 */
export const SCRIPT_HEADER = [
  "-- MySQL runs this script statement by statement, with no transaction around it: if it stops",
  "-- part way, what ran stays, and running the same facetdb command again completes it. Run by",
  "-- hand, give it to mysql --batch, which stops at the first error: the source command and a",
  "-- paste go on past one.",
].join("\n");

/** Quoted strings, quoted names and comments: where a `;` does not end a statement. */
const OPAQUE = /'(?:[^'\\]|\\.|'')*'|`(?:[^`]|``)*`|"(?:[^"\\]|\\.|"")*"|--[^\n]*|#[^\n]*/g;

/** A statement with a `;` of its own (a trigger's `begin … end`): the client needs another delimiter. */
function compound(text: string): boolean {
  return text.replace(OPAQUE, "").includes(";");
}

/**
 * The plan as the script the CLI prints and a DBA can paste into the mysql client: the header, then
 * each statement with its `;`, a blank line between. The client ends a statement at the first `;`,
 * so a compound one goes between `delimiter //` and `delimiter ;` lines, which are the client's
 * commands and no SQL: `run` sends each statement's text alone, one statement per call.
 */
export function renderScript(plan: EnginePlan): string {
  if (plan.statements.length === 0) {
    return "";
  }
  const body = plan.statements
    .map(({ text }) => (compound(text) ? `delimiter //\n${text}//\ndelimiter ;` : `${text};`))
    .join("\n\n");
  return `${SCRIPT_HEADER}\n\n${body}\n`;
}
