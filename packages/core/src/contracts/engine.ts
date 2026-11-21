import type { QuestionSet } from "../questions/index.ts";
import type { OnChange } from "../records/index.ts";
import type { Clock } from "./clock.ts";
import type { Capabilities, Connector, ReadRow, RecordKey } from "./connector.ts";

/**
 * The database engine contract (anyone can add a database by implementing it): what one database
 * offers the CLI. An engine plans install, uninstall and prune for a source, renders a plan as the
 * script the operator reads first, runs it, opens the runtime connector and answers doctor. It owns
 * the answer columns, the queue and the change capture in the source's database; the log and
 * everything else stay in the one Postgres store. The CLI picks an engine by the URL's scheme.
 *
 * Design notes:
 * - A statement names the database it serves, `source` or `store`, because the store is one
 *   Postgres for every engine. `store` statements, and the store's own objects among removes and
 *   keeps (`log`, `store-table`), appear only when `EngineDeps.storeShared` says the store is the
 *   source's own database: the plan is then one script, today's, byte for byte. With a separate
 *   store the plan is `source` only, like a MySQL plan, and the CLI's store door (`migrateStore`,
 *   the purge) owns the store. The tag follows a table's role, not the function that made it:
 *   whatever the store, everything the source's database needs is `source`, among it the `facetdb`
 *   schema, `facetdb.jobs`, `facetdb.projects`, `facetdb.table_owners` and the worker's grants on
 *   them.
 * - A plan is an ordered list, not a tree of steps: the order is what runs and what the operator
 *   reads, and on a database without transactional DDL (MySQL) a stopped run is described by one
 *   index. Every statement is idempotent on a transactional engine, so running the same plan again
 *   completes it; an inspect-first engine (MySQL's `alter … add column`, `revoke`, `drop column`)
 *   fails on what is already there or gone, so after a stop the CLI plans afresh and never replays
 *   a stopped plan. An
 *   uninstall of several tables is one plan per table, and each object's `scope` says whether it
 *   goes with its table or once for the whole run.
 * - What runs is what was printed, string for string. The one exception is a `secret` statement:
 *   no plan holds the worker login's password, so `run` binds the one it is given.
 * - `current` is on the connector, not here: it reads a record's decision with the worker login,
 *   the key column and the question set the connector already holds, for `explain` and the review
 *   screens, which run where connectors are open (the worker, the server). An engine plans with
 *   the admin credential, which nothing keeps, and an API or plugin source has a connector (the
 *   store's) and no engine.
 * - `text` is free-form per engine: SQL for a SQL database; for MongoDB the mongosh line of one
 *   command, `db.runCommand({ createIndexes: "facetdb_jobs", ... })`. mongosh evaluates that line
 *   as JavaScript, where Extended JSON's `{ "$date": ... }` is a plain object, so the command is
 *   written in a form JavaScript and the driver read alike: plain JSON values only, and a time set
 *   by the server with `$currentDate`. The engine runs exactly the document the operator read.
 */

/**
 * One source as an engine sees it, built by the CLI from the config. The connection string
 * travels beside it, never inside: the admin URL to plan and run, the worker login's URL to open
 * and to doctor.
 */
