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
  LISTINGS_JOBS,
  LISTINGS_QUESTIONS,
  LISTINGS_TABLE,
  LISTINGS_TRIGGERS,
  listingsTarget,
  MARIADB_SQL_MODE,
  type RecordingDriver,
  recordingDriver,
  type ScriptedDatabase,
  scriptedDatabase,
} from "../testing/index.ts";
import {
  createMysqlInstaller,
  INSTALL_RERUN_NOTE,
  JOBS_TABLE,
  OWNERS_TABLE,
  QUEUE_NOTE,
  REFUSED_FIX,
  SCRIPT_HEADER,
  WORKER_ACCOUNT,
} from "./index.ts";

/**
 * The MySQL and MariaDB install plan on the recording driver: the listings example renders byte for
 * byte as install.listings.sql, the plan of an installed table is empty, a stopped or changed
 * install plans only what is missing, the worker's rights are the least that works, and every
 * refusal says what to do. The db suite runs the same plan on both servers.
 */

const FIXTURE = new URL("./install.listings.sql", import.meta.url);
const PASSWORD = "a-long-random-password";
const INSTALL: InstallOptions = { ...ENGINE_DEPS, workerPassword: PASSWORD };

type Planned = { readonly result: PlanResult; readonly driver: RecordingDriver };

async function planned(
  database: ScriptedDatabase,
  target: EngineTarget = listingsTarget(),
  options: InstallOptions = INSTALL,
  url = ADMIN_URL,
): Promise<Planned> {
  const driver = recordingDriver(scriptedDatabase(database));
  const result = await createMysqlInstaller({ connect: driver.connect }).planInstall(
    target,
    url,
    options,
  );
  return { result, driver };
}

function planOf({ result }: Planned): EnginePlan {
  if (!result.ok) {
    throw new Error(`refused: ${result.refusal.code}: ${result.refusal.message}`);
  }
  return result.plan;
}

function refusalOf({ result }: Planned): Refusal {
  if (result.ok) {
    throw new Error(`planned: ${JSON.stringify(result.plan.statements)}`);
  }
  return result.refusal;
}

const texts = (plan: EnginePlan) => plan.statements.map((statement) => statement.text);
const render = createMysqlInstaller({ connect: recordingDriver().connect }).render;

/** Reads only: a plan, refused or not, changes nothing, and lets go of its connection. */
function readOnly(driver: RecordingDriver): void {
  expect(driver.sent.every((sent) => sent.text.trimStart().startsWith("select"))).toBe(true);
  expect(driver.closed).toBe(driver.opened);
}

/** The listings table with one more column, or another in place of one. */
function withColumns(
  database: ScriptedDatabase,
  table: string,
  columns: ScriptedDatabase["tables"][number]["columns"],
): ScriptedDatabase {
  return {
    ...database,
    tables: database.tables.map((one) => (one.name === table ? { ...one, columns } : one)),
  };
}

/** A refusal in the Postgres engine's code and fix, for a concept both engines refuse. */
const refused = (message: string): Refusal => ({
  code: "migrate-refused",
  message,
  fix: REFUSED_FIX,
});

const DEFINER_NOTE =
  "The triggers run with the rights of the account that creates them (their definer): if that account is dropped, inserts and updates on app.listings fail until facetdb migrate runs again under another account.";

const COLUMNS_NOTE =
  "MySQL does not tie a trigger to the columns it names: renaming or dropping the key or a state column of app.listings makes the application's writes on it fail with error 1054 until facetdb migrate runs again.";

