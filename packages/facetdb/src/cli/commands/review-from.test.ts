import {
  type Answer,
  type AnswerEntry,
  createReviewService,
  type DecisionLog,
  type HumanEntry,
  type LogEntry,
  type RecordKey,
  type ReviewService,
  recordAnswer,
  reviewEntryOf,
  stateHash,
} from "@facetdb/core";
import {
  FakeClock,
  FakeConnector,
  FakeDatabase,
  FakeDecisionLog,
  FakeReviewQueue,
} from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { runInProcess, type Workspace } from "../program.ts";
import { questionSetOf } from "./database.ts";
import { readAnswer } from "./export.ts";
import { createReviewCommand, type ReviewDoor, type ReviewSource } from "./review.ts";

/**
 * `facetdb review --from` through the in-process runner with the real review service over the
 * core's fakes, a fake file and a fake clock: no terminal, no real timer. The queue, the lock, the
 * hash check and the log are the service's own; what is tested here is what the command adds:
 * reading the file, judging each row, showing before doing, and letting go.
 */

const SOURCE = "acme:listings";
const START = Date.parse("2026-11-05T10:00:00Z");
const REVIEWER = "os:tester";
const FILE = "decisions.jsonl";

const config: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: "postgres://facetdb_worker:pw@localhost:5432/app",
      table: "listings",
      read: ["body"],
      questions: {
        scam: noul("Is this listing likely a scam?"),
        team: choice("Which team owns this?", { billing: "Money questions", tech: "Technical" }),
      },
    },
    {
      name: "tickets",
      database: "postgres://facetdb_worker:pw@localhost:5432/app",
      table: "tickets",
      read: ["body"],
      questions: { urgent: noul("Is this urgent?") },
    },
  ],
});

const UNSURE_SCAM: Answer = { type: "noul", probability: 0.58 };
const SURE_BILLING: Answer = { type: "choice", top: "billing", probabilities: [0.9, 0.1] };
const UNSURE_TEAM: Answer = { type: "choice", top: "billing", probabilities: [0.6, 0.4] };

/** A file the command reads: its path to its text; a path in `directories` is not a file. */
function workspaceOf(files: Readonly<Record<string, string>>): Workspace {
  const unused = () => Promise.reject(new Error("review --from touches no other file"));
  return {
    exists: unused,
    write: unused,
    writeParts: unused,
    hasClaudeCommand: () => false,
    peek: (path) => {
      const text = files[path];
      if (path === "a-directory") {
        return Promise.resolve({ kind: "other" });
      }
      return Promise.resolve(
        text === undefined
          ? { kind: "none" }
          : { kind: "file", firstLine: text.split("\n")[0] ?? "" },
      );
    },
    lines: (path) => {
      const text = files[path];
      if (text === undefined) {
        throw new Error(`no file ${path}`);
      }
      return (async function* () {
        for (const line of text.split("\n")) {
          yield line;
        }
      })();
    },
  };
}

type Setup = {
  /** Wraps the service the command decides through, to make something happen between its calls. */
  readonly wrap?: (service: ReviewService, stop: AbortController) => ReviewService;
};

function world(setup: Setup = {}) {
  const clock = new FakeClock(START);
  const db = new FakeDatabase({ fields: ["body"], clock });
  db.install();
  const connector = new FakeConnector(db);
  const log = new FakeDecisionLog();
  const queue = new FakeReviewQueue();
  const [listings] = config.sources;
  if (listings === undefined) {
    throw new Error("the test config has no source");
  }
  const questionSet = questionSetOf(config, listings);
  const service = createReviewService({
    queue,
    log: new Map<string, DecisionLog>([[SOURCE, log]]),
    connectors: new Map([[SOURCE, connector]]),
    actions: new Map([[SOURCE, []]]),
    questionSets: new Map([[SOURCE, { questionSet, version: 3 }]]),
    clock,
  });
  const sources: ReviewSource[] = [
    { id: SOURCE, name: "listings", questionSet, version: 3, keyText: undefined },
  ];
  const calls = { queue: 0, cards: 0, closed: 0 };
  const stop = new AbortController();
  const door: ReviewDoor = {
    queue: () => {
      calls.queue += 1;
      return Promise.resolve({
        reviewer: REVIEWER,
        queue,
        sources,
        logs: new Map([[SOURCE, log]]),
        versions: () => Promise.resolve(new Map([[3, questionSet]])),
        close: () => {
          calls.closed += 1;
          return Promise.resolve();
        },
      });
    },
    cards: () => {
      calls.cards += 1;
      return Promise.resolve({
        reviewer: REVIEWER,
        queue,
        sources,
        logs: new Map([[SOURCE, log]]),
        versions: () => Promise.resolve(new Map([[3, questionSet]])),
        service: setup.wrap === undefined ? service : setup.wrap(service, stop),
        close: () => {
          calls.closed += 1;
          return Promise.resolve();
        },
      });
    },
  };

  /** As the worker leaves a record: answered, logged, written, its card queued if it needs review. */
  async function seed(key: RecordKey, body: string, answers: Record<string, Answer>) {
    db.edit(key, { body });
    const hash = stateHash(["body"], { body });
    const entry: AnswerEntry = {
      kind: "answer",
      key,
      version: 3,
      model: "jev-1.14.0",
      stateHash: hash,
      answers,
      usage: { inputTokens: 100, outputTokens: 8 },
      at: new Date(clock.now()),
    };
    const written: Parameters<typeof reviewEntryOf>[0]["decisions"][] = [];
    await recordAnswer(entry, questionSet, log, (k, decision, expected) => {
      written.push(decision.decisions);
      return connector.write(k, decision, expected);
    });
    const [decisions] = written;
    if (decisions === undefined) {
      throw new Error("the seed's answer was not written");
    }
    if (Object.values(decisions).some((decision) => decision.kind === "needs_review")) {
      await queue.upsert({
        source: SOURCE,
        ...reviewEntryOf({ key, stateHash: hash, decisions, answers, since: entry.at }),
      });
    }
    clock.advance(1_000);
    return hash;
  }

  function run(
    argv: readonly string[],
    rows: readonly string[] | undefined,
    look: { answers?: readonly string[]; interactive?: boolean } = {},
  ) {
    return runInProcess(
      ["review", ...argv],
      {
        projectDir: "/work/acme",
        env: {},
        loadConfig: () => Promise.resolve(config),
        connect: () => {
          throw new Error("the fake door opens no database connection");
        },
        workspace: workspaceOf(rows === undefined ? {} : { [FILE]: rows.join("\n") }),
        clock,
        osUser: () => "tester",
        stopSignal: () => stop.signal,
        ...(look.answers === undefined ? {} : { answers: look.answers }),
        ...(look.interactive === undefined ? {} : { interactive: look.interactive }),
      },
      [createReviewCommand(door)],
    );
  }

  const history = async (key: RecordKey): Promise<readonly LogEntry[]> => log.history(key);
  const humans = async (key: RecordKey): Promise<HumanEntry[]> =>
    (await history(key)).filter((entry): entry is HumanEntry => entry.kind === "human");
  const lockOf = (key: RecordKey) => queue.rows.find((row) => row.key === key)?.lock ?? null;
  const statusOf = async (key: RecordKey) => (await connector.current([key])).get(key)?.status;

  return { clock, db, log, queue, service, calls, seed, run, history, humans, lockOf, statusOf };
}

