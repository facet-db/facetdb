import {
  type EngineDeps,
  type EnginePlan,
  EngineRefusal,
  type EngineTarget,
  type PlanResult,
  type QuestionSet,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { PollingRow } from "../dialect/index.ts";
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
import { pollingEngine } from "./index.ts";

/**
 * The polling engine (the engine contract) on a recording client, through the reference dialect:
 * the plans, `run`, `open`, `checkUrl` and doctor where the generic code decides (a dialect without
 * transactional DDL stops part way and keeps what ran, a password bound and never printed, the
 * run's own check of the mark, the marks' rows, whole-table reads, no pooler). Postgres's are
 * proven on PGlite in `@facetdb/postgres` (polling/engine.test.ts).
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
const deps: EngineDeps = { clock: new FakeClock(), allowInsecure: false, storeShared: false };

function target(overrides: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: { id: "proj_tickets", name: "Tickets" },
    source: "tickets",
    table: "tickets",
    storage: "inline",
    onChange: "reset",
    questionSet,
    urlVariable: "TICKETS_URL",
    ...overrides,
  };
}

type Table = {
  readonly columns: readonly {
    name: string;
    time?: boolean;
    nullable?: boolean;
    readable?: boolean;
  }[];
  readonly marks?: ReadonlyMap<string, string>;
  readonly key?: readonly string[];
  readonly login?: boolean;
  readonly whoami?: string;
};

const APP: Table["columns"] = [
  { name: "id", nullable: false },
  { name: "title" },
  { name: "body" },
  { name: "updated_at", time: true, nullable: false },
];

/** A table installed for `project`, its marks as the reference dialect keeps them. */
function installed(project = "proj_tickets"): Table {
  return {
    columns: [...APP, ...OWNED.map((name) => ({ name }))],
    marks: new Map(
      OWNED.map((name) => [name, name === "facetdb_state_hash" ? `facetdb:${project}` : "facetdb"]),
    ),
    login: true,
  };
}

/** The catalog's answer to one of the reference dialect's reads of `table`, or undefined for any other statement. */
function catalogAnswer(table: Table | undefined, text: string): readonly PollingRow[] | undefined {
  switch (text) {
    case PLAIN_COLUMNS:
      return (table?.columns ?? []).map((column) => ({
        name: column.name,
        type: "varchar",
        time: column.time === true,
        nullable: column.nullable ?? true,
        readable: column.readable ?? true,
      }));
    case PLAIN_KEY:
      return (table?.key ?? ["id"]).map((name) => ({ name }));
    case PLAIN_MARKS:
      return [...(table?.marks ?? [])].map(([name, mark]) => ({ name, mark }));
    case PLAIN_LOGIN:
      return table?.login === true ? [{ one: 1 }] : [];
    case plainDialect.login?.whoami:
      return [{ name: table?.whoami ?? "facetdb_worker" }];
    default:
      return undefined;
  }
}

/**
 * A recording client whose catalog reads answer `table`; every other statement answers none, and
 * with `failure` the one at that index among them fails as the driver would.
 */
function world(
  table: Table | undefined,
  failure?: { readonly at: number; readonly error: Error },
): RecordingClient {
  let sent = 0;
  return recordingClient((text): readonly PollingRow[] | undefined => {
    const read = catalogAnswer(table, text);
    if (read !== undefined) {
      return read;
    }
    sent += 1;
    if (failure !== undefined && sent === failure.at + 1) {
      throw failure.error;
    }
    return undefined;
  });
}

function engineOn(client: RecordingClient, warnings: string[] = []) {
  const connect = recordingConnect(client);
  return {
    engine: pollingEngine(plainDialect, connect, { warn: (message) => warnings.push(message) }),
    connect,
  };
}

function planned(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

/** What a run sent besides the catalog's reads. */
function changes(client: RecordingClient): readonly string[] {
  const reads = [PLAIN_COLUMNS, PLAIN_KEY, PLAIN_MARKS, PLAIN_LOGIN];
  return client.statements.map((one) => one.text).filter((text) => !reads.includes(text));
}

describe("the polling engine's plans", () => {
  it("plans a fresh table as the reference dialect writes it: no transaction, the login bound at run, whole-table reads", async () => {
    const client = world({ columns: APP });
    const { engine, connect } = engineOn(client);
    const plan = planned(
      await engine.planInstall(target(), ADMIN, { ...deps, workerPassword: PASSWORD }),
    );
    expect(plan.transactional).toBe(false);
    expect(plan.removes).toEqual([]);
    expect(plan.keeps).toEqual([]);
    // The column found is the application's to keep current: said once, at migrate.
    expect(plan.notes).toEqual([
      "FacetDB polls main.tickets every 10 seconds by updated_at: the application must set updated_at on every insert and every update, or a change it makes is never noticed",
    ]);
    const login = plan.statements.filter((statement) => statement.purpose === "login");
    expect(login).toEqual([
      {
        database: "source",
        purpose: "login",
        text: "-- the worker login: created by facetdb migrate with the password bound, never printed",
        secret: true,
      },
      { database: "source", purpose: "login", text: `grant connect to "facetdb_worker"` },
    ]);
    expect(plan.statements.filter((statement) => statement.purpose === "grants")).toEqual([
      expect.objectContaining({ text: `grant select on "main"."tickets" to "facetdb_worker"` }),
      expect.objectContaining({ text: expect.stringMatching(/^grant update \("not_priority",/) }),
    ]);
    const script = engine.render(plan);
    expect(script.startsWith("create table if not exists")).toBe(true);
    expect(script.endsWith(`to "facetdb_worker";\n`)).toBe(true);
    expect(script).not.toContain("begin;");
    expect(script).not.toContain(PASSWORD);
    // The admin URL was used for the call and let go of.
    expect(connect.opened).toEqual([{ url: ADMIN }]);
    expect(client.closes.count).toBe(1);
  });

  it("refuses with the contract's worker-login code when the login is missing and no password came, in the dialect's words", async () => {
    const { engine } = engineOn(world({ columns: APP }));
    const result = await engine.planInstall(target(), ADMIN, deps);
    expect(result.ok ? undefined : result.refusal).toEqual({
      code: "worker-login",
      message:
        "the worker login facetdb_worker does not exist yet, and no password was given to create it with",
      fix: "put the worker login and a long random password in TICKETS_URL: plain://facetdb_worker:<a long random password>@<host>/<database>; the install creates the login with that password",
    });
  });

  it("refuses a table without a single-column key, and an admin URL of another database or in the clear", async () => {
    const composite = await engineOn(
      world({ columns: APP, key: ["id", "title"] }),
    ).engine.planInstall(target(), ADMIN, { ...deps, workerPassword: PASSWORD });
    expect(composite.ok ? undefined : composite.refusal.message).toBe(
      "main.tickets needs a single-column primary key, and has a composite one (id, title); FacetDB keys its answers by it.",
    );
    const { engine, connect } = engineOn(world({ columns: APP }));
    const other = await engine.planInstall(target(), "postgres://admin@localhost/app", deps);
    expect(other.ok ? undefined : other.refusal).toEqual({
      code: "admin-url",
      message:
        "the admin connection string is a postgres: one, and this polling engine reads Plain SQL (plain://); no connection was made",
      fix: "pass plain://user:password@host/database?tls=on as --admin-url",
    });
    const clear = await engine.planInstall(target(), "plain://admin:pw@db.example.com/app", deps);
    expect(clear.ok ? undefined : clear.refusal).toEqual({
      code: "admin-url-tls",
      message:
        "the admin connection string reaches db.example.com without TLS, so the admin password would travel in the clear; no connection was made",
      fix: "add ?tls=on to the admin connection string, or pass --allow-insecure if that network is trusted",
    });
    expect(connect.opened).toEqual([]);
  });

  it("uninstalls every marked column and the marks' rows, keeps the login, and asks the project's name back", async () => {
    const { engine } = engineOn(world(installed()));
    const plan = planned(
      await engine.planUninstall(target(), ADMIN, { ...deps, purge: false, alsoUninstalling: [] }),
    );
    expect(plan.statements.map((statement) => statement.text)).toEqual([
      `revoke all on "main"."tickets" from "facetdb_worker"`,
      ...OWNED.map((name) => `alter table "main"."tickets" drop column "${name}"`),
      `delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'tickets'`,
    ]);
    expect(plan.removes.at(-1)).toEqual({
      kind: "marker",
      name: "facetdb_table_owners",
      of: "main.tickets",
      scope: "source",
    });
    expect(plan.keeps).toEqual([
      {
        kind: "login",
        name: "facetdb_worker",
        scope: "run",
        reason: "uninstall never drops it: every project on the server may share it",
      },
    ]);
    expect(plan.confirm).toEqual({ kind: "project", name: "Tickets" });
  });

  it("prunes a removed question's columns and their marks' rows, and leaves whole-table reads alone (no column to take back)", async () => {
    const { engine } = engineOn(world(installed()));
    const later: QuestionSet = {
      ...questionSet,
      questions: [{ type: "noul", name: "urgent", instructions: "Urgent?", stakes: "low" }],
      read: ["title"],
    };
    const plan = planned(await engine.planPrune(target({ questionSet: later }), ADMIN, deps));
    expect(plan.statements.map((statement) => statement.text)).toEqual([
      `alter table "main"."tickets" drop column "not_priority"`,
      `alter table "main"."tickets" drop column "not_priority_probability"`,
      `delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'tickets' and column_name in ('not_priority', 'not_priority_probability')`,
    ]);
    expect(plan.removes.map((object) => [object.kind, object.name, object.reason])).toEqual([
      ["column", "not_priority", "no question asks it any more"],
      ["column", "not_priority_probability", "no question asks it any more"],
    ]);
  });
});

describe("the polling engine's run", () => {
  it("binds the password at the secret statement, and a stop part way keeps what ran, with no secret in its words", async () => {
    const plan = planned(
      await engineOn(world({ columns: APP })).engine.planInstall(target(), ADMIN, {
        ...deps,
        workerPassword: PASSWORD,
      }),
    );
    // The statement right after the login's creation fails, quoting the password as a driver might.
    const failAt = plan.statements.findIndex((statement) => statement.secret === true) + 1;
    const failing = world(
      { columns: APP },
      { at: failAt, error: new Error(`permission denied (the password ${PASSWORD} was refused)`) },
    );
    const ran = await engineOn(failing).engine.run(target(), plan, ADMIN, {
      ...deps,
      workerPassword: PASSWORD,
    });
    expect(
      failing.statements.find((statement) => statement.text.startsWith("create user")),
    ).toMatchObject({
      text: `create user "facetdb_worker" password :1`,
      params: [PASSWORD],
    });
    expect(ran.stopped).toEqual({
      at: failAt,
      error: "permission denied (the password *** was refused)",
    });
    // No transactional DDL: what ran before the stop stays, and a fresh plan made after the stop
    // (from the table as it is then: those columns present) completes it.
    expect(ran.ran).toEqual(plan.statements.slice(0, failAt));
    expect(ran.removed).toEqual([]);
  });

  it("stops before anything when another project marked the table since the plan was read", async () => {
    const { engine } = engineOn(world({ columns: APP }));
    const plan = planned(
      await engine.planInstall(target(), ADMIN, { ...deps, workerPassword: PASSWORD }),
    );
    const client = world(installed("proj_other"));
    const ran = await engineOn(client).engine.run(target(), plan, ADMIN, {
      ...deps,
      workerPassword: PASSWORD,
    });
    expect(ran.stopped).toEqual({
      at: 0,
      refusal: {
        code: "another-project",
        message:
          "main.tickets already carries FacetDB columns from another project (proj_other); one table belongs to one project. Uninstall there first, or point this project at another table.",
        fix: "change the table or the config as the message says, then run the command again; nothing was changed",
      },
    });
    expect(changes(client)).toEqual([]);
  });

  it("stops at the secret statement when the run was given no password", async () => {
    const { engine } = engineOn(world({ columns: APP }));
    const plan = planned(
      await engine.planInstall(target(), ADMIN, { ...deps, workerPassword: PASSWORD }),
    );
    const ran = await engineOn(world({ columns: APP })).engine.run(target(), plan, ADMIN, deps);
    expect(ran.stopped).toMatchObject({ refusal: { code: "worker-password" } });
  });

  it("re-reads the table before a log-only purge's empty plan lets the store's purge follow", async () => {
    const options = { ...deps, purge: true, alsoUninstalling: [] };
    const plan = planned(
      await engineOn(world({ columns: APP })).engine.planUninstall(target(), ADMIN, options),
    );
    expect(plan.confirm).toEqual({ kind: "source", name: "tickets" });
    // Nothing installed since: the run has nothing to do, and the store's purge may follow.
    expect(await engineOn(world({ columns: APP })).engine.run(target(), plan, ADMIN, deps)).toEqual(
      {
        ran: [],
        removed: [],
        notes: [],
      },
    );
    // Installed again since the plan was read: the log is live again, and nothing is purged.
    const again = await engineOn(world(installed())).engine.run(target(), plan, ADMIN, deps);
    expect(again.stopped).toEqual({
      at: 0,
      refusal: {
        code: "uninstall-refused",
        message:
          'the decision log of source "tickets" is live again: main.tickets is now installed for its project; nothing was changed',
        fix: "change the table or the config as the message says, then run the command again; nothing was changed",
      },
    });
  });
});

describe("the polling engine's open, checkUrl and doctor", () => {
  it("opens a connector that polls by the NOT NULL updated_at, and never by a nullable one", async () => {
    const warnings: string[] = [];
    const client = world({ ...installed(), columns: [...APP, ...OWNED.map((name) => ({ name }))] });
    const { engine, connect } = engineOn(client, warnings);
    const connector = await engine.open(target(), WORKER_URL, { ...deps, maxConnections: 7 });
    expect(connect.opened).toEqual([{ url: WORKER_URL, max: 7 }]);
    const iterator = connector.watch()[Symbol.asyncIterator]();
    client.answer([{ k: "1", s0: "a", s1: "b", h: null, x: false, c: "2026-11-03 10:00:00" }], []);
    expect(await iterator.next()).toEqual({ done: false, value: ["1"] });
    const poll = client.statements.find((statement) => statement.text.startsWith("select cast"));
    expect(poll?.text).toContain(`order by "updated_at", "id" fetch first :1 rows only`);
    await connector.close();
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(warnings).toEqual([]);

    const nullable = world({
      ...installed(),
      columns: [
        ...APP.map((column) =>
          column.name === "updated_at" ? { ...column, nullable: true } : column,
        ),
        ...OWNED.map((name) => ({ name })),
      ],
    });
    const hourly = await engineOn(nullable, warnings).engine.open(target(), WORKER_URL, deps);
    const scan = hourly.watch()[Symbol.asyncIterator]();
    await hourly.close();
    await scan.next();
    expect(warnings).toHaveLength(1);
  });

  it("refuses to open a source whose worker may not read the column FacetDB polls by, with the command that grants it", async () => {
    const unread = world({
      ...installed(),
      columns: [
        ...APP.map((column) =>
          column.name === "updated_at" ? { ...column, readable: false } : column,
        ),
        ...OWNED.map((name) => ({ name })),
      ],
    });
    await expect(engineOn(unread).engine.open(target(), WORKER_URL, deps)).rejects.toMatchObject({
      refusal: {
        code: "polling-read",
        message:
          "the worker login may not read updated_at, the column FacetDB polls main.tickets by",
        fix: "run facetdb migrate: it grants the worker its read of that column",
      },
    });
    // The connection `open` made for it is let go of.
    expect(unread.closes.count).toBe(1);
  });

  it("throws the contract's refusal for a table without a key, a side table, and a URL of another database", async () => {
    const { engine } = engineOn(world({ columns: APP, key: [] }));
    await expect(engine.open(target(), WORKER_URL, deps)).rejects.toMatchObject({
      refusal: { code: "primary-key" },
    });
    await expect(
      engine.open(target({ storage: "side-table" }), WORKER_URL, deps),
    ).rejects.toBeInstanceOf(EngineRefusal);
    expect(
      engine.checkUrl(target(), "mysql://facetdb_worker@db/app", { allowInsecure: false }),
    ).toEqual({
      code: "polling-scheme",
      message:
        "TICKETS_URL is a mysql: connection string, and this polling engine reads Plain SQL (plain://); no connection was made",
      fix: 'set TICKETS_URL to a Plain SQL connection string (plain://user:password@host/database), or leave connector: "polling" out so its scheme picks the engine',
    });
    expect(engine.checkUrl(target(), WORKER_URL, { allowInsecure: false })).toBeUndefined();
  });

  it("doctor checks the login and the install, has no pooler check without a pooler rule, and leaves the heartbeat to the store", async () => {
    const { engine } = engineOn(world(installed()));
    expect(engine.checks.map((check) => check.name)).toEqual(["database", "install", "worker"]);
    const checks = await engine.doctor(target(), WORKER_URL, deps);
    expect(checks).toEqual([
      {
        name: "database",
        status: "ok",
        detail: "logged in as facetdb_worker: tickets on localhost/app (round trip 0 ms)",
      },
      {
        name: "install",
        status: "ok",
        detail:
          "the answer columns and facetdb_state_hash are in place; FacetDB polls main.tickets every 10 seconds by updated_at; no trigger",
      },
      {
        name: "worker",
        status: "skip",
        detail:
          "not checked here: the worker's heartbeat is in the FacetDB store, which the store's checks read",
      },
    ]);
    const wrong = await engineOn(world({ ...installed(), whoami: "admin" })).engine.doctor(
      target(),
      WORKER_URL,
      deps,
    );
    expect(wrong[0]).toEqual({
      name: "database",
      status: "fail",
      detail: `"tickets" logs in as admin on localhost/app, not as the worker login facetdb_worker`,
      fix: "set TICKETS_URL to plain://facetdb_worker:<a long random password>@<host>/<database>; facetdb migrate creates that login with the password in it, and it is the only login the worker needs",
    });
    expect(wrong.slice(1).map((check) => [check.name, check.status])).toEqual([
      ["install", "skip"],
      ["worker", "skip"],
    ]);
  });
});
