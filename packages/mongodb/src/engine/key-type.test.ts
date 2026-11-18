import type {
  EnginePlan,
  EngineTarget,
  InstallOptions,
  PlanResult,
  QuestionSet,
} from "@facetdb/core";
import { CONTRACT_QUESTIONS, FakeClock } from "@facetdb/core/testing";
import { ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { keyFromText, keyOf, keyToText } from "../connector/index.ts";
import { KEY_TYPES, type KeyType, parseLine } from "../install/index.ts";
import { FakeMongo, FakeWorkerMongo } from "../testing/index.ts";
import { createMongoEngine, MONGO_KEY_TEXT, mongoKeyText } from "./index.ts";

/**
 * The `_id` type in the marker over fakes: the install plan reads it (the validator's declared
 * type, else one document's, checked for any other) and writes it in the marker, says `mixed` and
 * no-document plainly, adds it to an install from an earlier version as one field and a note, and
 * never reads it again; a key is read and printed in the recorded type, the tags still taken; the
 * engine's `keyTextOf` reads the marker under the worker login.
 */

const ADMIN = "mongodb://127.0.0.1:27017/app";
const WORKER = "mongodb://facetdb_worker:pw@127.0.0.1:27017/app";
const HEX = "65f1a2b3c4d5e6f708192a3b";

const questionSet: QuestionSet = {
  questions: CONTRACT_QUESTIONS,
  read: ["title"],
  model: "jev-1.14.0",
  thresholds: {},
};

const target: EngineTarget = {
  project: { id: "proj_listings", name: "Listings" },
  source: "listings",
  table: "listings",
  storage: "inline",
  onChange: "keep",
  questionSet,
  urlVariable: "LISTINGS_URL",
};

const options: InstallOptions = {
  clock: new FakeClock(0),
  allowInsecure: false,
  storeShared: false,
  workerPassword: "a-long-random-password",
};

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

/** The engine over a fake server: the plan for `app.listings`, and its run. */
function engineOn(server: FakeMongo) {
  const engine = createMongoEngine({ connect: server.connect, warn: () => undefined });
  return {
    plan: async () => planOf(await engine.planInstall(target, ADMIN, options)),
    run: async (plan: EnginePlan) => {
      const result = await engine.run(target, plan, ADMIN, options);
      expect(result.stopped).toBeUndefined();
    },
  };
}

/** `app.listings` with documents whose `_id`s have these BSON types, in natural order. */
const serverWith = (types: readonly string[]) =>
  new FakeMongo().collection("app", "listings").ids("app", "listings", types);

/** The marker line's `$set`, read back from the printed line as `run` reads it. */
function markerSet(plan: EnginePlan): unknown {
  const [first] = plan.statements;
  if (first === undefined) {
    throw new Error("the plan has no statement");
  }
  const update = parseLine(first.text).command["update"];
  return typeof update === "object" && update !== null && !Array.isArray(update)
    ? (update as Record<string, unknown>)["$set"]
    : undefined;
}

const STRING_NOTE =
  'The marker records that app.listings is keyed by strings, as its documents hold: facetdb explain, facetdb export and the review take and print each _id as you write it, 1001 for the string "1001".';

const UNTYPED =
  'an ObjectId as its 24 hex characters, a number as its digits, a string as itself, and a string _id that reads as an ObjectId or a number written s:<id> (s:1001 for the string "1001")';

describe("the install records the _id type in the marker", () => {
  it.each([
    [["string", "string"], "string"],
    [["objectId"], "objectId"],
    [["int", "double", "long"], "number"],
    [["string", "int"], "mixed"],
    [["objectId", "string"], "mixed"],
    // A Date or a Decimal128 `_id` has no key at all: the keys keep the untyped rule.
    [["date"], "mixed"],
    [["decimal"], "mixed"],
  ] as const)("documents keyed by %j: %s", async (types, keyType) => {
    const server = serverWith(types);
    const { plan, run } = engineOn(server);
    const planned = await plan();
    expect(markerSet(planned)).toEqual({
      project: "proj_listings",
      source: "listings",
      keyType,
    });
    expect(planned.statements[0]?.purpose).toBe("marker");
    await run(planned);
    expect(server.database("app").markers.get("owner:listings")?.["keyType"]).toBe(keyType);
    // Recorded once: the next plan is empty and reads no type.
    const before = server.commandNames().length;
    expect((await plan()).statements).toEqual([]);
    const reads = server.commandNames().slice(before);
    expect(reads.some((read) => /^(aggregate|listCollections) /.test(read))).toBe(false);
  });

  it("says what the recorded type changes on the terminal, and says mixed plainly", async () => {
    expect((await engineOn(serverWith(["string"])).plan()).notes).toContain(STRING_NOTE);
    expect((await engineOn(serverWith(["string", "int"])).plan()).notes).toContain(
      `The _ids its documents hold are of more than one type, or of one FacetDB makes no key of, so the marker records keyType "mixed", and keys keep the form they have without a type: ${UNTYPED}.`,
    );
  });

  it("takes the type a validator declares, without reading a document", async () => {
    const server = new FakeMongo().collectionOptions("app", "listings", {
      validator: { $jsonSchema: { properties: { _id: { bsonType: "string" } } } },
    });
    const planned = await engineOn(server).plan();
    expect(markerSet(planned)).toMatchObject({ keyType: "string" });
    expect(planned.notes).toContain(
      'The marker records that app.listings is keyed by strings, as its validator declares: facetdb explain, facetdb export and the review take and print each _id as you write it, 1001 for the string "1001".',
    );
    expect(server.commandNames().some((name) => name.startsWith("aggregate "))).toBe(false);
  });

  it.each([
    [{ bsonType: ["int", "long"] }, "number"],
    [{ type: "integer" }, "number"],
    [{ bsonType: ["string", "int"] }, "mixed"],
    [{ bsonType: "objectId" }, "objectId"],
  ] as const)("reads the declared %j as %s", async (declared, keyType) => {
    const server = new FakeMongo().collectionOptions("app", "listings", {
      validator: { $jsonSchema: { bsonType: "object", properties: { _id: declared } } },
    });
    expect(markerSet(await engineOn(server).plan())).toMatchObject({ keyType });
  });

  it("reads the documents when the validator would let another type in, or declares no _id", async () => {
    for (const options of [
      {
        validator: { $jsonSchema: { properties: { _id: { bsonType: "string" } } } },
        validationAction: "warn",
      },
      {
        validator: { $jsonSchema: { properties: { _id: { bsonType: "string" } } } },
        validationLevel: "off",
      },
      { validator: { $jsonSchema: { properties: { title: { bsonType: "string" } } } } },
      { validator: { title: { $type: "string" } } },
    ]) {
      const server = serverWith(["objectId"]).collectionOptions("app", "listings", options);
      expect(markerSet(await engineOn(server).plan())).toMatchObject({ keyType: "objectId" });
    }
  });

  it("records none on a collection with no document, says so once, and records it on a later migrate", async () => {
    const server = new FakeMongo().collection("app", "listings");
    const { plan, run } = engineOn(server);
    const first = await plan();
    expect(markerSet(first)).toEqual({ project: "proj_listings", source: "listings" });
    expect(first.notes).toContain(
      `app.listings has no document yet, and no validator declares the type of its _id, so the marker records none: keys are read and printed as they are without one (${UNTYPED}). Run facetdb migrate again once it has documents, and it records the type.`,
    );
    await run(first);
    // Still empty: nothing to do, and nothing said again.
    expect(await plan()).toMatchObject({ statements: [], notes: [] });

    server.ids("app", "listings", ["string"]);
    const later = await plan();
    expect(later.statements.map((statement) => statement.text)).toEqual([
      'db.getSiblingDB("app").runCommand({ findAndModify: "facetdb_meta", query: { _id: "owner:listings", project: "proj_listings" }, update: { $set: { keyType: "string" } } })',
    ]);
    expect(later.statements[0]?.purpose).toBe("marker");
    expect(later.notes).toEqual([
      `app.listings was installed before FacetDB recorded the type of a collection's _id: this migrate adds keyType "string" to its marker in facetdb_meta, and changes no document. ${STRING_NOTE}`,
    ]);
    await run(later);
    // The one field: the install time a first change stream starts at stays as it was.
    expect(server.database("app").markers.get("owner:listings")).toEqual({
      _id: "owner:listings",
      project: "proj_listings",
      source: "listings",
      installedAt: new Date(0),
      keyType: "string",
    });
    expect(await plan()).toMatchObject({ statements: [], notes: [] });
  });

  it("adds the type to an install from an earlier version as one marker update, never a destructive command", async () => {
    const server = serverWith(["string"]);
    const { plan, run } = engineOn(server);
    await run(await plan());
    // The marker as an earlier version wrote it: no keyType.
    const marker = server.database("app").markers.get("owner:listings");
    delete marker?.["keyType"];

    const upgrade = await plan();
    expect(upgrade.statements).toHaveLength(1);
    const line = parseLine(upgrade.statements[0]?.text ?? "");
    // No upsert: a marker gone or another project's since the plan was read is left alone.
    expect(line.command).toEqual({
      findAndModify: "facetdb_meta",
      query: { _id: "owner:listings", project: "proj_listings" },
      update: { $set: { keyType: "string" } },
    });
    expect(upgrade.removes).toEqual([]);
    await run(upgrade);
    expect(server.database("app").markers.get("owner:listings")?.["keyType"]).toBe("string");
  });

  it("lets a type it does not know in the marker stop no migrate, prune, uninstall or another project's refusal", async () => {
    const server = serverWith(["string"]);
    const { plan, run } = engineOn(server);
    await run(await plan());
    const marker = server.database("app").markers.get("owner:listings");
    if (marker !== undefined) {
      marker["keyType"] = "uuid";
    }
    // Recorded, whatever its value: the migrate neither reads the type again nor rewrites it.
    const before = server.commandNames().length;
    expect(await plan()).toMatchObject({ statements: [], notes: [] });
    expect(
      server
        .commandNames()
        .slice(before)
        .some((read) => read.startsWith("aggregate ")),
    ).toBe(false);
    const engine = createMongoEngine({ connect: server.connect, warn: () => undefined });
    expect((await engine.planPrune(target, ADMIN, options)).ok).toBe(true);
    const uninstall = { ...options, purge: false, alsoUninstalling: [] };
    expect((await engine.planUninstall(target, ADMIN, uninstall)).ok).toBe(true);
    const theirs = await engine.planInstall(
      { ...target, project: { id: "proj_other", name: "Other" } },
      ADMIN,
      options,
    );
    expect(theirs).toMatchObject({ ok: false, refusal: { code: "migrate-refused" } });
  });

  it("bounds the look for an _id of another type, and past it records none and says so", async () => {
    const server = serverWith(["string"]);
    server.slowIdScan = true;
    const planned = await engineOn(server).plan();
    expect(markerSet(planned)).toEqual({ project: "proj_listings", source: "listings" });
    expect(planned.notes).toContain(
      `FacetDB stopped looking through app.listings for an _id of another type after 30 seconds, so the marker records no type: keys are read and printed as they are without one (${UNTYPED}). Declare the type of _id in the collection's validator ($jsonSchema, properties._id.bsonType), which FacetDB reads instead of the documents, or run facetdb migrate again at a quieter time.`,
    );
    const scan = server
      .commands()
      .find((command) => command["find"] === "listings" && command["maxTimeMS"] !== undefined);
    expect(scan?.["maxTimeMS"]).toBe(30_000);
  });
});

describe("keys in the recorded type", () => {
  it("reads and prints a numeric string bare in a string collection, and only there", () => {
    expect(keyFromText("1001", "string")).toBe("1001");
    expect(keyToText("1001", "string")).toBe("1001");
    expect(keyFromText(HEX, "string")).toBe(HEX);
    expect(keyToText(HEX, "string")).toBe(HEX);
    // Without a type, or mixed, the untyped rule: the escape.
    for (const type of [undefined, "mixed", "number", "objectId"] as const) {
      expect(keyFromText("1001", type)).toBe("n:1001");
      expect(keyToText("1001", type)).toBe("s:1001");
    }
  });

  it("still takes every tag, and prints a key of another type with its own", () => {
    expect(keyFromText("s:1001", "string")).toBe("1001");
    expect(keyFromText("n:5", "string")).toBe("n:5");
    expect(keyFromText(`oid:${HEX}`, "string")).toBe(`oid:${HEX}`);
    // A document of another type, added after the type was recorded.
    expect(keyToText("n:5", "string")).toBe("n:5");
    expect(keyToText(`oid:${HEX}`, "string")).toBe(`oid:${HEX}`);
    // A string that spells a tag keeps the one escape; the empty string prints s:.
    expect(keyToText("s:n:5", "string")).toBe("s:n:5");
    expect(keyFromText("s:n:5", "string")).toBe("s:n:5");
    expect(keyToText("", "string")).toBe("s:");
    expect(keyFromText("s:", "string")).toBe("");
  });

  it("reads ObjectIds and numbers as the rule does in their own collections", () => {
    expect(keyFromText(HEX, "objectId")).toBe(`oid:${HEX}`);
    expect(keyToText(`oid:${HEX}`, "objectId")).toBe(HEX);
    expect(keyFromText("1001", "number")).toBe("n:1001");
    expect(keyToText("n:1001", "number")).toBe("1001");
    expect(keyFromText("-2.5", "number")).toBe("n:-2.5");
  });

  it("prints every key as a text that reads back as it, under every type, never two alike", () => {
    const ids: unknown[] = [
      "1001",
      "",
      "listing-42",
      "n:5",
      "oid:x",
      "s:",
      HEX,
      HEX.toUpperCase(),
      "-2.5",
      "1e-7",
      "042",
      new ObjectId(HEX),
      new ObjectId(),
      1001,
      -2.5,
      0,
      1e-7,
    ];
    for (const type of [undefined, ...KEY_TYPES] satisfies readonly (KeyType | undefined)[]) {
      const printed = new Map<string, string>();
      for (const id of ids) {
        const key = keyOf(id);
        if (key === undefined) {
          throw new Error(`no key for ${String(id)}`);
        }
        const text = keyToText(key, type);
        expect(keyFromText(text, type), `${key} printed ${text} under ${type}`).toBe(key);
        const other = printed.get(text);
        expect(other === undefined || other === key, `${key} and ${other} print ${text}`).toBe(
          true,
        );
        printed.set(text, key);
      }
    }
  });

  it("is the untyped key text without a type, and words the string form for a string collection", () => {
    expect(mongoKeyText(undefined).toText("1001")).toBe(MONGO_KEY_TEXT.toText("1001"));
    expect(mongoKeyText(undefined).form).toBe(MONGO_KEY_TEXT.form);
    expect(mongoKeyText("string").form).toContain('1001 for the _id "1001"');
  });
});

describe("the engine's keyTextOf: the marker's type under the worker login", () => {
  function workerWith(marker: Record<string, unknown> | undefined): FakeWorkerMongo {
    const fake = new FakeWorkerMongo();
    if (marker !== undefined) {
      fake.insert("facetdb_meta", { _id: "owner:listings", project: "proj_listings", ...marker });
    }
    return fake;
  }

  const warnings: string[] = [];
  const keyTextOn = (fake: FakeWorkerMongo, url = WORKER) => {
    const engine = createMongoEngine({
      worker: fake.connect,
      warn: (line) => warnings.push(line),
    });
    if (engine.keyTextOf === undefined) {
      throw new Error("the MongoDB engine has no keyTextOf");
    }
    return engine.keyTextOf(target, url, { allowInsecure: false });
  };

  it("takes and prints 1001 bare on a collection whose marker records strings", async () => {
    const fake = workerWith({ keyType: "string" });
    const keyText = await keyTextOn(fake);
    expect(keyText.fromText("1001")).toBe("1001");
    expect(keyText.toText("1001")).toBe("1001");
    expect(keyText.fromText("s:1001")).toBe("1001");
    // One find of the marker on a connection of its own, let go of after it.
    expect(fake.calls.map((call) => call.kind)).toEqual(["connect", "find", "close"]);
  });

  it("is the untyped rule where the marker records no type, or there is no marker", async () => {
    for (const fake of [workerWith({}), workerWith({ keyType: "mixed" }), workerWith(undefined)]) {
      const keyText = await keyTextOn(fake);
      expect(keyText.fromText("1001")).toBe("n:1001");
      expect(keyText.toText("1001")).toBe("s:1001");
      expect(keyText.form).toBe(MONGO_KEY_TEXT.form);
    }
  });

  it("reads a type it does not know as none, the old form, with a warning saying how to record it again", async () => {
    warnings.length = 0;
    const keyText = await keyTextOn(workerWith({ keyType: 7 }));
    expect(keyText.fromText("1001")).toBe("n:1001");
    expect(keyText.toText("1001")).toBe("s:1001");
    expect(warnings).toEqual([
      "the marker of app.listings records the _id type 7, which FacetDB does not know (it writes objectId, number, string, mixed), so keys are read and printed as without a type, a string _id that reads as a number or an ObjectId written s:<id>; remove the field keyType from the marker in facetdb_meta and run facetdb migrate to read the type again",
    ]);
  });

  it("refuses a plaintext URL to another host before connecting", async () => {
    const fake = workerWith({ keyType: "string" });
    await expect(
      keyTextOn(fake, "mongodb://facetdb_worker:pw@db.example.com/app?tls=false"),
    ).rejects.toMatchObject({
      refusal: {
        message:
          "LISTINGS_URL reaches db.example.com with tls=false, so the password in it would travel in the clear; no connection was made",
      },
    });
    expect(fake.calls).toEqual([]);
  });
});
