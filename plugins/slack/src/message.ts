import type { ChannelDefinition } from "facetdb/plugin";

/** What a channel is handed to deliver (core's `ChannelMessage`), as `facetdb/plugin` types it. */
export type ChannelMessage = Parameters<ChannelDefinition["deliver"]>[1];

const SEVERITY_WORD: Readonly<Record<ChannelMessage["severity"], string>> = {
  critical: "Critical",
  warning: "Warning",
  information: "Information",
};

/**
 * Slack reads `<`, `>` and `&` as markup in any message text: `<!channel>` pings a channel and
 * `<https://evil.example|your invoice>` shows one link under another's words. They are the only
 * three Slack asks to escape, and escaped they show as written.
 */
export function escapeSlack(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The longest message sent, in UTF-16 units (JavaScript's length, never fewer than Slack's
 * characters). Slack cuts a message above 40,000 characters (or refuses it, `msg_too_long`) and
 * asks for 4,000 at most for messages to read well: an alert or a notification is a few lines,
 * and a record's long text belongs on its page, which the link opens.
 */
export const TEXT_LIMIT = 4000;

/** Ends a text that was cut to fit `TEXT_LIMIT`. */
export const CUT_MARKER = " … (cut to fit Slack; the link has the rest)";

/**
 * The alert's words escaped, cut to `budget` units with the marker when they do not fit. The cut
 * is counted after escaping (`&` becomes five units) and falls between whole characters, so it
 * never splits a surrogate pair or an escape.
 */
function fitted(text: string, budget: number): string {
  const escaped = escapeSlack(text);
  if (escaped.length <= budget) {
    return escaped;
  }
  const room = Math.max(0, budget - CUT_MARKER.length);
  let kept = "";
  for (const character of text) {
    const piece = escapeSlack(character);
    if (kept.length + piece.length > room) {
      break;
    }
    kept += piece;
  }
  return `${kept}${CUT_MARKER}`;
}

/**
 * The link as Slack links it: `<url>` with no label, so it stays clickable under `parse: "none"`
 * and no other words can be shown over it. Only an http or https URL is wrapped, as the URL
 * standard writes it (a space or `>` percent-encoded) with `|` encoded too, so nothing in it can
 * close the bracket or add a label. Anything else is escaped and stays bare text.
 */
function linkText(link: string): string {
  const url = URL.canParse(link) ? new URL(link) : undefined;
  if (url === undefined || (url.protocol !== "http:" && url.protocol !== "https:")) {
    return escapeSlack(link);
  }
  return `<${escapeSlack(url.href.replaceAll("|", "%7C"))}>`;
}

/**
 * The message as plain text: its severity in a word, the alert's words (cut to fit `TEXT_LIMIT`),
 * and its link, whole, on a line of its own.
 */
export function messageText(message: ChannelMessage): string {
  const head = `${SEVERITY_WORD[message.severity]}: `;
  const tail = message.link === undefined ? "" : `\n${linkText(message.link)}`;
  return `${head}${fitted(message.text, TEXT_LIMIT - head.length - tail.length)}${tail}`;
}
