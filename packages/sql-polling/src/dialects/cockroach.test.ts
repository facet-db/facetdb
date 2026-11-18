import type { EngineDeps, EngineTarget, QuestionSet } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import type { PollingClient, PollingRow, SqlDialect } from "../dialect/index.ts";
import { pollingEngine } from "../engine/index.ts";
import {
  PLAIN_COLUMNS,
  PLAIN_KEY,
  plainDialect,
  recordingClient,
  recordingConnect,
  runDialectConformance,
} from "../testing/index.ts";
import {
  cockroachDialect,
  cockroachOnPostgresWire,
  driverOptions,
  isCockroachVersion,
  postgresWireEngine,
  scramVerifier,
} from "./cockroach.ts";

/**
 * The CockroachDB dialect without a server: the conformance suite with its SQL snapshot
 * cockroach.dialect.sql, the TLS rule and the driver options a connection string gives, and the
 * engine that asks a `postgres://` server's version() which dialect it speaks. What the server does
 * with the SQL is cockroach.db.test.ts's.
 */

runDialectConformance({
  dialect: cockroachDialect,
  fixture: new URL("./cockroach.dialect.sql", import.meta.url),
});

const listings: QuestionSet = {
  questions: [
    { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
  ],
  read: ["title", "description"],
  model: "jev-1.14.0",
  thresholds: {},
};

const target: EngineTarget = {
  project: { id: "proj_listings", name: "Listings" },
  source: "listings",
  table: "listings",
  storage: "inline",
  onChange: "reset",
  questionSet: listings,
  urlVariable: "LISTINGS_URL",
};

const deps: EngineDeps = { clock: new FakeClock(), allowInsecure: false, storeShared: false };

describe("the CockroachDB dialect's TLS rule", () => {
  const verdict = (url: string, allowInsecure = false) =>
    cockroachDialect.tls.verdict(url, allowInsecure);

  it("lets this machine's own node in without TLS: the compose container's URL, a hostless one, a loopback list", () => {
    expect(verdict("cockroachdb://root@127.0.0.1:26257/defaultdb")).toBeUndefined();
    expect(verdict("cockroachdb://root@localhost:26257/defaultdb")).toBeUndefined();
    expect(verdict("cockroachdb://root@[::1]:26257/defaultdb")).toBeUndefined();
    expect(verdict("cockroachdb:///defaultdb")).toBeUndefined();
    expect(verdict("cockroachdb://u@127.0.0.1:26257,localhost:26258/app")).toBeUndefined();
  });

  it("refuses another machine in the clear, by every mode that may send the password so, and names the host", () => {
    for (const url of [
      "cockroachdb://u:p@db.example.com:26257/app",
      "cockroachdb://u:p@db.example.com:26257/app?sslmode=disable",
      "cockroachdb://u:p@db.example.com:26257/app?sslmode=prefer",
      "cockroachdb://u:p@db.example.com:26257/app?sslmode=verify-full&sslmode=disable",
      "cockroachdb://u:p@127.0.0.1:26257,db.example.com:26257/app",
    ]) {
      expect(verdict(url), url).toEqual({ host: "db.example.com" });
    }
  });

  it("lets TLS in, and a plaintext URL only by --allow-insecure, never by a default", () => {
    for (const mode of ["require", "verify-ca", "verify-full"]) {
      expect(verdict(`cockroachdb://u:p@db.example.com:26257/app?sslmode=${mode}`)).toBeUndefined();
    }
    expect(verdict("cockroachdb://u:p@db.example.com:26257/app", true)).toBeUndefined();
  });

  it("reads a string that is no URL as invalid, and two @ before the path as ambiguous, whatever --allow-insecure says", () => {
    expect(verdict("db.example.com:26257/app", true)).toBe("invalid");
    expect(verdict("cockroachdb://u@db%zz.example.com/app")).toBe("invalid");
    expect(verdict("cockroachdb://x@evil.example.com,y@localhost/app", true)).toBe("ambiguous");
  });

  it("is the engine's refusal before anything connects: the worker URL as database-url-tls, the admin URL as admin-url-tls", async () => {
    const client = recordingClient();
    const connect = recordingConnect(client);
    const engine = pollingEngine(cockroachDialect, connect, { warn: () => undefined });
    const clear = "cockroachdb://facetdb_worker:pw@db.example.com:26257/app";
    expect(engine.checkUrl(target, clear, { allowInsecure: false })).toEqual({
      code: "database-url-tls",
      message:
        "LISTINGS_URL reaches db.example.com without TLS, so the password in it would travel in the clear; no connection was made",
      fix: "add ?sslmode=verify-full to LISTINGS_URL, or pass --allow-insecure if that network is trusted",
    });
    const planned = await engine.planInstall(target, clear, deps);
    expect(planned.ok === false && planned.refusal.code).toBe("admin-url-tls");
    expect(engine.checkUrl(target, "postgres://u:p@127.0.0.1/app", deps)?.code).toBe(
      "polling-scheme",
    );
    expect(connect.opened).toEqual([]);
    expect(engine.checkUrl(target, clear, { allowInsecure: true })).toBeUndefined();
  });
});

describe("the CockroachDB connect's driver options", () => {
  const files = (path: string) => Buffer.from(`file:${path}`);

  it("keeps the compose container's URL as it is, with TLS off: it asks for none", () => {
    expect(driverOptions("cockroachdb://root@127.0.0.1:26257/defaultdb", files)).toEqual({
      url: "cockroachdb://root@127.0.0.1:26257/defaultdb",
      ssl: false,
    });
  });

  it("reads sslmode as libpq does, and takes the certificate files off the URL so they are never sent as settings", () => {
    const options = driverOptions(
      "cockroachdb://root@db.example.com:26257/app?sslmode=verify-full&sslrootcert=certs/ca.crt&sslcert=certs/client.root.crt&sslkey=certs/client.root.key&application_name=facetdb",
      files,
    );
    expect(options.url).toBe(
      "cockroachdb://root@db.example.com:26257/app?application_name=facetdb",
    );
    expect(options.ssl).toEqual({
      rejectUnauthorized: true,
      ca: files("certs/ca.crt"),
      cert: files("certs/client.root.crt"),
      key: files("certs/client.root.key"),
    });
    const require = driverOptions("cockroachdb://u@db.example.com/app?sslmode=require", files);
    expect(require.ssl).toEqual({ rejectUnauthorized: false });
    expect(driverOptions("cockroachdb://u@db.example.com/app?sslmode=prefer", files).ssl).toBe(
      "prefer",
    );
  });

  it("verifies against the CA without comparing the name for verify-ca, and for require with a root certificate (libpq's rule)", () => {
    for (const url of [
      "cockroachdb://u@db.example.com/app?sslmode=verify-ca&sslrootcert=ca.crt",
      "cockroachdb://u@db.example.com/app?sslmode=require&sslrootcert=ca.crt",
    ]) {
      const { ssl } = driverOptions(url, files);
      expect(ssl).toMatchObject({ rejectUnauthorized: true, ca: files("ca.crt") });
      expect(
        typeof ssl === "object" && ssl.checkServerIdentity?.("db.example.com", {} as never),
      ).toBe(undefined);
    }
  });

  it("names localhost for a hostless URL, so the driver never reads PGHOST, and refuses a mode it does not know", () => {
    expect(driverOptions("cockroachdb:///app", files).host).toBe("localhost");
    expect(() => driverOptions("cockroachdb://u@db.example.com/app?sslmode=on", files)).toThrow(
      "sslmode=on is not a mode CockroachDB reads; use sslmode=verify-full (or require, verify-ca, disable)",
    );
  });

  it("refuses sslrootcert=system with any mode but verify-full, and reads it alone as verify-full, as libpq does", () => {
    for (const mode of ["require", "verify-ca", "prefer", "disable"]) {
      expect(() =>
        driverOptions(
          `cockroachdb://u@db.example.com/app?sslmode=${mode}&sslrootcert=system`,
          files,
        ),
      ).toThrow(
        `sslrootcert=system checks the node against this machine's CA store, which any public certificate chains to, so it needs sslmode=verify-full (libpq's rule), not sslmode=${mode}; use sslmode=verify-full, or name your cluster's CA file in sslrootcert`,
      );
    }
    const alone = "cockroachdb://u@db.example.com/app?sslrootcert=system";
    expect(driverOptions(alone, files).ssl).toEqual({ rejectUnauthorized: true });
    expect(cockroachDialect.tls.verdict(alone, false)).toBeUndefined();
  });

  it("takes every TLS parameter off the URL, the key's passphrase as the key's, and refuses any other ssl parameter rather than send it as a session setting", () => {
    const options = driverOptions(
      "cockroachdb://u@db.example.com/app?sslmode=verify-full&sslkey=client.key&sslcert=client.crt&sslpassword=s3cret",
      files,
    );
    expect(options.url).toBe("cockroachdb://u@db.example.com/app");
    expect(options.ssl).toMatchObject({ passphrase: "s3cret", key: files("client.key") });
    for (const extra of ["sslcrl=crl.pem", "sslsni=0", "ssl=true", "SSLMODE=require"]) {
      const name = extra.split("=")[0] ?? "";
      expect(() =>
        driverOptions(`cockroachdb://u@db.example.com/app?sslmode=verify-full&${extra}`, files),
      ).toThrow(
        `the connection string has ${name}, which FacetDB's CockroachDB connection does not read (it reads sslmode, sslrootcert, sslcert, sslkey, sslpassword); remove it, and ask for TLS with sslmode=verify-full`,
      );
    }
  });

  it("reads sslrootcert=system as the machine's own CA store, never as a file", () => {
    const read = (path: string): Buffer => {
      throw new Error(`read ${path}`);
    };
    expect(
      driverOptions(
        "cockroachdb://u@db.example.com/app?sslmode=verify-full&sslrootcert=system",
        read,
      ),
    ).toEqual({ url: "cockroachdb://u@db.example.com/app", ssl: { rejectUnauthorized: true } });
  });
});

describe("the CockroachDB plans", () => {
  /** A catalog with the listings table (keyed by id, an updated_at NOT NULL) and no worker login. */
  const catalog =
    (version: string) =>
    (text: string): readonly PollingRow[] | undefined => {
      if (text.includes("version()")) {
        return [{ version }];
      }
      if (text.includes(" as present")) {
        return [{ present: true }];
      }
      if (text.includes("format_type") || text === PLAIN_COLUMNS) {
        return ["id", "title", "description", "updated_at"].map((name) => ({
          name,
          type: name === "updated_at" ? "timestamp with time zone" : "text",
          comment: null,
          time: name === "updated_at",
          nullable: name === "title" || name === "description",
          readable: true,
        }));
      }
      if (text.includes("indisprimary") || text === PLAIN_KEY) {
        return [{ name: "id" }];
      }
      if (text.includes("current_user")) {
        return [{ name: "facetdb_worker" }];
      }
      if (text.includes("pg_backend_pid")) {
        return [{ pid: "7" }];
      }
      return undefined;
    };

  it("claims the table first, then adds each column in one group with its mark, with no lock and no header, and says the grants are the table's", async () => {
    const engine = pollingEngine(cockroachDialect, recordingConnect(recordingClient(catalog(""))), {
      warn: () => undefined,
    });
    const result = await engine.planInstall(target, "cockroachdb://root@127.0.0.1:26257/app", {
      ...deps,
      workerPassword: "a-long-random-password",
    });
    if (!result.ok) {
      throw new Error(result.refusal.message);
    }
    const { plan } = result;
    expect(plan.transactional).toBe(false);
    // The claim: facetdb_state_hash added without `if not exists`, with the project's mark.
    expect(plan.statements[0]).toEqual({
      database: "source",
      purpose: "marker",
      text: `begin;\nset local autocommit_before_ddl = off;\nalter table "public"."listings"\n  add column "facetdb_state_hash" text;\ncomment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings';\ncommit`,
    });
    expect(plan.statements[1]?.text).toBe(
      `begin;\nset local autocommit_before_ddl = off;\nalter table "public"."listings"\n  add column if not exists "is_scam" boolean;\ncomment on column "public"."listings"."is_scam" is 'facetdb';\ncommit`,
    );
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "marker",
      ...Array.from({ length: 5 }, () => "columns"),
      "login",
      ...Array.from({ length: 3 }, () => "grants"),
    ]);
    expect(engine.render(plan)).not.toMatch(/\block table\b|grant select \(/);
    expect(plan.notes).toContain(
      "CockroachDB has no column-level grants, so the worker login facetdb_worker may read and update every column of public.listings, not only its key, the state fields and FacetDB's own columns (FacetDB reads and writes only those); keep a column the worker must never read in another table",
    );
  });

  it("binds a SCRAM verifier at the login, never the password, salted afresh each time", () => {
    const login = cockroachDialect.login;
    const one = login?.secret("a-long-random-password");
    const two = login?.secret("a-long-random-password");
    expect(one?.text).toBe('create user if not exists "facetdb_worker" with login password $1');
    expect(String(one?.params[0])).toMatch(
      /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/,
    );
    expect(one?.params[0]).not.toBe(two?.params[0]);
    expect(JSON.stringify(one)).not.toContain("a-long-random-password");
  });

  it("computes the verifier packages/postgres/src/install/scram.ts computes, byte for byte (a known answer)", () => {
    // Printed once by the Postgres package's scramVerifier("pencil", sixteen bytes of 7), the
    // original this module copies: a broken copy fails here before a secure node refuses its login.
    expect(scramVerifier("pencil", Buffer.alloc(16, 7))).toBe(
      "SCRAM-SHA-256$4096:BwcHBwcHBwcHBwcHBwcHBw==$K97YndbwHX05fl7lN8Bcm3gG4nc43WvYj0OL1dbknsk=:tvU6S2vfOxKAzPZ5dC4h+cucyZ553rNC2MQ2ZJzmu3g=",
    );
  });
});

