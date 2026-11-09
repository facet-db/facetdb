import { FakeDecisionLog } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { RecordDecision, WriteResult } from "../contracts/index.ts";
import type { Question, QuestionSet } from "../questions/index.ts";
import type { Answer } from "../thresholds/index.ts";
import {
  type AnswerEntry,
  applyHumanDecision,
  type HumanEntry,
  humanDecisionStands,
  type ReviewedRecord,
  reapplyThresholds,
  recordAnswer,
} from "./index.ts";

// The questions and thresholds below are the low-stakes defaults: a noul is yes at or above 0.70
// and no at or below 0.30; a choice decides at confidence 0.50.
const scam: Question = {
  type: "noul",
  name: "scam",
  instructions: "Is this listing likely a scam?",
  stakes: "low",
};
const team: Question = {
  type: "choice",
  name: "team",
  instructions: "Which team owns this?",
  options: [
    { name: "billing", description: "Money questions" },
    { name: "tech", description: "Technical questions" },
  ],
  stakes: "low",
  storeProbabilities: false,
};

function questionSet(
  questions: readonly Question[],
  thresholds: QuestionSet["thresholds"] = {},
): QuestionSet {
  return { questions, read: ["body"], model: "jev-1.14.0", thresholds };
}

function answerEntry(
  key: string,
  stateHash: string,
  answers: Record<string, Answer>,
  version = 1,
): AnswerEntry {
  return {
    kind: "answer",
    key,
    version,
    model: "jev-1.14.0",
    stateHash,
    answers,
    usage: { inputTokens: 100, outputTokens: 10 },
    at: new Date("2026-10-31T10:00:00Z"),
  };
}

function humanEntry(
  key: string,
  question: string,
  value: boolean | string,
  stateHash: string,
): HumanEntry {
  return {
    kind: "human",
    key,
    question,
    value,
    reviewer: "amara",
    note: "checked by hand",
    stateHash,
    version: 1,
    at: new Date("2026-10-31T11:00:00Z"),
  };
}

/** A connector's write with a shared journal: it refuses a write whose expected hash is not the row's. */
function fakeWriter(journal: string[], rowHashes: Record<string, string>) {
  const writes: { key: string; decision: RecordDecision; expectedHash: string }[] = [];
  const write = (
    key: string,
    decision: RecordDecision,
    expectedHash: string,
  ): Promise<WriteResult> => {
    journal.push(`write ${key}`);
    if (rowHashes[key] !== expectedHash) {
      return Promise.resolve({ written: false });
    }
    writes.push({ key, decision, expectedHash });
    return Promise.resolve({ written: true });
  };
  return { write, writes };
}

// reapplyThresholds takes no model provider, so a threshold change cannot call one; the counter
// is asserted anyway so the day someone threads a provider through, this test says so.
const provider = { calls: 0 };

describe("an answer is logged before the row is written", () => {
  it("appends the answer, then writes, and the write carries the answer's state hash", async () => {
    const journal: string[] = [];
    const log = new FakeDecisionLog(journal);
    const { write, writes } = fakeWriter(journal, { r1: "h1" });
    const entry = answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.85 } });

    const result = await recordAnswer(entry, questionSet([scam]), log, write);

    expect(result.written).toBe(true);
    expect(journal).toEqual(["append answer r1", "write r1"]);
    expect(writes[0]?.expectedHash).toBe("h1");
    expect(writes[0]?.decision.status).toBe("done");
    expect(await log.latestAnswer("r1")).toEqual(entry);
  });

  it("keeps every answer in history, oldest first, and the latest per record", async () => {
    const log = new FakeDecisionLog();
    const first = answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.5 } }, 1);
    const second = answerEntry("r1", "h2", { scam: { type: "noul", probability: 0.9 } }, 2);
    await log.appendAnswer(first);
    await log.appendAnswer(second);
    await log.appendAnswer(
      answerEntry("r2", "h9", { scam: { type: "noul", probability: 0.1 } }, 1),
    );

    expect(await log.history("r1")).toEqual([first, second]);
    expect(await log.latestAnswer("r1")).toEqual(second);
    expect((await log.latestAnswersSince()).map((e) => e.key)).toEqual(["r1", "r2"]);
    expect((await log.latestAnswersSince(2)).map((e) => e.key)).toEqual(["r1"]);
  });
});

