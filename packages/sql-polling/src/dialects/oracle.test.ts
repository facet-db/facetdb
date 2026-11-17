import { EngineRefusal, type EngineTarget, type QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createPollingConnector } from "../connector/index.ts";
import { pollingEngine } from "../engine/index.ts";
import {
  oracleDialect,
  oracleFailure,
  oracleTarget,
  SESSION_SETTINGS,
  settleSession,
} from "../oracle.ts";
import { recordingClient, recordingConnect, runDialectConformance } from "../testing/index.ts";

/**
 * The Oracle dialect without a server: the conformance suite of this package with every operation's
 * SQL for the listings example in oracle.dialect.sql (quoted identifiers as written, `:n` binds,
 * `fetch first`, `comment on column` marks, the worker user with its grants), and what the dialect
 * decides on its own: the TLS rule of `oracle://` strings, the boolean conversion, a name Oracle
 * cannot hold, a table named without its schema, the driver's errors as refusals. The catalog
 * reads, the session's text formats and the driver run for real in oracle.db.test.ts.
 */
runDialectConformance({
  dialect: oracleDialect,
  fixture: new URL("./oracle.dialect.sql", import.meta.url),
});

const LISTINGS: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

function target(changes: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: { id: "proj_listings", name: "Listings" },
    source: "listings",
    table: "listings",
    schema: "APP",
    storage: "inline",
    onChange: "reset",
    questionSet: LISTINGS,
    urlVariable: "LISTINGS_URL",
    ...changes,
  };
}

describe("the TLS rule of an oracle:// connection string", () => {
  const { verdict } = oracleDialect.tls;

  it("asks for TLS with ?protocol=tcps, and reaches only this machine without it", () => {
    expect(verdict("oracle://app:pw@db.example.com:2484/ORCLPDB1?protocol=tcps", false)).toBe(
      undefined,
    );
    expect(verdict("oracle://app:pw@db.example.com:1521/ORCLPDB1", false)).toEqual({
      host: "db.example.com",
    });
    expect(verdict("oracle://app:pw@db.example.com:1521/ORCLPDB1?protocol=tcp", false)).toEqual({
      host: "db.example.com",
    });
    for (const local of ["127.0.0.1", "127.8.0.1", "localhost", "[::1]"]) {
      expect(verdict(`oracle://system:facetdb@${local}:1521/FREEPDB1`, false)).toBe(undefined);
    }
  });

  it("lets a plaintext remote host through only with --allow-insecure, and calls a non-URL invalid", () => {
    expect(verdict("oracle://app:pw@10.0.0.5:1521/ORCLPDB1", true)).toBe(undefined);
    expect(verdict("app/pw@db.example.com:1521/ORCLPDB1", false)).toBe("invalid");
  });

  it("refuses a plaintext remote URL in the engine's words before anything connects", async () => {
    const client = recordingClient();
    const engine = pollingEngine(oracleDialect, recordingConnect(client), {
      warn: () => undefined,
    });
    const url = "oracle://facetdb_worker:pw@db.example.com:1521/ORCLPDB1";
    expect(engine.checkUrl(target(), url, { allowInsecure: false })).toEqual({
      code: "database-url-tls",
      message:
        "LISTINGS_URL reaches db.example.com without TLS, so the password in it would travel in the clear; no connection was made",
      fix: "add ?protocol=tcps to LISTINGS_URL, or pass --allow-insecure if that network is trusted",
    });
    expect(client.statements).toEqual([]);
  });
});