describe("planInstall: the listings example", () => {
  it("renders byte for byte as install.listings.sql", async () => {
    const plan = planOf(await planned(freshListings()));
    expect(render(plan)).toBe(await readFile(FIXTURE, "utf8"));
  });

  it("says before its first statement that MySQL runs it statement by statement and that a rerun completes it", async () => {
    const plan = planOf(await planned(freshListings()));
    const script = render(plan);
    expect(script.startsWith(`${SCRIPT_HEADER}\n\n`)).toBe(true);
    expect(SCRIPT_HEADER).toContain("statement by statement");
    expect(SCRIPT_HEADER).toContain("running the same facetdb command again completes it");
    expect(SCRIPT_HEADER).toContain("give it to mysql --batch, which stops at the first error");
    expect(script.indexOf(SCRIPT_HEADER)).toBeLessThan(script.indexOf("set session"));
    expect(plan).toMatchObject({ transactional: false, removes: [], keeps: [] });
    expect(plan.notes).toEqual([INSTALL_RERUN_NOTE, QUEUE_NOTE, DEFINER_NOTE, COLUMNS_NOTE]);
    expect(QUEUE_NOTE).toContain("varbinary(1020)");
    expect(plan.confirm).toBeUndefined();
  });

  it("tags every statement as the source's, with its purpose, in the order the script runs", async () => {
    const plan = planOf(await planned(freshListings()));
    expect(plan.statements.every((statement) => statement.database === "source")).toBe(true);
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      "marker",
      "marker",
      "marker",
      "columns",
      "queue",
      "login",
      "grants",
      "grants",
      "grants",
      "grants",
      "capture",
      "capture",
      "capture",
      "capture",
      "capture",
      "capture",
    ]);
  });

  it("creates the login and its grants before any trigger, so a stop never leaves capture with no worker", async () => {
    const plan = planOf(await planned(freshListings()));
    const purposes = plan.statements.map((statement) => statement.purpose);
    expect(purposes.lastIndexOf("grants")).toBeLessThan(purposes.indexOf("capture"));
    expect(purposes.indexOf("login")).toBeLessThan(purposes.indexOf("capture"));
  });

  it("shows where the worker password goes and never the password, and how a hand-run must treat it", async () => {
    const plan = planOf(await planned(freshListings()));
    const secret = plan.statements.filter((statement) => statement.secret === true);
    expect(secret).toHaveLength(1);
    expect(secret[0]).toMatchObject({ database: "source", purpose: "login" });
    const text = secret[0]?.text ?? "";
    expect(text).toMatch(
      /\ncreate user if not exists 'facetdb_worker'@'%' identified by \? password expire never$/,
    );
    // The placeholder is the statement's only `?`: the driver binds exactly one value.
    expect(text.split("?")).toHaveLength(2);
    expect(text).toContain("write the password into this one\n-- statement as a quoted literal");
    expect(text).toContain("never go on past an error: mysql --batch stops at the first");
    for (const words of [JSON.stringify(plan), render(plan)]) {
      expect(words).not.toContain(PASSWORD);
    }
  });

  it("stops another project's table with a select, which MySQL and MariaDB both raise from", async () => {
    const guard = texts(planOf(await planned(freshListings()))).find((text) =>
      text.startsWith("-- stops the script here"),
    );
    expect(guard).toContain(
      "\nselect (select 1 from `app`.`facetdb_table_owners` where `table_name` = 'listings' and `project_id` <> 'proj_listings'\n        union all select 1) as `facetdb_owner_guard`",
    );
  });

  it("reads the catalog through one connection it closes, and changes nothing", async () => {
    const { driver } = await planned(freshListings());
    expect(driver.opened).toBe(1);
    readOnly(driver);
    expect(driver.sent.every((sent) => sent.url === ADMIN_URL)).toBe(true);
  });
});

