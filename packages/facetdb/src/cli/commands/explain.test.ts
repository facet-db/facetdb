import type { EngineTarget, KeyText, RecordDecision } from "@facetdb/core";
import { FakeClock, FakeConnector, FakeDatabase, FakeEngine } from "@facetdb/core/testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { lazyEngine } from "../engines.ts";
import { type EngineEntry, runInProcess } from "../program.ts";
import {
  createPgliteWorld,
  createStore,
  type PgliteWorld,
  postgresEngines,
  resetPgliteWorld,
  type SqlConnect,
  type Store,
  sourceIdOf,
  TEST_SECRET,
} from "../testing.ts";
import { questionSetOf } from "./database.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb explain` through the in-process runner on PGlite: a record with two model answers under
 * two question-set versions and one human decision prints oldest first, each with the wording that
 * was in force at the time (not today's), `--json` carries the same entries, and a key nobody
 * answered says what to check.
 */

const WORKER_URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";

function configWith(
  wording: string,
  options: { readonly yesAbove?: number; readonly storage?: "inline" | "side-table" } = {},
): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: WORKER_URL,
        table: "listings",
        ...(options.storage === undefined ? {} : { storage: options.storage }),
        read: ["id", "title"],
        thresholds:
          options.yesAbove === undefined ? {} : { is_scam: { yesAbove: options.yesAbove } },
        questions: {
          is_scam: noul(wording),
          category: choice("Which category is this listing?", {
            car: "A car",
            flat: "A flat",
          }),
        },
      },
    ],
  });
}

/** The project `projectRef` derives from `PROJECT_DIR`, and the id the log is kept under. */
const PROJECT_DIR = "/work/listings-app";
const LOG_ID = sourceIdOf("listings-app", "listings");
const FIRST_WORDING = "Is this listing a scam?";
const SECOND_WORDING = "Does this listing look like fraud?";
const CURRENT_WORDING = "Is this listing fraudulent in any way?";

let world: PgliteWorld;
let store: Store;

// One engine for the file, emptied after every test: a boot per test cost 440 ms.
beforeAll(async () => {
  world = await createPgliteWorld();
});

afterAll(async () => {
  await world.close();
});

beforeEach(async () => {
  store = await createStore({ pglite: world.db, secret: TEST_SECRET, clock: new FakeClock(0) });
  await world.client.query(
    `create table public.listings (
       id text primary key, title text not null,
       is_scam boolean, is_scam_probability real, category text, category_confidence real,
       facetdb_status text not null default 'pending', facetdb_updated_at timestamptz,
       facetdb_reviewed boolean not null default false)`,
  );
  await world.client.query(
    "insert into public.listings (id, title, is_scam, is_scam_probability, category, category_confidence, facetdb_status, facetdb_reviewed) values ('r1', 'A car', false, 0.58, 'car', 0.9, 'done', true), ('r2', 'Untouched', null, null, null, null, 'pending', false)",
  );
});

afterEach(async () => {
  await store.close();
  await resetPgliteWorld(world);
});

/** Whether each store the command asked for was allowed to be plaintext. */
const storeAsked: boolean[] = [];

function run(
  argv: readonly string[],
  config: ProjectConfig,
  env: Record<string, string> = { DATABASE_URL: "postgres://localhost:5432/app" },
  connect: SqlConnect = world.connect,
  engines: readonly EngineEntry[] = postgresEngines(connect),
) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env,
      loadConfig: () => Promise.resolve(config),
      engines,
      connect,
      // The command closes the store it is given; the test's own stays open through a wrapper.
      store: (options) => {
        storeAsked.push(options?.allowInsecure === true);
        return Promise.resolve({ ...store, close: () => Promise.resolve() });
      },
    },
    COMMANDS,
  );
}

function setOf(config: ProjectConfig) {
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has no source");
  }
  return questionSetOf(config, source);
}

