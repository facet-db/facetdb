import {
  type Answer,
  type AnswerEntry,
  createReviewService,
  type DecisionLog,
  type HumanEntry,
  isWithdrawal,
  type LogEntry,
  REVIEW_LOCK_MS,
  type RecordKey,
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
import { choice, facetdb, noul, type ProjectConfig, type score } from "../../config/index.ts";
import { runInProcess } from "../program.ts";
import type { KeyEvent, ReviewTerminal } from "../terminal.ts";
import { questionSetOf } from "./database.ts";
import { createReviewCommand, type ReviewDoor, type ReviewSource } from "./review.ts";

/**
 * `facetdb review` through the in-process runner with the real review service over the core's fakes
 * (a fake queue, a fake log, a fake table), a scripted key sequence and a fake clock: no real
 * terminal and no real timer. The queue, the lock and the log are the service's own; what is tested
 * here is what the command adds: the flags, the words, the keys.
 */

/** A terminal colour or style code, built so the pattern holds no control character. */
const ESCAPES = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

const SOURCE = "acme:listings";
const START = Date.parse("2026-11-05T10:00:00Z");
const REVIEWER = "os:tester";

const WORDS = {
  scam: "Is this listing likely a scam?",
  team: "Which team owns this?",
} as const;

function configOf(
  questions: Record<string, ReturnType<typeof noul | typeof choice | typeof score>> = {
    scam: noul(WORDS.scam),
    team: choice(WORDS.team, { billing: "Money questions", tech: "Technical questions" }),
  },
): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: "postgres://facetdb_worker:pw@localhost:5432/app",
        table: "listings",
        read: ["body"],
        questions,
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
}

const UNSURE_SCAM: Answer = { type: "noul", probability: 0.58 };
const SURE_BILLING: Answer = { type: "choice", top: "billing", probabilities: [0.9, 0.1] };
const UNSURE_TEAM: Answer = { type: "choice", top: "billing", probabilities: [0.6, 0.4] };

/**
 * A key, an idle wait (the clock moves by what was waited for), a line typed at a prompt, or a
 * probe: something that happens between two keys (another reviewer acting, a look at the queue).
 */
type Step =
  | string
  | { readonly idle: true }
  | { readonly typed: string | undefined }
  | { readonly probe: () => void | Promise<void> };

type Scripted = {
  readonly terminal: ReviewTerminal;
  readonly asked: string[];
  readonly waits: number[];
  opened: number;
  closed: number;
};

/** A terminal that plays `steps`: keys, an idle wait (the clock moves by what was waited), a typed line. */
function scripted(
  steps: readonly Step[],
  clock: FakeClock,
  look: { columns?: number; color?: boolean; interactive?: boolean } = {},
): Scripted {
  const left = [...steps];
  const seen: Scripted = {
    asked: [],
    waits: [],
    opened: 0,
    closed: 0,
    terminal: {
      interactive: () => look.interactive ?? true,
      columns: () => look.columns ?? 80,
      color: () => look.color ?? false,
      open: () => {
        seen.opened += 1;
        return {
          next: async (waitMs): Promise<KeyEvent> => {
            seen.waits.push(waitMs);
            let step = left.shift();
            while (typeof step === "object" && "probe" in step) {
              await step.probe();
              step = left.shift();
            }
            if (step === undefined) {
              return { kind: "end" };
            }
            if (typeof step === "string") {
              return { kind: "key", key: step };
            }
            if ("idle" in step) {
              clock.advance(waitMs);
              return { kind: "idle" };
            }
            throw new Error("the script typed a line where a key was read");
          },
          flush: () => undefined,
          line: async (question) => {
            seen.asked.push(question);
            let step = left.shift();
            // Something that happens while the reviewer types (time passing, another reviewer acting).
            while (typeof step === "object" && "probe" in step) {
              await step.probe();
              step = left.shift();
            }
            if (typeof step !== "object" || !("typed" in step)) {
              throw new Error("the script gave a key where a line was read");
            }
            return step.typed;
          },
          close: () => {
            seen.closed += 1;
          },
        };
      },
    },
  };
  return seen;
}