describe("planInstall: only what is missing", () => {
  it("plans nothing on a table the install left as it is: a second plan has no statements", async () => {
    const again = await planned(installedListings(), listingsTarget(), {
      ...ENGINE_DEPS,
      workerPassword: "another-long-random-password",
    });
    expect(planOf(again)).toEqual({
      statements: [],
      transactional: false,
      removes: [],
      keeps: [],
      notes: [],
    });
    expect(render(planOf(again))).toBe("");
    readOnly(again.driver);
  });

  it("finishes an install stopped after the columns: no claim again, no column added twice", async () => {
    const installed = installedListings();
    // Stopped before the queue: the marker, its row and the columns are there, and no login yet.
    const stopped: ScriptedDatabase = {
      schema: installed.schema,
      database: installed.database,
      tables: installed.tables.filter((table) => table.name !== JOBS_TABLE),
      owners: installed.owners ?? [],
    };
    const plan = planOf(await planned(stopped));
    expect(plan.statements.map((statement) => statement.purpose)).toEqual([
      "settings",
      "marker",
      "queue",
      "login",
      "grants",
      "grants",
      "grants",
      "grants",
      "capture",
      "capture",
      "capture",
      "capture",
      "capture",
      "capture",
    ]);
    expect(texts(plan)[1]).toMatch(/^-- stops the script here/);
    expect(texts(plan).join("\n")).not.toMatch(
      /alter table|insert into `app`.`facetdb_table_owners`/,
    );
  });

  it("adds a new question's columns and their grants, and nothing else", async () => {
    const target = listingsTarget({
      questionSet: {
        ...LISTINGS_QUESTIONS,
        questions: [
          ...LISTINGS_QUESTIONS.questions,
          {
            type: "choice",
            name: "category",
            instructions: "Which category is this listing?",
            options: [
              { name: "home", description: "A home or a room" },
              { name: "car", description: "A car or a motorbike" },
            ],
            stakes: "low",
            storeProbabilities: true,
          },
        ],
      },
    });
    const plan = planOf(await planned(installedListings(), target));
    expect(texts(plan)).toEqual([
      "set session lock_wait_timeout = 10",
      expect.stringMatching(/^-- stops the script here/),
      "alter table `app`.`listings`\n  add column `category` varchar(255) comment 'facetdb',\n  add column `category_confidence` float comment 'facetdb',\n  add column `category_probabilities` json comment 'facetdb'",
      "grant select (`category`, `category_confidence`, `category_probabilities`)\n  on `app`.`listings` to 'facetdb_worker'@'%'",
      "grant update (`category`, `category_confidence`, `category_probabilities`)\n  on `app`.`listings` to 'facetdb_worker'@'%'",
    ]);
    // The triggers compare the state, which did not change: they stay as they are.
    expect(plan.notes).toEqual([INSTALL_RERUN_NOTE]);
  });

  it("recreates the update trigger when read changes, and only it, after the new grant", async () => {
    const target = listingsTarget({
      questionSet: { ...LISTINGS_QUESTIONS, read: ["title", "description", "price"] },
    });
    const database = withColumns(installedListings(), "listings", [
      ...(installedListings().tables[0]?.columns ?? []),
      { name: "price", type: "decimal(10,2)" },
    ]);
    const plan = planOf(await planned(database, target));
    expect(texts(plan)).toEqual([
      "set session lock_wait_timeout = 10",
      expect.stringMatching(/^-- stops the script here/),
      "grant select (`price`)\n  on `app`.`listings` to 'facetdb_worker'@'%'",
      "drop trigger if exists `app`.`facetdb_listings_upd`",
      expect.stringContaining(
        "or not (cast(old.`price` as binary) <=> cast(new.`price` as binary)) then",
      ),
    ]);
    expect(plan.notes).toEqual([INSTALL_RERUN_NOTE, DEFINER_NOTE, COLUMNS_NOTE]);
  });

  it("takes a body pasted with other line ends or indentation as the same trigger", async () => {
    const installed = installedListings();
    const pasted: ScriptedDatabase = {
      ...installed,
      triggers: (installed.triggers ?? []).map((trigger) => ({
        ...trigger,
        body: trigger.body.replaceAll("\n", "\r\n    "),
      })),
    };
    expect(planOf(await planned(pasted)).statements).toEqual([]);
  });

  it("creates no login that exists, and needs no password for one", async () => {
    const plan = planOf(
      await planned({ ...freshListings(), worker: { global: ["USAGE"] } }, listingsTarget(), {
        ...ENGINE_DEPS,
      }),
    );
    expect(plan.statements.some((statement) => statement.secret === true)).toBe(false);
    expect(texts(plan).join("\n")).not.toContain("create user");
    expect(texts(plan).filter((text) => text.startsWith("grant"))).toHaveLength(4);
  });

  it("names the schema the config names, and the connection's database otherwise", async () => {
    const shop: ScriptedDatabase = { ...freshListings(), schema: "shop", database: null };
    const plan = planOf(await planned(shop, listingsTarget({ schema: "shop" })));
    expect(texts(plan).join("\n")).toContain("alter table `shop`.`listings`");
    expect(texts(plan).join("\n")).not.toContain("`app`");
  });
});

