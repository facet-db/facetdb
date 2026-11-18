import { readFile } from "node:fs/promises";
import type {
  EnginePlan,
  EngineTarget,
  InstallOptions,
  PlanResult,
  QuestionSet,
  Refusal,
} from "@facetdb/core";
import { describe, expect, it } from "vitest";
import {
  ADMIN_URL,
  ENGINE_DEPS,
  freshListings,
  installedListings,
  installedSideListings,
  LISTINGS_QUESTIONS,
  LISTINGS_TABLE,
  MARIADB_SQL_MODE,
  recordingDriver,
  type ScriptedDatabase,
  type ScriptedTable,
  scriptedDatabase,
  sideListingsTarget,
} from "../testing/index.ts";
import {
  createMysqlInstaller,
  INSTALL_RERUN_NOTE,
  normalizedDefinition,
  OWNED_MARK,
  REFUSED_FIX,
  SETTINGS,
  SIDE_TABLE_NAME_LIMIT,
  storedViewDefinition,
  WORKER_ACCOUNT,
} from "./index.ts";

/**
 * Side-table mode on MySQL and MariaDB on the recording driver: the listings example renders byte
 * for byte as install.listings.side-table.sql, the table gains no column, the side table is keyed
 * by the table's key in its own type and references it where InnoDB allows, the view runs with its
 * reader's rights, the triggers upsert the side row and queue the record, the worker reads the
 * table's key and state and writes the side table only, the readers of the table are given the
 * view, a plan of an installed table is empty, and uninstall and prune touch FacetDB's objects
 * only. The db suite (connector/side-table.db.test.ts) runs the same plans on both servers.
 */

const FIXTURE = new URL("./install.listings.side-table.sql", import.meta.url);
const INSTALL: InstallOptions = { ...ENGINE_DEPS, workerPassword: "a-long-random-password" };
const SIDE = "`app`.`facetdb_listings_answers`";
const VIEW = "`app`.`listings_with_answers`";
const TABLE = "`app`.`listings`";

const installer = (database: ScriptedDatabase) =>
  createMysqlInstaller({ connect: recordingDriver(scriptedDatabase(database)).connect });

async function install(
  database: ScriptedDatabase,
  target: EngineTarget = sideListingsTarget(),
): Promise<PlanResult> {
  return installer(database).planInstall(target, ADMIN_URL, INSTALL);
}

function planOf(result: PlanResult): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

function refusalOf(result: PlanResult): Refusal {
  if (result.ok) {
    throw new Error(`planned: ${JSON.stringify(result.plan.statements)}`);
  }
  return result.refusal;
}

const texts = (plan: EnginePlan) => plan.statements.map((statement) => statement.text);
const render = installer(freshListings()).render;

/** The database with one table replaced, or added. */
function withTable(database: ScriptedDatabase, table: ScriptedTable): ScriptedDatabase {
  const others = database.tables.filter((one) => one.name !== table.name);
  return { ...database, tables: [...others, table] };
}

/** The listings example with a second question: a choice, whose columns follow is_scam's. */
const TWO_QUESTIONS: QuestionSet = {
  ...LISTINGS_QUESTIONS,
  questions: [
    ...LISTINGS_QUESTIONS.questions,
    {
      type: "choice",
      name: "category",
      instructions: "What is being sold?",
      options: [
        { name: "car", description: "A vehicle" },
        { name: "flat", description: "A place to live" },
      ],
      stakes: "low",
      storeProbabilities: false,
    },
  ],
};

const refused = (message: string): Refusal => ({
  code: "migrate-refused",
  message,
  fix: REFUSED_FIX,
});

const nameTaken = (message: string): Refusal => ({
  code: "name-taken",
  message,
  fix: "rename or drop that object if nothing uses it, or rename the table, then run facetdb migrate again",
});

