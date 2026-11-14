import { describe, expect, it } from "vitest";
import { URL_VARIABLES } from "../index.ts";
import { serverUrl, skipUnless } from "./index.ts";

describe("serverUrl", () => {
  it("returns the URL the variable names", () => {
    const env = { MARIADB_URL: "mariadb://root:facetdb@127.0.0.1:3307/facetdb" };
    expect(serverUrl("MARIADB_URL", env)).toBe("mariadb://root:facetdb@127.0.0.1:3307/facetdb");
  });

  it("fails as environment, not code, naming the server and how to start it, when unset or empty", () => {
    for (const env of [{}, { MYSQL_URL: "" }]) {
      expect(() => serverUrl("MYSQL_URL", env)).toThrow(
        "environment, not code: MYSQL_URL is unset (point it at a MySQL 8 server; scripts/test-databases.sh up mysql starts one)",
      );
    }
  });
});

describe("skipUnless", () => {
  it("runs the suite on a variable that is set, printing nothing", () => {
    const printed: string[] = [];
    const env = { MYSQL_URL: "mysql://root:facetdb@127.0.0.1:3306/facetdb" };
    expect(skipUnless("MYSQL_URL", env, (line) => printed.push(line))).toBe(false);
    expect(printed).toEqual([]);
  });

  it("skips the half whose variable is unset or empty while the other is set, and says so", () => {
    const printed: string[] = [];
    const env = { MYSQL_URL: "mysql://root:facetdb@127.0.0.1:3306/facetdb", MARIADB_URL: "" };
    expect(skipUnless("MARIADB_URL", env, (line) => printed.push(line))).toBe(true);
    expect(printed).toEqual([
      "SKIPPED: the suite on MARIADB_URL (unset; point it at a MariaDB 10.5 or later server; scripts/test-databases.sh up mariadb starts one)",
    ]);
  });

  it("fails as serverUrl does when none of the package's variables is set: never a silent pass", () => {
    const printed: string[] = [];
    for (const variable of URL_VARIABLES) {
      expect(() =>
        skipUnless(variable, { MYSQL_URL: "", DATABASE_URL: "postgres://x" }, (line) =>
          printed.push(line),
        ),
      ).toThrow(`environment, not code: ${variable} is unset`);
    }
    expect(printed).toEqual([]);
  });
});
