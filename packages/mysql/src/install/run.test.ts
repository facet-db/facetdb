import type { EnginePlan, RunOptions } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import {
  ADMIN_URL,
  type Answer,
  ENGINE_DEPS,
  freshListings,
  installedListings,
  listingsTarget,
  mysqlError,
  recordingDriver,
  type ScriptedDatabase,
  scriptedDatabase,
} from "../testing/index.ts";
import {
  createMysqlInstaller,
  INSTALL_RERUN_NOTE,
  REFUSED_FIX,
  UNINSTALL_RERUN_NOTE,
} from "./index.ts";

/**
 * `run` on the recording driver: the plan's statements one per call, as printed, the worker
 * password bound at the `secret` statement through the driver's escaping and nowhere in a plan, a
 * script or a result; a stop says where, keeps what ran (MySQL commits each statement), and reads
 * the owner guard's stop as the refusal it is.
 */

const PASSWORD = "a-long-random-password";
const RUN: RunOptions = { ...ENGINE_DEPS, workerPassword: PASSWORD };

async function installPlan(database: ScriptedDatabase = freshListings()): Promise<EnginePlan> {
  const result = await createMysqlInstaller({
    connect: recordingDriver(scriptedDatabase(database)).connect,
  }).planInstall(listingsTarget(), ADMIN_URL, RUN);
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.message}`);
  }
  return result.plan;
}

/** A driver over a scripted database whose answer to one statement is a failure. */
function failingAt(database: ScriptedDatabase, fails: (text: string) => Error | undefined) {
  const catalog = scriptedDatabase(database);
  const answer: Answer = (text, params) => {
    const error = fails(text);
    if (error !== undefined) {
      throw error;
    }
    return catalog(text, params);
  };
  return recordingDriver(answer);
}

describe("run", () => {
  it("runs the plan as printed, one statement per call, in order, on one connection it closes", async () => {
    const plan = await installPlan();
    const driver = recordingDriver(scriptedDatabase(freshListings()));
    const result = await createMysqlInstaller({ connect: driver.connect }).run(
      listingsTarget(),
      plan,
      ADMIN_URL,
      RUN,
    );
    expect(result).toEqual({
      ran: plan.statements,
      removed: [],
      // A finished run has no use for the note about a stopped one.
      notes: plan.notes.filter((note) => note !== INSTALL_RERUN_NOTE),
    });
    expect(driver.sent.map((sent) => sent.text)).toEqual(plan.statements.map((s) => s.text));
    expect(driver.opened).toBe(1);
    expect(driver.closed).toBe(1);
  });

  it("binds the password at the secret statement alone, and puts it in no plan, script or result", async () => {
    const plan = await installPlan();
    const driver = recordingDriver(scriptedDatabase(freshListings()));
    const installer = createMysqlInstaller({ connect: driver.connect });
    const result = await installer.run(listingsTarget(), plan, ADMIN_URL, RUN);
    const secret = plan.statements.findIndex((statement) => statement.secret === true);
    expect(driver.sent.map((sent) => sent.params)).toEqual(
      plan.statements.map((_, index) => (index === secret ? [PASSWORD] : undefined)),
    );
    expect(driver.sent[secret]?.text).not.toContain(PASSWORD);
    for (const words of [JSON.stringify(plan), installer.render(plan), JSON.stringify(result)]) {
      expect(words).not.toContain(PASSWORD);
    }
  });

  it("stops at a failing statement, keeps what ran before it, and says how to finish", async () => {
    const plan = await installPlan();
    const at = plan.statements.findIndex((statement) => statement.purpose === "queue");
    const driver = failingAt(freshListings(), (text) =>
      text.startsWith("create table if not exists `app`.`facetdb_jobs`")
        ? mysqlError(
            1142,
            "ER_TABLEACCESS_DENIED_ERROR",
            "CREATE command denied to user 'admin'@'%' for table 'facetdb_jobs'",
          )
        : undefined,
    );
    const result = await createMysqlInstaller({ connect: driver.connect }).run(
      listingsTarget(),
      plan,
      ADMIN_URL,
      RUN,
    );
    expect(result).toEqual({
      ran: plan.statements.slice(0, at),
      stopped: {
        at,
        error: "CREATE command denied to user 'admin'@'%' for table 'facetdb_jobs'",
      },
      removed: [],
      notes: plan.notes,
    });
    expect(result.notes).toContain(INSTALL_RERUN_NOTE);
    // Nothing after the stop was sent.
    expect(driver.sent).toHaveLength(at + 1);
    expect(driver.closed).toBe(1);
  });

  it("tells a failure of the secret statement by its number and code alone, never the server's words", async () => {
    const password = "it's-a-secret\\";
    const plan = await installPlan();
    // A parse error quotes a cut of the statement near the error, the escaped password with it.
    const driver = failingAt(freshListings(), (text) =>
      text.includes("create user")
        ? mysqlError(
            1064,
            "ER_PARSE_ERROR",
            "You have an error in your SQL syntax near 'it\\'s-a-sec' at line 5",
          )
        : undefined,
    );
    const result = await createMysqlInstaller({ connect: driver.connect }).run(
      listingsTarget(),
      plan,
      ADMIN_URL,
      { ...RUN, workerPassword: password },
    );
    expect(result.stopped).toEqual({
      at: plan.statements.findIndex((statement) => statement.secret === true),
      error:
        "creating the worker login failed with error 1064 ER_PARSE_ERROR; the server's words are not shown, since they can quote the password",
    });
    expect(JSON.stringify(result)).not.toContain("sec");
  });

  it("blanks the password, as given and as the driver escaped it, and the URL from another failure's words", async () => {
    const password = "it's-a-secret\\";
    const plan = await installPlan();
    const driver = failingAt(freshListings(), (text) =>
      text.startsWith("grant select (")
        ? mysqlError(
            1044,
            "ER_DBACCESS_DENIED_ERROR",
            `Access denied near 'it\\'s-a-secret\\\\' or ${password} at mysql://admin:admin-secret@127.0.0.1:3306/app`,
          )
        : undefined,
    );
    const result = await createMysqlInstaller({ connect: driver.connect }).run(
      listingsTarget(),
      plan,
      ADMIN_URL,
      { ...RUN, workerPassword: password },
    );
    expect(result.stopped).toEqual({
      at: plan.statements.findIndex((statement) => statement.text.startsWith("grant select (")),
      error: "Access denied near '***' or *** at ***",
    });
    expect(JSON.stringify(result)).not.toContain("a-secret");
  });

  it("reads the owner guard's stop as the another-project refusal, before the table is touched", async () => {
    const plan = await installPlan();
    const guard = plan.statements.findIndex((statement) =>
      statement.text.startsWith("-- stops the script here"),
    );
    // Another project claimed the table between the plan and the run.
    const claimed: ScriptedDatabase = {
      ...freshListings(),
      owners: [{ table: "listings", projectId: "proj_b", source: "listings" }],
    };
    const driver = failingAt(claimed, (text) =>
      text.startsWith("-- stops the script here")
        ? mysqlError(1242, "ER_SUBQUERY_NO_1_ROW", "Subquery returns more than 1 row")
        : undefined,
    );
    const result = await createMysqlInstaller({ connect: driver.connect }).run(
      listingsTarget(),
      plan,
      ADMIN_URL,
      RUN,
    );
    expect(result).toEqual({
      ran: plan.statements.slice(0, guard),
      stopped: {
        at: guard,
        refusal: {
          code: "another-project",
          message:
            "app.listings already carries FacetDB columns from another project (proj_b); one table belongs to one project. Uninstall there first, or point this project at another table.",
          fix: REFUSED_FIX,
        },
      },
      removed: [],
      notes: plan.notes,
    });
    expect(plan.statements.slice(0, guard).map((statement) => statement.purpose)).toEqual([
      "settings",
      "marker",
      "marker",
    ]);
  });

  it("stops before its first statement when the plan creates the login and the run has no password", async () => {
    const plan = await installPlan();
    const driver = recordingDriver(scriptedDatabase(freshListings()));
    expect(
      await createMysqlInstaller({ connect: driver.connect }).run(
        listingsTarget(),
        plan,
        ADMIN_URL,
        ENGINE_DEPS,
      ),
    ).toEqual({
      ran: [],
      stopped: {
        at: 0,
        refusal: {
          code: "worker-password",
          message: "this plan sets the worker login's password, and the run was given none",
          fix: "set the source's connection string to the worker login with its password",
        },
      },
      removed: [],
      notes: [],
    });
    expect(driver.opened).toBe(0);
  });

  it("refuses a plaintext admin URL to another machine before it connects", async () => {
    const plan = await installPlan();
    const driver = recordingDriver();
    const result = await createMysqlInstaller({ connect: driver.connect }).run(
      listingsTarget(),
      plan,
      "mysql://admin:s3cret@db.example.com/app",
      RUN,
    );
    expect(result).toMatchObject({
      ran: [],
      stopped: { at: 0, refusal: { code: "admin-url-tls" } },
    });
    expect(driver.opened).toBe(0);
    // TLS asked for in the URL, as mysql2 reads it, lets it connect.
    const secure = await createMysqlInstaller({ connect: driver.connect }).run(
      listingsTarget(),
      plan,
      'mysql://admin:s3cret@db.example.com/app?ssl={"rejectUnauthorized":true}',
      RUN,
    );
    expect(secure.stopped).toBeUndefined();
  });

  it("runs a plan with nothing to do as nothing, without connecting", async () => {
    const plan = await installPlan(installedListings());
    const driver = recordingDriver();
    expect(
      await createMysqlInstaller({ connect: driver.connect }).run(
        listingsTarget(),
        plan,
        ADMIN_URL,
        RUN,
      ),
    ).toEqual({ ran: [], removed: [], notes: [] });
    expect(driver.opened).toBe(0);
  });
});

