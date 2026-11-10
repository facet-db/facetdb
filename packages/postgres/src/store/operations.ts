import type {
  ActiveAlert,
  AlertRecord,
  AlertStore,
  BackfillProgress,
  CursorStore,
  ReservationId,
  UsageStore,
} from "@facetdb/core";
import type { SqlClient } from "../sql/index.ts";
import { flag, integer, json, text, textOrNull } from "./rows.ts";

/**
 * `facetdb.usage`, `usage_reservations` and `usage_alerts` as core's `UsageStore`: billable input
 * tokens per project per UTC month, the reservations of requests in flight, and which spending alerts
 * went out this month.
 */
export function createUsageStore(client: SqlClient): UsageStore {
  return {
    async add(projectId, month, inputTokens) {
      await client.query(
        `insert into facetdb.usage (project_id, month, input_tokens) values ($1, $2, $3)
         on conflict (project_id, month) do update set input_tokens = facetdb.usage.input_tokens + excluded.input_tokens`,
        [projectId, month, inputTokens],
      );
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
     * The check and the insert are atomic across processes: the month's `usage` row is locked first
     * (an upsert that changes nothing), so a second `reserve` for the same project and month waits
     * for the first to commit and then counts its reservation. Each statement of a read-committed
     * transaction takes a fresh snapshot, which is why the lock is its own statement and the check a
     * second one. A project with no limit keeps answering, so it needs no lock.
     */
    async reserve(projectId, month, requestTokens, limit, now, expiresAt) {
      return client.transaction(async (query) => {
        if (limit !== undefined) {
          await query(
            `insert into facetdb.usage (project_id, month, input_tokens) values ($1, $2, 0)
             on conflict (project_id, month) do update set input_tokens = facetdb.usage.input_tokens`,
            [projectId, month],
          );
        }
        // Reservations whose lease ended give their headroom back; clearing them keeps the table small.
        await query(
          "delete from facetdb.usage_reservations where project_id = $1 and expires_at <= $2",
          [projectId, now],
        );
        const rows = await query(
          `insert into facetdb.usage_reservations (project_id, month, tokens, expires_at)
           select $1::text, $2::text, $3::bigint, $4::bigint
            where $5::bigint is null
               or coalesce((select input_tokens from facetdb.usage where project_id = $1 and month = $2), 0)
                + coalesce((select sum(tokens) from facetdb.usage_reservations
                             where project_id = $1 and month = $2 and expires_at > $6), 0) < $5::bigint
           returning id::text as id`,
          [projectId, month, requestTokens, expiresAt, limit ?? null, now],
        );
        const row = rows[0];
        return row === undefined ? undefined : (text(row, "id") as ReservationId);
      });
    },

    async release(projectId, reservation) {
      await client.query(
        "delete from facetdb.usage_reservations where project_id = $1 and id = $2::uuid",
        [projectId, reservation],
      );
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