/** A minimal row. */
const row = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({ source: "listings", key: "r1", question: "scam", value: "yes", ...fields });

/**
 * A line of `facetdb export --format jsonl` for an answer, as the export writes it (its own
 * `readAnswer` makes the words), with `edits` replacing a question's decision and `tweaks` any other
 * field of a question, as a person editing the file would.
 */
function answerLine(
  key: string,
  hash: string,
  answers: Record<string, Answer>,
  edits: Record<string, string> = {},
  tweaks: Record<string, Record<string, unknown>> = {},
) {
  const [listings] = config.sources;
  if (listings === undefined) {
    throw new Error("the test config has no source");
  }
  const set = questionSetOf(config, listings);
  return JSON.stringify({
    time: "2026-11-05T10:00:00.000Z",
    kind: "answer",
    record_key: key,
    version: 3,
    state_hash: hash,
    model: "jev-1.14.0",
    answers: Object.fromEntries(
      Object.entries(answers).map(([question, answer]) => [
        question,
        {
          ...answer,
          ...readAnswer(set, question, answer),
          ...(edits[question] === undefined ? {} : { decision: edits[question] }),
          ...tweaks[question],
        },
      ]),
    ),
  });
}

/** A line of the export for a person's decision. */
function humanLine(key: string, hash: string, question: string, value: string, by: string) {
  return JSON.stringify({
    time: "2026-11-05T10:05:00.000Z",
    kind: "human",
    record_key: key,
    version: 3,
    state_hash: hash,
    question,
    value,
    decision: value,
    decided_by: by,
  });
}