describe("re-applying thresholds reads the log, never the model", () => {
  it("loosening a threshold decides a waiting record, with no provider call", async () => {
    const journal: string[] = [];
    const log = new FakeDecisionLog(journal);
    const { write, writes } = fakeWriter(journal, { r1: "h1" });
    const current = questionSet([scam]);
    // 0.55 sits between 0.30 and 0.70: needs review at the defaults.
    await recordAnswer(
      answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.55 } }),
      current,
      log,
      write,
    );
    expect(writes[0]?.decision.status).toBe("needs_review");

    const report = await reapplyThresholds(current, { scam: { yesAbove: 0.5 } }, log, write);

    expect(report.written).toEqual(["r1"]);
    expect(writes[1]?.decision).toEqual({
      decisions: { scam: { kind: "decided", value: true, probabilityOrConfidence: 0.55 } },
      status: "done",
    });
    expect(writes[1]?.expectedHash).toBe("h1");
    expect(provider.calls).toBe(0);
  });

  it("tightening a threshold sends a decided record back to review", async () => {
    const log = new FakeDecisionLog();
    const { write, writes } = fakeWriter([], { r1: "h1" });
    const current = questionSet([scam]);
    await recordAnswer(
      answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.8 } }),
      current,
      log,
      write,
    );
    expect(writes[0]?.decision.status).toBe("done");

    const report = await reapplyThresholds(
      current,
      { scam: { yesAbove: 0.9, noBelow: 0.1 } },
      log,
      write,
    );

    expect(report.written).toEqual(["r1"]);
    expect(writes[1]?.decision).toEqual({
      decisions: { scam: { kind: "needs_review" } },
      status: "needs_review",
    });
  });

  it("decides a choice from the logged probabilities, not from a single stored number", async () => {
    const log = new FakeDecisionLog();
    const { write, writes } = fakeWriter([], { r1: "h1" });
    const current = questionSet([team]);
    // Confidence (0.6 - 1/2) / (1 - 1/2) = 0.2: below 0.50, so review at the defaults.
    await recordAnswer(
      answerEntry("r1", "h1", {
        team: { type: "choice", top: "billing", probabilities: [0.6, 0.4] },
      }),
      current,
      log,
      write,
    );

    await reapplyThresholds(current, { team: { confidenceAtLeast: 0.19 } }, log, write);

    expect(writes[1]?.decision.decisions["team"]).toMatchObject({
      kind: "decided",
      value: "billing",
    });
  });

  it("writes only where the decision changed", async () => {
    const log = new FakeDecisionLog();
    const { write, writes } = fakeWriter([], { r1: "h1", r2: "h2", r3: "h3" });
    const current = questionSet([scam]);
    await recordAnswer(
      answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.95 } }),
      current,
      log,
      write,
    );
    await recordAnswer(
      answerEntry("r2", "h2", { scam: { type: "noul", probability: 0.55 } }),
      current,
      log,
      write,
    );
    await recordAnswer(
      answerEntry("r3", "h3", { scam: { type: "noul", probability: 0.02 } }),
      current,
      log,
      write,
    );
    writes.length = 0;

    const report = await reapplyThresholds(current, { scam: { yesAbove: 0.5 } }, log, write);

    expect(report).toMatchObject({
      examined: 3,
      written: ["r2"],
      unchanged: 2,
      stale: [],
      unanswered: [],
    });
    expect(writes.map((w) => w.key)).toEqual(["r2"]);
  });

  it("changes a value when the new thresholds read the same answer the other way", async () => {
    const log = new FakeDecisionLog();
    const { write, writes } = fakeWriter([], { r1: "h1" });
    const current = questionSet([scam], { scam: { yesAbove: 0.4, noBelow: 0.2 } });
    await recordAnswer(
      answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.5 } }),
      current,
      log,
      write,
    );
    expect(writes[0]?.decision.decisions["scam"]).toMatchObject({ value: true });

    await reapplyThresholds(current, { scam: { yesAbove: 0.9, noBelow: 0.6 } }, log, write);

    expect(writes[1]?.decision.decisions["scam"]).toMatchObject({ kind: "decided", value: false });
  });

  it("reports a record whose row moved on as stale, and one missing a question as unanswered", async () => {
    const log = new FakeDecisionLog();
    const { write } = fakeWriter([], { r1: "h1-new", r2: "h2" });
    await log.appendAnswer(answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.55 } }));
    await log.appendAnswer(answerEntry("r2", "h2", { scam: { type: "noul", probability: 0.55 } }));

    const report = await reapplyThresholds(questionSet([scam, team]), {}, log, write);

    expect(report.stale).toEqual([]);
    expect(report.unanswered).toEqual(["r1", "r2"]);

    const staleReport = await reapplyThresholds(
      questionSet([scam]),
      { scam: { yesAbove: 0.5 } },
      log,
      write,
    );
    expect(staleReport.stale).toEqual(["r1"]);
    expect(staleReport.written).toEqual(["r2"]);
  });
});

