import type { EngineTarget, QuestionSet } from "@facetdb/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type TemporaryDatabase, temporaryDatabase } from "../testing/index.ts";
import { planInstall } from "./install.ts";
import {
  columns,
  execute,
  install,
  jobs,
  LISTINGS,
  listings,
  planned,
  ran,
  reading,
  rows,
  snapshot,
  target,
  withCategory,
} from "./listings-world.ts";
import { NOTHING, REFUSED_FIX } from "./plan.ts";
import { KEPT_REASON, planPrune } from "./prune.ts";
import { render } from "./run.ts";

/**
 * `migrate --prune` on a SQLite file, run for real on a temporary file: the columns of questions
 * the set no longer has go, with the record that they were FacetDB's, and nothing else does; a
 * column the application uses is refused by name; a table not installed yet has nothing to prune.
 */

let file: TemporaryDatabase;

beforeEach(() => {
  file = temporaryDatabase();
});

afterEach(() => {
  file.remove();
});

function plan(source: EngineTarget) {
  return reading(file, (query) => planPrune(source, query));
}

/** The listings set with the category question but without its stored probabilities. */
const categoryWithoutProbabilities: QuestionSet = {
  ...withCategory,
  questions: withCategory.questions.map((question) =>
    question.type === "choice" ? { ...question, storeProbabilities: false } : question,
  ),
};

