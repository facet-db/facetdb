import type { EnginePlan, EngineTarget, PlanResult, QuestionSet, Refusal } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import {
  ADMIN_URL,
  ENGINE_DEPS,
  freshListings,
  installedListings,
  LISTINGS_QUESTIONS,
  listingsTarget,
  type RecordingDriver,
  recordingDriver,
  type ScriptedDatabase,
  scriptedDatabase,
} from "../testing/index.ts";
import {
  createMysqlInstaller,
  KEPT_REASON,
  PRUNE_RERUN_NOTE,
  REFUSED_FIX,
  SETTINGS,
  scriptHeader,
  WORKER_ACCOUNT,
} from "./index.ts";

/**
 * `migrate --prune` on MySQL and MariaDB with the recording driver: the marked columns of questions
 * the set no longer has go, after the worker's rights on them (MySQL keeps a dropped column's
 * grants); a `_probabilities` column of a question still asked stays; a state column `read` no
 * longer lists loses the worker's read; nothing to prune is an empty plan.
 */

type Planned = { readonly result: PlanResult; readonly driver: RecordingDriver };

async function planned(
  database: ScriptedDatabase,
  target: EngineTarget,
  url = ADMIN_URL,
): Promise<Planned> {
  const driver = recordingDriver(scriptedDatabase(database));
  const result = await createMysqlInstaller({ connect: driver.connect }).planPrune(
    target,
    url,
    ENGINE_DEPS,
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
    throw new Error("planned instead of refusing");
  }
  return result.refusal;
}

const texts = (plan: EnginePlan) => plan.statements.map((statement) => statement.text);

const EMPTY: EnginePlan = {
  statements: [],
  transactional: false,
  removes: [],
  keeps: [],
  notes: [],
};

/** The listings set with a choice question beside `is_scam`, storing its probabilities or not. */
function withCategory(storeProbabilities: boolean): QuestionSet {
  return {
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
        storeProbabilities,
      },
    ],
  };
}

