import { styleText } from "node:util";
import {
  chosenWords,
  likelyYes,
  type OpenedCard,
  type OpenQuestion,
  percent,
  type Question,
  type QuestionSet,
  resolveThresholds,
  saidWords,
} from "@facetdb/core";

/**
 * One review card drawn for a terminal: where the record is and how long it has waited, its state
 * fields wrapped to the width with JSON laid out as key and value lines, each open question with
 * the model's answer in words and its figure beside what it means, the decided questions greyed,
 * the note, the keys. A figure is never alone: "58% likely yes", "billing, 82% sure". Status is
 * never colour alone: a decided question says "decided", the question the keys act on says "next to
 * answer".
 */

/** Styling by role. Colour only ever repeats what the words say. */
export type Style = {
  bold(text: string): string;
  dim(text: string): string;
  accent(text: string): string;
};

export const PLAIN: Style = { bold: (t) => t, dim: (t) => t, accent: (t) => t };

export const COLORED: Style = {
  bold: (t) => styleText("bold", t, { validateStream: false }),
  dim: (t) => styleText("dim", t, { validateStream: false }),
  accent: (t) => styleText("yellow", t, { validateStream: false }),
};

/** What a card is drawn from: the opened card, its source as the config names it, and the screen. */
export type CardView = {
  /** The source as the config names it (the card carries the store's id). */
  readonly sourceName: string;
  /** The record's key as the user writes it. */
  readonly keyText: string;
  readonly card: Pick<OpenedCard, "state" | "since">;
  /** Questions still waiting for a person, in order; the first is the one the keys decide. */
  readonly open: readonly OpenQuestion[];
  readonly decided: readonly {
    readonly question: Question;
    readonly value: boolean | string;
  }[];
  readonly questionSet: QuestionSet;
  readonly nowMs: number;
  readonly lockedUntilMs: number;
  readonly note: string | undefined;
  readonly width: number;
  readonly style: Style;
};

const MIN_WIDTH = 24;
// Past this depth a JSON value is shown as one wrapped line: a value nested thousands deep is data.
const MAX_JSON_DEPTH = 6;

/**
 * Text from a record is customer data and goes to a terminal: a control character or an escape
 * sequence in it could move the cursor, rewrite the screen or set the title. Everything but newline
 * and tab becomes the replacement character (bidirectional overrides too, which reorder what is
 * read); a tab becomes two spaces and a carriage return goes.
 */
export function plainText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\n") {
      out += char;
    } else if (char === "\t") {
      out += "  ";
    } else if (char === "\r") {
      // dropped: "\r\n" is a newline, a lone "\r" would overwrite the line
    } else if (isUnsafe(code)) {
      out += "�";
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * Characters a terminal acts on or a reader cannot see: C0 and C1 controls, the soft hyphen, the
 * Arabic letter mark, zero-width spaces and joiners, the left-to-right and right-to-left marks,
 * line and paragraph separators, every bidirectional override and isolate, the invisible
 * operators, the word joiner and the byte order mark.
 */
function isUnsafe(code: number): boolean {
  return (
    code < 0x20 ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0xad ||
    code === 0x61c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x2028 && code <= 0x202e) ||
    (code >= 0x2060 && code <= 0x206f) ||
    code === 0xfeff
  );
}

/** `plainText` on one line, for a key, a label or a name. */
export function oneLine(text: string): string {
  return plainText(text).replaceAll("\n", " ");
}

/** Wraps text to `width` characters at spaces, keeping its line breaks and breaking words longer than a line. */
export function wrap(text: string, width: number): string[] {
  const room = Math.max(width, MIN_WIDTH);
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    let lineLength = 0;
    for (const word of paragraph.split(" ")) {
      if (word === "") {
        continue;
      }
      let rest = [...word];
      while (rest.length > room) {
        if (line !== "") {
          lines.push(line);
          line = "";
          lineLength = 0;
        }
        lines.push(rest.slice(0, room).join(""));
        rest = rest.slice(room);
      }
      if (line === "") {
        line = rest.join("");
        lineLength = rest.length;
      } else if (lineLength + 1 + rest.length <= room) {
        line += ` ${rest.join("")}`;
        lineLength += 1 + rest.length;
      } else {
        lines.push(line);
        line = rest.join("");
        lineLength = rest.length;
      }
    }
    lines.push(line);
  }
  return lines;
}

