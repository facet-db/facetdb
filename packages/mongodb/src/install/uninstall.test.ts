import type { UninstallOptions } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { type FakeMongo, FakeServerError } from "../testing/index.ts";
import { planInstall } from "./install.ts";
import {
  ADMIN,
  deps,
  freshServer,
  installedServer,
  installOptions,
  PROJECT,
  planOf,
  READS,
  refusalOf,
  rights,
  runToEnd,
  target,
} from "./install-world.ts";
import { renderScript } from "./mongosh.ts";
import { runPlan } from "./run.ts";
import { planUninstall } from "./uninstall.ts";

/**
 * The MongoDB uninstall plan on the recording fake: after the project's name, the `facetdb` field
 * of every document, the collection's jobs, its role and its marker go, and the jobs and marker
 * collections only with the database's last installed collection, by lines that check it at run
 * time; the worker login stays, with why. A collection with no install left purges only its log
 * (the CLI's store door), and another project's collection is refused.
 */

const options: UninstallOptions = { ...deps, purge: false, alsoUninstalling: [] };

/** The Postgres engine's fix of every refusal whose message says what to change. */
const REFUSED_FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

const LINES = [
  'db.getSiblingDB("app").runCommand({ update: "listings", updates: [{ q: {}, u: { $unset: { facetdb: "" } }, multi: true }] })',
  'db.getSiblingDB("app").runCommand({ delete: "facetdb_jobs", deletes: [{ q: { collection: "listings" }, limit: 0 }] })',
  'db.getSiblingDB("app").runCommand({ dropRole: "facetdb_worker_listings" })',
  'db.getSiblingDB("app").runCommand({ delete: "facetdb_meta", deletes: [{ q: { _id: "owner:listings", project: "proj_listings" }, limit: 1 }] })',
  'if (db.getSiblingDB("app").getCollection("facetdb_meta").findOne({}) === null) db.getSiblingDB("app").runCommand({ drop: "facetdb_jobs" })',
  'if (db.getSiblingDB("app").getCollection("facetdb_meta").findOne({}) === null) db.getSiblingDB("app").runCommand({ drop: "facetdb_meta" })',
];

/** MongoDB's words for its logins: the user that holds the roles, each collection's role. */
const LOGIN_KEPT = {
  kind: "login",
  name: "facetdb_worker",
  scope: "run",
  noun: "user",
  reason: "uninstall never drops it: other collections and projects of the database may share it",
};

const OWN = [
  { kind: "field", name: "facetdb", of: "app.listings", scope: "source" },
  { kind: "jobs-table", name: "facetdb_jobs", of: "app.listings", scope: "source" },
  {
    kind: "login",
    name: "facetdb_worker_listings",
    of: "app.listings",
    scope: "source",
    noun: "role",
  },
  // Its marker document: "its table-ownership mark", as on every other engine.
  { kind: "marker", name: "facetdb_meta", of: "app.listings", scope: "source" },
];

const SHARED = ["facetdb_jobs", "facetdb_meta"];

/**
 * The database's queue and marks as every other engine's kinds name them, the `collection` kind
 * left to the user's collections.
 */
const shared = (reason: string) => [
  { kind: "jobs-table", name: "facetdb_jobs", scope: "run", reason },
  { kind: "marker", name: "facetdb_meta", scope: "run", reason },
];

const users = target({ table: "users", source: "users" });

/** A second collection of the database installed beside listings, through its own plan. */
async function installUsers(server: FakeMongo): Promise<void> {
  server.collection("app", "users");
  await runToEnd(
    server,
    planOf(await planInstall(server.connect, users, ADMIN, installOptions)),
    users,
  );
}

