import type { SqlClient, SqlQuery, SqlRow } from "./client.ts";
import { quoteIdent } from "./identifier.ts";

/**
 * The one definition of `facetdb.jobs`, the queue. The Postgres connector installs it in the
 * customer's database and the FacetDB store creates it for plugin and API sources; both call
 * `jobsTableSql` and run the queries below, so the two queues can never drift. The schema is named
 * here rather than imported from the package root, which would be a cycle: the root re-exports
 * this module.
 */
const SCHEMA = "facetdb";
const TABLE = "jobs";

/** The queue table as it appears in SQL text. */
export const JOBS_TABLE = `${quoteIdent(SCHEMA)}.${quoteIdent(TABLE)}`;

/**
 * How long a claim holds a job when its worker never acks or releases it, as when the process
 * died in flight. Longer than the 10-minute retry window, so a live worker keeps its claim;
 * a dead one gives the job back to the queue within this.
 */
export const CLAIM_LEASE_MS = 15 * 60_000;

/**
 * The statements that create the schema and the queue, idempotent. One row per record: several
 * changes before a worker arrives are asked once (`on conflict (record_key) do nothing`, the very
 * statement the trigger runs). The table has no source column; a database that queues for
 * several sources, as the FacetDB store does, puts the source into the key (see `jobsQueries`).
 */
export function jobsTableSql(): string[] {
  return [
    `create schema if not exists ${quoteIdent(SCHEMA)}`,
    `create table if not exists ${JOBS_TABLE} (
  record_key text primary key,
  enqueued_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text
)`,
    `create index if not exists ${quoteIdent("jobs_queue")} on ${JOBS_TABLE} (enqueued_at, record_key)`,
  ];
}

/**
 * The queue's operations, as SQL text with numbered parameters (documented per entry). Times are
 * milliseconds since the epoch from the caller's clock, never the database's `now()`, so a fake clock
 * decides who has expired. Claiming uses the database's own row locking: `for update skip locked`.
 *
 * A `prefix` narrows `claim` and `waiting` to the keys that start with it; the empty string means
 * every job (the customer's database, where the trigger writes the bare key). A caller that shares
 * the table among sources writes `prefix + key` and strips the prefix from what comes back.
 */
