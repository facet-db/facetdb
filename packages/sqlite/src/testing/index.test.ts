import { describe, expect, it } from "vitest";
import { serverUrl, skipUnless } from "./index.ts";

const UNSET =
  "environment, not code: LIBSQL_URL is unset (point it at a libSQL server (sqld); scripts/test-databases.sh up libsql starts one)";

describe("serverUrl", () => {
  it("returns the URL the variable names", () => {
    const env = { LIBSQL_URL: "http://127.0.0.1:8080" };
    expect(serverUrl("LIBSQL_URL", env)).toBe("http://127.0.0.1:8080");
  });

  it("fails as environment, not code, naming the server and how to start it, when unset or empty", () => {
    for (const env of [{}, { LIBSQL_URL: "" }]) {
      expect(() => serverUrl("LIBSQL_URL", env)).toThrow(UNSET);
    }
  });
});

describe("skipUnless", () => {
  it("runs the suite when its variable is set, printing nothing", () => {
    const printed: string[] = [];
    const env = { LIBSQL_URL: "http://127.0.0.1:8080" };
    expect(skipUnless("LIBSQL_URL", env, (line) => printed.push(line))).toBe(false);
    expect(printed).toEqual([]);
  });

  it("never skips the package's only server: unset, the suite fails as serverUrl does", () => {
    const printed: string[] = [];
    for (const env of [{}, { LIBSQL_URL: "", MYSQL_URL: "mysql://x" }]) {
      expect(() => skipUnless("LIBSQL_URL", env, (line) => printed.push(line))).toThrow(UNSET);
    }
    expect(printed).toEqual([]);
  });
});
