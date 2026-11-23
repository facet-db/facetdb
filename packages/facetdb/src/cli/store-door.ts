import { type Clock, type DoctorCheck, HEARTBEAT_LOSS_MS, type QuestionSet } from "@facetdb/core";
import {
  AmbiguousHostError,
  deleteCursorsSql,
  LOCK_TIMEOUT,
  PlaintextUrlError,
  type PurgedSource,
  planStoreStep,
  readResumeRows,
  readStoreLog,
  rebuildStoreReviewQueue,
  requireTls,
  resumeRowsStatements,
  runStoreStep,
  SCHEMA_VERSION,
  SECRET_VARIABLE,
  type SqlConnect,
  STORE_NEWER_STATE,
  StoreBusyError,
  type StoreLog,
  sourceIdOf,
  storePurgeRefusal,
  storePurgeStatements,
  storeScript,
  storeVersion,
} from "@facetdb/postgres";
import type { SourceConfig } from "../config/index.ts";
import { databaseChanged, isPostgresUrl, schemeOf } from "./engines.ts";
import { CliError, databaseLabel, plainMessage } from "./program.ts";

// The reviewer accounts' rules: a command checks a name and hashes a password before it opens the
// store, so a bad invocation is refused before any connection.
export {
  hashPassword,
  isUserName,
  MIN_PASSWORD_LENGTH,
  USER_NAME_RULE,
  UsersNotWritableError,
} from "@facetdb/postgres";

/**
 * The store door: everything the CLI does with the FacetDB store, which is always the Postgres that
 * `DATABASE_URL` names, whatever engine a source has. A command reaches a source's database through
 * its engine and the store through here; the composition root opens the store's services
 * (`createStore`, main.ts). When the store is a source's own database (`storeShared`) the engine's
 * plans carry the store's statements (no-ops on a current store) and uninstall's and doctor's store
 * parts; otherwise, and always for a polling source, uninstall's purge and doctor's store group are
 * here. Migrate's store step is here in both cases: it runs on its own, before any source's
 * transaction.
 */

type Env = Readonly<Record<string, string | undefined>>;

/** The variable that names the store. */
export const STORE_VARIABLE = "DATABASE_URL";

/** The store's secret's variable: it encrypts what the store keeps. */
export const STORE_SECRET_VARIABLE = SECRET_VARIABLE;

/** The id the store keeps a source's log, versions and registration under: project and name. */
export const storeSourceId = sourceIdOf;

/** `DATABASE_URL`, or undefined when it is unset or empty. */
export function storeUrlOf(env: Env): string | undefined {
  const url = env[STORE_VARIABLE];
  return url === undefined || url === "" ? undefined : url;
}

/**
 * What the store's TLS rule (`requireTls`) says about a connection string: undefined when it may
 * be used, `"invalid"` when it is not a URL, `"ambiguous"` when its host cannot be read for sure
 * (more than one `@` before the path), else the host it would reach without TLS. `pgHost` is the
 * environment's `PGHOST`, where the driver goes for a URL that names no host.
 */
function tlsRefusal(
  url: string,
  allowInsecure: boolean | undefined,
  pgHost: string | undefined,
): "invalid" | "ambiguous" | { readonly host: string; readonly viaPgHost: boolean } | undefined {
  try {
    requireTls(url, allowInsecure ?? false, pgHost);
    return undefined;
  } catch (error) {
    if (error instanceof AmbiguousHostError) {
      return "ambiguous";
    }
    return error instanceof PlaintextUrlError
      ? { host: error.host, viaPgHost: error.viaPgHost }
      : "invalid";
  }
}

const AMBIGUOUS =
  "has more than one @ before the path, so its host cannot be read for sure (the driver and the check would read different hosts)";
const ambiguousFix = (target: string) =>
  `percent-encode every @ in the user and password of ${target} as %40`;

/** Where a refused URL would go: its host, or `PGHOST`'s when the URL names none. */
const reaches = (
  subject: string,
  refusal: { readonly host: string; readonly viaPgHost: boolean },
) =>
  refusal.viaPgHost
    ? `${subject} names no host, so the driver reaches PGHOST (${refusal.host}) without TLS`
    : `${subject} reaches ${refusal.host} without TLS`;

const fixFor = (target: string, viaPgHost: boolean) =>
  `add ?sslmode=require to ${target},${viaPgHost ? " point PGHOST at this machine or a socket directory," : ""} or pass --allow-insecure if that network is trusted`;

/**
 * The words for a Postgres connection string (`variable` names where it came from) that the
 * store's TLS rule refuses, with the fix, or undefined when the URL may be used.
 */
