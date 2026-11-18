import { stateHash } from "@facetdb/core";
import { Decimal128, Int32, Long, ObjectId } from "mongodb";
import { describe, expect, it } from "vitest";
import {
  idOf,
  keyFromText,
  keyOf,
  keyToText,
  stateOf,
  stateProjection,
  stateText,
  valueAt,
} from "./keys.ts";

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

describe("keys as the user writes them", () => {
  it.each([
    // The three types, each as its _id is written: never oid: or n: on the terminal.
    [new ObjectId(HEX), HEX],
    [1, "1"],
    [42, "42"],
    [-1.5, "-1.5"],
    // Below 1e-6 JavaScript prints an exponent, and the number reads back as a number.
    [1e-7, "1e-7"],
    [-1e-7, "-1e-7"],
    [1.5e-10, "1.5e-10"],
    [5e-324, "5e-324"],
    ["listing-42", "listing-42"],
    // The empty string prints as the escape alone, so a log line never ends on nothing.
    ["", "s:"],
    // A string the rule would read as another type keeps the one escape, so it reads back.
    ["1", "s:1"],
    ["-1.5", "s:-1.5"],
    ["1e-7", "s:1e-7"],
    ["-1e-7", "s:-1e-7"],
    ["1.5e-10", "s:1.5e-10"],
    ["5e-324", "s:5e-324"],
    [HEX, `s:${HEX}`],
    ["n:42", "s:n:42"],
    [`oid:${HEX}`, `s:oid:${HEX}`],
    ["s:x", "s:s:x"],
    // A tag-like string that names no document as a tag is shown bare: it can only be the string.
    ["oid:x", "oid:x"],
    ["n:042", "n:042"],
    // Strings the rule reads as strings: a leading zero, a trailing zero, 23 hex characters.
    ["042", "042"],
    ["1.50", "1.50"],
    [HEX.slice(1), HEX.slice(1)],
  ])("%s prints as %s, which reads back as its key", (id, text) => {
    const key = keyOf(id);
    if (key === undefined) {
      throw new Error(`the fixture ${String(id)} has no key`);
    }
    expect(keyToText(key)).toBe(text);
    expect(keyFromText(text)).toBe(key);
  });

  it("reads 24 hex characters as an ObjectId, a number in its own form as a number, else a string", () => {
    expect(keyFromText(HEX)).toBe(`oid:${HEX}`);
    expect(keyFromText(HEX.toUpperCase())).toBe(`oid:${HEX}`);
    expect(keyFromText("1")).toBe("n:1");
    expect(keyFromText("0")).toBe("n:0");
    expect(keyFromText("-2.5")).toBe("n:-2.5");
    expect(keyFromText("listing-42")).toBe("listing-42");
    expect(keyFromText("042")).toBe("042");
    expect(keyFromText("1e3")).toBe("1e3");
    expect(keyFromText("1e-7")).toBe("n:1e-7");
    // Not JavaScript's own form of the number: a string.
    expect(keyFromText("1E-7")).toBe("1E-7");
    expect(keyFromText("10e-8")).toBe("10e-8");
    expect(keyFromText("1e-07")).toBe("1e-07");
    expect(keyFromText("-0")).toBe("-0");
    expect(keyFromText(" 1")).toBe(" 1");
    // Past 2^53 a number has no key: the text is the string it spells.
    expect(keyFromText("9007199254740993")).toBe("9007199254740993");
  });

  it("takes the tagged form as written, so a script that typed it keeps finding its records", () => {
    expect(keyFromText(`oid:${HEX}`)).toBe(`oid:${HEX}`);
    expect(keyFromText("n:1")).toBe("n:1");
    expect(keyFromText("s:listing-42")).toBe("listing-42");
    expect(keyFromText("s:1")).toBe("1");
    expect(keyFromText("s:n:1")).toBe("s:n:1");
    // A tag-like text in no written form spells a string, keyed as keyOf keys that string.
    expect(keyFromText("n:042")).toBe("s:n:042");
    expect(keyFromText("oid:12")).toBe("s:oid:12");
    expect(idOf(keyFromText("n:042"))).toBe("n:042");
  });

  it("round-trips every key keyOf writes, and shows a text in no written form as it is", () => {
    const ids: unknown[] = [
      new ObjectId(),
      new ObjectId(HEX),
      0,
      7,
      -3,
      0.25,
      Number.MAX_SAFE_INTEGER,
      new Int32(12),
      Long.fromNumber(99),
      "a",
      "s:",
      "oid:",
      "n:",
      "12a",
      "Ünïcode key",
    ];
    for (const id of ids) {
      const key = keyOf(id);
      expect(key).toBeDefined();
      if (key !== undefined) {
        expect(keyFromText(keyToText(key))).toBe(key);
      }
    }
    expect(keyToText("n:042")).toBe("n:042");
    expect(keyToText(`oid:${HEX.toUpperCase()}`)).toBe(`oid:${HEX.toUpperCase()}`);
  });

  /**
   * A seeded sweep (fast-check is core's dependency, not this package's): numbers of every scale,
   * the exponent ones included, ObjectIds, and strings drawn from the characters a number, a hex
   * and a tag are made of, each number's and ObjectId's text also kept as a string `_id`. Every key
   * prints as a text that reads back as it, and no two keys print alike.
   */
  it("round-trips a few hundred generated _ids, and never prints two keys alike", () => {
    let seed = 87;
    const random = () => {
      // mulberry32: a fixed sequence, so a failure names the same _id on every run.
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
    const pick = (text: string) => text.charAt(Math.floor(random() * text.length));
    const ids: unknown[] = [];
    for (let at = 0; at < 300; at += 1) {
      const sign = random() < 0.5 ? -1 : 1;
      const scale = 10 ** -Math.floor(random() * 330);
      const number = [
        sign * Math.floor(random() * 1_000_000),
        sign * random() * scale,
        sign * Math.floor(random() * Number.MAX_SAFE_INTEGER),
      ][at % 3] as number;
      const objectId = new ObjectId();
      const characters = Array.from({ length: 1 + Math.floor(random() * 8) }, () =>
        pick("0123456789abcdef.-e:snoidE x"),
      ).join("");
      ids.push(number, String(number), objectId, objectId.toHexString(), characters);
    }
    const printed = new Map<string, string>();
    for (const id of ids) {
      const key = keyOf(id);
      if (key === undefined) {
        continue;
      }
      const text = keyToText(key);
      expect(keyFromText(text), `the _id ${String(id)} printed as ${text}`).toBe(key);
      const other = printed.get(text);
      expect(other === undefined || other === key, `${key} and ${other} both print ${text}`).toBe(
        true,
      );
      printed.set(text, key);
    }
    expect(printed.size).toBeGreaterThan(1000);
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
