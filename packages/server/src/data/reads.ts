import {
  ALERT_KINDS,
  type AlertEvent,
  type AlertRecord,
  type QuietSummaryState,
  quietKey,
} from "@facetdb/core";
import { z } from "zod";

type SqlRow = Readonly<Record<string, unknown>>;

/**
 * The one thing these reads need from the store's database: run a statement. The worker's store
 * client (postgres.js in production, PGlite in tests) has this shape.
 */
export type DashboardDatabase = {
  query(text: string, params?: readonly unknown[]): Promise<readonly SqlRow[]>;
};

/** Where a whole UTC day starts and ends, in ms, for the log counted by day. */
export type Day = { readonly from: number; readonly to: number };

/** One backfill run's row in `facetdb.cursors`: its key and whether its last page was settled. */
export type CursorRow = { readonly run: string; readonly done: boolean };

/**
 * What the Home and Sources pages read from the FacetDB store, by project and by source id
 * (`sourceIdOf`): the heartbeat, the month's usage, the alerts, the decision log by day, the review
 * queue, the run log and the backfill cursors. Reads only: nothing here writes.
 */
export type DashboardReads = {
  /** When the project's worker last beat, in ms; undefined when none ever has. */
  lastHeartbeat(projectId: string): Promise<number | undefined>;
  /** The project's billable input tokens in a UTC month (`YYYY-MM`). */
  monthTokens(projectId: string, month: string): Promise<number>;
  /** The project's model-failing alerts still active, one per source that raised one. */
  modelFailing(projectId: string): Promise<readonly AlertEvent[]>;
  /** The project's newest alert history lines, newest first. */
  recentAlerts(projectId: string, limit: number): Promise<readonly AlertRecord[]>;
  /**
   * Per channel address, the project's newest history line that holds a delivery to it; an address
   * no line holds is left out.
   */
  lastDeliveries(
    projectId: string,
    channels: readonly string[],
  ): Promise<ReadonlyMap<string, AlertRecord>>;
  /**
   * Per channel address, its quiet-hours summary state as the worker keeps it (under core's
   * `quietKey`), with whether the summary had anything to say (`held`). Read by key alone, never
   * from the history. An address with no state is left out.
   */
  quietSummaries(
    projectId: string,
    channels: readonly string[],
  ): Promise<ReadonlyMap<string, QuietSummaryState>>;
  /** Model answers logged for these sources within the day. */
  answered(sourceIds: readonly string[], day: Day): Promise<number>;
  /** People's decisions logged for these sources within the day: records decided, and by how many people. */
  decided(
    sourceIds: readonly string[],
    day: Day,
  ): Promise<{ readonly records: number; readonly reviewers: number }>;
  /** The review queue of these sources: its cards and when the oldest began waiting (ms). */
  queue(
    sourceIds: readonly string[],
  ): Promise<{ readonly waiting: number; readonly oldestSince: number | undefined }>;
  /** When the worker's newest pass that claimed a change of the source began (the run log), in ms. */
  lastChange(sourceId: string): Promise<number | undefined>;
  /** The backfill cursors whose run key begins with `prefix`. */
  cursors(prefix: string): Promise<readonly CursorRow[]>;
  /** Records of the source the model answered under a question-set version. */
  answeredUnder(sourceId: string, version: number): Promise<number>;
  /** When the source's newest backfill-finished alert was raised, in ms. */
  backfillFinishedAt(projectId: string, source: string): Promise<number | undefined>;
};

// Database rows are a boundary: numbers and timestamps are selected as text, so both drivers hand
// back the same types, and are checked here.

function whole(row: SqlRow | undefined, column: string): number {
  const value = row?.[column];
  const parsed = typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`column "${column}" came back as ${typeof value}, expected a whole number`);
  }
  return parsed;
}

function wholeOrUndefined(row: SqlRow | undefined, column: string): number | undefined {
  return row?.[column] === null ? undefined : whole(row, column);
}

