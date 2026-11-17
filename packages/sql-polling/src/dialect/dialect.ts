import type { AnswerColumnKind } from "@facetdb/core";

/**
 * A SQL database as the polling connector and the polling engine see it: every piece of SQL text
 * that differs between databases, and the catalog reads whose queries differ, so the connector, the
 * plans and doctor are written once. Postgres is the first dialect (`@facetdb/postgres`),
 * CockroachDB and Oracle follow; `runDialectConformance` in this package's testing module snapshots
 * what each one writes for every operation.
 *
 * Every identifier from the config reaches SQL through `quoteIdent` (or `quoteTable`), every value
 * of the connector's travels as a bind parameter, and a plan's statements write their values as
 * literals through `quoteLiteral`, because a plan prints exactly what runs.
 */

/** A row as the driver returns it: column name to value. Callers select text where it matters. */
export type PollingRow = Readonly<Record<string, unknown>>;

/** Runs one statement with bind parameters (the dialect's placeholders) and returns its rows. */
export type PollingQuery = (
  text: string,
  params?: readonly unknown[],
) => Promise<readonly PollingRow[]>;

/**
 * What polling needs from a driver, and nothing more: statements, a transaction, and a way to let
 * go of the connection. Postgres's client (postgres.js) has more and fits this as it is; a test
 * hands in a recording client through the same type, so no module is patched.
 */
export type PollingClient = {
  readonly query: PollingQuery;
  /** Runs `work` in one transaction; it commits when `work` resolves and rolls back when it throws. */
  transaction<T>(work: (query: PollingQuery) => Promise<T>): Promise<T>;
  close(): Promise<void>;
};

/** Opens a client for a connection string; `max` is the most connections its pool keeps open. */
export type PollingConnect = (url: string, options?: { readonly max?: number }) => PollingClient;

/** A table as the dialect quotes it: its schema (the dialect's default when the config names none) and its name. */
export type TableRef = { readonly schema: string; readonly name: string };

/** The kinds of column FacetDB adds: the answers' (core's), the time of a decision, the state hash. */
export type ColumnKind = AnswerColumnKind | "timestamp" | "hash";

/** One column of the source's table as the dialect's catalog reads it. */
export type ColumnFacts = {
  readonly name: string;
  /** Its type as the database prints it: `timestamp with time zone`, `integer`. */
  readonly type: string;
  /**
   * Its comment, where the database has comments: FacetDB marks its own columns with one
   * (`OWNED_MARK`), and the table's project on `facetdb_state_hash`. Null without one.
   */
  readonly comment: string | null;
  /** Whether it holds a point in time (a timestamp or a date): what a last-changed column must be. */
  readonly time: boolean;
  readonly nullable: boolean;
  /**
   * Whether the connection's own login may read it: the worker's, when `open` and doctor read the
   * catalog, so a column the application added after the install is found before a poll fails on it.
   */
  readonly readable: boolean;
};

/** What the catalog says of the source's table, read with whichever login the call has. */
export type TableFacts = {
  /** Every column, in table order. */
  readonly columns: readonly ColumnFacts[];
  /** The primary key's columns in key order: exactly one for a table FacetDB can key. */
  readonly key: readonly string[];
  /** The row-level policies FacetDB names (`facetdb_reads`, `facetdb_writes`) that exist on the table. */
  readonly policies: readonly string[];
  /** FacetDB's change-capture triggers on the table: a trigger install's, which polling never makes. */
  readonly triggers: readonly string[];
  /**
   * The columns the worker login may select through a column-level grant of its own, in table
   * order; empty where the dialect grants on the whole table or has no logins.
   */
  readonly workerSelect: readonly string[];
};

/**
 * How FacetDB marks what it owns on a table: each column FacetDB adds carries `OWNED_MARK`, and
 * `facetdb_state_hash` carries the table's project. Where the database has comments the marks are
 * column comments; elsewhere they are rows of a `facetdb_table_owners` table, one per marked
 * column, holding the same texts, so the rest of polling reads both alike.
 */
export type Ownership =
  | {
      readonly kind: "comment";
      /** The statement that sets `text` (written as a literal) as the comment of `column` on `table`. */
      commentOn(table: TableRef, column: string, text: string): string;
    }
  | {
      readonly kind: "table";
      /** The statements that make the marks' table where it is missing; idempotent, run before the first mark. */
      create(): readonly string[];
      /** The statements that record `text` as the mark of `column` on `table`, replacing any; idempotent. */
      markColumn(table: TableRef, column: string, text: string): readonly string[];
      /** The statements that remove every mark of `table`; idempotent. */
      unmarkTable(table: TableRef): readonly string[];
      /** The statements that remove the marks of `columns` on `table` (a prune's); idempotent. */
      unmarkColumns(table: TableRef, columns: readonly string[]): readonly string[];
      /** The marks recorded for `table`, by column; empty when there are none (or no owners table yet). */
      marks(query: PollingQuery, table: TableRef): Promise<ReadonlyMap<string, string>>;
    };

