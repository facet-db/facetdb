import {
  type ActiveAlert,
  ALERT_KINDS,
  type AlertKind,
  type AlertRecord,
  type AlertSettlement,
  type AlertSeverity,
  type AlertStore,
  type BackfillProgress,
  type CursorStore,
  type HeldMessage,
  type QuietSummaryState,
  type UsageStore,
} from "@facetdb/core";
import type { SqlClient, SqlRow } from "../sql/index.ts";
import { flag, integer, json, jsonObject, text, textOrNull } from "./rows.ts";
import { RESERVE_USAGE_FUNCTION } from "./schema.ts";

/**
 * `facetdb.usage`, `usage_reservations` and `usage_alerts` as core's `UsageStore`: billable input
 * tokens per project per UTC month, the reservations of requests in flight, and which spending alerts
 * went out this month.
 */
export function createUsageStore(client: SqlClient): UsageStore {
  return {
    async add(projectId, month, inputTokens) {
      const rows = await client.query(
        `insert into facetdb.usage (project_id, month, input_tokens) values ($1, $2, $3)
         on conflict (project_id, month) do update set input_tokens = facetdb.usage.input_tokens + excluded.input_tokens
         returning input_tokens::text as total`,
        [projectId, month, inputTokens],
      );
      return integer(rows[0] ?? {}, "total");
    },

    async total(projectId, month) {
      const rows = await client.query(
        `select coalesce(sum(input_tokens), 0)::text as total from facetdb.usage
          where project_id = $1 and month = $2`,
        [projectId, month],
      );
      return integer(rows[0] ?? {}, "total");
    },

    /**
     * One statement, so one round trip and no transaction holding a connection: the store's
     * `reserve_usage` function (store migration 3) locks the month's `usage` row, clears the
     * project's expired reservations, reads the count and inserts the reservation when the count
     * plus the open reservations stays under the limit. The check and the insert are atomic across
     * processes: a second `reserve` waits on the lock, and its check, a statement of its own in the
     * function, takes a fresh snapshot and counts what the first committed. A project with no limit
     * keeps answering, so it takes no lock.
     */
    async reserve(projectId, month, requestTokens, limit, now, expiresAt) {
      const rows = await client.query(
        `select reservation_id, month_total::text as month_total
           from ${RESERVE_USAGE_FUNCTION}($1::text, $2::text, $3::bigint, $4::bigint, $5::bigint, $6::bigint)`,
        [projectId, month, requestTokens, limit ?? null, now, expiresAt],
      );
      const row = rows[0] ?? {};
      return {
        reservation: textOrNull(row, "reservation_id") ?? undefined,
        monthTotal: integer(row, "month_total"),
      };
    },

    async release(projectId, reservation) {
      await client.query(
        "delete from facetdb.usage_reservations where project_id = $1 and id = $2::uuid",
        [projectId, reservation],
      );
    },

    /**
     * One statement, so one round trip and one atomic step: the count and the release commit together.
     * The delete reads the count's output, so the month's `usage` row is locked before the reservation
     * row, the order `reserve` takes them in; the other order could deadlock with a `reserve` clearing
     * this reservation after its lease. A data-modifying `with` runs to completion either way, so the
     * tokens are counted even when the reservation is already gone. It answers with the month's count
     * after the write, so the gate needs no second read for the status.
     */
    async finish(projectId, month, reservation, inputTokens) {
      const rows = await client.query(
        `with counted as (
           insert into facetdb.usage (project_id, month, input_tokens) values ($1, $2, $4)
           on conflict (project_id, month) do update set input_tokens = facetdb.usage.input_tokens + excluded.input_tokens
           returning input_tokens
         ), released as (
           delete from facetdb.usage_reservations
            where project_id = $1 and id = $3::uuid and exists (select 1 from counted)
         )
         select input_tokens::text as total from counted`,
        [projectId, month, reservation, inputTokens],
      );
      return integer(rows[0] ?? {}, "total");
    },

    // The cap is part of the claim (migration 7): a cap changed mid-month is a new alert.
    async claimAlert(projectId, month, kind, cap) {
      const rows = await client.query(
        `insert into facetdb.usage_alerts (project_id, month, kind, cap) values ($1, $2, $3, $4)
         on conflict do nothing returning kind`,
        [projectId, month, kind, cap],
      );
      return rows.length > 0;
    },

    async releaseAlert(projectId, month, kind, cap) {
      await client.query(
        "delete from facetdb.usage_alerts where project_id = $1 and month = $2 and kind = $3 and cap = $4",
        [projectId, month, kind, cap],
      );
    },
  };
}