const alertEvent = z.object({
  kind: z.enum(ALERT_KINDS),
  what: z.string(),
  project: z.string(),
  source: z.string(),
  question: z.string().nullable(),
  did: z.string(),
  link: z.string(),
});

// Each channel tried; absent from a line no channel was tried for, and from every line written
// before channels were delivered to, which reads as it always did.
const alertDelivery = z.object({
  channel: z.string(),
  ok: z.boolean(),
  error: z.string().exactOptional(),
});

const alertRecord = z.object({
  at: z.number(),
  key: z.string(),
  phase: z.enum(["raised", "resolved"]),
  severity: z.enum(["information", "warning", "critical"]),
  event: alertEvent,
  delivered: z.boolean(),
  deliveries: z.array(alertDelivery).exactOptional(),
  // The channels whose quiet hours held the message; absent when none did.
  held: z.array(z.string()).exactOptional(),
  pending: z.literal(true).exactOptional(),
});

const activeAlert = z.object({ event: alertEvent });

// The summary state (core's `QuietSummaryState`), a row the worker wrote: a boundary.
const quietSummaryState = z.object({
  until: z.number(),
  since: z.number(),
  triedAt: z.number(),
  sentAt: z.number().nullable(),
  // Absent from a state written before it, which reads as no summary.
  held: z.boolean().exactOptional(),
});

const cursorRow = z.object({ run: z.string(), done: z.boolean() });

function parsedJson<Schema extends z.ZodType>(schema: Schema, row: SqlRow, column: string) {
  const value = row[column];
  if (typeof value !== "string") {
    throw new Error(`column "${column}" came back as ${typeof value}, expected JSON text`);
  }
  return schema.parse(JSON.parse(value));
}

/** SQL for a millisecond count as a timestamp: `$n` is a number of ms. */
const at = (placeholder: string) => `to_timestamp(${placeholder}::double precision / 1000)`;

/** SQL that reads a timestamp back as whole milliseconds, as text. */
const ms = (expression: string) => `round(extract(epoch from ${expression}) * 1000)::bigint::text`;

/** The sources a read covers, as one JSON parameter both drivers bind alike. */
const IN_SOURCES = "source_id in (select jsonb_array_elements_text($1::jsonb))";

