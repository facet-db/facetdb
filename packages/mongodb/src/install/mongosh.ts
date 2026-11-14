import type { EnginePlan } from "@facetdb/core";

/**
 * A plan's statements as mongosh lines (the engine contract: "for MongoDB the mongosh line of one
 * command"). Each line names its database and holds one command document written in the part of
 * JavaScript that JSON and mongosh read alike, so the line runs as printed in a mongosh session and
 * `run` reads back exactly the document the operator read, by parsing, never by evaluating. There
 * are two shapes:
 *
 *   db.getSiblingDB("app").runCommand({ create: "facetdb_jobs" })
 *   if (db.getSiblingDB("app").getCollection("facetdb_meta").findOne({}) === null) db.getSiblingDB("app").runCommand({ drop: "facetdb_jobs" })
 *
 * The second runs its command only while a collection holds no document matching a filter: how an
 * uninstall drops what every collection of a database shares once none of them uses it, the check
 * at run time the contract asks of a run-scoped drop, which no MongoDB command makes by itself. The
 * one value that is not JSON is mongosh's own `passwordPrompt()`, where the `secret` statement's
 * password goes: mongosh asks the operator for it, and `run` binds the one it is given.
 */

/** Where the worker's password goes in the `secret` statement: printed as `passwordPrompt()`. */
export const PASSWORD_PROMPT: unique symbol = Symbol("passwordPrompt()");

export type CommandValue =
  | string
  | number
  | boolean
  | null
  | typeof PASSWORD_PROMPT
  | readonly CommandValue[]
  | CommandDocument;

/** A command document, or any document inside one: the first key of a command is its name. */
export type CommandDocument = { readonly [key: string]: CommandValue };

