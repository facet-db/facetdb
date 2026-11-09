import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { NoulQuestion } from "../questions/index.ts";
import { decide, defaultThresholds } from "../thresholds/index.ts";
import { isBlank, shouldSkip } from "./skip.ts";
import { type StateValue, stateHash } from "./state-hash.ts";
import {
  RECORD_STATUSES,
  type RecordStatus,
  STATUS_COLUMN,
  type StatusEvent,
  transition,
} from "./status.ts";

describe("record statuses", () => {
  it("are exactly the six strings, with no seventh value", () => {
    expect([...RECORD_STATUSES]).toEqual([
      "pending",
      "done",
      "needs_review",
      "error",
      "unchecked",
      "skipped",
    ]);
    expect(STATUS_COLUMN).toBe("facetdb_status");
  });
});

describe("transition", () => {
  const allStatuses: readonly RecordStatus[] = RECORD_STATUSES;

  it.each<[StatusEvent, RecordStatus]>([
    ["queued", "pending"],
    ["answered-all-decided", "done"],
    ["answered-some-review", "needs_review"],
    ["model-error", "error"],
    ["released-unchecked", "unchecked"],
    ["skipped", "skipped"],
  ])("%s lands on %s from every status", (event, expected) => {
    for (const current of allStatuses) {
      expect(transition(current, event)).toBe(expected);
    }
  });

  it("a state change resets a decided record to pending by default (onChange reset)", () => {
    for (const current of allStatuses) {
      expect(transition(current, { event: "state-changed", onChange: "reset" })).toBe("pending");
    }
  });

  it("a state change keeps the previous status under onChange keep", () => {
    for (const current of allStatuses) {
      expect(transition(current, { event: "state-changed", onChange: "keep" })).toBe(current);
    }
  });

  it("a human decision that closes the last open question makes a needs_review record done", () => {
    expect(transition("needs_review", "human-decided-last")).toBe("done");
  });

  it("a human decision on any other status is refused, because only the review screen makes one", () => {
    for (const current of allStatuses.filter((s) => s !== "needs_review")) {
      expect(() => transition(current, "human-decided-last")).toThrow(/needs_review/);
    }
  });
});

describe("NULL until decided", () => {
  const question: NoulQuestion = {
    type: "noul",
    name: "urgent",
    instructions: "Is this urgent?",
    stakes: "low",
  };
  const thresholds = defaultThresholds("noul", "low");

  it("a probability between the thresholds gets no decision, so its value column stays NULL", () => {
    expect(decide(question, thresholds, { type: "noul", probability: 0.5 })).toEqual({
      kind: "needs_review",
    });
  });

  it("a record with one decided and one undecided question goes to needs_review; the decided question still returns its value", () => {
    const decided = decide(question, thresholds, { type: "noul", probability: 0.99 });
    const undecided = decide(question, thresholds, { type: "noul", probability: 0.5 });
    expect(decided).toEqual({ kind: "decided", value: true, probabilityOrConfidence: 0.99 });
    expect(undecided.kind).toBe("needs_review");
    expect(transition("pending", "answered-some-review")).toBe("needs_review");
  });
});

describe("stateHash", () => {
  const fields = ["status_text", "amount"] as const;
  const row: Record<string, StateValue> = { status_text: "open", amount: "12.50", notes: "first" };

  it("ignores a changed column outside the state", () => {
    const changed = { ...row, notes: "second", facetdb_status: "done" };
    expect(stateHash(fields, changed)).toBe(stateHash(fields, row));
  });

  it("changes when a state column changes", () => {
    expect(stateHash(fields, { ...row, status_text: "closed" })).not.toBe(stateHash(fields, row));
    expect(stateHash(fields, { ...row, amount: "13.00" })).not.toBe(stateHash(fields, row));
  });

  it("hashes a number as the database's text, so 12.50 and 12.5 are different states", () => {
    expect(stateHash(fields, { ...row, amount: "12.5" })).not.toBe(stateHash(fields, row));
  });

  it("keeps NULL distinct from blank", () => {
    const nul = stateHash(fields, { status_text: null, amount: "1" });
    const blank = stateHash(fields, { status_text: "", amount: "1" });
    expect(nul).not.toBe(blank);
  });

  it("depends on config order of the state fields", () => {
    expect(stateHash(["a", "b"], { a: "x", b: "y" })).not.toBe(
      stateHash(["b", "a"], { a: "x", b: "y" }),
    );
  });

  it("is a 64-character SHA-256 hex digest", () => {
    expect(stateHash(fields, row)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reordering the non-state columns never changes it", () => {
    const nonState = fc.uniqueArray(fc.stringMatching(/^x[a-z]{1,6}$/), {
      minLength: 1,
      maxLength: 6,
    });
    fc.assert(
      fc.property(
        fc.string(),
        fc.integer(),
        nonState,
        fc.array(fc.string(), { minLength: 6, maxLength: 6 }),
        fc.nat(),
        (text, n, names, texts, seed) => {
          const base: Record<string, StateValue> = { s_text: text, s_num: String(n) };
          const entries = names.map((name, i) => [name, texts[i] ?? ""] as const);
          const forward = Object.fromEntries(entries);
          const rotated = [
            ...entries.slice(seed % entries.length),
            ...entries.slice(0, seed % entries.length),
          ];
          const reordered = Object.fromEntries(rotated);
          const stateFields = ["s_text", "s_num"];
          expect(stateHash(stateFields, { ...base, ...reordered })).toBe(
            stateHash(stateFields, { ...base, ...forward }),
          );
        },
      ),
    );
  });
});

describe("shouldSkip", () => {
  const fields = ["title", "body"] as const;

  it("skips a record whose every state field is NULL or blank", () => {
    expect(shouldSkip(fields, { title: null, body: "   " }, { filterExcluded: false })).toEqual({
      skip: true,
      reason: "empty-state",
    });
  });

  it("does not skip when any state field has content", () => {
    expect(shouldSkip(fields, { title: null, body: "hello" }, { filterExcluded: false })).toEqual({
      skip: false,
    });
  });

  it("treats a number's or a boolean's database text as never blank", () => {
    expect(isBlank("0")).toBe(false);
    expect(isBlank("false")).toBe(false);
    expect(isBlank("")).toBe(true);
  });

  it("skips a record the where filter excluded, even with content, and says why", () => {
    expect(shouldSkip(fields, { title: "x", body: "y" }, { filterExcluded: true })).toEqual({
      skip: true,
      reason: "filtered-out",
    });
  });
});