function pad(text: string, length: number): string {
  return text + " ".repeat(Math.max(0, length - [...text].length));
}

/** The object a state value is when it is JSON text for one (a boundary: the database holds text). */
function jsonContainerOf(value: string): object | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** A JSON object or list as key and value lines, nested ones indented; list items are numbered from 1. */
function keyValueLines(node: object, width: number, depth: number): string[] {
  const entries: [string, unknown][] = Array.isArray(node)
    ? node.map((item, index): [string, unknown] => [String(index + 1), item])
    : Object.entries(node);
  if (entries.length === 0) {
    return [Array.isArray(node) ? "(empty list)" : "(empty)"];
  }
  const keys = entries.map(([key]) => oneLine(key));
  const keyWidth = Math.min(Math.max(...keys.map((key) => [...key].length)), 20);
  const lines: string[] = [];
  entries.forEach(([, value], index) => {
    const key = keys[index] ?? "";
    if (typeof value === "object" && value !== null) {
      lines.push(key);
      const inner =
        depth >= MAX_JSON_DEPTH
          ? wrap(oneLine(JSON.stringify(value)), width - 2)
          : keyValueLines(value, width - 2, depth + 1);
      for (const line of inner) {
        lines.push(`  ${line}`);
      }
      return;
    }
    const text = value === null ? "null" : plainText(String(value));
    wrap(text, width - keyWidth - 2).forEach((line, row) => {
      lines.push(`${row === 0 ? pad(key, keyWidth) : " ".repeat(keyWidth)}  ${line}`);
    });
  });
  return lines;
}

/** A state field's value as lines: wrapped text, or key and value lines when it is JSON. */
function valueLines(value: string | null, width: number, style: Style): string[] {
  if (value === null) {
    return [style.dim("(empty)")];
  }
  const container = jsonContainerOf(value);
  if (container !== undefined) {
    return keyValueLines(container, width, 0);
  }
  return wrap(plainText(value), width);
}

function stateLines(state: CardView["card"]["state"], width: number, style: Style): string[] {
  const names = Object.keys(state).map(oneLine);
  const labelWidth = Math.min(Math.max(0, ...names.map((name) => [...name].length)), 20);
  const lines: string[] = [];
  Object.entries(state).forEach(([name, value], index) => {
    const label = pad(names[index] ?? name, labelWidth);
    valueLines(value, width - labelWidth - 4, style).forEach((line, row) => {
      lines.push(`  ${row === 0 ? style.dim(label) : " ".repeat(labelWidth)}  ${line}`);
    });
  });
  return lines;
}

/** `YYYY-MM-DD HH:MM UTC`: the same hour on every machine, as `facetdb explain` prints it. */
export function whenUtc(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/** "14 minutes", "3 hours": how long a card has waited, in the largest whole unit. */
export function waitingWords(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60_000);
  if (minutes < 1) {
    return "less than a minute";
  }
  if (minutes < 60) {
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    return hours === 1 ? "1 hour" : `${hours} hours`;
  }
  return `${Math.floor(hours / 24)} days`;
}

