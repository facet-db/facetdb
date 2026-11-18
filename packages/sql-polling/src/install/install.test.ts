import type {
  EngineDeps,
  EnginePlan,
  EngineTarget,
  PlanResult,
  QuestionSet,
  Refusal,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { PollingRow } from "../dialect/index.ts";
import { pollingEngine } from "../engine/index.ts";
import {
  PLAIN_COLUMNS,
  PLAIN_KEY,
  PLAIN_LOGIN,
  PLAIN_MARKS,
  plainDialect,
  type RecordingClient,
  recordingClient,
  recordingConnect,
} from "../testing/index.ts";
import { LAST_CHANGED_CODE, type PollingTable, readTable } from "./index.ts";

/**
 * The column a polled table is read by, as the source's config says it, through the reference
 * dialect on a recording client: a column `lastChanged` names is used in the catalog's spelling,
 * `false` reads the whole table every hour with no warning, a column the table lacks, or one that
 * holds no time, may be NULL or is FacetDB's own is refused (`last-changed-column`) before any
 * statement, and the install's note, `open` and doctor all read the same decision. A source without
 * the field keeps the guess by name, whose words polling-engine.test.ts pins.
 */

const questionSet: QuestionSet = {
  questions: [
    { type: "noul", name: "not_priority", instructions: "Is this not a priority?", stakes: "low" },
  ],
  read: ["title", "body"],
  model: "jev-1.14.0",
  thresholds: {},
};

const OWNED = [
  "not_priority",
  "not_priority_probability",
  "facetdb_status",
  "facetdb_updated_at",
  "facetdb_reviewed",
  "facetdb_state_hash",
];

const ADMIN = "plain://admin:s3cret-admin@localhost/app";
const WORKER_URL = "plain://facetdb_worker:a-long-random-password@localhost/app";
const PASSWORD = "a-long-random-password";

type Column = {
  readonly name: string;
  readonly type?: string;
  readonly time?: boolean;
  readonly nullable?: boolean;
};

/** The application's table: the guess's updated_at beside the changed_on a config names. */
const APP: readonly Column[] = [
  { name: "id", type: "integer", nullable: false },
  { name: "title", type: "varchar" },
  { name: "body", type: "varchar" },
  { name: "updated_at", type: "timestamp", time: true, nullable: false },
  { name: "changed_on", type: "timestamp", time: true, nullable: false },
];

type Table = { readonly columns: readonly Column[]; readonly installed?: boolean };

function target(lastChanged?: string | false): EngineTarget {
  return {
    project: { id: "proj_tickets", name: "Tickets" },
    source: "tickets",
    table: "tickets",
    storage: "inline",
    onChange: "reset",
    questionSet,
    urlVariable: "TICKETS_URL",
    ...(lastChanged === undefined ? {} : { lastChanged }),
  };
}

/** The table as installed for this project: FacetDB's columns, their marks, the login. */
function installed(columns: readonly Column[] = APP): Table {
  return { columns: [...columns, ...OWNED.map((name) => ({ name }))], installed: true };
}

/** A recording client whose catalog reads answer `table`; every other statement takes a queued answer. */
function world(table: Table): RecordingClient {
  const marks =
    table.installed === true
      ? OWNED.map((name) => ({
          name,
          mark: name === "facetdb_state_hash" ? "facetdb:proj_tickets" : "facetdb",
        }))
      : [];
  return recordingClient((text): readonly PollingRow[] | undefined => {
    switch (text) {
      case PLAIN_COLUMNS:
        return table.columns.map((column) => ({
          name: column.name,
          type: column.type ?? "varchar",
          time: column.time === true,
          nullable: column.nullable ?? true,
          readable: true,
        }));
      case PLAIN_KEY:
        return [{ name: "id" }];
      case PLAIN_MARKS:
        return marks;
      case PLAIN_LOGIN:
        return table.installed === true ? [{ one: 1 }] : [];
      case plainDialect.login?.whoami:
        return [{ name: "facetdb_worker" }];
      default:
        return undefined;
    }
  });
}

/** What a call sent besides the catalog's reads. */
function changes(client: RecordingClient): readonly string[] {
  const reads = [PLAIN_COLUMNS, PLAIN_KEY, PLAIN_MARKS, PLAIN_LOGIN];
  return client.statements.map((one) => one.text).filter((text) => !reads.includes(text));
}

function engineOn(client: RecordingClient, warnings: string[] = []) {
  const connect = recordingConnect(client);
  const clock = new FakeClock(10_000_000);
  const deps: EngineDeps = { clock, allowInsecure: false, storeShared: false };
  return {
    engine: pollingEngine(plainDialect, connect, { warn: (message) => warnings.push(message) }),
    connect,
    clock,
    deps,
  };
}

function planned(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

async function read(table: Table, lastChanged?: string | false): Promise<PollingTable> {
  const found = await readTable(plainDialect, world(table).query, target(lastChanged));
  if (found === undefined) {
    throw new Error("the table was not found");
  }
  return found;
}

const OTHERWISE = "or write lastChanged: false to read the whole table every hour on purpose";

/** The refusals of `nope`, of a column holding text, of a nullable one, as migrate, open and doctor say them. */
const MISSING: Refusal = {
  code: LAST_CHANGED_CODE,
  message:
    "main.tickets has no column nope, which lastChanged names as the column FacetDB polls by",
  fix: `name a column of main.tickets that holds a time, NOT NULL, set by the application on every insert and every update, in lastChanged, ${OTHERWISE}`,
};

describe("the column a polled table is read by, as lastChanged says", () => {
  it("absent: the guess by name, as before (updated_at, not the changed_on beside it)", async () => {
    const found = await read({ columns: APP });
    expect(found.lastChanged).toEqual({ column: "updated_at" });
    expect(found.lastChangedRefusal).toBeUndefined();
  });

  it("a named column is used over the guess, in the catalog's spelling when only its case differs", async () => {
    expect((await read({ columns: APP }, "changed_on")).lastChanged).toEqual({
      column: "changed_on",
      named: true,
    });
    // Oracle keeps an unquoted changed_on as CHANGED_ON: the poll quotes the catalog's name.
    const upper = APP.map((column) => ({ ...column, name: column.name.toUpperCase() }));
    const found = await read({ columns: upper }, "changed_on");
    expect(found.lastChanged).toEqual({ column: "CHANGED_ON", named: true });
    expect(found.lastChangedRefusal).toBeUndefined();
  });

  it("refuses a name that several columns match only without case, naming them and asking for the exact spelling", async () => {
    // Postgres keeps quoted names as written: "Changed" and "changed" are two columns.
    const twice: readonly Column[] = [
      ...APP,
      { name: "Changed", type: "timestamp", time: true, nullable: false },
      { name: "changed", type: "timestamp", time: true, nullable: false },
    ];
    const found = await read({ columns: twice }, "CHANGED");
    expect(found.lastChanged).toEqual({});
    expect(found.lastChangedRefusal).toEqual({
      code: LAST_CHANGED_CODE,
      message:
        "main.tickets has no column spelled CHANGED exactly, and 2 columns that differ from it only in case (Changed, changed), so FacetDB cannot tell which one lastChanged means",
      fix: `write the column's exact spelling in lastChanged (one of Changed, changed), ${OTHERWISE}`,
    });
    // The exact spelling is used, whatever columns differ from it in case.
    expect((await read({ columns: twice }, "changed")).lastChanged).toEqual({
      column: "changed",
      named: true,
    });
  });

  it("false: no column, even beside an updated_at, and the scan is the config's choice", async () => {
    const found = await read({ columns: APP }, false);
    expect(found.lastChanged).toEqual({ chosen: true });
    expect(found.lastChangedRefusal).toBeUndefined();
  });

  it("refuses a column the table lacks, one that holds no time, one that may be NULL, and FacetDB's own", async () => {
    expect((await read({ columns: APP }, "nope")).lastChangedRefusal).toEqual(MISSING);
    expect((await read({ columns: APP }, "title")).lastChangedRefusal).toEqual({
      code: LAST_CHANGED_CODE,
      message:
        "main.tickets's title, which lastChanged names, holds varchar, not a point in time, so FacetDB cannot tell which rows changed since its last poll",
      fix: `name a column of main.tickets that holds a time (a timestamp or a date), NOT NULL, set by the application on every insert and every update, in lastChanged, ${OTHERWISE}`,
    });
    const nullable = APP.map((column) =>
      column.name === "changed_on" ? { ...column, nullable: true } : column,
    );
    expect((await read({ columns: nullable }, "changed_on")).lastChangedRefusal).toEqual({
      code: LAST_CHANGED_CODE,
      message:
        "main.tickets's changed_on, which lastChanged names, may be NULL, and a row whose changed_on is NULL would never be read again",
      fix: `make changed_on NOT NULL and set it on every insert and every update, ${OTHERWISE}`,
    });
    // FacetDB's own decision time, before the install made it and after: its writes bump it.
    for (const table of [{ columns: APP }, installed()]) {
      expect((await read(table, "facetdb_updated_at")).lastChangedRefusal).toEqual({
        code: LAST_CHANGED_CODE,
        message:
          "facetdb_updated_at, which lastChanged names, is FacetDB's own column on main.tickets, and FacetDB's own writes change it",
        fix: `name the application's own last-changed column of main.tickets in lastChanged, ${OTHERWISE}`,
      });
    }
  });
});

describe("the polling install with lastChanged", () => {
  it("a named column: the note says the poll compares it and the application must set it; no warning", async () => {
    const { engine, deps } = engineOn(world({ columns: APP }));
    const plan = planned(
      await engine.planInstall(target("changed_on"), ADMIN, { ...deps, workerPassword: PASSWORD }),
    );
    expect(plan.notes).toEqual([
      "FacetDB polls main.tickets every 10 seconds by changed_on, the column lastChanged names: the application must set changed_on on every insert and every update, or a change it makes is never noticed",
    ]);
  });

  it("false: the note says the table is read whole every hour by the config's choice, and how to poll instead; no warning", async () => {
    const { engine, deps } = engineOn(world({ columns: APP }));
    const plan = planned(
      await engine.planInstall(target(false), ADMIN, { ...deps, workerPassword: PASSWORD }),
    );
    expect(plan.notes).toEqual([
      "FacetDB reads main.tickets whole every hour, as lastChanged: false says, so a change is noticed within the hour; name in lastChanged a column holding a time, NOT NULL, that the application sets on every insert and every update, and FacetDB polls it every 10 seconds",
    ]);
  });

  it("refuses a column the table lacks, or one of the wrong type, before any statement is planned or sent", async () => {
    const client = world({ columns: APP });
    const { engine, deps } = engineOn(client);
    const missing = await engine.planInstall(target("nope"), ADMIN, {
      ...deps,
      workerPassword: PASSWORD,
    });
    expect(missing).toEqual({ ok: false, refusal: MISSING });
    const wrong = await engine.planInstall(target("body"), ADMIN, {
      ...deps,
      workerPassword: PASSWORD,
    });
    expect(wrong.ok ? undefined : wrong.refusal).toMatchObject({
      code: LAST_CHANGED_CODE,
      message:
        "main.tickets's body, which lastChanged names, holds varchar, not a point in time, so FacetDB cannot tell which rows changed since its last poll",
    });
    expect(changes(client)).toEqual([]);
    // The same refusal on migrate --prune: never read as "no column" and the worker's read revoked.
    const pruned = await engineOn(world(installed())).engine.planPrune(target("nope"), ADMIN, deps);
    expect(pruned).toEqual({ ok: false, refusal: MISSING });
  });
});

describe("the polling connector and doctor with lastChanged: what migrate said", () => {
  it("open polls every 10 seconds by the named column, and warns of nothing", async () => {
    const warnings: string[] = [];
    const client = world(installed());
    const { engine, deps, clock } = engineOn(client, warnings);
    const connector = await engine.open(target("changed_on"), WORKER_URL, deps);
    const iterator = connector.watch()[Symbol.asyncIterator]();
    client.answer([{ k: "1", s0: "a", s1: "b", h: null, x: false, c: "2026-11-04 10:00:00" }], []);
    expect(await iterator.next()).toEqual({ done: false, value: ["1"] });
    const poll = client.statements.find((statement) => statement.text.startsWith("select cast"));
    expect(poll?.text).toContain(`order by "changed_on", "id" fetch first :1 rows only`);
    await connector.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(clock.sleeps).toEqual([10_000]);
    expect(warnings).toEqual([]);
  });

  it("open with false reads the whole table every hour, beside an updated_at, and warns of nothing", async () => {
    const warnings: string[] = [];
    const client = world(installed());
    const { engine, deps, clock } = engineOn(client, warnings);
    const connector = await engine.open(target(false), WORKER_URL, deps);
    const iterator = connector.watch()[Symbol.asyncIterator]();
    client.answer([{ k: "1", s0: "a", s1: "b", h: null, x: false }], []);
    expect(await iterator.next()).toEqual({ done: false, value: ["1"] });
    const poll = client.statements.find((statement) => statement.text.startsWith("select cast"));
    expect(poll?.text).toContain(`order by "id" fetch first :1 rows only`);
    expect(poll?.text).not.toContain("updated_at");
    await connector.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(clock.sleeps).toEqual([3_600_000]);
    expect(warnings).toEqual([]);
  });

  it("open refuses a named column the table lacks in migrate's words, and lets go of its connection", async () => {
    const client = world(installed());
    const { engine, deps } = engineOn(client);
    await expect(engine.open(target("nope"), WORKER_URL, deps)).rejects.toMatchObject({
      refusal: MISSING,
    });
    expect(client.closes.count).toBe(1);
  });

  it("doctor names the column or the scan on the install line, and fails the polling line for a column it cannot poll by", async () => {
    const install = async (lastChanged: string | false) => {
      const { engine, deps } = engineOn(world(installed()));
      return engine.doctor(target(lastChanged), WORKER_URL, deps);
    };
    const named = await install("changed_on");
    expect(named.find((check) => check.name === "install")).toEqual({
      name: "install",
      status: "ok",
      detail:
        "the answer columns and facetdb_state_hash are in place; FacetDB polls main.tickets every 10 seconds by changed_on, the column lastChanged names; no trigger",
    });
    expect(named.some((check) => check.name === "polling")).toBe(false);
    const scanned = await install(false);
    expect(scanned.find((check) => check.name === "install")?.detail).toBe(
      "the answer columns and facetdb_state_hash are in place; FacetDB reads main.tickets whole every hour, as lastChanged: false says; no trigger",
    );
    expect(scanned.some((check) => check.name === "polling")).toBe(false);
    const missing = await install("nope");
    expect(missing.map((check) => [check.name, check.status])).toEqual([
      ["database", "ok"],
      ["install", "ok"],
      ["polling", "fail"],
      ["worker", "skip"],
    ]);
    expect(missing.find((check) => check.name === "polling")).toEqual({
      name: "polling",
      status: "fail",
      detail: MISSING.message,
      fix: MISSING.fix,
    });
    expect(missing.find((check) => check.name === "install")?.detail).toBe(
      "the answer columns and facetdb_state_hash are in place",
    );
  });
});