describe("planInstall in side-table mode: the listings example", () => {
  it("renders byte for byte as install.listings.side-table.sql", async () => {
    const plan = planOf(await install(freshListings()));
    expect(render(plan)).toBe(await readFile(FIXTURE, "utf8"));
  });

  it("is one text for MySQL and MariaDB", async () => {
    const mysql = planOf(await install(freshListings()));
    const mariadb = planOf(
      await install({
        ...freshListings(),
        version: "10.6.20-MariaDB-ubu2204",
        sqlMode: MARIADB_SQL_MODE,
      }),
    );
    expect(render(mariadb)).toBe(render(mysql));
  });

  it("adds no column to the table and writes none of its rows: it names the table only to reference, read, grant and trigger on it", async () => {
    const plan = planOf(await install(freshListings()));
    const naming = texts(plan).filter((text) => text.includes(TABLE));
    expect(naming.map((text) => text.split("\n")[0])).toEqual([
      `create table if not exists ${SIDE} (`,
      `create or replace sql security invoker view ${VIEW} as`,
      "grant select (`id`, `title`, `description`)",
      "create definer = current_user trigger `app`.`facetdb_listings_ins` after insert on `app`.`listings` for each row",
      "create definer = current_user trigger `app`.`facetdb_listings_upd` after update on `app`.`listings` for each row",
    ]);
    expect(texts(plan).some((text) => /alter table `app`\.`listings`\s/.test(text))).toBe(false);
  });

  it("tags every statement as the source's, with its purpose, in the order the script runs", async () => {
    const plan = planOf(await install(freshListings()));
    expect(plan.statements.every((statement) => statement.database === "source")).toBe(true);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      "marker",
      "marker",
      "marker",
      "columns",
      "columns",
      "queue",
      "login",
      "grants",
      "grants",
      "grants",
      "grants",
      "grants",
      "capture",
      "capture",
      "capture",
      "capture",
    ]);
  });

  it("says what the foreign key refuses, what the view shows, to whom, and what a later column or reader needs", async () => {
    const plan = planOf(await install(freshListings()));
    expect(plan.notes[0]).toBe(INSTALL_RERUN_NOTE);
    expect(plan.notes.slice(-3)).toEqual([
      "app.facetdb_listings_answers references app.listings by its key, so a deleted record takes its answers with it; while it stands, MySQL and MariaDB refuse truncate table and drop table on app.listings and a change of its key column's type (delete from works, and facetdb uninstall removes the reference), and online schema-change tools need telling: gh-ost refuses a table another table references, and pt-online-schema-change needs --alter-foreign-keys-method.",
      "app.listings_with_answers lists the columns app.listings has now: after the application adds, renames or drops one of them, run facetdb migrate again to re-create the view (until then a dropped column makes it fail with error 1356).",
      "app.listings_with_answers runs with the rights of whoever reads it (SQL SECURITY INVOKER), so it shows no account more than app.listings does: the accounts that hold select on app.listings now get select on the view and on app.facetdb_listings_answers, and one given select on app.listings later reads the view once facetdb migrate runs again (or after the same two grants by hand).",
    ]);
  });
});