function tlsProblem(
  url: string,
  variable: string,
  allowInsecure: boolean | undefined,
  pgHost: string | undefined,
): { readonly problem: string; readonly fix: string } | undefined {
  const refusal = tlsRefusal(url, allowInsecure, pgHost);
  if (refusal === undefined) {
    return undefined;
  }
  if (refusal === "ambiguous") {
    return { problem: `${variable} ${AMBIGUOUS}`, fix: ambiguousFix(variable) };
  }
  return refusal === "invalid"
    ? {
        problem: `${variable} is not a connection string (postgres://user:password@host/database)`,
        fix: fixFor(variable, false),
      }
    : {
        problem: `${reaches(variable, refusal)}, so the password in it would travel in the clear`,
        fix: fixFor(variable, refusal.viaPgHost),
      };
}

/** A `pglite://` store is `facetdb dev`'s embedded one, never a store elsewhere. */
export const PGLITE_STORE = "a PGlite store is for facetdb dev; point DATABASE_URL at a Postgres";

const PGLITE_FIX =
  "set DATABASE_URL to a Postgres connection string (postgres://user:password@host/database; a free Supabase or Neon project is enough), or run facetdb dev, which keeps its own store under .facetdb/dev/";

/**
 * Why the store's URL may not be used, before anything connects; undefined when it may: a PGlite
 * store outside `facetdb dev`, a database of another kind (the store is always a Postgres), or a
 * password in the clear to another machine.
 */
export function storeUrlProblem(
  url: string,
  allowInsecure: boolean | undefined,
  pgHost: string | undefined,
):
  | {
      readonly code: "store-pglite" | "store-not-postgres" | "database-url-tls";
      readonly problem: string;
      readonly fix: string;
    }
  | undefined {
  const scheme = schemeOf(url);
  if (scheme === "pglite") {
    return { code: "store-pglite", problem: PGLITE_STORE, fix: PGLITE_FIX };
  }
  // A string with no scheme is no connection string at all: the TLS rule's words say so.
  if (scheme !== undefined && !isPostgresUrl(url)) {
    return {
      code: "store-not-postgres",
      problem: `DATABASE_URL names a ${scheme}: database, and the FacetDB store is always a Postgres`,
      fix: "point DATABASE_URL at a Postgres (postgres://user:password@host/database; a free Supabase or Neon project is enough), and read a source's own database from a variable of its own",
    };
  }
  const tls = tlsProblem(url, STORE_VARIABLE, allowInsecure, pgHost);
  return tls === undefined ? undefined : { code: "database-url-tls", ...tls };
}

/** Refuses a store URL that may not be used, before any connection, in the words a command prints. */
export function requireUsableStoreUrl(
  url: string,
  allowInsecure: boolean | undefined,
  pgHost: string | undefined,
): void {
  const refused = storeUrlProblem(url, allowInsecure, pgHost);
  if (refused !== undefined) {
    throw new CliError(
      refused.code,
      refused.code === "database-url-tls"
        ? `${refused.problem}; no connection was made`
        : refused.problem,
      refused.fix,
    );
  }
}

/**
 * The store's URL, refused before anything connects when it is unset, PGlite's, another kind of
 * database's or plaintext.
 */
export function requireStoreUrl(env: Env, allowInsecure: boolean | undefined): string {
  const url = storeUrlOf(env);
  if (url === undefined) {
    throw new CliError(
      "database-url",
      "DATABASE_URL is not set, so FacetDB has no database for its store",
      "set DATABASE_URL to the connection string of the database FacetDB keeps its store in",
    );
  }
  requireUsableStoreUrl(url, allowInsecure, env["PGHOST"]);
  return url;
}

/**
 * Where a Postgres URL connects, as postgres.js resolves it (3.4.9's `parseOptions`): the URL's
 * host, else `PGHOST`, else localhost; its port, else `PGPORT`, else 5432; its database (the path
 * as written, which the driver does not decode), else `PGDATABASE`, else the user, which is the
 * URL's, else `PGUSERNAME`, else `PGUSER`, else the machine's own (the same for both sides, so
 * written as empty). Undefined for any other URL.
 */
function addressOf(
  url: string,
  env: Env,
):
  | {
      readonly host: string;
      readonly port: string;
      readonly database: string;
      readonly user: string;
    }
  | undefined {
  if (!isPostgresUrl(url)) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  /** A part of the URL, absent when empty, as the driver's `||` reads it. */
  const given = (text: string) => (text === "" ? undefined : text);
  const setting = (name: string) => given(env[name] ?? "");
  const user =
    given(decodeURIComponent(parsed.username)) ?? setting("PGUSERNAME") ?? setting("PGUSER") ?? "";
  return {
    host: (given(parsed.hostname) ?? setting("PGHOST") ?? "localhost").toLowerCase(),
    port: given(parsed.port) ?? setting("PGPORT") ?? "5432",
    database: given(parsed.pathname.slice(1)) ?? setting("PGDATABASE") ?? user,
    user,
  };
}

