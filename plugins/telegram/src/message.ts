import type { ChannelSpec } from "facetdb/plugin";

/**
 * The text of one Telegram message: the alert's words, a blank line, and its link. Telegram takes
 * at most 4096 characters in a message (https://core.telegram.org/bots/api#sendmessage); they are
 * counted here in UTF-16 code units, which is never fewer than Telegram counts. A longer message is
 * cut, never split into several: the alert's words are shortened and end with `CUT_MARKER`, and the
 * link is always kept whole after them.
 */

/** What a channel is given to deliver: a system alert or a record notification (core's contract). */
export type ChannelMessage = Parameters<ChannelSpec<unknown, never>["deliver"]>[1];

export const MESSAGE_MAX = 4096;

/** Ends the words of a message that was shortened to fit. */
export const CUT_MARKER = "… (shortened to fit one Telegram message)";

/** The first `length` code units of `text`, without leaving half of a surrogate pair at the end. */
function head(text: string, length: number): string {
  const cut = text.slice(0, length);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * The message's text within `MESSAGE_MAX`, or undefined when its link alone leaves no room for the
 * marker: a link is never cut, and FacetDB's links (a studio address and a path) are far shorter.
 */
export function messageText(message: ChannelMessage): string | undefined {
  const tail = message.link === undefined ? "" : `\n\n${message.link}`;
  if (message.text.length + tail.length <= MESSAGE_MAX) {
    return `${message.text}${tail}`;
  }
  const room = MESSAGE_MAX - tail.length - CUT_MARKER.length;
  if (room < 0) {
    return undefined;
  }
  return `${head(message.text, room).trimEnd()}${CUT_MARKER}${tail}`;
}