describe("the side table", () => {
  it("is keyed by the table's key in its own type, character set and collation, never its auto_increment", async () => {
    const database = withTable(freshListings(), {
      ...LISTINGS_TABLE,
      columns: [
        {
          name: "id",
          type: "varchar(36)",
          charset: "utf8mb4",
          collation: "utf8mb4_0900_ai_ci",
        },
        ...LISTINGS_TABLE.columns.slice(1),
      ],
    });
    const create = texts(planOf(await install(database)))[4] ?? "";
    expect(create).toContain(
      "`id` varchar(36) character set utf8mb4 collate utf8mb4_0900_ai_ci not null primary key",
    );
    const unsigned = withTable(freshListings(), {
      ...LISTINGS_TABLE,
      columns: [
        { name: "id", type: "bigint unsigned", extra: "auto_increment" },
        ...LISTINGS_TABLE.columns.slice(1),
      ],
    });
    const created = texts(planOf(await install(unsigned)))[4] ?? "";
    expect(created).toContain("`id` bigint unsigned not null primary key");
    expect(created).not.toContain("auto_increment");
  });

  it("carries inline mode's columns, marked, and the mark on the table", async () => {
    const create = texts(planOf(await install(freshListings())))[4] ?? "";
    for (const line of [
      "`is_scam` boolean comment 'facetdb'",
      "`is_scam_probability` float comment 'facetdb'",
      "`facetdb_status` varchar(16) not null default 'pending' comment 'facetdb'",
      "`facetdb_updated_at` datetime(3) comment 'facetdb'",
      "`facetdb_reviewed` boolean not null default false comment 'facetdb'",
    ]) {
      expect(create).toContain(line);
    }
    expect(
      create.endsWith(`) engine = InnoDB default charset = utf8mb4 comment = '${OWNED_MARK}'`),
    ).toBe(true);
  });

  it("references the table on delete and update cascade; a partitioned table, which a foreign key cannot reference, gets a note instead", async () => {
    const innodb = texts(planOf(await install(freshListings())))[4] ?? "";
    expect(innodb).toContain(
      "constraint `facetdb_listings_fk` foreign key (`id`) references `app`.`listings` (`id`)\n    on delete cascade on update cascade",
    );
    const plan = planOf(
      await install(
        withTable(freshListings(), { ...LISTINGS_TABLE, createOptions: "partitioned" }),
      ),
    );
    expect(texts(plan)[4]).not.toContain("foreign key");
    expect(plan.notes.some((note) => note.includes("refuse truncate table"))).toBe(false);
    expect(plan.notes).toContain(
      "app.listings is a partitioned table, which an InnoDB foreign key cannot reference: when the application deletes a record, its row in app.facetdb_listings_answers stays (the view and facetdb explain no longer show it), and a record inserted again under the same key starts fresh.",
    );
  });

  it("refuses a table of another engine than InnoDB, whose table locks the worker's row lock could wait on until a timeout, and changes nothing", async () => {
    for (const engine of ["MyISAM", "Aria"]) {
      const driver = recordingDriver(
        scriptedDatabase(withTable(freshListings(), { ...LISTINGS_TABLE, engine })),
      );
      const result = await createMysqlInstaller({ connect: driver.connect }).planInstall(
        sideListingsTarget(),
        ADMIN_URL,
        INSTALL,
      );
      expect(refusalOf(result)).toEqual({
        code: "table-engine",
        message: `app.listings is a ${engine} table; side-table mode keeps the answers in an InnoDB table beside it and serializes the worker's write with the application's on InnoDB's row locks, which a ${engine} table does not take, so the two could wait on each other until a lock timeout`,
        fix: 'convert the table to InnoDB (alter table app.listings engine = InnoDB), or set storage "inline" for this source, then run facetdb migrate again',
      });
      expect(driver.sent.every((sent) => sent.text.trimStart().startsWith("select"))).toBe(true);
    }
    // Inline mode keeps its own rule: it still installs on a MyISAM table.
    const inline = await install(
      withTable(freshListings(), { ...LISTINGS_TABLE, engine: "MyISAM" }),
      sideListingsTarget({ storage: "inline" }),
    );
    expect(inline.ok).toBe(true);
  });
});

describe("the view", () => {
  it("runs with its reader's rights and joins the side table on the key, a record without a side row reading as pending", async () => {
    const view = texts(planOf(await install(freshListings())))[5];
    expect(view).toBe(`create or replace sql security invoker view ${VIEW} as
select t.*,
  a.\`is_scam\`,
  a.\`is_scam_probability\`,
  coalesce(a.\`facetdb_status\`, 'pending') as \`facetdb_status\`,
  a.\`facetdb_updated_at\`,
  coalesce(a.\`facetdb_reviewed\`, 0) as \`facetdb_reviewed\`
  from ${TABLE} t
  left join ${SIDE} a on a.\`id\` = t.\`id\``);
    expect(view).not.toContain("definer");
  });

  it("is FacetDB's only when its stored text is the one the plan makes, whatever the engine's parentheses and spacing", () => {
    const stored = storedViewDefinition(
      "app",
      "listings",
      "id",
      ["id", "title"],
      ["is_scam", "facetdb_status", "facetdb_reviewed"],
    );
    // MySQL 8's text, as the server printed it (side-table.db.test.ts reads it back on both).
    expect(stored).toBe(
      "select `t`.`id` AS `id`,`t`.`title` AS `title`,`a`.`is_scam` AS `is_scam`,coalesce(`a`.`facetdb_status`,'pending') AS `facetdb_status`,coalesce(`a`.`facetdb_reviewed`,0) AS `facetdb_reviewed` from (`app`.`listings` `t` left join `app`.`facetdb_listings_answers` `a` on((`a`.`id` = `t`.`id`)))",
    );
    // MariaDB's: one pair of parentheses around the join's condition.
    const mariadb = stored.replace("on((`a`.`id` = `t`.`id`)))", "on(`a`.`id` = `t`.`id`))");
    expect(normalizedDefinition(mariadb)).toBe(normalizedDefinition(stored));
    // A name or a literal that differs is another view, even one that reads the side table.
    expect(normalizedDefinition(stored.replace("'pending'", "'done'"))).not.toBe(
      normalizedDefinition(stored),
    );
    expect(normalizedDefinition("select `a b` from `t`")).not.toBe(
      normalizedDefinition("select `ab` from `t`"),
    );
  });
});