describe("two projects on one CockroachDB table (with no lock to hold it)", () => {
  const OTHER = "facetdb:proj_other";

  /**
   * The listings table as the catalog shows it, `owner` the project mark on facetdb_state_hash
   * (none: the column is not there), with a client that runs a group through its own transaction.
   */
  function world(options: { owner?: string; claimFails?: boolean; claimedMeanwhile?: boolean }) {
    let owner = options.owner;
    const sent: string[] = [];
    const facts = (text: string): readonly PollingRow[] => {
      if (text.includes(" as present")) {
        return [{ present: true }];
      }
      if (text.includes("format_type")) {
        const app = ["id", "title", "description", "updated_at"].map((name) => ({
          name,
          type: name === "updated_at" ? "timestamp with time zone" : "text",
          comment: null,
          time: name === "updated_at",
          nullable: name === "title" || name === "description",
          readable: true,
        }));
        return owner === undefined
          ? app
          : [
              ...app,
              {
                name: "facetdb_state_hash",
                type: "text",
                comment: owner,
                time: false,
                nullable: true,
                readable: true,
              },
            ];
      }
      if (text.includes("indisprimary")) {
        return [{ name: "id" }];
      }
      if (text.includes("pg_roles")) {
        return [{ exists: 1 }];
      }
      return [];
    };
    const query = (text: string) => {
      sent.push(text);
      return Promise.resolve(facts(text));
    };
    const client: PollingClient = {
      query,
      transaction: (work) =>
        work(async (text) => {
          sent.push(`[transaction] ${text}`);
          if (text.includes(`add column "facetdb_state_hash"`)) {
            if (options.claimFails === true) {
              // The other project's claim committed first: its add won, this one fails.
              owner = OTHER;
              throw new Error(`column "facetdb_state_hash" of relation "listings" already exists`);
            }
            // This claim committed, and the other project overwrote its mark right after.
            owner = options.claimedMeanwhile === true ? OTHER : "facetdb:proj_listings";
          }
          return [];
        }),
      close: () => Promise.resolve(),
    };
    const engine = pollingEngine(cockroachDialect, () => client, { warn: () => undefined });
    return { engine, sent };
  }

  const url = "cockroachdb://root@127.0.0.1:26257/app";

  it("stops a run whose claim another project's won, with the ownership refusal, after nothing else ran", async () => {
    const { engine, sent } = world({ claimFails: true });
    const plan = await engine.planInstall(target, url, deps);
    if (!plan.ok) {
      throw new Error(plan.refusal.message);
    }
    const ran = await engine.run(target, plan.plan, url, deps);
    expect(ran.stopped).toEqual({
      at: 0,
      refusal: {
        code: "another-project",
        message:
          "public.listings already carries FacetDB columns from another project (proj_other); one table belongs to one project. Uninstall there first, or point this project at another table.",
        fix: "change the table or the config as the message says, then run the command again; nothing was changed",
      },
    });
    expect(ran.ran).toEqual([]);
    // The group went through the client's transaction, its setting first, never as one text.
    expect(sent.filter((text) => text.startsWith("[transaction]"))).toHaveLength(1);
    expect(sent.some((text) => text.startsWith("begin;"))).toBe(false);
  });

  it("stops a run when the mark read right after its claim is another project's", async () => {
    const { engine } = world({ claimedMeanwhile: true });
    const plan = await engine.planInstall(target, url, deps);
    if (!plan.ok) {
      throw new Error(plan.refusal.message);
    }
    const ran = await engine.run(target, plan.plan, url, deps);
    expect(ran.stopped).toMatchObject({ at: 0, refusal: { code: "another-project" } });
    expect(ran.ran.map((statement) => statement.purpose)).toEqual(["marker"]);
  });

  it("refuses a second project's plan, and its worker's open, on a table the first one's mark claims", async () => {
    const { engine } = world({ owner: OTHER });
    const plan = await engine.planInstall(target, url, deps);
    expect(plan.ok === false && plan.refusal.code).toBe("migrate-refused");
    await expect(engine.open(target, url, { ...deps, workerId: "w" })).rejects.toMatchObject({
      refusal: {
        code: "another-project",
        message:
          "public.listings already carries FacetDB columns from another project (proj_other); one table belongs to one project. Uninstall there first, or point this project at another table.",
      },
    });
  });

  it("plans only the marks on its own installed table: no add, so nothing is claimed twice", async () => {
    const { engine } = world({ owner: "facetdb:proj_listings" });
    const plan = await engine.planInstall(target, url, deps);
    if (!plan.ok) {
      throw new Error(plan.refusal.message);
    }
    expect(plan.plan.statements[0]?.text).toBe(
      `comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings'`,
    );
    expect(
      plan.plan.statements.filter((one) => one.text.includes(`"facetdb_state_hash" text`)),
    ).toEqual([]);
  });
});