/**
 * Whether two connection strings reach one database (`storeShared`, the CLI's to compute): the same
 * host, port and database once postgres.js's defaults apply to both, read from `env` as the driver
 * reads `process.env`, so two URLs the driver routes to different databases never compare equal,
 * and a port written on one side matches `PGPORT` on the other. Logins may differ.
 */
export function sameDatabase(a: string, b: string, env: Env): boolean {
  const left = addressOf(a, env);
  const right = addressOf(b, env);
  return (
    left !== undefined &&
    right !== undefined &&
    left.host === right.host &&
    left.port === right.port &&
    left.database === right.database
  );
}

/** Whether two connection strings reach one database as one login (the user as the driver reads it). */
function sameLogin(a: string, b: string, env: Env): boolean {
  return sameDatabase(a, b, env) && addressOf(a, env)?.user === addressOf(b, env)?.user;
}

/**
 * The variable a source's own connection string is read from when it is not the store's: never
 * `DATABASE_URL`, which names the store, so a source called `database` reads `DATABASE_SOURCE_URL`.
 */
export function ownVariable(sourceName: string): string {
  const variable = `${sourceName.toUpperCase()}_URL`;
  return variable === STORE_VARIABLE ? `${sourceName.toUpperCase()}_SOURCE_URL` : variable;
}

/**
 * A source that reads `DATABASE_URL`, the store's variable, for a database that is not a Postgres:
 * a configuration error, since the store is always a Postgres, as the error to print (doctor makes
 * it the source's failed database check); undefined for any other source.
 */
export function storeVariableMisuse(
  source: SourceConfig,
  url: string | undefined,
): CliError | undefined {
  if (source.databaseEnv !== STORE_VARIABLE || url === undefined || isPostgresUrl(url)) {
    return undefined;
  }
  const variable = ownVariable(source.name);
  return new CliError(
    "store-not-postgres",
    `the source "${source.name}" reads DATABASE_URL, the store's variable, and its database is not a Postgres (${schemeOf(url) ?? "no scheme"}); the FacetDB store is always a Postgres, so a source of another kind reads a variable of its own`,
    `write database: env("${variable}") for the source in facetdb.config.ts, set ${variable} to its connection string, and point DATABASE_URL at the store's Postgres`,
  );
}

/**
 * A polling source whose connection string reaches the store's database as the store's own login
 * (`DATABASE_URL`'s: the same database and the same user, whatever variable holds either), as the
 * error to print; undefined for any other source. Its engine installs the table's columns and none
 * of the store's tables, so the store door runs the store's part as `DATABASE_URL`'s login while
 * the source's string must log in as the worker: one login cannot be both. The same database with
 * the worker's own login on the source is the two-credential setup, and passes. A shared store for
 * a polling source, in one plan, is not supported yet.
 */
export function pollingStoreClash(
  env: Env,
  source: SourceConfig,
  url: string | undefined,
): CliError | undefined {
  const store = storeUrlOf(env);
  if (
    enginePlansStore(source) ||
    url === undefined ||
    store === undefined ||
    !sameLogin(store, url, env)
  ) {
    return undefined;
  }
  const variable =
    source.databaseEnv === undefined || source.databaseEnv === STORE_VARIABLE
      ? ownVariable(source.name)
      : source.databaseEnv;
  return new CliError(
    "store-polling",
    `the source "${source.name}" has connector: "polling" and connects to the FacetDB store's database as the store's own login (the one in DATABASE_URL); the polling connector installs the table's columns and none of the store's tables, so the source and the store need two logins`,
    `keep the two credentials apart: set ${variable} to the worker login's connection string, postgres://facetdb_worker:<a long random password>@<host>/<database>, named with database: env("${variable}") in facetdb.config.ts, and keep the store owner's connection string in DATABASE_URL; the same database is fine`,
  );
}

/**
 * Whether a source's engine plans the store's part when the store is the source's own database:
 * only the Postgres trigger engine's plans hold it (today's one script). The polling engine
 * (`connector: "polling"`) serves every SQL database and plans the source's part alone, so for a
 * polling source the store door runs the store's part wherever the store is.
 */
export function enginePlansStore(source: SourceConfig): boolean {
  return source.connector !== "polling";
}