describe("the triggers", () => {
  it("run after the insert and after an update of a state column, upsert the side row and queue the record", async () => {
    const plan = planOf(await install(freshListings()));
    const triggers = texts(plan).filter((text) => text.startsWith("create definer"));
    expect(triggers).toHaveLength(2);
    expect(triggers[0]).toContain(
      "insert into `app`.`facetdb_listings_answers` (`id`) values (new.`id`)\n    on duplicate key update `is_scam` = null, `is_scam_probability` = null, `facetdb_status` = 'pending', `facetdb_updated_at` = null, `facetdb_reviewed` = false;",
    );
    expect(triggers[0]).toContain("insert into `app`.`facetdb_jobs`");
    expect(triggers[1]).toContain(
      "if not (cast(old.`title` as binary) <=> cast(new.`title` as binary))",
    );
    expect(triggers[1]).toContain("on duplicate key update `facetdb_status` = 'pending';");
    // No trigger sets a column of the table: there is none of FacetDB's on it.
    expect(triggers.some((text) => text.includes("set new."))).toBe(false);
  });

  it("with onChange keep, upserts the side row without changing its status, which still locks it", async () => {
    const plan = planOf(await install(freshListings(), sideListingsTarget({ onChange: "keep" })));
    const update = texts(plan).find((text) => text.includes("after update")) ?? "";
    expect(update).toContain("on duplicate key update `facetdb_status` = `facetdb_status`;");
  });

  it("drops the before-insert trigger an inline install left, and re-creates the update trigger after the update", async () => {
    const inline = installedListings();
    const database: ScriptedDatabase = {
      ...inline,
      tables: [LISTINGS_TABLE, ...inline.tables.filter((table) => table.name !== "listings")],
    };
    const plan = planOf(await install(database));
    expect(texts(plan)).toContain("drop trigger if exists `app`.`facetdb_listings_new`");
    expect(texts(plan).filter((text) => text.startsWith("create definer"))).toHaveLength(2);
  });
});

describe("the grants (least privilege)", () => {
  it("the worker selects the key and the state of the table, writes none of it, writes the side table's rows and selects the view", async () => {
    const plan = planOf(await install(freshListings()));
    const grants = plan.statements
      .filter((statement) => statement.purpose === "grants")
      .map((statement) => statement.text);
    expect(grants).toEqual([
      `grant select (\`id\`, \`title\`, \`description\`)\n  on ${TABLE} to ${WORKER_ACCOUNT}`,
      `grant select, insert, update, delete on ${SIDE} to ${WORKER_ACCOUNT}`,
      `grant select on ${VIEW} to ${WORKER_ACCOUNT}`,
      `grant select, insert, update, delete on \`app\`.\`facetdb_jobs\` to ${WORKER_ACCOUNT}`,
      `grant select on \`app\`.\`facetdb_table_owners\` to ${WORKER_ACCOUNT}`,
    ]);
    expect(
      texts(plan).some((text) =>
        /grant (?:all|update|insert|delete)[^\n]*`app`\.`listings`/.test(text),
      ),
    ).toBe(false);
  });

  it("gives every account that reads the table select on the view and the side table, a MariaDB role by its name as the catalog says", async () => {
    const grants = [
      { user: "app_reader", host: "%", table: "listings", privileges: ["Select"] },
      { user: "app_role", host: "", table: "listings", privileges: ["Select", "Update"] },
      { user: "app_blank", host: "", table: "listings", privileges: ["Select"] },
      { user: "app_writer", host: "10.0.0.%", table: "listings", privileges: ["Insert"] },
    ];
    const mariadb = planOf(
      await install({
        ...freshListings(),
        version: "10.6.20-MariaDB-ubu2204",
        sqlMode: MARIADB_SQL_MODE,
        roles: ["app_role"],
        grants,
      }),
    );
    // app_role is a role; app_blank is an account whose host is empty, named with it.
    expect(texts(mariadb)).toContain(
      `grant select on ${SIDE} to 'app_blank'@'', 'app_reader'@'%', 'app_role'`,
    );
    expect(texts(mariadb)).toContain(
      `grant select on ${VIEW} to 'app_blank'@'', 'app_reader'@'%', 'app_role'`,
    );
    expect(texts(mariadb).join("\n")).not.toContain("app_writer");
    // MySQL 8 has no is_role column, and its roles are accounts with a host: every name has one.
    const mysql = planOf(await install({ ...freshListings(), roles: ["app_role"], grants }));
    expect(texts(mysql)).toContain(
      `grant select on ${SIDE} to 'app_blank'@'', 'app_reader'@'%', 'app_role'@''`,
    );
  });
});

