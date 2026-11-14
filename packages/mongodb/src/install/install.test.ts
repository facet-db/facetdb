import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { FakeMongo, FakeServerError } from "../testing/index.ts";
import { planInstall } from "./install.ts";
import {
  ADMIN,
  deps,
  freshServer,
  installedServer,
  installOptions,
  listings,
  PASSWORD,
  planOf,
  READS,
  refusalOf,
  rights,
  runToEnd,
  target,
} from "./install-world.ts";
import { bindCommand, parseLine, renderScript } from "./mongosh.ts";
import { runPlan } from "./run.ts";

/**
 * The MongoDB install plan on a recording fake of the driver: the listings script byte for byte,
 * what a plan reads and what a run sends, the refusals before anything runs (a standalone server, a
 * server older than the driver's floor, an application's own `facetdb` field among them), the
 * worker login made once with least privilege and its password bound only at run, and the Atlas
 * path, where MongoDB refuses the role and the login to the admin and the run's refusal says how to
 * make them by hand.
 */

const FIXTURE = new URL("./install.listings.mongosh", import.meta.url);

/** The Postgres engine's fix of every refusal whose message says what to change. */
const REFUSED_FIX =
  "change the table or the config as the message says, then run the command again; nothing was changed";

const unauthorized = (command: string) =>
  new FakeServerError(
    13,
    "Unauthorized",
    `not authorized on app to execute command { ${command}: ... }`,
  );

const atlasRefusal = (command: string) =>
  new FakeServerError(
    8000,
    "AtlasError",
    `user is not allowed to do action [${command}] on [app.]`,
  );

/** The steps to make the role and the login by hand, as the Atlas path gives them. */
const STEPS = [
  "On Atlas, open Database Access, then Custom Roles, Add New Custom Role: name it facetdb_worker_listings and give it find, update and changeStream on app.listings; find, insert, update and remove on app.facetdb_jobs; and find on app.facetdb_meta.",
  "Then Database Users, Add New Database User: facetdb_worker, password authentication with a long random password, and the custom role facetdb_worker_listings under Database User Privileges.",
  "The worker's connection string is then mongodb+srv://facetdb_worker:<that password>@<your cluster's host>/app?authSource=admin (Atlas keeps every user in admin); run facetdb migrate again to finish the install.",
  "On your own server, run facetdb migrate with an admin connection string whose user holds userAdmin on app (or root) instead.",
];

/** The driver's refusal of a server older than it supports: a selection error caused by the handshake's. */
const OLD_SERVER = new Error("Server selection timed out after 30000 ms", {
  cause: new Error(
    "Server at 127.0.0.1:27017 reports maximum wire version 8, but this version of the Node.js Driver requires at least 9 (MongoDB 4.4)",
  ),
});

const BELOW_FLOOR = {
  code: "server-version",
  message:
    "the MongoDB server at 127.0.0.1:27017 is older than MongoDB 4.4: the mongodb driver FacetDB connects with talks to 4.4 and later only, and refused it at the handshake; nothing was changed",
  fix: "upgrade the server to MongoDB 4.4 or later, as a replica set; every Atlas cluster already runs one",
};

/** The note for a login that can do more than FacetDB needs, holding `roles`, a user of `db`. */
const beyondLeast = (db: string, roles: string) =>
  `facetdb_worker (a user of ${db}) holds ${roles}, more than FacetDB needs: the least it needs for app.listings is find, update and changeStream on app.listings; find, insert, update and remove on app.facetdb_jobs; and find on app.facetdb_meta. FacetDB takes away no right it did not give.`;