/** The queue, the log and the table of one source behind the real review service. */
function world(config: ProjectConfig = configOf()) {
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
  const door: ReviewDoor = {
    queue: () => {
      calls.queue += 1;
      return Promise.resolve({
        reviewer: REVIEWER,
        queue,
        sources,
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
        service,
        close: () => {
          calls.closed += 1;
          return Promise.resolve();
        },
      });
    },
  };

  /** As the worker leaves a record: answered, logged, written needs_review, its card queued. */
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
    await queue.upsert({
      source: SOURCE,
      ...reviewEntryOf({ key, stateHash: hash, decisions, answers, since: entry.at }),
    });
    clock.advance(1_000);
    return hash;
  }

  async function run(
    argv: readonly string[],
    steps: readonly Step[] = [],
    look: { columns?: number; color?: boolean; interactive?: boolean; stopped?: boolean } = {},
  ) {
    const terminal = scripted(steps, clock, look);
    const stop = new AbortController();
    if (look.stopped === true) {
      stop.abort();
    }
    const result = await runInProcess(
      ["review", ...argv],
      {
        projectDir: "/work/acme",
        env: {},
        loadConfig: () => Promise.resolve(config),
        connect: () => {
          throw new Error("the fake door opens no database connection");
        },
        clock,
        osUser: () => "tester",
        stopSignal: () => stop.signal,
        terminal: terminal.terminal,
      },
      [createReviewCommand(door)],
    );
    return { ...result, terminal, stop };
  }

  const history = async (key: RecordKey): Promise<readonly LogEntry[]> => log.history(key);
  const humans = async (key: RecordKey): Promise<HumanEntry[]> =>
    (await history(key)).filter((entry): entry is HumanEntry => entry.kind === "human");

  return { clock, db, connector, log, queue, service, calls, seed, run, history, humans };
}

const lockOf = (w: ReturnType<typeof world>, key: RecordKey) =>
  w.queue.rows.find((row) => row.key === key)?.lock;

