import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { quietTypelessPackageWarning } from "./warnings.ts";

/**
 * Node's warnings under `facetdb`: a config file in a package with no `"type"` reaches no printer,
 * every other warning reaches Node's own printer as before (which keeps `--disable-warning` and
 * `--redirect-warnings` working), and a process Node gave no printer (`--no-warnings`) is left
 * alone. An EventEmitter stands in for `process`.
 */

/** A warning as `process.emitWarning` makes one: an Error with a name and maybe a code. */
function warning(name: string, message: string, code?: string): Error {
  const made = new Error(message);
  made.name = name;
  return code === undefined ? made : Object.assign(made, { code });
}

const TYPELESS = warning(
  "Warning",
  "Module type of file:///work/app/facetdb.config.ts is not specified and it doesn't parse as CommonJS.",
  "MODULE_TYPELESS_PACKAGE_JSON",
);

describe("the warning filter", () => {
  it("keeps the typeless package.json warning of the config file from Node's printer", () => {
    const emitter = new EventEmitter<{ warning: [Error] }>();
    const printed: Error[] = [];
    emitter.on("warning", (received) => {
      printed.push(received);
    });
    expect(quietTypelessPackageWarning(emitter)).toBe(true);
    emitter.emit("warning", TYPELESS);
    expect(printed).toEqual([]);
    expect(emitter.listenerCount("warning")).toBe(1);
  });

  it("hands every other warning to Node's own printers, in their order", () => {
    const emitter = new EventEmitter<{ warning: [Error] }>();
    const printed: string[] = [];
    emitter.on("warning", (received) => {
      printed.push(`printer: ${received.message}`);
    });
    emitter.on("warning", (received) => {
      printed.push(`second: ${received.message}`);
    });
    quietTypelessPackageWarning(emitter);
    const experimental = warning("ExperimentalWarning", "SQLite is experimental", "SQLITE_X");
    emitter.emit("warning", experimental);
    emitter.emit("warning", TYPELESS);
    emitter.emit("warning", warning("DeprecationWarning", "url.parse()", "DEP0169"));
    expect(printed).toEqual([
      "printer: SQLite is experimental",
      "second: SQLite is experimental",
      "printer: url.parse()",
      "second: url.parse()",
    ]);
  });

  it("changes nothing when Node printed no warnings (--no-warnings)", () => {
    const emitter = new EventEmitter<{ warning: [Error] }>();
    expect(quietTypelessPackageWarning(emitter)).toBe(false);
    expect(emitter.listenerCount("warning")).toBe(0);
  });
});