describe("facetdb review --from: the rows", () => {
  it("applies a minimal row as os:<name>, with its note, and lets the card go", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(["--from", FILE, "--yes"], [row({ note: "wire only" })]);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Will apply 1 decision as os:tester:");
    expect(result.stdout).toContain("line 1: listings r1, scam: yes");
    expect(result.stdout).toContain("Written to the record and logged for os:tester.");
    expect(result.stdout).toContain("Done: 1 applied, 0 already decided, 0 not applied");
    expect(await w.humans("r1")).toMatchObject([
      { question: "scam", value: true, reviewer: REVIEWER, note: "wire only", version: 3 },
    ]);
    expect(await w.statusOf("r1")).toBe("done");
    expect(w.lockOf("r1")).toBeNull();
    expect(result.prompts).toEqual([]);
  });

  it("takes yes and no, true and false, and an option's name, and decides every question of a record on one card", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const result = await w.run(
      ["--from", FILE, "--yes"],
      [row({ value: false }), row({ question: "team", value: "tech", note: "  " })],
    );

    expect(result.code, result.stderr).toBe(0);
    expect(await w.humans("r1")).toMatchObject([
      { question: "scam", value: false, reviewer: REVIEWER },
      { question: "team", value: "tech", reviewer: REVIEWER },
    ]);
    expect((await w.humans("r1"))[1]?.note).toBeUndefined();
    expect(await w.statusOf("r1")).toBe("done");
    expect(w.lockOf("r1")).toBeNull();
  });

  it("reads an edited export row: a needs-review decision changed to a value is the instruction, and the unedited rows are left as they are", async () => {
    const w = world();
    const hash = await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const other = await w.seed("r2", "Fine car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    // The export of the log: both records were answered, scam is for a person, team was decided.
    // Only r1's scam is edited (needs review made yes).
    const answers = { scam: UNSURE_SCAM, team: SURE_BILLING };
    const lines = [
      answerLine("r1", hash, answers, { scam: "yes" }),
      answerLine("r2", other, answers),
    ];

    const result = await w.run(["--from", FILE, "--yes", "--source", "listings"], lines);

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Will apply 1 decision as os:tester:");
    expect(result.stdout).toContain("line 1: listings r1, scam: yes");
    expect(result.stdout).toContain("1 line is left as it is");
    expect(result.stdout).not.toContain("refused");
    expect(await w.humans("r1")).toMatchObject([{ question: "scam", value: true }]);
    // The unedited record keeps its card.
    expect(await w.humans("r2")).toEqual([]);
    expect(w.queue.rows.map((card) => card.key)).toEqual(["r2"]);
  });

  it("counts only a record's last answer row, the ones before it being its history", async () => {
    const w = world();
    const old = stateHash(["body"], { body: "Old text" });
    const hash = await w.seed("r1", "New text", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const answers = { scam: UNSURE_SCAM, team: SURE_BILLING };
    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", old, answers, { scam: "yes" }), answerLine("r1", hash, answers)],
    );

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("No decision to apply.");
    expect(result.stdout).not.toContain("refused");
    expect(await w.humans("r1")).toEqual([]);
  });

  it("asks which source an export belongs to when the config has more than one", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(
      ["--from", FILE],
      [answerLine("r1", "abc", { scam: UNSURE_SCAM, team: SURE_BILLING })],
    );

    expect(result.code).toBe(2);
    expect(result.stderr).toContain("line 1 is a row of facetdb export, which names no source");
    expect(result.stderr).toContain("fix: pass --source <name>");
    expect(w.calls).toEqual({ queue: 0, cards: 0, closed: 0 });
  });

  it("refuses the rows it cannot use by line number, still applies the good ones, and says what a row looks like", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(
      ["--from", FILE, "--yes"],
      [
        "this is not json",
        row(),
        "",
        JSON.stringify({ source: "listings", key: "r1", value: "yes" }),
        row({ question: "nope" }),
        row({ question: "team", value: "sales" }),
        row({ source: "ghost" }),
        row({ source: "tickets" }),
        "[1, 2]",
        JSON.stringify({ kind: "weird" }),
        row({ notes: "typo" }),
      ],
    );

    // Every outcome is printed, the good row is applied, and the run ends in exit 1: lines were refused.
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("9 lines were refused or not applied");
    expect(result.stderr).toContain("the other 1 decision was applied");
    expect(result.stdout).toContain("9 rows are refused and skipped:");
    expect(result.stdout).toContain("line 1: is not JSON");
    expect(result.stdout).toContain("line 4: question: question is missing or not text");
    expect(result.stdout).toContain(
      'line 5: listings has no question named "nope"; it asks scam, team',
    );
    expect(result.stdout).toContain(
      'line 6: "sales" is not an option of "team"; pick one of billing, tech',
    );
    expect(result.stdout).toContain('line 7: the config has no source named "ghost"');
    expect(result.stdout).toContain("line 8: tickets has never run a worker");
    expect(result.stdout).toContain("line 9: is not a JSON object");
    expect(result.stdout).toContain("an export row's kind is answer or human");
    expect(result.stdout).toContain("Unrecognized key");
    expect(result.stdout).toContain('a decision row is {"source":"listings"');
    expect(result.stdout).toContain("line 2: listings r1, scam: yes. Written");
    expect(await w.humans("r1")).toHaveLength(1);
  });

  it("refuses a decision that contradicts another line of the file, and lets a repeated one pass", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(["--from", FILE, "--yes"], [row(), row(), row({ value: "no" })]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "line 3: listings r1, scam: line 1 decides this question as yes and this line as no",
    );
    expect(result.stdout).toContain("Will apply 1 decision");
    expect(await w.humans("r1")).toMatchObject([{ value: true }]);
  });

  it("refuses a record that is not waiting, and says why: never answered, or decided by the thresholds", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(
      ["--from", FILE, "--yes"],
      [row({ key: "ghost" }), row({ question: "team", value: "tech" }), row({ key: "r9" }), row()],
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "line 1: listings ghost, scam: the worker has never answered this record",
    );
    expect(result.stdout).toContain(
      '"team" is not waiting for a person on this record: the thresholds decided it',
    );
    expect(result.stdout).toContain("line 4: listings r1, scam: yes. Written");
    expect(await w.humans("r1")).toMatchObject([{ question: "scam" }]);
  });

  it("neutralises control characters in what the file says before printing it", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const evil = `r1${esc}[31mred${String.fromCharCode(0x202e)}`;
    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [
        row({ key: evil }),
        row({ question: `x${bel}y` }),
        row({ source: evil }),
        // zod's own words carry the extra key, and the path of a malformed answer carries its key.
        row({ [`${esc}]0;pwned${bel}`]: 1 }),
        JSON.stringify({
          kind: "answer",
          record_key: "r1",
          state_hash: "abc",
          answers: { [`${esc}[2J`]: {} },
        }),
      ],
    );

    expect(result.code).toBe(1);
    for (const text of [result.stdout, result.stderr]) {
      expect(text).not.toContain(esc);
      expect(text).not.toContain(bel);
      expect(text).not.toContain(String.fromCharCode(0x202e));
    }
    expect(result.stdout).toContain("�");
    expect(result.stdout).toContain("pwned");
  });

  it("prints nothing of the file raw under --json either", async () => {
    const w = world();
    const esc = String.fromCharCode(27);
    const result = await w.run(
      ["--from", FILE, "--yes", "--json"],
      [row({ [`${esc}]0;pwned${String.fromCharCode(7)}`]: 1 })],
    );
    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(esc);
    expect(result.stderr).not.toContain(esc);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false });
  });
});