describe('a postgres:// source with connector: "polling"', () => {
  /** The composition root's Postgres dialect, stood in for by the plain one under Postgres's schemes. */
  const postgresStandIn: SqlDialect = {
    ...plainDialect,
    name: "Postgres",
    schemes: ["postgres", "postgresql"],
    lock: (ref) =>
      `lock table ${plainDialect.quoteTable(ref.schema, ref.name)} in share row exclusive mode`,
  };

  function wire(version: string) {
    const client = recordingClient((text) => {
      if (text.includes("version()")) {
        return [{ version }];
      }
      return undefined;
    });
    const connect = recordingConnect(client);
    return {
      client,
      connect,
      engine: postgresWireEngine({ postgres: postgresStandIn, connect, warn: () => undefined }),
    };
  }

  it("tells CockroachDB from Postgres by version()", () => {
    expect(
      isCockroachVersion(
        "CockroachDB CCL v24.3.37 (x86_64-pc-linux-gnu, built 2026/10/21 02:10:26, go1.22.12)",
      ),
    ).toBe(true);
    expect(isCockroachVersion("CockroachDB OSS v23.1.0")).toBe(true);
    expect(
      isCockroachVersion("PostgreSQL 16.4 on x86_64-pc-linux-gnu, compiled by gcc, 64-bit"),
    ).toBe(false);
  });

  it("plans with the CockroachDB dialect when the server says CockroachDB, and asks it once per URL", async () => {
    const { engine, client, connect } = wire("CockroachDB CCL v24.3.37 (x86_64-pc-linux-gnu)");
    const url = "postgres://root@127.0.0.1:26257/app";
    // Not installed: the uninstall's refusal is worded with the dialect's table, after asking.
    const first = await engine.planUninstall(target, url, {
      ...deps,
      purge: false,
      alsoUninstalling: [],
    });
    const second = await engine.planPrune(target, url, deps);
    expect(first.ok).toBe(false);
    expect(second).toEqual({
      ok: true,
      plan: { statements: [], transactional: false, removes: [], keeps: [], notes: [] },
    });
    expect(client.statements.filter((one) => one.text.includes("version()"))).toHaveLength(1);
    expect(connect.opened[0]).toEqual({ url });
    // Its words are a Postgres URL's: the CockroachDB SQL, judged by the Postgres rule.
    expect(engine.schemes).toEqual(["postgres", "postgresql"]);
    expect(engine.checks.map((check) => check.name)[0]).toBe("dialect");
    // A bare table is in the Postgres dialect's default schema, named with no question asked; the
    // stand-in's is the plain dialect's.
    expect(engine.label(target)).toBe(`${postgresStandIn.defaultSchema}.listings`);
  });

  it("says which it found on doctor's first line", async () => {
    const cockroach = wire("CockroachDB CCL v24.3.37 (x86_64-pc-linux-gnu, built 2026/10/21)");
    const url = "postgres://facetdb_worker:pw@127.0.0.1:26257/app";
    const [line] = await cockroach.engine.doctor(target, url, deps);
    expect(line).toEqual({
      name: "dialect",
      status: "ok",
      detail:
        '"listings" on 127.0.0.1:26257/app answers version() as CockroachDB CCL v24.3.37, so FacetDB polls it with the CockroachDB dialect',
    });
    const postgres = wire("PostgreSQL 16.4 on x86_64-pc-linux-gnu, compiled by gcc");
    const [other] = await postgres.engine.doctor(target, url, deps);
    expect(other?.detail).toBe(
      '"listings" on 127.0.0.1:26257/app answers version() as PostgreSQL 16.4, so FacetDB polls it with the Postgres dialect',
    );
  });

  it("keeps Postgres's SQL for a Postgres server: its lock, as the Postgres dialect plans it", async () => {
    const { engine, client } = wire("PostgreSQL 16.4 on x86_64-pc-linux-gnu");
    await engine.planUninstall(target, "postgres://root@127.0.0.1/app", {
      ...deps,
      purge: false,
      alsoUninstalling: [],
    });
    // The stand-in's catalog read, not CockroachDB's: the Postgres dialect read the table.
    expect(client.statements.some((one) => one.text === PLAIN_COLUMNS)).toBe(true);
    expect(client.statements.some((one) => one.text.includes("format_type"))).toBe(false);
  });

  it("asks nothing of a URL the Postgres rule refuses before connecting, and refuses it in that rule's words", async () => {
    const { engine, connect } = wire("CockroachDB CCL v24.3.37");
    const clear = "postgres://u:pw@db.example.com/app";
    const refused = await engine.planInstall(target, clear, deps);
    expect(refused.ok === false && refused.refusal.code).toBe("admin-url-tls");
    const doctor = await engine.doctor(target, clear, deps);
    expect(doctor[0]).toEqual({
      name: "dialect",
      status: "skip",
      detail: "not checked: the connection string was refused before connecting",
    });
    expect(doctor[1]).toMatchObject({ name: "database", status: "fail" });
    await expect(engine.open(target, clear, { ...deps, workerId: "w" })).rejects.toThrow(
      "reaches db.example.com without TLS",
    );
    expect(connect.opened).toEqual([]);
  });

  it("asks again after a failed question, and a run that cannot ask stops with the reason, no secret in it", async () => {
    const client = recordingClient();
    const connect = recordingConnect(client);
    const engine = postgresWireEngine({
      postgres: postgresStandIn,
      connect,
      warn: () => undefined,
    });
    const url = "postgres://root:s3cret@127.0.0.1:26257/app";
    client.failNext(new Error("password authentication failed for root:s3cret"));
    const ran = await engine.run(
      target,
      { statements: [], transactional: false, removes: [], keeps: [], notes: [] },
      url,
      { ...deps },
    );
    expect(ran.stopped).toEqual({ at: 0, error: "password authentication failed for root:***" });
    client.answer([{ version: "CockroachDB CCL v24.3.37" }]);
    const [line] = await engine.doctor(target, url, deps);
    expect(line?.status).toBe("ok");
  });

  it("gives the CockroachDB SQL the Postgres dialect's TLS rule and worker URL shape", () => {
    const onWire = cockroachOnPostgresWire(postgresStandIn);
    expect(onWire.tls).toBe(postgresStandIn.tls);
    expect(onWire.schemes).toEqual(["postgres", "postgresql"]);
    expect(onWire.login?.urlShape).toBe(postgresStandIn.login?.urlShape);
    expect(onWire.addColumns).toBe(cockroachDialect.addColumns);
    expect(onWire.lock).toBeUndefined();
  });
});
