import type { KeyText } from "@facetdb/core";
import { FakeClock, FakeEngine } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig, score } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { type EngineEntry, runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  resetPgliteWorld,
  type SqlConnect,
  type Store,
  sourceIdOf,
  TEST_SECRET,
} from "../testing.ts";
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
/** How many times the log was counted. */
let counts: number;
/** The files `--out` wrote. */
let files: Map<string, string>;
/** Each part written to a file, in order: how much it held. */
let writes: { readonly path: string; readonly length: number }[];
/** The `page` call that fails (counted from 1), or none. */
let failingPage: number | undefined;
/** A file another run makes while this one reads the log, as two exports at once would. */
let raceTo: string | undefined;

// One engine for the file, emptied after every test: a boot per test cost 440 ms.
beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new FakeClock(0) });
  pageLimits = [];
  counts = 0;
  files = new Map();
  writes = [];
  failingPage = undefined;
  raceTo = undefined;
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

function run(
  argv: readonly string[],
  env: Record<string, string> = defaultEnv(),
  setup: { readonly config?: ProjectConfig; readonly engines?: readonly EngineEntry[] } = {},
) {
  const connect: SqlConnect = world.connect;
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env,
      loadConfig: () => Promise.resolve(setup.config ?? CONFIG),
      ...(setup.engines === undefined ? {} : { engines: setup.engines }),
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
                if (pageLimits.length === failingPage) {
                  return Promise.reject(new Error("the store went away"));
                }
                if (raceTo !== undefined) {
                  files.set(raceTo, "another run's export\n");
                }
                return log.page(after, limit);
              },
              count: (version?: number) => {
                counts += 1;
                return log.count(version);
              },
            };
          },
          close: () => Promise.resolve(),
        }),
      // The disk's rules (main.ts's diskWorkspace, proven in main.test.ts): the parts go aside and
      // take the name at the end, replacing a file only with `overwrite`.
      workspace: {
        exists: (path) => Promise.resolve(files.has(path)),
        write: () => Promise.reject(new Error("export writes its file in parts")),
        writeParts: async (path, parts, { overwrite }) => {
          let text = "";
          for await (const part of parts) {
            writes.push({ path, length: part.length });
            text += part;
          }
          if (!overwrite && files.has(path)) {
            return "exists";
          }
          files.set(path, text);
          return "written";
        },
        peek: () => Promise.reject(new Error("export reads no file")),
        lines: () => {
          throw new Error("export reads no file");
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
    // One count, never a page of the log.
    expect(counts).toBe(1);
    expect(pageLimits).toEqual([]);

    const json = await run(["export", "--source", "listings", "--dry-run", "--json", "--out", "x"]);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      dryRun: true,
      source: "listings",
      format: "jsonl",
      rows: 3,
    });
  });

  it("allows --dry-run --json without --out: a dry run puts no rows on stdout", async () => {
    await seed();

    const result = await run(["export", "--source", "listings", "--dry-run", "--json"]);

    expect(result.code, result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      ok: true,
      dryRun: true,
      source: "listings",
      format: "jsonl",
      rows: 3,
    });
    expect(result.stderr).toContain(
      'would write 3 log rows of "listings" as jsonl to the terminal',
    );
  });

  it("refuses to replace the file --out names, naming --force, and replaces it with --force", async () => {
    await seed();
    const argv = ["export", "--source", "listings", "--format", "csv", "--out", "x.csv"];

    const first = await run(argv);
    expect(first.code, first.stderr).toBe(0);
    const written = files.get("x.csv");

    const second = await run(argv);
    expect(second.code).toBe(1);
    expect(second.stdout).toBe("");
    expect(second.stderr).toContain(
      "error: x.csv already exists, and export does not replace a file unless told to; nothing was written",
    );
    expect(second.stderr).toContain("fix: pass --force to replace x.csv");
    expect(second.stderr).toContain("https://docs.facetdb.dev/fix/export-out-exists");
    expect(files.get("x.csv")).toBe(written);
    // Refused before the store is read: no page, and the dry run says it too.
    expect(pageLimits).toHaveLength(1);
    expect((await run([...argv, "--dry-run"])).code).toBe(1);

    await store.log(LOG_ID).appendAnswer({
      kind: "answer",
      key: "r3",
      version: 1,
      model: "jev-1.14.0",
      stateHash: "hash-r3",
      answers: { is_scam: { type: "noul", probability: 0.2 } },
      usage: { inputTokens: 1, outputTokens: 1 },
      at: new Date("2026-10-31T08:00:00Z"),
    });
    const forced = await run([...argv, "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stdout).toBe('Wrote 4 log rows of "listings" as csv to x.csv.\n');
    // Replaced, not added to: the header once, then 3 + 3 + 1 + 1 lines.
    expect(parseCsv(files.get("x.csv") ?? "")).toHaveLength(1 + 3 + 3 + 1 + 1);
  });

  it("writes the file page by page as the log is read, never as one string", async () => {
    const log = store.log(LOG_ID);
    for (let n = 0; n < 1200; n += 1) {
      await log.appendAnswer({
        kind: "answer",
        key: `r${n}`,
        version: 1,
        model: "jev-1.14.0",
        stateHash: `hash-${n}`,
        answers: { is_scam: { type: "noul", probability: 0.5 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        at: new Date(Date.UTC(2026, 9, 28, 0, 0, n % 60)),
      });
    }

    const result = await run(["export", "--source", "listings", "--out", "log.jsonl"]);

    expect(result.code, result.stderr).toBe(0);
    // 1,200 rows in pages of 500: three parts, each a page, none the whole log.
    expect(writes).toHaveLength(3);
    expect(Math.max(...writes.map((write) => write.length))).toBeLessThan(
      (files.get("log.jsonl") ?? "").length / 2,
    );
    const keys = (files.get("log.jsonl") ?? "")
      .trim()
      .split("\n")
      .map((line) => (JSON.parse(line) as { record_key: string }).record_key);
    expect(keys).toEqual(Array.from({ length: 1200 }, (_, n) => `r${n}`));
  });

  it("leaves --out as it was when a later page fails, --force or not", async () => {
    const log = store.log(LOG_ID);
    for (let n = 0; n < 600; n += 1) {
      await log.appendAnswer({
        kind: "answer",
        key: `r${n}`,
        version: 1,
        model: "jev-1.14.0",
        stateHash: `hash-${n}`,
        answers: { is_scam: { type: "noul", probability: 0.5 } },
        usage: { inputTokens: 1, outputTokens: 1 },
        at: new Date(Date.UTC(2026, 9, 28, 0, 0, n % 60)),
      });
    }
    files.set("log.jsonl", "last week's export\n");
    failingPage = 2;

    const result = await run(["export", "--source", "listings", "--out", "log.jsonl", "--force"]);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain("the store went away");
    expect(writes).toHaveLength(1);
    expect(files.get("log.jsonl")).toBe("last week's export\n");
    expect([...files.keys()]).toEqual(["log.jsonl"]);
  });

  it("refuses in its own words when another export made --out meanwhile, and the last wins under --force", async () => {
    await seed();
    raceTo = "log.jsonl";

    const refused = await run(["export", "--source", "listings", "--out", "log.jsonl"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain(
      "error: log.jsonl already exists, and export does not replace a file unless told to; nothing was written",
    );
    expect(refused.stderr).toContain("fix: pass --force to replace log.jsonl");
    expect(files.get("log.jsonl")).toBe("another run's export\n");

    files.delete("log.jsonl");
    const forced = await run(["export", "--source", "listings", "--out", "log.jsonl", "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(files.get("log.jsonl")?.trim().split("\n")).toHaveLength(3);
  });

  it("makes the file even for an empty log: the CSV header alone", async () => {
    const result = await run([
      "export",
      "--source",
      "tickets",
      "--format",
      "csv",
      "--out",
      "empty.csv",
    ]);
    expect(result.code, result.stderr).toBe(0);
    expect(parseCsv(files.get("empty.csv") ?? "")).toHaveLength(1);
    expect(writes).toHaveLength(1);
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

  it("writes a tagged-key engine's keys as the user writes them, and never opens its database", async () => {
    const HEX = "65f1a2b3c4d5e6f708192a3b";
    const mongoConfig = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database: "mongodb://facetdb_worker:worker-password@source.invalid:27017/app",
          table: "listings",
          read: ["title"],
          questions: { is_scam: noul("Is this listing a scam?") },
        },
      ],
    });
    const mongo = new FakeEngine({
      name: "mongodb",
      schemes: ["mongodb", "mongodb+srv"],
      keyText: {
        toText: (key) => key.replace(/^(?:oid|n):/, ""),
        fromText: (text) => text,
        form: "the document's _id as you write it",
      },
    });
    await store.questionSets.record(LOG_ID, setOf(mongoConfig));
    const log = store.log(LOG_ID);
    for (const [key, at, stateHash] of [
      [`oid:${HEX}`, "2026-11-04T09:00:00Z", "hash-car"],
      ["n:1", "2026-11-04T09:01:00Z", "hash-flat"],
    ] as const) {
      await log.appendAnswer({
        kind: "answer",
        key,
        version: 1,
        model: "jev-1.14.0",
        stateHash,
        answers: { is_scam: { type: "noul", probability: 0.03 } },
        usage: { inputTokens: 100, outputTokens: 5 },
        at: new Date(at),
      });
    }
    await log.appendHuman({
      kind: "human",
      key: "n:1",
      question: "is_scam",
      value: true,
      reviewer: "ana@example.com",
      stateHash: "hash-flat",
      version: 1,
      at: new Date("2026-11-04T09:02:00Z"),
    });
    const setup = {
      config: mongoConfig,
      engines: [lazyEngine("mongodb", () => Promise.resolve(mongo))],
    };

    const jsonl = await run(["export", "--source", "listings"], defaultEnv(), setup);
    const csv = await run(
      ["export", "--source", "listings", "--format", "csv"],
      defaultEnv(),
      setup,
    );

    expect(jsonl.code).toBe(0);
    expect(
      jsonl.stdout
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as { record_key: string }).record_key),
    ).toEqual([HEX, "1", "1"]);
    expect(csv.code).toBe(0);
    expect(
      parseCsv(csv.stdout)
        .slice(1)
        .map((record) => record[2]),
    ).toEqual([HEX, "1", "1"]);
    expect(`${jsonl.stdout}${csv.stdout}`).not.toMatch(/oid:|n:1/);
    expect(mongo.opened).toEqual([]);
    // With the source's connection string set, nothing is said about the keys' form.
    expect(jsonl.stderr).not.toContain("record_key");
  });

  it("writes a string _id 1001 as 1001 where the marker records strings, reading only that type", async () => {
    const mongoConfig = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database: "mongodb://facetdb_worker:worker-password@localhost:27017/app",
          table: "listings",
          read: ["title"],
          questions: { is_scam: noul("Is this listing a scam?") },
        },
      ],
    });
    const untyped: KeyText = {
      // the untyped rule alone: a numeric string prints with its escape.
      toText: (key) => (/^[0-9]+$/.test(key) ? `s:${key}` : key),
      fromText: (text) => text,
      form: "the document's _id as you write it",
    };
    const asked: string[] = [];
    const mongo = new FakeEngine({
      name: "mongodb",
      schemes: ["mongodb", "mongodb+srv"],
      keyText: untyped,
      keyTextOf: (target) => {
        asked.push(target.table);
        return { ...untyped, toText: (key) => key };
      },
    });
    await store.questionSets.record(LOG_ID, setOf(mongoConfig));
    await store.log(LOG_ID).appendAnswer({
      kind: "answer",
      key: "1001",
      version: 1,
      model: "jev-1.14.0",
      stateHash: "hash-boat",
      answers: { is_scam: { type: "noul", probability: 0.03 } },
      usage: { inputTokens: 100, outputTokens: 5 },
      at: new Date("2026-11-04T09:00:00Z"),
    });
    const setup = {
      config: mongoConfig,
      engines: [lazyEngine("mongodb", () => Promise.resolve(mongo))],
    };

    const jsonl = await run(["export", "--source", "listings"], defaultEnv(), setup);

    expect(jsonl.code).toBe(0);
    expect((JSON.parse(jsonl.stdout.trim()) as { record_key: string }).record_key).toBe("1001");
    expect(asked).toEqual(["listings"]);
    // The type only: no connector opened, no row of the collection read.
    expect(mongo.opened).toEqual([]);
    // A dry run writes no key, so it reads no type.
    asked.length = 0;
    const dry = await run(["export", "--source", "listings", "--dry-run"], defaultEnv(), setup);
    expect(dry.code).toBe(0);
    expect(asked).toEqual([]);
  });

  it("writes the keys as stored, and says why on stderr, when the source's database refuses to connect", async () => {
    const mongoConfig = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database: "mongodb://facetdb_worker:worker-password@localhost:27017/app",
          table: "listings",
          read: ["title"],
          questions: { is_scam: noul("Is this listing a scam?") },
        },
      ],
    });
    const mongo = new FakeEngine({
      name: "mongodb",
      schemes: ["mongodb", "mongodb+srv"],
      keyText: {
        toText: (key) => key.replace(/^n:/, ""),
        fromText: (text) => text,
        form: "the document's _id as you write it",
      },
      keyTextOf: () => {
        // The driver's words on a server that is down; worker-password must never be echoed.
        throw new Error(
          "connect ECONNREFUSED 127.0.0.1:27017 (mongodb://facetdb_worker:worker-password@localhost:27017/app)",
        );
      },
    });
    await store.questionSets.record(LOG_ID, setOf(mongoConfig));
    await store.log(LOG_ID).appendAnswer({
      kind: "answer",
      key: "n:1",
      version: 1,
      model: "jev-1.14.0",
      stateHash: "hash-flat",
      answers: { is_scam: { type: "noul", probability: 0.03 } },
      usage: { inputTokens: 100, outputTokens: 5 },
      at: new Date("2026-11-04T09:00:00Z"),
    });

    const result = await run(["export", "--source", "listings"], defaultEnv(), {
      config: mongoConfig,
      engines: [lazyEngine("mongodb", () => Promise.resolve(mongo))],
    });

    expect(result.code).toBe(0);
    expect((JSON.parse(result.stdout.trim()) as { record_key: string }).record_key).toBe("n:1");
    expect(result.stderr).toContain(
      'note: export could not read how the keys of "listings" are written from its database (it could not be reached or read), so it writes each record_key as the FacetDB store keeps it',
    );
    expect(result.stderr).not.toContain("worker-password");
  });

  it("says on stderr which form the keys take when the source's connection string is unset here", async () => {
    await seed();
    // What the loader makes of `database: process.env.LISTINGS_URL` with LISTINGS_URL unset.
    const unset: ProjectConfig = {
      ...CONFIG,
      sources: CONFIG.sources.map(({ database: _database, ...source }) => ({
        ...source,
        databaseEnv: "LISTINGS_URL",
      })),
    };

    const result = await run(["export", "--source", "listings"], defaultEnv(), { config: unset });

    expect(result.code).toBe(0);
    expect(result.stderr).toContain(
      'note: LISTINGS_URL is not set here, so export cannot tell which database "listings" is on and writes each record_key as the FacetDB store keeps it',
    );
    expect(result.stderr).toContain("Set LISTINGS_URL to export MongoDB keys as you write them.");
    // The rows themselves are unchanged, on stdout.
    expect(result.stdout.trim().split("\n")).toHaveLength(3);
  });
});
