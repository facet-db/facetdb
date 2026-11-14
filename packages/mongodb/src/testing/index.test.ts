import { describe, expect, it } from "vitest";
import { serverUrl, skipUnless } from "./index.ts";

const UNSET =
  "environment, not code: MONGODB_URL is unset (point it at a MongoDB 4.2 or later replica set; scripts/test-databases.sh up mongo starts one)";

describe("serverUrl", () => {
  it("returns the URL the variable names", () => {
    const env = { MONGODB_URL: "mongodb://127.0.0.1:27017/facetdb" };
    expect(serverUrl("MONGODB_URL", env)).toBe("mongodb://127.0.0.1:27017/facetdb");
  });

  it("fails as environment, not code, naming the server and how to start it, when unset or empty", () => {
    for (const env of [{}, { MONGODB_URL: "" }]) {
      expect(() => serverUrl("MONGODB_URL", env)).toThrow(UNSET);
    }
  });
});

describe("skipUnless", () => {
  it("runs the suite when its variable is set, printing nothing", () => {
    const printed: string[] = [];
    const env = { MONGODB_URL: "mongodb://127.0.0.1:27017/facetdb" };
    expect(skipUnless("MONGODB_URL", env, (line) => printed.push(line))).toBe(false);
    expect(printed).toEqual([]);
  });

  it("never skips the package's only server: unset, the suite fails as serverUrl does", () => {
    const printed: string[] = [];
    for (const env of [{}, { MONGODB_URL: "", MYSQL_URL: "mysql://x" }]) {
      expect(() => skipUnless("MONGODB_URL", env, (line) => printed.push(line))).toThrow(UNSET);
    }
    expect(printed).toEqual([]);
  });
});