describe("the listings install plan", () => {
  it("prints the committed fixture byte for byte", async () => {
    const plan = planOf(await planInstall(freshServer().connect, target(), ADMIN, installOptions));
    expect(renderScript(plan)).toBe(await readFile(FIXTURE, "utf8"));
  });

  it("claims the collection first, says what each command serves, keeps the password out, runs with no transaction", async () => {
    const plan = planOf(await planInstall(freshServer().connect, target(), ADMIN, installOptions));
    expect(
      plan.statements.map((statement) => [statement.purpose, statement.secret ?? false]),
    ).toEqual([
      ["marker", false],
      ["queue", false],
      ["queue", false],
      ["grants", false],
      ["login", true],
      ["grants", false],
    ]);
    expect(plan.statements.every((statement) => statement.database === "source")).toBe(true);
    expect(plan.transactional).toBe(false);
    expect(plan.removes).toEqual([]);
    expect(plan.keeps).toEqual([]);
    expect(plan.confirm).toBeUndefined();
    expect(JSON.stringify(plan)).not.toContain(PASSWORD);
  });

  it("says plainly that the worker reads every field, and where the answers go", async () => {
    const plan = planOf(await planInstall(freshServer().connect, target(), ADMIN, installOptions));
    expect(plan.notes).toEqual([
      "MongoDB grants rights on whole collections, never on single fields: facetdb_worker can read every field of app.listings, not only title and description, and can update any of them; FacetDB's worker writes only the facetdb field.",
      "The answers go in each document's facetdb field (facetdb.is_scam, facetdb.is_scam_probability, facetdb.status, facetdb.updated_at, facetdb.reviewed and facetdb.state_hash); the worker writes them, and this install changes no document.",
      "MongoDB runs these commands one at a time, with no transaction: if one fails, the ones before it stay, and running facetdb migrate again finishes the install.",
    ]);
  });

  it("reads and changes nothing while it plans, and lets go of the connection", async () => {
    const server = freshServer();
    await planInstall(server.connect, target(), ADMIN, installOptions);
    expect(server.commandNames().every((command) => READS.has(command.split(" ")[0] ?? ""))).toBe(
      true,
    );
    expect(server.calls[0]).toEqual({ kind: "connect", url: ADMIN, forceTls: false });
    expect(server.calls.at(-1)).toEqual({ kind: "close" });
    // The replica set; then, beside listCollections and the marker's findOne, the application's
    // own facetdb field (no marker yet), the role and the login.
    expect(server.commandNames()).toEqual([
      "hello admin",
      "find app",
      "rolesInfo app",
      "usersInfo app",
      "usersInfo admin",
    ]);
  });

  it("runs as printed: each command in order, the password bound at the secret statement only", async () => {
    const server = freshServer();
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    const before = server.commands().length;
    const result = await runToEnd(server, plan);
    expect(result).toEqual({ ran: plan.statements, removed: [], notes: plan.notes });
    const sent = server.commands().slice(before);
    expect(sent).toEqual(
      plan.statements.map((statement) =>
        bindCommand(parseLine(statement.text).command, statement.secret ? PASSWORD : undefined),
      ),
    );
    expect(sent.filter((command) => JSON.stringify(command).includes(PASSWORD))).toEqual([
      { createUser: "facetdb_worker", pwd: PASSWORD, roles: [] },
    ]);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    const app = server.database("app");
    expect(app.users.get("facetdb_worker")).toEqual({
      roles: [{ role: "facetdb_worker_listings", db: "app" }],
      password: PASSWORD,
    });
    expect(app.roles.get("facetdb_worker_listings")).toEqual({
      privileges: rights("listings"),
      roles: [],
    });
    expect(app.markers.get("owner:listings")).toEqual({
      _id: "owner:listings",
      project: "proj_listings",
      source: "listings",
      installedAt: new Date(0),
    });
    // A job is keyed by its collection beside the plain key: the indexes lead with it.
    expect(
      app.indexes.get("facetdb_jobs")?.map((index) => [index.key, index.name, index.unique]),
    ).toEqual([
      [{ collection: 1, record_key: 1 }, "collection_1_record_key_1", true],
      [{ collection: 1, claimed_at: 1 }, "collection_1_claimed_at_1", false],
    ]);
  });

  it("plans nothing on an installed collection: a second plan is empty", async () => {
    const server = await installedServer();
    const again = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    expect(again).toEqual({
      statements: [],
      transactional: false,
      removes: [],
      keeps: [],
      notes: [],
    });
    expect(renderScript(again)).toBe("");
    // An installed collection needs no password: the login is there.
    const { workerPassword: _, ...withoutPassword } = installOptions;
    expect(
      planOf(await planInstall(server.connect, target(), ADMIN, withoutPassword)).statements,
    ).toEqual([]);
  });

  it("finishes when the same plan runs again: a command whose work is done is done", async () => {
    const server = freshServer();
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    await runToEnd(server, plan);
    const before = server.commands().length;
    const result = await runToEnd(server, plan);
    expect(result.ran).toEqual(plan.statements);
    expect(server.commands().length - before).toBe(plan.statements.length);
    // The login there already keeps its password.
    expect(server.database("app").users.get("facetdb_worker")?.password).toBe(PASSWORD);
  });

  it("records the source's new name in the marker and nothing else", async () => {
    const server = await installedServer();
    const renamed = planOf(
      await planInstall(server.connect, target({ source: "ads" }), ADMIN, installOptions),
    );
    expect(renamed.statements.map((statement) => statement.purpose)).toEqual(["marker"]);
    await runToEnd(server, renamed, target({ source: "ads" }));
    expect(server.database("app").markers.get("owner:listings")?.["source"]).toBe("ads");
  });

  it("takes a sharded cluster's router: change streams work through mongos", async () => {
    const server = freshServer();
    server.hello = { ismaster: true, msg: "isdbgrid", ok: 1 };
    expect((await planInstall(server.connect, target(), ADMIN, installOptions)).ok).toBe(true);
  });

  it("installs in the database the config names, beside the connection string's", async () => {
    const server = new FakeMongo().collection("shop", "listings");
    const plan = planOf(
      await planInstall(server.connect, target({ schema: "shop" }), ADMIN, installOptions),
    );
    expect(
      plan.statements.every((statement) => statement.text.startsWith('db.getSiblingDB("shop")')),
    ).toBe(true);
    expect(plan.statements[3]?.text).toContain('resource: { db: "shop", collection: "listings" }');
  });
});