describe("facetdb review --from: a record that changed", () => {
  it("refuses an export row made at a state the record no longer has, and applies it to nothing", async () => {
    const w = world();
    const old = await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    // The record was edited and answered again after the export.
    const fresh = await w.seed("r1", "Cheap car, now with a photo", {
      scam: UNSURE_SCAM,
      team: SURE_BILLING,
    });
    expect(fresh).not.toBe(old);

    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", old, { scam: UNSURE_SCAM, team: SURE_BILLING }, { scam: "yes" })],
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("1 row is refused and skipped:");
    expect(result.stdout).toContain(
      `the record changed since this row was made (the row is for state ${old.slice(0, 8)}, the record is now at ${fresh.slice(0, 8)})`,
    );
    expect(result.stdout).toContain("No decision to apply.");
    expect(await w.humans("r1")).toEqual([]);
    expect(await w.statusOf("r1")).toBe("needs_review");
    // Nothing was locked for a row that was refused.
    expect(w.lockOf("r1")).toBeNull();
    expect(w.calls.cards).toBe(1);
  });

  it("refuses the row if the record changes between the plan and the decision, and lets the card go", async () => {
    const w = world({
      wrap: (service) => ({
        ...service,
        decide: async (...args) => {
          // The model answered the record again while the plan was being read.
          await w.seed("r1", "Cheap car, edited", { scam: UNSURE_SCAM, team: SURE_BILLING });
          return service.decide(...args);
        },
      }),
    });
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(["--from", FILE, "--yes"], [row()]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("not applied:");
    expect(await w.humans("r1")).toEqual([]);
    expect(w.lockOf("r1")).toBeNull();
  });

  /** r1 answered at state A, decided by maya, edited and answered again at state B. */
  async function decidedThenChanged(w: ReturnType<typeof world>) {
    const answers = { scam: UNSURE_SCAM, team: SURE_BILLING };
    const a = await w.seed("r1", "Cheap car", answers);
    await w.service.openKey("maya", SOURCE, "r1");
    await w.service.decide("maya", { source: SOURCE, key: "r1", stateHash: a }, "scam", true);
    await w.service.release("maya", { source: SOURCE, key: "r1", stateHash: a });
    const b = await w.seed("r1", "Cheap car, now with a photo", answers);
    expect(await w.statusOf("r1")).toBe("needs_review");
    return { a, b, answers };
  }

  it.each([
    ["yes", true],
    ["no", false],
  ])(
    "applies the edit %s of the answer at the current state, whatever a person decided at the one before",
    async (words, value) => {
      const w = world();
      const { a, b, answers } = await decidedThenChanged(w);

      // The export of that log: the answer at A, the person's decision at A, the answer at B edited.
      const result = await w.run(
        ["--from", FILE, "--yes", "--source", "listings"],
        [
          answerLine("r1", a, answers),
          humanLine("r1", a, "scam", "yes", "maya"),
          answerLine("r1", b, answers, { scam: words }),
        ],
      );

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Will apply 1 decision as os:tester:");
      expect(result.stdout).not.toContain("refused");
      expect(await w.humans("r1")).toMatchObject([
        { reviewer: "maya", value: true, stateHash: a },
        { reviewer: REVIEWER, value, stateHash: b },
      ]);
      expect(await w.statusOf("r1")).toBe("done");
    },
  );

  it("leaves the unedited export of that history alone", async () => {
    const w = world();
    const { a, b, answers } = await decidedThenChanged(w);
    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [
        answerLine("r1", a, answers),
        humanLine("r1", a, "scam", "yes", "maya"),
        answerLine("r1", b, answers),
      ],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("No decision to apply.");
    expect(await w.humans("r1")).toHaveLength(1);
  });

  it("refuses an edit of a record that changed since and is now done, as changed", async () => {
    const w = world();
    const answers = { scam: UNSURE_SCAM, team: SURE_BILLING };
    const a = await w.seed("r1", "Cheap car", answers);
    // Answered again, and this time the thresholds decide everything: no card is left.
    const b = await w.seed("r1", "Cheap car, now with a photo", {
      scam: { type: "noul", probability: 0.95 },
      team: SURE_BILLING,
    });
    expect(await w.statusOf("r1")).toBe("done");
    // As the worker's write leaves the queue of a record that is done.
    await w.queue.remove(SOURCE, "r1");

    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", a, answers, { scam: "yes" })],
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      `the record changed since this row was made (the row is for state ${a.slice(0, 8)}, the log's latest answer is at ${b.slice(0, 8)})`,
    );
    expect(await w.humans("r1")).toEqual([]);
  });
});