describe("planInstall: columns, queue and capture", () => {
  it("maps every question type onto MySQL's types", async () => {
    const questions: QuestionSet = {
      ...LISTINGS_QUESTIONS,
      questions: [
        { type: "noul", name: "is_scam", instructions: "Is this listing a scam?", stakes: "high" },
        {
          type: "choice",
          name: "category",
          instructions: "Which category?",
          options: [
            { name: "home", description: "A home" },
            { name: "car", description: "A car" },
          ],
          stakes: "low",
          storeProbabilities: false,
        },
        {
          type: "score",
          name: "urgency",
          instructions: "How urgent?",
          levels: [{ name: "low" }, { name: "high" }],
          stakes: "low",
        },
      ],
    };
    const plan = planOf(await planned(freshListings(), listingsTarget({ questionSet: questions })));
    expect(texts(plan).find((text) => text.startsWith("alter table"))).toBe(
      [
        "alter table `app`.`listings`",
        "  add column `is_scam` boolean comment 'facetdb',",
        "  add column `is_scam_probability` float comment 'facetdb',",
        "  add column `category` varchar(255) comment 'facetdb',",
        "  add column `category_confidence` float comment 'facetdb',",
        "  add column `urgency` varchar(255) comment 'facetdb',",
        "  add column `urgency_confidence` float comment 'facetdb',",
        "  add column `urgency_expected` float comment 'facetdb',",
        "  add column `facetdb_status` varchar(16) not null default 'pending' comment 'facetdb',",
        "  add column `facetdb_updated_at` datetime(3) comment 'facetdb',",
        "  add column `facetdb_reviewed` boolean not null default false comment 'facetdb'",
      ].join("\n"),
    );
  });

  it("keys the queue the database's tables share by the table's name and the key's text bytes", async () => {
    const plan = planOf(await planned(freshListings()));
    const jobs = texts(plan).find((text) =>
      text.startsWith("create table if not exists `app`.`facetdb_jobs`"),
    );
    // Bytes, not a PAD SPACE varchar: two keys that differ only in trailing spaces stay two jobs.
    expect(jobs).toContain(
      "`table_name` varchar(64) not null,\n  `record_key` varbinary(1020) not null,",
    );
    expect(jobs).toContain("primary key (`table_name`, `record_key`),");
    expect(jobs).toMatch(/collate = utf8mb4_bin row_format = dynamic$/);
    // The enqueuing triggers write the table's name as a literal and the key cast to text.
    const enqueuing = texts(plan).filter(
      (text) => text.startsWith("create definer") && text.includes("insert into"),
    );
    expect(enqueuing).toHaveLength(2);
    for (const text of enqueuing) {
      expect(text).toContain(
        "insert into `app`.`facetdb_jobs` (`table_name`, `record_key`) values ('listings', cast(new.`id` as char character set utf8mb4))",
      );
    }
  });

  it("takes a text key that fits the queue: a uuid as char(36), a varchar(255)", async () => {
    for (const type of ["char(36)", "varchar(255)", "bigint unsigned", "decimal(20,0)"]) {
      const key = withColumns(freshListings(), "listings", [
        { name: "id", type, charset: "utf8mb4", collation: "utf8mb4_unicode_ci" },
        ...LISTINGS_TABLE.columns.slice(1),
      ]);
      expect((await planned(key)).result.ok).toBe(true);
    }
  });

  it("clears a held claim when the record is queued already, so the worker's ack cannot lose a change", async () => {
    const plan = planOf(await planned(freshListings()));
    const enqueuing = texts(plan).filter(
      (text) => text.startsWith("create definer") && text.includes("insert into"),
    );
    for (const text of enqueuing) {
      expect(text).toContain(
        "on duplicate key update `claimed_at` = null, `claimed_by` = null, `claim_token` = null",
      );
      expect(text).not.toContain("insert ignore");
    }
  });

  it("queues every insert after it, when an auto_increment key has its value", async () => {
    const plan = planOf(await planned(freshListings()));
    expect(texts(plan)).toContain(
      "create definer = current_user trigger `app`.`facetdb_listings_ins` after insert on `app`.`listings` for each row\ninsert into `app`.`facetdb_jobs` (`table_name`, `record_key`) values ('listings', cast(new.`id` as char character set utf8mb4))\n  on duplicate key update `claimed_at` = null, `claimed_by` = null, `claim_token` = null",
    );
  });

  it("sets a new row pending before the insert with onChange reset, whatever status it was given", async () => {
    const plan = planOf(await planned(freshListings()));
    expect(texts(plan)).toContain(
      "create definer = current_user trigger `app`.`facetdb_listings_new` before insert on `app`.`listings` for each row\nset new.`facetdb_status` = 'pending'",
    );
  });

  it("leaves the status alone with onChange keep, and drops the reset trigger an earlier install made", async () => {
    const fresh = planOf(await planned(freshListings(), listingsTarget({ onChange: "keep" })));
    expect(texts(fresh).join("\n")).not.toContain(LISTINGS_TRIGGERS.pending);
    const update = texts(fresh).find((text) => text.includes("before update")) ?? "";
    expect(update).not.toContain("facetdb_status");
    expect(update).toContain("insert into `app`.`facetdb_jobs`");
    // An install made with reset, planned again with keep.
    const switched = planOf(
      await planned(installedListings(), listingsTarget({ onChange: "keep" })),
    );
    expect(texts(switched)).toEqual([
      "set session lock_wait_timeout = 10",
      expect.stringMatching(/^-- stops the script here/),
      "drop trigger if exists `app`.`facetdb_listings_new`",
      "drop trigger if exists `app`.`facetdb_listings_upd`",
      expect.stringMatching(
        /^create definer = current_user trigger `app`.`facetdb_listings_upd` before update/,
      ),
    ]);
  });

  it("installs a second table of the database beside the first, on the queue they share", async () => {
    const installed = installedListings();
    const orders = { ...LISTINGS_TABLE, name: "orders" };
    const plan = planOf(
      await planned(
        { ...installed, tables: [...installed.tables, orders] },
        listingsTarget({ table: "orders", source: "orders" }),
      ),
    );
    const all = texts(plan).join("\n");
    expect(all).not.toContain("create table if not exists `app`.`facetdb_jobs`");
    expect(all).not.toContain("create table if not exists `app`.`facetdb_table_owners`");
    expect(all).toContain("values ('orders', 'proj_listings', 'orders')");
    expect(all).toContain("values ('orders', cast(new.`id` as char character set utf8mb4))");
    expect(all).toContain("alter table `app`.`orders`");
    // The worker holds its rights on the shared tables already: only the new table's are granted.
    expect(texts(plan).filter((text) => text.startsWith("grant"))).toEqual([
      expect.stringContaining("on `app`.`orders`"),
      expect.stringContaining("on `app`.`orders`"),
    ]);
  });

  it("renders a compound trigger between delimiter lines and sends it as one statement", async () => {
    const plan = planOf(await planned(freshListings()));
    const update = texts(plan).find((text) => text.includes("before update")) ?? "";
    expect(update).not.toContain("delimiter");
    expect(render(plan)).toContain(`delimiter //\n${update}//\ndelimiter ;\n`);
    // A statement whose only `;` is inside a comment or a string is not one to frame.
    expect(render(plan)).toContain("identified by ? password expire never;\n");
  });
});