describe("planPrune", () => {
  it("drops a removed question's columns after taking back the worker's rights on them", async () => {
    const installed = installedListings(listingsTarget({ questionSet: withCategory(false) }));
    const plan = planOf(await planned(installed, listingsTarget()));
    expect(texts(plan)).toEqual([
      SETTINGS.text,
      "revoke select (`category`, `category_confidence`), update (`category`, `category_confidence`)\n  on `app`.`listings` from 'facetdb_worker'@'%'",
      "alter table `app`.`listings`\n  drop column `category`,\n  drop column `category_confidence`",
    ]);
    expect(plan.statements.map((statement) => [statement.database, statement.purpose])).toEqual([
      ["source", "settings"],
      ["source", "grants"],
      ["source", "columns"],
    ]);
    expect(plan.removes).toEqual(
      ["category", "category_confidence"].map((name) => ({
        kind: "column",
        name,
        of: "app.listings",
        scope: "source",
        reason: "no question asks it any more",
      })),
    );
    expect(plan).toMatchObject({ transactional: false, keeps: [], notes: [PRUNE_RERUN_NOTE] });
    expect(plan.confirm).toBeUndefined();
    // On a MariaDB server its note says MariaDB, as the version read says.
    const mariadb = planOf(
      await planned({ ...installed, version: "10.6.20-MariaDB-ubu2204" }, listingsTarget()),
    );
    expect(mariadb.notes).toEqual([
      "MariaDB runs these statements one by one, with no transaction around them: if one fails, the ones before it stay done, and running facetdb migrate --prune again completes it.",
    ]);
    // And its script's header, as the note does; MySQL's stays MySQL's.
    const { render } = createMysqlInstaller({ connect: recordingDriver().connect });
    expect(render(mariadb).startsWith(`${scriptHeader("MariaDB")}\n\n`)).toBe(true);
    expect(render(plan).startsWith(`${scriptHeader("MySQL")}\n\n`)).toBe(true);
  });

  it("drops the columns a question had under its old type, with why", async () => {
    const changed = listingsTarget({
      questionSet: {
        ...LISTINGS_QUESTIONS,
        questions: [
          {
            type: "score",
            name: "is_scam",
            instructions: "How likely is this listing a scam?",
            levels: [{ name: "unlikely" }, { name: "likely" }],
            stakes: "high",
          },
        ],
      },
    });
    const plan = planOf(await planned(installedListings(), changed));
    expect(plan.removes).toEqual([
      {
        kind: "column",
        name: "is_scam_probability",
        of: "app.listings",
        scope: "source",
        reason: "its question changed type",
      },
    ]);
  });

  it("keeps a live question's _probabilities column when storeProbabilities went off, rights and all", async () => {
    const installed = installedListings(listingsTarget({ questionSet: withCategory(true) }));
    const plan = planOf(
      await planned(installed, listingsTarget({ questionSet: withCategory(false) })),
    );
    expect(plan).toEqual({
      ...EMPTY,
      keeps: [
        {
          kind: "column",
          name: "category_probabilities",
          of: "app.listings",
          scope: "source",
          reason: KEPT_REASON,
        },
      ],
    });
  });

  it("takes back the worker's read of a state column read no longer lists", async () => {
    const plan = planOf(
      await planned(
        installedListings(),
        listingsTarget({ questionSet: { ...LISTINGS_QUESTIONS, read: ["title"] } }),
      ),
    );
    expect(texts(plan)).toEqual([
      SETTINGS.text,
      "revoke select (`description`)\n  on `app`.`listings` from 'facetdb_worker'@'%'",
    ]);
    expect(plan.removes).toEqual([
      {
        kind: "grant",
        name: WORKER_ACCOUNT,
        of: "description",
        scope: "source",
        reason: "read no longer lists it",
      },
    ]);
  });

  it("keeps the worker's read of a time-typed created_at, which its scan orders by, and takes back any other", async () => {
    const installed = installedListings();
    const withMarker = (type: string): ScriptedDatabase => ({
      ...installed,
      tables: installed.tables.map((table) =>
        table.name === "listings"
          ? { ...table, columns: [...table.columns, { name: "created_at", type }] }
          : table,
      ),
      worker: {
        ...installed.worker,
        columns: [
          ...(installed.worker?.columns ?? []),
          { table: "listings", column: "created_at", privilege: "SELECT" },
        ],
      },
    });
    expect(planOf(await planned(withMarker("datetime(3)"), listingsTarget()))).toEqual(EMPTY);
    expect(planOf(await planned(withMarker("timestamp"), listingsTarget()))).toEqual(EMPTY);
    // A created_at that is not a time orders nothing: the worker's read of it is not install's.
    expect(texts(planOf(await planned(withMarker("varchar(32)"), listingsTarget())))).toEqual([
      SETTINGS.text,
      "revoke select (`created_at`)\n  on `app`.`listings` from 'facetdb_worker'@'%'",
    ]);
  });

  it("refuses an admin who may not read mysql.user, in words that name the right to grant", async () => {
    const denied = await planned(
      { ...installedListings(), deniedGrantTables: ["user"] },
      listingsTarget({ questionSet: { ...LISTINGS_QUESTIONS, read: ["title"] } }),
    );
    expect(refusalOf(denied)).toMatchObject({
      code: "admin-rights",
      fix: expect.stringContaining("grant select on mysql.user to <the admin account>"),
    });
    expect(denied.driver.closed).toBe(1);
  });

  it("is an empty plan when there is nothing to prune, or nothing installed yet", async () => {
    for (const database of [
      installedListings(),
      freshListings(),
      { ...installedListings(), tables: [] },
    ]) {
      const prune = await planned(database, listingsTarget());
      expect(planOf(prune)).toEqual(EMPTY);
      expect(prune.driver.sent.every((sent) => sent.text.trimStart().startsWith("select"))).toBe(
        true,
      );
      expect(prune.driver.closed).toBe(1);
    }
  });

  it("refuses a table of another project, and one that lost its single-column key", async () => {
    const theirs = await planned(
      installedListings(listingsTarget({ project: { id: "proj_b", name: "Bee" } })),
      listingsTarget(),
    );
    expect(refusalOf(theirs)).toEqual({
      code: "prune-refused",
      message: "app.listings belongs to another project (proj_b); prune it from that project.",
      fix: REFUSED_FIX,
    });
    const installed = installedListings();
    const keyless: ScriptedDatabase = {
      ...installed,
      tables: installed.tables.map((table) =>
        table.name === "listings" ? { ...table, primaryKey: [] } : table,
      ),
    };
    expect(refusalOf(await planned(keyless, listingsTarget()))).toEqual({
      code: "prune-refused",
      message:
        "app.listings no longer has a single-column primary key, which FacetDB installed by; restore it first.",
      fix: REFUSED_FIX,
    });
  });

  it("says a view that reads a dropped column breaks, which MariaDB cannot list", async () => {
    const installed = installedListings(listingsTarget({ questionSet: withCategory(false) }));
    const mariadb = planOf(await planned({ ...installed, views: "unlisted" }, listingsTarget()));
    expect(mariadb.notes).toEqual([
      PRUNE_RERUN_NOTE,
      "MySQL and MariaDB drop a column that a view reads, and the view then fails with error 1356; MariaDB cannot list the views that read app.listings, so check them before this runs.",
    ]);
    // Only a revoke, no column dropped: nothing for a view to lose.
    const unread = planOf(
      await planned(
        { ...installedListings(), views: "unlisted" },
        listingsTarget({ questionSet: { ...LISTINGS_QUESTIONS, read: ["title"] } }),
      ),
    );
    expect(unread.notes).toEqual([PRUNE_RERUN_NOTE]);
  });

  it("refuses a plaintext admin URL before it connects", async () => {
    const remote = await planned(
      installedListings(),
      listingsTarget(),
      "mysql://admin:s3cret@db.example.com/app",
    );
    expect(refusalOf(remote).code).toBe("admin-url-tls");
    expect(remote.driver.opened).toBe(0);
  });
});