describe("the uninstall plan", () => {
  it("removes what install added, the shared collections with the last one, and asks the project's name", async () => {
    const server = await installedServer();
    const plan = planOf(await planUninstall(server.connect, target(), ADMIN, options));
    expect(plan.statements.map((statement) => statement.text)).toEqual(LINES);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "columns",
      "data",
      "grants",
      "marker",
      "cleanup",
      "cleanup",
    ]);
    expect(plan.transactional).toBe(false);
    expect(plan.confirm).toEqual({ kind: "project", name: PROJECT.name });
    expect(plan.removes).toEqual([...OWN, ...shared("no collection uses it any more")]);
    expect(plan.removes.some((object) => object.kind === "collection")).toBe(false);
    expect(plan.keeps).toEqual([LOGIN_KEPT]);
    expect(plan.notes).toEqual([
      "Removing the facetdb field writes every document of app.listings that has one, an update each in the oplog: on a large collection, run it when the replica set can take the load.",
    ]);
    expect(renderScript(plan)).toBe(`${LINES.join("\n\n")}\n`);
  });

  it("reads and changes nothing while it plans", async () => {
    const server = await installedServer();
    const sent = server.commands().length;
    await planUninstall(server.connect, target(), ADMIN, options);
    expect(
      server
        .commandNames()
        .slice(sent)
        .every((command) => READS.has(command.split(" ")[0] ?? "")),
    ).toBe(true);
    expect(server.calls.at(-1)).toEqual({ kind: "close" });
  });

  it("runs as printed: the fields, the jobs, the role and the marker go, the login stays", async () => {
    const server = await installedServer();
    server
      .fields("app", "listings", ["facetdb.is_scam", "facetdb.status"])
      .job("app", "listings", "oid:65f0")
      .job("app", "listings", "s:a.b");
    const plan = planOf(await planUninstall(server.connect, target(), ADMIN, options));
    const result = await runToEnd(server, plan);
    expect(result).toEqual({ ran: plan.statements, removed: plan.removes, notes: plan.notes });
    const app = server.database("app");
    expect([...(app.fields.get("listings") ?? [])]).toEqual([]);
    expect(app.roles.has("facetdb_worker_listings")).toBe(false);
    expect(app.users.get("facetdb_worker")?.roles).toEqual([]);
    expect([...app.collections.keys()]).toEqual(["listings"]);
    expect(app.markers.size).toBe(0);
  });

  it("leaves the shared collections to a collection still installed, by the same lines", async () => {
    const server = await installedServer();
    await installUsers(server);
    // Both collections' jobs, under the same key: told apart by the collection beside it.
    server.job("app", "listings", "n:1").job("app", "users", "n:1");
    const plan = planOf(await planUninstall(server.connect, target(), ADMIN, options));
    expect(plan.statements.map((statement) => statement.text)).toEqual(LINES);
    expect(plan.removes).toEqual(OWN);
    expect(plan.keeps).toEqual([...shared("app.users is still installed"), LOGIN_KEPT]);
    const result = await runToEnd(server, plan);
    // The guard found the other collection's marker: nothing shared was dropped.
    expect(result.removed).toEqual(OWN);
    const app = server.database("app");
    expect(app.jobs).toEqual([{ collection: "users", record_key: "n:1" }]);
    expect([...app.markers.keys()]).toEqual(["owner:users"]);
    expect(app.collections.has("facetdb_jobs")).toBe(true);
    expect(app.users.get("facetdb_worker")?.roles).toEqual([
      { role: "facetdb_worker_users", db: "app" },
    ]);
  });

  it("words the whole run when it uninstalls both, never changing a line; the last one drops the shared", async () => {
    const server = await installedServer();
    await installUsers(server);
    const first = planOf(
      await planUninstall(server.connect, target(), ADMIN, {
        ...options,
        alsoUninstalling: [users],
      }),
    );
    expect(first.statements.map((statement) => statement.text)).toEqual(LINES);
    expect(
      first.removes.filter((object) => object.scope === "run").map((object) => object.name),
    ).toEqual(SHARED);
    // The first run finds the other collection still installed: it reports its own objects only.
    expect((await runToEnd(server, first)).removed).toEqual(OWN);
    const second = planOf(await planUninstall(server.connect, users, ADMIN, options));
    const result = await runToEnd(server, second, users);
    expect(
      result.removed.filter((object) => object.scope === "run").map((object) => object.name),
    ).toEqual(SHARED);
    expect([...server.database("app").collections.keys()]).toEqual(["listings", "users"]);
  });

  it("keeps a role made by hand in admin (Atlas's pages), with why and the step to drop it", async () => {
    const server = await installedServer();
    server.database("app").roles.clear();
    server.role("admin", "facetdb_worker_listings", rights("listings"));
    const plan = planOf(await planUninstall(server.connect, target(), ADMIN, options));
    expect(plan.statements.some((statement) => statement.text.includes("dropRole"))).toBe(false);
    expect(plan.removes.some((object) => object.name === "facetdb_worker_listings")).toBe(false);
    expect(plan.keeps).toEqual([
      {
        kind: "login",
        name: "facetdb_worker_listings",
        of: "admin",
        scope: "source",
        noun: "role",
        reason:
          "made by hand in admin, where FacetDB drops no role (Atlas keeps roles to its own pages): delete it in Database Access, Custom Roles, once nothing uses it",
      },
      LOGIN_KEPT,
    ]);
    // With no role in either place, nothing is said of one.
    server.database("admin").roles.clear();
    const without = planOf(await planUninstall(server.connect, target(), ADMIN, options));
    expect(without.keeps).toEqual([LOGIN_KEPT]);
  });

  it("stops with the server's words when a document is refused (ok: 1, a write error), nothing after it run", async () => {
    const server = (await installedServer()).refuseDocuments(
      "listings",
      "Document failed validation",
    );
    const plan = planOf(await planUninstall(server.connect, target(), ADMIN, options));
    const result = await runPlan(server.connect, target(), plan, ADMIN, deps);
    expect(result).toEqual({
      ran: [],
      stopped: { at: 0, error: "MongoDB refused update: Document failed validation" },
      removed: [],
      notes: [],
    });
    expect(server.database("app").markers.has("owner:listings")).toBe(true);
  });

  it("finishes a stopped run when planned again: the marker goes last", async () => {
    const server = (await installedServer()).fail(
      "dropRole",
      new FakeServerError(
        13,
        "Unauthorized",
        "not authorized on app to execute command { dropRole: ... }",
      ),
    );
    const plan = planOf(await planUninstall(server.connect, target(), ADMIN, options));
    const stopped = await runPlan(server.connect, target(), plan, ADMIN, deps);
    expect(stopped.stopped).toEqual({
      at: 2,
      error: "not authorized on app to execute command { dropRole: ... }",
    });
    expect(stopped.ran).toEqual(plan.statements.slice(0, 2));
    expect(server.database("app").markers.has("owner:listings")).toBe(true);
    expect(
      planOf(await planUninstall(server.connect, target(), ADMIN, options)).statements.map(
        (statement) => statement.text,
      ),
    ).toEqual(LINES);
  });
});