describe("planInstall in side-table mode: only what is missing", () => {
  it("plans nothing on a table the install left as it is", async () => {
    expect(
      planOf(await install(installedSideListings(sideListingsTarget(), ["app_reader"]))),
    ).toEqual({
      statements: [],
      transactional: false,
      removes: [],
      keeps: [],
      notes: [],
    });
  });

  it("gives a reader granted after the install its two grants, and nothing else", async () => {
    const installed = installedSideListings();
    const plan = planOf(
      await install({
        ...installed,
        grants: [
          ...(installed.grants ?? []),
          { user: "late_reader", host: "%", table: "listings", privileges: ["Select"] },
        ],
      }),
    );
    expect(texts(plan).slice(2)).toEqual([
      `grant select on ${SIDE} to 'late_reader'@'%'`,
      `grant select on ${VIEW} to 'late_reader'@'%'`,
    ]);
    expect(plan.notes).toHaveLength(2);
  });

  it("makes the view again, and only it, when the application added a column to the table", async () => {
    const installed = installedSideListings();
    const plan = planOf(
      await install(
        withTable(installed, {
          ...LISTINGS_TABLE,
          columns: [...LISTINGS_TABLE.columns, { name: "price", type: "int" }],
        }),
      ),
    );
    expect(
      texts(plan)
        .slice(2)
        .map((text) => text.split("\n")[0]),
    ).toEqual([`create or replace sql security invoker view ${VIEW} as`]);
  });

  it("makes the view again when it runs with its definer's rights", async () => {
    const installed = installedSideListings();
    const view = installed.tables.find((table) => table.name === "listings_with_answers");
    const plan = planOf(
      await install(
        withTable(installed, {
          ...(view as ScriptedTable),
          view: { security: "DEFINER", definition: view?.view?.definition ?? "" },
        }),
      ),
    );
    expect(texts(plan)).toHaveLength(3);
    expect(texts(plan)[2]).toContain("sql security invoker");
  });

  it("adds a new question's columns to the side table, then makes the view and the insert trigger again", async () => {
    const plan = planOf(
      await install(installedSideListings(), sideListingsTarget({ questionSet: TWO_QUESTIONS })),
    );
    expect(
      texts(plan)
        .slice(2)
        .map((text) => text.split("\n")[0]),
    ).toEqual([
      "alter table `app`.`facetdb_listings_answers`",
      `create or replace sql security invoker view ${VIEW} as`,
      "drop trigger if exists `app`.`facetdb_listings_ins`",
      "create definer = current_user trigger `app`.`facetdb_listings_ins` after insert on `app`.`listings` for each row",
    ]);
    expect(texts(plan)[2]).toBe(
      "alter table `app`.`facetdb_listings_answers`\n  add column `category` varchar(255) comment 'facetdb',\n  add column `category_confidence` float comment 'facetdb'",
    );
  });
});

