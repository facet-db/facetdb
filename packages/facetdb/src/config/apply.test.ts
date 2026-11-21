import { describe, expect, it } from "vitest";
import {
  type ApplyPlan,
  apply,
  type ConfigFileRead,
  type ConfigFiles,
  type GitState,
  planApply as planConfig,
  uncommittedWords,
} from "./apply.ts";
import type { ProjectDraft, SourceDraft } from "./draft.ts";
import { facetdb, noul, type ProjectConfig } from "./dsl.ts";
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

/**
 * As the loader reads `database: process.env.DATABASE_URL`: the value, and the variable found by
 * it (no `databaseEnvNamed`), so Apply checks the name against the file's text.
 */
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

/** Apply with one source's draft, as the Questions page sends it. */
function planApply(
  current: Parameters<typeof planConfig>[0],
  draft: SourceDraft,
  env: Parameters<typeof planConfig>[2],
) {
  return planConfig(current, { source: draft }, env);
}

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

  it("says whether the file holds lines of the person's own that the rewrite drops", () => {
    // A file in FacetDB's own form: every line of it is one the exporter writes, nothing is lost.
    expect(planned().dropsOwnText).toBe(false);
    // A comment, or code of the person's own, is not the exporter's: rewriting the file drops it.
    const commented = TEXT.replace("export default", "// the listings of the shop\nexport default");
    expect(commented).not.toBe(TEXT);
    expect(planned(REWORDED, commented).dropsOwnText).toBe(true);
    expect(planned(REWORDED, `const shop = "listings";\n${TEXT}`).dropsOwnText).toBe(true);
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
    expect(plan.after).toContain('database: env("DATABASE_URL"),');
    expect(plan.after).toContain('import { env, facetdb, noul } from "facetdb";');
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

  describe("where two variables hold one connection string here", () => {
    const both = { DATABASE_URL: URL, LISTINGS_URL: URL };

    /** A file as a user writes it with `process.env`, by hand: the exporter writes `env(...)`. */
    const legacy = (database: string) =>
      [
        'import { facetdb, noul } from "facetdb";',
        "",
        "export default facetdb({",
        '  model: "jev-1.14.0",',
        "  sources: [",
        "    {",
        '      name: "listings",',
        `      database: ${database},`,
        '      table: "listings",',
        '      read: ["title"],',
        '      questions: { is_scam: noul("Is this listing a scam?") },',
        "    },",
        "  ],",
        "});",
        "",
      ].join("\n");

    it("keeps the process.env variable the file names, rather than the loader's guess", () => {
      // The loader recorded DATABASE_URL (CONFIG), the file reads LISTINGS_URL.
      const text = legacy("process.env.LISTINGS_URL");
      const result = planApply({ path: PATH, text, config: CONFIG }, REWORDED, both);
      if (!result.ok) {
        throw new Error(JSON.stringify(result.issues));
      }
      expect(result.plan.after).toContain('database: env("LISTINGS_URL"),');
      expect(result.plan.diff).toContain('+      database: env("LISTINGS_URL"),');
      expect(result.plan.diff).toContain("-      database: process.env.LISTINGS_URL,");
      // The bracket form names it too.
      const bracket = legacy('process.env["LISTINGS_URL"]');
      const kept = planApply({ path: PATH, text: bracket, config: CONFIG }, REWORDED, both);
      expect(kept.ok && kept.plan.after).toContain('database: env("LISTINGS_URL"),');
    });

    it("refuses a process.env file that names both variables, saying only the names it holds", () => {
      const text = legacy("process.env.LISTINGS_URL ?? process.env.DATABASE_URL");
      expect(planApply({ path: PATH, text, config: CONFIG }, REWORDED, both)).toEqual({
        ok: false,
        issues: [
          {
            path: "sources[0].database",
            message:
              'DATABASE_URL, LISTINGS_URL hold the same connection string where the worker runs, and Apply cannot tell from facetdb.config.ts which of them "listings" reads, so it would not write the right one; give "listings" a variable whose value no other variable shares, or edit facetdb.config.ts by hand',
          },
        ],
      });
    });

    it("refuses a file that names neither (a helper reads it), never guessing", () => {
      // The refusal names no variable the file's text does not hold.
      const helper = legacy("connection()");
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

    it("never pins or refuses a source the file named with env(...): the loader's mark, not the text, decides", () => {
      // As the loader reads `database: env("LISTINGS_URL")`: the name is the file's own.
      const named = {
        ...DECLARED,
        sources: DECLARED.sources.map((source) => ({
          ...source,
          databaseEnv: "LISTINGS_URL",
          databaseEnvNamed: true as const,
        })),
      };
      const text = configFileSource(named);
      expect(text).toContain('database: env("LISTINGS_URL"),');
      const result = planApply({ path: PATH, text, config: named }, REWORDED, both);
      expect(result.ok && result.plan.after).toContain('database: env("LISTINGS_URL"),');
      // Even a text that names neither variable through process.env leaves it as it is.
      const helper = planApply(
        { path: PATH, text: legacy("connection()"), config: named },
        REWORDED,
        both,
      );
      expect(helper.ok).toBe(true);

      // One source named DATABASE_URL with env(), another read through process.env.LISTINGS_URL
      // and guessed DATABASE_URL by the loader: the text's process.env.LISTINGS_URL pins the second
      // and never moves the first, which judging by the text alone would.
      const [listings] = DECLARED.sources;
      if (listings === undefined) throw new Error("DECLARED has a source");
      const two = {
        ...DECLARED,
        sources: [
          { ...listings, databaseEnv: "DATABASE_URL", databaseEnvNamed: true as const },
          { ...listings, name: "sellers", table: "sellers", databaseEnv: "DATABASE_URL" },
        ],
      };
      const mixed = configFileSource(two).replace(
        /(name: "sellers",\n\s*)database: env\("DATABASE_URL"\)/,
        "$1database: process.env.LISTINGS_URL",
      );
      expect(mixed).toContain("database: process.env.LISTINGS_URL,");
      expect(mixed).toContain('database: env("DATABASE_URL"),');
      const planned = planApply({ path: PATH, text: mixed, config: two }, REWORDED, both);
      if (!planned.ok) {
        throw new Error(JSON.stringify(planned.issues));
      }
      expect(planned.plan.config.sources.map((source) => source.databaseEnv)).toEqual([
        "DATABASE_URL",
        "LISTINGS_URL",
      ]);
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

  it("never writes a variable that is not a name env(...) can carry: the schema refuses it", () => {
    const odd = {
      ...CONFIG,
      sources: CONFIG.sources.map((source) => ({ ...source, databaseEnv: "X;process.exit()" })),
    };
    const result = planApply({ path: PATH, text: TEXT, config: odd }, REWORDED, {
      "X;process.exit()": URL,
    });
    expect(result).toMatchObject({ ok: false, issues: [{ path: "sources[0].database" }] });
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

describe("planApply with the project's spending settings (Settings)", () => {
  const changed = (plan: ApplyPlan) =>
    plan.diff.split("\n").filter((line) => /^[-+][^-+]/.test(line));

  function projectPlan(
    project: ProjectDraft,
    current: { readonly text: string; readonly config: ProjectConfig } = {
      text: TEXT,
      config: CONFIG,
    },
    env: Readonly<Record<string, string | undefined>> = ENV,
  ) {
    return planConfig({ path: PATH, ...current }, { project }, env);
  }

  it("writes the cap and onCapReached into the file and nothing else, with no warnings", () => {
    const result = projectPlan({ spendingCap: 2_000_000, onCapReached: "continue" });
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    expect(changed(result.plan)).toEqual([
      "+  spendingCap: 2000000,",
      '+  onCapReached: "continue",',
    ]);
    expect(result.plan.config).toMatchObject({ spendingCap: 2_000_000, onCapReached: "continue" });
    expect(result.plan.config.sources).toEqual(CONFIG.sources);
    expect(result.plan.warnings).toEqual([]);
  });

  it("removes the cap on null, and back to the default pause writes no onCapReached line", () => {
    const capped = { ...CONFIG, spendingCap: 5_000_000, onCapReached: "continue" as const };
    const result = projectPlan(
      { spendingCap: null, onCapReached: "pause" },
      { text: configFileSource(capped), config: capped },
    );
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    expect(changed(result.plan)).toEqual([
      "-  spendingCap: 5000000,",
      '-  onCapReached: "continue",',
    ]);
    expect(result.plan.config.spendingCap).toBeUndefined();
    expect(result.plan.after).toBe(TEXT);
  });

  it("keeps each source's variable pinned to the one the file names: the whole file is rendered again", () => {
    // A hand-written process.env file whose variable the loader guessed as DATABASE_URL (the
    // exporter now writes env(), so the replace is made on the exported text's env() line).
    const text = TEXT.replace(
      'database: env("DATABASE_URL")',
      "database: process.env.LISTINGS_URL",
    );
    expect(text).toContain("database: process.env.LISTINGS_URL,");
    const both = { DATABASE_URL: URL, LISTINGS_URL: URL };
    const result = projectPlan({ spendingCap: 1000 }, { text, config: CONFIG }, both);
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    expect(result.plan.after).toContain('database: env("LISTINGS_URL"),');
    // The pinned variable is kept under its name; the form becomes env(), as every Apply writes it.
    expect(changed(result.plan)).toEqual([
      "+  spendingCap: 1000,",
      "-      database: process.env.LISTINGS_URL,",
      '+      database: env("LISTINGS_URL"),',
    ]);
    // A source whose variable is unset here would be written as another one: refused as for a source draft.
    const unset = {
      ...DECLARED,
      sources: DECLARED.sources.map(({ database: _database, ...source }) => source),
    };
    expect(projectPlan({ spendingCap: 1000 }, { text: TEXT, config: unset }, {})).toMatchObject({
      ok: false,
      issues: [{ path: "sources[0].database" }],
    });
  });

  it("says a project draft that changes nothing changes nothing", () => {
    for (const project of [{}, { onCapReached: "pause" as const }, { spendingCap: null }]) {
      const result = projectPlan(project);
      if (!result.ok) {
        throw new Error(JSON.stringify(result.issues));
      }
      expect(result.plan.changed).toBe(false);
      expect(result.plan.diff).toBe("");
    }
  });

  it("refuses a cap the loader refuses, at its own path", () => {
    expect(projectPlan({ spendingCap: -5 })).toEqual({
      ok: false,
      issues: [{ path: "spendingCap", message: "spendingCap must be more than 0" }],
    });
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
    expect(refused).toMatchObject({
      kind: "uncommitted",
      state: git.kind,
      message: expect.stringContaining(words),
    });
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

  it("names every git state and its fix, and none for a committed file", () => {
    expect(uncommittedWords({ kind: "clean" }, PATH)).toBeUndefined();
    expect(uncommittedWords({ kind: "untracked" }, PATH)).toEqual({
      state: "untracked",
      message:
        "facetdb.config.ts has never been committed to git, so nothing could bring back what it holds now once Apply replaced it",
      fix: 'commit it first (git add facetdb.config.ts && git commit), or apply again with force ("force": true) to replace it',
    });
    expect(uncommittedWords({ kind: "no-repository" }, PATH)?.fix).toBe(
      'apply again with force ("force": true) to replace it, or put the project under git (git init, then git add facetdb.config.ts && git commit) so Apply can check',
    );
    // The studio words each state its own way: the state goes with the terminal's words.
    expect(uncommittedWords({ kind: "unreadable", reason: "fatal" }, PATH)?.state).toBe(
      "unreadable",
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