describe("facetdb review: the invocation", () => {
  it("stops with the fix when there is no terminal and no --json, before anything opens", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run([], [], { interactive: false });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("facetdb review needs a terminal");
    expect(result.stderr).toContain("add --json to print the queue");
    expect(w.calls).toEqual({ queue: 0, cards: 0, closed: 0 });
    expect(result.terminal.opened).toBe(0);
  });

  it.each(["0", "1", "-0.2", "1.5", "abc", "60%", ""])(
    "refuses --below %j with the fix, as a bad invocation",
    async (below) => {
      const w = world();
      const result = await w.run(["--below", below]);
      expect(result.code).toBe(2);
      expect(result.stderr).toContain("--below takes a number between 0 and 1");
      expect(result.stderr).toContain("fix: pass --below 0.6");
      expect(w.calls.queue).toBe(0);
    },
  );

  it.each(["0", "-3", "1.5", "many"])("refuses --limit %j with the fix", async (limit) => {
    const result = await world().run(["--limit", limit]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--limit takes a whole number of cards");
  });

  it("refuses a name no account can have, an unknown source and an unknown question", async () => {
    const w = world();
    const user = await w.run(["--user", "Maya!"]);
    expect(user.code).toBe(2);
    expect(user.stderr).toContain('"Maya!" is not a name a reviewer account can have');

    const source = await w.run(["--source", "nope"]);
    expect(source.code).toBe(2);
    expect(source.stderr).toContain('the config has no source named "nope"');
    expect(source.stderr).toContain("pass one of: listings, tickets");

    const question = await w.run(["--source", "listings", "--question", "nope"]);
    expect(question.code).toBe(2);
    expect(question.stderr).toContain('has no question named "nope"');
    expect(question.stderr).toContain("pass one of: scam, team");
    expect(w.calls).toEqual({ queue: 0, cards: 0, closed: 0 });
  });

  it("says what a dry run would do and opens nothing", async () => {
    const w = world();
    const result = await w.run(["--dry-run", "--source", "listings", "--below", "0.6"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Dry run: would show the cards of listings");
    expect(result.stdout).toContain("under 60% sure");
    expect(result.stdout).toContain("as os:tester");
    expect(w.calls).toEqual({ queue: 0, cards: 0, closed: 0 });
  });
});

describe("facetdb review --json: the queue", () => {
  it("prints the cards with the model's figures in words beside the numbers, needing no terminal", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "A flat", { scam: UNSURE_SCAM, team: UNSURE_TEAM });

    const result = await w.run(["--json"], [], { interactive: false });

    expect(result.code).toBe(0);
    const document = JSON.parse(result.stdout) as {
      ok: boolean;
      reviewer: string;
      count: number;
      cards: {
        source: string;
        key: string;
        waiting: string;
        skippedByYou: boolean;
        open: { question: string; says: string; figure: number }[];
      }[];
    };
    expect(document.ok).toBe(true);
    expect(document.reviewer).toBe(REVIEWER);
    expect(document.count).toBe(2);
    expect(document.cards[0]).toMatchObject({
      source: "listings",
      key: "r1",
      skippedByYou: false,
      open: [{ question: "scam", says: "58% likely yes", figure: 0.58 }],
    });
    expect(document.cards[1]?.open.map((open) => open.question)).toEqual(["scam", "team"]);
    // The model's figure for a choice is its confidence in the top answer (billing at 60 to 40).
    expect(document.cards[1]?.open[1]?.says).toBe("20% sure");
    expect(document.cards[1]?.open[1]?.figure).toBeCloseTo(0.2, 10);
    expect(result.terminal.opened).toBe(0);
    expect(w.calls.closed).toBe(1);
    // Nothing is locked by looking.
    expect(w.queue.rows.every((row) => row.lock === null)).toBe(true);
  });

  it("narrows by --question, --below (strictly under, for that question) and --limit", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "A flat", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    await w.seed("r3", "A boat", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    const keys = async (argv: readonly string[]) => {
      const result = await w.run([...argv, "--json"]);
      return (JSON.parse(result.stdout) as { cards: { key: string }[] }).cards.map(
        (card) => card.key,
      );
    };

    expect(await keys(["--question", "team"])).toEqual(["r2", "r3"]);
    // The scam figure is 0.58 and the team figure 0.2: strictly under, for any open question...
    expect(await keys(["--below", "0.19"])).toEqual([]);
    expect(await keys(["--below", "0.21"])).toEqual(["r2", "r3"]);
    expect(await keys(["--below", "0.58"])).toEqual(["r2", "r3"]);
    expect(await keys(["--below", "0.6"])).toEqual(["r1", "r2", "r3"]);
    // ...or for the question named.
    expect(await keys(["--below", "0.6", "--question", "scam"])).toEqual(["r1", "r2", "r3"]);
    expect(await keys(["--below", "0.58", "--question", "scam"])).toEqual([]);
    expect(await keys(["--below", "0.19", "--question", "team"])).toEqual([]);
    expect(await keys(["--below", "0.21", "--question", "team"])).toEqual(["r2", "r3"]);
    expect(await keys(["--limit", "2"])).toEqual(["r1", "r2"]);
    expect(await keys(["--source", "listings", "--limit", "1"])).toEqual(["r1"]);
  });

  it("lists a card the reviewer skipped after the others, and marks it", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.run([], ["s", "q"]);

    const result = await w.run(["--json"]);

    const cards = (JSON.parse(result.stdout) as { cards: { key: string; skippedByYou: boolean }[] })
      .cards;
    expect(cards.map((card) => [card.key, card.skippedByYou])).toEqual([
      ["r2", false],
      ["r1", true],
    ]);
  });
});

