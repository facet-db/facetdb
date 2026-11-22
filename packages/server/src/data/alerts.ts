import {
  ALERT_SEVERITY,
  ALERT_TITLES,
  type AlertKind,
  type AlertRecord,
  type AlertSeverity,
  DELIVERY_ERROR_NOT_KEPT,
  deliveryWords,
  RESOLVABLE_ALERT_KINDS,
  readableTokenCounts,
} from "@facetdb/core";
import type { DashboardReads } from "./reads.ts";

/**
 * `GET /v1/alerts`: the channels the config names and the alert history, newest first. Reads only.
 *
 * The channels are answered as a kind and a name ("slack", "#ops"), what each sends, its quiet
 * hours, whether it was bound, and its newest delivery, and nothing else: the address in the config
 * is `<channel>:<where>`, and the config refuses a webhook URL or a credential in it, but this
 * surface does not rely on that: a "where" that reads as a URL or carries credentials is answered
 * with no name and no address, and no setting of a channel plugin (its webhook, token or headers)
 * is ever handed to this module, which receives the config's channels alone. A delivery's words are
 * the history's, which never keeps what a plugin threw.
 */

/** The history is capped, not paged: the newest lines, because the page answers "what has happened lately". */
export const ALERT_HISTORY_LINES = 100;

/** Which system alerts a channel is sent: critical alone, critical and warnings, or all. */
export type ChannelSends = "critical" | "warnings" | "everything";

/** A channel's quiet hours as the config writes them (`HH:MM`, an IANA zone); nothing acts on them yet. */
export type ChannelQuietHours = {
  readonly from: string;
  readonly to: string;
  readonly zone?: string;
};

/**
 * A channel as the config names it: its address, what it sends and its quiet hours. Nothing of its
 * plugin's settings (a webhook URL, a token) is ever handed to this module.
 */
export type ConfiguredChannel = {
  readonly address: string;
  readonly sends: ChannelSends;
  readonly quiet?: ChannelQuietHours;
};

/** A channel the worker runs with, and whether it was bound to its plugin's channel at the start. */
export type RunningChannel = ConfiguredChannel & { readonly bound: boolean };

/** A channel's newest delivery: when, of which event, and whether it went through. */
export type ChannelDeliveryView = {
  /** When the event's line was recorded, ISO 8601: the delivery was tried then. */
  readonly at: string;
  readonly kind: AlertKind;
  /** The event's name: `Model failing`. */
  readonly title: string;
  /** Whether the message was the alert or its resolved message. */
  readonly phase: "raised" | "resolved";
  readonly ok: boolean;
  /** Why it failed, in the words the history keeps (never a plugin's own error); null when it went through. */
  readonly error: string | null;
};

/** A channel as the config names it: `slack:#ops` is the kind `slack` and the name `#ops`. */
export type AlertChannelView = {
  readonly kind: string;
  /** Where it posts; null when the address held something that must not be repeated (a URL, a credential). */
  readonly name: string | null;
  /** `<kind>:<name>`; null when the name is not repeated. */
  readonly address: string | null;
  readonly sends: ChannelSends;
  /** Its quiet hours, with a null zone for the worker's own; null when it has none. */
  readonly quiet: {
    readonly from: string;
    readonly to: string;
    readonly zone: string | null;
  } | null;
  /** Whether the worker bound it to its plugin's channel when it started. */
  readonly bound: boolean;
  /** Whether its newest delivery went through; null before its first. */
  readonly delivering: boolean | null;
  /** Its newest delivery; null when the history holds none. */
  readonly last: ChannelDeliveryView | null;
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
  /**
   * True when the line's channels were still being tried when it was read, or its worker stopped
   * before they answered: whether any took it is not known, so `delivered` says nothing then. False
   * for every line written by an earlier version and for every settled one.
   */
  readonly pending: boolean;
  /**
   * The channels whose quiet hours held the message, in the config's order, each as the channels
   * are answered (an address that must not be repeated has a null name and address); they hear of
   * it in the summary sent when their hours end. Empty when none held it.
   */
  readonly held: readonly HeldChannelView[];
};

/** A channel that held a message, named as the channel list names it. */
export type HeldChannelView = Pick<AlertChannelView, "kind" | "name" | "address">;

export type AlertsView = {
  /** The channels the worker runs with: the config as it started. */
  readonly channels: readonly AlertChannelView[];
  /**
   * True when facetdb.config.ts now names other channels, or gives one other `sends` or quiet
   * hours, which apply at the next restart.
   */
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
  /**
   * The channels the worker runs with, each bound or not: `alerts.channels` as it started, then as
   * each reload that bound them put them in force.
   */
  readonly channels: () => readonly RunningChannel[];
  /**
   * The channels facetdb.config.ts names now, read on each request: they differ from the ones in
   * force only while a reload could not bind them (or a worker that never reloads runs).
   */
  readonly fileChannels: () => readonly ConfiguredChannel[];
  readonly reads: Pick<DashboardReads, "recentAlerts" | "lastDeliveries">;
};