export function createDashboardReads(database: DashboardDatabase): DashboardReads {
  const { query } = database;
  return {
    async lastHeartbeat(projectId) {
      const rows = await query("select at::text as at from facetdb.heartbeats where project = $1", [
        projectId,
      ]);
      return rows[0] === undefined ? undefined : whole(rows[0], "at");
    },

    async monthTokens(projectId, month) {
      const rows = await query(
        `select coalesce(sum(input_tokens), 0)::text as total from facetdb.usage
          where project_id = $1 and month = $2`,
        [projectId, month],
      );
      return whole(rows[0], "total");
    },

    async modelFailing(projectId) {
      const rows = await query(
        `select state::text as state from facetdb.alerts
          where state->'event'->>'kind' = 'model_failing' and state->'event'->>'project' = $1
          order by key`,
        [projectId],
      );
      return rows.map((row) => parsedJson(activeAlert, row, "state").event);
    },

    async recentAlerts(projectId, limit) {
      const rows = await query(
        `select record::text as record from facetdb.alert_history
          where record->'event'->>'project' = $1 order by id desc limit $2`,
        [projectId, limit],
      );
      return rows.map((row) => parsedJson(alertRecord, row, "record"));
    },

    async lastDeliveries(projectId, channels) {
      // A line written by an earlier version, or one no channel was tried for, has no `deliveries`
      // and holds nothing here; a line whose channels are still being tried has an empty list.
      const rows = await query(
        `select distinct on (delivery->>'channel') delivery->>'channel' as channel,
                h.record::text as record
           from facetdb.alert_history h,
                jsonb_array_elements(
                  case when jsonb_typeof(h.record->'deliveries') = 'array'
                       then h.record->'deliveries' else '[]'::jsonb end
                ) as delivery
          where h.record->'event'->>'project' = $1
            and delivery->>'channel' in (select jsonb_array_elements_text($2::jsonb))
          order by delivery->>'channel', h.id desc`,
        [projectId, JSON.stringify(channels)],
      );
      const lines = new Map<string, AlertRecord>();
      for (const row of rows) {
        const channel = row["channel"];
        if (typeof channel !== "string") {
          throw new Error(`column "channel" came back as ${typeof channel}, expected text`);
        }
        lines.set(channel, parsedJson(alertRecord, row, "record"));
      }
      return lines;
    },

    async quietSummaries(projectId, channels) {
      // One row per channel by its primary key (core's `quietKey`, made here and sent beside its
      // address: the SQL never builds one). The history is never read: whether the summary had
      // anything to say is the state's own `held`, written by the worker with its claim.
      const rows = await query(
        `select c.channel, a.state::text as state
           from jsonb_to_recordset($1::jsonb) as c(channel text, key text)
           join facetdb.alerts a on a.key = c.key`,
        [
          JSON.stringify(
            channels.map((channel) => ({ channel, key: quietKey(projectId, channel) })),
          ),
        ],
      );
      const summaries = new Map<string, QuietSummaryState>();
      for (const row of rows) {
        const { channel } = row;
        if (typeof channel !== "string") {
          throw new Error(`column "channel" came back as ${typeof channel}, expected text`);
        }
        summaries.set(channel, parsedJson(quietSummaryState, row, "state"));
      }
      return summaries;
    },

    async answered(sourceIds, day) {
      const rows = await query(
        `select count(*)::text as answered from facetdb.decisions
          where ${IN_SOURCES} and kind = 'answer' and at >= ${at("$2")} and at < ${at("$3")}`,
        [JSON.stringify(sourceIds), day.from, day.to],
      );
      return whole(rows[0], "answered");
    },

    async decided(sourceIds, day) {
      const rows = await query(
        `select count(distinct (source_id, record_key))::text as records,
                count(distinct reviewer)::text as reviewers
           from facetdb.decisions
          where ${IN_SOURCES} and kind = 'human' and at >= ${at("$2")} and at < ${at("$3")}`,
        [JSON.stringify(sourceIds), day.from, day.to],
      );
      return { records: whole(rows[0], "records"), reviewers: whole(rows[0], "reviewers") };
    },

    async queue(sourceIds) {
      const rows = await query(
        `select count(*)::text as waiting, ${ms("min(since)")} as oldest
           from facetdb.reviews where ${IN_SOURCES}`,
        [JSON.stringify(sourceIds)],
      );
      return {
        waiting: whole(rows[0], "waiting"),
        oldestSince: wholeOrUndefined(rows[0], "oldest"),
      };
    },

    async lastChange(sourceId) {
      const rows = await query(
        `select ${ms("max(started_at)")} as seen from facetdb.runs
          where source_id = $1 and claimed > 0`,
        [sourceId],
      );
      return wholeOrUndefined(rows[0], "seen");
    },

    async cursors(prefix) {
      const rows = await query(
        "select run, done from facetdb.cursors where left(run, length($1)) = $1 order by run",
        [prefix],
      );
      return rows.map((row) => cursorRow.parse(row));
    },

    async answeredUnder(sourceId, version) {
      const rows = await query(
        `select count(distinct record_key)::text as answered from facetdb.decisions
          where source_id = $1 and kind = 'answer' and version = $2`,
        [sourceId, version],
      );
      return whole(rows[0], "answered");
    },

    async backfillFinishedAt(projectId, source) {
      const rows = await query(
        `select max((record->>'at')::bigint)::text as finished from facetdb.alert_history
          where record->'event'->>'kind' = 'backfill_finished' and record->>'phase' = 'raised'
            and record->'event'->>'project' = $1 and record->'event'->>'source' = $2`,
        [projectId, source],
      );
      return wholeOrUndefined(rows[0], "finished");
    },
  };
}
