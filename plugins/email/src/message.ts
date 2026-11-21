import type { ChannelDefinition } from "facetdb/plugin";

/** What a channel is handed to deliver: a system alert or a record notification (core's `ChannelMessage`). */
export type ChannelMessage = Parameters<ChannelDefinition<unknown>["deliver"]>[1];

/** The longest subject, in characters: the severity, a colon and the first sentence, clipped. */
export const SUBJECT_LIMIT = 120;

const SEVERITY: Readonly<Record<ChannelMessage["severity"], string>> = {
  critical: "Critical",
  warning: "Warning",
  information: "Information",
};

/**
 * Everything that may not reach a header: line breaks (CR, LF, NEL, the Unicode line and paragraph
 * separators), every other control character, and the bidirectional controls that would make a
 * subject read other than it is written. Written as Unicode properties: Cc is every C0 and C1
 * control (CR, LF, NEL among them), Zl and Zp the line and paragraph separators.
 */
const NOT_IN_A_HEADER = /[\p{Cc}\p{Zl}\p{Zp}\p{Bidi_Control}]/gu;
const LINE_BREAK = /\r\n|[\n\v\f\r\x85\p{Zl}\p{Zp}]/u;
const SENTENCE = /^.*?[.!?](?=\s|$)/u;

/** `value` on one line: every character a header may not hold becomes a space, and runs of spaces one. */
export function oneLine(value: string): string {
  return value.replace(NOT_IN_A_HEADER, " ").replace(/\s+/gu, " ").trim();
}

/** The first sentence of the first line that has words: up to the first . ! or ? before a space. */
function firstSentence(text: string): string {
  const line = text.split(LINE_BREAK).find((part) => oneLine(part) !== "") ?? "";
  const words = oneLine(line);
  return SENTENCE.exec(words)?.[0] ?? words;
}

/** `value` held to `limit` characters (code points, so no emoji is cut in two), ending in … when clipped. */
function clipped(value: string, limit: number): string {
  const characters = Array.from(value);
  return characters.length <= limit
    ? value
    : `${characters
        .slice(0, limit - 1)
        .join("")
        .trimEnd()}…`;
}

/** The subject: the severity and the alert's first sentence, on one line, at most `SUBJECT_LIMIT` characters. */
export function subjectOf(message: ChannelMessage): string {
  const severity = SEVERITY[message.severity];
  const sentence = clipped(firstSentence(message.text), SUBJECT_LIMIT - severity.length - 2);
  return sentence === "" ? severity : `${severity}: ${sentence}`;
}

/** The body, plain text: the alert's text and, when it has one, its link on a line of its own. */
export function bodyOf(message: ChannelMessage): string {
  return message.link === undefined ? message.text : `${message.text}\n\n${message.link}`;
}
