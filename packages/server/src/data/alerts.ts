import {
  ALERT_SEVERITY,
  ALERT_TITLES,
  type AlertKind,
  type AlertRecord,
  type AlertSeverity,
  RESOLVABLE_ALERT_KINDS,
} from "@facetdb/core";
import type { DashboardReads } from "./reads.ts";

/**
 * `GET /v1/alerts`: the channels the config names and the alert history, newest first. Reads only.
 *
 * The channels are answered as a kind and a name ("slack", "#ops") and nothing else: the address in
 * the config is `<channel>:<where>`, and the config refuses a webhook URL or a credential in it, but
 * this surface does not rely on that: a "where" that reads as a URL or carries credentials is
 * answered with no name, and no setting of a channel plugin (its webhook, token or headers) is ever
 * handed to this module, which receives the addresses alone.
 */

/** The history is capped, not paged: the newest lines, because the page answers "what has happened lately". */
export const ALERT_HISTORY_LINES = 100;

/** A channel as the config names it: `slack:#ops` is the kind `slack` and the name `#ops`. */
export type AlertChannelView = {
  readonly kind: string;
  /** Where it posts; null when the address held something that must not be repeated (a URL, a credential). */
  readonly name: string | null;
};

/**
 * How an alert stands: resolved at a time (ISO 8601); still open, for a kind the code resolves
 * (`RESOLVABLE_ALERT_KINDS`) that has not been; or only raised, for a kind nothing ever resolves,
 * which makes no claim about being over.
 */
export type AlertStanding =
  | { readonly phase: "open" }
  | { readonly phase: "resolved"; readonly at: string }
  | { readonly phase: "raised" };

/** One alert as every alert reads, with how it stands now. */
export type AlertEventView = {
  /** When it was raised, ISO 8601 (for a resolved message with no raised line left, when it resolved). */
  readonly at: string;
  readonly kind: AlertKind;
  readonly severity: AlertSeverity;
  /** The event's name: `Backfill finished`. */
  readonly title: string;
  readonly what: string;
  readonly project: string;
  /** The source, or `all sources` for an event of the whole project. */
  readonly source: string;
  readonly question: string | null;
  readonly did: string;
  readonly link: string;
  readonly standing: AlertStanding;
  /**
   * True for a resolved message whose raised line is older than the history read: `at` is then when
   * it resolved, and the alert itself was raised earlier.
   */
  readonly raisedBeforeHistory: boolean;
  /** False when every configured channel refused the message. */
  readonly delivered: boolean;
};

export type AlertsView = {
  /** The channels the worker runs with: the config as it started. */
  readonly channels: readonly AlertChannelView[];
  /** True when facetdb.config.ts now names other channels, which apply at the next restart. */
  readonly fileChannelsDiffer: boolean;
  readonly events: readonly AlertEventView[];
  /** How many history lines were read at most. */
  readonly limit: number;
  /** True when older lines exist than the ones read: the oldest events are not shown. */
  readonly capped: boolean;
};

export type AlertsOutcome =
  | { readonly kind: "alerts"; readonly alerts: AlertsView }
  | { readonly kind: "unknown_project" };

export type AlertsService = {
  alerts(projectId: string): Promise<AlertsOutcome>;
};

export type AlertsDeps = {
  /** The project the worker serves. */
  readonly projectId: string;
  /** The channel addresses the worker runs with (`alerts.channels` as it started). */
  readonly channels: () => readonly string[];
  /** The channel addresses facetdb.config.ts names now, read on each request; a reload changes them. */
  readonly fileChannels: () => readonly string[];
  readonly reads: Pick<DashboardReads, "recentAlerts">;
};

const ADDRESS = /^([a-z][a-z0-9-]*):(\S.*)$/;
/**
 * Not a name to repeat: a scheme (`https://…`), `user:password@host`, or anything with a path, a
 * query or an assignment in it (`example.com/hook?token=x`), where a token can sit with no scheme.
 */
const NOT_A_NAME = /:\/\/|[^\s@/]+:[^\s@/]+@|[?/=]/;

/** A configured address as its kind and its name; the rest of a long or odd address is never repeated. */
export function channelOf(address: string): AlertChannelView {
  const found = ADDRESS.exec(address);
  if (found === null) {
    return { kind: "unknown", name: null };
  }
  const [, kind = "unknown", where = ""] = found;
  return { kind, name: NOT_A_NAME.test(where) ? null : where };
}

type Line = { readonly record: AlertRecord; readonly resolvedBy: AlertRecord | undefined };

/**
 * The history lines, newest first, as events: a raised line is an alert that went out, and it stands
 * as resolved when a later line of the same event is the resolved message (an event raised again
 * every 30 minutes while it stays open is one episode, resolved once). A resolved line whose raised
 * line is older than the lines read is kept as an event of its own, marked `raisedBeforeHistory`,
 * so nothing is dropped. Only a kind the code resolves (`RESOLVABLE_ALERT_KINDS`) can be `open`;
 * the others are `raised` and claim nothing about being over.
 */
export function eventsOf(records: readonly AlertRecord[]): readonly AlertEventView[] {
  const waiting = new Map<string, AlertRecord>();
  const consumed = new Set<AlertRecord>();
  const lines: Line[] = [];
  for (const record of records) {
    if (record.phase === "resolved") {
      waiting.set(record.key, record);
      lines.push({ record, resolvedBy: undefined });
      continue;
    }
    const resolvedBy = waiting.get(record.key);
    if (resolvedBy !== undefined) {
      consumed.add(resolvedBy);
    }
    lines.push({ record, resolvedBy });
  }
  return lines
    .filter(({ record }) => record.phase === "raised" || !consumed.has(record))
    .map(({ record, resolvedBy }) => {
      const { event } = record;
      const standing: AlertStanding =
        record.phase === "resolved"
          ? { phase: "resolved", at: new Date(record.at).toISOString() }
          : resolvedBy !== undefined
            ? { phase: "resolved", at: new Date(resolvedBy.at).toISOString() }
            : RESOLVABLE_ALERT_KINDS.includes(event.kind)
              ? { phase: "open" }
              : { phase: "raised" };
      return {
        at: new Date(record.at).toISOString(),
        kind: event.kind,
        // A resolved line is recorded as information; the event's own severity is the kind's.
        severity: record.phase === "resolved" ? ALERT_SEVERITY[event.kind] : record.severity,
        title: ALERT_TITLES[event.kind],
        what: event.what,
        project: event.project,
        source: event.source,
        question: event.question,
        did: event.did,
        link: event.link,
        standing,
        raisedBeforeHistory: record.phase === "resolved",
        delivered: record.delivered,
      };
    });
}

/** Whether two lists name the same channels, in any order. Only the answer leaves; no address does. */
function sameAddresses(a: readonly string[], b: readonly string[]): boolean {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((address, index) => address === right[index]);
}

export function createAlertsService(deps: AlertsDeps): AlertsService {
  return {
    async alerts(projectId) {
      if (projectId !== deps.projectId) {
        return { kind: "unknown_project" };
      }
      // One line more than the limit tells whether older ones exist.
      const records = await deps.reads.recentAlerts(projectId, ALERT_HISTORY_LINES + 1);
      return {
        kind: "alerts",
        alerts: {
          channels: deps.channels().map(channelOf),
          fileChannelsDiffer: !sameAddresses(deps.channels(), deps.fileChannels()),
          events: eventsOf(records.slice(0, ALERT_HISTORY_LINES)),
          limit: ALERT_HISTORY_LINES,
          capped: records.length > ALERT_HISTORY_LINES,
        },
      };
    },
  };
}
