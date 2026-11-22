import { describe, expect, it } from "vitest";
import type { InstalledPlugin } from "../../api/index.ts";
import { draftOf, edited, NO_EDITS } from "./draft.ts";
import { isControl, settingsOf, withValue } from "./settings.ts";

/**
 * How the Plugins page reads a settings schema: the shapes it draws, the ones it sends to the file,
 * nothing the file writes left out, and a draft that changes what was changed and moves nothing
 * else.
 */

function plugin(
  schema: InstalledPlugin["settings"]["schema"],
  values: InstalledPlugin["settings"]["values"] = {},
  more: Partial<InstalledPlugin["settings"]> = {},
): InstalledPlugin {
  return {
    name: "probe",
    key: "probe",
    version: "1.0.0",
    builtIn: false,
    provides: { source: [], action: [], channel: [], provider: [], pack: [] },
    core: { range: "*", holds: true },
    settings: { schema, values, variables: [], hostOnly: [], ...more },
  };
}

const kinds = (one: InstalledPlugin) =>
  settingsOf(one).map((setting) => [setting.path.join("."), setting.shape.kind, setting.editable]);

describe("the settings a schema describes", () => {
  it("are drawn by shape, each field of an object on its own line, an editable mark covering what it holds", () => {
    const one = plugin({
      type: "object",
      properties: {
        name: { type: "string" },
        size: { type: "integer" },
        on: { type: "boolean" },
        style: { type: "string", enum: ["a", "b"] },
        maybe: { anyOf: [{ type: "string" }, { type: "null" }] },
        roles: { type: "array", items: { type: "string" } },
        tags: { type: "object", additionalProperties: { type: "string" } },
        auth: { type: "object", editable: true, properties: { user: { type: "string" } } },
      },
    });
    expect(kinds(one)).toEqual([
      ["name", "text", false],
      ["size", "number", false],
      ["on", "boolean", false],
      ["style", "choice", false],
      ["maybe", "text", false],
      ["roles", "list", false],
      ["tags", "map", false],
      ["auth.user", "text", true],
    ]);
  });

  it("sends to the file what the form cannot draw, and keeps what the file writes beyond the schema", () => {
    const one = plugin(
      {
        type: "object",
        properties: {
          either: { type: ["string", "number"] },
          union: { anyOf: [{ type: "string" }, { type: "number" }] },
          rows: { type: "array", items: { type: "object", properties: { a: { type: "string" } } } },
          numbers: { type: "array", items: { type: "number" } },
          ref: { $ref: "#/$defs/x" },
          fixed: { const: "x" },
          anything: {},
        },
      },
      { extra: "kept" },
    );
    expect(kinds(one).map(([path, kind]) => [path, kind])).toEqual([
      ["either", "other"],
      ["union", "other"],
      ["rows", "other"],
      ["numbers", "other"],
      ["ref", "other"],
      ["fixed", "other"],
      ["anything", "other"],
      ["extra", "other"],
    ]);
  });

  it("without a schema, sends every setting the file writes to the file, or the whole of them", () => {
    expect(kinds(plugin(null, { a: 1, b: "x" }))).toEqual([
      ["a", "other", false],
      ["b", "other", false],
    ]);
    expect(kinds(plugin(null))).toEqual([["", "other", false]]);
    // A plugin whose schema has no settings has nothing to show.
    expect(kinds(plugin({ type: "object", properties: {}, additionalProperties: false }))).toEqual(
      [],
    );
  });

  it("is never a control where it names a variable or holds an address cut to its host", () => {
    const one = plugin(
      {
        type: "object",
        properties: {
          to: { type: "string", editable: true },
          hooks: { type: "object", additionalProperties: { type: "string" }, editable: true },
          plain: { type: "string", editable: true },
        },
      },
      { to: { env: "TO_ADDRESS" }, hooks: { ops: "hooks.example.com" }, plain: "x" },
      { hostOnly: ["hooks.ops"] },
    );
    expect(settingsOf(one).map((setting) => isControl(setting, one))).toEqual([false, false, true]);
  });
});

describe("a draft of the settings", () => {
  const [name, count] = settingsOf(
    plugin({
      type: "object",
      properties: {
        name: { type: "string", default: "FacetDB", editable: true },
        count: { type: "integer", editable: true },
      },
    }),
  );
  const values = { first: 1, name: "Shop", last: 2 };

  it("changes a setting in its place, and adds a new one last", () => {
    expect(Object.keys(withValue(values, ["name"], "Store"))).toEqual(["first", "name", "last"]);
    expect(withValue(values, ["count"], 3)).toEqual({ ...values, count: 3 });
    expect(withValue(values, ["name"], undefined)).toEqual({ first: 1, last: 2 });
    expect(withValue({}, ["a", "b"], 1)).toEqual({ a: { b: 1 } });
  });

  it("holds no change where a setting is back to the file's value, or to its default where the file writes none", () => {
    if (name === undefined || count === undefined) {
      throw new Error("two settings");
    }
    let edits = edited(NO_EDITS, values, name, "Store");
    expect(edits.size).toBe(1);
    edits = edited(edits, values, name, "Shop");
    expect(edits.size).toBe(0);

    const unwritten = { first: 1 };
    expect(edited(NO_EDITS, unwritten, name, "FacetDB").size).toBe(0);
    expect(edited(NO_EDITS, unwritten, count, undefined).size).toBe(0);
    const set = edited(NO_EDITS, unwritten, count, 3);
    expect(draftOf(unwritten, set)).toEqual({ first: 1, count: 3 });
  });
});