/**
 * What the TLS rule says of a connection string, before anything connects: nothing (it may be
 * used), not a connection string, a host that cannot be read for sure, or the host it would reach
 * in the clear, with the variable the driver took it from when the URL names none (Postgres's
 * `PGHOST`) and how to point that variable elsewhere.
 */
export type TlsVerdict =
  | undefined
  | "invalid"
  | "ambiguous"
  | {
      readonly host: string;
      readonly via?: { readonly variable: string; readonly fix: string };
    };

/** The TLS rule of a dialect's connection strings, and the words its refusals use. */
export type TlsRule = {
  verdict(url: string, allowInsecure: boolean): TlsVerdict;
  /** A connection string's shape: `postgres://user:password@host/database`. */
  readonly shape: string;
  /** The same shape asking for TLS, as the admin connection string's fix shows it. */
  readonly secureShape: string;
  /** How a connection string asks for TLS, before the string's name: `add ?sslmode=require to`. */
  readonly ask: string;
};

/**
 * The statement `run` executes in place of a plan's `secret` one: it carries what is derived from
 * the worker password as a bind parameter, never as text (no plan holds the password).
 */
export type SecretStatement = { readonly text: string; readonly params: readonly unknown[] };

/**
 * The worker login, where the database has logins FacetDB creates (the only credential kept,
 * created at install with the least permission that works).
 */
export type LoginRule = {
  /** The login's name: `facetdb_worker`. */
  readonly name: string;
  /** Whether it exists already; an existing login keeps its password (other projects may share it). */
  exists(query: PollingQuery): Promise<boolean>;
  /** How the plan prints the password's statement: a comment, never the password. */
  readonly secretText: string;
  /** What `run` executes at the `secret` statement, from the password it is given. */
  secret(password: string): SecretStatement;
  /** The statements that create the login once the secret statement ran. */
  create(): readonly string[];
  /** The worker's rights: read `select`, write `update`, on `table`, and what else it needs there. */
  grants(table: TableRef, select: readonly string[], update: readonly string[]): readonly string[];
  /**
   * The install plan's note where `grants` reaches wider than the columns it was given, because the
   * database grants a table whole (CockroachDB has no column-level grants), naming the table as the
   * words show it (`public.listings`). Absent where the grants name the columns.
   */
  grantsNote?(table: string): string;
  /**
   * Whether `grants` also gives the worker the use of the table's schema (Postgres's `usage`).
   * Uninstall leaves it, and says so: another FacetDB table in that schema may still need it.
   */
  readonly schemaUsage: boolean;
  /** Takes back what `grants` gave on `table`, given the policies the catalog found there. */
  revoke(table: TableRef, policies: readonly string[]): readonly string[];
  /** Takes back the worker's read of `columns` (a prune of reads `read` no longer lists). */
  revokeSelect(table: TableRef, columns: readonly string[]): readonly string[];
  /** A query returning the connection's login as the column `name`. */
  readonly whoami: string;
  /** The worker's connection string as the words show it: `postgres://facetdb_worker:<a long random password>@<host>/<database>`. */
  readonly urlShape: string;
};

/**
 * How doctor finds a transaction-mode pooler in front of a database whose driver prepares
 * statements: the probe runs twice on one connection and must answer from one session (`pid`).
 */
export type PoolerRule = {
  /** One statement with one bind parameter, answering the server session as the column `pid`. */
  readonly probe: string;
  /** The server's code for "prepared statement does not exist", read off the driver's error. */
  readonly goneState: string;
  /** Why a URL is known to reach a transaction pooler without asking it (a provider's port), or undefined. */
  known(url: string): string | undefined;
};