describe("run: what an uninstall removed", () => {
  async function uninstallPlan(): Promise<EnginePlan> {
    const result = await createMysqlInstaller({
      connect: recordingDriver(scriptedDatabase(installedListings())).connect,
    }).planUninstall(listingsTarget(), ADMIN_URL, {
      ...ENGINE_DEPS,
      purge: false,
      alsoUninstalling: [],
    });
    if (!result.ok) {
      throw new Error(`refused: ${result.refusal.message}`);
    }
    return result.plan;
  }

  it("reports the run's shared objects once its checks dropped them", async () => {
    const plan = await uninstallPlan();
    // After the run: the queue and the marker table are gone.
    const gone: ScriptedDatabase = { ...freshListings(), tables: freshListings().tables };
    const result = await createMysqlInstaller({
      connect: recordingDriver(scriptedDatabase(gone)).connect,
    }).run(listingsTarget(), plan, ADMIN_URL, ENGINE_DEPS);
    expect(result).toEqual({ ran: plan.statements, removed: plan.removes, notes: [] });
    expect(plan.notes).toEqual([UNINSTALL_RERUN_NOTE]);
  });

  it("reports the table's own objects alone when another table's trigger kept the queue", async () => {
    const plan = await uninstallPlan();
    const kept: ScriptedDatabase = installedListings();
    const result = await createMysqlInstaller({
      connect: recordingDriver(scriptedDatabase(kept)).connect,
    }).run(listingsTarget(), plan, ADMIN_URL, ENGINE_DEPS);
    expect(result.removed).toEqual(plan.removes.filter((object) => object.scope === "source"));
    expect(result.removed.length).toBeLessThan(plan.removes.length);
  });
});