/**
 * Whether the store is this source's own database. A Postgres source whose connection string the
 * config reads from `DATABASE_URL` is, by definition: the loader read it there. Any other Postgres
 * source is compared with `DATABASE_URL` (`sameDatabase`), and without it has no store yet. A
 * source of another kind never shares the store, which is always a Postgres; one that reads
 * `DATABASE_URL` is refused in words (`storeVariableMisuse`), so no later engine shares by
 * accident. Nor does a polling source (`enginePlansStore`): its engine never plans the store's
 * part, so the store door runs it even when `DATABASE_URL` names the source's database.
 */
export function storeSharedFor(env: Env, source: SourceConfig): boolean {
  const misuse =
    storeVariableMisuse(source, source.database) ?? pollingStoreClash(env, source, source.database);
  if (misuse !== undefined) {
    throw misuse;
  }
  if (!enginePlansStore(source)) {
    return false;
  }
  if (source.database !== undefined && !isPostgresUrl(source.database)) {
    return false;
  }
  if (source.databaseEnv === STORE_VARIABLE) {
    return true;
  }
  const store = storeUrlOf(env);
  return (
    store !== undefined &&
    source.database !== undefined &&
    sameDatabase(store, source.database, env)
  );
}

/** The store's part of `facetdb migrate` (its step), as shown before it runs. */
export type StoreMigration = {
  /** Where it runs: `host/db`, what the script's header and the confirmation name. */
  readonly label: string;
  /**
   * Whether the store is at this FacetDB's schema version already: then nothing runs there, no
   * DDL is shown, and `--json` reports nothing applied.
   */
  readonly current: boolean;
  /**
   * The step's script (`storeStepStatements`: the store's lock, then its whole idempotent DDL),
   * what migrate brings it to and runs statement for statement; empty when it is current.
   */
  readonly script: string;
  /** What its migrations cannot settle (store version 4's shared logs), said before it runs. */
  readonly notes: readonly string[];
  /** Whether the login may create the store's tables; true when it is current (nothing to create). */
  readonly mayCreate: boolean;
};

/**
 * Whose connection string reaches the store for its step: `DATABASE_URL`'s when the store is its
 * own database, the admin's when it is the source's (the store's step runs on its own there too,
 * under the admin string the source's install runs with).
 */
export type StoreLogin = "store" | "admin";

function storeNewer(label: string, newest: number): CliError {
  return new CliError(
    "store-newer",
    `the FacetDB store on ${label} is at schema version ${newest}, newer than this FacetDB knows (${SCHEMA_VERSION}); nothing was run`,
    "upgrade FacetDB to the version that wrote the store, then run facetdb migrate again",
  );
}

/**
 * The store's step as it stands, read and nothing else: current, or the script that brings it to
 * this version. A store newer than this FacetDB is refused here, before the confirmation, in words.
 */
export async function showStoreMigration(
  connect: SqlConnect,
  url: string,
): Promise<StoreMigration> {
  const client = connect(url);
  try {
    const label = databaseLabel(url);
    const step = await planStoreStep(client.query);
    if (step.kind === "newer") {
      throw storeNewer(label, step.newest);
    }
    return step.kind === "current"
      ? { label, current: true, script: "", notes: [], mayCreate: true }
      : {
          label,
          current: false,
          script: storeScript(step.statements),
          notes: step.notes,
          mayCreate: step.mayCreate,
        };
  } finally {
    await client.close();
  }
}

/**
 * The refusal of a store step whose login may not create the store's tables, before the
 * confirmation: in the words of the string that reaches it (`DATABASE_URL`, or the admin string
 * when the store is the source's own database).
 */
export function storeLoginError(label: string, login: StoreLogin): CliError {
  return login === "store"
    ? new CliError(
        "store-login",
        `the login in DATABASE_URL may not create the store's tables in ${label}; nothing was run`,
        "point DATABASE_URL at a login that may create tables in that database (its owner, as a free Supabase or Neon project gives you), then run facetdb migrate again",
      )
    : new CliError(
        "store-login",
        `the login in the admin connection string may not create the store's tables in ${label}; nothing was run`,
        "give the admin connection string of a login that may create tables in that database (its owner, as a free Supabase or Neon project gives you), then run facetdb migrate again",
      );
}

/**
 * Refuses, in FacetDB's words, a store step the login may not run (it may not create the store's
 * tables), so no caller meets Postgres's bare "permission denied": `runStoreMigration` checks it at
 * every run, and migrate before its confirmation too. A dry run prints the step without it.
 */
export function requireStoreRunnable(store: StoreMigration, login: StoreLogin): void {
  if (!store.current && !store.mayCreate) {
    throw storeLoginError(store.label, login);
  }
}

