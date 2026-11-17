import { stateHash } from "@facetdb/core";
import { Decimal128, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import { idOf, keyOf, stateOf, stateProjection, stateText, valueAt } from "./keys.ts";

/**
 * Keys and state text for the MongoDB connector: an `_id` as a tagged key and back in its one
 * written form, and a state field as the text `stateHash` reads, canonical JSON inside.
 */

const HEX = "65f1a2b3c4d5e6f708192a3b";

describe("keys", () => {
  it.each([
    [new ObjectId(HEX), `oid:${HEX}`],
    [42, "n:42"],
    [-1.5, "n:-1.5"],
    [-0, "n:0"],
    [new Int32(7), "n:7"],
    [Long.fromNumber(9), "n:9"],
    ["listing-42", "listing-42"],
    ["", ""],
    ["oid:x", "s:oid:x"],
    ["n:42", "s:n:42"],
    ["s:x", "s:s:x"],
  ])("%s is the key %s, and the key reads back as it", (id, key) => {
    expect(keyOf(id)).toBe(key);
    const back = idOf(key);
    expect(back instanceof ObjectId ? `oid:${back.toHexString()}` : keyOf(back)).toBe(key);
  });

  it("gives no key to an _id of another type, or a number past 2^53", () => {
    for (const id of [
      new Date(0),
      Decimal128.fromString("1.5"),
      { a: 1 },
      Number.NaN,
      2 ** 60,
      Long.fromString("9007199254740993"),
      true,
      null,
    ]) {
      expect(keyOf(id)).toBeUndefined();
    }
  });

  it("names a document only in a key's one written form", () => {
    for (const key of [
      "n:042",
      "n:",
      "n:1e3",
      "s:abc",
      `oid:${HEX.toUpperCase()}`,
      "oid:12",
      "n:x",
    ]) {
      expect(idOf(key)).toBeUndefined();
    }
    expect(idOf("n:1000")).toBe(1000);
    expect(idOf("s:s:abc")).toBe("s:abc");
  });
});

describe("state text", () => {
  it("is the string itself, NULL for a missing field, and canonical JSON's text otherwise", () => {
    expect(stateText("Refund")).toBe("Refund");
    expect(stateText(undefined)).toBeNull();
    expect(stateText(null)).toBeNull();
    expect(stateText(12.5)).toBe("12.5");
    expect(stateText(true)).toBe("true");
    expect(stateText(new Date("2026-11-04T09:00:00.000Z"))).toBe("2026-11-04T09:00:00.000Z");
    expect(stateText(new ObjectId(HEX))).toBe(HEX);
    expect(stateText(Decimal128.fromString("12.50"))).toBe("12.50");
    expect(stateText(Long.fromString("9007199254740993"))).toBe("9007199254740993");
    expect(stateText(["a", 1, null])).toBe('["a",1,null]');
    expect(
      stateText({ b: new Date("2026-11-04T09:00:00.000Z"), a: { d: new ObjectId(HEX), c: 1 } }),
    ).toBe(`{"a":{"c":1,"d":"${HEX}"},"b":"2026-11-04T09:00:00.000Z"}`);
  });

  it("hashes two reads of one document alike whatever order its keys came in", () => {
    const fields = ["address"];
    const one = stateOf({ address: { city: "Paris", zip: "75001" } }, fields);
    const two = stateOf({ address: { zip: "75001", city: "Paris" } }, fields);
    expect(stateHash(fields, one)).toBe(stateHash(fields, two));
    expect(
      stateHash(fields, stateOf({ address: { city: "Lyon", zip: "75001" } }, fields)),
    ).not.toBe(stateHash(fields, one));
  });

  it("reads a dotted field MongoDB's way, through arrays, and projects only first segments", () => {
    const document = { address: { city: "Paris" }, items: [{ sku: 1 }, { sku: 2 }, {}] };
    expect(valueAt(document, ["address", "city"])).toBe("Paris");
    expect(valueAt(document, ["items", "sku"])).toEqual([1, 2]);
    expect(valueAt(document, ["address", "zip"])).toBeUndefined();
    expect(stateOf(document, ["address.city", "items.sku", "missing"])).toEqual({
      "address.city": "Paris",
      "items.sku": "[1,2]",
      missing: null,
    });
    expect(stateProjection(["address.city", "address", "title"])).toEqual({
      address: 1,
      title: 1,
    });
  });
});
