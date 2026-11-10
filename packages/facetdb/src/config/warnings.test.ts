import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Question, QuestionSet } from "@facetdb/core";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "./load.ts";
import {
  type ConfigWarning,
  formatWarnings,
  type WordingWarning,
  type WordingWarningCode,
  wordingWarnings,
} from "./warnings.ts";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function yesNo(name: string, instructions: string, criteria?: { true?: string }): Question {
  return {
    type: "noul",
    name,
    instructions,
    stakes: "low",
    ...(criteria === undefined ? {} : { criteria }),
  };
}

function setOf(questions: Question[], read: string[] = ["body"]): QuestionSet {
  return { questions, read, model: "jev-1.14.0", thresholds: {} };
}

function codesFor(instructions: string, read?: string[]): WordingWarningCode[] {
  return wordingWarnings(setOf([yesNo("q", instructions)], read), 0).map((w) => w.code);
}

describe("a double negative", () => {
  it.each([
    "Is the customer not asking for no refund?",
    "Don't flag a message that isn't spam.",
    "Is it untrue that the reply never mentions the order, without exception?",
  ])("is flagged: %s", (text) => {
    expect(codesFor(text)).toEqual(["double-negative"]);
  });

  it("is judged per sentence, and one negation is fine", () => {
    expect(codesFor("Is the customer asking for a refund? Ignore messages with no text.")).toEqual(
      [],
    );
    expect(codesFor("Does the message say nothing about delivery?")).toEqual([]);
  });

  it("counts neither … nor as one negation and not only as none", () => {
    expect(codesFor("Does the message mention neither the invoice nor the order?")).toEqual([]);
    expect(codesFor("Is the customer not only angry but also asking for money back?")).toEqual([]);
  });

  it("also reads the criteria of a question", () => {
    const set = setOf([
      yesNo("refund", "Is this a refund request?", { true: "It is not a case of no refund" }),
    ]);
    expect(wordingWarnings(set, 0).map((w) => w.code)).toEqual(["double-negative"]);
  });
});

describe("counting", () => {
  it.each([
    "How many items did the customer order?",
    "Is the total above fifty euros?",
    "Does the message count the number of complaints?",
    "Did the customer write more than 3 times?",
    "Were there at least two attachments?",
  ])("is flagged: %s", (text) => {
    expect(codesFor(text)).toEqual(["counting"]);
  });

  it("leaves 'more than' and 'at least' alone when no number follows", () => {
    expect(codesFor("Is the customer more than a little upset?")).toEqual([]);
    expect(codesFor("Is the customer at least polite?")).toEqual([]);
    expect(codesFor("Does the message count as a complaint?")).toEqual([]);
    expect(codesFor("Is this an account question?")).toEqual([]);
  });
});

describe("a date comparison", () => {
  it.each([
    "Was the order placed before the delivery date?",
    "Is the invoice older than 30 days?",
    "Did the customer write within 3 days of the purchase?",
    "Is the ticket from after 2026-03-01?",
  ])("is flagged: %s", (text) => {
    expect(codesFor(text)).toEqual(["date-comparison"]);
  });

  it("is flagged next to a date-typed state field", () => {
    expect(codesFor("Did they reply before due_at?", ["body", "due_at"])).toEqual([
      "date-comparison",
    ]);
    expect(codesFor("Was it sent after the order.createdAt?", ["order.createdAt"])).toEqual([
      "date-comparison",
    ]);
  });

  it("leaves a comparison word alone when no date is near it", () => {
    expect(codesFor("Does the message thank us after the greeting?")).toEqual([]);
    expect(codesFor("Did they reply before due_at?", ["body", "channel"])).toEqual([]);
  });
});

describe("the state size", () => {
  const set = setOf([yesNo("q", "Is the customer asking for a refund?")]);

  it("warns above 8,000 estimated tokens, never at exactly 8,000", () => {
    expect(wordingWarnings(set, 8_000)).toEqual([]);
    const warnings = wordingWarnings(set, 8_001);
    expect(warnings.map((w) => w.code)).toEqual(["state-size"]);
    expect(warnings[0]?.question).toBeNull();
    expect(warnings[0]?.message).toContain("8,001");
    expect(warnings[0]?.message).toContain("8,000");
  });
});

