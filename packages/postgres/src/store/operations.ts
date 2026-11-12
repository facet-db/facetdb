import type {
  ActiveAlert,
  AlertRecord,
  AlertStore,
  BackfillProgress,
  CursorStore,
  UsageStore,
} from "@facetdb/core";
import type { SqlClient } from "../sql/index.ts";
import { flag, integer, json, textOrNull } from "./rows.ts";
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

    async claimAlert(projectId, month, kind) {
      const rows = await client.query(
        `insert into facetdb.usage_alerts (project_id, month, kind) values ($1, $2, $3)
         on conflict do nothing returning kind`,
        [projectId, month, kind],
      );
      return rows.length > 0;
    },

    async releaseAlert(projectId, month, kind) {
      await client.query(
        "delete from facetdb.usage_alerts where project_id = $1 and month = $2 and kind = $3",
        [projectId, month, kind],
      );
    },
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
      await client.query("insert into facetdb.alert_history (record) values ($1::jsonb)", [
        JSON.stringify(record),
      ]);
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