describe("what an install refuses before anything runs", () => {
  it("a standalone server: change streams need a replica set, and the fix says how to make one", async () => {
    const server = freshServer();
    server.hello = { isWritablePrimary: true, ok: 1 };
    const refusal = refusalOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    expect(refusal.code).toBe("no-replica-set");
    expect(refusal.message).toBe(
      "the MongoDB server at 127.0.0.1:27017 is a standalone mongod: FacetDB follows changes with change streams, which only a replica set has (one node is enough); nothing was changed",
    );
    expect(refusal.fix).toContain("mongod --replSet rs0");
    expect(refusal.fix).toContain("rs.initiate()");
    expect(refusal.fix).toContain("on Atlas every cluster is already a replica set");
    expect(server.commandNames()).toEqual(["hello admin"]);
    expect(server.calls.at(-1)).toEqual({ kind: "close" });
  });

  it("a server older than the driver's floor, in words naming the floor and the driver", async () => {
    for (const error of [OLD_SERVER, OLD_SERVER.cause]) {
      if (!(error instanceof Error)) {
        throw new Error("the cause is the handshake's error");
      }
      const server = freshServer().fail("hello", error);
      expect(refusalOf(await planInstall(server.connect, target(), ADMIN, installOptions))).toEqual(
        BELOW_FLOOR,
      );
      expect(server.calls.at(-1)).toEqual({ kind: "close" });
    }
    // Any other failure stays the driver's own error.
    const server = freshServer().fail("hello", new Error("connect ECONNREFUSED 127.0.0.1:27017"));
    await expect(planInstall(server.connect, target(), ADMIN, installOptions)).rejects.toThrow(
      "ECONNREFUSED",
    );
  });

  it("names the floor the driver's own words give, so a driver upgrade cannot leave an old one", async () => {
    const floorOf = async (words: string) => {
      const server = freshServer().fail("hello", new Error(words));
      return refusalOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    };
    const newer = await floorOf(
      "Server at 127.0.0.1:27017 reports wire version 12, but this version of the driver requires at least 13 (MongoDB 5.0).",
    );
    expect(newer.message).toContain("is older than MongoDB 5.0");
    expect(newer.fix).toBe(
      "upgrade the server to MongoDB 5.0 or later, as a replica set; every Atlas cluster already runs one",
    );
    // Words with no version: the pinned driver's own floor.
    const unnamed = await floorOf(
      "Server at 127.0.0.1:27017 reports maximum wire version 8, but this version of the Node.js Driver requires at least 9",
    );
    expect(unnamed).toEqual(BELOW_FLOOR);
  });

  it("a collection another project installed on, under migrate's code, naming that project", async () => {
    const server = freshServer().marker("app", "listings", "proj_other", "listings");
    expect(refusalOf(await planInstall(server.connect, target(), ADMIN, installOptions))).toEqual({
      code: "migrate-refused",
      message:
        "app.listings already carries FacetDB from another project (proj_other); one collection belongs to one project. Uninstall there first, or point this project at another collection.",
      fix: REFUSED_FIX,
    });
  });

  it("a facetdb field with no marker: the application's, which the answers and an uninstall would destroy, or FacetDB's own from a lost marker", async () => {
    const server = freshServer().fields("app", "listings", ["facetdb.color"]);
    expect(refusalOf(await planInstall(server.connect, target(), ADMIN, installOptions))).toEqual({
      code: "migrate-refused",
      message:
        'app.listings already has documents with a field named facetdb, and facetdb_meta holds no marker for it: FacetDB keeps its answers in that field. If the field is the application\'s, rename it, or point this source at another collection. If it is FacetDB\'s own, left by an earlier install whose marker is gone (facetdb_meta dropped by hand, or by an uninstall that ran beside an install), remove it from every document with db.getSiblingDB("app").runCommand({ update: "listings", updates: [{ q: {}, u: { $unset: { facetdb: "" } }, multi: true }] }), or put the marker back with db.getSiblingDB("app").runCommand({ findAndModify: "facetdb_meta", query: { _id: "owner:listings", project: "proj_listings" }, update: { $set: { project: "proj_listings", source: "listings" }, $currentDate: { installedAt: true } }, upsert: true }); then run the command again.',
      fix: REFUSED_FIX,
    });
    expect(server.commands()).toContainEqual({
      find: "listings",
      filter: { facetdb: { $exists: true } },
      projection: { _id: 1 },
      limit: 1,
    });
    expect(server.commandNames().every((command) => READS.has(command.split(" ")[0] ?? ""))).toBe(
      true,
    );
  });

  it("asks nothing of the documents once the marker says the field is FacetDB's", async () => {
    const server = (await installedServer()).fields("app", "listings", ["facetdb.status"]);
    const sent = server.commands().length;
    expect(
      planOf(await planInstall(server.connect, target(), ADMIN, installOptions)).statements,
    ).toEqual([]);
    expect(server.commands().slice(sent)).not.toContainEqual(
      expect.objectContaining({ find: "listings" }),
    );
  });

  it("a state field FacetDB writes, in the Postgres engine's words, before connecting", async () => {
    for (const read of [["title", "facetdb.status"], ["facetdb"]]) {
      const server = freshServer();
      const refusal = refusalOf(
        await planInstall(
          server.connect,
          target({ questionSet: { ...listings, read } }),
          ADMIN,
          installOptions,
        ),
      );
      expect(refusal).toEqual({
        code: "migrate-refused",
        message: `app.listings: the state field ${read.filter((field) => field.startsWith("facetdb")).join(", ")} is a field FacetDB writes; a state field must be the application's own field, or the worker's writes would re-queue every record.`,
        fix: REFUSED_FIX,
      });
      expect(server.calls).toEqual([]);
    }
  });

  it("a collection that does not exist, and a view, which has no change stream", async () => {
    const missing = refusalOf(
      await planInstall(new FakeMongo().connect, target(), ADMIN, installOptions),
    );
    expect(missing.code).toBe("migrate-refused");
    expect(missing.message).toContain('db.getSiblingDB("app").createCollection("listings")');
    expect(missing.fix).toBe(REFUSED_FIX);
    const view = refusalOf(
      await planInstall(
        new FakeMongo().collection("app", "listings", "view").connect,
        target(),
        ADMIN,
        installOptions,
      ),
    );
    expect(view).toEqual({
      code: "migrate-refused",
      message:
        "app.listings is a view, and change streams follow collections only; point the source at the collection the view reads from.",
      fix: REFUSED_FIX,
    });
  });

  it("a login to make with no password given (worker-login), saying where the password goes", async () => {
    const { workerPassword: _, ...withoutPassword } = installOptions;
    expect(
      refusalOf(await planInstall(freshServer().connect, target(), ADMIN, withoutPassword)),
    ).toEqual({
      code: "worker-login",
      message:
        "the worker login facetdb_worker does not exist yet, and no password was given to create it with",
      fix: "put the worker login and a long random password in LISTINGS_URL: mongodb://facetdb_worker:<a long random password>@<host>/app; the install creates the login with that password",
    });
  });

  it("side-table mode, which MongoDB does not have", async () => {
    const refusal = refusalOf(
      await planInstall(
        freshServer().connect,
        target({ storage: "side-table" }),
        ADMIN,
        installOptions,
      ),
    );
    expect(refusal.code).toBe("migrate-refused");
    expect(refusal.message).toContain('remove storage: "side-table"');
  });

  it("no database to install in, or one of MongoDB's own", async () => {
    for (const [url, overrides] of [
      ["mongodb://127.0.0.1:27017", {}],
      ["mongodb://127.0.0.1:27017/?replicaSet=rs0", {}],
      ["mongodb://127.0.0.1:27017/admin", {}],
      [ADMIN, { schema: "local" }],
    ] as const) {
      const server = freshServer();
      const refusal = refusalOf(
        await planInstall(server.connect, target(overrides), url, installOptions),
      );
      expect(refusal.code).toBe("migrate-refused");
      expect(refusal.message).toContain("name the source's database in the connection string");
      expect(server.calls).toEqual([]);
    }
  });

  it("a jobs collection whose index on a collection's keys is not unique: one job per record needs it", async () => {
    const server = freshServer().index("app", "facetdb_jobs", {
      name: "collection_1_record_key_1",
      key: { collection: 1, record_key: 1 },
      unique: false,
    });
    const refusal = refusalOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    expect(refusal.code).toBe("migrate-refused");
    expect(refusal.message).toContain(
      'db.getSiblingDB("app").facetdb_jobs.dropIndex("collection_1_record_key_1")',
    );
  });

  it("adds only the index the jobs collection lacks", async () => {
    const server = freshServer().index("app", "facetdb_jobs", {
      name: "collection_1_record_key_1",
      key: { collection: 1, record_key: 1 },
      unique: true,
    });
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    expect(
      plan.statements
        .filter((statement) => statement.purpose === "queue")
        .map((statement) => statement.text),
    ).toEqual([
      'db.getSiblingDB("app").runCommand({ createIndexes: "facetdb_jobs", indexes: [{ key: { collection: 1, claimed_at: 1 }, name: "collection_1_claimed_at_1" }] })',
    ]);
  });
});