const ADDRESS = /^([a-z][a-z0-9-]*):(\S.*)$/;
/**
 * Not a name to repeat: a scheme (`https://…`), `user:password@host`, or anything with a path, a
 * query or an assignment in it (`example.com/hook?token=x`), where a token can sit with no scheme.
 */
const NOT_A_NAME = /:\/\/|[^\s@/]+:[^\s@/]+@|[?/=]/;

/** A configured address as its kind and its name; the rest of a long or odd address is never repeated. */
export function channelOf(address: string): Pick<AlertChannelView, "kind" | "name"> {
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
        // Rows written before the compact figures carry bare digits: read at a glance, as new rows are.
        what: readableTokenCounts(event.what),
        project: event.project,
        source: event.source,
        question: event.question,
        did: event.did,
        link: event.link,
        standing,
        raisedBeforeHistory: record.phase === "resolved",
        delivered: record.delivered,
        pending: record.pending === true,
        held: (record.held ?? []).map(heldChannelView),
      };
    });
}

/** A held channel's address from the history, a boundary, named only as the channel list would. */
function heldChannelView(address: string): HeldChannelView {
  const { kind, name } = channelOf(address);
  return { kind, name, address: name === null ? null : `${kind}:${name}` };
}

/** A channel as one comparable text: its address, what it sends and its quiet hours. */
function settingsOf(channel: ConfiguredChannel): string {
  const { quiet } = channel;
  return JSON.stringify([
    channel.address,
    channel.sends,
    quiet === undefined ? null : [quiet.from, quiet.to, quiet.zone ?? null],
  ]);
}

/**
 * Whether two lists name the same channels with the same settings, in any order. Only the answer
 * leaves; no address does.
 */
function sameChannels(a: readonly ConfiguredChannel[], b: readonly ConfiguredChannel[]): boolean {
  const left = a.map(settingsOf).sort();
  const right = b.map(settingsOf).sort();
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/**
 * A channel's newest delivery from the history line that holds it. The line is a database row, a
 * boundary: the words are cleaned and held to a length again (core's `deliveryWords`).
 */
function lastOf(address: string, record: AlertRecord | undefined): ChannelDeliveryView | null {
  const delivery = record?.deliveries?.find((entry) => entry.channel === address);
  if (record === undefined || delivery === undefined) {
    return null;
  }
  const words = deliveryWords(delivery.error ?? "");
  return {
    at: new Date(record.at).toISOString(),
    kind: record.event.kind,
    title: ALERT_TITLES[record.event.kind],
    phase: record.phase,
    ok: delivery.ok,
    error: delivery.ok ? null : words === "" ? DELIVERY_ERROR_NOT_KEPT : words,
  };
}

/** A running channel as the endpoint answers it: nothing but the config's own words and the history's. */
function channelView(channel: RunningChannel, record: AlertRecord | undefined): AlertChannelView {
  const { kind, name } = channelOf(channel.address);
  const last = lastOf(channel.address, record);
  return {
    kind,
    name,
    address: name === null ? null : `${kind}:${name}`,
    sends: channel.sends,
    quiet:
      channel.quiet === undefined
        ? null
        : { from: channel.quiet.from, to: channel.quiet.to, zone: channel.quiet.zone ?? null },
    bound: channel.bound,
    delivering: last === null ? null : last.ok,
    last,
  };
}

export function createAlertsService(deps: AlertsDeps): AlertsService {
  return {
    async alerts(projectId) {
      if (projectId !== deps.projectId) {
        return { kind: "unknown_project" };
      }
      const channels = deps.channels();
      // One line more than the limit tells whether older ones exist.
      const [records, lastLines] = await Promise.all([
        deps.reads.recentAlerts(projectId, ALERT_HISTORY_LINES + 1),
        channels.length === 0
          ? Promise.resolve(new Map<string, AlertRecord>())
          : deps.reads.lastDeliveries(
              projectId,
              channels.map((channel) => channel.address),
            ),
      ]);
      return {
        kind: "alerts",
        alerts: {
          channels: channels.map((channel) => channelView(channel, lastLines.get(channel.address))),
          fileChannelsDiffer: !sameChannels(channels, deps.fileChannels()),
          events: eventsOf(records.slice(0, ALERT_HISTORY_LINES)),
          limit: ALERT_HISTORY_LINES,
          capped: records.length > ALERT_HISTORY_LINES,
        },
      };
    },
  };
}
