import { describe, expect, it } from "vitest";
import { ADMIN_REQUEST_TIMEOUT_MS, connectionConfig, serverFailure } from "./client.ts";
import { qualifiedName, quoteName, quoteString } from "./identifier.ts";
import {
  adminUrlRefusal,
  MssqlUrlError,
  parseMssqlUrl,
  tlsProblem,
  withoutSecrets,
} from "./url.ts";

/**
 * A SQL Server connection string as the engine reads it, and the TLS rule: TLS with the certificate
 * checked by default; `encrypt=false` or `trustServerCertificate=true` toward another machine
 * refused unless `--allow-insecure`; this machine's server either way.
 */

describe("parseMssqlUrl", () => {
  it("reads the test server's string as scripts/test-databases.sh prints it, TLS on by default", () => {
    expect(parseMssqlUrl("mssql://sa:Facetdb-test-1@127.0.0.1:1433/master")).toEqual({
      host: "127.0.0.1",
      port: 1433,
      database: "master",
      user: "sa",
      password: "Facetdb-test-1",
      encrypt: true,
      trustServerCertificate: false,
    });
  });

  it("takes sqlserver://, the default port, no database, escapes, and the TLS parameters in any case", () => {
    expect(
      parseMssqlUrl(
        "sqlserver://app%40corp:p%40ss%2Fword@db.example.com/?Encrypt=strict&TrustServerCertificate=False",
      ),
    ).toEqual({
      host: "db.example.com",
      port: 1433,
      database: undefined,
      user: "app@corp",
      password: "p@ss/word",
      encrypt: "strict",
      trustServerCertificate: false,
    });
  });

  it("refuses what is not a SQL Server connection string, saying why", () => {
    const why = (url: string) => {
      try {
        parseMssqlUrl(url);
      } catch (error) {
        return error instanceof MssqlUrlError ? error : undefined;
      }
      return undefined;
    };
    expect(why("postgres://a@b/c")?.message).toContain(
      "is not a SQL Server URL (mssql://user:password@host:1433/database)",
    );
    expect(why("mssql:///app")?.message).toContain("it names no host");
    expect(why("mssql://a@b/c?encrypt=maybe")?.message).toContain(
      "encrypt is true, false or strict",
    );
    expect(why("mssql://a@b/c?trustServerCertificate=1")?.message).toContain(
      "trustServerCertificate is true or false",
    );
    expect(why("mssql://a:%zz@b/c")?.message).toContain("a % that starts no escape");
    expect(why("mssql://x@evil.com,y@localhost/app")?.ambiguous).toBe(true);
  });

  it("refuses a host no host name is, so a key=value string never carries its password to the driver", () => {
    // Prisma's form: a URL parser reads all of it, password included, as one host.
    const prisma = "sqlserver://db.example.com;database=app;user=sa;password=hunter2;encrypt=true";
    expect(() => parseMssqlUrl(prisma)).toThrow(
      "its host holds characters no host name has, as the key=value pairs of a JDBC or Prisma string do",
    );
    const refusal = adminUrlRefusal(prisma, false);
    expect(refusal).toMatchObject({ code: "admin-url" });
    expect(JSON.stringify(refusal)).not.toContain("hunter2");
    expect(refusal?.fix).toBe(
      "pass the admin connection string as mssql://user:password@host:1433/database (or sqlserver://…) with --admin-url; a named instance (host\\instance) and an ADO.NET, ODBC, JDBC or Prisma key=value string (Server=…;Database=…) are not read: give the instance's TCP port, and write the string as that URL",
    );
    // A named instance and an ADO.NET string are not URLs at all: the same fix names them.
    for (const unread of [
      "mssql://sa:pw@db.example.com\\SQLEXPRESS/app",
      "Server=tcp:db.example.com,1433;Database=app;User ID=sa;Password=hunter2;",
    ]) {
      const refused = adminUrlRefusal(unread, false);
      expect(refused).toMatchObject({ code: "admin-url", fix: refusal?.fix });
      expect(JSON.stringify(refused)).not.toContain("hunter2");
    }
    // Host names, IPv4 and IPv6 addresses pass.
    for (const host of ["db-1.example.com", "sql_server.corp.local", "10.0.0.5", "[fe80::1]"]) {
      expect(parseMssqlUrl(`mssql://a:b@${host}/app`).host).toBe(host);
    }
  });
});

