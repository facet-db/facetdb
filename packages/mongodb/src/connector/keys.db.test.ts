import type {
  EngineDeps,
  EngineTarget,
  KeyText,
  OpenConnector,
  QuestionSet,
  RecordDecision,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock } from "@facetdb/core/testing";
import { type Db, MongoClient, ObjectId } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMongoEngine, MONGO_KEY_TEXT } from "../engine/index.ts";
import { connectAdmin, planInstall, runPlan, WORKER_USER } from "../install/index.ts";
import { serverUrl, skipUnless } from "../testing/index.ts";

/**
 * Keys as the user writes them on a real MongoDB replica set. Two collections are installed by the
 * install plan: one keyed by ObjectIds (MongoDB's default `_id`), one by numbers, with a string
 * `"1"` beside the number 1 (MongoDB lets one collection hold both). The engine's connector answers
 * every document as the worker does (read the state, write the decision under its hash), then each
 * is found as `facetdb explain` finds it: the `_id` typed as the user writes it, read into the key
 * by the engine's `keyText`, the decision read back by `current`, and the key printed back in the
 * very form that was typed.
 */

const PASSWORD = "facetdb-worker-test-password";
const PROJECT = { id: "proj_listings", name: "Listings" };
const FIELDS = ["title"] as const;
const BY_OBJECT_ID = "listings_oid";
const BY_NUMBER = "listings_num";

const questionSet: QuestionSet = {
  questions: CONTRACT_QUESTIONS,
  read: [...FIELDS],
  model: "jev-1.14.0",
  thresholds: {},
};

const decided: RecordDecision = {
  decisions: { not_priority: { kind: "decided", value: true, probabilityOrConfidence: 0.96 } },
  status: "done",
};

function target(collection: string): EngineTarget {
  return {
    project: PROJECT,
    source: collection,
    table: collection,
    storage: "inline",
    onChange: "keep",
    questionSet,
    urlVariable: "LISTINGS_URL",
  };
}