export type EngineTarget = {
  /** The project that owns the install: its id marks the table, uninstall asks its name back. */
  readonly project: { readonly id: string; readonly name: string };
  /** The source's name in the config; its decision log in the store is keyed by it. */
  readonly source: string;
  /** The table the source reads, or the collection on MongoDB. */
  readonly table: string;
  /**
   * The table's schema as the config names it (`schema.table`). Absent: the engine's default
   * (`public` on Postgres, `dbo` on SQL Server, the connection's database on MySQL and MongoDB).
   */
  readonly schema?: string;
  /**
   * The single-column primary key, when the caller knows it. Otherwise the engine reads it from the
   * catalog, and every engine refuses a composite one.
   */
  readonly key?: string;
  /** Where the answers live. */
  readonly storage: "inline" | "side-table";
  /**
   * How the engine notices a changed record where its database offers two ways. Absent: the
   * trigger, which every SQL engine uses; only the SQL Server engine reads `"change-tracking"`, and
   * the config loader refuses it on any other database.
   */
  readonly capture?: "trigger" | "change-tracking";
  /**
   * The column a polled table is read by ("polling with a state hash … using a last-changed column;
   * without one, a full scan every hour, with a warning"): its name, or `false` for the hourly full
   * scan on purpose, with no warning. Absent: the polling engine looks for one by name
   * (`updated_at`, `modified_at` …). Only the polling engine reads it; an engine with a trigger or
   * a change feed has no use for it.
   */
  readonly lastChanged?: string | false;
  /** What a change to a decided record does to its status. */
  readonly onChange: OnChange;
  /**
   * The questions (each choice carries its own `storeProbabilities`), the state fields (`read`) and
   * the filter (`where`). The model and the thresholds ride along unread: an engine owns columns,
   * not decisions.
   */
  readonly questionSet: QuestionSet;
  /**
   * How the engine's words name the source's connection string: the environment variable the CLI
   * read it from (`DATABASE_URL`, `LISTINGS_URL`), so a refusal or a doctor's fix says what to set.
   * Absent where no variable holds it (Cloud, a test): "the source's connection string".
   */
  readonly urlVariable?: string;
};

/**
 * What part of the install a statement serves. The CLI shows it in `--json` and when a run stops
 * part way ("stopped at statement 14 (grants)").
 */
export type StatementPurpose =
  // A setting the statements after it rely on (Postgres's `set local`, a transaction-local value).
  | "settings"
  // FacetDB's schema, and the store's tables when the store shares the source's database.
  | "schema"
  // The answer and status columns or fields, or the side table and its view.
  | "columns"
  // The change capture: triggers, the functions they call, the role that owns them.
  | "capture"
  // The jobs table and its indexes.
  | "queue"
  // The worker login: created, or its password set.
  | "login"
  // The rights and row-level policies of the worker login and the trigger's owner.
  | "grants"
  // The project marker: which project installed on which table.
  | "marker"
  // Rows FacetDB writes or deletes in its own tables: queued jobs, a purged log.
  | "data"
  // What FacetDB no longer uses: functions no trigger calls, an emptied table or schema.
  | "cleanup";

/** One statement of a plan, as printed and as run. */
export type PlanStatement = {
  /**
   * The database it serves: the source's own, or the FacetDB store (Postgres). `store` appears only
   * in a plan made with `storeShared`, whose one script runs in that one database.
   */
  readonly database: "source" | "store";
  readonly purpose: StatementPurpose;
  /**
   * The statement in the engine's own language, exactly as printed and as run: SQL with every value
   * written as a literal, or MongoDB's mongosh line. It never holds a secret.
   */
  readonly text: string;
  /**
   * The statement that gives the worker login its password, the one credential FacetDB keeps. Its
   * text shows where the password goes, never the password, and `run` binds the one it is given. On
   * Postgres it prints as a comment with no placeholder, and `run` executes its own `set_config`
   * with a fresh SCRAM verifier: neither the password nor a verifier is ever in a plan or a result
   * (the Postgres engine's test asserts it).
   */
  readonly secret?: true;
};