describe("the worker login", () => {
  it("an existing login keeps its password: the plan grants it the role, and sets no password", async () => {
    // Another collection's install made the login.
    const server = await installedServer(target({ table: "users", source: "users" }));
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    expect(plan.statements.some((statement) => statement.secret === true)).toBe(false);
    expect(plan.statements.slice(-2).map((statement) => statement.text)).toEqual([
      'db.getSiblingDB("app").runCommand({ createRole: "facetdb_worker_listings", privileges: [{ resource: { db: "app", collection: "listings" }, actions: ["find", "update", "changeStream"] }, { resource: { db: "app", collection: "facetdb_jobs" }, actions: ["find", "insert", "update", "remove"] }, { resource: { db: "app", collection: "facetdb_meta" }, actions: ["find"] }], roles: [] })',
      'db.getSiblingDB("app").runCommand({ grantRolesToUser: "facetdb_worker", roles: [{ role: "facetdb_worker_listings", db: "app" }] })',
    ]);
    // Its role on the other collection is FacetDB's too: nothing beyond the least privilege.
    expect(plan.notes.some((note) => note.includes("more than FacetDB needs"))).toBe(false);
    await runPlan(server.connect, target(), plan, ADMIN, deps);
    expect(server.database("app").users.get("facetdb_worker")?.roles).toEqual([
      { role: "facetdb_worker_users", db: "app" },
      { role: "facetdb_worker_listings", db: "app" },
    ]);
  });

  it("a login in the source's database gets FacetDB's role even when another role covers it, and a note says it can do more", async () => {
    const server = freshServer()
      .role("app", "readWrite", [
        {
          resource: { db: "app", collection: "" },
          actions: ["find", "insert", "update", "remove", "changeStream"],
        },
      ])
      .user("app", "facetdb_worker", [{ role: "readWrite", db: "app" }]);
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    expect(plan.statements.map((statement) => statement.text.split(":")[0])).toEqual([
      'db.getSiblingDB("app").runCommand({ findAndModify',
      'db.getSiblingDB("app").runCommand({ create',
      'db.getSiblingDB("app").runCommand({ createIndexes',
      'db.getSiblingDB("app").runCommand({ createRole',
      'db.getSiblingDB("app").runCommand({ grantRolesToUser',
    ]);
    expect(plan.notes.at(-1)).toBe(beyondLeast("app", "readWrite@app"));
  });

  it("a login in admin that already has every right (root) needs no role, and a note says it can do more", async () => {
    const server = freshServer()
      .role("admin", "root", [
        {
          resource: { db: "", collection: "" },
          actions: ["find", "insert", "update", "remove", "changeStream", "dropDatabase"],
        },
      ])
      .user("admin", "facetdb_worker", [{ role: "root", db: "admin" }]);
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "marker",
      "queue",
      "queue",
    ]);
    expect(plan.notes.at(-1)).toBe(beyondLeast("admin", "root@admin"));
  });

  it("FacetDB's role changed by hand is given exactly its rights again", async () => {
    const server = await installedServer();
    server.role("app", "facetdb_worker_listings", [
      {
        resource: { db: "app", collection: "listings" },
        actions: ["find", "update", "changeStream", "insert"],
      },
    ]);
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    expect(plan.statements.map((statement) => statement.text)).toEqual([
      'db.getSiblingDB("app").runCommand({ updateRole: "facetdb_worker_listings", privileges: [{ resource: { db: "app", collection: "listings" }, actions: ["find", "update", "changeStream"] }, { resource: { db: "app", collection: "facetdb_jobs" }, actions: ["find", "insert", "update", "remove"] }, { resource: { db: "app", collection: "facetdb_meta" }, actions: ["find"] }], roles: [] })',
    ]);
    await runToEnd(server, plan);
    expect(planOf(await planInstall(server.connect, target(), ADMIN, installOptions))).toEqual({
      statements: [],
      transactional: false,
      removes: [],
      keeps: [],
      notes: [],
    });
  });

  it("shows the steps instead of commands when MongoDB hides its users and roles from the admin", async () => {
    const server = freshServer().fail("usersInfo", unauthorized("usersInfo"));
    const { workerPassword: _, ...withoutPassword } = installOptions;
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, withoutPassword));
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "marker",
      "queue",
      "queue",
    ]);
    expect(plan.notes.slice(3)).toEqual([
      "MongoDB would not show the admin connection string its users and roles, so this plan makes no role or login: give facetdb_worker the rights below yourself.",
      ...STEPS,
    ]);
  });
});