describe("planInstall in side-table mode refuses, says why and what to do, and changes nothing", () => {
  it(`refuses a table name longer than ${SIDE_TABLE_NAME_LIMIT} characters, which the side table's name would not fit`, async () => {
    const name = "l".repeat(SIDE_TABLE_NAME_LIMIT + 1);
    const database = withTable({ ...freshListings(), tables: [] }, { ...LISTINGS_TABLE, name });
    expect(refusalOf(await install(database, sideListingsTarget({ table: name })))).toEqual({
      code: "name-too-long",
      message: `the table name ${name} has 49 characters; side-table mode keeps the answers in facetdb_<table>_answers, and MySQL allows 64 characters in a name, so a table name can have 48 at most`,
      fix: 'rename the table to 48 characters or fewer, or set storage "inline" for this source, then run facetdb migrate again',
    });
    const fits = "l".repeat(SIDE_TABLE_NAME_LIMIT);
    const fitting = withTable(
      { ...freshListings(), tables: [] },
      { ...LISTINGS_TABLE, name: fits },
    );
    expect((await install(fitting, sideListingsTarget({ table: fits }))).ok).toBe(true);
  });

  it("refuses a table an inline install left its columns on", async () => {
    expect(refusalOf(await install(installedListings()))).toEqual(
      refused(
        'app.listings carries FacetDB\'s columns is_scam, is_scam_probability, facetdb_status, facetdb_updated_at, facetdb_reviewed from an install in inline mode; side-table mode leaves the table alone. Set storage "inline" back and run facetdb uninstall, then set "side-table" and run facetdb migrate; or keep storage "inline".',
      ),
    );
  });

  it("refuses a table with a column of a name the view gives one of FacetDB's", async () => {
    const database = withTable(freshListings(), {
      ...LISTINGS_TABLE,
      columns: [...LISTINGS_TABLE.columns, { name: "is_scam", type: "tinyint(1)" }],
    });
    expect(refusalOf(await install(database))).toEqual(
      refused(
        "app.listings has a column named is_scam, a name the view app.listings_with_answers gives one of FacetDB's columns; rename the question or the column.",
      ),
    );
  });

  it("refuses a table of the side table's name that is not FacetDB's, or keyed by another column", async () => {
    const installed = installedSideListings();
    const side = installed.tables.find((table) => table.name === "facetdb_listings_answers");
    const unmarked = withTable(installed, { ...(side as ScriptedTable), comment: "" });
    expect(refusalOf(await install(unmarked))).toEqual(
      nameTaken(
        "app.facetdb_listings_answers exists and is not FacetDB's side table (it is not a table with the comment 'facetdb'); side-table mode keeps the answers of app.listings under that name",
      ),
    );
    const rekeyed = withTable(installed, { ...(side as ScriptedTable), primaryKey: ["uuid"] });
    expect(refusalOf(await install(rekeyed))).toEqual(
      refused(
        "app.facetdb_listings_answers is keyed by (uuid), not by id, the primary key of app.listings; it holds FacetDB's answers only, so drop it and run facetdb migrate again.",
      ),
    );
  });

  it("refuses a column of the side table whose question changed type, as inline mode refuses it", async () => {
    const installed = installedSideListings();
    const side = installed.tables.find((table) => table.name === "facetdb_listings_answers");
    const drifted = withTable(installed, {
      ...(side as ScriptedTable),
      columns: (side?.columns ?? []).map((column) =>
        column.name === "is_scam" ? { ...column, type: "varchar(255)" } : column,
      ),
    });
    expect(refusalOf(await install(drifted)).message).toBe(
      "app.facetdb_listings_answers: is_scam is varchar(255) and the question now needs boolean; a question's type cannot change in place. Remove the question (migrate --prune drops its columns), then add it back.",
    );
  });

  it("refuses a relation of the view's name that is not the view FacetDB makes, even one that reads the side table", async () => {
    const words = nameTaken(
      "app.listings_with_answers exists and is not the view FacetDB makes (its text is not the join of app.listings and app.facetdb_listings_answers FacetDB writes); side-table mode gives that name to its view",
    );
    const table = withTable(freshListings(), {
      name: "listings_with_answers",
      columns: [{ name: "id", type: "int" }],
    });
    expect(refusalOf(await install(table))).toEqual(words);
    const another = withTable(freshListings(), {
      name: "listings_with_answers",
      type: "VIEW",
      columns: [{ name: "id", type: "int" }],
      view: {
        security: "INVOKER",
        definition: "select `app`.`listings`.`id` AS `id` from `app`.`listings`",
      },
    });
    expect(refusalOf(await install(another))).toEqual(words);
    // The customer's own view over the side table, under FacetDB's name: refused, not replaced.
    const installed = installedSideListings();
    const view = installed.tables.find((one) => one.name === "listings_with_answers");
    const customers = withTable(installed, {
      ...(view as ScriptedTable),
      view: {
        security: "INVOKER",
        definition: (view?.view?.definition ?? "").replace("'pending'", "'new'"),
      },
    });
    expect(refusalOf(await install(customers))).toEqual(words);
  });

  it("recognises its own view in MariaDB's text, and one made before the application added a column", async () => {
    const installed = installedSideListings();
    const view = installed.tables.find((one) => one.name === "listings_with_answers");
    const mariadb = withTable(installed, {
      ...(view as ScriptedTable),
      view: {
        security: "INVOKER",
        definition: (view?.view?.definition ?? "").replace(
          "on((`a`.`id` = `t`.`id`)))",
          "on(`a`.`id` = `t`.`id`))",
        ),
      },
    });
    expect(planOf(await install(mariadb)).statements).toEqual([]);
    const grown = withTable(mariadb, {
      ...LISTINGS_TABLE,
      columns: [...LISTINGS_TABLE.columns, { name: "price", type: "int" }],
    });
    expect(texts(planOf(await install(grown)))[2]).toContain("create or replace");
  });
});