/** The kinds of thing an install adds, and an uninstall or a prune removes or keeps. */
export type ObjectKind =
  // An answer or status column on the source's table.
  | "column"
  // An answer or status field on a document (MongoDB's `facetdb` subdocument).
  | "field"
  // The table that holds a source's answers in side-table mode.
  | "side-table"
  // The view that joins a table with its side table.
  | "view"
  // A trigger that queues a changed record.
  | "trigger"
  // A function the triggers call.
  | "function"
  // The queue; with `of`, one table's queued jobs in it.
  | "jobs-table"
  // The record of which project installed on which table; with `of`, one project's part of it.
  | "marker"
  // FacetDB's schema.
  | "schema"
  // A login or role FacetDB created: the worker login, the role that owns the triggers.
  | "login"
  // A right FacetDB gave a login: `name` is the login, `of` the table, column or schema it is on.
  | "grant"
  // A row-level security policy.
  | "policy"
  // An index FacetDB made.
  | "index"
  // A collection FacetDB made on MongoDB.
  | "collection"
  // SQL Server's Change Tracking on a table, which FacetDB's install turned on: `of` the table.
  | "change-tracking"
  // The store's decision log: its tables, or with `of` one source's entries in one of them.
  | "log"
  // Another table of the FacetDB store (usage, alerts, heartbeats, the webhook outbox).
  | "store-table";

/**
 * A thing FacetDB put in a database, as a typed reference the CLI words and groups: what a plan
 * removes, and with a reason (`KeptObject`) what it keeps.
 */
export type EngineObject = {
  readonly kind: ObjectKind;
  /** Its name as the database spells it: `is_scam`, `facetdb.jobs`, `facetdb_worker`. */
  readonly name: string;
  /**
   * What it belongs to, when it is part of something: the table or collection of a column, field,
   * trigger, policy, index, view or side table; the part of a shared object that is meant (a
   * table's queued jobs, a source's log, a project's marker); what a grant is on. Absent for an
   * object of the database as a whole.
   */
  readonly of?: string;
  /**
   * `source`: it belongs to this table's install and goes with it. `run`: it serves every source
   * of the database (the jobs table, the marks, the enqueue functions, the store's tables, the
   * schema, the worker's use of a schema, the project's entry) and goes only when every source of
   * the run is gone; the CLI prints it once for the run.
   */
  readonly scope: "source" | "run";
  /**
   * How many rows it stands for, when the CLI says so: a source's decisions in the log, a table's
   * queued jobs. A number, so the CLI formats every count one way.
   */
  readonly count?: number;
  /** Why it goes, in words the CLI prints as they are: `no question asks it any more`. */
  readonly reason?: string;
  /**
   * What the database calls it, where its word is not the CLI's for the kind: MongoDB's `role` and
   * `user` for a `login`. The CLI's word for the kind when absent.
   */
  readonly noun?: string;
};

/** Something a plan leaves in place on purpose, never without why. */
export type KeptObject = EngineObject & {
  /** `every project on the server may share it`, `only --purge deletes a log`. */
  readonly reason: string;
};

/**
 * What an engine would do for one source, shown before anything runs: the statements in order, what
 * they remove, what stays and why, and what to tell and ask the operator. Plain data, so it prints
 * as `--json` and two plans compare as values.
 */
export type EnginePlan = {
  /** In the order they run; empty when there is nothing to do (a prune of a fresh source). */
  readonly statements: readonly PlanStatement[];
  /**
   * Whether `run` applies the statements as one transaction, all or nothing. False where the
   * database cannot (MySQL commits each DDL statement, MongoDB has none): a run that stops keeps
   * what ran before it, and the same plan run again completes it.
   */
  readonly transactional: boolean;
  /** What goes: this table's own objects (`source`), and what the whole run removes (`run`). */
  readonly removes: readonly EngineObject[];
  readonly keeps: readonly KeptObject[];
  /** What the operator must be told besides the script, one sentence each. */
  readonly notes: readonly string[];
  /**
   * The name typed back before the plan runs: the project's for an uninstall, the source's for a
   * purge of a log its earlier uninstall left. Absent when a yes is enough (install, prune).
   */
  readonly confirm?: { readonly kind: "project" | "source"; readonly name: string };
};

/**
 * Why an engine will not go on, and what to do instead. The CLI prints it as an error with its fix
 * and the docs page of its code.
 */
