import {
  type EngineDeps,
  type EnginePlan,
  EngineRefusal,
  type EngineTarget,
  type PlanResult,
  type Refusal,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { afterEach, describe, expect, it } from "vitest";
import { nodeSqliteClient, type SqliteClient } from "../connector/index.ts";
import { JOURNAL_MODE, NO_USERS, ONE_WORKER, WAL_KEPT, WAL_NOTE } from "../install/index.ts";
import { type TemporaryDatabase, temporaryDatabase } from "../testing/index.ts";
import {
  connectionOf,
  createLibsqlEngine,
  LIBSQL_DOCTOR_CHECKS,
  type LibsqlConfig,
  type LibsqlDriver,
  type LibsqlResult,
  type LibsqlTransaction,
  libsqlClient,
  REQUEST_TIMEOUT_MS,
  refusedCredentials,
  SERVER_ACCESS,
  SERVER_JOURNAL,
  SERVER_ONE_WORKER,
  timedFetch,
} from "./index.ts";

/**
 * The libSQL engine without a server: the URL and token rules, the engine's calls through a
 * recording client (a node:sqlite file underneath, so the SQL really runs), which shows what the
 * client is opened with and what each call sends; the plan's pragma left out and its guard table
 * moved to main; the client over a handwritten @libsql/client driver; and the token kept out of
 * every script, plan, result, refusal, error and doctor line. `libsql.db.test.ts` runs the same on
 * sqld.
 */

const START = Date.parse("2026-11-04T09:00:00.000Z");
const TOKEN = "eyJhbGciOiJFZERTQSJ9.c2VjcmV0LXRva2Vu.do-not-print-me";
const TURSO = "libsql://listings-acme.turso.io";
const VARIABLE = "LISTINGS_URL";

const clock = new FakeClock(START);
const deps: EngineDeps = { clock, allowInsecure: false, storeShared: false };

/** The listings, as the SQLite tests have them. */
const LISTINGS =
  "create table listings (id integer primary key, title text, description text, price real)";

function target(changes: Partial<EngineTarget> = {}): EngineTarget {
  return {
    project: { id: "proj_listings", name: "Listings" },
    source: "listings",
    table: "listings",
    storage: "inline",
    onChange: "reset",
    questionSet: {
      questions: [
        { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
      ],
      read: ["title", "description"],
      model: "jev-1.14.0",
      thresholds: {},
    },
    urlVariable: VARIABLE,
    ...changes,
  };
}

function planned(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused (${result.refusal.code}): ${result.refusal.message}`);
  }
  return result.plan;
}

function refusalOf(value: ReturnType<typeof connectionOf>): Refusal {
  if (!("code" in value)) {
    throw new Error("expected a refusal");
  }
  return value;
}

describe("the URL and the auth token", () => {
  const env = { [`${VARIABLE}_AUTH_TOKEN`]: TOKEN };

  it("reads the token from the source's variable with _AUTH_TOKEN appended, else LIBSQL_AUTH_TOKEN", () => {
    expect(connectionOf(target(), TURSO, env, false)).toEqual({
      server: { url: TURSO, host: "listings-acme.turso.io", plaintext: false, loopback: false },
      token: { variable: "LISTINGS_URL_AUTH_TOKEN", value: TOKEN },
    });
    const shared = connectionOf(target(), TURSO, { LIBSQL_AUTH_TOKEN: "other" }, false);
    expect("token" in shared && shared.token).toEqual({
      variable: "LIBSQL_AUTH_TOKEN",
      value: "other",
    });
    // The source's own wins over the shared one; an empty one counts as unset.
    const both = { ...env, LIBSQL_AUTH_TOKEN: "other" };
    expect("token" in connectionOf(target(), TURSO, both, false)).toBe(true);
    const empty = connectionOf(
      target(),
      TURSO,
      { LISTINGS_URL_AUTH_TOKEN: "", LIBSQL_AUTH_TOKEN: "x" },
      false,
    );
    expect(empty).toMatchObject({ token: { variable: "LIBSQL_AUTH_TOKEN" } });
  });

  it("refuses a server not on this machine without a token, naming both variables", () => {
    const refused = refusalOf(connectionOf(target(), TURSO, {}, false));
    expect(refused).toEqual({
      code: "libsql-auth-token",
      message:
        "no auth token for the libSQL server at listings-acme.turso.io: LISTINGS_URL_AUTH_TOKEN and LIBSQL_AUTH_TOKEN are unset; no connection was made",
      fix: "set LISTINGS_URL_AUTH_TOKEN to the database's auth token (turso db tokens create <database> makes one); FacetDB reads it from the environment only, never from the config or the URL",
    });
    const { urlVariable: _variable, ...unnamed } = target();
    const bare = refusalOf(connectionOf(unnamed, TURSO, {}, false));
    expect(bare.message).toContain("LIBSQL_AUTH_TOKEN is unset");
  });

  it("lets a loopback server run without a token, over http", () => {
    for (const url of [
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "http://[::1]:8080",
      "libsql://127.0.0.1:8080?tls=0",
    ]) {
      const connection = connectionOf(target(), url, {}, false);
      expect(connection).toMatchObject({ server: { loopback: true, plaintext: true } });
      expect("token" in connection).toBe(false);
    }
  });

  it("refuses http and ?tls=0 to another machine unless --allow-insecure", () => {
    for (const url of ["http://sqld.internal:8080", "libsql://sqld.internal:8080?tls=0"]) {
      const refused = refusalOf(connectionOf(target(), url, env, false));
      expect(refused.code).toBe("database-url-tls");
      expect(refused.message).toBe(
        "LISTINGS_URL reaches sqld.internal:8080 without TLS (http://, or libsql:// with ?tls=0), so the auth token would travel in the clear; no connection was made",
      );
      expect(connectionOf(target(), url, env, true)).toMatchObject({
        server: { plaintext: true },
        token: { variable: "LISTINGS_URL_AUTH_TOKEN" },
      });
    }
    expect(connectionOf(target(), "https://listings-acme.turso.io", env, false)).toMatchObject({
      server: { plaintext: false },
    });
  });

  it("refuses a token in the URL without echoing it, and a string that names no server", () => {
    const refused = refusalOf(connectionOf(target(), `${TURSO}?authToken=${TOKEN}`, {}, false));
    expect(refused.code).toBe("libsql-token-in-url");
    expect(refused.fix).toBe(
      "remove the authToken parameter from LISTINGS_URL, and set LISTINGS_URL_AUTH_TOKEN to the token instead",
    );
    expect(JSON.stringify(refused)).not.toContain(TOKEN);
    for (const url of [
      "postgres://u:p@db.example.com/app",
      "libsql:",
      "not a url",
      "file:./app.db",
    ]) {
      expect(refusalOf(connectionOf(target(), url, env, false)).code).toBe("libsql-url");
    }
    // The fix shows the local form the CLI routes, never a plain loopback http: URL.
    expect(refusalOf(connectionOf(target(), "not a url", env, false)).fix).toContain(
      "or libsql://127.0.0.1:8080?tls=0 for sqld on this machine",
    );
  });

  it("refuses a parameter given twice: the client reads the last tls, the rule would read the first", () => {
    for (const allowInsecure of [false, true]) {
      const refused = refusalOf(
        connectionOf(
          target(),
          "libsql://listings-acme.turso.io:8080?tls=1&tls=0",
          env,
          allowInsecure,
        ),
      );
      expect(refused).toEqual({
        code: "libsql-url",
        message:
          "LISTINGS_URL gives the tls parameter more than once; the libSQL client would read the last one, so FacetDB judges no such URL; no connection was made",
        fix: "keep one tls parameter in LISTINGS_URL",
      });
    }
    expect(
      refusalOf(connectionOf(target(), `${TURSO}?authToken=a&authToken=b`, env, false)).code,
    ).toBe("libsql-token-in-url");
  });

  it("hands the client the URL as it was judged, so a backslash cannot move the host", () => {
    // The URL standard reads the backslash as a slash: the host is 127.0.0.1, the rest a path.
    const judged = connectionOf(target(), "http://127.0.0.1\\@evil.example:8080", {}, false);
    expect(judged).toEqual({
      server: {
        url: "http://127.0.0.1/@evil.example:8080",
        host: "127.0.0.1",
        plaintext: true,
        loopback: true,
      },
    });
    expect(connectionOf(target(), "http://127.0.0.1:8080", {}, false)).toMatchObject({
      server: { url: "http://127.0.0.1:8080/" },
    });
    // A *.localhost name is no loopback: it may resolve off the machine, so plaintext is refused.
    for (const url of [
      "http://sqld.localhost:8080",
      "http://libsql.localhost\\@evil.example:8080",
    ]) {
      expect(refusalOf(connectionOf(target(), url, env, false)).code).toBe("database-url-tls");
    }
  });
});

describe("the client's requests", () => {
  it("aborts a request the server never answers after REQUEST_TIMEOUT_MS", async () => {
    expect(REQUEST_TIMEOUT_MS).toBe(30_000);
    const signals: AbortSignal[] = [];
    const hanging = (_request: Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal === undefined || signal === null) {
          return;
        }
        signals.push(signal);
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    const fetch = timedFetch(hanging, 5);
    await expect(fetch(new Request("http://127.0.0.1:8080/v2/pipeline"))).rejects.toThrow(
      /timeout|aborted/i,
    );
    expect(signals).toHaveLength(1);
  });
});

/** One call the recording client was asked to make. */
type Call = {
  readonly call: "open" | "run" | "all" | "exec" | "begin" | "commit" | "rollback";
  readonly sql?: string;
};

/**
 * A recording `OpenLibsql`: a node:sqlite file underneath, so the statements really run, and every
 * open (with its config) and call written down in order.
 */
class Recorder {
  readonly file: TemporaryDatabase = temporaryDatabase();
  readonly configs: LibsqlConfig[] = [];
  readonly calls: Call[] = [];
  readonly #clients: SqliteClient[] = [];

  constructor(...tables: readonly string[]) {
    const db = this.file.open();
    for (const sql of tables) {
      db.exec(sql);
    }
    db.close();
  }

  readonly open = (config: LibsqlConfig): SqliteClient => {
    this.configs.push(config);
    this.calls.push({ call: "open" });
    const inner = nodeSqliteClient(this.file.open());
    this.#clients.push(inner);
    const record = (call: Call["call"], sql?: string) =>
      this.calls.push(sql === undefined ? { call } : { call, sql });
    const recorded = (statements: Pick<SqliteClient, "run" | "all" | "exec">) => ({
      run: (sql: string, params?: Parameters<SqliteClient["run"]>[1]) => {
        record("run", sql);
        return statements.run(sql, params);
      },
      all: (sql: string, params?: Parameters<SqliteClient["all"]>[1]) => {
        record("all", sql);
        return statements.all(sql, params);
      },
      exec: (sql: string) => {
        record("exec", sql);
        return statements.exec(sql);
      },
    });
    return {
      ...recorded(inner),
      transaction: (work) =>
        inner.transaction(async (tx) => {
          record("begin");
          try {
            const result = await work(recorded(tx));
            record("commit");
            return result;
          } catch (error) {
            record("rollback");
            throw error;
          }
        }),
      close: () => inner.close(),
    };
  };

  /** Only the statements, in order, between the opens. */
  sql(): readonly string[] {
    return this.calls.flatMap((one) => (one.sql === undefined ? [`(${one.call})`] : [one.sql]));
  }

  async remove(): Promise<void> {
    for (const client of this.#clients) {
      await client.close();
    }
    this.file.remove();
  }
}

const recorders: Recorder[] = [];
function recorder(...tables: readonly string[]): Recorder {
  const made = new Recorder(...tables);
  recorders.push(made);
  return made;
}
afterEach(async () => {
  for (const made of recorders.splice(0)) {
    await made.remove();
  }
});

const ENV = { [`${VARIABLE}_AUTH_TOKEN`]: TOKEN };

describe("the engine through the client", () => {
  it("opens the client with the URL and the token from the environment, and leaves the pragma out of the plan", async () => {
    const made = recorder(LISTINGS);
    const engine = createLibsqlEngine({ env: ENV, open: made.open });
    expect(engine.name).toBe("libsql");
    expect(engine.schemes).toEqual(["libsql", "https", "http"]);
    expect(engine.label(target(), "libsql://app-org.turso.io")).toBe("listings");
    expect(engine.capabilities).toMatchObject({ multipleWorkers: false, pushWakeup: false });
    expect(engine.checks).toBe(LIBSQL_DOCTOR_CHECKS);

    const plan = planned(await engine.planInstall(target(), TURSO, deps));
    expect(made.configs).toEqual([{ url: TURSO, authToken: TOKEN }]);
    // Planning reads, it never writes: no transaction, no exec.
    expect(made.calls.every((one) => one.call === "open" || one.call === "all")).toBe(true);
    expect(plan.statements.map((one) => one.text)).not.toContain(JOURNAL_MODE.text);
    expect(plan.statements[0]?.purpose).toBe("queue");
    expect(plan.notes).toEqual([SERVER_ACCESS, SERVER_ONE_WORKER, SERVER_JOURNAL]);
    expect(plan.notes).not.toContain(NO_USERS);
    expect(plan.notes).not.toContain(ONE_WORKER);
    expect(plan.notes).not.toContain(WAL_NOTE);
    const script = engine.render(plan);
    expect(script.startsWith("begin immediate;\n\n")).toBe(true);
    expect(script.endsWith("commit;\n")).toBe(true);
    expect(script).not.toContain("journal_mode = wal");
  });

  it("runs each statement as printed inside one write transaction, after the owner check, and nothing after", async () => {
    const made = recorder(LISTINGS);
    const engine = createLibsqlEngine({ env: ENV, open: made.open });
    const plan = planned(await engine.planInstall(target(), TURSO, deps));
    made.calls.splice(0);
    const result = await engine.run(target(), plan, TURSO, deps);
    expect(result.stopped).toBeUndefined();
    expect(result.ran).toEqual(plan.statements);
    expect(made.sql()).toEqual([
      "(open)",
      "(begin)",
      "select 1 from sqlite_master where type = 'table' and name = ?",
      ...plan.statements.map((one) => one.text),
      "(commit)",
    ]);
    // Idempotent: planned again, nothing adds a column.
    const again = planned(await engine.planInstall(target(), TURSO, deps));
    expect(again.statements.some((one) => one.purpose === "columns")).toBe(false);
  });

  it("an uninstall's guard table lives in main and the script's last statement drops it", async () => {
    const made = recorder(LISTINGS, LISTINGS.replace("listings", "offers"));
    const engine = createLibsqlEngine({ env: ENV, open: made.open });
    const offers = target({ source: "offers", table: "offers" });
    for (const source of [target(), offers]) {
      expect(
        (
          await engine.run(
            source,
            planned(await engine.planInstall(source, TURSO, deps)),
            TURSO,
            deps,
          )
        ).stopped,
      ).toBeUndefined();
    }
    const uninstall = planned(
      await engine.planUninstall(target(), TURSO, { ...deps, purge: false, alsoUninstalling: [] }),
    );
    const texts = uninstall.statements.map((one) => one.text);
    expect(texts.some((text) => /\btemp\b/.test(text))).toBe(false);
    expect(texts).toContain(
      'create table if not exists "facetdb_guard" ("ok" integer constraint "facetdb: another table of this file still uses it; stop and roll back, nothing of this script is committed yet" check ("ok"))',
    );
    expect(texts.at(-1)).toBe('drop table if exists "facetdb_guard"');
    expect(uninstall.notes).not.toContain(WAL_KEPT);

    for (const source of [target(), offers]) {
      const plan = planned(
        await engine.planUninstall(source, TURSO, { ...deps, purge: false, alsoUninstalling: [] }),
      );
      expect((await engine.run(source, plan, TURSO, deps)).stopped).toBeUndefined();
    }
    const db = made.file.open();
    expect(
      db.prepare("select name from sqlite_master where substr(name, 1, 8) = 'facetdb_'").all(),
    ).toEqual([]);
    db.close();
  });

  it("refuses before it connects: every call, the same refusal, and no client opened", async () => {
    const made = recorder(LISTINGS);
    const engine = createLibsqlEngine({ env: {}, open: made.open });
    const expected = refusalOf(connectionOf(target(), TURSO, {}, false));
    expect(engine.checkUrl(target(), TURSO, deps)).toEqual(expected);
    expect(await engine.planInstall(target(), TURSO, deps)).toEqual({
      ok: false,
      refusal: expected,
    });
    expect(await engine.planPrune(target(), TURSO, deps)).toEqual({ ok: false, refusal: expected });
    const run = await engine.run(
      target(),
      { statements: [], transactional: true, removes: [], keeps: [], notes: [] },
      TURSO,
      deps,
    );
    expect(run.stopped).toEqual({ at: 0, refusal: expected });
    const opened = await engine.open(target(), TURSO, deps).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(opened).toBeInstanceOf(EngineRefusal);
    expect((opened as EngineRefusal).refusal).toEqual(expected);
    expect(made.configs).toEqual([]);
  });

  it("opens the tables of one server on one client, in the database's words, with one worker", async () => {
    const made = recorder(LISTINGS, LISTINGS.replace("listings", "offers"));
    const engine = createLibsqlEngine({ env: ENV, open: made.open });
    const offers = target({ source: "offers", table: "offers" });
    for (const source of [target(), offers]) {
      await engine.run(source, planned(await engine.planInstall(source, TURSO, deps)), TURSO, deps);
    }
    made.configs.splice(0);
    const a = await engine.open(target(), TURSO, { ...deps, workerId: "w1" });
    const b = await engine.open(offers, TURSO, { ...deps, workerId: "w1" });
    expect(made.configs).toEqual([{ url: TURSO, authToken: TOKEN }]);
    expect(await a.claim(1)).toEqual([]);
    const second = await engine.open(target(), TURSO, { ...deps, workerId: "w2" });
    const refused = await second.claim(1).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(EngineRefusal);
    expect((refused as EngineRefusal).message).toContain(
      "worker w1 holds the lock on listings in the libSQL database at listings-acme.turso.io: it last renewed it at",
    );
    expect((refused as EngineRefusal).refusal.fix).toContain("stop the other facetdb worker first");
    expect(JSON.stringify((refused as EngineRefusal).refusal)).not.toContain(TURSO);
    await Promise.all([a.close(), b.close(), second.close()]);
  });
});

describe("doctor", () => {
  it("checks the server, the token, the SQLite under it, the capture, the install and the lock", async () => {
    const made = recorder(LISTINGS);
    const engine = createLibsqlEngine({ env: ENV, open: made.open });
    expect(LIBSQL_DOCTOR_CHECKS.map((check) => check.name)).toEqual([
      "server",
      "token",
      "sqlite",
      "capture",
      "install",
      "marks",
      "lock",
    ]);
    const before = await engine.doctor(target(), TURSO, deps);
    expect(before.map((check) => [check.name, check.status])).toEqual([
      ["server", "ok"],
      ["token", "ok"],
      ["sqlite", "ok"],
      ["capture", "fail"],
      ["install", "fail"],
      ["marks", "skip"],
      ["lock", "skip"],
    ]);
    expect(before[1]?.detail).toBe(
      "the server accepts the auth token from LISTINGS_URL_AUTH_TOKEN",
    );
    await engine.run(
      target(),
      planned(await engine.planInstall(target(), TURSO, deps)),
      TURSO,
      deps,
    );
    const after = await engine.doctor(target(), TURSO, deps);
    expect(after.every((check) => check.status === "ok")).toBe(true);
    expect(after.at(-1)?.detail).toBe("no worker holds the lock; the next facetdb worker takes it");
  });

  it("fails the token check without a token, and when the server refuses it", async () => {
    const made = recorder(LISTINGS);
    const missing = await createLibsqlEngine({ env: {}, open: made.open }).doctor(
      target(),
      TURSO,
      deps,
    );
    expect(missing.map((check) => [check.name, check.status])).toEqual([
      ["server", "skip"],
      ["token", "fail"],
      ["sqlite", "skip"],
      ["capture", "skip"],
      ["install", "skip"],
      ["marks", "skip"],
      ["lock", "skip"],
    ]);
    expect(missing[0]?.detail).toBe("not contacted: there is no auth token to send it");
    const inUrl = await createLibsqlEngine({ env: ENV, open: made.open }).doctor(
      target(),
      `${TURSO}?authToken=${TOKEN}`,
      deps,
    );
    expect(inUrl.slice(0, 2).map((check) => [check.name, check.status, check.detail])).toEqual([
      [
        "server",
        "skip",
        "not contacted: the URL carries an auth token, which FacetDB refuses to send from a connection string",
      ],
      [
        "token",
        "fail",
        refusalOf(connectionOf(target(), `${TURSO}?authToken=x`, {}, false)).message,
      ],
    ]);
    expect(JSON.stringify(inUrl)).not.toContain(TOKEN);
    expect(made.configs).toEqual([]);

    const unauthorized = Object.assign(new Error("SERVER_ERROR: Server returned HTTP status 401"), {
      cause: Object.assign(new Error("Server returned HTTP status 401"), { status: 401 }),
    });
    const refusing = createLibsqlEngine({
      env: ENV,
      open: () => ({
        run: () => Promise.reject(unauthorized),
        all: () => Promise.reject(unauthorized),
        exec: () => Promise.reject(unauthorized),
        transaction: () => Promise.reject(unauthorized),
        close: () => Promise.resolve(),
      }),
    });
    const refused = await refusing.doctor(target(), TURSO, deps);
    expect(refused.slice(0, 2)).toEqual([
      {
        name: "server",
        status: "ok",
        detail: "the libSQL server at listings-acme.turso.io answers",
      },
      {
        name: "token",
        status: "fail",
        detail:
          "the libSQL server at listings-acme.turso.io refused the auth token from LISTINGS_URL_AUTH_TOKEN",
        fix: "set LISTINGS_URL_AUTH_TOKEN to a token of this database (turso db tokens create <database> makes one)",
      },
    ]);
    expect(refusedCredentials(new Error("HRANA_PROTO_ERROR: Unauthorized: JWT expired"))).toBe(
      true,
    );
    expect(refusedCredentials(new Error("fetch failed"))).toBe(false);

    const down = createLibsqlEngine({
      env: ENV,
      open: () => {
        throw new Error("fetch failed");
      },
    });
    const unanswered = await down.doctor(target(), TURSO, deps);
    expect(unanswered[0]).toEqual({
      name: "server",
      status: "fail",
      detail: "the libSQL server at listings-acme.turso.io did not answer: fetch failed",
      fix: "check that the server is running and that LISTINGS_URL names it",
      // No answer at all: a reading of the install behind it tells nothing and may be asked again.
      unreachable: true,
    });
  });

  it("refuses http to another machine as a failed server check", async () => {
    const made = recorder(LISTINGS);
    const checks = await createLibsqlEngine({ env: ENV, open: made.open }).doctor(
      target(),
      "http://sqld.internal:8080",
      deps,
    );
    expect(checks.map((check) => [check.name, check.status])).toEqual([
      ["server", "fail"],
      ["token", "skip"],
      ["sqlite", "skip"],
      ["capture", "skip"],
      ["install", "skip"],
      ["marks", "skip"],
      ["lock", "skip"],
    ]);
    expect(made.configs).toEqual([]);
  });
});

/** A handwritten @libsql/client driver: answers from a script, writes down every call. */
class FakeDriver implements LibsqlDriver {
  readonly calls: string[] = [];
  readonly answers = new Map<string, LibsqlResult>();
  failWith: Error | undefined;

  #answer(sql: string, args: unknown[]): Promise<LibsqlResult> {
    this.calls.push(`${sql} ${JSON.stringify(args)}`);
    if (this.failWith !== undefined) {
      return Promise.reject(this.failWith);
    }
    return Promise.resolve(this.answers.get(sql) ?? { columns: [], rows: [], rowsAffected: 0 });
  }

  execute(statement: { sql: string; args: unknown[] }): Promise<LibsqlResult> {
    return this.#answer(statement.sql, statement.args);
  }

  executeMultiple(sql: string): Promise<void> {
    this.calls.push(`multiple: ${sql}`);
    return Promise.resolve();
  }

  transaction(mode: "write"): Promise<LibsqlTransaction> {
    this.calls.push(`transaction(${mode})`);
    return Promise.resolve({
      execute: (statement) => this.#answer(`tx: ${statement.sql}`, statement.args),
      executeMultiple: (sql) => this.executeMultiple(`tx: ${sql}`),
      commit: () => {
        this.calls.push("commit");
        return Promise.resolve();
      },
      rollback: () => {
        this.calls.push("rollback");
        return Promise.resolve();
      },
      close: () => {
        this.calls.push("close transaction");
      },
    });
  }

  close(): void {
    this.calls.push("close");
  }
}

describe("the client over @libsql/client", () => {
  const config = { url: TURSO, authToken: TOKEN };

  it("binds parameters as a list, reads rows as objects by column, and changes from rowsAffected", async () => {
    const driver = new FakeDriver();
    driver.answers.set("select a, b from t where k = ?", {
      columns: ["a", "b"],
      rows: [
        ["x", 1],
        ["y", null],
      ],
      rowsAffected: 0,
    });
    driver.answers.set("update t set a = ?", { columns: [], rows: [], rowsAffected: 3 });
    const client = libsqlClient(driver, config);
    expect(await client.all("select a, b from t where k = ?", ["42"])).toEqual([
      { a: "x", b: 1 },
      { a: "y", b: null },
    ]);
    expect(await client.run("update t set a = ?", [null])).toEqual({ changes: 3 });
    await client.exec("create table t (a); create index i on t (a)");
    await client.close();
    await client.close();
    expect(driver.calls).toEqual([
      'select a, b from t where k = ? ["42"]',
      "update t set a = ? [null]",
      "multiple: create table t (a); create index i on t (a)",
      "close",
    ]);
  });

  it("a transaction is the client's interactive write transaction: committed, or rolled back when its work throws", async () => {
    const driver = new FakeDriver();
    driver.answers.set("tx: update q set c = ? returning k", {
      columns: ["k"],
      rows: [["1"]],
      rowsAffected: 1,
    });
    const client = libsqlClient(driver, config);
    const claimed = await client.transaction((tx) =>
      tx.all("update q set c = ? returning k", ["w1"]),
    );
    expect(claimed).toEqual([{ k: "1" }]);
    await expect(
      client.transaction(async (tx) => {
        await tx.run("delete from q", []);
        throw new Error("stop");
      }),
    ).rejects.toThrow("stop");
    expect(driver.calls).toEqual([
      "transaction(write)",
      'tx: update q set c = ? returning k ["w1"]',
      "commit",
      "close transaction",
      "transaction(write)",
      "tx: delete from q []",
      "rollback",
      "close transaction",
    ]);
  });

  it("takes turns: a statement never lands between a transaction's statements", async () => {
    const driver = new FakeDriver();
    const client = libsqlClient(driver, config);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transaction = client.transaction(async (tx) => {
      await tx.run("first", []);
      await held;
      await tx.run("second", []);
    });
    const outside = client.run("outside", []);
    await Promise.resolve();
    release();
    await Promise.all([transaction, outside]);
    expect(driver.calls).toEqual([
      "transaction(write)",
      "tx: first []",
      "tx: second []",
      "commit",
      "close transaction",
      "outside []",
    ]);
  });

  it("keeps the token and the URL out of every error it passes on", async () => {
    const driver = new FakeDriver();
    driver.failWith = new Error(`SERVER_ERROR: ${TURSO} said no to Bearer ${TOKEN}`);
    const client = libsqlClient(driver, config);
    const error = await client.all("select 1").then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "SERVER_ERROR: <the connection string> said no to Bearer <the auth token>",
    );
    driver.failWith = new Error("SQLITE_ERROR: no such table: t");
    await expect(client.all("select 1")).rejects.toBe(driver.failWith);
  });
});

describe("the auth token never appears", () => {
  it("in a printed script, a plan or a run as JSON, a refusal, an error or a doctor line", async () => {
    const made = recorder(LISTINGS);
    const engine = createLibsqlEngine({ env: ENV, open: made.open });
    const seen: string[] = [];
    const install = planned(await engine.planInstall(target(), TURSO, deps));
    seen.push(engine.render(install), JSON.stringify(install));
    seen.push(JSON.stringify(await engine.run(target(), install, TURSO, deps)));
    const uninstall = planned(
      await engine.planUninstall(target(), TURSO, { ...deps, purge: true, alsoUninstalling: [] }),
    );
    seen.push(engine.render(uninstall), JSON.stringify(uninstall));
    seen.push(JSON.stringify(await engine.planPrune(target(), TURSO, deps)));
    seen.push(JSON.stringify(await engine.doctor(target(), TURSO, deps)));
    // Refusals and errors: a missing table, another worker's lock, a token in the URL, a bad URL.
    seen.push(JSON.stringify(await engine.planInstall(target({ table: "nowhere" }), TURSO, deps)));
    const opened = await engine.open(target({ table: "nowhere" }), TURSO, deps).then(
      () => undefined,
      (error: unknown) => error,
    );
    seen.push(String(opened), JSON.stringify((opened as EngineRefusal).refusal));
    seen.push(JSON.stringify(engine.checkUrl(target(), `${TURSO}?authToken=${TOKEN}`, deps)));
    seen.push(JSON.stringify(engine.checkUrl(target(), "http://sqld.internal:8080", deps)));
    seen.push(JSON.stringify(await engine.doctor(target(), "http://sqld.internal:8080", deps)));

    expect(made.configs.every((config) => config.authToken === TOKEN)).toBe(true);
    expect(seen.length).toBeGreaterThan(10);
    for (const text of seen) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("do-not-print-me");
    }
  });
});