describe("facetdb review: a card on the terminal", () => {
  it("shows the state, the open question with the model's answer in words, the decided one greyed, and the lock", async () => {
    const w = world();
    await w.seed("r1", "Cheap car, wire only", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run([], ["q"]);

    expect(result.code).toBe(0);
    const text = result.stdout;
    expect(text).toContain("listings r1\nWaiting less than a minute, since 2026-11-05 10:00 UTC.");
    expect(text).toContain("Locked for you, 10:00 left");
    expect(text).toContain("body  Cheap car, wire only");
    expect(text).toContain("> scam  Yes or no · next to answer");
    expect(text).toContain("Is this listing likely a scam?");
    expect(text).toContain("The model says 58% likely yes.");
    expect(text.replace(/\s+/g, " ")).toContain(
      "It decides on its own at 70% or more, or 30% or less.",
    );
    expect(text).toContain("y yes · n no");
    expect(text).toContain("team decided: billing (not waiting for you)");
    // The decided question is not asked again.
    expect(text).not.toContain("Which team owns this?");
  });

  it("never shows a figure without its words", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: UNSURE_TEAM });

    const result = await w.run([], ["q"]);

    const figures = result.stdout.split("\n").filter((line) => /\d+%/.test(line));
    expect(figures.length).toBeGreaterThan(0);
    for (const line of figures) {
      // Every line with a percentage names what it is the percentage of.
      expect(line.replace(/[\d.%\s]/g, ""), line).not.toBe("");
      expect(line.trim(), line).not.toMatch(/^[\d.]+%?$/);
    }
    expect(result.stdout).toContain("The model leans billing, 20% sure.");
    expect(result.stdout).toContain("billing  60% chance  the model's pick");
    expect(result.stdout).toContain("tech     40% chance");
    expect(result.stdout).not.toMatch(/0\.\d/);
  });

  it("lays out JSON as key and value lines and wraps long text to the terminal's width", async () => {
    const w = world();
    const json = JSON.stringify({
      plan: "pro",
      orders: 14,
      address: { city: "Oslo", zip: "0150" },
    });
    await w.seed("r1", `${json}`, { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed(
      "r2",
      "I was charged twice for order 5521 and I want the second charge back today please",
      { scam: UNSURE_SCAM, team: SURE_BILLING },
    );

    const result = await w.run([], ["s", "q"], { columns: 40 });

    const lines = result.stdout.split("\n");
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    expect(at("body  plan     pro")).toBeGreaterThan(-1);
    expect(lines[at("body  plan     pro") + 1]).toBe("        orders   14");
    expect(lines[at("body  plan     pro") + 2]).toBe("        address");
    expect(lines[at("body  plan     pro") + 3]).toBe("          city  Oslo");
    // Long text: broken at spaces, aligned under its label, within 40 columns.
    const wrapped = lines.slice(at("body  I was charged"), at("body  I was charged") + 4);
    expect(wrapped.join(" ").replace(/\s+/g, " ")).toContain(
      "I was charged twice for order 5521 and I want the second charge",
    );
    for (const line of lines) {
      expect([...line].length, line).toBeLessThanOrEqual(40);
    }
    expect(wrapped[1]?.startsWith("        ")).toBe(true);
  });

  it("neutralises control characters and escape sequences in a record's text", async () => {
    const w = world();
    await w.seed("r1", "hello \u001b[2J\u001b]0;pwned\u0007 world ‮evil", {
      scam: UNSURE_SCAM,
      team: SURE_BILLING,
    });

    const result = await w.run([], ["q"]);

    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\u0007");
    expect(result.stdout).not.toContain("‮");
    expect(result.stdout).toContain("hello �[2J�]0;pwned� world �evil");
  });

  it("uses colour only when the terminal does, and says the same words either way", async () => {
    const draw = async (color: boolean) => {
      const w = world();
      await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
      return (await w.run([], ["q"], { color })).stdout;
    };
    const plain = await draw(false);
    const colored = await draw(true);

    expect(plain).not.toContain("\u001b[");
    expect(colored).toContain("\u001b[");
    // Colour repeats the words and adds none.
    expect(colored.replace(ESCAPES, "")).toBe(plain);
  });
});

