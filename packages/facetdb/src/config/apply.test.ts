import { describe, expect, it } from "vitest";
import {
  type ApplyPlan,
  apply,
  type ConfigFileRead,
  type ConfigFiles,
  type GitState,
  planApply,
  uncommittedWords,
} from "./apply.ts";
import type { SourceDraft } from "./draft.ts";
import { facetdb, noul } from "./dsl.ts";
import { configFileSource } from "./json.ts";
import { unifiedDiff } from "./text-diff.ts";

/**
 * Apply's file half: a draft judged within the project as the file loads, rendered by the exporter,
 * shown as a diff, and written aside and renamed only when the confirmation names that diff and git
 * keeps a copy of what is replaced (or the write is forced).
 */

const URL = "postgres://facetdb_worker:worker-password@localhost:5432/app";
const ENV = { DATABASE_URL: URL };
const PATH = "facetdb.config.ts";

const DECLARED = facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: URL,
      table: "listings",
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});

/** As the loader reads `database: process.env.DATABASE_URL`: the value, and the variable. */
const CONFIG = {
  ...DECLARED,
  sources: DECLARED.sources.map((source) => ({ ...source, databaseEnv: "DATABASE_URL" })),
};

const TEXT = configFileSource(CONFIG);

const REWORDED: SourceDraft = {
  name: "listings",
  questions: {
    is_scam: { type: "noul", instructions: "Is this listing a scam or a fake?", stakes: "low" },
  },
};

function planned(draft: SourceDraft = REWORDED, text = TEXT): ApplyPlan {
  const result = planApply({ path: PATH, text, config: CONFIG }, draft, ENV);
  if (!result.ok) {
    throw new Error(`the draft was refused: ${JSON.stringify(result.issues)}`);
  }
  return result.plan;
}

/** The file in memory and git's answer as the test sets it; every replace is recorded. */
function files(text: string, git: GitState = { kind: "clean" }, read?: ConfigFileRead) {
  const state = { text, git, writes: [] as string[], gitAsked: 0 };
  const door: ConfigFiles = {
    read: () => Promise.resolve(read ?? { kind: "file", text: state.text }),
    replace: (_path, written) => {
      state.writes.push(written);
      state.text = written;
      return Promise.resolve();
    },
    gitState: () => {
      state.gitAsked += 1;
      return Promise.resolve(state.git);
    },
  };
  return { state, door };
}

