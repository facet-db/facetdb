import { describe, expect, it } from "vitest";
import {
  driverLiteral,
  plainMessage,
  quoteIdent,
  quoteLiteral,
  quoteTable,
  tlsProblem,
} from "./index.ts";

/**
 * The TLS rule reads a connection string as mysql2 3.24 reads it, and the quoting door writes names
 * and values one way for MySQL and MariaDB.
 */

describe("tlsProblem", () => {
  const remote = "mysql://admin:s3cret@db.example.com:3306/app";

  it("passes a host on this machine, whatever the URL asks", () => {
    for (const url of [
      "mysql://admin:s3cret@localhost/app",
      "mysql://admin:s3cret@LOCALHOST:3306/app",
      "mysql://admin:s3cret@127.0.0.1:3306/app",
      "mysql://admin:s3cret@[::1]:3306/app",
      "mariadb://admin:s3cret@127.0.0.1/app",
      // No host: mysql2 connects to localhost.
      "mysql:///app",
      // A socket path connects through a socket on this machine, the host aside.
      `${remote}?socketPath=/var/run/mysqld/mysqld.sock`,
    ]) {
      expect(tlsProblem(url, false)).toBeUndefined();
    }
  });

  it("passes another machine when ssl is an object or a profile name, as mysql2 reads it", () => {
    for (const ssl of [
      '{"rejectUnauthorized":true}',
      "{}",
      '{"rejectUnauthorized":false}',
      "Amazon%20RDS",
    ]) {
      expect(tlsProblem(`${remote}?ssl=${ssl}`, false)).toBeUndefined();
    }
  });

  it("refuses another machine reached in the clear, naming the host", () => {
    for (const url of [
      remote,
      `${remote}?ssl=false`,
      `${remote}?ssl=0`,
      `${remote}?ssl=`,
      // A boolean is no TLS profile: mysql2 refuses it rather than turn TLS on.
      `${remote}?ssl=true`,
      // mysql2 takes a parameter's first occurrence.
      `${remote}?ssl=false&ssl={}`,
      // An empty socket path is no socket.
      `${remote}?socketPath=`,
      // A percent-encoded host is the host it decodes to, as mysql2 decodes it.
      "mysql://admin:s3cret@db%2Eexample.com/app",
    ]) {
      expect(tlsProblem(url, false)).toEqual({ host: "db.example.com" });
    }
    expect(tlsProblem("mysql://admin:s3cret@10.0.0.7/app", false)).toEqual({ host: "10.0.0.7" });
  });

  it("is the operator's to waive with --allow-insecure, and calls a non-URL invalid", () => {
    expect(tlsProblem(remote, true)).toBeUndefined();
    expect(tlsProblem("not a connection string", false)).toBe("invalid");
    // A host mysql2 could not decode either.
    expect(tlsProblem("mysql://admin@%zz/app", false)).toBe("invalid");
  });
});

describe("quoting", () => {
  it("quotes a name in backticks, doubling a backtick inside it", () => {
    expect(quoteIdent("listings")).toBe("`listings`");
    expect(quoteIdent("odd`name")).toBe("`odd``name`");
    expect(quoteTable("app", "list ings")).toBe("`app`.`list ings`");
  });

  it("writes a value as a literal, doubling a quote and a backslash", () => {
    expect(quoteLiteral("proj_listings")).toBe("'proj_listings'");
    expect(quoteLiteral("Bob's \\ listings")).toBe("'Bob''s \\\\ listings'");
  });

  it("knows how the driver writes a value in place of a ?", () => {
    expect(driverLiteral("it's")).toBe("'it\\'s'");
  });
});

describe("plainMessage", () => {
  it("blanks every secret, and the password inside a URL", () => {
    const url = "mysql://admin:s3cret@db.example.com/app";
    expect(
      plainMessage(new Error(`Access denied for admin using s3cret at ${url} with hunter2`), [
        url,
        "hunter2",
        undefined,
        "",
      ]),
    ).toBe("Access denied for admin using *** at *** with ***");
    expect(plainMessage("not an error", ["error"])).toBe("not an ***");
  });
});
