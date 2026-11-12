import { FakeClock } from "@facetdb/core/testing";
import { createStore, type SqlConnect, type Store } from "@facetdb/postgres";
import { createPgliteWorld, type PgliteWorld, TEST_SECRET } from "@facetdb/postgres/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { choice, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { runInProcess } from "../program.ts";
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

const FIRST_WORDING = "Is this listing a scam?";
const SECOND_WORDING = "Does this listing look like fraud?";
const CURRENT_WORDING = "Is this listing fraudulent in any way?";

let world: PgliteWorld;
let store: Store;

beforeEach(async () => {
  world = await createPgliteWorld();
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
  await world.close();
});

/** Whether each store the command asked for was allowed to be plaintext. */
const storeAsked: boolean[] = [];

function run(
  argv: readonly string[],
  config: ProjectConfig,
  env: Record<string, string> = { DATABASE_URL: "postgres://localhost:5432/app" },
  connect: SqlConnect = world.connect,
) {
  return runInProcess(
    argv,
    {
      projectDir: "/work/listings-app",
      env,
      loadConfig: () => Promise.resolve(config),
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
  const v1 = await store.questionSets.record("listings", setOf(configWith(FIRST_WORDING)));
  const v2 = await store.questionSets.record(
    "listings",
    setOf(configWith(SECOND_WORDING, { yesAbove: 0.5 })),
  );
  expect([v1.version, v2.version]).toEqual([1, 2]);
  const log = store.log("listings");
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
