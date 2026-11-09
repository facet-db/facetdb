/**
 * An alert channel delivers two kinds of message through one contract: system alerts about FacetDB
 * itself, and record notifications an action sent when a decision matched its condition. Batching
 * into a digest happens before `deliver` is called.
 */

export type ChannelMessage = {
  readonly kind: "system-alert" | "record-notification";
  readonly severity: "critical" | "warning" | "information";
  /** Plain words: what happened, which project, source and question, and what FacetDB did about it. */
  readonly text: string;
  /** The one link to the page where the problem is fixed, when there is one. */
  readonly link?: string;
};

export type AlertChannel<C> = {
  deliver(message: ChannelMessage, config: C): Promise<void>;
};