export type SqlDialect = {
  /** How the words name the database: `Postgres`. */
  readonly name: string;
  /** The URL schemes its connection strings start with, without the colon. */
  readonly schemes: readonly string[];
  /** The schema a table lives in when the config names none: `public`. */
  readonly defaultSchema: string;
  /**
   * Whether DDL runs inside a transaction, so a plan runs all or nothing; where it does not, a run
   * that stops keeps what ran, and a fresh plan made after the stop (from the table as it is then)
   * completes it.
   */
  readonly transactionalDdl: boolean;
  /**
   * What every plan with statements runs first: the settings the rest relies on (Postgres's
   * `lock_timeout`, so a table busy behind a long transaction refuses within seconds instead of
   * queueing the application's queries behind the plan's lock). Empty where there are none.
   */
  readonly header: readonly string[];
  /**
   * The statement that locks the table for the rest of the plan's transaction, right after the
   * header: a concurrent install, prune or uninstall of the table waits for it, and `run` reads the
   * table's mark again right after it, as another run left it committed. Absent where DDL commits
   * each statement, so no lock outlives one.
   */
  lock?(table: TableRef): string;
  /**
   * Where DDL commits statement by statement and nothing locks a table, but a transaction can still
   * hold a few DDL statements all or nothing (CockroachDB): an install then claims the table first,
   * adding `facetdb_state_hash` with the project's mark in one group that fails when the column is
   * already there (another run's claim won the race; `run` reads the mark right after the claim,
   * and after a claim that failed, and stops with the ownership refusal), and adds each other
   * column together with its mark, so a run stopped anywhere leaves either nothing or a marked
   * column, never one the next plan would refuse as the application's.
   */
  readonly atomic?: {
    /** One printed statement that runs `statements` in one transaction: `begin; …; commit`. */
    group(statements: readonly string[]): string;
    /**
     * What `run` sends, as one statement, inside the client's own transaction for a text `group`
     * printed (so the driver rolls a failure back); undefined for any other text.
     */
    inner(text: string): string | undefined;
    /** The statement adding `name` that fails when the column exists: the claim a second run loses. */
    addStrict(table: TableRef, name: string, definition: string): string;
  };

  /** The `index`-th bind placeholder, from 1: `$1`, `:1`. */
  placeholder(index: number): string;
  /** An identifier as written, quoted: the only way a name from the config becomes SQL. */
  quoteIdent(name: string): string;
  /** A table, schema-qualified and quoted. */
  quoteTable(schema: string, name: string): string;
  /** A value as a string literal, for the plans, which carry no parameters. */
  quoteLiteral(text: string): string;
  /** A column read as the database's own text: the key, every state field (the hash is over it). */
  keyAsText(column: string): string;
  /**
   * A state field of the catalog's `type` read as text, where `keyAsText` cannot read every type
   * whole (Oracle's `to_char` of a CLOB stops past 4000 bytes, so a CLOB is selected as it is and
   * the driver hands it over as text). Absent: `keyAsText`, whatever the type. The connector calls
   * it for the state fields whose types it was given (`PollingConnectorOptions.columns`).
   */
  stateAsText?(column: string, type: string): string;
  /** `in (…)` over `count` placeholders from the first: a statement's only list, its binds first. */
  inList(count: number): string;
  /**
   * The most items one `in` list holds: longer lists go in several statements (Oracle allows 1000;
   * a smaller cap also bounds how many statements of different lengths a driver prepares).
   */
  readonly maxInList: number;

  /** The type of each kind of column FacetDB adds. */
  readonly types: Readonly<Record<ColumnKind, string>>;
  /** The literal false, for `facetdb_reviewed`'s default. */
  readonly falseValue: string;
  /**
   * How a boolean travels where SQL has none (Oracle's `number(1)`, for 19c, which has no SQL
   * boolean): what a boolean binds as when `write` stores a noul answer or `facetdb_reviewed`, and
   * what a boolean column or the `excluded` expression reads back as from the driver. Absent where
   * the driver hands booleans over both ways (Postgres), and then the connector binds and reads
   * JavaScript booleans as they are.
   */
  readonly booleans?: {
    /** The bind parameter of a boolean: Oracle's 1 or 0. */
    bind(value: boolean): unknown;
    /** A boolean as the driver returned it, read back; anything else is a boundary error. */
    read(value: unknown): boolean;
  };
  /** The time a bind parameter holds as milliseconds since the epoch: what `write` stamps. */
  timeFromMs(placeholder: string): string;
  /** A time column as milliseconds since the epoch, as text: what `current` reads back. */
  msOfTime(column: string): string;
  /** The value that says a row is outside the source's `where` filter, selected per row (a boolean, read through `booleans` where the dialect has them). */
  excluded(where: string | undefined): string;

  /**
   * How an install adds a column: `if-not-exists`, every column in each run, the database skipping
   * the present ones; or `inspect-first`, the missing ones only, as the catalog reads them.
   */
  readonly addColumn: "if-not-exists" | "inspect-first";
  /** The statements that add `columns` (name and definition) to `table`. */
  addColumns(
    table: TableRef,
    columns: readonly (readonly [name: string, definition: string])[],
  ): readonly string[];
  /** The statements that drop `columns`, which the catalog found, from `table`. */
  dropColumns(table: TableRef, columns: readonly string[]): readonly string[];

  /** Keyset paging: the clause that ends a page at the rows the placeholder counts. */
  limit(placeholder: string): string;
  /** The keyset condition with a tie-breaker: the row comes after `(values…)` in `(columns…)` order. */
  after(columns: readonly string[], values: readonly string[]): string;

  readonly ownership: Ownership;
  /** The table's catalog facts, or undefined when it does not exist; `login` is the worker's name. */
  table(query: PollingQuery, table: TableRef, login: string): Promise<TableFacts | undefined>;

  readonly tls: TlsRule;
  /** Absent where the database has no login FacetDB creates. */
  readonly login?: LoginRule;
  /** The smallest round trip: `select 1`. */
  readonly ping: string;
  /** Absent where no transaction-mode pooler can stand in front of the database. */
  readonly pooler?: PoolerRule;
};