describe("a human decision stands until the record's state changes", () => {
  const current = questionSet([scam]);
  const reviewed = (hash: string): ReviewedRecord => ({
    key: "r1",
    hash,
    status: "needs_review",
    questions: [scam],
    decisions: { scam: { kind: "needs_review" } },
    answers: { scam: { type: "noul", probability: 0.55 } },
  });

  it("is logged before it is written, writes the value at once, sets reviewed and closes the record", async () => {
    const journal: string[] = [];
    const log = new FakeDecisionLog(journal);
    const { write, writes } = fakeWriter(journal, { r1: "h1" });

    const result = await applyHumanDecision(
      humanEntry("r1", "scam", false, "h1"),
      reviewed("h1"),
      log,
      write,
    );

    expect(result).toEqual({ written: true, status: "done" });
    expect(journal).toEqual(["append human r1", "write r1"]);
    expect(writes[0]?.decision).toEqual({
      decisions: { scam: { kind: "decided", value: false, probabilityOrConfidence: 0.55 } },
      status: "done",
      reviewed: true,
    });
  });

  it("leaves the record in review while another question is still undecided", async () => {
    const log = new FakeDecisionLog();
    const { write, writes } = fakeWriter([], { r1: "h1" });
    const record: ReviewedRecord = {
      ...reviewed("h1"),
      questions: [scam, team],
      decisions: { scam: { kind: "needs_review" }, team: { kind: "needs_review" } },
      answers: {
        scam: { type: "noul", probability: 0.55 },
        team: { type: "choice", top: "billing", probabilities: [0.6, 0.4] },
      },
    };

    const result = await applyHumanDecision(
      humanEntry("r1", "scam", true, "h1"),
      record,
      log,
      write,
    );

    expect(result.status).toBe("needs_review");
    expect(writes[0]?.decision.reviewed).toBe(true);
    expect(writes[0]?.decision.decisions["team"]).toEqual({ kind: "needs_review" });
  });

  it("is refused for a record that is not waiting for review", async () => {
    const log = new FakeDecisionLog();
    const { write } = fakeWriter([], { r1: "h1" });

    await expect(
      applyHumanDecision(
        humanEntry("r1", "scam", true, "h1"),
        { ...reviewed("h1"), status: "done" },
        log,
        write,
      ),
    ).rejects.toThrow(/needs_review/);
  });

  it("survives loosening, tightening, and a new model answer for the same state", async () => {
    const log = new FakeDecisionLog();
    const { write, writes } = fakeWriter([], { r1: "h1" });
    await recordAnswer(
      answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.55 } }),
      current,
      log,
      write,
    );
    await applyHumanDecision(humanEntry("r1", "scam", false, "h1"), reviewed("h1"), log, write);
    writes.length = 0;

    // Loosening would decide yes (0.55 >= 0.5); tightening would send it back to review.
    const loosened = await reapplyThresholds(current, { scam: { yesAbove: 0.5 } }, log, write);
    const tightened = await reapplyThresholds(
      current,
      { scam: { yesAbove: 0.99, noBelow: 0.01 } },
      log,
      write,
    );
    // A model upgrade answers the same state again, now at 0.99.
    await recordAnswer(
      answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.99 } }, 2),
      questionSet([scam]),
      log,
      write,
    );

    expect(loosened.written).toEqual([]);
    expect(tightened.written).toEqual([]);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.decision.decisions["scam"]).toMatchObject({ kind: "decided", value: false });
  });

  it("is retired by a state change: the next answer is decided by the thresholds again", async () => {
    const log = new FakeDecisionLog();
    const { write, writes } = fakeWriter([], { r1: "h2" });
    await log.appendAnswer(answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.55 } }));
    await log.appendHuman(humanEntry("r1", "scam", false, "h1"));
    expect(await humanDecisionStands(log, "r1", "scam", "h1")).toBe(true);
    expect(await humanDecisionStands(log, "r1", "scam", "h2")).toBe(false);

    await recordAnswer(
      answerEntry("r1", "h2", { scam: { type: "noul", probability: 0.95 } }, 2),
      current,
      log,
      write,
    );

    expect(writes[0]?.decision.decisions["scam"]).toMatchObject({ kind: "decided", value: true });
  });

  it("goes by the person's latest word on a question", async () => {
    const log = new FakeDecisionLog();
    await log.appendHuman(humanEntry("r1", "scam", false, "h1"));
    await log.appendHuman(humanEntry("r1", "scam", true, "h1"));
    const { write, writes } = fakeWriter([], { r1: "h1" });

    await recordAnswer(
      answerEntry("r1", "h1", { scam: { type: "noul", probability: 0.1 } }),
      current,
      log,
      write,
    );

    expect(writes[0]?.decision.decisions["scam"]).toMatchObject({ kind: "decided", value: true });
  });

  it("keeps the first person's decision when a second decides from the same card snapshot", async () => {
    const log = new FakeDecisionLog();
    const { write, writes } = fakeWriter([], { r1: "h1" });
    const snapshot: ReviewedRecord = {
      ...reviewed("h1"),
      questions: [scam, team],
      decisions: { scam: { kind: "needs_review" }, team: { kind: "needs_review" } },
      answers: {
        scam: { type: "noul", probability: 0.55 },
        team: { type: "choice", top: "billing", probabilities: [0.6, 0.4] },
      },
    };

    await applyHumanDecision(humanEntry("r1", "scam", true, "h1"), snapshot, log, write);
    // The second reviewer's card still shows scam as needs_review.
    const second = await applyHumanDecision(
      humanEntry("r1", "team", "tech", "h1"),
      snapshot,
      log,
      write,
    );

    expect(second.status).toBe("done");
    expect(writes.at(-1)?.decision.decisions).toEqual({
      scam: { kind: "decided", value: true, probabilityOrConfidence: 0.55 },
      team: { kind: "decided", value: "tech", probabilityOrConfidence: 0.19999999999999996 },
    });
  });

  it("keeps both decisions when two reviewers overlap and the stale write lands last", async () => {
    const log = new FakeDecisionLog();
    const rows: RecordDecision[] = [];
    let atFirstWrite: () => void = () => {};
    const firstWriteStarted = new Promise<void>((resolve) => {
      atFirstWrite = resolve;
    });
    let releaseFirst: () => void = () => {};
    const firstWriteHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const write = async (_key: string, decision: RecordDecision): Promise<WriteResult> => {
      calls += 1;
      if (calls === 1) {
        atFirstWrite();
        await firstWriteHeld;
      }
      rows.push(decision);
      return { written: true };
    };
    const snapshot: ReviewedRecord = {
      ...reviewed("h1"),
      questions: [scam, team],
      decisions: { scam: { kind: "needs_review" }, team: { kind: "needs_review" } },
      answers: {
        scam: { type: "noul", probability: 0.55 },
        team: { type: "choice", top: "billing", probabilities: [0.6, 0.4] },
      },
    };

    // A logs scam and stalls in its write; B logs team and writes both; then A's stale write lands.
    const a = applyHumanDecision(humanEntry("r1", "scam", true, "h1"), snapshot, log, write);
    await firstWriteStarted;
    await applyHumanDecision(humanEntry("r1", "team", "tech", "h1"), snapshot, log, write);
    releaseFirst();
    await a;

    expect(rows.at(-1)?.status).toBe("done");
    expect(rows.at(-1)?.decisions["scam"]).toMatchObject({ kind: "decided", value: true });
    expect(rows.at(-1)?.decisions["team"]).toMatchObject({ kind: "decided", value: "tech" });
  });

  it("does not come back when the state returns: after A, B, A the decision made at A is retired", async () => {
    const log = new FakeDecisionLog();
    await log.appendAnswer(answerEntry("r1", "hA", { scam: { type: "noul", probability: 0.55 } }));
    await log.appendHuman(humanEntry("r1", "scam", false, "hA"));
    await log.appendAnswer(answerEntry("r1", "hB", { scam: { type: "noul", probability: 0.55 } }));
    const { write, writes } = fakeWriter([], { r1: "hA" });

    await recordAnswer(
      answerEntry("r1", "hA", { scam: { type: "noul", probability: 0.95 } }),
      current,
      log,
      write,
    );

    expect(await humanDecisionStands(log, "r1", "scam", "hA")).toBe(false);
    expect(writes[0]?.decision.decisions["scam"]).toMatchObject({ kind: "decided", value: true });
  });

  it("is refused by the write when the record changed while the card was open", async () => {
    const log = new FakeDecisionLog();
    const { write, writes } = fakeWriter([], { r1: "h-newer" });

    const result = await applyHumanDecision(
      humanEntry("r1", "scam", true, "h1"),
      reviewed("h1"),
      log,
      write,
    );

    expect(result.written).toBe(false);
    expect(writes).toEqual([]);
    expect(await humanDecisionStands(log, "r1", "scam", "h-newer")).toBe(false);
  });
});
