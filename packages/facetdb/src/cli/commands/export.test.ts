import { FakeClock } from "@facetdb/core/testing";
import { createStore, type SqlConnect, type Store, sourceIdOf } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld, TEST_SECRET } from "@facetdb/postgres/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig, score } from "../../config/index.ts";
import { runInProcess } from "../program.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb export` through the in-process runner on PGlite: both formats on a seeded store, oldest
 * first, a human decision row, the dry run, the unknown source, a log of 1,000 rows read in pages,
 * and a CSV whose values hold quotes, commas and line breaks.
 */

// The source's own database is never opened: this URL has no server behind it.
const SOURCE_URL = "postgres://facetdb_worker:worker-password@source.invalid:5432/app";
/** The project `projectRef` derives from `PROJECT_DIR`, and the id the log is kept under. */
const PROJECT_DIR = "/work/listings-app";
const LOG_ID = sourceIdOf("listings-app", "listings");

const CONFIG: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: SOURCE_URL,
      table: "listings",
      read: ["id", "title"],
      questions: {
        is_scam: noul("Is this listing a scam?"),
        category: choice("Which category is this listing?", { car: "A car", flat: "A flat" }),
        quality: score("How good is the photo?", ["poor", "fine", "great"]),
      },
    },
    {
      name: "tickets",
      database: SOURCE_URL,
      table: "tickets",
      read: ["id", "body"],
      questions: { urgent: noul("Is this urgent?") },
    },
  ],
});

let world: PgliteWorld;
let store: Store;
/** How many rows each `page` call was asked for, in order. */
let pageLimits: number[];
/** The files `--out` wrote. */
let files: Map<string, string>;

beforeEach(async () => {
  world = await createPgliteWorld();
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new FakeClock(0) });
  pageLimits = [];
  files = new Map();
});

afterEach(async () => {
  await store.close();
  await world.close();
});

function run(argv: readonly string[], env: Record<string, string> = defaultEnv()) {
  const connect: SqlConnect = world.connect;
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env,
      loadConfig: () => Promise.resolve(CONFIG),
      connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: () =>
        Promise.resolve({
          ...store,
          log: (sourceId: string) => {
            const log = store.log(sourceId);
            return {
              ...log,
              page: (after: number | undefined, limit: number) => {
                pageLimits.push(limit);
                return log.page(after, limit);
              },
            };
          },
          close: () => Promise.resolve(),
        }),
      workspace: {
        exists: () => Promise.resolve(false),
        write: (path, text) => {
          files.set(path, text);
          return Promise.resolve();
        },
        hasClaudeCommand: () => false,
      },
    },
    COMMANDS,
  );
}

function defaultEnv(): Record<string, string> {
  return { DATABASE_URL: "postgres://localhost:5432/app" };
}

function setOf(config: ProjectConfig) {
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has no source");
  }
  return questionSetOf(config, source);
}

/** r1 answered under v1, answered again, and decided by a person; r2 answered once. */
async function seed(): Promise<void> {
  await store.questionSets.record(LOG_ID, setOf(CONFIG));
  const log = store.log(LOG_ID);
  await log.appendAnswer({
    kind: "answer",
    key: "r2",
    version: 1,
    model: "jev-1.14.0",
    stateHash: "hash-r2",
    answers: {
      is_scam: { type: "noul", probability: 0.99 },
      category: { type: "choice", top: "flat", probabilities: [0.1, 0.9] },
      quality: { type: "score", probabilities: [0.1, 0.2, 0.7], confidence: 0.8, expected: 2.6 },
    },
    usage: { inputTokens: 100, outputTokens: 5 },
    at: new Date("2026-10-28T14:02:00Z"),
  });
  await log.appendAnswer({
    kind: "answer",
    key: "r1",
    version: 1,
    model: "jev-1.14.0",
    stateHash: "hash-r1",
    answers: {
      is_scam: { type: "noul", probability: 0.58 },
      category: { type: "choice", top: "car", probabilities: [0.95, 0.05] },
      quality: { type: "score", probabilities: [0.6, 0.3, 0.1], confidence: 0.4, expected: 0.5 },
    },
    usage: { inputTokens: 100, outputTokens: 5 },
    at: new Date("2026-10-29T09:30:00Z"),
  });
  await log.appendHuman({
    kind: "human",
    key: "r1",
    question: "is_scam",
    value: false,
    reviewer: "ana@example.com",
    note: "seller is verified",
    stateHash: "hash-r1",
    version: 1,
    at: new Date("2026-10-30T16:45:00Z"),
  });
}

