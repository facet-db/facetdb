import { describe, expect, it } from "vitest";
import { serverUrl, skipUnless } from "./index.ts";

const UNSET =
  "environment, not code: MSSQL_URL is unset (point it at a SQL Server 2016 or later; scripts/test-databases.sh up mssql starts one)";

describe("serverUrl", () => {
  it("returns the URL the variable names", () => {
    const env = { MSSQL_URL: "mssql://sa:Facetdb-test-1@127.0.0.1:1433/master" };
    expect(serverUrl("MSSQL_URL", env)).toBe("mssql://sa:Facetdb-test-1@127.0.0.1:1433/master");
  });

  it("fails as environment, not code, naming the server and how to start it, when unset or empty", () => {
    for (const env of [{}, { MSSQL_URL: "" }]) {
      expect(() => serverUrl("MSSQL_URL", env)).toThrow(UNSET);
    }
  });
});

describe("skipUnless", () => {
  it("runs the suite when its variable is set, printing nothing", () => {
    const printed: string[] = [];
    const env = { MSSQL_URL: "mssql://sa:Facetdb-test-1@127.0.0.1:1433/master" };
    expect(skipUnless("MSSQL_URL", env, (line) => printed.push(line))).toBe(false);
    expect(printed).toEqual([]);
  });

  it("never skips the package's only server: unset, the suite fails as serverUrl does", () => {
    const printed: string[] = [];
    for (const env of [{}, { MSSQL_URL: "", MYSQL_URL: "mysql://x" }]) {
      expect(() => skipUnless("MSSQL_URL", env, (line) => printed.push(line))).toThrow(UNSET);
    }
    expect(printed).toEqual([]);
  });
});
