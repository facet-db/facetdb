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
  /** `$1` keys (text[]). Keys already queued stay one entry. */
  enqueue: `insert into ${JOBS_TABLE} (record_key)
select key from unnest($1::text[]) as key
on conflict (record_key) do nothing`,

  /**
   * `$1` keys (text[]). For a key whose state changed: queues it, and when a worker holds the job
   * already, takes the claim away so that worker's `ack` (which only deletes its own claims) leaves
   * the job in the queue to be asked again. `enqueue` would leave the claim, and the ack would then
   * delete the only job for the new state.
   */
  requeue: `insert into ${JOBS_TABLE} (record_key)
select key from unnest($1::text[]) as key
on conflict (record_key) do update set claimed_at = null, claimed_by = null`,

  /**
   * `$1` prefix, `$2` worker, `$3` limit, `$4` now (ms), `$5` lease (ms). Takes unclaimed jobs and
   * those whose claim lease ended; two workers never receive the same job.
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
   * `$1` worker, `$2` key, `$3` the claim's time (ms). Removes one finished job, and only while
   * the claim it was given still stands: the same worker and the very time it was claimed. A job
   * granted again since (its lease ended, or a change cleared the claim and another batch took it)
   * carries another time and stays queued for the batch that holds it now.
   */
  ack: `delete from ${JOBS_TABLE}
 where record_key = $2::text and claimed_by = $1
   and claimed_at = to_timestamp($3::double precision / 1000)`,

  /** `$1` worker, `$2` key, `$3` the claim's time (ms). Gives one claim back, and only that claim. */
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
 * Each key is settled in its own statement: a statement that touched several job rows would wait,
 * holding some of them, for a row an application transaction holds (the trigger locks the job row
 * for that transaction), and Postgres may abort the application's transaction to break the cycle.
 */
export type ClaimLedger = {
  /** Records that `queuedKeys` were claimed at `atMs`. */
  held(queuedKeys: readonly string[], atMs: number): void;
  ack(queuedKeys: readonly string[]): Promise<void>;
  release(queuedKeys: readonly string[]): Promise<void>;
};

export function createClaimLedger(
  query: (text: string, params: readonly unknown[]) => Promise<unknown>,
  workerId: string,
): ClaimLedger {
  const times = new Map<string, number[]>();
  const settle = async (statement: string, queuedKeys: readonly string[]): Promise<void> => {
    for (const key of queuedKeys) {
      const pending = times.get(key);
      const atMs = pending?.shift();
      if (pending?.length === 0) {
        times.delete(key);
      }
      if (atMs !== undefined) {
        await query(statement, [workerId, key, atMs]);
      }
    }
  };
  return {
    held(queuedKeys, atMs) {
      for (const key of queuedKeys) {
        times.set(key, [...(times.get(key) ?? []), atMs]);
      }
    },
    ack: (queuedKeys) => settle(jobsQueries.ack, queuedKeys),
    release: (queuedKeys) => settle(jobsQueries.release, queuedKeys),
  };
}