describe.skipIf(skipUnless("MONGODB_URL"))("MongoDB keys as the user writes them", () => {
  const clock = new FakeClock(Date.parse("2026-11-04T09:00:00.000Z"));
  const deps: EngineDeps = { clock, allowInsecure: false, storeShared: false };
  const engine = createMongoEngine({ warn: () => undefined });
  const name = `facetdb_t087_${process.pid}`;
  const urls = { admin: "", worker: "" };
  let root: MongoClient;
  let db: Db;
  const opened: OpenConnector[] = [];

  beforeAll(async () => {
    const admin = new URL(serverUrl("MONGODB_URL"));
    admin.pathname = `/${name}`;
    const worker = new URL(admin);
    worker.username = WORKER_USER;
    worker.password = PASSWORD;
    urls.admin = admin.toString();
    urls.worker = worker.toString();
    root = new MongoClient(serverUrl("MONGODB_URL"));
    db = root.db(name);
    await drop();
    for (const collection of [BY_OBJECT_ID, BY_NUMBER]) {
      await db.createCollection(collection);
      const planned = await planInstall(connectAdmin, target(collection), urls.admin, {
        ...deps,
        workerPassword: PASSWORD,
      });
      if (!planned.ok) {
        throw new Error(`install refused: ${planned.refusal.message}`);
      }
      const ran = await runPlan(connectAdmin, target(collection), planned.plan, urls.admin, {
        ...deps,
        workerPassword: PASSWORD,
      });
      if (ran.stopped !== undefined) {
        throw new Error(`install stopped: ${JSON.stringify(ran.stopped)}`);
      }
    }
  });

  afterAll(async () => {
    for (const connector of opened.splice(0)) {
      await connector.close();
    }
    try {
      await drop();
    } finally {
      await root.close();
    }
  });

  async function drop(): Promise<void> {
    await db.command({ dropAllUsersFromDatabase: 1 });
    await db.command({ dropAllRolesFromDatabase: 1 });
    await db.dropDatabase();
  }

  /** The engine's own hook, as the CLI reaches it: `DatabaseEngine.keyText`. */
  function keyText(): KeyText {
    if (engine.keyText === undefined) {
      throw new Error("the MongoDB engine has no keyText: explain would print its tagged keys");
    }
    return engine.keyText;
  }

  /**
   * The worker's half: the engine opens the connector under the worker login, which reads every
   * document of the collection (one scan page) and writes its decision under the state hash read.
   */
  async function answerAll(collection: string): Promise<{
    readonly connector: OpenConnector;
    readonly keys: readonly string[];
  }> {
    const connector = await engine.open(target(collection), urls.worker, {
      ...deps,
      workerId: `w-${collection}`,
    });
    opened.push(connector);
    const page = await connector.scan(null);
    expect(page.next).toBeNull();
    for (const row of page.rows) {
      expect((await connector.write(row.key, decided, row.hash)).written).toBe(true);
    }
    return { connector, keys: page.rows.map((row) => row.key) };
  }

  /** `facetdb explain <source> <typed>`'s half: the typed `_id` to the key, then `current`. */
  async function explain(connector: OpenConnector, typed: string) {
    const key = keyText().fromText(typed);
    const current = (await connector.current([key])).get(key);
    return { key, current, printed: keyText().toText(key) };
  }

  it("is the engine's keyText, the one the package exports", () => {
    expect(engine.keyText).toBe(MONGO_KEY_TEXT);
  });

  it("finds an ObjectId document typed as its 24 hex characters, and prints it so", async () => {
    const ids = [new ObjectId(), new ObjectId()];
    await db
      .collection<{ _id: ObjectId; title: string }>(BY_OBJECT_ID)
      .insertMany(ids.map((_id, at) => ({ _id, title: `Listing ${at}` })));

    const { connector, keys } = await answerAll(BY_OBJECT_ID);

    // The store and the queue keep the tagged key.
    expect([...keys].sort()).toEqual(ids.map((id) => `oid:${id.toHexString()}`).sort());
    for (const id of ids) {
      const typed = id.toHexString();
      const found = await explain(connector, typed);
      expect(found.key).toBe(`oid:${typed}`);
      expect(found.current).toMatchObject({
        status: "done",
        decisions: { not_priority: { kind: "decided", value: true } },
      });
      expect(found.printed).toBe(typed);
    }
    // The hex typed in capitals names the same document.
    const [first] = ids;
    if (first === undefined) {
      throw new Error("the fixture has two ObjectIds");
    }
    const upper = await explain(connector, first.toHexString().toUpperCase());
    expect(upper.current?.status).toBe("done");
    expect(upper.printed).toBe(first.toHexString());
  });

  it("finds a number typed bare, and a string _id beside it by the one escape, each printed as typed", async () => {
    await db.collection<{ _id: number | string; title: string }>(BY_NUMBER).insertMany([
      { _id: 1, title: "The number one" },
      { _id: 2.5, title: "Two and a half" },
      { _id: "1", title: "The string one" },
      { _id: "listing-42", title: "A string key" },
    ]);

    const { connector, keys } = await answerAll(BY_NUMBER);

    expect([...keys].sort()).toEqual(["1", "listing-42", "n:1", "n:2.5"]);
    for (const [typed, key] of [
      ["1", "n:1"],
      ["2.5", "n:2.5"],
      ["s:1", "1"],
      ["listing-42", "listing-42"],
    ] as const) {
      const found = await explain(connector, typed);
      expect(found.key).toBe(key);
      expect(found.current?.status).toBe("done");
      expect(found.printed).toBe(typed);
    }
    // What the worker's log prints for every key: never a tag but the one escape.
    expect(keys.map((key) => keyText().toText(key)).sort()).toEqual([
      "1",
      "2.5",
      "listing-42",
      "s:1",
    ]);
    // A script that typed the tagged key still finds the record.
    expect((await explain(connector, "n:1")).current?.status).toBe("done");
    // A number no document has is found nowhere, and says so by its absence.
    expect((await explain(connector, "3")).current).toBeUndefined();
  });
});