/** r1: asked under v1 (unsure), asked again under v2 (sure), then a person decided under v2. */
async function seedHistory(): Promise<void> {
  const v1 = await store.questionSets.record(LOG_ID, setOf(configWith(FIRST_WORDING)));
  const v2 = await store.questionSets.record(
    LOG_ID,
    setOf(configWith(SECOND_WORDING, { yesAbove: 0.5 })),
  );
  expect([v1.version, v2.version]).toEqual([1, 2]);
  const log = store.log(LOG_ID);
  await log.appendAnswer({
    kind: "answer",
    key: "r1",
    version: 1,
    model: "jev-1.14.0",
    stateHash: "hash-1",
    answers: {
      is_scam: { type: "noul", probability: 0.58 },
      category: { type: "choice", top: "car", probabilities: [0.95, 0.05] },
    },
    usage: { inputTokens: 100, outputTokens: 5 },
    at: new Date("2026-10-28T14:02:00Z"),
  });
  await log.appendAnswer({
    kind: "answer",
    key: "r1",
    version: 2,
    model: "jev-1.14.0",
    stateHash: "hash-2",
    answers: {
      is_scam: { type: "noul", probability: 0.58 },
      category: { type: "choice", top: "flat", probabilities: [0.2, 0.8] },
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
    stateHash: "hash-2",
    version: 2,
    at: new Date("2026-10-30T16:45:00Z"),
  });
}

describe("facetdb explain", () => {
  it("prints answers and human decisions oldest first, each with the wording of its own version", async () => {
    await seedHistory();

    // The config now words the question a third way; the history must not.
    const result = await run(["explain", "listings", "r1"], configWith(CURRENT_WORDING));

    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    const at = (text: string) => lines.findIndex((line) => line.includes(text));
    const first = at("2026-10-28 14:02 · jev-1.14.0 · question set v1");
    const second = at("2026-10-29 09:30 · jev-1.14.0 · question set v2");
    const human = at("2026-10-30 16:45 · question set v2");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(human).toBeGreaterThan(second);

    // v1: the first wording, a 58% scam between the default thresholds, so it needed review.
    expect(lines[first + 1]).toBe(`    "${FIRST_WORDING}" 58% likely yes → needs review`);
    // v2: the second wording and its own threshold (yesAbove 0.5), under which 58% is a yes.
    expect(lines[second + 1]).toBe(`    "${SECOND_WORDING}" 58% likely yes → yes`);
    expect(lines[second + 2]).toBe('    "Which category is this listing?" flat, 60% sure → flat');
    expect(lines[human]).toBe(
      `2026-10-30 16:45 · question set v2 · "${SECOND_WORDING}" decided no by ana@example.com · note: seller is verified`,
    );
    // Today's wording appears nowhere in the history.
    expect(result.stdout).not.toContain(CURRENT_WORDING);
    // Then the row as it stands, in words.
    expect(lines.at(-2)).toBe("Now: is_scam: no · category: car · status: done · reviewed: yes");
    // Never a raw probability.
    expect(result.stdout).not.toMatch(/0\.58|noul=/);
  });

  it("prints the entries with --json, in the same order, and the human text goes to stderr", async () => {
    await seedHistory();

    const result = await run(["explain", "listings", "r1", "--json"], configWith(CURRENT_WORDING));

    expect(result.code).toBe(0);
    const printed = JSON.parse(result.stdout) as {
      ok: boolean;
      source: string;
      key: string;
      entries: {
        kind: string;
        at: string;
        version: number;
        wording?: string;
        answers?: { wording: string }[];
      }[];
      current: {
        found: boolean;
        status: string;
        reviewed: boolean;
        values: Record<string, string>;
      };
    };
    expect(printed.ok).toBe(true);
    expect(printed.source).toBe("listings");
    expect(printed.key).toBe("r1");
    expect(printed.entries.map((entry) => [entry.kind, entry.version, entry.at])).toEqual([
      ["answer", 1, "2026-10-28T14:02:00.000Z"],
      ["answer", 2, "2026-10-29T09:30:00.000Z"],
      ["human", 2, "2026-10-30T16:45:00.000Z"],
    ]);
    expect(printed.entries[0]?.answers?.[0]?.wording).toBe(FIRST_WORDING);
    expect(printed.entries[1]?.answers?.[0]?.wording).toBe(SECOND_WORDING);
    expect(printed.entries[2]?.wording).toBe(SECOND_WORDING);
    expect(printed.current).toEqual({
      found: true,
      status: "done",
      reviewed: true,
      values: { is_scam: "no", category: "car" },
    });
    // Round trip: the JSON re-serialises to itself.
    expect(JSON.parse(JSON.stringify(printed))).toEqual(printed);
    expect(result.stderr).toContain("decided no by ana@example.com");
  });

  it("prints a decision and its withdrawal (undo), both kept in the log", async () => {
    await seedHistory();
    await store.log(LOG_ID).appendHuman({
      kind: "human",
      key: "r1",
      question: "is_scam",
      value: { withdrawn: true },
      reviewer: "ana@example.com",
      stateHash: "hash-2",
      version: 2,
      at: new Date("2026-10-30T16:46:00Z"),
    });

    const result = await run(["explain", "listings", "r1"], configWith(CURRENT_WORDING));

    expect(result.code).toBe(0);
    const lines = result.stdout.split("\n");
    const decided = lines.findIndex((line) => line.includes("decided no by ana@example.com"));
    expect(decided).toBeGreaterThan(-1);
    expect(lines[decided + 1]).toBe(
      `2026-10-30 16:46 · question set v2 · "${SECOND_WORDING}" decision withdrawn by ana@example.com (undo)`,
    );

    const json = await run(["explain", "listings", "r1", "--json"], configWith(CURRENT_WORDING));
    const printed = JSON.parse(json.stdout) as { entries: { kind: string; reviewer?: string }[] };
    expect(printed.entries.map((entry) => entry.kind)).toEqual([
      "answer",
      "answer",
      "human",
      "withdrawal",
    ]);
    expect(printed.entries[3]?.reviewer).toBe("ana@example.com");
  });

  it("reads the current state from the side table, not the app's table, in side-table mode", async () => {
    await seedHistory();
    // Side-table install: the app's table is untouched (no FacetDB columns, and the worker cannot
    // see its constraints); the answers and status live on facetdb.listings_answers.
    await world.client.query("drop table public.listings");
    await world.client.query(
      "create table public.listings (id text primary key, title text not null)",
    );
    await world.client.query("insert into public.listings values ('r1', 'A car')");
    await world.client.query(
      `create table facetdb.listings_answers (
         id text primary key references public.listings (id),
         is_scam boolean, is_scam_probability real, category text, category_confidence real,
         facetdb_status text not null default 'pending', facetdb_updated_at timestamptz,
         facetdb_reviewed boolean not null default false)`,
    );
    await world.client.query(
      "insert into facetdb.listings_answers (id, is_scam, is_scam_probability, category, category_confidence, facetdb_status, facetdb_reviewed) values ('r1', false, 0.58, 'car', 0.9, 'done', true)",
    );

    const result = await run(
      ["explain", "listings", "r1"],
      configWith(CURRENT_WORDING, { storage: "side-table" }),
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("2026-10-28 14:02 · jev-1.14.0 · question set v1");
    expect(result.stdout).toContain(
      "Now: is_scam: no · category: car · status: done · reviewed: yes",
    );
  });

  it("says what to check when the key has no history", async () => {
    const result = await run(["explain", "listings", "r2"], configWith(CURRENT_WORDING));

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('no history for record r2 of "listings"');
    expect(result.stdout).toContain("Is the source right?");
    expect(result.stdout).toContain("Has the worker run?");

    const json = await run(["explain", "listings", "r2", "--json"], configWith(CURRENT_WORDING));
    expect(JSON.parse(json.stdout)).toEqual({
      ok: true,
      source: "listings",
      key: "r2",
      entries: [],
    });
  });

  it("refuses a source the config does not have, naming the ones it has", async () => {
    const result = await run(["explain", "orders", "r1"], configWith(CURRENT_WORDING));

    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no source named "orders"');
    expect(result.stderr).toContain("pass one of: listings");
  });

  it("is a bad invocation without a key", async () => {
    const result = await run(["explain", "listings"], configWith(CURRENT_WORDING));

    expect(result.code).toBe(2);
  });
});

describe("facetdb explain keeps the worker's password out of the clear", () => {
  const REMOTE_PLAIN = "postgres://facetdb_worker:s3cret-worker-password@db.example.com/x";
  const REMOTE_TLS = `${REMOTE_PLAIN}?sslmode=require`;

  /** A driver that fails the test when anything connects. */
  const noConnection: SqlConnect = (url) => {
    throw new Error(`a connection was opened to ${url}`);
  };

  /** What the loader makes of `database: process.env.LISTINGS_URL`: the value read, and the variable. */
  function ownUrl(url: string): ProjectConfig {
    const base = configWith(CURRENT_WORDING);
    return {
      ...base,
      sources: base.sources.map(({ database: _database, ...source }) => ({
        ...source,
        database: url,
        databaseEnv: "LISTINGS_URL",
      })),
    };
  }

  it("refuses a plaintext remote DATABASE_URL before the store opens, and the flag it names is accepted", async () => {
    storeAsked.length = 0;
    const result = await run(
      ["explain", "listings", "r1"],
      configWith(CURRENT_WORDING),
      { DATABASE_URL: REMOTE_PLAIN },
      noConnection,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "error: DATABASE_URL reaches db.example.com without TLS, so the password in it would travel in the clear; no connection was made",
    );
    expect(result.stderr).toContain(
      "fix: add ?sslmode=require to DATABASE_URL, or pass --allow-insecure if that network is trusted",
    );
    expect(result.stderr).not.toContain("s3cret-worker-password");
    expect(storeAsked).toEqual([]);
  });

  it("refuses a source's own plaintext remote URL when DATABASE_URL has TLS, naming its variable", async () => {
    storeAsked.length = 0;
    const result = await run(
      ["explain", "listings", "r1"],
      ownUrl(REMOTE_PLAIN),
      { DATABASE_URL: REMOTE_TLS },
      noConnection,
    );
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("error: LISTINGS_URL reaches db.example.com without TLS");
    expect(result.stderr).toContain("fix: add ?sslmode=require to LISTINGS_URL");
    expect(storeAsked).toEqual([]);
  });

  it("--allow-insecure reaches the store and lets both through", async () => {
    storeAsked.length = 0;
    const result = await run(
      ["explain", "listings", "r1", "--allow-insecure"],
      ownUrl(REMOTE_PLAIN),
      { DATABASE_URL: REMOTE_PLAIN },
    );
    expect(result.stderr).not.toContain("without TLS");
    expect(storeAsked).toEqual([true]);
  });
});

describe("facetdb explain on an engine whose keys carry a type tag", () => {
  /** The key forms of MongoDB's connector: `oid:<hex>` for an ObjectId, `n:<number>` for a number. */
  const HEX = "65f1a2b3c4d5e6f708192a3b";
  const OBJECT_KEY = `oid:${HEX}`;
  const NUMBER_KEY = "n:1";
  const MONGO_URL = "mongodb://facetdb_worker:worker-password@localhost:27017/app";
  const FORM = "the document's _id as you write it";

  /** A handwritten key text with MongoDB's rule: 24 hex an ObjectId, digits a number. */
  const tagged: KeyText = {
    toText: (key) => key.replace(/^(?:oid|n):/, ""),
    fromText: (text) =>
      /^[0-9a-f]{24}$/.test(text) ? `oid:${text}` : /^[0-9]+$/.test(text) ? `n:${text}` : text,
    form: FORM,
  };

  const mongoConfig: ProjectConfig = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "listings",
        database: MONGO_URL,
        table: "listings",
        read: ["title"],
        questions: { is_scam: noul(FIRST_WORDING) },
      },
    ],
  });

  const decided: RecordDecision = {
    decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.97 } },
    status: "done",
  };

  /** A string `_id` "1001": its key is itself, which the untyped rule alone would type as `s:1001`. */
  const STRING_KEY = "1001";

  /**
   * The key text of a collection whose marker records string `_id`s: a bare text is the string,
   * `s:` still taken.
   */
  const stringTyped: KeyText = {
    toText: (key) => key,
    fromText: (text) => text.replace(/^s:/, ""),
    form: "the document's _id as you write it (a string as itself)",
  };

  /** The fake MongoDB: every document answered, its decision stored, its log in the store. */
  async function mongoWorld(
    keyTextOf?: (target: EngineTarget) => KeyText,
  ): Promise<readonly EngineEntry[]> {
    const database = new FakeDatabase({ fields: ["title"] });
    database.install();
    database.edit(OBJECT_KEY, { title: "A car" });
    database.edit(NUMBER_KEY, { title: "A flat" });
    database.edit(STRING_KEY, { title: "A boat" });
    const writer = new FakeConnector(database);
    for (const row of (await writer.read([OBJECT_KEY, NUMBER_KEY, STRING_KEY])).rows) {
      expect((await writer.write(row.key, decided, row.hash)).written).toBe(true);
    }
    await store.questionSets.record(LOG_ID, setOf(mongoConfig));
    for (const key of [OBJECT_KEY, NUMBER_KEY, STRING_KEY]) {
      await store.log(LOG_ID).appendAnswer({
        kind: "answer",
        key,
        version: 1,
        model: "jev-1.14.0",
        stateHash: `hash-${key}`,
        answers: { is_scam: { type: "noul", probability: 0.03 } },
        usage: { inputTokens: 100, outputTokens: 5 },
        at: new Date("2026-11-04T09:00:00Z"),
      });
    }
    const engine = new FakeEngine({
      name: "mongodb",
      schemes: ["mongodb", "mongodb+srv"],
      database,
      keyText: tagged,
      ...(keyTextOf === undefined ? {} : { keyTextOf }),
    });
    return [lazyEngine("mongodb", () => Promise.resolve(engine))];
  }

  function explain(argv: readonly string[], engines: readonly EngineEntry[]) {
    return run(
      ["explain", "listings", ...argv],
      mongoConfig,
      { DATABASE_URL: "postgres://localhost:5432/app" },
      world.connect,
      engines,
    );
  }

  it("finds an ObjectId typed as its 24 hex characters, and prints it so", async () => {
    const engines = await mongoWorld();

    const result = await explain([HEX], engines);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`History of record ${HEX} of "listings", oldest first:`);
    expect(result.stdout).toContain(`    "${FIRST_WORDING}" 3% likely yes → no`);
    // The current state was read with the tagged key: the record's stored decision, found.
    expect(result.stdout).toContain("Now: is_scam: no · status: done · reviewed: no");
    expect(result.stdout).not.toContain("oid:");
  });

  it("finds a number typed bare, and prints it bare", async () => {
    const engines = await mongoWorld();

    const result = await explain(["1"], engines);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('History of record 1 of "listings", oldest first:');
    expect(result.stdout).toContain("Now: is_scam: no · status: done · reviewed: no");
    expect(result.stdout).not.toContain("n:1");

    const json = await explain(["1", "--json"], engines);
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, key: "1", current: { found: true } });
  });

  it("still finds the tagged form typed as written, and prints the _id as the user writes it", async () => {
    const engines = await mongoWorld();

    const result = await explain([OBJECT_KEY], engines);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`History of record ${HEX} of "listings"`);
  });

  it("says how a key is written when nothing is found, in the engine's words", async () => {
    const engines = await mongoWorld();

    const result = await explain(["2"], engines);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('FacetDB has no history for record 2 of "listings".');
    expect(result.stdout).toContain(`Then check the key: it is ${FORM}.`);
    expect(result.stdout).not.toContain("primary key, as text");
  });

  it("finds a numeric string _id typed bare where the marker records strings, and prints it bare", async () => {
    const asked: string[] = [];
    const engines = await mongoWorld((target) => {
      asked.push(target.table);
      return stringTyped;
    });

    const result = await explain([STRING_KEY], engines);

    expect(result.code).toBe(0);
    expect(asked).toEqual(["listings"]);
    expect(result.stdout).toContain('History of record 1001 of "listings", oldest first:');
    expect(result.stdout).toContain("Now: is_scam: no · status: done · reviewed: no");
    expect(result.stdout).not.toContain("s:1001");
    // The escape typed as before still finds it.
    expect((await explain([`s:${STRING_KEY}`], engines)).stdout).toContain(
      'History of record 1001 of "listings"',
    );
  });
});

