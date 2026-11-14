import { describe, expect, it } from "vitest";
import { serverUrl, skipUnless, testServerUrl } from "./index.ts";

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

describe("testServerUrl", () => {
  it("trusts the test container's self-signed certificate on this machine, when the URL says nothing of TLS", () => {
    expect(
      testServerUrl("MSSQL_URL", { MSSQL_URL: "mssql://sa:Facetdb-test-1@127.0.0.1:1433/master" }),
    ).toBe("mssql://sa:Facetdb-test-1@127.0.0.1:1433/master?trustServerCertificate=true");
    expect(testServerUrl("MSSQL_URL", { MSSQL_URL: "mssql://sa:pw@localhost/master" })).toBe(
      "mssql://sa:pw@localhost/master?trustServerCertificate=true",
    );
  });

  it("leaves a URL of another host, or one with a TLS setting of its own, as it is", () => {
    for (const url of [
      "mssql://sa:pw@db.example.com:1433/master",
      "mssql://sa:pw@127.0.0.1:1433/master?encrypt=strict",
      "mssql://sa:pw@127.0.0.1:1433/master?TrustServerCertificate=false",
    ]) {
      expect(testServerUrl("MSSQL_URL", { MSSQL_URL: url })).toBe(url);
    }
    expect(() => testServerUrl("MSSQL_URL", {})).toThrow(UNSET);
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