describe("facetdb review --from: an edit is applied or refused, never left", () => {
  const answers = { scam: UNSURE_SCAM, team: SURE_BILLING };

  it("refuses an edit of a question the thresholds decided, with that reason", async () => {
    const w = world();
    const hash = await w.seed("r1", "Cheap car", answers);

    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", hash, answers, { team: "tech" })],
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      'line 1: listings r1, team: "team" is not waiting for a person on this record: the thresholds decided it',
    );
    expect(result.stdout).not.toContain("left as it is");
    expect(await w.humans("r1")).toEqual([]);
  });

  it("refuses an edit of a card another reviewer has open, saying so", async () => {
    const w = world();
    const hash = await w.seed("r1", "Cheap car", answers);
    await w.queue.lock(SOURCE, "r1", "maya", w.clock.now());

    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", hash, answers, { scam: "yes" })],
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("another reviewer has it open");
    expect(await w.humans("r1")).toEqual([]);
    expect(w.lockOf("r1")).toMatchObject({ by: "maya" });
  });

  it("refuses a decision the log has no answer for at that state", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", answers);
    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", "d".repeat(64), answers, { scam: "yes" })],
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("the log has no answer to this record at state dddddddd");
  });

  it("says the true reason when the card is in your queue but the question is not open on it", async () => {
    const w = world();
    const both = { scam: UNSURE_SCAM, team: UNSURE_TEAM };
    const hash = await w.seed("r1", "Cheap car", both);
    // The card at the same state, as it stands after the thresholds took scam off it.
    await w.queue.upsert({
      source: SOURCE,
      key: "r1",
      stateHash: hash,
      openQuestions: ["team"],
      numbers: { team: 0.2 },
      since: new Date(START),
    });

    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", hash, both, { scam: "yes" })],
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      '"scam" was waiting for a person when this row was made, but it is not open on this record\'s card any more',
    );
    expect(result.stdout).not.toContain("not in your queue");
    expect(await w.humans("r1")).toEqual([]);
  });

  it("lists one decision for one question: a minimal row and an edited answer row that disagree are refused before the confirmation, either way round", async () => {
    const answers = { scam: UNSURE_SCAM, team: SURE_BILLING };
    const args = ["--from", FILE, "--source", "listings"];

    const minimalFirst = world();
    const a = await minimalFirst.seed("r1", "Cheap car", answers);
    const first = await minimalFirst.run(
      args,
      [row({ value: "no" }), answerLine("r1", a, answers, { scam: "yes" })],
      { answers: ["yes"] },
    );
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("Will apply 1 decision as os:tester:");
    expect(first.stdout).toContain("line 1: listings r1, scam: no");
    expect(first.stdout).toContain(
      "line 2: listings r1, scam: line 1 decides this question as no and this line as yes",
    );
    expect(first.prompts).toEqual(["Apply 1 decision as os:tester? Type yes to continue: "]);
    expect(await minimalFirst.humans("r1")).toMatchObject([{ value: false }]);

    const answerFirst = world();
    const b = await answerFirst.seed("r1", "Cheap car", answers);
    const second = await answerFirst.run(
      args,
      [answerLine("r1", b, answers, { scam: "yes" }), row({ value: "no" })],
      { answers: ["yes"] },
    );
    expect(second.code).toBe(1);
    expect(second.stdout).toContain("line 1: listings r1, scam: yes");
    expect(second.stdout).toContain(
      "line 2: listings r1, scam: line 1 decides this question as yes and this line as no",
    );
    expect(await answerFirst.humans("r1")).toMatchObject([{ value: true }]);
  });

  it("counts two rows that agree once", async () => {
    const answers = { scam: UNSURE_SCAM, team: SURE_BILLING };
    const w = world();
    const hash = await w.seed("r1", "Cheap car", answers);
    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [row(), answerLine("r1", hash, answers, { scam: "yes" })],
    );
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Will apply 1 decision as os:tester:");
    expect(result.stdout).not.toContain("refused");
    expect(await w.humans("r1")).toHaveLength(1);
  });

  it("refuses a state hash that is not the 64 hex characters the export writes, printing none of it raw", async () => {
    const answers = { scam: UNSURE_SCAM, team: SURE_BILLING };
    const w = world();
    await w.seed("r1", "Cheap car", answers);
    const esc = String.fromCharCode(27);
    const bel = String.fromCharCode(7);
    const evil = `${esc}]0;pwzz${bel}zz`;
    const lines = [
      // An edited answer line and a human line, each with the title-setting sequence as its hash.
      answerLine("r1", evil, answers, { scam: "yes" }),
      humanLine("r1", evil, "scam", "yes", REVIEWER),
    ];

    for (const flags of [[], ["--json"]]) {
      const result = await w.run(
        ["--from", FILE, "--yes", "--source", "listings", ...flags],
        lines,
      );
      expect(result.code).toBe(1);
      for (const text of [result.stdout, result.stderr]) {
        expect(text).not.toContain(esc);
        expect(text).not.toContain(bel);
      }
      expect(`${result.stdout}${result.stderr}`).toContain(
        "state_hash must be the 64 lowercase hex characters the export writes",
      );
    }
    expect(await w.humans("r1")).toEqual([]);
  });

  it("refuses words that are not an answer to the question, and a decision changed to nothing", async () => {
    const w = world();
    const hash = await w.seed("r1", "Cheap car", answers);
    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", hash, answers, { scam: "maybe", team: "needs review" })],
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain('"maybe" is not an answer to "scam", a yes-or-no question');
    expect(result.stdout).toContain(
      'team: the decision was changed to "needs review", which decides nothing',
    );
    expect(await w.humans("r1")).toEqual([]);
  });

  it("refuses an edit to the model's value or top that leaves the decision as it was, saying where a decision goes", async () => {
    const w = world();
    const hash = await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const both = { scam: UNSURE_SCAM, team: UNSURE_TEAM };

    const value = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", hash, both, {}, { team: { value: "tech" } })],
    );
    expect(value.code).toBe(1);
    expect(value.stdout).toContain(
      "team: the model's value was changed, but that decides nothing: a decision is written in the decision field",
    );

    const top = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [answerLine("r1", hash, both, {}, { team: { top: "tech" } })],
    );
    expect(top.code).toBe(1);
    expect(top.stdout).toContain("the model's top was changed");
    expect(await w.humans("r1")).toEqual([]);
  });
});