describe("planUninstall in side-table mode", () => {
  it("drops the triggers, takes back every right on the view and the side table, drops both, and touches nothing of the table's own", async () => {
    const result = await installer(
      installedSideListings(sideListingsTarget(), ["app_reader"]),
    ).planUninstall(sideListingsTarget(), ADMIN_URL, {
      ...ENGINE_DEPS,
      purge: false,
      alsoUninstalling: [],
    });
    const plan = planOf(result);
    expect(texts(plan).slice(0, 13)).toEqual([
      SETTINGS.text,
      "drop trigger if exists `app`.`facetdb_listings_ins`",
      "drop trigger if exists `app`.`facetdb_listings_upd`",
      `revoke select (\`id\`, \`title\`, \`description\`)\n  on ${TABLE} from ${WORKER_ACCOUNT}`,
      `revoke select\n  on ${VIEW} from 'app_reader'@'%'`,
      `revoke select\n  on ${VIEW} from ${WORKER_ACCOUNT}`,
      `revoke select\n  on ${SIDE} from 'app_reader'@'%'`,
      `revoke select, insert, update, delete\n  on ${SIDE} from ${WORKER_ACCOUNT}`,
      `drop view if exists ${VIEW}`,
      `drop table if exists ${SIDE}`,
      "delete from `app`.`facetdb_jobs` where `table_name` = 'listings'",
      "delete from `app`.`facetdb_table_owners` where `table_name` = 'listings'",
      expect.stringContaining("set @facetdb_cleanup"),
    ]);
    // The reader's own select on the table is the application's: it stays.
    expect(texts(plan).join("\n")).not.toContain(`on ${TABLE} from 'app_reader'`);
    expect(plan.removes).toEqual(
      expect.arrayContaining([
        { kind: "view", name: "app.listings_with_answers", of: "app.listings", scope: "source" },
        {
          kind: "side-table",
          name: "app.facetdb_listings_answers",
          of: "app.listings",
          scope: "source",
        },
        {
          kind: "grant",
          name: "'app_reader'@'%'",
          of: "app.listings_with_answers",
          scope: "source",
        },
      ]),
    );
    expect(plan.confirm).toEqual({ kind: "project", name: "Listings" });
  });

  it("takes back a right held with grant option by a revoke grant option of its own, and names a MariaDB role without a host", async () => {
    const installed = installedSideListings();
    const plan = planOf(
      await installer({
        ...installed,
        version: "10.6.20-MariaDB-ubu2204",
        sqlMode: MARIADB_SQL_MODE,
        roles: ["app_role"],
        grants: [
          ...(installed.grants ?? []),
          {
            user: "app_admin",
            host: "%",
            table: "listings_with_answers",
            privileges: ["Select", "Grant"],
          },
          { user: "app_grantor", host: "%", table: "listings_with_answers", privileges: ["Grant"] },
          { user: "app_role", host: "", table: "facetdb_listings_answers", privileges: ["Select"] },
        ],
      }).planUninstall(sideListingsTarget(), ADMIN_URL, {
        ...ENGINE_DEPS,
        purge: false,
        alsoUninstalling: [],
      }),
    );
    const revokes = texts(plan).filter(
      (text) => text.startsWith("revoke") && !text.includes(TABLE),
    );
    expect(revokes).toEqual([
      `revoke select\n  on ${VIEW} from 'app_admin'@'%'`,
      `revoke grant option\n  on ${VIEW} from 'app_admin'@'%'`,
      `revoke grant option\n  on ${VIEW} from 'app_grantor'@'%'`,
      `revoke select\n  on ${VIEW} from ${WORKER_ACCOUNT}`,
      `revoke select\n  on ${SIDE} from 'app_role'`,
      `revoke select, insert, update, delete\n  on ${SIDE} from ${WORKER_ACCOUNT}`,
    ]);
    expect(texts(plan).join("\n")).not.toMatch(/revoke [^\n]*\bgrant on/);
  });

  it("leaves a view of the name that does not read the side table, and an unmarked table of the side table's name", async () => {
    const installed = installedSideListings();
    const database: ScriptedDatabase = {
      ...installed,
      tables: installed.tables.map((table) =>
        table.name === "listings_with_answers"
          ? { ...table, view: { security: "INVOKER", definition: "select 1 AS `one`" } }
          : table.name === "facetdb_listings_answers"
            ? { ...table, comment: "" }
            : table,
      ),
    };
    const plan = planOf(
      await installer(database).planUninstall(sideListingsTarget(), ADMIN_URL, {
        ...ENGINE_DEPS,
        purge: false,
        alsoUninstalling: [],
      }),
    );
    expect(texts(plan).some((text) => text.startsWith("drop view"))).toBe(false);
    expect(
      texts(plan).some((text) => text.startsWith("drop table if exists `app`.`facetdb_listings")),
    ).toBe(false);
  });
});