/** "9:41": minutes and seconds left on a lock. */
export function leftWords(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** The names a pick numbers, 1 first: a choice's options or a score's levels, lowest first. */
export function pickNames(question: Question): readonly string[] {
  switch (question.type) {
    case "noul":
      return [];
    case "choice":
      return question.options.map((option) => option.name);
    case "score":
      return question.levels.map((level) => level.name);
  }
}

/** The kind of question in the card's own tag: "Yes or no", "Pick one", "Rate on a scale". */
function kindWords(question: Question): string {
  switch (question.type) {
    case "noul":
      return question.stakes === "high" ? "Yes or no, high stakes" : "Yes or no";
    case "choice":
      return "Pick one";
    case "score":
      return "Rate on a scale";
  }
}

/** When the thresholds decide on their own, in words (the card says what would have made it sure). */
function decidesWords(question: Question, set: QuestionSet): string {
  const thresholds = resolveThresholds(question, set.thresholds[question.name]);
  return thresholds.kind === "yes-no"
    ? `It decides on its own at ${percent(thresholds.yesAbove)} or more, or ${percent(thresholds.noBelow)} or less.`
    : `It decides on its own at ${percent(thresholds.confidenceAtLeast)} confidence or more.`;
}

/** How to answer the question, as the keys put it. */
export function answerKeys(question: Question): string {
  const names = pickNames(question);
  switch (question.type) {
    case "noul":
      return "y yes · n no";
    case "choice":
    case "score":
      return names.length >= 10
        ? `1 to ${names.length} pick (two digits from 10, then enter if it is shorter)`
        : `1 to ${names.length} pick`;
  }
}

function openLines(
  open: OpenQuestion,
  isNext: boolean,
  set: QuestionSet,
  width: number,
  style: Style,
): string[] {
  const { question, answer } = open;
  const tag = isNext ? style.accent("next to answer") : "waiting";
  const lines = [
    `${isNext ? style.accent(">") : " "} ${style.bold(oneLine(question.name))}  ${style.dim(`${kindWords(question)} · ${tag}`)}`,
    ...wrap(plainText(question.instructions), width - 4).map((line) => `    ${line}`),
  ];
  const says =
    answer.type === "noul"
      ? `The model says ${likelyYes(answer.probability)}.`
      : `The model leans ${saidWords(question, answer)}.`;
  lines.push(...wrap(`${says} ${decidesWords(question, set)}`, width - 4).map((l) => `    ${l}`));
  if (answer.type !== "noul") {
    const names = pickNames(question);
    const probabilities = answer.probabilities;
    const top = probabilities.indexOf(Math.max(...probabilities));
    const numberWidth = String(names.length).length;
    const nameWidth = Math.max(0, ...names.map((name) => [...oneLine(name)].length));
    names.forEach((name, index) => {
      const chance = `${percent(probabilities[index] ?? 0)} chance`;
      const pick = index === top ? "  the model's pick" : "";
      lines.push(
        `    ${String(index + 1).padStart(numberWidth)}  ${pad(oneLine(name), nameWidth)}  ${chance}${pick}`,
      );
    });
  }
  return lines;
}

function valueWords(value: boolean | string): string {
  return oneLine(chosenWords(value));
}

/** The whole card: header, state, open questions, decided questions, note and keys. */
export function renderCard(view: CardView): string {
  const { style, width } = view;
  const left = view.lockedUntilMs - view.nowMs;
  const waiting = `Waiting ${waitingWords(view.nowMs - view.card.since.getTime())}, since ${whenUtc(view.card.since)}.`;
  const lock = `Locked for you, ${leftWords(left)} left. It is renewed while this card is open.`;
  const lines = [
    style.dim("─".repeat(width)),
    ...wrap(`${oneLine(view.sourceName)} ${oneLine(view.keyText)}`, width).map(style.bold),
    ...wrap(waiting, width).map(style.dim),
    ...wrap(lock, width).map(style.dim),
    "",
    ...stateLines(view.card.state, width, style),
  ];
  for (const [index, open] of view.open.entries()) {
    lines.push("", ...openLines(open, index === 0, view.questionSet, width, style));
  }
  for (const decided of view.decided) {
    lines.push(
      "",
      ...wrap(
        `${oneLine(decided.question.name)} decided: ${valueWords(decided.value)} (not waiting for you)`,
        width - 2,
      ).map((line) => style.dim(`  ${line}`)),
    );
  }
  if (view.note !== undefined) {
    lines.push("", ...wrap(`Note for your next decision: ${plainText(view.note)}`, width));
  }
  const next = view.open[0];
  lines.push(
    "",
    ...wrap(
      `${next === undefined ? "" : `${answerKeys(next.question)} · `}: note · s skip · u undo · q quit`,
      width,
    ).map(style.dim),
  );
  return `${lines.join("\n")}\n`;
}