describe("the Atlas path: MongoDB refuses the role and the login to the admin", () => {
  it("stops before them, keeps what ran, and its refusal's fix and notes carry the steps and the worker's connection string", async () => {
    const server = freshServer()
      .fail("createRole", atlasRefusal("createRole"))
      .fail("createUser", atlasRefusal("createUser"));
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    const result = await runPlan(server.connect, target(), plan, ADMIN, installOptions);
    expect(result).toEqual({
      ran: plan.statements.slice(0, 3),
      stopped: {
        at: 3,
        refusal: {
          code: "users-refused",
          message:
            "MongoDB refused createRole to the admin connection string (user is not allowed to do action [createRole] on [app.]): Atlas makes roles and users only on its own pages, and another server needs an admin with userAdmin on app; the commands before it ran and stay",
          // The CLI prints a stopped run's refusal and not its notes.
          fix: STEPS.join(" "),
        },
      },
      removed: [],
      notes: STEPS,
    });
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
    expect(server.commandNames().slice(-1)).toEqual(["createRole app"]);
  });

  it("stops at createUser when only the login is refused (Unauthorized), the role made", async () => {
    const server = freshServer().fail("createUser", unauthorized("createUser"));
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    const result = await runPlan(server.connect, target(), plan, ADMIN, installOptions);
    expect(result.stopped).toMatchObject({
      at: 4,
      refusal: { code: "users-refused", fix: STEPS.join(" ") },
    });
    expect(result.ran).toEqual(plan.statements.slice(0, 4));
    expect(result.notes).toEqual(STEPS);
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("has nothing left to do once the steps are done by hand: the login in admin has every right", async () => {
    const server = freshServer()
      .fail("createRole", atlasRefusal("createRole"))
      .fail("createUser", atlasRefusal("createUser"));
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    await runPlan(server.connect, target(), plan, ADMIN, installOptions);
    // Database Access: the custom role and the user, both in admin, as Atlas makes them.
    server
      .role("admin", "facetdb_worker_listings", rights("listings"))
      .user("admin", "facetdb_worker", [{ role: "facetdb_worker_listings", db: "admin" }]);
    const again = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    expect(again.statements).toEqual([]);
    expect(again.notes).toEqual([]);
  });
});

describe("TLS", () => {
  it("refuses a plaintext connection string to another host before connecting", async () => {
    const server = freshServer();
    const url = "mongodb://admin:secret@db.example.com:27017/app?tls=false";
    const refusal = refusalOf(await planInstall(server.connect, target(), url, installOptions));
    expect(refusal.code).toBe("admin-url-tls");
    expect(refusal.message).toBe(
      "the admin connection string reaches db.example.com with tls=false, so the admin password would travel in the clear; no connection was made",
    );
    expect(server.calls).toEqual([]);
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    const run = await runPlan(server.connect, target(), plan, url, installOptions);
    expect(run.stopped).toMatchObject({ at: 0, refusal: { code: "admin-url-tls" } });
    expect(server.calls.filter((call) => call.kind === "connect" && call.url === url)).toEqual([]);
  });

  it("connects with TLS to another host by default, and as the string says with --allow-insecure", async () => {
    for (const [url, allowInsecure, forceTls] of [
      ["mongodb://admin:secret@db.example.com:27017/app", false, true],
      ["mongodb://admin:secret@db.example.com:27017/app?tls=true", false, false],
      ["mongodb+srv://admin:secret@cluster0.example.mongodb.net/app", false, false],
      ["mongodb://admin:secret@db.example.com:27017/app?ssl=false", true, false],
      [ADMIN, false, false],
    ] as const) {
      const server = freshServer();
      await planInstall(server.connect, target(), url, { ...installOptions, allowInsecure });
      expect(server.calls[0]).toEqual({ kind: "connect", url, forceTls });
    }
  });
});

describe("what a run checks itself", () => {
  it("stops at the secret statement without a password; what ran before it stays", async () => {
    const server = freshServer();
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    const result = await runPlan(server.connect, target(), plan, ADMIN, deps);
    expect(result.stopped).toEqual({
      at: 4,
      refusal: {
        code: "worker-password",
        message: "this plan sets the worker login's password, and the run was given none",
        fix: "set the source's connection string to the worker login with its password",
      },
    });
    expect(result.ran).toEqual(plan.statements.slice(0, 4));
  });

  it("stops at the marker, first, when another project claimed the collection since the plan was read: nothing changed", async () => {
    const server = freshServer();
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    server.marker("app", "listings", "proj_other", "listings");
    const result = await runPlan(server.connect, target(), plan, ADMIN, installOptions);
    expect(result).toEqual({
      ran: [],
      stopped: {
        at: 0,
        refusal: {
          code: "another-project",
          message:
            "app.listings already carries FacetDB from another project (proj_other); one collection belongs to one project. Uninstall there first, or point this project at another collection.",
          fix: REFUSED_FIX,
        },
      },
      removed: [],
      notes: [],
    });
    const app = server.database("app");
    expect(app.collections.has("facetdb_jobs")).toBe(false);
    expect(app.roles.size).toBe(0);
    expect(app.users.size).toBe(0);
  });

  it("stops, refused in words, at a server older than the driver's floor", async () => {
    const server = freshServer();
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    server.fail("findAndModify", OLD_SERVER);
    const result = await runPlan(server.connect, target(), plan, ADMIN, installOptions);
    expect(result).toEqual({
      ran: [],
      stopped: { at: 0, refusal: BELOW_FLOOR },
      removed: [],
      notes: [],
    });
  });

  it("runs nothing of a plan whose lines were changed after printing", async () => {
    const server = freshServer();
    const plan = planOf(await planInstall(server.connect, target(), ADMIN, installOptions));
    const sent = server.commands().length;
    const secretAt = plan.statements.findIndex((statement) => statement.secret === true);
    for (const changed of [
      // Text after the command.
      plan.statements.map((statement, index) =>
        index === 2 ? { ...statement, text: `${statement.text}; db.dropDatabase()` } : statement,
      ),
      // The secret flag dropped: passwordPrompt() where no password may go.
      plan.statements.map(({ secret: _, ...statement }) => statement),
      // The password's place moved to another command, still marked secret.
      plan.statements.map((statement, index) =>
        index === secretAt
          ? {
              ...statement,
              text: 'db.getSiblingDB("app").runCommand({ createUser: "someone_else", pwd: passwordPrompt(), roles: [{ role: "root", db: "admin" }] })',
            }
          : statement,
      ),
      // Another command marked secret.
      plan.statements.map((statement, index) =>
        index === plan.statements.length - 1 ? { ...statement, secret: true as const } : statement,
      ),
    ]) {
      const result = await runPlan(
        server.connect,
        target(),
        { ...plan, statements: changed },
        ADMIN,
        installOptions,
      );
      expect(result.ran).toEqual([]);
      expect(result.stopped).toHaveProperty("error");
    }
    expect(server.commands().length).toBe(sent);
  });

  it("says the server's error, with no secret in it, and keeps what ran", async () => {
    const server = freshServer().fail(
      "createIndexes",
      new FakeServerError(
        67,
        "CannotCreateIndex",
        `cannot create index with ${PASSWORD} and mongodb://admin:secret@x`,
      ),
    );
    const url = "mongodb://admin:secret@127.0.0.1:27017/app";
    const plan = planOf(await planInstall(server.connect, target(), url, installOptions));
    const result = await runPlan(server.connect, target(), plan, url, installOptions);
    expect(result.stopped).toEqual({
      at: 2,
      error: "cannot create index with *** and mongodb://admin:***@x",
    });
    expect(result.ran).toEqual(plan.statements.slice(0, 2));
  });
});