describe("planApply", () => {
  it("renders the project with the draft through the exporter and diffs it against the file", () => {
    const plan = planned();

    expect(plan.changed).toBe(true);
    expect(plan.before).toBe(TEXT);
    expect(plan.after).toBe(configFileSource(plan.config));
    expect(plan.after).toContain('"is_scam": noul("Is this listing a scam or a fake?"),');
    expect(plan.diff).toBe(unifiedDiff(PATH, TEXT, plan.after));
    expect(plan.diff.split("\n").filter((line) => /^[-+][^-+]/.test(line))).toEqual([
      '-        "is_scam": noul("Is this listing a scam?"),',
      '+        "is_scam": noul("Is this listing a scam or a fake?"),',
    ]);
    // The same file and draft name the same plan; another draft or another file, another plan.
    expect(planned().id).toBe(plan.id);
    expect(planned({ ...REWORDED, name: "listings" }, `${TEXT}\n`).id).not.toBe(plan.id);
  });

  it("writes no connection string and no code from the draft: only the variable and JSON values", () => {
    const plan = planned({
      name: "listings",
      questions: {
        is_scam: {
          type: "noul",
          instructions: '"), require("node:child_process").execSync("id"), ("',
          stakes: "low",
        },
      },
    });

    expect(plan.after).not.toContain(URL);
    expect(plan.after).toContain("database: process.env.DATABASE_URL,");
    // Every string from the draft is a JSON string literal: its quotes are escaped, never closed.
    expect(plan.after).toContain(
      'noul("\\"), require(\\"node:child_process\\").execSync(\\"id\\"), (\\"")',
    );
  });

  it("refuses a new source naming a variable the file does not, by the databaseEnv key too", () => {
    const result = planApply(
      { path: PATH, text: TEXT, config: CONFIG },
      {
        name: "x",
        databaseEnv: "ADMIN_DATABASE_URL",
        table: "users",
        read: ["email"],
        questions: { is_staff: { type: "noul", instructions: "Is this a staff account?" } },
      },
      { ...ENV, ADMIN_DATABASE_URL: "postgres://admin:hunter2@localhost:5432/app" },
    );
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: "databaseEnv",
          message:
            "a draft reads only the connection variables facetdb.config.ts already names (DATABASE_URL); name one of those, or add the source to facetdb.config.ts",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    // Merged over a source the file has, the key is refused alike.
    expect(
      planApply(
        { path: PATH, text: TEXT, config: CONFIG },
        { name: "listings", databaseEnv: "ADMIN_DATABASE_URL" },
        { ...ENV, ADMIN_DATABASE_URL: "postgres://admin:hunter2@localhost:5432/app" },
      ),
    ).toMatchObject({ ok: false, issues: [{ path: "databaseEnv" }] });
  });

  it("refuses a where the file does not have, on its source or a new one: SQL is the operator's", () => {
    const changed = planApply(
      { path: PATH, text: TEXT, config: CONFIG },
      { name: "listings", where: "true) or (select pg_sleep(10)) is null or (true" },
      ENV,
    );
    expect(changed).toEqual({
      ok: false,
      issues: [
        {
          path: "sources[0].where",
          message:
            "a draft cannot change the where filter: it is SQL that runs in your database as written; edit the where filter in facetdb.config.ts by hand",
        },
      ],
    });
    const added = planApply(
      { path: PATH, text: TEXT, config: CONFIG },
      {
        name: "orders",
        database: { env: "DATABASE_URL" },
        table: "orders",
        read: ["note"],
        where: "price > 0",
        questions: { is_fraud: { type: "noul", instructions: "Is this order fraud?" } },
      },
      ENV,
    );
    expect(added).toMatchObject({
      ok: false,
      issues: [
        {
          path: "sources[1].where",
          message: expect.stringContaining(
            "a draft cannot give a new source the where filter: it is SQL",
          ),
        },
      ],
    });
    // The where the file already has rides along unchanged.
    const kept = {
      ...CONFIG,
      sources: CONFIG.sources.map((source) => ({ ...source, where: "price > 0" })),
    };
    expect(
      planApply({ path: PATH, text: configFileSource(kept), config: kept }, REWORDED, ENV).ok,
    ).toBe(true);
  });

  it("refuses actions the file does not have: a plugin and its settings are the operator's", () => {
    const result = planApply(
      { path: PATH, text: TEXT, config: CONFIG },
      {
        name: "listings",
        actions: [
          { plugin: "@facetdb/webhook", action: "send", config: { url: "https://example.com" } },
        ],
      },
      ENV,
    );
    expect(result).toMatchObject({
      ok: false,
      issues: [{ path: "sources[0].actions", message: expect.stringContaining("by hand") }],
    });
  });

  it("keeps the variable the file names when another variable holds the same string here", () => {
    const text = TEXT.replace("process.env.DATABASE_URL", "process.env.LISTINGS_URL");
    // Both hold the URL here; the loader recorded DATABASE_URL, the file reads LISTINGS_URL.
    const both = { DATABASE_URL: URL, LISTINGS_URL: URL };
    const result = planApply({ path: PATH, text, config: CONFIG }, REWORDED, both);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    expect(result.plan.after).toContain("database: process.env.LISTINGS_URL,");
    expect(result.plan.diff).not.toContain("process.env");

    // A file that names neither (a helper reads it) cannot tell: refused, never guessed, and the
    // refusal names no variable the file's text does not hold.
    const helper = TEXT.replace("process.env.DATABASE_URL", "connection()");
    expect(planApply({ path: PATH, text: helper, config: CONFIG }, REWORDED, both)).toEqual({
      ok: false,
      issues: [
        {
          path: "sources[0].database",
          message:
            'Several variables hold the same connection string where the worker runs, and Apply cannot tell from facetdb.config.ts which of them "listings" reads, so it would not write the right one; give "listings" a variable whose value no other variable shares, or edit facetdb.config.ts by hand',
        },
      ],
    });
  });

  it("refuses a draft the loader refuses, with the field paths, and a variable the file does not name", () => {
    const result = planApply(
      { path: PATH, text: TEXT, config: CONFIG },
      { name: "listings", thresholds: { is_scam: { yesAbove: 2 } } },
      ENV,
    );
    expect(result).toMatchObject({
      ok: false,
      issues: [expect.objectContaining({ path: expect.stringContaining("thresholds.is_scam") })],
    });
    expect(
      planApply(
        { path: PATH, text: TEXT, config: CONFIG },
        { name: "listings", database: { env: "AWS_SECRET_ACCESS_KEY" } },
        { ...ENV, AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI" },
      ),
    ).toMatchObject({ ok: false, issues: [{ path: "database.env" }] });
  });

  it("never writes a variable that is not a name process.env.<name> can carry: the schema refuses it", () => {
    const odd = {
      ...CONFIG,
      sources: CONFIG.sources.map((source) => ({ ...source, databaseEnv: "X;process.exit()" })),
    };
    const result = planApply({ path: PATH, text: TEXT, config: odd }, REWORDED, {
      "X;process.exit()": URL,
    });
    expect(result).toMatchObject({ ok: false, issues: [{ path: "sources[0].databaseEnv" }] });
  });

  it("refuses a table source whose variable is unknown, rather than write another one", () => {
    const unset = {
      ...DECLARED,
      sources: DECLARED.sources.map(({ database: _database, ...source }) => source),
    };
    const result = planApply({ path: PATH, text: TEXT, config: unset }, REWORDED, {});
    expect(result).toMatchObject({ ok: false, issues: [{ path: "sources[0].database" }] });
  });

  it("says a draft that changes nothing changes nothing", () => {
    const plan = planned({ name: "listings" });
    expect(plan.changed).toBe(false);
    expect(plan.diff).toBe("");
  });
});

describe("apply", () => {
  it("writes the plan's file when git keeps the file as it is", async () => {
    const plan = planned();
    const disk = files(TEXT);

    expect(await apply(plan, { force: false, files: disk.door })).toEqual({ kind: "written" });
    expect(disk.state.writes).toEqual([plan.after]);
  });

  it.each([
    [{ kind: "modified" }, "has changes git has not committed, and Apply would replace them"],
    [{ kind: "untracked" }, "has never been committed to git"],
    [{ kind: "ignored" }, "is ignored by git"],
    [{ kind: "no-repository" }, "is not in a git repository"],
    [{ kind: "no-git" }, "git is not installed here"],
    [{ kind: "unreadable", reason: "fatal: detected dubious ownership" }, "dubious ownership"],
  ] as const)("refuses %o without force, saying why, and writes with force", async (git, words) => {
    const plan = planned();
    const disk = files(TEXT, git);

    const refused = await apply(plan, { force: false, files: disk.door });
    expect(refused).toMatchObject({ kind: "uncommitted", message: expect.stringContaining(words) });
    expect(refused).toMatchObject({
      fix: expect.stringContaining('apply again with force ("force": true)'),
    });
    expect(disk.state.writes).toEqual([]);

    expect(await apply(plan, { force: true, files: disk.door })).toEqual({ kind: "written" });
    expect(disk.state.writes).toEqual([plan.after]);
  });

  it("never replaces a file changed since the plan, a link, or with nothing to change", async () => {
    const plan = planned();
    const moved = files(`${TEXT}// a comment typed meanwhile\n`);
    expect(await apply(plan, { force: true, files: moved.door })).toEqual({ kind: "moved" });
    expect(moved.state.writes).toEqual([]);

    const linked = files(TEXT, { kind: "clean" }, { kind: "not-a-file" });
    expect(await apply(plan, { force: true, files: linked.door })).toEqual({ kind: "not-a-file" });
    expect(linked.state.writes).toEqual([]);

    const same = files(TEXT);
    expect(await apply(planned({ name: "listings" }), { force: false, files: same.door })).toEqual({
      kind: "unchanged",
    });
    expect(same.state).toMatchObject({ writes: [], gitAsked: 0 });
  });

  it("names every git state's fix, and none for a committed file", () => {
    expect(uncommittedWords({ kind: "clean" }, PATH)).toBeUndefined();
    expect(uncommittedWords({ kind: "untracked" }, PATH)).toEqual({
      message:
        "facetdb.config.ts has never been committed to git, so nothing could bring back what it holds now once Apply replaced it",
      fix: 'commit it first (git add facetdb.config.ts && git commit), or apply again with force ("force": true) to replace it',
    });
    expect(uncommittedWords({ kind: "no-repository" }, PATH)?.fix).toBe(
      'apply again with force ("force": true) to replace it, or put the project under git (git init, then git add facetdb.config.ts && git commit) so Apply can check',
    );
  });
});

describe("unifiedDiff", () => {
  it("prints hunks with three lines of context, as git does", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n").concat("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j", "k"].join("\n").concat("\n");
    expect(unifiedDiff("x.ts", before, after)).toBe(
      [
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -2,9 +2,10 @@",
        " b",
        " c",
        " d",
        "-e",
        "+E",
        " f",
        " g",
        " h",
        " i",
        " j",
        "+k",
        "",
      ].join("\n"),
    );
  });

  it("splits changes far apart into hunks, and says when a last line has no newline", () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
    const changed = lines.map((line, index) => (index === 0 || index === 19 ? `${line}!` : line));
    const diff = unifiedDiff("x.ts", lines.join("\n"), changed.join("\n"));
    expect(diff.split("\n").filter((line) => line.startsWith("@@"))).toEqual([
      "@@ -1,4 +1,4 @@",
      "@@ -17,4 +17,4 @@",
    ]);
    expect(diff).toContain(
      "-line 20\n\\ No newline at end of file\n+line 20!\n\\ No newline at end of file\n",
    );
    expect(unifiedDiff("x.ts", "same\n", "same\n")).toBe("");
    expect(unifiedDiff("x.ts", "", "new\n")).toBe("--- a/x.ts\n+++ b/x.ts\n@@ -0,0 +1 @@\n+new\n");
  });
});