/**
 * The step stopped at its lock timeout, in FacetDB's words: which store table is busy and what to
 * do. Its one transaction rolled back, so nothing of it ran.
 */
function storeBusy(error: StoreBusyError, label: string): CliError {
  const table = error.table ?? "one of the store's tables";
  return new CliError(
    "store-busy",
    `another transaction holds ${table} on ${label}, so the FacetDB store's migration stopped waiting for it after ${LOCK_TIMEOUT}; nothing was run`,
    `wait for that transaction to end, or end it (pg_stat_activity names it; pg_locks shows what it holds on ${table}), then run facetdb migrate again`,
  );
}

/**
 * Brings the store to this FacetDB's schema version in its own transaction, before any source's
 * part runs: the step is planned again right before the run and runs only when its script is the
 * one shown, statement for statement, so the SQL executed is the SQL printed. A store that moved
 * since the show (another migrate, a worker's start) runs nothing: the words say to look again. A
 * login that may not create the store's tables, and a store table another transaction holds past
 * the step's lock timeout, stop in FacetDB's words.
 */
export async function runStoreMigration(
  connect: SqlConnect,
  url: string,
  shown: StoreMigration,
  login: StoreLogin,
): Promise<void> {
  const client = connect(url);
  try {
    const again = await planStoreStep(client.query);
    if (again.kind === "newer") {
      throw storeNewer(shown.label, again.newest);
    }
    // For a store that is behind, the script is a constant (the whole idempotent DDL), so this
    // compare checks the kind alone: still behind, as shown. What protects the run from a store
    // that moves after it is the script itself: the store's advisory lock taken first, and FD053
    // raised under it when a newer FacetDB wrote the store.
    if (again.kind !== "behind" || storeScript(again.statements) !== shown.script) {
      throw databaseChanged();
    }
    requireStoreRunnable({ ...shown, mayCreate: again.mayCreate }, login);
    await runStoreStep(client, again.statements);
  } catch (error) {
    if (error instanceof StoreBusyError) {
      throw storeBusy(error, shown.label);
    }
    // The step's own check under the store's lock: a newer FacetDB migrated it between the two
    // reads. The driver's error is a boundary, read by its code; the transaction rolled back.
    if (error instanceof Error && "code" in error && error.code === STORE_NEWER_STATE) {
      const found = await storeVersion(client.query);
      throw storeNewer(shown.label, found.kind === "found" ? found.newest : 0);
    }
    throw error;
  } finally {
    await client.close();
  }
}

/**
 * Once the store holds the review queue (migration 6), the records decided needs_review before it
 * existed get their cards from the decision log, once per project of the store
 * (`rebuildStoreReviewQueue`). `questionSets` maps each of the project's sources, by store id, to
 * the set it runs under. Returns how many records wait, or undefined when an earlier migrate of the
 * project already listed them.
 */
export async function rebuildReviewCards(
  connect: SqlConnect,
  url: string,
  projectId: string,
  questionSets: ReadonlyMap<string, QuestionSet>,
): Promise<number | undefined> {
  const client = connect(url);
  try {
    return await rebuildStoreReviewQueue(client, projectId, questionSets);
  } catch (error) {
    throw new CliError(
      "review-queue",
      `the review queue could not be listed from the decision log in ${databaseLabel(url)}: ${plainMessage(error, [url])}; everything above ran`,
      "run facetdb migrate again: it lists the records waiting for review once the store answers",
    );
  } finally {
    await client.close();
  }
}

/**
 * The store's part of `facetdb uninstall` when it is its own database, as shown: with `--purge` the
 * source's decision log (`log`), and always the source's resume rows in `facetdb.cursors` (its
 * backfills' places, a MongoDB stream's token, a Change Tracking version), so a source installed
 * again never resumes from where this one stopped.
 */
export type StoreUninstall = {
  readonly label: string;
  readonly statements: readonly string[];
  readonly script: string;
  /** The log the purge deletes; undefined without `--purge`, when the log stays. */
  readonly log: StoreLog | undefined;
  /** The run keys of the source's resume rows, as read before the script is shown. */
  readonly resumeRows: readonly string[];
};

/**
 * The store's part for one source, read and nothing else: undefined when there is nothing to do
 * there (no `--purge`, and no resume row of the source in the store). With `--purge` the script is
 * the log's purge then the resume rows' delete, in one transaction; without, the delete alone.
 */