/** Splits CSV text per RFC 4180 into records of fields, so a test checks the quoting by parsing it. */
function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quoted) {
      if (char === '"' && text.charAt(at + 1) === '"') {
        field += '"';
        at += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      record.push(field);
      field = "";
    } else if (char === "\r" && text.charAt(at + 1) === "\n") {
      record.push(field);
      records.push(record);
      field = "";
      record = [];
      at += 1;
    } else {
      field += char;
    }
  }
  return records;
}

describe("facetdb export", () => {
  it("writes the log as JSONL, oldest first, answers nested per question and a human row beside them", async () => {
    await seed();

    const result = await run(["export", "--source", "listings"]);

    expect(result.code).toBe(0);
    const rows = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(rows.map((row) => [row["time"], row["kind"], row["record_key"]])).toEqual([
      ["2026-10-28T14:02:00.000Z", "answer", "r2"],
      ["2026-10-29T09:30:00.000Z", "answer", "r1"],
      ["2026-10-30T16:45:00.000Z", "human", "r1"],
    ]);
    expect(rows[1]).toMatchObject({
      version: 1,
      model: "jev-1.14.0",
      state_hash: "hash-r1",
      answers: {
        // 58% is between the default thresholds of a noul with stakes "medium": it needs review.
        is_scam: { type: "noul", probability: 0.58, decision: "needs review" },
        category: { type: "choice", value: "car", probability: 0.95, decision: "car" },
        quality: { type: "score", value: "poor", confidence: 0.4 },
      },
    });
    expect(rows[2]).toEqual({
      time: "2026-10-30T16:45:00.000Z",
      kind: "human",
      record_key: "r1",
      version: 1,
      state_hash: "hash-r1",
      question: "is_scam",
      value: "no",
      decision: "no",
      decided_by: "ana@example.com",
      note: "seller is verified",
    });
  });

  it("writes the log as CSV, one line per question per log row, with the header first", async () => {
    await seed();

    const result = await run(["export", "--source", "listings", "--format", "csv"]);

    expect(result.code).toBe(0);
    const records = parseCsv(result.stdout);
    expect(records[0]).toEqual([
      "time",
      "kind",
      "record_key",
      "version",
      "model",
      "question",
      "value",
      "probability",
      "confidence",
      "decision",
      "decided_by",
    ]);
    // Two answer rows of three questions, then one human row.
    expect(records).toHaveLength(1 + 3 + 3 + 1);
    expect(records.slice(1, 4).map((record) => [record[2], record[5]])).toEqual([
      ["r2", "is_scam"],
      ["r2", "category"],
      ["r2", "quality"],
    ]);
    const scam = records[1];
    expect(scam?.[7]).toBe("0.99");
    expect(scam?.[9]).toBe("yes");
    expect(records[6]?.slice(0, 2)).toEqual(["2026-10-29T09:30:00.000Z", "answer"]);
    expect(records.at(-1)).toEqual([
      "2026-10-30T16:45:00.000Z",
      "human",
      "r1",
      "1",
      "",
      "is_scam",
      "no",
      "",
      "",
      "no",
      "ana@example.com",
    ]);
    expect(result.stdout).toContain("\r\n");
  });

  it("never breaks a CSV line on a quote, a comma or a newline inside a value", async () => {
    await store.log(LOG_ID).appendHuman({
      kind: "human",
      key: 'a "quoted", key\nwith a break',
      question: "category",
      value: 'flat, "big"\r\nstudio',
      reviewer: "o'brien, ana",
      stateHash: "h",
      version: 1,
      at: new Date("2026-10-30T16:45:00Z"),
    });

    const result = await run(["export", "--source", "listings", "--format", "csv"]);

    const records = parseCsv(result.stdout);
    expect(records).toHaveLength(2);
    expect(records[1]).toEqual([
      "2026-10-30T16:45:00.000Z",
      "human",
      'a "quoted", key\nwith a break',
      "1",
      "",
      "category",
      'flat, "big"\r\nstudio',
      "",
      "",
      'flat, "big"\r\nstudio',
      "o'brien, ana",
    ]);
    expect(result.stdout).toContain('"a ""quoted"", key\nwith a break"');
  });

  it("reads 1,000 log rows in pages, never in one query", async () => {
    const log = store.log(LOG_ID);
    for (let n = 0; n < 1000; n += 1) {
      await log.appendAnswer({
        kind: "answer",
        key: `r${n}`,
        version: 1,
        model: "jev-1.14.0",
        stateHash: `hash-${n}`,
        answers: { is_scam: { type: "noul", probability: 0.5 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        at: new Date(Date.UTC(2026, 9, 28, 0, 0, n)),
      });
    }

    const result = await run(["export", "--source", "listings"]);

    expect(result.code).toBe(0);
    const keys = result.stdout
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { record_key: string }).record_key);
    expect(keys).toEqual(Array.from({ length: 1000 }, (_, n) => `r${n}`));
    expect(pageLimits.length).toBeGreaterThan(1);
    expect(Math.max(...pageLimits)).toBeLessThan(1000);
  });

  it("writes the file --out names instead of the terminal, and says how many rows", async () => {
    await seed();

    const result = await run([
      "export",
      "--source",
      "listings",
      "--format",
      "csv",
      "--out",
      "exports/listings.csv",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('Wrote 3 log rows of "listings" as csv to exports/listings.csv.\n');
    expect(parseCsv(files.get("exports/listings.csv") ?? "")).toHaveLength(8);
  });

  it("prints the count with --json, and refuses --json without --out because the rows would share its output", async () => {
    await seed();

    const withFile = await run(["export", "--source", "listings", "--json", "--out", "log.jsonl"]);
    expect(withFile.code).toBe(0);
    expect(JSON.parse(withFile.stdout)).toEqual({
      ok: true,
      source: "listings",
      format: "jsonl",
      rows: 3,
      out: "log.jsonl",
    });
    expect(files.get("log.jsonl")?.trim().split("\n")).toHaveLength(3);

    const without = await run(["export", "--source", "listings", "--json"]);
    expect(without.code).toBe(2);
    expect(JSON.parse(without.stdout)).toMatchObject({ ok: false, error: { code: "usage" } });
  });

  it("with --dry-run prints the row count and the format, and writes nothing", async () => {
    await seed();

    const result = await run([
      "export",
      "--source",
      "listings",
      "--format",
      "csv",
      "--out",
      "log.csv",
      "--dry-run",
    ]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('would write 3 log rows of "listings" as csv to log.csv');
    expect(files.size).toBe(0);

    const json = await run(["export", "--source", "listings", "--dry-run", "--json", "--out", "x"]);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      dryRun: true,
      source: "listings",
      format: "jsonl",
      rows: 3,
    });
  });

  it("names the sources of the config for an unknown source, or none given", async () => {
    const unknown = await run(["export", "--source", "orders"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('the config has no source named "orders"');
    expect(unknown.stderr).toContain("pass one of: listings, tickets");

    const none = await run(["export"]);
    expect(none.code).toBe(2);
    expect(none.stderr).toContain("listings, tickets");
  });

  it("refuses a format it does not write, and a missing DATABASE_URL, with the fix", async () => {
    const format = await run(["export", "--source", "listings", "--format", "xml"]);
    expect(format.code).toBe(2);
    expect(format.stderr).toContain("--format jsonl or --format csv");

    const noUrl = await run(["export", "--source", "listings"], {});
    expect(noUrl.code).toBe(1);
    expect(noUrl.stderr).toContain("DATABASE_URL is not set");
  });

  it("tells an empty log from an error on stderr, and keeps stdout to the data", async () => {
    const result = await run(["export", "--source", "tickets"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('no log for "tickets" yet');
  });
});