describe("the worker's rights", () => {
  /** Every grant of the plan: its privileges, their columns, what it is on, and to whom. */
  function grants(plan: EnginePlan) {
    return texts(plan)
      .filter((text) => text.startsWith("grant"))
      .map((text) => {
        const match = /^grant (.+?)\s+on (`[^`]+`\.`[^`]+`) to (.+)$/s.exec(text);
        if (match === null) {
          throw new Error(`not a grant this test reads: ${text}`);
        }
        const [, privileges = "", on = "", to = ""] = match;
        const parts = [...privileges.matchAll(/(\w+)(?: \(([^)]*)\))?/g)].map((part) => ({
          privilege: part[1],
          columns: part[2]?.split(", ").map((column) => column.replaceAll("`", "")),
        }));
        return { parts, on, to };
      });
  }

  it("has no right on a column outside the state and FacetDB's own, and no right to create anything", async () => {
    const plan = planOf(await planned(freshListings()));
    const allowed = new Set([
      "id",
      "title",
      "description",
      "is_scam",
      "is_scam_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
    ]);
    const found = grants(plan);
    expect(found.map(({ on }) => on)).toEqual([
      "`app`.`listings`",
      "`app`.`listings`",
      `\`app\`.\`${JOBS_TABLE}\``,
      `\`app\`.\`${OWNERS_TABLE}\``,
    ]);
    for (const { parts, on, to } of found) {
      expect(to).toBe(WORKER_ACCOUNT);
      for (const { privilege, columns } of parts) {
        expect(["select", "insert", "update", "delete"]).toContain(privilege);
        if (on === "`app`.`listings`") {
          // On the customer's table only column rights, and only on these columns.
          expect(columns).toBeDefined();
          for (const column of columns ?? []) {
            expect(allowed.has(column)).toBe(true);
          }
        }
      }
    }
    const updated = found[1]?.parts[0]?.columns ?? [];
    expect(updated).toEqual([
      "is_scam",
      "is_scam_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
    ]);
    const script = render(plan);
    expect(script).not.toMatch(
      /\b(all|create|alter|drop|index|references|trigger)\b[^;]*\bto 'facetdb_worker'/i,
    );
    expect(script).not.toMatch(/with grant option|on \*\.\*|on `app`\.\*/i);
  });

  it("asks nothing of the application's account: the triggers run as their definer", async () => {
    const plan = planOf(await planned(freshListings()));
    const triggers = texts(plan).filter((text) => text.startsWith("create definer"));
    expect(triggers).toHaveLength(3);
    for (const text of triggers) {
      expect(text).toMatch(/^create definer = current_user trigger /);
    }
    expect(
      triggers.filter((text) => text.includes("insert into `app`.`facetdb_jobs`")),
    ).toHaveLength(2);
    // No statement grants anything to anyone but the worker login.
    for (const text of texts(plan).filter((one) => one.startsWith("grant"))) {
      expect(text.endsWith(` to ${WORKER_ACCOUNT}`)).toBe(true);
    }
  });
});