export async function showStoreUninstall(
  connect: SqlConnect,
  url: string,
  source: PurgedSource,
  purge: boolean,
): Promise<StoreUninstall | undefined> {
  const client = connect(url);
  try {
    const resumeRows = await readResumeRows(client.query, source.id);
    if (!purge && resumeRows.length === 0) {
      return undefined;
    }
    const statements = [
      ...(purge ? storePurgeStatements(source) : []),
      ...resumeRowsStatements(source.id),
    ];
    return {
      label: databaseLabel(url),
      statements,
      script: storeScript(statements),
      log: purge ? await readStoreLog(client.query, source.id) : undefined,
      resumeRows,
    };
  } finally {
    await client.close();
  }
}

/** The statement an operator runs in the store to delete the resume rows a failed part left. */
export function resumeRowsByHand(part: StoreUninstall): string {
  return deleteCursorsSql(part.resumeRows);
}

/** The fix of a refused purge, in the words of the engine's refusals. */
const REFUSED_FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

/** Runs the store's part shown, as shown, in one transaction; its guard's refusal is the CLI's error. */
export async function runStoreUninstall(
  connect: SqlConnect,
  url: string,
  part: StoreUninstall,
): Promise<void> {
  const client = connect(url);
  try {
    await client.transaction(async (query) => {
      for (const statement of part.statements) {
        await query(statement);
      }
    });
  } catch (error) {
    const refused = storePurgeRefusal(error);
    if (refused !== undefined) {
      throw new CliError("uninstall-refused", refused, REFUSED_FIX);
    }
    throw error;
  } finally {
    await client.close();
  }
}

const ok = (name: string, detail: string): DoctorCheck => ({ name, status: "ok", detail });
const fail = (name: string, detail: string, fix: string): DoctorCheck => ({
  name,
  status: "fail",
  detail,
  fix,
});

const DATABASE_URL_FIX =
  "set DATABASE_URL to the connection string of the database FacetDB keeps its store in";

/** Opens a connection, runs `work` and closes it, whatever happens. */
async function withConnection<T>(
  connect: SqlConnect,
  url: string,
  work: (query: ReturnType<SqlConnect>["query"]) => Promise<T>,
): Promise<T> {
  const client = connect(url);
  try {
    return await work(client.query);
  } finally {
    await client.close();
  }
}

/**
 * doctor's store check: `DATABASE_URL` is set, a Postgres (never a PGlite store outside `facetdb
 * dev`), reached with TLS, and at this FacetDB's schema version. It reads; nothing is created, so a
 * store that is behind says so instead of being migrated.
 */
export async function storeCheck(
  connect: SqlConnect,
  env: Env,
  allowInsecure: boolean | undefined,
): Promise<DoctorCheck> {
  const url = storeUrlOf(env);
  if (url === undefined) {
    return fail(
      "store",
      "DATABASE_URL is not set, so FacetDB has no database for its store",
      DATABASE_URL_FIX,
    );
  }
  const refused = storeUrlProblem(url, allowInsecure, env["PGHOST"]);
  if (refused !== undefined) {
    return fail("store", refused.problem, refused.fix);
  }
  const label = databaseLabel(url);
  try {
    const found = await withConnection(connect, url, storeVersion);
    if (found.kind === "absent") {
      return fail(
        "store",
        `the FacetDB store on ${label} is not installed`,
        "run facetdb migrate with the admin credential: it prints the store's SQL first and installs it",
      );
    }
    if (found.newest > SCHEMA_VERSION) {
      return fail(
        "store",
        `the FacetDB store on ${label} is at schema version ${found.newest}, newer than this FacetDB knows (${SCHEMA_VERSION})`,
        "upgrade FacetDB to the version that wrote it",
      );
    }
    return found.current
      ? ok(
          "store",
          `the FacetDB store on ${label} is reachable and current (schema version ${SCHEMA_VERSION})`,
        )
      : fail(
          "store",
          `the FacetDB store on ${label} is at schema version ${found.newest}, behind this FacetDB (${SCHEMA_VERSION})`,
          "run facetdb migrate with the admin credential: it brings the store to this version",
        );
  } catch (error) {
    return fail(
      "store",
      `the FacetDB store on ${label} could not be read: ${plainMessage(error, [url, env[SECRET_VARIABLE]])}`,
      "check the host, port, user and password in DATABASE_URL, and that the database accepts connections from this machine (a firewall or an allow-list)",
    );
  }
}

/** A statement with a parameter, so the driver prepares it under a name, as it does the worker's. */
const POOLER_PROBE = "select pg_backend_pid() as pid, $1::int as run";

/** The server's error code, read off the driver's error (a boundary). */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

/**
 * Supabase serves transaction mode on port 6543: Supavisor on its pooler hosts
 * (`*.pooler.supabase.com`, session mode on 5432) and the dedicated PgBouncer beside the database
 * (`db.<project ref>.supabase.co`, the database itself on 5432).
 */