describe("an oracle:// connection string as the driver reads it", () => {
  it("gives the user, the password and Easy Connect, tcps:// for TLS, port 1521 by default", () => {
    expect(oracleTarget("oracle://facetdb_worker:p%40ss%2Fw@db.example.com/ORCLPDB1")).toEqual({
      user: "facetdb_worker",
      password: "p@ss/w",
      connectString: "db.example.com:1521/ORCLPDB1",
      tls: false,
      label: "db.example.com:1521/ORCLPDB1",
    });
    expect(
      oracleTarget("oracle://app:pw@db.example.com:2484/ORCLPDB1?protocol=tcps"),
    ).toMatchObject({ connectString: "tcps://db.example.com:2484/ORCLPDB1", tls: true });
  });

  it("refuses a string with no user or service, and a parameter it would ignore", () => {
    expect(() => oracleTarget("oracle://db.example.com:1521/ORCLPDB1")).toThrow(
      "names no host, service or user",
    );
    expect(() => oracleTarget("oracle://app:pw@db.example.com:1521/")).toThrow(
      "names no host, service or user",
    );
    expect(() => oracleTarget("oracle://app:pw@db.example.com/ORCLPDB1?sslmode=require")).toThrow(
      "the parameter sslmode, which FacetDB does not read; the only one is ?protocol=tcps (TLS)",
    );
    expect(() => oracleTarget("oracle://app:pw@db.example.com/ORCLPDB1?protocol=ssl")).toThrow(
      "asks for protocol ssl",
    );
  });

  it("refuses a service name that would carry Easy Connect parameters past the protocol rule", () => {
    for (const service of ["FREEPDB1%3Fssl_server_dn_match%3Dno", "x%28DESCRIPTION%29", "a/b"]) {
      expect(() => oracleTarget(`oracle://app:pw@db.example.com:1521/${service}`)).toThrow(
        "holds a ?, ( or /, which no service name has",
      );
    }
  });

  it("pins every session's text formats, binary comparison and sorting, and UTC", async () => {
    const sent: string[] = [];
    const session = {
      execute: (text: string) => {
        sent.push(text);
        return Promise.resolve({});
      },
    };
    const settled = await new Promise<unknown>((resolve) => {
      settleSession(session, "", resolve);
    });
    expect(settled).toBeUndefined();
    expect(sent).toEqual([SESSION_SETTINGS]);
    for (const setting of [
      "nls_date_format = 'YYYY-MM-DD HH24:MI:SS'",
      "nls_timestamp_format = 'YYYY-MM-DD HH24:MI:SS.FF9'",
      "nls_numeric_characters = '.,'",
      "nls_sort = 'BINARY'",
      "nls_comp = 'BINARY'",
      "time_zone = '+00:00'",
    ]) {
      expect(SESSION_SETTINGS).toContain(setting);
    }
  });
});