describe("the TLS rule", () => {
  const read = parseMssqlUrl;

  it("takes TLS with a checked certificate anywhere", () => {
    expect(tlsProblem(read("mssql://a:b@db.example.com/app"), false)).toBeUndefined();
    expect(
      tlsProblem(read("mssql://a:b@db.example.com/app?encrypt=strict"), false),
    ).toBeUndefined();
  });

  it("refuses a password in the clear, or past any certificate, toward another machine", () => {
    expect(tlsProblem(read("mssql://a:b@db.example.com/app?encrypt=false"), false)).toEqual({
      host: "db.example.com",
      kind: "plaintext",
    });
    expect(
      tlsProblem(read("mssql://a:b@db.example.com/app?trustServerCertificate=true"), false),
    ).toEqual({ host: "db.example.com", kind: "unverified" });
  });

  it("takes either on this machine, and anywhere with --allow-insecure", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
      expect(
        tlsProblem(
          read(`mssql://a:b@${host}/app?encrypt=false&trustServerCertificate=true`),
          false,
        ),
      ).toBeUndefined();
    }
    expect(tlsProblem(read("mssql://a:b@db.example.com/app?encrypt=false"), true)).toBeUndefined();
  });

  it("words the admin string's refusals with their fixes", () => {
    expect(adminUrlRefusal("mssql://a:b@db.example.com/app?encrypt=false", false)).toEqual({
      code: "admin-url-tls",
      message:
        "the admin connection string reaches db.example.com without TLS (encrypt=false), so the admin password would travel in the clear; no connection was made",
      fix: "remove encrypt=false from the admin connection string, or pass --allow-insecure if that network is trusted",
    });
    expect(adminUrlRefusal("mssql://x@evil.com,y@localhost/app", false)).toMatchObject({
      code: "admin-url",
      fix: "percent-encode every @ in the user and password of the admin connection string as %40",
    });
    expect(adminUrlRefusal("nonsense", false)).toMatchObject({
      code: "admin-url",
      message:
        "the admin connection string is not a SQL Server URL (mssql://user:password@host:1433/database); no connection was made",
    });
    expect(adminUrlRefusal("mssql://a:b@db.example.com/app", false)).toBeUndefined();
  });
});

describe("connectionConfig", () => {
  it("gives tedious the string's server, login, database and TLS, with xact_abort on and the admin plans' timeout", () => {
    expect(
      connectionConfig(
        parseMssqlUrl("mssql://admin:pw@[::1]:14330/app?trustServerCertificate=true"),
      ),
    ).toEqual({
      server: "::1",
      authentication: { type: "default", options: { userName: "admin", password: "pw" } },
      options: {
        port: 14330,
        database: "app",
        encrypt: true,
        trustServerCertificate: true,
        abortTransactionOnError: true,
        requestTimeout: ADMIN_REQUEST_TIMEOUT_MS,
      },
    });
    expect(ADMIN_REQUEST_TIMEOUT_MS).toBe(600_000);
    expect(
      connectionConfig(parseMssqlUrl("mssql://a:b@db.example.com")).options,
    ).not.toHaveProperty("database");
  });
});

describe("serverFailure", () => {
  it("makes tedious's AggregateError of several server errors one error: the messages joined, the first number kept", () => {
    const failure = serverFailure(
      new AggregateError([
        Object.assign(new Error("The index 'ix' is dependent on column 'facetdb_status'."), {
          number: 5074,
        }),
        Object.assign(new Error("ALTER TABLE DROP COLUMN facetdb_status failed."), {
          number: 4922,
        }),
      ]),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({
      message:
        "The index 'ix' is dependent on column 'facetdb_status'. ALTER TABLE DROP COLUMN facetdb_status failed.",
      number: 5074,
    });
  });

  it("passes any other error as it is", () => {
    const one = Object.assign(new Error("Invalid object name 'x'."), { number: 208 });
    expect(serverFailure(one)).toBe(one);
  });
});

describe("withoutSecrets", () => {
  it("blanks a connection string, the password in it and any other secret out of a message", () => {
    const url = "mssql://admin:s3cret%21@db.example.com/app";
    expect(
      withoutSecrets(`login failed for admin (s3cret!) on ${url}; worker pw hunter2`, [
        url,
        "hunter2",
        undefined,
      ]),
    ).toBe("login failed for admin (***) on ***; worker pw ***");
  });
});

describe("quoting", () => {
  it("brackets a name with ] doubled, and writes a value as a Unicode literal with ' doubled", () => {
    expect(quoteName("a]b")).toBe("[a]]b]");
    expect(quoteString("O'Brien")).toBe("N'O''Brien'");
    expect(qualifiedName("sales", "o'brien]s")).toBe("[sales].[o'brien]]s]");
  });
});