describe("planInstall refuses, says why and what to do, and changes nothing", () => {
  it("refuses a plaintext admin URL to another machine before it connects", async () => {
    const remote = await planned(
      freshListings(),
      listingsTarget(),
      INSTALL,
      "mysql://admin:s3cret@db.example.com:3306/app",
    );
    expect(refusalOf(remote)).toEqual({
      code: "admin-url-tls",
      message:
        "the admin connection string reaches db.example.com without TLS, so the admin password would travel in the clear; no connection was made",
      fix: 'add ?ssl={"rejectUnauthorized":true} to the admin connection string (mysql2 reads ssl as a JSON object, so ssl=true does not turn TLS on), or pass --allow-insecure if that network is trusted',
    });
    expect(remote.driver.opened).toBe(0);
    const invalid = await planned(freshListings(), listingsTarget(), INSTALL, "not a url");
    expect(refusalOf(invalid).code).toBe("admin-url");
    expect(invalid.driver.opened).toBe(0);
    // The operator's --allow-insecure lets it connect.
    const allowed = await planned(
      freshListings(),
      listingsTarget(),
      { ...INSTALL, allowInsecure: true },
      "mysql://admin:s3cret@db.example.com:3306/app",
    );
    expect(allowed.result.ok).toBe(true);
  });

  it("refuses to create the login without a password, in words that name the source's variable", async () => {
    const { result, driver } = await planned(
      freshListings(),
      listingsTarget({ urlVariable: "LISTINGS_URL" }),
      ENGINE_DEPS,
    );
    expect(result).toEqual({
      ok: false,
      refusal: {
        code: "worker-login",
        message:
          "the worker login facetdb_worker does not exist yet, and no password was given to create it with",
        fix: 'put the worker login and a long random password in LISTINGS_URL: mysql://facetdb_worker:<a long random password>@<host>:3306/<database>?ssl={"rejectUnauthorized":true}; the install creates the login with that password',
      },
    });
    readOnly(driver);
  });

  it("refuses an account of the worker's name for another host: install adds no second one", async () => {
    const beside = await planned({
      ...freshListings(),
      worker: { global: ["USAGE"] },
      otherWorkerHosts: ["localhost"],
    });
    expect(refusalOf(beside)).toEqual({
      code: "worker-host",
      message:
        "this server has 'facetdb_worker'@'localhost' beside 'facetdb_worker'@'%'; MySQL logs a connection from a matching host in as the more specific account, which has none of the rights FacetDB gives 'facetdb_worker'@'%'",
      fix: "drop 'facetdb_worker'@'localhost' (drop user 'facetdb_worker'@'localhost') if nothing else uses it, then run facetdb migrate again",
    });
    const instead = await planned({ ...freshListings(), otherWorkerHosts: ["10.0.0.%"] });
    expect(refusalOf(instead)).toMatchObject({
      code: "worker-host",
      message:
        "this server has 'facetdb_worker'@'10.0.0.%' and no 'facetdb_worker'@'%'; FacetDB's worker login is 'facetdb_worker'@'%', and install adds no second account of the name",
    });
    readOnly(beside.driver);
  });

  it("refuses when neither the connection string nor the config names a database", async () => {
    const none = await planned({ ...freshListings(), database: null });
    expect(refusalOf(none)).toMatchObject({ code: "no-database" });
    expect(refusalOf(none).fix).toContain("<database>.listings");
    readOnly(none.driver);
  });

  it("refuses a server whose sql_mode reads a backslash as a plain character", async () => {
    const mode = await planned({
      ...freshListings(),
      sqlMode: "STRICT_TRANS_TABLES,NO_BACKSLASH_ESCAPES",
    });
    expect(refusalOf(mode)).toMatchObject({ code: "sql-mode" });
    expect(refusalOf(mode).fix).toContain("remove NO_BACKSLASH_ESCAPES");
    readOnly(mode.driver);
  });

  it("refuses to create the login on a MariaDB whose grants may create accounts without a password", async () => {
    const mariadb: ScriptedDatabase = {
      ...freshListings(),
      version: "10.5.27-MariaDB",
      sqlMode: "STRICT_TRANS_TABLES,NO_ENGINE_SUBSTITUTION",
    };
    const open = await planned(mariadb);
    expect(refusalOf(open)).toEqual({
      code: "sql-mode",
      message:
        "this MariaDB server's sql_mode lacks NO_AUTO_CREATE_USER, under which a grant to an account that does not exist creates it with no password: the printed script creates 'facetdb_worker'@'%' and then grants it rights, so run by hand past a failed create user it would leave the login open; nothing was changed",
      fix: "add NO_AUTO_CREATE_USER to the server's sql_mode (it is in MariaDB's default), then run facetdb migrate again",
    });
    readOnly(open.driver);
    // MariaDB's default mode has it; a login that exists is not created; MySQL 8 never creates one.
    expect((await planned({ ...mariadb, sqlMode: MARIADB_SQL_MODE })).result.ok).toBe(true);
    expect(
      (await planned({ ...mariadb, worker: { global: ["USAGE"] } }, listingsTarget(), ENGINE_DEPS))
        .result.ok,
    ).toBe(true);
    expect((await planned({ ...freshListings(), sqlMode: "STRICT_TRANS_TABLES" })).result.ok).toBe(
      true,
    );
  });

  it("refuses to plan triggers the admin could not create with binary logging on", async () => {
    const withoutSuper = { binaryLogging: true, trustCreators: false, superUser: false };
    const logged: ScriptedDatabase = { ...freshListings(), triggerRights: withoutSuper };
    const refused1419 = await planned(logged);
    expect(refusalOf(refused1419)).toEqual({
      code: "log-bin",
      message:
        "this server logs binary changes and has log_bin_trust_function_creators off, so it lets only an account with the SUPER privilege create triggers, and the account of the admin connection string has none: the install would stop at its first trigger; nothing was changed",
      fix: "set log_bin_trust_function_creators to 1 (on RDS, in the instance's parameter group; on Cloud SQL, as a database flag), or run facetdb migrate as an account with SUPER, then run it again",
    });
    readOnly(refused1419.driver);
    const trusted = { binaryLogging: true, trustCreators: true, superUser: false };
    expect((await planned({ ...logged, triggerRights: trusted })).result.ok).toBe(true);
    const unlogged = { binaryLogging: false, trustCreators: false, superUser: false };
    expect((await planned({ ...logged, triggerRights: unlogged })).result.ok).toBe(true);
    // A plan that creates no trigger asks nothing of the binary log.
    const installed: ScriptedDatabase = { ...installedListings(), triggerRights: withoutSuper };
    expect(planOf(await planned(installed)).statements).toEqual([]);
  });

  it("refuses a table that does not exist, and a view", async () => {
    const missing = await planned({ ...freshListings(), tables: [] });
    expect(refusalOf(missing)).toEqual(
      refused(
        "app.listings does not exist; FacetDB adds columns to a table, it does not create one.",
      ),
    );
    const view = await planned({
      ...freshListings(),
      tables: [{ ...LISTINGS_TABLE, type: "VIEW" }],
    });
    expect(refusalOf(view)).toMatchObject({
      code: "not-a-table",
      message:
        "app.listings is a view, not a table; FacetDB puts its columns and triggers on a base table",
    });
    readOnly(missing.driver);
    readOnly(view.driver);
  });

  it("refuses a table name too long for the trigger names", async () => {
    const long = "l".repeat(53);
    const table = { ...LISTINGS_TABLE, name: long };
    const refusedLong = await planned(
      { ...freshListings(), tables: [table] },
      listingsTarget({ table: long }),
    );
    expect(refusalOf(refusedLong)).toMatchObject({ code: "name-too-long" });
    expect(refusalOf(refusedLong).message).toContain("a table name can have 52 at most");
    const fits = "l".repeat(52);
    const accepted = await planned(
      { ...freshListings(), tables: [{ ...LISTINGS_TABLE, name: fits }] },
      listingsTarget({ table: fits }),
    );
    expect(accepted.result.ok).toBe(true);
  });

  it("refuses a table without a single-column primary key a trigger can read, in Postgres's code", async () => {
    const cases: readonly (readonly [ScriptedDatabase, EngineTarget, string])[] = [
      [
        { ...freshListings(), tables: [{ ...LISTINGS_TABLE, primaryKey: [] }] },
        listingsTarget(),
        "app.listings has no primary key; FacetDB keys its jobs and decisions by it. Add one and run migrate again.",
      ],
      [
        { ...freshListings(), tables: [{ ...LISTINGS_TABLE, primaryKey: ["id", "title"] }] },
        listingsTarget(),
        "app.listings has a composite primary key (id, title); FacetDB supports single-column keys only for now. Add a single-column surrogate key.",
      ],
      [
        freshListings(),
        listingsTarget({ key: "uuid" }),
        "app.listings's primary key is id, not uuid; the config and the table disagree.",
      ],
      [
        withColumns(freshListings(), "listings", [
          { name: "id", type: "int", extra: "STORED GENERATED" },
          ...LISTINGS_TABLE.columns.slice(1),
        ]),
        listingsTarget(),
        "app.listings's primary key id is a generated column, which a trigger cannot read, so FacetDB could not queue the record. Use a key the application sets.",
      ],
    ];
    for (const [database, target, message] of cases) {
      const refusedKey = await planned(database, target);
      expect(refusalOf(refusedKey)).toEqual(refused(message));
      readOnly(refusedKey.driver);
    }
  });

  it("refuses a key the queue cannot keep as its text", async () => {
    const cases: readonly (readonly [string, string])[] = [
      [
        "text",
        "app.listings's primary key id is text, which MySQL indexes only by a prefix; FacetDB's queue keeps a record's whole key",
      ],
      [
        "binary(16)",
        "app.listings's primary key id is binary(16), whose bytes are not text; FacetDB's queue keeps a key as its text",
      ],
      [
        "varchar(512)",
        "app.listings's primary key id is varchar(512), longer than the 255 characters FacetDB's queue keeps of a key",
      ],
    ];
    for (const [type, message] of cases) {
      const key = withColumns(freshListings(), "listings", [
        { name: "id", type },
        ...LISTINGS_TABLE.columns.slice(1),
      ]);
      expect(refusalOf(await planned(key))).toEqual({
        code: "queue-key",
        message,
        fix: "use an integer, char or varchar key of at most 255 characters (a uuid as char(36) rather than binary(16))",
      });
    }
  });

  it("refuses state columns the table lacks, FacetDB writes, or generates", async () => {
    const read = (columns: readonly string[]) =>
      listingsTarget({ questionSet: { ...LISTINGS_QUESTIONS, read: columns } });
    const missing = await planned(freshListings(), read(["title", "body"]));
    expect(refusalOf(missing)).toEqual(
      refused(
        "app.listings has no column named body, which the source's read lists. Fix read in the config, or add the column.",
      ),
    );
    const own = await planned(installedListings(), read(["title", "facetdb_status"]));
    expect(refusalOf(own)).toEqual(
      refused(
        "app.listings: the state field facetdb_status is a column FacetDB writes; a state field must be the application's own column, or the worker's writes would re-queue every record.",
      ),
    );
    const generated = await planned(
      withColumns(freshListings(), "listings", [
        ...LISTINGS_TABLE.columns,
        { name: "slug", type: "varchar(255)", extra: "VIRTUAL GENERATED" },
      ]),
      read(["title", "slug"]),
    );
    expect(refusalOf(generated)).toEqual(
      refused(
        "app.listings: the state field slug is a generated column, which a MySQL trigger cannot compare. Read the columns it is generated from instead.",
      ),
    );
  });

  it("refuses a table another project installed on, in Postgres's words", async () => {
    const theirs = await planned(
      installedListings(listingsTarget({ project: { id: "proj_b", name: "Bee" } })),
    );
    expect(refusalOf(theirs)).toEqual(
      refused(
        "app.listings already carries FacetDB columns from another project (proj_b); one table belongs to one project. Uninstall there first, or point this project at another table.",
      ),
    );
    readOnly(theirs.driver);
  });

  it("refuses a table of the queue's name that is not the queue the triggers would write to", async () => {
    const older = await planned({
      ...freshListings(),
      tables: [
        LISTINGS_TABLE,
        {
          name: JOBS_TABLE,
          columns: [
            { name: "record_key", type: "int" },
            { name: "claimed_at", type: "datetime(3)" },
          ],
          primaryKey: ["record_key"],
        },
      ],
    });
    expect(refusalOf(older)).toEqual({
      code: "jobs-table",
      message:
        "app.facetdb_jobs exists and is not the queue this FacetDB makes: it has no table_name, enqueued_at, claimed_by, claim_token column; its primary key is (record_key), not (table_name, record_key)",
      fix: "drop or rename app.facetdb_jobs if no FacetDB install uses it (an earlier version may have left it), then run facetdb migrate again",
    });
    readOnly(older.driver);
    // Every column, keyed by the record_key alone.
    const keyedByRecord = await planned({
      ...freshListings(),
      tables: [LISTINGS_TABLE, { ...LISTINGS_JOBS, primaryKey: ["record_key"] }],
    });
    expect(refusalOf(keyedByRecord).message).toBe(
      "app.facetdb_jobs exists and is not the queue this FacetDB makes: its primary key is (record_key), not (table_name, record_key)",
    );
  });

  it("refuses a trigger of FacetDB's name on another table", async () => {
    const misplaced = await planned({
      ...freshListings(),
      triggers: [
        {
          name: LISTINGS_TRIGGERS.pending,
          table: "audit",
          timing: "BEFORE",
          event: "INSERT",
          body: "set new.at = now()",
        },
      ],
    });
    expect(refusalOf(misplaced)).toMatchObject({
      code: "trigger-name",
      message:
        "a trigger named facetdb_listings_new is already on app.audit; it is the name FacetDB gives a trigger of app.listings",
    });
  });

  it("refuses a question whose column the application already has", async () => {
    const collision = await planned(
      withColumns(freshListings(), "listings", [
        ...LISTINGS_TABLE.columns,
        { name: "is_scam", type: "tinyint(1)" },
      ]),
    );
    expect(refusalOf(collision)).toEqual(
      refused(
        "app.listings already has a column named is_scam that is not FacetDB's; rename the question or the column.",
      ),
    );
  });

  it("refuses a question whose type changed under its marked column", async () => {
    const changed = listingsTarget({
      questionSet: {
        ...LISTINGS_QUESTIONS,
        questions: [
          {
            type: "choice",
            name: "is_scam",
            instructions: "Is this listing a scam?",
            options: [
              { name: "yes", description: "It is" },
              { name: "no", description: "It is not" },
            ],
            stakes: "high",
            storeProbabilities: false,
          },
        ],
      },
    });
    expect(refusalOf(await planned(installedListings(), changed))).toEqual(
      refused(
        "app.listings: is_scam is tinyint(1) and the question now needs varchar(255); a question's type cannot change in place. Remove the question (migrate --prune drops its columns), then add it back.",
      ),
    );
  });

  it("refuses a worker login that holds rights FacetDB never gives", async () => {
    const rights = await planned({
      ...freshListings(),
      worker: {
        global: ["USAGE", "PROCESS"],
        schema: ["CREATE"],
        tables: [{ table: "listings", privilege: "SELECT" }],
      },
    });
    expect(refusalOf(rights)).toEqual(
      refused(
        "the user 'facetdb_worker'@'%' on this server holds PROCESS on the server, CREATE on the database app, SELECT on the whole table app.listings, rights FacetDB never gives it; FacetDB grants it single columns of a table and its own two tables only. Revoke those rights, or drop the user if no project uses it, then run migrate again.",
      ),
    );
  });
});