describe("Oracle's own rules", () => {
  it("quotes every name as written, and refuses one Oracle cannot hold", () => {
    expect(oracleDialect.quoteTable("APP", "listings")).toBe('"APP"."listings"');
    expect(oracleDialect.quoteTable("APP", "LISTINGS")).toBe('"APP"."LISTINGS"');
    expect(() => oracleDialect.quoteIdent('x"y')).toThrow("holds no double quote");
    expect(() => oracleDialect.quoteIdent("")).toThrow("a name is non-empty");
    expect(oracleDialect.quoteLiteral("it's")).toBe("'it''s'");
  });

  it("reads a CLOB state field whole, selected as it is, and every other type through to_char", async () => {
    const client = recordingClient();
    const connector = createPollingConnector(
      oracleDialect,
      client,
      { ...target(), key: "id" },
      {
        columns: [
          { name: "id", type: "NUMBER" },
          { name: "title", type: "VARCHAR2" },
          { name: "description", type: "CLOB" },
        ],
        clock: new FakeClock(),
        warn: () => undefined,
      },
    );
    await connector.read(["1"]);
    expect(client.statements[0]?.text).toContain(
      'select to_char("id") as k, to_char("title") as s0, "description" as s1,',
    );
    expect(oracleDialect.stateAsText?.("notes", "NCLOB")).toBe('"notes"');
    expect(oracleDialect.stateAsText?.("born", "DATE")).toBe('to_char("born")');
    await connector.close();
  });

  it("binds a boolean as 1 or 0 and reads only those back", () => {
    const booleans = oracleDialect.booleans;
    expect(booleans?.bind(true)).toBe(1);
    expect(booleans?.bind(false)).toBe(0);
    expect(booleans?.read(1)).toBe(true);
    expect(booleans?.read(0)).toBe(false);
    expect(() => booleans?.read("1")).toThrow('came back as "1", expected 1 or 0');
  });

  it("refuses a table named without its schema, which the worker could not find", async () => {
    const client = recordingClient();
    const engine = pollingEngine(oracleDialect, recordingConnect(client), {
      warn: () => undefined,
    });
    const { schema: _named, ...unqualified } = target({ table: "LISTINGS" });
    await expect(
      engine.planInstall(unqualified, "oracle://system:pw@127.0.0.1:1521/FREEPDB1", {
        clock: new FakeClock(),
        allowInsecure: false,
        storeShared: false,
      }),
    ).rejects.toThrow(
      "the source's table LISTINGS names no schema, and Oracle has no default schema the worker shares",
    );
    expect(client.statements).toEqual([]);
  });

  it("writes a noul's answer and the reviewed flag as 1 or 0, and reads them back as booleans", async () => {
    const client = recordingClient();
    const connector = createPollingConnector(
      oracleDialect,
      client,
      { ...target(), key: "id" },
      { clock: new FakeClock(1_700_000_000_000), warn: () => undefined },
    );
    client.answer([{ k: "1", s0: "a", s1: "b", h: null, x: 0 }]);
    const { rows } = await connector.read(["1"]);
    expect(rows[0]?.excluded).toBe(false);
    client.answer([{ k: "1", s0: "a", s1: "b", h: null, x: 0 }]);
    await connector.write(
      "1",
      {
        decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.93 } },
        status: "done",
        reviewed: true,
      },
      rows[0]?.hash ?? "",
    );
    expect(client.statements.at(-1)?.params).toEqual([
      "1",
      0,
      0.93,
      "done",
      1_700_000_000_000,
      1,
      rows[0]?.hash,
    ]);
    client.answer([{ k: "1", q0v: 0, q0p: ".93", cs: "done", cu: "1700000000000", cr: 1 }]);
    expect((await connector.current(["1"])).get("1")).toEqual({
      decisions: { is_scam: { kind: "decided", value: false, probabilityOrConfidence: 0.93 } },
      status: "done",
      reviewed: true,
      updatedAt: new Date(1_700_000_000_000),
    });
    await connector.close();
  });
});

describe("the driver's errors as the engine's refusals", () => {
  const at = { label: "db.example.com:1521/ORCLPDB1", user: "facetdb_worker" };
  const driverError = (errorNum: number, message: string) =>
    Object.assign(new Error(`${message}\nHelp: https://docs.oracle.com/error-help/db/`), {
      errorNum,
    });

  it("words a refused login, a missing table and a busy one, and passes any other error", () => {
    const login = oracleFailure(driverError(1017, "ORA-01017: invalid credential"), at);
    expect(login).toBeInstanceOf(EngineRefusal);
    expect((login as EngineRefusal).refusal).toMatchObject({
      code: "database-login",
      message:
        "Oracle refused the login of facetdb_worker on db.example.com:1521/ORCLPDB1 (ORA-01017, the user name or the password is wrong)",
    });
    const missing = oracleFailure(
      driverError(942, 'ORA-00942: table or view "APP"."LISTINGS" does not exist'),
      at,
    );
    expect((missing as EngineRefusal).refusal).toMatchObject({
      code: "polling-table",
      message:
        'ORA-00942: table or view "APP"."LISTINGS" does not exist: the table does not exist on db.example.com:1521/ORCLPDB1, or facetdb_worker may not read it',
    });
    const busy = oracleFailure(driverError(54, "ORA-00054: resource busy"), at);
    expect((busy as EngineRefusal).refusal.code).toBe("table-busy");
    const other = driverError(1722, "ORA-01722: invalid number");
    expect(oracleFailure(other, at)).toBe(other);
  });
});