describe("every warning", () => {
  const messy = setOf(
    [
      yesNo("a", "Is it not true that there is no refund?"),
      yesNo("b", "How many orders are older than 30 days?"),
    ],
    ["body"],
  );
  const warnings = wordingWarnings(messy, 20_000);

  it("covers all four codes", () => {
    expect(new Set(warnings.map((w) => w.code))).toEqual(
      new Set(["double-negative", "counting", "date-comparison", "state-size"]),
    );
  });

  it("carries a fix sentence and mentions neither noul nor a probability", () => {
    for (const warning of warnings) {
      expect(warning.fix.trim().length).toBeGreaterThan(20);
      expect(`${warning.message} ${warning.fix}`).not.toMatch(/noul|probabilit|percent|%/i);
    }
  });

  it("gives the remedy for numbers and dates", () => {
    const fix = (code: WordingWarningCode) => warnings.find((w) => w.code === code)?.fix ?? "";
    expect(fix("counting")).toContain("Compute the number in SQL and pass it as a state field");
    expect(fix("date-comparison")).toContain("SQL");
    expect(fix("date-comparison")).toContain("state field");
  });

  it("is printed with the source, the question and the fix", () => {
    const text = formatWarnings(warnings.map((w): ConfigWarning => ({ ...w, source: "tickets" })));
    expect(text).toContain('source "tickets", question "a"');
    expect(text).toContain('source "tickets", question "b"');
    expect(text).toContain('source "tickets"\n');
    for (const warning of warnings) {
      expect(text).toContain(`Fix: ${warning.fix}`);
    }
  });

  it("a clean question set yields none", () => {
    const clean = setOf(
      [
        yesNo("refund", "Is the customer asking for their money back?"),
        {
          type: "score",
          name: "urgency",
          instructions: "How urgent is this message?",
          stakes: "low",
          levels: [{ name: "low" }, { name: "medium" }, { name: "high" }],
        },
        {
          type: "choice",
          name: "team",
          instructions: "Which team should handle it?",
          stakes: "low",
          storeProbabilities: false,
          options: [
            { name: "billing", description: "Charges, payments, invoices" },
            { name: "shipping", description: "Delivery times, tracking" },
          ],
        },
      ],
      ["subject", "body", "channel"],
    );
    expect(wordingWarnings(clean, 1_200)).toEqual([]);
  });

  it("never changes the question set it reads", () => {
    const before = structuredClone(messy);
    wordingWarnings(messy, 20_000);
    expect(messy).toEqual(before);
  });
});

describe("the loader", () => {
  const scratch: string[] = [];

  afterEach(async () => {
    await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function project(instructions: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "facetdb-warnings-"));
    scratch.push(dir);
    await mkdir(join(dir, "node_modules"));
    await symlink(packageDir, join(dir, "node_modules", "facetdb"));
    await writeFile(
      join(dir, "facetdb.config.ts"),
      [
        'import { facetdb, noul } from "facetdb";',
        "export default facetdb({",
        '  model: "jev-1.14.0",',
        "  sources: [",
        '    { name: "tickets", api: true, read: ["body"], questions: {',
        `      many: noul(${JSON.stringify(instructions)}),`,
        '      late: noul("Was it sent before the deadline?"),',
        "    } },",
        "  ],",
        "});",
      ].join("\n"),
    );
    return dir;
  }

  function sink() {
    const writes: string[] = [];
    return { writes, stderr: { write: (text: string) => writes.push(text) } };
  }

  it("prints the warnings to stderr once per load and returns them beside the config", async () => {
    const projectDir = await project("How many orders does the customer have?");
    const { writes, stderr } = sink();
    const loaded = await loadConfig("facetdb.config.ts", { projectDir, env: {}, stderr });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('source "tickets", question "many"');
    expect(writes[0]).toContain('source "tickets", question "late"');
    expect(writes[0]).toContain("Fix: ");
    expect(loaded.warnings.map((w: WordingWarning) => [w.question, w.code])).toEqual([
      ["many", "counting"],
      ["late", "date-comparison"],
    ]);
    expect(loaded.config.sources[0]?.questions.map((q) => q.name)).toEqual(["many", "late"]);
  });

  it("prints nothing with quiet, and the config is the same either way", async () => {
    const projectDir = await project("How many orders does the customer have?");
    const loud = sink();
    const quiet = sink();
    const withPrint = await loadConfig("facetdb.config.ts", {
      projectDir,
      env: {},
      stderr: loud.stderr,
    });
    const silent = await loadConfig("facetdb.config.ts", {
      projectDir,
      env: {},
      stderr: quiet.stderr,
      quiet: true,
    });
    expect(quiet.writes).toEqual([]);
    expect(silent.warnings).toHaveLength(2);
    expect(silent.config).toEqual(withPrint.config);
  });

  it("adds the size warning when a command measured the state of a source", async () => {
    const projectDir = await project("Is the customer asking for their money back?");
    const dirty = sink();
    // Only the "late" question warns by its wording; the measured size adds one for the source.
    const loaded = await loadConfig("facetdb.config.ts", {
      projectDir,
      env: {},
      stderr: dirty.stderr,
      stateEstimates: { tickets: 9_000 },
    });
    expect(loaded.warnings.map((w) => w.code)).toEqual(["date-comparison", "state-size"]);
    expect(dirty.writes).toHaveLength(1);
  });
});