describe("what an uninstall refuses, and the purge of a log alone", () => {
  it("a collection FacetDB is not installed on", async () => {
    expect(refusalOf(await planUninstall(freshServer().connect, target(), ADMIN, options))).toEqual(
      {
        code: "uninstall-refused",
        message:
          "FacetDB is not installed on app.listings (facetdb_meta has no marker for it); run migrate first, or check the source's database and collection.",
        fix: REFUSED_FIX,
      },
    );
  });

  it("with --purge, a collection with no install left purges only its log, the source's name typed back", async () => {
    const server = freshServer();
    const plan = planOf(
      await planUninstall(server.connect, target(), ADMIN, { ...options, purge: true }),
    );
    expect(plan).toEqual({
      statements: [],
      transactional: false,
      removes: [],
      keeps: [],
      notes: ["app.listings has no FacetDB install left; only the decision log is purged."],
      confirm: { kind: "source", name: "listings" },
    });
  });

  it("with --purge, a log another installed collection of the project writes under the source's name", async () => {
    const server = freshServer().marker("app", "listings_v2", PROJECT.id, "listings");
    expect(
      refusalOf(await planUninstall(server.connect, target(), ADMIN, { ...options, purge: true })),
    ).toMatchObject({
      code: "uninstall-refused",
      message:
        'the decision log of source "listings" may be shared with app.listings_v2 (project proj_listings), which is still installed; uninstall that collection first, or keep the log. Nothing was changed.',
    });
  });

  it("another project's collection, under uninstall's code: its uninstall is that project's", async () => {
    const server = freshServer().marker("app", "listings", "proj_other", "listings");
    expect(refusalOf(await planUninstall(server.connect, target(), ADMIN, options))).toEqual({
      code: "uninstall-refused",
      message:
        "app.listings already carries FacetDB from another project (proj_other); one collection belongs to one project. Uninstall there first, or point this project at another collection.",
      fix: REFUSED_FIX,
    });
  });

  it("a server older than the driver's floor, in words naming it", async () => {
    // The plan's first read, the marker's, is where the driver's handshake refuses the server.
    const server = freshServer().fail(
      "findOne",
      new Error(
        "Server at 127.0.0.1:27017 reports maximum wire version 8, but this version of the Node.js Driver requires at least 9 (MongoDB 4.4)",
      ),
    );
    const refusal = refusalOf(await planUninstall(server.connect, target(), ADMIN, options));
    expect(refusal.code).toBe("server-version");
    expect(refusal.message).toContain("older than MongoDB 4.4");
  });

  it("a plaintext connection string to another host, before connecting", async () => {
    const server = await installedServer();
    const calls = server.calls.length;
    const refusal = refusalOf(
      await planUninstall(
        server.connect,
        target(),
        "mongodb://db.example.com/app?tls=false",
        options,
      ),
    );
    expect(refusal.code).toBe("admin-url-tls");
    expect(server.calls.length).toBe(calls);
  });
});