describe("facetdb review --from: what already stands", () => {
  it("applies nothing twice: the second run says the decision was made, and by you", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.run(["--from", FILE, "--yes"], [row()]);

    const again = await w.run(["--from", FILE, "--yes"], [row()]);

    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain("1 row is already decided, so nothing is applied twice:");
    expect(again.stdout).toContain("already decided as yes by you (os:tester) on 2026-11-05");
    expect(again.stdout).toContain("No decision to apply.");
    expect(await w.humans("r1")).toHaveLength(1);
  });

  it("applies an edited export row only once, too: the same file run again reports it decided", async () => {
    const w = world();
    const hash = await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const lines = [
      answerLine("r1", hash, { scam: UNSURE_SCAM, team: SURE_BILLING }, { scam: "yes" }),
    ];
    await w.run(["--from", FILE, "--yes", "--source", "listings"], lines);

    const again = await w.run(["--from", FILE, "--yes", "--source", "listings"], lines);

    expect(again.stdout).toContain("already decided as yes by you (os:tester)");
    expect(await w.humans("r1")).toHaveLength(1);
  });

  it("names another reviewer who decided it, and refuses a different value over a person's decision", async () => {
    const w = world();
    const hash = await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    await w.queue.lock(SOURCE, "r1", "maya", w.clock.now());
    const opened = await w.service.openKey("maya", SOURCE, "r1");
    expect(opened.kind).toBe("opened");
    await w.service.decide("maya", { source: SOURCE, key: "r1", stateHash: hash }, "scam", false);
    await w.service.release("maya", { source: SOURCE, key: "r1", stateHash: hash });

    const same = await w.run(
      ["--from", FILE, "--yes"],
      [row({ value: "no" }), row({ question: "team", value: "tech" })],
    );
    expect(same.code, same.stderr).toBe(0);
    expect(same.stdout).toContain("already decided as no by maya on 2026-11-05");

    const other = await w.run(["--from", FILE, "--yes"], [row({ value: "yes" })]);
    expect(other.code).toBe(1);
    expect(other.stdout).toContain(
      '"scam" was already decided as no by maya on 2026-11-05 10:00 UTC; a decision a person made is never overwritten',
    );
    expect(await w.humans("r1")).toMatchObject([
      { question: "scam", value: false, reviewer: "maya" },
      { question: "team", value: "tech", reviewer: REVIEWER },
    ]);
  });

  it("compares an export's human row with what stands: the same is already decided, an edit is refused", async () => {
    const w = world();
    const hash = await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    await w.run(["--from", FILE, "--yes"], [row({ value: "no" })]);

    const args = ["--from", FILE, "--yes", "--source", "listings"];

    const unedited = await w.run(args, [humanLine("r1", hash, "scam", "no", REVIEWER)]);
    expect(unedited.code, unedited.stderr).toBe(0);
    expect(unedited.stdout).toContain("line 1: listings r1, scam: already decided as no by you");
    expect(unedited.stdout).not.toContain("refused");

    // The edit of the last row is refused; the row before it was the log's history of that question.
    const edited = await w.run(args, [
      humanLine("r1", hash, "scam", "no", REVIEWER),
      humanLine("r1", hash, "scam", "yes", REVIEWER),
    ]);
    expect(edited.code).toBe(1);
    expect(edited.stdout).toContain("1 row is refused and skipped:");
    expect(edited.stdout).toContain(
      'line 2: listings r1, scam: "scam" was already decided as no by you (os:tester) on 2026-11-05 10:00 UTC; a decision a person made is never overwritten',
    );

    // One of the two words edited and not the other is a line that says two things.
    const torn = await w.run(args, [
      JSON.stringify({
        kind: "human",
        record_key: "r1",
        state_hash: hash,
        question: "scam",
        value: "no",
        decision: "yes",
        decided_by: REVIEWER,
      }),
    ]);
    expect(torn.code).toBe(1);
    expect(torn.stdout).toContain(
      'line 1: value is "no" and decision is "yes"; a person\'s decision is written in both, so edit both or neither',
    );
    expect(torn.stdout).not.toContain("already decided");

    // A take-back as the last row leaves nothing to apply.
    const withdrawn = await w.run(args, [
      humanLine("r1", hash, "scam", "no", REVIEWER),
      humanLine("r1", hash, "scam", "withdrawn", REVIEWER),
    ]);
    expect(withdrawn.stdout).toContain("No decision to apply.");
    expect(withdrawn.stdout).not.toContain("refused");
    expect(await w.humans("r1")).toHaveLength(1);
  });

  it("leaves a card another reviewer has open alone, and says it may be open elsewhere", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.queue.lock(SOURCE, "r1", "maya", w.clock.now());

    const result = await w.run(["--from", FILE, "--yes"], [row()]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("or another reviewer has it open");
    expect(await w.humans("r1")).toEqual([]);
    expect(w.lockOf("r1")).toMatchObject({ by: "maya" });
  });

  it("refuses a card another reviewer opens between the plan and the decision, and leaves their lock", async () => {
    const w = world({
      wrap: (service) => ({
        ...service,
        openKey: async (viewer, source, key) => {
          await w.queue.lock(source, key, "maya", w.clock.now());
          return service.openKey(viewer, source, key);
        },
      }),
    });
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(["--from", FILE, "--yes"], [row()]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("maya has this card open until");
    expect(await w.humans("r1")).toEqual([]);
    expect(w.lockOf("r1")).toMatchObject({ by: "maya" });
  });
});