/** The database's own clock as the milliseconds since the epoch a `bigint` beat column holds. */
const DATABASE_NOW_MS = "(extract(epoch from clock_timestamp()) * 1000)::bigint";

/** A whole number of ms in a stored quiet-hours state; the row is a boundary. */
function stateTime(state: Record<string, unknown>, field: string): number {
  const value = state[field];
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new Error(`the quiet-hours state's "${field}" is ${JSON.stringify(value)}, expected ms`);
  }
  return value;
}

/** A quiet-hours summary state as `swapQuietState` wrote it. */
function quietStateOf(row: SqlRow): QuietSummaryState {
  const state = jsonObject(row, "state");
  return {
    until: stateTime(state, "until"),
    since: stateTime(state, "since"),
    triedAt: stateTime(state, "triedAt"),
    sentAt: state["sentAt"] === null ? null : stateTime(state, "sentAt"),
  };
}

function oneOf<T extends string>(row: SqlRow, column: string, allowed: readonly T[]): T {
  const value = text(row, column);
  if (!(allowed as readonly string[]).includes(value)) {
    throw new Error(`column "${column}" holds "${value}", expected one of ${allowed.join(", ")}`);
  }
  return value as T;
}

const PHASES = ["raised", "resolved"] as const;
const SEVERITIES: readonly AlertSeverity[] = ["information", "warning", "critical"];

/** A held history line as the summary names it. */
function heldOf(row: SqlRow): HeldMessage {
  return {
    key: text(row, "key"),
    phase: oneOf(row, "phase", PHASES),
    severity: oneOf(row, "severity", SEVERITIES),
    kind: oneOf<AlertKind>(row, "kind", ALERT_KINDS),
    source: text(row, "source"),
  };
}