/** One line: the database it runs in, the command, and the guard it runs under, if any. */
export type MongoshLine = {
  readonly database: string;
  readonly command: CommandDocument;
  /** Run the command only while this collection of the same database has no document matching `filter`. */
  readonly unlessAny?: { readonly collection: string; readonly filter: CommandDocument };
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isList(value: CommandValue): value is readonly CommandValue[] {
  return Array.isArray(value);
}

/**
 * A JSON string, which is also a JavaScript one; U+2028 and U+2029 escaped too, so no string can
 * break a line that is read line by line.
 */
function printString(text: string): string {
  return JSON.stringify(text).replaceAll("\u2028", "\\u2028").replaceAll("\u2029", "\\u2029");
}

function printValue(value: CommandValue): string {
  if (value === PASSWORD_PROMPT) {
    return "passwordPrompt()";
  }
  if (value === null) {
    return "null";
  }
  if (isList(value)) {
    return `[${value.map(printValue).join(", ")}]`;
  }
  switch (typeof value) {
    case "string":
      return printString(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error(`a command holds only finite numbers, not ${value}`);
      }
      return JSON.stringify(value);
    case "boolean":
      return String(value);
    default: {
      const entries = Object.entries(value).map(
        ([key, inner]) => `${IDENTIFIER.test(key) ? key : printString(key)}: ${printValue(inner)}`,
      );
      return entries.length === 0 ? "{}" : `{ ${entries.join(", ")} }`;
    }
  }
}

const sibling = (database: string) => `db.getSiblingDB(${printString(database)})`;

/** The line as the operator reads it and mongosh runs it. */
export function printLine(line: MongoshLine): string {
  const call = `${sibling(line.database)}.runCommand(${printValue(line.command)})`;
  if (line.unlessAny === undefined) {
    return call;
  }
  const { collection, filter } = line.unlessAny;
  return `if (${sibling(line.database)}.getCollection(${printString(collection)}).findOne(${printValue(filter)}) === null) ${call}`;
}

/** The plan as one script, a line per statement and a blank line between: empty for a plan with none. */
export function renderScript(plan: EnginePlan): string {
  return plan.statements.length === 0
    ? ""
    : `${plan.statements.map((statement) => statement.text).join("\n\n")}\n`;
}

const NUMBER = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
const KEY = /[A-Za-z_$][A-Za-z0-9_$]*/y;
const WORD_GOES_ON = /[A-Za-z0-9_$]/;

/**
 * The line read back: its database, guard and command. Anything but the two shapes `printLine`
 * writes is refused with where it went wrong, so a plan read back from `--json` and altered runs
 * nothing it did not print. Only spaces separate the tokens; a key is a bare identifier or a
 * string, never `__proto__` (which a JavaScript object literal would take as its prototype).
 */
export function parseLine(text: string): MongoshLine {
  let at = 0;
  const fail: (what: string) => never = (what) => {
    throw new Error(`not a line FacetDB prints: ${what} at character ${at + 1}`);
  };
  const space = () => {
    while (text[at] === " ") {
      at += 1;
    }
  };
  const take = (literal: string) => {
    space();
    if (!text.startsWith(literal, at)) {
      fail(`expected ${literal}`);
    }
    at += literal.length;
  };
  const word = (literal: string): boolean =>
    text.startsWith(literal, at) && !WORD_GOES_ON.test(text[at + literal.length] ?? "");

  const string = (): string => {
    space();
    if (text[at] !== '"') {
      fail("expected a string");
    }
    let end = at + 1;
    while (end < text.length && text[end] !== '"') {
      end += text[end] === "\\" ? 2 : 1;
    }
    if (end >= text.length) {
      fail("a string that does not end");
    }
    let value: unknown;
    try {
      value = JSON.parse(text.slice(at, end + 1));
    } catch {
      fail("a string that is not JSON");
    }
    at = end + 1;
    return typeof value === "string" ? value : fail("expected a string");
  };

  const key = (): string => {
    space();
    let name: string;
    if (text[at] === '"') {
      name = string();
    } else {
      KEY.lastIndex = at;
      const match = KEY.exec(text);
      name = match === null ? fail("expected a key") : match[0];
      at += name.length;
    }
    return name === "__proto__" ? fail("the key __proto__") : name;
  };

  const value = (): CommandValue => {
    space();
    const next = text[at];
    if (next === "{") {
      return document();
    }
    if (next === "[") {
      at += 1;
      const items: CommandValue[] = [];
      space();
      if (text[at] === "]") {
        at += 1;
        return items;
      }
      for (;;) {
        items.push(value());
        space();
        if (text[at] === "]") {
          at += 1;
          return items;
        }
        take(",");
      }
    }
    if (next === '"') {
      return string();
    }
    if (next === "-" || (next !== undefined && next >= "0" && next <= "9")) {
      NUMBER.lastIndex = at;
      const match = NUMBER.exec(text);
      const digits = match === null ? fail("expected a number") : match[0];
      at += digits.length;
      return Number(digits);
    }
    for (const [literal, meaning] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const) {
      if (word(literal)) {
        at += literal.length;
        return meaning;
      }
    }
    if (text.startsWith("passwordPrompt()", at)) {
      at += "passwordPrompt()".length;
      return PASSWORD_PROMPT;
    }
    return fail("expected a value");
  };

  const document = (): CommandDocument => {
    take("{");
    const entries: [string, CommandValue][] = [];
    space();
    if (text[at] === "}") {
      at += 1;
      return {};
    }
    for (;;) {
      const name = key();
      if (entries.some(([seen]) => seen === name)) {
        fail(`the key ${name} twice`);
      }
      take(":");
      entries.push([name, value()]);
      space();
      if (text[at] === "}") {
        at += 1;
        return Object.fromEntries(entries);
      }
      take(",");
    }
  };

  const database = (): string => {
    take("db.getSiblingDB(");
    const name = string();
    take(")");
    return name;
  };

  const command = (): MongoshLine => {
    const name = database();
    take(".runCommand(");
    const body = document();
    take(")");
    space();
    if (at !== text.length) {
      fail("text after the command");
    }
    return { database: name, command: body };
  };

  space();
  if (!word("if")) {
    return command();
  }
  take("if");
  take("(");
  const guarded = database();
  take(".getCollection(");
  const collection = string();
  take(").findOne(");
  const filter = document();
  take(")");
  take("===");
  take("null");
  take(")");
  const line = command();
  return line.database === guarded
    ? { ...line, unlessAny: { collection, filter } }
    : fail("a guard on another database than its command");
}

/** Whether a value holds the password's placeholder anywhere. */
export function holdsPassword(value: CommandValue): boolean {
  if (value === PASSWORD_PROMPT) {
    return true;
  }
  if (value === null || typeof value !== "object") {
    return false;
  }
  return isList(value) ? value.some(holdsPassword) : Object.values(value).some(holdsPassword);
}

/** A plain value for the driver: the placeholder replaced by `password`, which it requires. */
function bound(value: CommandValue, password: string | undefined): unknown {
  if (value === PASSWORD_PROMPT) {
    if (password === undefined) {
      throw new Error("the command needs the worker's password, and none was given");
    }
    return password;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  return isList(value)
    ? value.map((item) => bound(item, password))
    : Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, bound(inner, password)]),
      );
}

/** The command as the driver sends it, the password bound where the line prints `passwordPrompt()`. */
export function bindCommand(
  command: CommandDocument,
  password?: string,
): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(command).map(([key, inner]) => [key, bound(inner, password)]),
  );
}