describe("facetdb review --from: show before doing", () => {
  it("prints the plan and asks, and writes nothing on anything but yes", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const no = await w.run(["--from", FILE], [row(), "not json"], { answers: ["no"] });

    expect(no.code).toBe(1);
    expect(no.prompts).toEqual(["Apply 1 decision as os:tester? Type yes to continue: "]);
    expect(no.stdout).toContain("Will apply 1 decision as os:tester:");
    expect(no.stdout).toContain("line 2: is not JSON");
    expect(no.stderr).toContain(
      "the decisions were not confirmed, so nothing was locked or written",
    );
    expect(await w.humans("r1")).toEqual([]);
    expect(w.lockOf("r1")).toBeNull();

    const yes = await w.run(["--from", FILE], [row()], { answers: ["Yes"] });
    expect(yes.code, yes.stderr).toBe(0);
    expect(await w.humans("r1")).toHaveLength(1);
  });

  it("with no terminal and no --yes, stops with the fix instead of deciding", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(["--from", FILE], [row()], { interactive: false });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("there is no terminal to ask on");
    expect(result.stderr).toContain("pass --yes once you have read the plan");
    expect(await w.humans("r1")).toEqual([]);
    expect(w.lockOf("r1")).toBeNull();
  });

  it("with --yes and no terminal, decides without asking", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(["--from", FILE, "--yes"], [row()], { interactive: false });
    expect(result.code, result.stderr).toBe(0);
    expect(await w.humans("r1")).toHaveLength(1);
  });

  it("does not ask when nothing would be applied", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(["--from", FILE], ["not json"]);
    expect(result.code).toBe(1);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain("Nothing was locked or written.");
  });

  it("--dry-run prints the plan and opens, locks, asks and logs nothing", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const before = await w.history("r1");

    const result = await w.run(["--from", FILE, "--dry-run"], [row(), row({ key: "ghost" })]);

    // Nothing is written, and the refusal of line 2 still ends the run in exit 1, so a script
    // can check a file before it applies it.
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("Would apply 1 decision as os:tester:");
    expect(result.stdout).toContain("line 2: listings ghost, scam: the worker has never answered");
    expect(result.stdout).toContain("Dry run: nothing was locked, decided or logged.");
    expect(result.prompts).toEqual([]);
    expect(w.calls).toEqual({ queue: 1, cards: 0, closed: 1 });
    expect(w.lockOf("r1")).toBeNull();
    expect(await w.history("r1")).toEqual(before);
    expect(await w.statusOf("r1")).toBe("needs_review");
  });

  it("--json prints the outcomes as one document and nothing else on stdout", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const clean = await w.run(["--from", FILE, "--yes", "--json"], [row()]);
    expect(clean.code, clean.stderr).toBe(0);
    expect(JSON.parse(clean.stdout)).toMatchObject({
      ok: true,
      reviewer: REVIEWER,
      dryRun: false,
      counts: { lines: 1, applied: 1, refused: 0, alreadyDecided: 0, notApplied: 0, left: 0 },
      malformed: [],
      rows: [
        {
          line: 1,
          source: "listings",
          key: "r1",
          question: "scam",
          decision: "yes",
          outcome: "applied",
        },
      ],
    });
    expect(clean.stdout.trim().split("\n")).toHaveLength(1);
    expect(clean.stderr).toContain("Will apply 1 decision");

    // A line refused: the same document under an error, ok false, exit 1, still one document.
    const w2 = world();
    await w2.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const refused = await w2.run(["--from", FILE, "--yes", "--json"], [row(), "nope"]);
    expect(refused.code).toBe(1);
    expect(refused.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      ok: false,
      error: { code: "rows-refused" },
      details: {
        ok: false,
        counts: { lines: 2, applied: 1, refused: 1 },
        malformed: [{ line: 2 }],
        rows: [{ line: 1, outcome: "applied" }],
      },
    });
  });

  it("--json with --dry-run says what would apply", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(["--from", FILE, "--dry-run", "--json"], [row()]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      dryRun: true,
      counts: { wouldApply: 1, applied: 0 },
      rows: [{ outcome: "would-apply" }],
    });
  });
});

