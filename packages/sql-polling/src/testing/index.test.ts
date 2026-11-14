import { describe, expect, it } from "vitest";
import { URL_VARIABLES } from "../index.ts";
import { serverUrl, skipUnless } from "./index.ts";

describe("serverUrl", () => {
  it("returns the URL the variable names", () => {
    const env = { ORACLE_URL: "oracle://system:facetdb@127.0.0.1:1521/FREEPDB1" };
    expect(serverUrl("ORACLE_URL", env)).toBe("oracle://system:facetdb@127.0.0.1:1521/FREEPDB1");
  });

  it("fails as environment, not code, naming the server and how to start it, when unset or empty", () => {
    for (const env of [{}, { COCKROACH_URL: "" }]) {
      expect(() => serverUrl("COCKROACH_URL", env)).toThrow(
        "environment, not code: COCKROACH_URL is unset (point it at a CockroachDB node; scripts/test-databases.sh up cockroach starts one)",
      );
    }
  });
});

describe("skipUnless", () => {
  it("runs the suite on a variable that is set, printing nothing", () => {
    const printed: string[] = [];
    const env = { COCKROACH_URL: "cockroachdb://root@127.0.0.1:26257/defaultdb" };
    expect(skipUnless("COCKROACH_URL", env, (line) => printed.push(line))).toBe(false);
    expect(printed).toEqual([]);
  });

  it("skips the half whose variable is unset or empty while the other is set, and says so", () => {
    const printed: string[] = [];
    const env = { COCKROACH_URL: "cockroachdb://root@127.0.0.1:26257/defaultdb", ORACLE_URL: "" };
    expect(skipUnless("ORACLE_URL", env, (line) => printed.push(line))).toBe(true);
    expect(printed).toEqual([
      "SKIPPED: the suite on ORACLE_URL (unset; point it at an Oracle Database 19c or later; scripts/test-databases.sh up oracle starts one)",
    ]);
  });

  it("fails as serverUrl does when none of the package's variables is set: never a silent pass", () => {
    const printed: string[] = [];
    for (const variable of URL_VARIABLES) {
      expect(() =>
        skipUnless(variable, { ORACLE_URL: "", DATABASE_URL: "postgres://x" }, (line) =>
          printed.push(line),
        ),
      ).toThrow(`environment, not code: ${variable} is unset`);
    }
    expect(printed).toEqual([]);
  });
});