function supabaseTransactionPort(url: string): boolean {
  try {
    const { port, hostname } = new URL(url);
    return (
      port === "6543" &&
      (hostname.endsWith(".pooler.supabase.com") || /^db\.[^.]+\.supabase\.co$/.test(hostname))
    );
  } catch {
    return false;
  }
}

/**
 * Why the store's connection cannot keep the worker's prepared statements, or undefined when it
 * can: one prepared statement run twice on one client connection (`max: 1`) either finds itself
 * gone (SQLSTATE 26000) or runs in two server sessions behind a transaction pooler.
 */
async function transactionPooler(connect: SqlConnect, url: string): Promise<string | undefined> {
  if (supabaseTransactionPort(url)) {
    return "port 6543 of a Supabase host is its transaction-mode pooler";
  }
  const client = connect(url, { max: 1 });
  try {
    const first = await client.query(POOLER_PROBE, [1]);
    const second = await client.query(POOLER_PROBE, [2]);
    return first[0]?.["pid"] === second[0]?.["pid"]
      ? undefined
      : "one prepared statement ran in two server sessions on one connection";
  } catch (error) {
    if (sqlState(error) === "26000") {
      return "a prepared statement was gone on its second run (SQLSTATE 26000, prepared statement does not exist)";
    }
    throw error;
  } finally {
    await client.close();
  }
}

const STORE_POOLER_FIX =
  "use the session pooler (port 5432) or a direct connection in DATABASE_URL; the worker prepares each statement once per connection";

/**
 * The store's connection keeps a prepared statement from one run to the next, as the engine's
 * pooler check proves a source's: the store's pool is the worker's busiest.
 */
export async function storePoolerCheck(connect: SqlConnect, url: string): Promise<DoctorCheck> {
  const where = `the store on ${databaseLabel(url)}`;
  try {
    const why = await transactionPooler(connect, url);
    return why === undefined
      ? ok(
          "pooler",
          "prepared statements stay on one server session on the store (a direct connection or a session pooler)",
        )
      : fail(
          "pooler",
          `${where}: the database is behind a transaction-mode pooler (Supabase port 6543, PgBouncer transaction mode): ${why}`,
          STORE_POOLER_FIX,
        );
  } catch (error) {
    return fail(
      "pooler",
      `${where}: a prepared statement could not be run: ${plainMessage(error, [url])}`,
      STORE_POOLER_FIX,
    );
  }
}

function ageOf(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 120) {
    return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
  }
  const minutes = Math.round(seconds / 60);
  return minutes < 120 ? `${minutes} minutes` : `${Math.round(minutes / 60)} hours`;
}

/**
 * The worker has reported within the last two minutes, read from the store with one plain select
 * over its own connection: opening the store (`createStore`) would create its schema and salt,
 * which a check never does and the worker login cannot.
 */
export async function heartbeatCheck(
  connect: SqlConnect,
  env: Env,
  clock: Clock,
  projectId: string,
  allowInsecure: boolean | undefined,
): Promise<DoctorCheck> {
  const url = storeUrlOf(env);
  if (url === undefined) {
    return fail(
      "worker",
      "DATABASE_URL is not set, so there is no store to read",
      DATABASE_URL_FIX,
    );
  }
  const refused = storeUrlProblem(url, allowInsecure, env["PGHOST"]);
  if (refused !== undefined) {
    return fail("worker", refused.problem, refused.fix);
  }
  let last: number | undefined;
  try {
    const rows = await withConnection(connect, url, (query) =>
      query("select at::text as at from facetdb.heartbeats where project = $1", [projectId]),
    );
    const at = rows[0]?.["at"];
    last = at === undefined ? undefined : Number(at);
  } catch (error) {
    const message = plainMessage(error, [url, env[SECRET_VARIABLE]]);
    if (/permission denied/i.test(message)) {
      return fail(
        "worker",
        `the login in DATABASE_URL may not read the store's heartbeats: ${message}`,
        "grant select on facetdb.heartbeats to the login in DATABASE_URL, or point DATABASE_URL at a login that can read it",
      );
    }
    if (/does not exist/i.test(message)) {
      return fail(
        "worker",
        `the store has no heartbeats table yet: ${message}`,
        "run facetdb migrate with the admin credential: it installs the store's tables, and the worker only uses them",
      );
    }
    return fail("worker", `the store could not be read: ${message}`, DATABASE_URL_FIX);
  }
  if (last === undefined) {
    return fail(
      "worker",
      "the worker has never sent a heartbeat for this project",
      "start it with facetdb worker, and leave it running",
    );
  }
  const age = clock.now() - last;
  return age >= HEARTBEAT_LOSS_MS
    ? fail(
        "worker",
        `the last heartbeat was ${ageOf(age)} ago, and a worker counts as down after 2 minutes`,
        "start the worker with facetdb worker, or restart it, and read its log for why it stopped",
      )
    : ok("worker", `the last heartbeat was ${ageOf(age)} ago`);
}