export type Refusal = {
  /** A short kebab-case id: `no-primary-key`, `another-project`, `no-replica-set`. */
  readonly code: string;
  readonly message: string;
  readonly fix: string;
};

/**
 * A refusal thrown where a call hands out something other than a plan: `open` throws it (a
 * plaintext URL, a table without a single-column key), so the CLI catches this one type across
 * engines and prints its code, message and fix as it prints a plan's refusal.
 */
export class EngineRefusal extends Error {
  readonly refusal: Refusal;

  constructor(refusal: Refusal) {
    super(refusal.message);
    this.name = "EngineRefusal";
    this.refusal = refusal;
  }
}

/** A plan, or a refusal instead of one: a refusal carries no statements, so nothing can run. */
export type PlanResult =
  | { readonly ok: true; readonly plan: EnginePlan }
  | { readonly ok: false; readonly refusal: Refusal };

/** What a run did. */
export type RunResult = {
  /**
   * The statements whose effect stays, in order: every one when the run finished; none when a
   * transactional run stopped (it rolled back); the ones before the stop otherwise.
   */
  readonly ran: readonly PlanStatement[];
  /**
   * Where the run stopped before its end, by index into the plan's statements, and why: one of the
   * engine's own checks refusing (another project claimed the table since the plan was read), or
   * the database's error, with no secret in its words. A failure after the last statement (the
   * commit, or the engine's own reading after it) is at the statement count: no statement failed.
   * Absent when the run finished.
   */
  readonly stopped?:
    | { readonly at: number; readonly refusal: Refusal }
    | { readonly at: number; readonly error: string };
  /**
   * What the run removed. A finished run reports its plan's `source`-scoped removes, and the
   * `run`-scoped ones only when it was the run's last: they belong to the last table's run of a
   * multi-table uninstall, whose statements find nothing still needing them. A stopped run reports
   * none: nothing links an object to a statement, so the CLI prints `ran` instead.
   */
  readonly removed: readonly EngineObject[];
  /** What the operator must be told now (`deleted`, where the plan said `deletes`). */
  readonly notes: readonly string[];
};

/**
 * One line `facetdb doctor` prints for a source.
 */
export type DoctorCheck = {
  /** What was checked: `database`, `pooler`, `install`; doctor's error code is `doctor-<name>`. */
  readonly name: string;
  /**
   * `fail` counts, and doctor exits 1 naming the first; `skip` is a check an earlier failure left
   * nothing to look at; `warn` is worth knowing and never a failure (the database is 190 ms away),
   * printed on its own line and not counted as a check.
   */
  readonly status: "ok" | "fail" | "skip" | "warn";
  /** What was found, in plain words, with no secret in them. */
  readonly detail: string;
  /** What to do, for a failure. */
  readonly fix?: string;
  /**
   * A `fail` of a reach check (`database`, `server`, `file`) that got no answer from the database
   * at all (refused, timed out, no such file, a file this user cannot write): nothing behind it was
   * read, so a reading of the install tells nothing and may be asked again once the server is up
   * or the file is there. A reach check that failed on what the database answered (another login
   * than the worker's, a string the engine refuses) leaves it unset: asking again changes nothing
   * until the string does, which the worker's environment fixes at its start.
   */
  readonly unreachable?: true;
};

/** What every call that reaches a database is given, besides the target and the URL. */
export type EngineDeps = {
  readonly clock: Clock;
  /**
   * The operator's `--allow-insecure`. Without it an engine refuses, before it connects, a URL that
   * would carry a password to another machine without TLS.
   */
  readonly allowInsecure: boolean;
  /**
   * Whether the FacetDB store is this source's own database: the same host, port and database as
   * the source's URL (the CLI compares them). Only then does a plan hold `store` statements and the
   * store's own objects, in one script with the source's; otherwise the plan is `source` only and
   * the CLI's store door owns the store.
   */
  readonly storeShared: boolean;
};

