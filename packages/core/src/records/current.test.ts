import { describe, expect, it } from "vitest";
import type { Question } from "../questions/index.ts";
import { parseCurrent } from "./current.ts";

/**
 * `parseCurrent`, the database boundary every engine that keeps answers in a record's columns reads
 * its stored decision through (`Connector.current`, for `explain` and the review screens): the
 * row's fixed aliases become the record's decision, and anything a column cannot hold is an error
 * naming the column, never a guess.
 */

const scam: Question = { type: "noul", name: "is_scam", instructions: "Scam?", stakes: "high" };
const category: Question = {
  type: "choice",
  name: "category",
  instructions: "Which category?",
  options: [
    { name: "car", description: "A car" },
    { name: "flat", description: "A flat" },
  ],
  stakes: "low",
  // A choice's probability list is never read back (`parseCurrent`): its stored one only.
  storeProbabilities: true,
};
const quality: Question = {
  type: "score",
  name: "quality",
  instructions: "How good?",
  levels: [{ name: "poor" }, { name: "fine" }, { name: "great" }],
  stakes: "low",
};
const QUESTIONS = [scam, category, quality];

/** A row as every engine's select hands it back: each answer as the database's own text. */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    q0v: "true",
    q0p: "0.93",
    q1v: "car",
    q1p: "0.81",
    q2v: "fine",
    q2p: "0.7",
    q2e: "1.2",
    cs: "done",
    cu: "1767225600000",
    cr: false,
    ...overrides,
  };
}

describe("parseCurrent", () => {
  it("reads every question's value and certainty, a score's expected value, the status and the time", () => {
    expect(parseCurrent(row(), QUESTIONS)).toEqual({
      decisions: {
        is_scam: { kind: "decided", value: true, probabilityOrConfidence: 0.93 },
        category: { kind: "decided", value: "car", probabilityOrConfidence: 0.81 },
        quality: { kind: "decided", value: "fine", probabilityOrConfidence: 0.7, expected: 1.2 },
      },
      status: "done",
      reviewed: false,
      updatedAt: new Date(1_767_225_600_000),
    });
  });

  it("is undefined while FacetDB never set the row's status (a polling install's unseen row)", () => {
    expect(parseCurrent(row({ cs: null }), QUESTIONS)).toBeUndefined();
  });

  it("leaves out a question whose value or certainty is NULL: not answered yet, or waiting for review", () => {
    const current = parseCurrent(
      row({ q0v: null, q0p: null, q1p: null, q2v: null, cs: "needs_review", cu: null, cr: true }),
      QUESTIONS,
    );
    expect(current).toEqual({
      decisions: {},
      status: "needs_review",
      reviewed: true,
      updatedAt: null,
    });
  });

  it("reads a no as false, and a score with no expected value without one", () => {
    expect(parseCurrent(row({ q0v: "false", q2e: null }), QUESTIONS)?.decisions).toEqual({
      is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.93 },
      category: { kind: "decided", value: "car", probabilityOrConfidence: 0.81 },
      quality: { kind: "decided", value: "fine", probabilityOrConfidence: 0.7 },
    });
  });

  it("reads only `true` as reviewed", () => {
    expect(parseCurrent(row({ cr: "true" }), QUESTIONS)?.reviewed).toBe(false);
    expect(parseCurrent(row({ cr: true }), QUESTIONS)?.reviewed).toBe(true);
  });

  it.each([
    [
      "a status that is not one of the six",
      { cs: "maybe" },
      'column "facetdb_status" holds "maybe", not a record status',
    ],
    [
      "an answer that is not text",
      { q1v: 3 },
      'a column of "category" came back as number, expected text',
    ],
    [
      "a yes or no that is neither",
      { q0v: "yes" },
      'the answer of "is_scam" reads "yes", expected true or false',
    ],
    [
      "a certainty that is no number",
      { q0p: "high" },
      'a column of "is_scam" reads "high", expected a number',
    ],
    ["a blank certainty", { q0p: " " }, 'a column of "is_scam" reads " ", expected a number'],
    [
      "a probability above 1",
      { q1p: "1.5" },
      'the probability of "category" reads 1.5, outside 0 to 1',
    ],
    [
      "a probability below 0",
      { q1p: "-0.1" },
      'the probability of "category" reads -0.1, outside 0 to 1',
    ],
    [
      "an expected value that is no number",
      { q2e: "Infinity" },
      'a column of "quality" reads "Infinity", expected a number',
    ],
    [
      "a time that is no number",
      { cu: "yesterday" },
      'a column of "facetdb_updated_at" reads "yesterday", expected a number',
    ],
  ])("refuses %s, naming the column", (_, overrides, message) => {
    expect(() => parseCurrent(row(overrides), QUESTIONS)).toThrow(message);
  });
});