describe("facetdb explain names the table as its engine does", () => {
  const MYSQL_URL = "mysql://facetdb_worker:worker-password@localhost:3306/app";

  /** A MySQL-like engine whose connector cannot read the record now: its words name the table. */
  class UnreadableEngine extends FakeEngine {
    override async open(...args: Parameters<FakeEngine["open"]>) {
      const connector = await super.open(...args);
      connector.current = () => Promise.reject(new Error("the connection was reset"));
      return connector;
    }
  }

  it("says the table it could not read as migrate's header does, never public.", async () => {
    const config: ProjectConfig = facetdb({
      model: "jev-1.14.0",
      sources: [
        {
          name: "listings",
          database: MYSQL_URL,
          table: "listings",
          read: ["title"],
          questions: { is_scam: noul(FIRST_WORDING) },
        },
      ],
    });
    await store.questionSets.record(LOG_ID, setOf(config));
    await store.log(LOG_ID).appendAnswer({
      kind: "answer",
      key: "r1",
      version: 1,
      model: "jev-1.14.0",
      stateHash: "hash-r1",
      answers: { is_scam: { type: "noul", probability: 0.03 } },
      usage: { inputTokens: 100, outputTokens: 5 },
      at: new Date("2026-11-04T09:00:00Z"),
    });
    const engine = new UnreadableEngine({
      name: "mysql",
      schemes: ["mysql", "mariadb"],
      database: new FakeDatabase({ fields: ["title"] }),
      // MySQL's rule: a bare table is in the connection string's database.
      label: (target, url) => `${target.schema ?? new URL(url).pathname.slice(1)}.${target.table}`,
    });

    const result = await run(
      ["explain", "listings", "r1"],
      config,
      { DATABASE_URL: "postgres://localhost:5432/app" },
      world.connect,
      [lazyEngine("mysql", () => Promise.resolve(engine))],
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      "the record's current state could not be read from app.listings: the connection was reset",
    );
    expect(result.stderr).not.toContain("public.");
  });
});
