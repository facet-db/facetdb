import type {
  EngineDeps,
  EngineTarget,
  KeyText,
  OpenConnector,
  QuestionSet,
  RecordDecision,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock } from "@facetdb/core/testing";
import { type Db, MongoClient } from "mongodb";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectAdmin, planInstall, runPlan, WORKER_USER } from "../install/index.ts";
import { serverUrl, skipUnless } from "../testing/index.ts";
import { createMongoEngine } from "./index.ts";

/**
 * The `_id` type in the marker on a real MongoDB replica set: the install reads it from the
 * documents or the validator and records it, an install from an earlier version gets it on the next
 * migrate, and the engine's `keyTextOf`, the door `facetdb explain` and `facetdb export` read keys
 * through, takes `1001` bare for the string `_id` "1001", finds the record by `current`, and prints
 * it back as `1001`, never `s:1001`. A mixed collection keeps the untyped form.
 */

const PASSWORD = "facetdb-worker-test-password";
const PROJECT = { id: "proj_listings", name: "Listings" };

const questionSet: QuestionSet = {
  questions: CONTRACT_QUESTIONS,
  read: ["title"],
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

describe.skipIf(skipUnless("MONGODB_URL"))("the _id type in the marker, on MongoDB", () => {
  const clock = new FakeClock(Date.parse("2026-11-05T09:00:00.000Z"));
  const deps: EngineDeps = { clock, allowInsecure: false, storeShared: false };
  const engine = createMongoEngine({ warn: () => undefined });
  const name = `facetdb_t124_${process.pid}`;
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

  /** `facetdb migrate`'s half: the plan, then its run as printed. */
  async function migrate(collection: string) {
    const options = { ...deps, workerPassword: PASSWORD };
    const planned = await planInstall(connectAdmin, target(collection), urls.admin, options);
    if (!planned.ok) {
      throw new Error(`install refused: ${planned.refusal.message}`);
    }
    const ran = await runPlan(connectAdmin, target(collection), planned.plan, urls.admin, options);
    if (ran.stopped !== undefined) {
      throw new Error(`install stopped: ${JSON.stringify(ran.stopped)}`);
    }
    return planned.plan;
  }

  /** A collection's marker in `facetdb_meta`, as install writes it. */
  async function markerOf(collection: string) {
    return db
      .collection<{ _id: string; keyType?: string; installedAt?: Date }>("facetdb_meta")
      .findOne({ _id: `owner:${collection}` });
  }

  async function keyTypeOf(collection: string): Promise<string | undefined> {
    return (await markerOf(collection))?.keyType;
  }

  /** The engine's door for keys, as explain and export reach it. */
  async function keyText(collection: string): Promise<KeyText> {
    if (engine.keyTextOf === undefined) {
      throw new Error("the MongoDB engine has no keyTextOf");
    }
    return engine.keyTextOf(target(collection), urls.worker, { allowInsecure: false });
  }

  /** The worker's half: every document read and answered under its state hash. */
  async function answerAll(collection: string): Promise<OpenConnector> {
    const connector = await engine.open(target(collection), urls.worker, {
      ...deps,
      workerId: `w-${collection}`,
    });
    opened.push(connector);
    const page = await connector.scan(null);
    for (const row of page.rows) {
      expect((await connector.write(row.key, decided, row.hash)).written).toBe(true);
    }
    return connector;
  }

  /** `facetdb explain <source> <typed>`: the key read in the recorded type, then `current`. */
  async function explain(collection: string, connector: OpenConnector, typed: string) {
    const text = await keyText(collection);
    const key = text.fromText(typed);
    return { key, current: (await connector.current([key])).get(key), printed: text.toText(key) };
  }

  it("records strings, and explain and export take and print 1001 bare", async () => {
    const collection = "listings_str";
    await db.collection<{ _id: string; title: string }>(collection).insertMany([
      { _id: "1001", title: "A boat" },
      { _id: "listing-42", title: "A car" },
    ]);

    const plan = await migrate(collection);

    expect(plan.statements[0]?.text).toContain('keyType: "string"');
    expect(await keyTypeOf(collection)).toBe("string");
    const connector = await answerAll(collection);
    const found = await explain(collection, connector, "1001");
    // The store and the queue keep the key as the connector wrote it: the string itself.
    expect(found.key).toBe("1001");
    expect(found.current?.status).toBe("done");
    // What export writes in record_key, and every line of explain prints.
    expect(found.printed).toBe("1001");
    // The escape typed before 124 still finds it.
    expect((await explain(collection, connector, "s:1001")).current?.status).toBe("done");
    // A second migrate has nothing to do.
    expect((await migrate(collection)).statements).toEqual([]);
  });

  it("adds the type to an install from an earlier version on the next migrate, as one marker field", async () => {
    const collection = "listings_old";
    await db
      .collection<{ _id: string; title: string }>(collection)
      .insertMany([{ _id: "2001", title: "A tent" }]);
    await migrate(collection);
    const installedAt = (await markerOf(collection))?.installedAt;
    expect(installedAt).toBeInstanceOf(Date);
    // The marker as an earlier version wrote it.
    await db
      .collection<{ _id: string; keyType?: string }>("facetdb_meta")
      .updateOne({ _id: `owner:${collection}` }, { $unset: { keyType: "" } });
    const connector = await answerAll(collection);
    expect((await explain(collection, connector, "2001")).current).toBeUndefined();

    const plan = await migrate(collection);

    expect(plan.statements.map((statement) => statement.text)).toEqual([
      `db.getSiblingDB("${name}").runCommand({ findAndModify: "facetdb_meta", query: { _id: "owner:${collection}", project: "proj_listings" }, update: { $set: { keyType: "string" } } })`,
    ]);
    expect(plan.notes[0]).toContain("changes no document");
    const marker = await markerOf(collection);
    expect(marker?.keyType).toBe("string");
    expect(marker?.installedAt).toEqual(installedAt);
    const found = await explain(collection, connector, "2001");
    expect(found.current?.status).toBe("done");
    expect(found.printed).toBe("2001");
  });

  it("records mixed for a number and a string beside it, and keeps the untyped form", async () => {
    const collection = "listings_mixed";
    await db.collection<{ _id: number | string; title: string }>(collection).insertMany([
      { _id: 1, title: "The number one" },
      { _id: "1", title: "The string one" },
    ]);

    const plan = await migrate(collection);

    expect(await keyTypeOf(collection)).toBe("mixed");
    expect(plan.notes.join("\n")).toContain('keyType "mixed"');
    const connector = await answerAll(collection);
    expect(await explain(collection, connector, "1")).toMatchObject({
      key: "n:1",
      printed: "1",
    });
    expect(await explain(collection, connector, "s:1")).toMatchObject({
      key: "1",
      printed: "s:1",
    });
  });

  it("takes the type the validator declares, and records none on an empty collection without one", async () => {
    await db.createCollection("listings_declared", {
      validator: {
        $jsonSchema: { bsonType: "object", properties: { _id: { bsonType: "string" } } },
      },
    });
    await db.createCollection("listings_empty");

    await migrate("listings_declared");
    const empty = await migrate("listings_empty");

    expect(await keyTypeOf("listings_declared")).toBe("string");
    expect(await keyTypeOf("listings_empty")).toBeUndefined();
    expect(empty.notes.join("\n")).toContain("has no document yet");
    expect((await keyText("listings_declared")).fromText("3001")).toBe("3001");
    expect((await keyText("listings_empty")).fromText("3001")).toBe("n:3001");
  });
});