/** `facetdb.alerts`, `alert_history` and `heartbeats` as core's `AlertStore`. */
export function createAlertStore(client: SqlClient): AlertStore {
  return {
    async getActive(key) {
      const rows = await client.query(
        "select state::text as state from facetdb.alerts where key = $1",
        [key],
      );
      const row = rows[0];
      return row === undefined ? undefined : (json(row, "state") as ActiveAlert);
    },

    async setActive(key, alert) {
      await client.query(
        `insert into facetdb.alerts (key, state) values ($1, $2::jsonb)
         on conflict (key) do update set state = excluded.state`,
        [key, JSON.stringify(alert)],
      );
    },

    async clearActive(key) {
      await client.query("delete from facetdb.alerts where key = $1", [key]);
    },

    async append(record: AlertRecord) {
      const rows = await client.query(
        "insert into facetdb.alert_history (record) values ($1::jsonb) returning id::text as id",
        [JSON.stringify(record)],
      );
      const row = rows[0];
      if (row === undefined) {
        throw new Error("the alert history did not answer the id of the line it recorded");
      }
      return text(row, "id");
    },

    // The channels' outcomes, written into the line recorded before they were tried, and its
    // `pending` mark dropped. The history is jsonb, so a new field is a merge into the record and
    // needs no migration.
    async settle(id, settlement: AlertSettlement) {
      await client.query(
        "update facetdb.alert_history set record = (record - 'pending') || $2::jsonb where id = $1::bigint",
        [id, JSON.stringify(settlement)],
      );
    },

    async lastHeartbeat(project) {
      const rows = await client.query(
        "select at::text as at from facetdb.heartbeats where project = $1",
        [project],
      );
      const row = rows[0];
      return row === undefined ? undefined : integer(row, "at");
    },

    async saveHeartbeat(project, at) {
      await client.query(
        `insert into facetdb.heartbeats (project, at) values ($1, $2)
         on conflict (project) do update set at = excluded.at`,
        [project, at],
      );
    },

    /**
     * Stamped with the database's clock, not the worker's: the rows are read by workers on other
     * machines, whose clocks can differ by minutes, and one clock ages them all. One statement; it
     * answers the time it stamped.
     */
    async saveWorkerBeat(project, worker) {
      const rows = await client.query(
        `insert into facetdb.worker_heartbeats (project, worker, at) values ($1, $2, ${DATABASE_NOW_MS})
         on conflict (project, worker) do update set at = excluded.at
         returning at::text as at`,
        [project, worker],
      );
      return integer(rows[0] ?? {}, "at");
    },

    async removeWorkerBeat(project, worker) {
      await client.query(
        "delete from facetdb.worker_heartbeats where project = $1 and worker = $2",
        [project, worker],
      );
    },

    /**
     * One statement that deletes and returns the rows: a second statement deleting the same row
     * waits for the first's commit and then finds it gone, so of two workers that look at once
     * exactly one gets each. The cutoff is the database's clock, read once for the statement, less
     * the age asked for: the clock that stamped the rows. The count of rows still beating is read
     * by the same statement; it names no row the delete took, whose `at` is at or before the
     * cutoff. Nothing comes back when nothing was taken.
     */
    async takeDeadWorkers(project, except, olderThanMs) {
      const rows = await client.query(
        `with cut as (
           select ${DATABASE_NOW_MS} - $3::bigint as at
         ), taken as (
           delete from facetdb.worker_heartbeats w using cut
            where w.project = $1 and w.worker <> $2 and w.at <= cut.at
           returning w.worker, w.at
         )
         select taken.worker as worker, taken.at::text as at,
                (select count(*) from facetdb.worker_heartbeats b, cut
                  where b.project = $1 and b.at > cut.at)::text as beating
           from taken
          order by taken.at, taken.worker`,
        [project, except, olderThanMs],
      );
      return {
        taken: rows.map((row) => ({ worker: text(row, "worker"), at: integer(row, "at") })),
        beating: rows[0] === undefined ? 0 : integer(rows[0], "beating"),
      };
    },

    // A channel's quiet-hours summary is standing state under a key no event has
    // (`quiet|<project>|<channel>`), in the same table as the active alerts: no migration.
    async quietState(key) {
      const rows = await client.query(
        "select state::text as state from facetdb.alerts where key = $1",
        [key],
      );
      const row = rows[0];
      return row === undefined ? undefined : quietStateOf(row);
    },

    /**
     * One statement that claims: an insert that a row already there turns into nothing, or an
     * update whose condition is the state read. A second update of the same row waits for the
     * first's commit, reads the condition again against what it wrote, and changes nothing, so of
     * two workers swapping the same state exactly one gets a row back. jsonb compares by value.
     */
    async swapQuietState(key, expected, next) {
      const rows =
        expected === undefined
          ? await client.query(
              `insert into facetdb.alerts (key, state) values ($1, $2::jsonb)
               on conflict (key) do nothing returning key`,
              [key, JSON.stringify(next)],
            )
          : await client.query(
              `update facetdb.alerts set state = $3::jsonb
                where key = $1 and state = $2::jsonb returning key`,
              [key, JSON.stringify(expected), JSON.stringify(next)],
            );
      return rows.length > 0;
    },

    async heldFor(project, channel, since, until) {
      const rows = await client.query(
        `select record->>'key' as key, record->>'phase' as phase, record->>'severity' as severity,
                record->'event'->>'kind' as kind, record->'event'->>'source' as source
           from facetdb.alert_history
          where record->'event'->>'project' = $1
            and record->'held' @> jsonb_build_array($2::text)
            and (record->>'at')::bigint >= $3::bigint and (record->>'at')::bigint < $4::bigint
          order by id`,
        [project, channel, since, until],
      );
      return rows.map(heldOf);
    },
  };
}

/** `facetdb.cursors` as core's `CursorStore`: where a backfill run resumes after a restart. */
export function createCursorStore(client: SqlClient): CursorStore {
  return {
    async load(run) {
      const rows = await client.query("select cursor, done from facetdb.cursors where run = $1", [
        run,
      ]);
      const row = rows[0];
      if (row === undefined) {
        return undefined;
      }
      const progress: BackfillProgress = {
        cursor: textOrNull(row, "cursor"),
        done: flag(row, "done"),
      };
      return progress;
    },

    async save(run, progress) {
      await client.query(
        `insert into facetdb.cursors (run, cursor, done) values ($1, $2, $3)
         on conflict (run) do update set cursor = excluded.cursor, done = excluded.done`,
        [run, progress.cursor, progress.done],
      );
    },
  };
}
