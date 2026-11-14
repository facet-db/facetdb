import { describe, expect, it } from "vitest";
import {
  bindCommand,
  holdsPassword,
  type MongoshLine,
  PASSWORD_PROMPT,
  parseLine,
  printLine,
} from "./mongosh.ts";

/**
 * The mongosh lines a plan prints and `run` reads back (the engine runs exactly the document the
 * operator read): printing then reading gives the same line, whatever a name or a value holds;
 * anything FacetDB does not print is refused; the password goes where `passwordPrompt()` stands.
 */

/** U+2028 and U+2029: line breaks to JavaScript, which JSON leaves unescaped. */
const LINE_SEPARATOR = String.fromCharCode(0x2028);
const PARAGRAPH_SEPARATOR = String.fromCharCode(0x2029);

/** A lone surrogate and the null character: strings JSON must escape to stay readable. */
const ODD = [String.fromCharCode(0xd800), String.fromCharCode(0)];

const lines: readonly MongoshLine[] = [
  { database: "app", command: { create: "facetdb_jobs" } },
  {
    database: "app",
    command: {
      findAndModify: "facetdb_meta",
      query: { _id: "owner:listings", project: "proj_listings" },
      update: { $set: { project: "proj_listings" }, $currentDate: { installedAt: true } },
      upsert: true,
    },
  },
  {
    database: "app",
    command: {
      update: "listings",
      updates: [{ q: {}, u: { $unset: { "facetdb.is_scam": "" } }, multi: true }],
    },
  },
  {
    database: "app",
    command: { drop: "facetdb_jobs" },
    unlessAny: { collection: "facetdb_meta", filter: {} },
  },
  { database: "app", command: { createUser: "facetdb_worker", pwd: PASSWORD_PROMPT, roles: [] } },
  {
    database: 'we"ird\\db',
    command: {
      a: [1, -2.5, 3e-7, 0, true, false, null, [], {}],
      "with space": `line${LINE_SEPARATOR}separator${PARAGRAPH_SEPARATOR}and\nnewline\ttab`,
      strings: ["passwordPrompt()", "é ✓ 𝄞", ...ODD],
    },
  },
];

const at = (index: number): MongoshLine => {
  const line = lines[index];
  if (line === undefined) {
    throw new Error(`no line ${index}`);
  }
  return line;
};

describe("a mongosh line", () => {
  it("reads back as the line it printed", () => {
    for (const line of lines) {
      expect(parseLine(printLine(line))).toEqual(line);
    }
  });

  it("is one line whatever its strings hold, and quotes only keys that are not names", () => {
    for (const line of lines) {
      const printed = printLine(line);
      for (const breaks of ["\n", "\r", LINE_SEPARATOR, PARAGRAPH_SEPARATOR]) {
        expect(printed).not.toContain(breaks);
      }
    }
    expect(printLine(at(2))).toBe(
      'db.getSiblingDB("app").runCommand({ update: "listings", updates: [{ q: {}, u: { $unset: { "facetdb.is_scam": "" } }, multi: true }] })',
    );
    expect(printLine(at(3))).toBe(
      'if (db.getSiblingDB("app").getCollection("facetdb_meta").findOne({}) === null) db.getSiblingDB("app").runCommand({ drop: "facetdb_jobs" })',
    );
    expect(printLine(at(4))).toBe(
      'db.getSiblingDB("app").runCommand({ createUser: "facetdb_worker", pwd: passwordPrompt(), roles: [] })',
    );
  });

  it("takes passwordPrompt() inside a string as text, and binds the password only where it stands", () => {
    expect(holdsPassword(parseLine(printLine(at(5))).command)).toBe(false);
    const login = parseLine(printLine(at(4)));
    expect(holdsPassword(login.command)).toBe(true);
    expect(bindCommand(login.command, "pw")).toEqual({
      createUser: "facetdb_worker",
      pwd: "pw",
      roles: [],
    });
    expect(() => bindCommand(login.command)).toThrow(/needs the worker's password/);
  });

  it("refuses anything FacetDB does not print", () => {
    for (const text of [
      'db.getSiblingDB("app").runCommand({ create: "x" }); db.dropDatabase()',
      'db.getSiblingDB("app").runCommand({ create: "x" })\ndb.dropDatabase()',
      'db.runCommand({ create: "x" })',
      'db.getSiblingDB("app").runCommand({ create: x })',
      'db.getSiblingDB("app").runCommand({ create: "x", create: "y" })',
      'db.getSiblingDB("app").runCommand({ __proto__: { create: "x" } })',
      'db.getSiblingDB("app").runCommand({ "__proto__": 1 })',
      'db.getSiblingDB("app").runCommand({ create: "x" ',
      'db.getSiblingDB("app").runCommand({ create: "x\\q" })',
      'db.getSiblingDB("app").runCommand({ create: ISODate("2026-11-03") })',
      'db.getSiblingDB("app").runCommand({ n: 01 })',
      'db.getSiblingDB("app").runCommand({ n: truex })',
      'if (db.getSiblingDB("other").getCollection("facetdb_meta").findOne({}) === null) db.getSiblingDB("app").runCommand({ drop: "facetdb_jobs" })',
      'if (db.getSiblingDB("app").getCollection("facetdb_meta").findOne({}) !== null) db.getSiblingDB("app").runCommand({ drop: "facetdb_jobs" })',
    ]) {
      expect(() => parseLine(text), text).toThrow(/not a line FacetDB prints/);
    }
  });
});