export const jobsQueries = {
  /**
   * `$1` keys (text[]). Keys already queued stay one entry. With several keys the insert can wait
   * on a job row an open application transaction inserted, holding the rows it inserted already:
   * `enqueueJobs` runs it under a statement timeout with a fallback to one key per statement.
   */
  enqueue: `insert into ${JOBS_TABLE} (record_key)
select key from unnest($1::text[]) as key
on conflict (record_key) do nothing`,

  /**
   * `$1` keys (text[]). For a key whose state changed: queues it, and when a worker holds the job
   * already, takes the claim away so that worker's `ack` (which only deletes its own claims) leaves
   * the job in the queue to be asked again. `enqueue` would leave the claim, and the ack would then
   * delete the only job for the new state. The store runs it with one key, in the transaction that
   * writes that record, so it never waits for a job row while holding another.
   */
  requeue: `insert into ${JOBS_TABLE} (record_key)
select key from unnest($1::text[]) as key
on conflict (record_key) do update set claimed_at = null, claimed_by = null`,

  /**
   * `$1` prefix, `$2` worker, `$3` limit, `$4` now (ms), `$5` lease (ms). Takes unclaimed jobs and
   * those whose claim lease ended; two workers never receive the same job. Several rows, so it
   * skips a row another transaction holds (`for update skip locked`) and never waits.
   */
  claim: `update ${JOBS_TABLE}
   set claimed_at = to_timestamp($4::double precision / 1000), claimed_by = $2
 where record_key in (
   select record_key from ${JOBS_TABLE}
    where starts_with(record_key, $1::text)
      and (claimed_at is null or claimed_at <= to_timestamp(($4::double precision - $5::double precision) / 1000))
    order by enqueued_at, record_key
    limit $3
    for update skip locked)
returning record_key`,

  /**
   * `$1` key, `$2` worker, `$3` now (ms), `$4` lease (ms). Takes that one job if it is unclaimed or
   * its claim lease ended; no row comes back when it is not queued or another worker holds it.
   */
  claimOne: `update ${JOBS_TABLE}
   set claimed_at = to_timestamp($3::double precision / 1000), claimed_by = $2
 where record_key in (
   select record_key from ${JOBS_TABLE}
    where record_key = $1::text
      and (claimed_at is null or claimed_at <= to_timestamp(($3::double precision - $4::double precision) / 1000))
    for update skip locked)
returning record_key`,

  /**
   * `$1` key, `$2` worker, `$3` now (ms). Inserts the job already claimed; no row comes back when
   * the key is queued already, claimed or not.
   */
  claimKey: `insert into ${JOBS_TABLE} (record_key, claimed_at, claimed_by)
values ($1, to_timestamp($3::double precision / 1000), $2)
on conflict (record_key) do nothing
returning record_key`,

  /**
   * `$1` worker, `$2` keys (text[]), `$3` the time each was claimed at (ms, double precision[], in
   * the keys' order). Removes the finished jobs whose claim still stands (the same worker and the
   * very time it was claimed) and returns their keys. Several rows, so it never waits: a row
   * another transaction holds is skipped (`for update skip locked`) rather than waited for while
   * this statement holds others; the ledger settles each key it did not return with `ack`.
   */
  ackBatch: `delete from ${JOBS_TABLE}
 where record_key in (
   select j.record_key from ${JOBS_TABLE} j
     join unnest($2::text[], $3::double precision[]) as c(key, at) on j.record_key = c.key
    where j.claimed_by = $1 and j.claimed_at = to_timestamp(c.at / 1000)
      for update of j skip locked)
returning record_key`,

  /**
   * `$1` worker, `$2` keys (text[]), `$3` claim times (ms, double precision[]). Gives back the
   * claims that still stand and returns their keys. Several rows, so it skips a row another
   * transaction holds (`for update skip locked`), as `ackBatch` does.
   */
  releaseBatch: `update ${JOBS_TABLE}
   set claimed_at = null, claimed_by = null
 where record_key in (
   select j.record_key from ${JOBS_TABLE} j
     join unnest($2::text[], $3::double precision[]) as c(key, at) on j.record_key = c.key
    where j.claimed_by = $1 and j.claimed_at = to_timestamp(c.at / 1000)
      for update of j skip locked)
returning record_key`,

  /**
   * `$1` worker, `$2` key, `$3` the claim's time (ms). Removes one finished job, and only while
   * the claim it was given still stands: the same worker and the very time it was claimed. A job
   * granted again since (its lease ended, or a change cleared the claim and another batch took it)
   * carries another time and stays queued for the batch that holds it now. One row, so it may wait
   * for an application transaction, but holding nothing.
   */
  ack: `delete from ${JOBS_TABLE}
 where record_key = $2::text and claimed_by = $1
   and claimed_at = to_timestamp($3::double precision / 1000)`,

  /**
   * `$1` worker, `$2` key, `$3` the claim's time (ms). Gives one claim back, and only that claim.
   * One row, so it may wait, holding nothing.
   */
  release: `update ${JOBS_TABLE}
   set claimed_at = null, claimed_by = null
 where record_key = $2::text and claimed_by = $1
   and claimed_at = to_timestamp($3::double precision / 1000)`,

  /** `$1` prefix, `$2` limit. The keys waiting for a worker, oldest first, without claiming them. */
  waiting: `select record_key from ${JOBS_TABLE}
 where starts_with(record_key, $1::text) and claimed_at is null
 order by enqueued_at, record_key
 limit $2`,
} as const;

/**
 * The claims one worker holds, so `ack` and `release` can name the time each was taken at. The
 * connector contract settles keys, not claims; the ledger remembers every time a key was claimed
 * and settles the oldest first, the order batches finish in. When a key was granted again, the older
 * batch's settle finds a claim that no longer stands and changes nothing, and the newer batch's
 * settle takes the job. The pairing is by order, not by token: a settle out of order, or two claims
 * of one key within the same millisecond, can pair a batch with another's claim (a job asked twice,
 * or settled early); the common case, a re-grant after a lease, is exact.
 *
 * A batch is settled in one statement that skips any job row another transaction holds
 * (`ackBatch`, `releaseBatch`), then each key it did not return in a statement of its own (`ack`,
 * `release`). A statement that waited, holding some job rows, for a row an application transaction
 * holds (the trigger locks the job row for that transaction) could close a cycle, and Postgres may
 * abort the application's transaction to break it; the batch never waits, and the one-key
 * statement waits holding nothing. A key the batch did not return is either held right now or no
 * longer claimed as given (granted again, or its claim cleared by a change); for the second kind
 * the one-key statement changes nothing too, so the cost of a miss is one statement, never a
 * wrong settle.
 */
export type ClaimLedger = {
  /** Records that `queuedKeys` were claimed at `atMs`. */
  held(queuedKeys: readonly string[], atMs: number): void;
  ack(queuedKeys: readonly string[]): Promise<void>;
  release(queuedKeys: readonly string[]): Promise<void>;
};