/**
 * A source's question-set version in force: the model its set asks for, as the worker runs it, and
 * the model the store holds it to, as its first answer named it.
 */
export type HeldVersion = {
  readonly source: string;
  readonly version: number;
  readonly model: string;
  readonly held: string;
};

/**
 * The model each of `sources`'s versions in force is held to (store migration 11), for doctor's
 * model check: one plain select, as `heartbeatCheck` reads. A version nothing has answered holds
 * none, and so does a project with no store. A store that cannot be read (its URL refused, a store
 * before migration 11, a login that may not read it) is said in words with no secret in them.
 */
export async function heldVersions(
  connect: SqlConnect,
  env: Env,
  projectId: string,
  sources: readonly string[],
  allowInsecure: boolean | undefined,
): Promise<
  | { readonly kind: "read"; readonly versions: readonly HeldVersion[] }
  | { readonly kind: "unreadable"; readonly why: string }
> {
  const url = storeUrlOf(env);
  if (url === undefined) {
    return { kind: "read", versions: [] };
  }
  const refused = storeUrlProblem(url, allowInsecure, env["PGHOST"]);
  if (refused !== undefined) {
    return { kind: "unreadable", why: refused.problem };
  }
  const names = new Map(sources.map((name) => [sourceIdOf(projectId, name), name]));
  try {
    const rows = await withConnection(connect, url, (query) =>
      query(
        `select f.source_id, f.version::text as version, f.question_set->>'model' as model,
                v.answered_by
           from facetdb.question_sets_in_force f
           join facetdb.question_set_versions v on v.source_id = f.source_id and v.version = f.version
          where f.source_id = any($1::text[]) and v.answered_by is not null
          order by f.source_id`,
        [[...names.keys()]],
      ),
    );
    const versions = rows.map((row) => ({
      source: names.get(String(row["source_id"])) ?? String(row["source_id"]),
      version: Number(row["version"]),
      model: String(row["model"]),
      held: String(row["answered_by"]),
    }));
    return { kind: "read", versions };
  } catch (error) {
    return { kind: "unreadable", why: plainMessage(error, [url, env[SECRET_VARIABLE]]) };
  }
}

/** `FACETDB_SECRET`, or undefined when it is unset or empty. */
function storeSecretOf(env: Env): string | undefined {
  const secret = env[SECRET_VARIABLE];
  return secret === undefined || secret === "" ? undefined : secret;
}

/** What the store's secret is for, in the words every message about it uses. */
const SECRET_PURPOSE = "the FacetDB store encrypts the credentials it keeps for the worker with it";

/** The fix for an unset secret: a value, and why it must be kept. */
export const STORE_SECRET_FIX = `set ${SECRET_VARIABLE} to a long random value (openssl rand -hex 32) and keep it: credentials encrypted under it need the same value to be read later`;

/** The store's secret is in the environment: it encrypts the credentials the store holds. */
export function secretCheck(env: Env): DoctorCheck {
  return storeSecretOf(env) === undefined
    ? fail("secret", `${SECRET_VARIABLE} is not set`, STORE_SECRET_FIX)
    : ok("secret", `${SECRET_VARIABLE} is set`);
}

/**
 * The store's secret, refused before anything connects when it is unset: the first `facetdb worker`
 * of a new project meets this, and the words name the variable, what it is for and the fix, where
 * the store's own refusal would reach the user as an unexpected error.
 */
export function requireStoreSecret(env: Env): string {
  const secret = storeSecretOf(env);
  if (secret === undefined) {
    throw new CliError(
      "store-secret",
      `${SECRET_VARIABLE} is not set, and ${SECRET_PURPOSE}; nothing was connected`,
      STORE_SECRET_FIX,
    );
  }
  return secret;
}

/**
 * What `facetdb migrate` says when the secret is unset: migrate itself never opens the encrypted
 * part of the store, so it runs, but the worker it installs for will stop without one.
 */
export function storeSecretWarning(env: Env): string | undefined {
  return storeSecretOf(env) === undefined
    ? `warning: ${SECRET_VARIABLE} is not set. migrate does not need it, but facetdb worker does: ${SECRET_PURPOSE}. Before you start the worker, ${STORE_SECRET_FIX}.`
    : undefined;
}