export type InstallOptions = EngineDeps & {
  /**
   * The worker login's password, from the source's connection string. An engine sets it only on a
   * login it creates: an existing one keeps its own, since other projects may share it. An engine
   * that must create the login and is given none refuses with the code `worker-login` before it
   * plans a statement, so the CLI can say how to put the password in the connection string.
   */
  readonly workerPassword?: string;
};

export type UninstallOptions = EngineDeps & {
  /**
   * Also delete the source's decision log (`--purge`): in the plan with `storeShared`, by the CLI's
   * store door otherwise. Without it the log always stays.
   */
  readonly purge: boolean;
  /**
   * The other sources this run uninstalls, before or after this one. They change the plan's words
   * only (its removes, keeps and notes say what the whole run leaves), never its statements: a
   * `run`-scoped object is dropped by a statement that checks at run time whether anything still
   * needs it (a `do` block on Postgres, an existence check on MySQL), so the first table's run
   * never drops the jobs table under the second table's trigger.
   */
  readonly alsoUninstalling: readonly EngineTarget[];
};

export type RunOptions = EngineDeps & {
  /** The password a `secret` statement binds; a run that reaches one without it stops there. */
  readonly workerPassword?: string;
};

export type OpenOptions = EngineDeps & {
  /** Names this worker's claims; two workers never share one. A fresh id when absent. */
  readonly workerId?: string;
  /**
   * The most connections the connector opens at once; the worker asks for its in-flight limit plus
   * two, so no lane waits for a connection.
   */
  readonly maxConnections?: number;
};

/** How many rows an inspection samples from the chosen table. */
export const INSPECT_SAMPLE_ROWS = 5;

/** The most tables an inspection lists; a database with more lists the first by name. */
export const INSPECT_MAX_TABLES = 500;

/** The longest a sampled value is shown, in characters; a longer one is cut there. */
export const INSPECT_MAX_VALUE = 500;

/** A column of the inspected table: its name and its type as the database writes it. */
export type InspectedColumn = { readonly name: string; readonly type: string };

/**
 * What the studio's setup flow sees of a database before anything is installed: the tables the
 * admin connection may read, and for the one asked about its columns, its single-column key and a
 * few rows as the model would read them.
 */
export type TableInspection = {
  /**
   * The tables, as the config names a table: bare in the engine's default schema (`listings` for
   * `public.listings` on Postgres), `schema.table` elsewhere. At most `INSPECT_MAX_TABLES`.
   */
  readonly tables: readonly string[];
  /** The table asked about; absent when none was. */
  readonly table?: {
    /** As the config names it, as in `tables`. */
    readonly name: string;
    /** Its single-column primary key; null when it has none or a composite one. */
    readonly key: string | null;
    /** In the table's order, FacetDB's own `facetdb_` columns left out. */
    readonly columns: readonly InspectedColumn[];
    /**
     * Up to `INSPECT_SAMPLE_ROWS` rows, newest first by the key, each column as text the way the
     * worker reads a state field (null for NULL), a value cut at `INSPECT_MAX_VALUE` characters.
     */
    readonly rows: readonly Readonly<Record<string, string | null>>[];
  };
};

export type InspectOptions = Pick<EngineDeps, "allowInsecure"> & {
  /** The table to read the columns and rows of, as `TableInspection.tables` names it. */
  readonly table?: string;
};

/** An inspection, or why the engine will not make one (an insecure URL, a table it cannot read). */
export type InspectResult =
  | { readonly ok: true; readonly inspection: TableInspection }
  | { readonly ok: false; readonly refusal: Refusal };

export type ReadRowsOptions = Pick<EngineDeps, "allowInsecure"> & {
  /** The most rows read, newest first. */
  readonly limit: number;
};

/**
 * A few rows of a table no source runs yet, as `scan` reads a state: the setup flow's preview and
 * the first backfill's estimate. `estimatedRows` is the database's own estimate of the table's size
 * from its statistics (no count is run), null when it has none; the where filter is not in it.
 */