describe("facetdb review --from: whatever happens, the card is let go", () => {
  it("lets go of the card and reports how far it got when deciding fails", async () => {
    const w = world({
      wrap: (service) => ({
        ...service,
        decide: () => Promise.reject(new Error("the database went away")),
      }),
    });
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(["--from", FILE, "--yes"], [row()]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "stopped by an error after 0 decisions were applied (those stand and are logged): the database went away",
    );
    expect(result.stderr).toContain("run the same file again");
    expect(w.lockOf("r1")).toBeNull();
    expect(w.calls.closed).toBe(w.calls.cards + w.calls.queue);
  });

  it("lets go of a lock taken by an open that then fails", async () => {
    const w = world({
      wrap: (service) => ({
        ...service,
        openKey: async (viewer, source, key) => {
          await w.queue.lock(source, key, viewer, w.clock.now());
          throw new Error("the record could not be read");
        },
      }),
    });
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(["--from", FILE, "--yes"], [row()]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the record could not be read");
    expect(w.lockOf("r1")).toBeNull();
  });

  it("keeps a run with --source to that source's rows", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(
      ["--from", FILE, "--yes", "--source", "listings"],
      [row({ source: "tickets" }), row()],
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("line 1: tickets is not the source --source listings names");
    expect(await w.humans("r1")).toHaveLength(1);
  });

  it("with --json an error is still one document, carrying what was applied", async () => {
    let decided = 0;
    const w = world({
      wrap: (service) => ({
        ...service,
        decide: (...args) => {
          decided += 1;
          return decided === 1
            ? service.decide(...args)
            : Promise.reject(new Error("the database went away"));
        },
      }),
    });
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "Fine car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(["--from", FILE, "--yes", "--json"], [row(), row({ key: "r2" })]);

    expect(result.code).toBe(1);
    const document = JSON.parse(result.stdout);
    expect(document).toMatchObject({
      ok: false,
      error: { code: "review-from-failed" },
      details: { counts: { applied: 1 }, rows: [{ line: 1, outcome: "applied" }] },
    });
    expect(w.lockOf("r1")).toBeNull();
    expect(w.lockOf("r2")).toBeNull();
  });

  it("stops between records on the stop signal: what was applied stands, the rest is not applied and never locked", async () => {
    const w = world({
      wrap: (service, stop) => ({
        ...service,
        decide: async (...args) => {
          const result = await service.decide(...args);
          stop.abort();
          return result;
        },
      }),
    });
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "Fine car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(["--from", FILE, "--yes"], [row(), row({ key: "r2" })]);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain(
      "line 2: listings r2, scam: yes: not applied: the command was asked to stop",
    );
    expect(result.stdout).toContain("Stopped early: run the same file again to carry on");
    expect(await w.humans("r1")).toHaveLength(1);
    expect(await w.humans("r2")).toEqual([]);
    expect(w.lockOf("r2")).toBeNull();
  });

  it("logs every decision under the reviewer, across records and questions", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    await w.seed("r2", "Fine car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(
      ["--from", FILE, "--yes"],
      [row(), row({ key: "r2", value: "no" }), row({ question: "team", value: "billing" })],
    );

    expect(result.code, result.stderr).toBe(0);
    const entries = [...(await w.humans("r1")), ...(await w.humans("r2"))];
    expect(entries).toHaveLength(3);
    expect(entries.every((entry) => entry.reviewer === REVIEWER)).toBe(true);
    expect(w.queue.rows).toEqual([]);
  });
});

describe("facetdb review --from: the invocation", () => {
  it("refuses a missing file and a directory with the fix, before anything opens", async () => {
    const w = world();
    const missing = await w.run(["--from", "nope.jsonl"], []);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain("there is no file at nope.jsonl");
    expect(missing.stderr).toContain(
      "facetdb export --source <name> --format jsonl --out decisions.jsonl",
    );

    const directory = await w.run(["--from", "a-directory"], []);
    expect(directory.code).toBe(2);
    expect(directory.stderr).toContain("is not a regular file");
    expect(w.calls).toEqual({ queue: 0, cards: 0, closed: 0 });
  });

  it("refuses the flags that narrow a walk through the queue, and --yes without --from", async () => {
    const w = world();
    const narrow = await w.run(["--from", FILE, "--below", "0.6", "--limit", "5"], [row()]);
    expect(narrow.code).toBe(2);
    expect(narrow.stderr).toContain("--below and --limit narrow the cards a person walks through");

    const question = await w.run(["--from", FILE, "--question", "scam"], [row()]);
    expect(question.code).toBe(2);
    expect(question.stderr).toContain("--question narrows the cards");

    const yes = await w.run(["--yes"], []);
    expect(yes.code).toBe(2);
    expect(yes.stderr).toContain("--yes confirms the decisions --from is about to apply");
    expect(w.calls).toEqual({ queue: 0, cards: 0, closed: 0 });
  });

  it("with --user and no terminal and nothing piped, says how the password gets in instead of asking", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(["--from", FILE, "--user", "maya", "--yes"], [row()], {
      interactive: false,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("--user maya needs the account's password");
    expect(result.stderr).toContain("pipe the password as the first line of standard input");
    expect(w.calls).toEqual({ queue: 0, cards: 0, closed: 0 });
    expect(await w.humans("r1")).toEqual([]);
  });

  it("with --user and a piped password, goes on to the door, which checks it", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(["--from", FILE, "--user", "maya", "--yes"], [row()], {
      interactive: false,
      answers: ["the password"],
    });
    // The fake door takes no password; the real one is tested on the store.
    expect(result.code, result.stderr).toBe(0);
    expect(w.calls.cards).toBe(1);
  });

  it("a dry run with --user asks for no password, even with no terminal", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run(["--from", FILE, "--user", "maya", "--dry-run"], [row()], {
      interactive: false,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain("no password was asked");
  });
});
