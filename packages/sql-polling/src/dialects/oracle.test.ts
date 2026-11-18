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
import {
  type Responder,
  recordingClient,
  recordingConnect,
  runDialectConformance,
} from "../testing/index.ts";

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

/** The listings table's columns as the catalog types them, the description a short text. */
const COLUMNS = [
  { name: "id", type: "NUMBER" },
  { name: "title", type: "VARCHAR2" },
  { name: "description", type: "VARCHAR2" },
] as const;

/**
 * Oracle's catalog reads answering for APP.listings, keyed by id, with `description` of the given
 * type; the worker may read it. Any other statement answers undefined (the next scripted rows).
 */
function oracleCatalog(description: string): Responder {
  return (text) => {
    if (text.includes("from all_tab_columns")) {
      return [...COLUMNS.slice(0, 2), { name: "description", type: description }].map((column) => ({
        column_name: column.name,
        data_type: column.type,
        remark: null,
        holds_time: 0,
        nullable: column.name === "id" ? "N" : "Y",
      }));
    }
    if (text.includes("from all_constraints")) {
      return [{ column_name: "id" }];
    }
    if (text.endsWith("where 1 = 0") || text.includes("from all_users")) {
      return [{ found: 1 }];
    }
    if (text === oracleDialect.login?.whoami) {
      return [{ name: "FACETDB_WORKER" }];
    }
    return undefined;
  };
}

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
        columns: [...COLUMNS.slice(0, 2), { name: "description", type: "CLOB" }],
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
    // JSON past 4000 bytes reads as NULL through to_char (23ai): serialized to a CLOB, read whole.
    expect(oracleDialect.stateAsText?.("specs", "JSON")).toBe(
      'json_serialize("specs" returning clob)',
    );
    await connector.close();
  });

  it("reads the catalog's types itself when made without columns, once, so a CLOB is read whole by that door too", async () => {
    const client = recordingClient(oracleCatalog("CLOB"));
    const connector = createPollingConnector(
      oracleDialect,
      client,
      { ...target(), key: "id" },
      { clock: new FakeClock(), warn: () => undefined },
    );
    await connector.read(["1"]);
    await connector.read(["2"]);
    const selects = client.statements.filter((one) => one.text.startsWith("select to_char"));
    expect(selects.map((one) => one.text)).toEqual([
      expect.stringContaining(
        'select to_char("id") as k, to_char("title") as s0, "description" as s1,',
      ),
      expect.stringContaining(
        'select to_char("id") as k, to_char("title") as s0, "description" as s1,',
      ),
    ]);
    // One catalog read, under the connection's own login, before the first state select.
    const catalog = client.statements.filter((one) => one.text.includes("from all_tab_columns"));
    expect(catalog).toEqual([expect.objectContaining({ params: ["APP", "listings"] })]);
    const texts = client.statements.map((one) => one.text);
    expect(texts.findIndex((text) => text.includes("from all_tab_columns"))).toBeLessThan(
      texts.findIndex((text) => text.startsWith("select to_char")),
    );
    await connector.close();
  });

  it.each(["BLOB", "LONG", "LONG RAW", "RAW", "XMLTYPE", "ROWID"])(
    "refuses a %s state field with the same words at migrate, at the worker's open, at doctor and in a connector made without columns",
    async (type) => {
      const words = {
        code: "state-field",
        message: `APP.listings's state field description (${type}) holds nothing Oracle can read as text, so FacetDB can neither notice its changes nor ask a question about it`,
        fix: "take description out of read, which names text, number and date columns; to ask about what it holds, keep a description in a text column and read that one",
      };
      const client = recordingClient(oracleCatalog(type));
      const engine = pollingEngine(oracleDialect, recordingConnect(client), {
        warn: () => undefined,
      });
      const deps = { clock: new FakeClock(), allowInsecure: false, storeShared: false };
      const planned = await engine.planInstall(
        target(),
        "oracle://system:pw@127.0.0.1:1521/FREEPDB1",
        { ...deps, workerPassword: "a-long-random-password" },
      );
      expect(planned).toEqual({ ok: false, refusal: words });
      const worker = "oracle://facetdb_worker:pw@127.0.0.1:1521/FREEPDB1";
      await expect(engine.open(target(), worker, deps)).rejects.toEqual(new EngineRefusal(words));
      const polling = (await engine.doctor(target(), worker, deps)).find(
        (check) => check.name === "polling",
      );
      expect(polling).toEqual({
        name: "polling",
        status: "fail",
        detail: words.message,
        fix: words.fix,
      });
      // The door without the engine: its first read of the state refuses, and nothing is selected.
      const bare = recordingClient(oracleCatalog(type));
      const connector = createPollingConnector(
        oracleDialect,
        bare,
        { ...target(), key: "id" },
        { clock: new FakeClock(), warn: () => undefined },
      );
      const refused = await connector.read(["1"]).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(refused).toBeInstanceOf(EngineRefusal);
      expect((refused as EngineRefusal).refusal).toEqual(words);
      expect(bare.statements.some((one) => one.text.startsWith("select to_char"))).toBe(false);
      await expect(connector.install()).rejects.toMatchObject({ refusal: words });
      await connector.close();
      // Given the columns, it refuses as it is made, and lets go of the client it was handed.
      const handed = recordingClient();
      expect(() =>
        createPollingConnector(
          oracleDialect,
          handed,
          { ...target(), key: "id" },
          {
            columns: [...COLUMNS.slice(0, 2), { name: "description", type }],
            clock: new FakeClock(),
            warn: () => undefined,
          },
        ),
      ).toThrow(words.message);
      expect(handed.closes.count).toBe(1);
      expect(handed.statements).toEqual([]);
    },
  );

  it("reads the types it knows as text, precision and case aside, and refuses every other", () => {
    for (const type of [
      "VARCHAR2",
      "NVARCHAR2",
      "CHAR",
      "NCHAR",
      "NUMBER",
      "FLOAT",
      "BINARY_FLOAT",
      "BINARY_DOUBLE",
      "DATE",
      "TIMESTAMP(6)",
      "TIMESTAMP(9) WITH TIME ZONE",
      "TIMESTAMP(6) WITH LOCAL TIME ZONE",
      "INTERVAL DAY(2) TO SECOND(6)",
      "INTERVAL YEAR(2) TO MONTH",
      "CLOB",
      "NCLOB",
      "JSON",
      "BOOLEAN",
      "varchar2(255 char)",
    ]) {
      expect([type, oracleDialect.unreadableState?.(type)]).toEqual([type, false]);
    }
    for (const type of ["BFILE", "VECTOR", "UROWID", "SDO_GEOMETRY", "ANYDATA", "MLSLABEL"]) {
      expect([type, oracleDialect.unreadableState?.(type)]).toEqual([type, true]);
    }
  });

  it("refuses only the fields read lists: a BLOB the source does not read is left alone", () => {
    const connector = createPollingConnector(
      oracleDialect,
      recordingClient(),
      { ...target(), key: "id" },
      {
        columns: [...COLUMNS, { name: "photo", type: "BLOB" }],
        clock: new FakeClock(),
        warn: () => undefined,
      },
    );
    expect(connector.capabilities.inlineColumns).toBe(true);
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

  it("names the table as the config writes it, schema and case alike", () => {
    const engine = pollingEngine(oracleDialect, recordingConnect(recordingClient()), {
      warn: () => undefined,
    });
    // The service in the URL's path is no schema: the label ignores it.
    const url = "oracle://facetdb_worker:pw@127.0.0.1:1521/FREEPDB1";
    expect(engine.label(target({ table: "LISTINGS" }), url)).toBe("APP.LISTINGS");
    expect(engine.label(target({ schema: "app", table: "listings" }), url)).toBe("app.listings");
  });

  it("writes a noul's answer and the reviewed flag as 1 or 0, and reads them back as booleans", async () => {
    const client = recordingClient();
    const connector = createPollingConnector(
      oracleDialect,
      client,
      { ...target(), key: "id" },
      { columns: COLUMNS, clock: new FakeClock(1_700_000_000_000), warn: () => undefined },
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