/** The columns that carry FacetDB's mark in the table's stored definition, in table order. */
function marked(): readonly string[] {
  const db = file.open();
  try {
    const sql = String(
      rows(db, "select sql from sqlite_master where name = 'listings'")[0]?.["sql"],
    );
    return [...sql.matchAll(/"([a-z_]+)" \/\* facetdb \*\//g)].map((match) => String(match[1]));
  } finally {
    db.close();
  }
}

describe("planPrune", () => {
  it("drops the columns of a removed question, their marks with them, and nothing else", async () => {
    execute(file, LISTINGS);
    await install(file, target({ questionSet: withCategory }));
    const prune = planned(await plan(target()));
    expect(prune.statements.map((statement) => statement.text)).toEqual([
      'alter table "listings" drop column "category"',
      'alter table "listings" drop column "category_confidence"',
      'alter table "listings" drop column "category_probabilities"',
    ]);
    expect(prune.transactional).toBe(true);
    expect(prune.removes).toEqual(
      ["category", "category_confidence", "category_probabilities"].map((name) => ({
        kind: "column",
        name,
        of: "listings",
        scope: "source",
        reason: "no question asks it any more",
      })),
    );
    expect(prune.keeps).toEqual([]);
    expect(render(prune)).toMatch(
      /^begin immediate;\n\nalter table "listings" drop column "category";/,
    );

    ran(target(), prune, file);
    expect(columns(file)).toEqual([
      "id",
      "title",
      "description",
      "price",
      "is_scam",
      "is_scam_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
    ]);
    expect(marked()).toEqual([
      "is_scam",
      "is_scam_probability",
      "facetdb_status",
      "facetdb_updated_at",
      "facetdb_reviewed",
    ]);
    // The change capture is untouched.
    execute(file, "insert into listings (title, description) values ('bike', 'red')");
    const db = file.open();
    expect(jobs(db)).toHaveLength(1);
  });

  // The application's own column of a removed question's name, and its rebuild form.
  it.each([
    [
      "dropped and added again",
      "alter table listings drop column category; alter table listings add column category text; insert into listings (title, description, category) values ('bike', 'red', 'vehicles')",
      ["category_confidence", "category_probabilities"],
    ],
    [
      "rebuilt the SQLite way",
      `insert into listings (title, description) values ('bike', 'red');
       create table new_listings (id integer primary key, title text, description text, price real, category text);
       insert into new_listings (id, title, description, price, category) select id, title, description, price, 'vehicles' from listings;
       drop table listings;
       alter table new_listings rename to listings;`,
      [],
    ],
  ])(
    "never drops the application's own category when the application %s",
    async (_, change, dropped) => {
      execute(file, LISTINGS);
      await install(file, target({ questionSet: withCategory }));
      execute(file, change);
      const prune = planned(await plan(target()));
      expect(prune.removes.map((object) => object.name)).toEqual(dropped);
      expect(render(prune)).not.toContain('drop column "category";');
      ran(target(), prune, file);
      expect(columns(file)).toContain("category");
      expect(rows(file.open(), "select category from listings")).toEqual([
        { category: "vehicles" },
      ]);
    },
  );

  it("keeps a _probabilities column once storeProbabilities is off, and says why", async () => {
    execute(file, LISTINGS);
    await install(file, target({ questionSet: withCategory }));
    const prune = planned(await plan(target({ questionSet: categoryWithoutProbabilities })));
    expect(prune.statements).toEqual([]);
    expect(prune.removes).toEqual([]);
    expect(prune.keeps).toEqual([
      {
        kind: "column",
        name: "category_probabilities",
        of: "listings",
        scope: "source",
        reason: KEPT_REASON,
      },
    ]);
  });

  it("says a column went because its question changed type", async () => {
    execute(file, LISTINGS);
    await install(file, target({ questionSet: withCategory }));
    const changed: QuestionSet = {
      ...listings,
      questions: [
        ...listings.questions,
        { type: "noul", name: "category", instructions: "Is it a car?", stakes: "low" },
      ],
    };
    const prune = planned(await plan(target({ questionSet: changed })));
    expect(prune.removes).toEqual([
      {
        kind: "column",
        name: "category_confidence",
        of: "listings",
        scope: "source",
        reason: "its question changed type",
      },
      {
        kind: "column",
        name: "category_probabilities",
        of: "listings",
        scope: "source",
        reason: "its question changed type",
      },
    ]);
  });

  it("is an empty plan for a table not installed yet, or not there at all", async () => {
    execute(file, LISTINGS);
    expect(await plan(target())).toEqual({ ok: true, plan: NOTHING });
    expect(await plan(target({ table: "adverts" }))).toEqual({ ok: true, plan: NOTHING });
  });

  it("refuses another project's table", async () => {
    execute(file, LISTINGS);
    await install(file, target({ questionSet: withCategory }));
    expect(await plan(target({ project: { id: "proj_other", name: "Other" } }))).toEqual({
      ok: false,
      refusal: {
        code: "prune-refused",
        message: "listings belongs to another project (proj_listings); prune it from that project.",
        fix: REFUSED_FIX,
      },
    });
  });

  it("refuses a drop the application's view blocks, naming the view", async () => {
    execute(file, LISTINGS);
    await install(file, target({ questionSet: withCategory }));
    execute(file, "create view cars as select id, title from listings where category = 'car'");
    const before = snapshot(file);
    expect(await plan(target())).toEqual({
      ok: false,
      refusal: {
        code: "prune-refused",
        message:
          "listings: the view cars uses category; SQLite cannot drop a column that an index, a view, a trigger or the table's own definition uses, and FacetDB never changes what is not its own. Drop or change it first, then run migrate --prune again.",
        fix: REFUSED_FIX,
      },
    });
    expect(snapshot(file)).toEqual(before);
  });

  it("leaves the install's script as shown: migrate plans it again after the prune and gets the same one", async () => {
    execute(file, LISTINGS);
    await install(file, target({ questionSet: withCategory }));
    // migrate --prune shows both scripts, then runs the prune and plans install again.
    const prune = planned(await plan(target()));
    const shown = render(planned(await reading(file, (query) => planInstall(target(), query))));
    ran(target(), prune, file);
    const again = planned(await reading(file, (query) => planInstall(target(), query)));
    expect(render(again)).toBe(shown);
    ran(target(), again, file);
    expect(columns(file)).not.toContain("category");
  });
});