export function createClaimLedger(query: SqlQuery, workerId: string): ClaimLedger {
  const times = new Map<string, number[]>();
  const settle = async (
    batch: string,
    one: string,
    queuedKeys: readonly string[],
  ): Promise<void> => {
    // The oldest times of each key, read but kept until the batch statement returns: a statement
    // that throws leaves the ledger whole, so a later settle still names those claims. Settles of
    // one key never overlap (a worker awaits each batch's settle).
    const claims: (readonly [key: string, atMs: number])[] = [];
    const taken = new Map<string, number>();
    for (const key of queuedKeys) {
      const index = taken.get(key) ?? 0;
      const atMs = times.get(key)?.[index];
      if (atMs !== undefined) {
        claims.push([key, atMs]);
        taken.set(key, index + 1);
      }
    }
    if (claims.length === 0) {
      return;
    }
    const rows = await query(batch, [
      workerId,
      claims.map(([key]) => key),
      claims.map(([, atMs]) => atMs),
    ]);
    for (const [key, count] of taken) {
      const remaining = times.get(key)?.slice(count) ?? [];
      if (remaining.length === 0) {
        times.delete(key);
      } else {
        times.set(key, remaining);
      }
    }
    const settled = new Set(rows.map((row: SqlRow) => row["record_key"]));
    for (const [key, atMs] of claims) {
      if (!settled.has(key)) {
        await query(one, [workerId, key, atMs]);
      }
    }
  };
  return {
    held(queuedKeys, atMs) {
      for (const key of queuedKeys) {
        times.set(key, [...(times.get(key) ?? []), atMs]);
      }
    },
    ack: (queuedKeys) => settle(jobsQueries.ackBatch, jobsQueries.ack, queuedKeys),
    release: (queuedKeys) => settle(jobsQueries.releaseBatch, jobsQueries.release, queuedKeys),
  };
}

/** Keys per `enqueue` statement: a backfill page fits in one, and no statement grows unbounded. */
export const ENQUEUE_KEYS_PER_STATEMENT = 500;

/**
 * Bounds the next statement of the transaction (`set local`) to half the server's
 * `deadlock_timeout`, read at run time (`pg_settings` gives it in milliseconds), never less than
 * 1 ms. Why half, and why the whole statement rather than one lock wait: see `enqueueJobs`.
 */
export const ENQUEUE_STATEMENT_TIMEOUT_SQL = `select set_config('statement_timeout', greatest(1, setting::int / 2)::text, true)
  from pg_settings where name = 'deadlock_timeout'`;

/**
 * Queues keys, `ENQUEUE_KEYS_PER_STATEMENT` per statement. A multi-row `insert … on conflict do
 * nothing` waits on a job row an open application transaction inserted (its trigger's insert),
 * holding the rows it inserted already, and `skip locked` cannot help an insert. An application
 * that then touches one of those rows waits on the batch: a cycle, and Postgres aborts the session
 * whose deadlock check fires first, which is the one that has waited `deadlock_timeout` first.
 *
 * The invariant: the batch ends itself before any session that waits on it can run that check.
 * Every wait on the batch's rows begins after the batch statement began, since the transaction
 * holds no job row before it; the statement is cancelled `deadlock_timeout / 2` after it began
 * (`statement_timeout`, SQLSTATE 57014), so it rolls back and lets go of its rows at least half a
 * `deadlock_timeout` before the earliest check of another session can fire. A per-wait bound
 * (`lock_timeout`) cannot promise this: the application may have begun waiting on the batch
 * before the batch began the wait that closes the cycle (reproduced on a real Postgres). This
 * holds for sessions under the server's `deadlock_timeout`; a role given a shorter one of its own
 * by a superuser is outside it.
 *
 * On that cancel the chunk is queued one key per statement, each of which waits holding nothing
 * else. A single key needs no transaction. A chunk the server is too slow to insert within the
 * bound, with no wait at all, takes the same fallback: slower, never wrong.
 */
export async function enqueueJobs(client: SqlClient, queuedKeys: readonly string[]): Promise<void> {
  const keys = [...new Set(queuedKeys)];
  for (let start = 0; start < keys.length; start += ENQUEUE_KEYS_PER_STATEMENT) {
    const chunk = keys.slice(start, start + ENQUEUE_KEYS_PER_STATEMENT);
    if (chunk.length === 1) {
      await client.query(jobsQueries.enqueue, [chunk]);
      continue;
    }
    try {
      await client.transaction(async (query) => {
        await query(ENQUEUE_STATEMENT_TIMEOUT_SQL);
        await query(jobsQueries.enqueue, [chunk]);
      });
    } catch (error) {
      if (!gaveUpWaiting(error)) {
        throw error;
      }
      for (const key of chunk) {
        await client.query(jobsQueries.enqueue, [[key]]);
      }
    }
  }
}

/**
 * The SQLSTATEs that mean the batch's own transaction ended because it waited on another:
 * `query_canceled` (the statement timeout above, the expected one), `lock_not_available` (a
 * `lock_timeout` the worker login may carry from its role) and `deadlock_detected` (the batch's own
 * deadlock check; it cannot fire first under the bound, but if it does, it is still the batch that
 * ended, not the application).
 */
const GAVE_UP_WAITING = new Set(["57014", "55P03", "40P01"]);

/** The driver's error (a boundary): did the batch end because it waited on another transaction? */
function gaveUpWaiting(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  return typeof error.code === "string" && GAVE_UP_WAITING.has(error.code);
}