export type ReadRowsResult =
  | {
      readonly ok: true;
      readonly rows: readonly ReadRow[];
      readonly estimatedRows: number | null;
    }
  | { readonly ok: false; readonly refusal: Refusal };

/** A source's runtime connector as `open` hands it out; whoever opened it closes it. */
export type OpenConnector = Connector & {
  /** Ends a running `watch` and lets go of the connection. */
  close(): Promise<void>;
};

/**
 * A record key as its user writes it, for an engine whose keys carry a type tag (MongoDB keys an
 * ObjectId `oid:<hex>` and a number `n:<number>`, so one key never names two documents). The tagged
 * key stays what the store, the queue and the log hold; the CLI prints a key through `toText` and
 * reads a typed one through `fromText`, so `facetdb explain listings 1` finds what the worker
 * logged as `listings: answered 1`. `fromText(toText(key))` is `key` for every key.
 */
export type KeyText = {
  /** The key as the user writes it: `oid:65f1…` is `65f1…`, `n:1` is `1`. */
  toText(key: RecordKey): string;
  /** The key the user's text names: what `toText` printed, or the tagged key itself as written. */
  fromText(text: string): RecordKey;
  /** How a key is written, in words, for the hint a lookup that found nothing gives. */
  readonly form: string;
};

/**
 * One database FacetDB installs on and reads from. The composition root makes each engine with its
 * own driver; the CLI calls engines and nothing else of a database.
 */