describe("planPrune in side-table mode", () => {
  it("makes the view again without a removed question's columns, then drops them from the side table, and nothing of the table", async () => {
    const database = installedSideListings(sideListingsTarget({ questionSet: TWO_QUESTIONS }));
    const plan = planOf(
      await installer(database).planPrune(sideListingsTarget(), ADMIN_URL, ENGINE_DEPS),
    );
    expect(texts(plan)).toEqual([
      SETTINGS.text,
      `create or replace sql security invoker view ${VIEW} as
select t.*,
  a.\`is_scam\`,
  a.\`is_scam_probability\`,
  coalesce(a.\`facetdb_status\`, 'pending') as \`facetdb_status\`,
  a.\`facetdb_updated_at\`,
  coalesce(a.\`facetdb_reviewed\`, 0) as \`facetdb_reviewed\`
  from ${TABLE} t
  left join ${SIDE} a on a.\`id\` = t.\`id\``,
      `alter table ${SIDE}\n  drop column \`category\`,\n  drop column \`category_confidence\``,
    ]);
    expect(plan.removes).toEqual([
      {
        kind: "column",
        name: "category",
        of: "app.facetdb_listings_answers",
        scope: "source",
        reason: "no question asks it any more",
      },
      {
        kind: "column",
        name: "category_confidence",
        of: "app.facetdb_listings_answers",
        scope: "source",
        reason: "no question asks it any more",
      },
    ]);
  });

  it("plans nothing when every column of the side table is still asked", async () => {
    const plan = planOf(
      await installer(installedSideListings()).planPrune(
        sideListingsTarget(),
        ADMIN_URL,
        ENGINE_DEPS,
      ),
    );
    expect(plan.statements).toEqual([]);
  });
});