describe("facetdb review: the keys", () => {
  it("y decides the yes-or-no question as os:<name>, logs it, writes the record and moves to the next card", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run([], ["y", "q"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("scam: yes. Written to the record and logged for os:tester.");
    expect(result.stdout).toContain("Every question on this card is decided: the record is done.");
    expect(result.stdout).toContain("listings r2");
    const [entry] = await w.humans("r1");
    expect(entry).toMatchObject({ question: "scam", value: true, reviewer: REVIEWER, version: 3 });
    expect((await w.connector.current(["r1"])).get("r1")).toMatchObject({ status: "done" });
    // r1 left the queue; r2 was held and was let go of on quit.
    expect(w.queue.rows.map((row) => row.key)).toEqual(["r2"]);
    expect(lockOf(w, "r2")).toBeNull();
    expect(result.stdout).toContain("Done: 1 question decided on 2 cards, 0 skipped.");
  });

  it("n decides no; a number picks a choice option; each answer is one decision with the card kept for the rest", async () => {
    const w = world();
    await w.seed("r1", "A flat", { scam: UNSURE_SCAM, team: UNSURE_TEAM });

    const result = await w.run([], ["n", "2"]);

    expect(result.stdout).toContain("scam: no. Written to the record");
    expect(result.stdout).toContain("One question is still open on this card.");
    // The card is drawn again with the first question greyed and the second next to answer.
    expect(result.stdout).toContain("scam decided: no (not waiting for you)");
    expect(result.stdout).toContain("> team  Pick one · next to answer");
    expect(result.stdout).toContain("team: tech. Written to the record");
    expect((await w.humans("r1")).map((entry) => [entry.question, entry.value])).toEqual([
      ["scam", false],
      ["team", "tech"],
    ]);
    expect(w.queue.rows).toEqual([]);
  });

  it("answers the question the key does not fit with what to press, and decides nothing", async () => {
    const w = world();
    await w.seed("r1", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run([], ["1", "x", "q"]);

    expect(result.stdout).toContain("This is a yes-or-no question: press y for yes or n for no.");
    expect(result.stdout).toContain("That key does nothing here.");
    expect(await w.humans("r1")).toEqual([]);

    const w2 = world();
    await w2.seed("r1", "A flat", { scam: UNSURE_SCAM, team: UNSURE_TEAM });
    // The first open question is the noul scam; decide it, then y is wrong for the choice.
    const second = await w2.run([], ["n", "y", "3", "q"]);
    expect(second.stdout).toContain("team is not a yes-or-no question: press 1 to 2 pick");
    expect(second.stdout).toContain("There is no option 3: pick 1 to 2.");
    expect((await w2.humans("r1")).map((entry) => entry.question)).toEqual(["scam"]);
  });

  it("s skips the card for this reviewer and releases its lock; skipped cards do not come round again", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run([], ["s", "s"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Skipped. The card goes behind the rest for you");
    expect(result.stdout).toContain("Done: 0 questions decided on 2 cards, 2 skipped.");
    expect(result.terminal.closed).toBe(1);
    expect(w.queue.rows.map((row) => [row.key, row.lock, row.skippedBy])).toEqual([
      ["r1", null, [REVIEWER]],
      ["r2", null, [REVIEWER]],
    ]);
  });

  it("u takes the last decision back: the card returns to the queue and is shown again", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run([], ["y", "u", "u", "q"]);

    expect(result.stdout).toContain("Took back your last decision. It is logged as withdrawn.");
    // Back on r1's card, then a second u has nothing left to take back.
    expect(result.stdout.match(/listings r1/g)?.length).toBe(2);
    expect(result.stdout).toContain("Nothing to undo: only your last decision of this session");
    const humans = await w.humans("r1");
    expect(humans.map((entry) => [entry.reviewer, isWithdrawal(entry.value)])).toEqual([
      [REVIEWER, false],
      [REVIEWER, true],
    ]);
    expect((await w.connector.current(["r1"])).get("r1")).toMatchObject({
      status: "needs_review",
    });
    // r2 was opened (and locked) meanwhile: undo let it go when it brought r1 back.
    expect(lockOf(w, "r2")).toBeNull();
    expect(w.queue.rows.map((row) => row.key)).toEqual(["r1", "r2"]);
  });

  it("u with nothing decided says so and keeps the card", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run([], ["u", "q"]);
    expect(result.stdout).toContain("Nothing to undo: only your last decision of this session");
    expect(lockOf(w, "r1")).toBeNull();
  });

  it("q quits and releases the lock; so do ctrl-c and the end of the input", async () => {
    for (const ending of [["q"], ["ctrl-c"], ["ctrl-d"], []]) {
      const w = world();
      await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
      const result = await w.run([], ending);
      expect(result.code).toBe(0);
      expect(lockOf(w, "r1"), ending.join()).toBeNull();
      expect(result.terminal.closed).toBe(1);
      expect(w.calls.closed).toBe(1);
    }
  });

  it("a stop signal ends the review and lets go of the card", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const result = await w.run([], ["y"], { stopped: true });

    expect(result.code).toBe(0);
    expect(lockOf(w, "r1")).toBeNull();
    expect(await w.humans("r1")).toEqual([]);
  });

  it(": takes a note with its own line prompt and sends it with the next decision only", async () => {
    const w = world();
    await w.seed("r1", "A flat", { scam: UNSURE_SCAM, team: UNSURE_TEAM });

    const result = await w.run([], [":", { typed: "  seller is verified " }, "n", "1"]);

    expect(result.terminal.asked).toEqual(["Note for the log (empty to clear): "]);
    expect(result.stdout).toContain("Note kept: it goes with your next decision on this card.");
    expect(result.stdout).toContain("Note for your next decision: seller is verified");
    const [first, second] = await w.humans("r1");
    expect(first).toMatchObject({ question: "scam", note: "seller is verified" });
    expect(second?.note).toBeUndefined();
  });

  it(": with an empty line clears the note, and a cancelled line takes none", async () => {
    const w = world();
    await w.seed("r1", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });

    const result = await w.run(
      [],
      [":", { typed: "first" }, ":", { typed: "" }, ":", { typed: undefined }, "y"],
    );

    expect(result.stdout).toContain("Note cleared.");
    expect(result.stdout).toContain("No note taken.");
    expect((await w.humans("r1"))[0]?.note).toBeUndefined();
  });

  it("takes two digits for ten options or more: 12, then 1 with enter, then 2 at once", async () => {
    const options = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [`opt${index + 1}`, `Option ${index + 1}`]),
    );
    const w = world(configOf({ topic: choice("Which topic?", options) }));
    const unsure: Answer = {
      type: "choice",
      top: "opt1",
      probabilities: [0.2, 0.18, 0.1, 0.1, 0.08, 0.08, 0.06, 0.06, 0.05, 0.04, 0.03, 0.02],
    };
    await w.seed("r1", "one", { topic: unsure });
    await w.seed("r2", "two", { topic: unsure });
    await w.seed("r3", "three", { topic: unsure });

    const result = await w.run([], ["1", "2", "1", "enter", "2", "q"]);

    expect(result.stdout).toContain("topic: opt12. Written to the record");
    expect(result.stdout).toContain("topic: opt1. Written to the record");
    expect(result.stdout).toContain("topic: opt2. Written to the record");
    expect(result.stdout).toContain(
      "1: press another digit to pick 10 or more, or enter to pick 1.",
    );
    expect((await w.humans("r1"))[0]?.value).toBe("opt12");
    expect((await w.humans("r2"))[0]?.value).toBe("opt1");
    expect((await w.humans("r3"))[0]?.value).toBe("opt2");
  });

  describe("a first digit belongs to the card it was typed on", () => {
    async function twelveOptions() {
      const options = Object.fromEntries(
        Array.from({ length: 12 }, (_, index) => [`opt${index + 1}`, `Option ${index + 1}`]),
      );
      const w = world(configOf({ topic: choice("Which topic?", options) }));
      const unsure: Answer = {
        type: "choice",
        top: "opt1",
        probabilities: [0.2, 0.18, 0.1, 0.1, 0.08, 0.08, 0.06, 0.06, 0.05, 0.04, 0.03, 0.02],
      };
      await w.seed("r1", "one", { topic: unsure });
      await w.seed("r2", "two", { topic: unsure });
      // bob takes r1 once the reviewer's lease has lapsed: the next renewal moves the session on.
      const bobTakesR1 = async () => {
        w.clock.advance(REVIEW_LOCK_MS + 1);
        await w.queue.lock(SOURCE, "r1", "bob", w.clock.now());
      };
      return { w, bobTakesR1 };
    }

    it("does not turn a 2 on the next card into option 12", async () => {
      const { w, bobTakesR1 } = await twelveOptions();

      // 1 on r1 waits for a second digit; r1 is lost; 2 on r2 is option 2, not 12.
      const result = await w.run([], ["1", { probe: bobTakesR1 }, { idle: true }, "2", "q"]);

      expect(result.stdout).toContain("bob holds this card now");
      expect((await w.humans("r1")).length).toBe(0);
      expect((await w.humans("r2")).map((entry) => entry.value)).toEqual(["opt2"]);
    });

    it("does not let enter on the next card pick the first digit's option", async () => {
      const { w, bobTakesR1 } = await twelveOptions();

      const result = await w.run([], ["1", { probe: bobTakesR1 }, { idle: true }, "enter", "q"]);

      expect(result.stdout).toContain("bob holds this card now");
      expect(await w.humans("r2")).toEqual([]);
    });
  });

  it("renews the lock when the note prompt closes, so a long note is not lost", async () => {
    const w = world();
    await w.seed("r1", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const leases: number[] = [];

    const result = await w.run(
      [],
      [
        ":",
        { probe: () => w.clock.advance(REVIEW_LOCK_MS - 1_000) },
        { typed: "a very long note" },
        {
          probe: () => {
            leases.push(lockOf(w, "r1")?.until.getTime() ?? 0);
          },
        },
        "y",
      ],
    );

    // Nine minutes and 59 seconds into the note, the lease was renewed to ten full minutes from then.
    expect(leases).toEqual([w.clock.now() + REVIEW_LOCK_MS]);
    expect((await w.humans("r1"))[0]).toMatchObject({ note: "a very long note", value: true });
    expect(result.stdout).not.toContain("Not saved");
  });

  it("says at once, not at the decision, that the card was lost while a note was typed", async () => {
    const w = world();
    await w.seed("r1", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const bobTakes = async () => {
      w.clock.advance(REVIEW_LOCK_MS + 1);
      await w.queue.lock(SOURCE, "r1", "bob", w.clock.now());
    };

    const result = await w.run([], [":", { probe: bobTakes }, { typed: "too late" }, "y"]);

    expect(result.stdout).toContain("bob holds this card now, so it is no longer yours.");
    expect(result.stdout).toContain("The note was not kept.");
    expect(result.stdout).not.toContain("Note kept");
    expect(await w.humans("r1")).toEqual([]);
  });

  describe("when the queue runs out after a decision", () => {
    it("offers u once more, and u brings the last card back", async () => {
      const w = world();
      await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });

      const result = await w.run([], ["y", "u", "q"]);

      expect(result.stdout.replace(/\s+/g, " ")).toContain(
        "That is the end of this review. Press u to take back your last decision, or q to finish.",
      );
      expect(result.stdout).toContain("Took back your last decision");
      // r1 is on the screen again, undecided, and let go of on q.
      expect(result.stdout.match(/listings r1/g)?.length).toBe(2);
      const humans = await w.humans("r1");
      expect(humans.map((entry) => isWithdrawal(entry.value))).toEqual([false, true]);
      expect((await w.connector.current(["r1"])).get("r1")).toMatchObject({
        status: "needs_review",
      });
      expect(lockOf(w, "r1")).toBeNull();
    });

    it("keeps the decision when the reviewer quits, ends the input or presses another key", async () => {
      for (const keys of [["y", "q"], ["y"], ["y", "x", "q"]]) {
        const w = world();
        await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
        const result = await w.run([], keys);
        expect(result.code, keys.join()).toBe(0);
        expect(result.stdout).toContain("Press u to take back your last decision");
        expect((await w.humans("r1")).length).toBe(1);
        expect(result.stdout).toContain("Done: 1 question decided on 1 card, 0 skipped.");
        if (keys.includes("x")) {
          // Said twice: with the end of the review, and again for the key that did nothing.
          expect(result.stdout.match(/Press u to take back your last decision/g)?.length).toBe(2);
        }
      }
    });

    it("offers nothing when nothing was decided, or the decision was already taken back", async () => {
      const empty = await world().run([], []);
      expect(empty.stdout).not.toContain("Press u");

      const w = world();
      await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
      await w.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
      const taken = await w.run([], ["y", "u", "s", "s"]);
      // r1 decided, taken back, then both cards skipped: nothing left to undo at the end.
      expect(taken.stdout).not.toContain("That is the end of this review");
    });

    it("also offers it when --limit ends the review", async () => {
      const w = world();
      for (const key of ["r1", "r2"]) {
        await w.seed(key, `body ${key}`, { scam: UNSURE_SCAM, team: SURE_BILLING });
      }

      const result = await w.run(["--limit", "1"], ["y", "u", "q"]);

      expect(result.stdout).toContain("That is the end of this review");
      expect(result.stdout).toContain("Took back your last decision");
    });
  });

  it("cleans invisible and direction-changing characters from a record and from a lock holder's name", async () => {
    const invisible = [0x200b, 0x200e, 0x200f, 0x061c, 0x2028, 0x2029, 0x2060, 0xfeff, 0x202e];
    const chars = invisible.map((code) => String.fromCharCode(code)).join("");
    const w = world();
    await w.seed("r1", `a${chars}b`, { scam: UNSURE_SCAM, team: SURE_BILLING });
    const bobTakes = async () => {
      w.clock.advance(REVIEW_LOCK_MS + 1);
      await w.queue.lock(SOURCE, "r1", `bo${chars}b`, w.clock.now());
    };

    const result = await w.run([], [{ probe: bobTakes }, "y"]);

    for (const code of invisible) {
      expect(result.stdout, code.toString(16)).not.toContain(String.fromCharCode(code));
    }
    expect(result.stdout).toContain(`a${"�".repeat(invisible.length)}b`);
    expect(result.stdout).toContain(`bo${"�".repeat(invisible.length)}b holds this card until`);
  });

  it("stops at --limit cards", async () => {
    const w = world();
    for (const key of ["r1", "r2", "r3"]) {
      await w.seed(key, `body ${key}`, { scam: UNSURE_SCAM, team: SURE_BILLING });
    }

    const result = await w.run(["--limit", "2"], ["y", "y", "y"]);

    expect(result.stdout).toContain("Done: 2 questions decided on 2 cards, 0 skipped.");
    expect(w.queue.rows.map((row) => row.key)).toEqual(["r3"]);
  });

  it("narrows the cards it opens by --source, --question and --below", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "A flat", { scam: UNSURE_SCAM, team: UNSURE_TEAM });

    const none = await w.run(["--below", "0.15"], ["y"]);
    expect(none.stdout).toContain(
      "Nothing to review where the model is under 15% sure: no card is waiting for you.",
    );
    const teams = await w.run(["--question", "team", "--source", "listings"], ["q"]);
    expect(teams.stdout).toContain("listings r2");
    expect(teams.stdout).not.toContain("listings r1");
  });

  it("renews the lock every minute while the card stays open, on the injected clock", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const opened = w.clock.now();
    const leases: (number | undefined)[] = [];
    const lease = () => {
      leases.push(lockOf(w, "r1")?.until.getTime());
    };

    const result = await w.run([], [{ probe: lease }, { idle: true }, { probe: lease }, "q"]);

    // The session waits for a key for at most the time left until the next renewal: a minute.
    expect(result.terminal.waits).toEqual([60_000, 60_000]);
    // Opened with ten minutes; a minute later the lease is ten minutes from then.
    expect(leases).toEqual([opened + REVIEW_LOCK_MS, opened + 60_000 + REVIEW_LOCK_MS]);
    expect(lockOf(w, "r1")).toBeNull();
  });

  it("moves on to the next card when a renewal finds the card is no longer the reviewer's", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    await w.seed("r2", "A flat", { scam: UNSURE_SCAM, team: SURE_BILLING });
    // The reviewer's lease lapses and bob takes the card.
    const bobTakes = async () => {
      w.clock.advance(REVIEW_LOCK_MS + 1);
      await w.queue.lock(SOURCE, "r1", "bob", w.clock.now());
    };

    const result = await w.run([], [{ probe: bobTakes }, { idle: true }, "q"]);

    expect(result.stdout).toContain(
      "bob holds this card now, so it is no longer yours. Moving on to the next one.",
    );
    expect(result.stdout).toContain("listings r2");
    expect(lockOf(w, "r1")?.by).toBe("bob");
    expect(lockOf(w, "r2")).toBeNull();
  });

  it("says a decision was not saved when another reviewer holds the card", async () => {
    const w = world();
    await w.seed("r1", "Cheap car", { scam: UNSURE_SCAM, team: SURE_BILLING });
    const bobTakes = async () => {
      w.clock.advance(REVIEW_LOCK_MS + 1);
      await w.queue.lock(SOURCE, "r1", "bob", w.clock.now());
    };

    const result = await w.run([], [{ probe: bobTakes }, "y"]);

    expect(result.stdout).toContain("Not saved: bob holds this card until");
    expect(await w.humans("r1")).toEqual([]);
  });
});