export type DatabaseEngine = {
  /** How the CLI names it: `postgres`, `mysql`, `mongodb`. */
  readonly name: string;
  /** The URL schemes it serves, without the colon: `postgres` and `postgresql`. */
  readonly schemes: readonly string[];
  /** What its databases can do; the connector `open` hands out declares the same. */
  readonly capabilities: Capabilities;
  /**
   * How its keys are written on the terminal, when that is not the key itself. Absent for the SQL
   * engines: their key is the primary key as text already.
   */
  readonly keyText?: KeyText;
  /**
   * How one source's keys are written, where the engine records a key type per table in the
   * source's database (MongoDB's marker holds the collection's `_id` type, so a string `_id` "1001"
   * is typed and printed `1001`). Read with the worker login's `url`, before anything else
   * connects; `keyText` where nothing is recorded. The CLI asks this before `keyText` on every door
   * that prints or reads a key. Absent, `keyText` is every source's.
   */
  keyTextOf?(
    target: EngineTarget,
    url: string,
    deps: Pick<EngineDeps, "allowInsecure">,
  ): Promise<KeyText>;
  /** The checks `doctor` runs, in order, and what each looks at: `doctor --dry-run` lists them. */
  readonly checks: readonly { readonly name: string; readonly looksAt: string }[];
  /**
   * The source's table as the engine's words name it: what every command's headers and
   * confirmations say (migrate, uninstall, preview, backfill, explain, dev). `url` is a connection
   * string of the source's database: the source's own, or the admin one migrate and uninstall plan
   * with, so the label agrees with the plan's object names. The schema as the config writes it
   * where it names one; otherwise the engine's own default where it has a fixed one
   * (`public.listings` on Postgres and CockroachDB, `dbo.listings` on SQL Server), the database
   * `url`'s path names where the default is the connection's database (`app.listings` on MySQL and
   * MongoDB; the bare name when the path names none), and the bare name where there is no schema
   * (SQLite, libSQL). Nothing connects; an engine with a fixed default ignores `url`.
   */
  label(target: EngineTarget, url: string): string;
  /**
   * The user and password a connection string logs in with, read as this engine's driver reads it,
   * each decoded and empty when the string has none; undefined when the driver would not take the
   * string. For an engine whose usual strings the WHATWG URL parser cannot read: MongoDB's, whose
   * replica set string names several hosts (`mongodb://a:27017,b:27017/app`), which `new URL`
   * refuses. Without it the CLI reads the string with `new URL`, as it does for Postgres; a libpq
   * several-host string (`postgresql://h1,h2/db`) is not read yet. Nothing connects.
   */
  login?(url: string): { readonly user: string; readonly password: string } | undefined;
  /**
   * The install for a source, from the database as the admin `url` shows it now: the answer
   * columns, the queue, the change capture, the worker login and its grants. Idempotent: on an
   * installed source it changes nothing.
   */
  planInstall(target: EngineTarget, url: string, options: InstallOptions): Promise<PlanResult>;
  /**
   * The uninstall: what install added goes, the decision log only with `purge`. `alsoUninstalling`
   * changes the plan's words, never its statements. With a separate store the engine still makes
   * the purge's checks on the source's side through `table_owners` (another installed table of the
   * project, the table live again) and refuses as today; the CLI's store door deletes the log only
   * after the engine's run has finished.
   */
  planUninstall(target: EngineTarget, url: string, options: UninstallOptions): Promise<PlanResult>;
  /**
   * `migrate --prune`: the columns of questions the set no longer has, and the reads `read` no
   * longer lists. A source not installed yet has nothing to prune: an empty plan, not a refusal.
   */
  planPrune(target: EngineTarget, url: string, deps: EngineDeps): Promise<PlanResult>;
  /**
   * The plan as one script in the engine's language, exactly as the CLI prints it before running
   * it: framed as one transaction when the plan runs as one; empty for a plan with no statements.
   */
  render(plan: EnginePlan): string;
  /**
   * Runs every statement of the plan against `url`, the source's database (the store's too with
   * `storeShared`), in order. With the target the engine checks again, inside the run, what the
   * plan read before it: on Postgres, the table's owner right after the claim.
   */
  run(target: EngineTarget, plan: EnginePlan, url: string, options: RunOptions): Promise<RunResult>;
  /**
   * What `open` and `doctor` refuse the worker login's `url` with before they connect (a URL that
   * would carry a password to another machine in the clear, unless `allowInsecure`), worded with
   * `target.urlVariable`, or undefined; nothing connects. The CLI asks it of every source before it
   * opens anything, so one refused source opens nothing, the store included.
   */
  checkUrl(
    target: EngineTarget,
    url: string,
    deps: Pick<EngineDeps, "allowInsecure">,
  ): Refusal | undefined;
  /**
   * The runtime connector for a source, under the worker login's `url`. A refusal (the URL's,
   * `checkUrl`'s, or a table without a single-column key) is thrown as an `EngineRefusal`.
   */
  open(target: EngineTarget, url: string, options: OpenOptions): Promise<OpenConnector>;
  /** doctor's checks of a source under the worker login's `url`, in order. Nothing is changed. */
  doctor(target: EngineTarget, url: string, deps: EngineDeps): Promise<readonly DoctorCheck[]>;
  /**
   * The tables the admin `url` may read, and with `options.table` that table's columns, key and
   * sample rows (the studio's setup flow, before any source exists). One connection with a short
   * timeout, read-only, closed whatever happens; refused before it connects as `planInstall`
   * refuses an insecure admin URL. Absent on an engine the studio cannot set up a source on yet:
   * the CLI's `facetdb init` and `facetdb migrate` serve it.
   */
  inspect?(url: string, options: InspectOptions): Promise<InspectResult>;
  /**
   * The newest `options.limit` rows of a target no worker runs yet, under the admin `url`: each
   * state as `scan` reads it, the where filter judged as `scan` judges it, and the table's
   * estimated size. Bounded as `inspect` is: one connection, one read-only transaction, a statement
   * timeout set for that transaction alone, nothing set on the session. The where filter runs as
   * the admin role inside those bounds. Absent where `inspect` is.
   */
  readRows?(target: EngineTarget, url: string, options: ReadRowsOptions): Promise<ReadRowsResult>;
};
