import { LOCK_TIMEOUT, type SqlClient, type SqlQuery } from "../sql/index.ts";
import { rekeyNotes, SCHEMA_VERSION, storeStepStatements, storeVersion } from "./schema.ts";

/**
 * The store's step of `facetdb migrate`. It runs on its own, in its own transaction, before any
 * source's install, also when the store is the source's own database: a store migration that builds
 * an index on a large log then holds the store's tables while it builds, never a customer's table.
 * Planned by reading where the store stands (nothing is changed), printed as `storeScript`, and run
 * as printed, statement for statement.
 */

/** Where the store stands against this FacetDB, and what its step runs. */
export type StoreStep =
  /** Every migration this FacetDB knows is applied: the step runs nothing. */
  | { readonly kind: "current" }
  /** Written by a newer FacetDB: refused, never guessed at. */
  | { readonly kind: "newer"; readonly newest: number }
  | {
      /** Absent, or behind this FacetDB. */
      readonly kind: "behind";
      /** The step's statements (`storeStepStatements`), run in one transaction as printed. */
      readonly statements: readonly string[];
      /** What its migrations cannot settle (store version 4's shared logs), said before it runs. */
      readonly notes: readonly string[];
      /** Whether the login may create the store's tables, so the CLI refuses in words before a run. */
      readonly mayCreate: boolean;
    };

/**
 * Reads where the store stands and plans its step; nothing is changed. `lockTimeout` is the step's
 * lock timeout (`LOCK_TIMEOUT`, the install's ten seconds), shorter only in a test.
 */
export async function planStoreStep(
  query: SqlQuery,
  lockTimeout: string = LOCK_TIMEOUT,
): Promise<StoreStep> {
  const found = await storeVersion(query);
  if (found.kind === "found" && found.newest > SCHEMA_VERSION) {
    return { kind: "newer", newest: found.newest };
  }
  if (found.kind === "found" && found.current) {
    return { kind: "current" };
  }
  const may = await query(
    `select case when to_regnamespace('facetdb') is null
                 then has_database_privilege(current_database(), 'create')
                 else has_schema_privilege('facetdb', 'create') end as may`,
  );
  return {
    kind: "behind",
    statements: storeStepStatements(lockTimeout),
    notes: await rekeyNotes(query),
    mayCreate: may[0]?.["may"] === true,
  };
}

/** A store script as the engines print theirs: one transaction, a blank line between statements. */
export function storeScript(statements: readonly string[]): string {
  return `begin;\n\n${statements.join(";\n\n")};\n\ncommit;\n`;
}

/** SQLSTATE `lock_not_available`: a statement waited past the step's lock timeout. */
const LOCK_NOT_AVAILABLE = "55P03";

/**
 * The store table a step's statement waits on for its lock, by what the statement does to it: the
 * table an index is built on, a table altered, created, written or read. Undefined when it names
 * none (a function's grant). The names are the store's own, never a user's.
 */
function tableOf(statement: string): string | undefined {
  return /\b(?:on|alter table|create table if not exists|create table|insert into|update|from) (facetdb\.\w+)/.exec(
    statement,
  )?.[1];
}

/**
 * The step stopped at its lock timeout: another transaction holds a store table the step must
 * lock. The transaction rolled back whole, so the store is where it was.
 */
export class StoreBusyError extends Error {
  /** The store table waited on, when the statement names one. */
  readonly table: string | undefined;
  constructor(table: string | undefined) {
    super(
      `${table === undefined ? "a table of the FacetDB store" : `the FacetDB store's table ${table}`} is held by another transaction, so the store's migration stopped waiting for it; nothing was changed`,
    );
    this.name = "StoreBusyError";
    this.table = table;
  }
}

/**
 * Runs the step's statements, exactly as given (the script shown), in one transaction: it commits
 * whole or not at all, so a crash leaves the store where it was and the next migrate shows the same
 * step again. A store a newer FacetDB wrote meanwhile fails with `STORE_NEWER_STATE`, rolled back; a
 * statement that waited past the lock timeout fails as `StoreBusyError`, naming the table, rolled back.
 */
export async function runStoreStep(
  client: SqlClient,
  statements: readonly string[],
): Promise<void> {
  let at: string | undefined;
  try {
    await client.transaction(async (query) => {
      for (const statement of statements) {
        at = statement;
        await query(statement);
      }
    });
  } catch (error) {
    // The driver's error is a boundary, read by its code.
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === LOCK_NOT_AVAILABLE) {
        throw new StoreBusyError(at === undefined ? undefined : tableOf(at));
      }
    }
    throw error;
  }
}
