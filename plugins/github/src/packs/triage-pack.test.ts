import { readFile } from "node:fs/promises";
import { env, facetdb, judgeDraftSource, noul, VERSION, wordingWarnings } from "facetdb";
import { loadPlugin, type PackDefinition } from "facetdb/plugin";
import { describe, expect, it } from "vitest";
import { github, triage } from "../index.ts";
import { type ChangedFiles, stateOf } from "../issues-state.ts";
import { managedLabels } from "../managed-labels.ts";

/**
 * The GitHub issue triage pack: it parses through the SDK's own checks applied to the GitHub
 * source, its wording meets the loader's wording check with no warning, its option names describe
 * content, it reads the four fields the issues source returns, its sample holds 50 complete
 * labelled records each in the state the source writes, and the plugin loads with the pack. Nothing
 * here calls a model: the live run is separate.
 */

const QUESTIONS = ["kind", "missing_reproduction", "not_priority"] as const;
const FIELDS = ["title", "body", "labels", "changed_files"] as const;
const KINDS = [
  "bug_report",
  "feature_request",
  "usage_question",
  "documentation_problem",
  "something_else",
] as const;
const YES_NO = ["yes", "no", "unsure"] as const;
const ANSWERS: Readonly<Record<(typeof QUESTIONS)[number], readonly string[]>> = {
  kind: [...KINDS, "unsure"],
  missing_reproduction: YES_NO,
  not_priority: YES_NO,
};
const LOW_STAKES = { yesAbove: 0.7, noBelow: 0.3 } as const;

type Issue = {
  readonly id: string;
  readonly title: string;
  readonly body: string | null;
  readonly labels: string;
  readonly changed_files: string;
  readonly expected: Readonly<Record<string, string>>;
};
/** The marketplace sample's layout: a flat list of answers; kind's options are read from the pack. */
type Sample = {
  readonly pack: string;
  readonly fields: readonly string[];
  readonly answers: readonly string[];
  readonly about: string;
  readonly records: readonly Issue[];
};

/** The fewest records per answer that the sample is held to, per question. */
const AT_LEAST: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  kind: { ...Object.fromEntries(KINDS.map((kind) => [kind, 6])), unsure: 5 },
  missing_reproduction: { yes: 7, no: 20, unsure: 5 },
  not_priority: { yes: 7, no: 20, unsure: 5 },
};

/** The same for missing_reproduction on the bug reports alone, where its answer is a judgment. */
const BUG_REPORTS_AT_LEAST: Readonly<Record<string, number>> = { yes: 5, no: 5, unsure: 3 };

/** Option names that say where an option sits, not what it holds (the `typesafe-ai` skill, Criteria). */
const POSITIONAL =
  /^(?:[a-z]|\d+|(?:option|choice|answer)_?\d+|first|second|third|fourth|fifth|last|left|right|top|bottom|middle)$/;

/** The names in backticks in a text: the state fields a question or a description refers to. */
function contentNames(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

/** Every run of `size` consecutive words of a text, lowercased: the phrases two texts could share. */
function wordRuns(text: string, size: number): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
  return words
    .slice(0, Math.max(0, words.length - size + 1))
    .map((_, index) => words.slice(index, index + size).join(" "));
}

/** The words a question is sent with: its instructions and every criterion or option description. */
function textsOf(question: PackDefinition["questions"][number]): string[] {
  switch (question.type) {
    case "noul":
      return [question.instructions, question.criteria?.true ?? "", question.criteria?.false ?? ""];
    case "choice":
      return [question.instructions, ...question.options.map((option) => option.description)];
    case "score":
      throw new Error(`the triage pack asks no score question; ${question.name} is one`);
  }
}

function questionOf(name: string): PackDefinition["questions"][number] {
  const question = triage.questions.find((candidate) => candidate.name === name);
  if (question === undefined) {
    throw new Error(`the triage pack has no question ${name}`);
  }
  return question;
}

/** The pack applied as the studio's "Start from a pack" applies it: a draft over the GitHub source. */
function applied(pack: PackDefinition) {
  const config = facetdb({
    model: "jev-1.14.0",
    plugins: { github: { token: env("GITHUB_TOKEN") } },
    source: github.issues({ repo: "your-org/your-repo", include: ["issues", "pull_requests"] }),
    read: [...FIELDS],
    questions: { placeholder: noul("Is this an issue?") },
  });
  const questions = Object.fromEntries(
    pack.questions.map(({ name, ...question }) => [name, question]),
  );
  return judgeDraftSource(config, { name: "issues", questions, thresholds: pack.thresholds }, {});
}

/** `pack` with the not_priority question asked in other words. */
function reworded(instructions: string): PackDefinition {
  return {
    ...triage,
    questions: triage.questions.map((question) =>
      question.name === "not_priority" ? { ...question, instructions } : question,
    ),
  };
}

/** Imports `@facetdb/github` as the given module; any other package is not installed. */
function importing(installed: unknown) {
  return async (specifier: string): Promise<unknown> => {
    if (specifier === "@facetdb/github") {
      return installed;
    }
    throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
      code: "ERR_MODULE_NOT_FOUND",
    });
  };
}

async function sample(): Promise<Sample> {
  return JSON.parse(
    await readFile(new URL("./triage.sample.json", import.meta.url), "utf8"),
  ) as Sample;
}

/** Why a record is not a complete labelled record of the pack's sample: none when it is. */
function problemsOf(issue: Issue): string[] {
  const problems: string[] = [];
  const keys = Object.keys(issue).sort();
  const wanted = ["body", "changed_files", "expected", "id", "labels", "title"];
  if (keys.join() !== wanted.join()) {
    problems.push(`${issue.id}: holds ${keys.join(", ")}, not ${wanted.join(", ")}`);
  }
  if (typeof issue.title !== "string" || issue.title.trim() === "") {
    problems.push(`${issue.id}: no title`);
  }
  if (issue.body !== null && typeof issue.body !== "string") {
    problems.push(`${issue.id}: a body that is neither text nor null`);
  }
  if (typeof issue.labels !== "string" || typeof issue.changed_files !== "string") {
    problems.push(`${issue.id}: labels and changed_files must be text`);
  }
  for (const question of QUESTIONS) {
    const answer = issue.expected[question];
    if (answer === undefined) {
      problems.push(`${issue.id}: no expected answer to ${question}`);
    } else if (!ANSWERS[question].includes(answer)) {
      problems.push(
        `${issue.id}: ${question} is "${answer}", not one of ${ANSWERS[question].join(", ")}`,
      );
    }
  }
  const extra = Object.keys(issue.expected).filter(
    (name) => !(QUESTIONS as readonly string[]).includes(name),
  );
  if (extra.length > 0) {
    problems.push(`${issue.id}: answers to questions the pack does not ask: ${extra.join(", ")}`);
  }
  return problems;
}

/** A pull request's changed files as its `changed_files` text holds them; undefined for an issue. */
function filesOf(changedFiles: string): ChangedFiles | undefined {
  if (changedFiles === "") {
    return undefined;
  }
  const [head = "", ...paths] = changedFiles.split("\n");
  const total = /^(\d+) files? changed/.exec(head)?.[1];
  if (total === undefined) {
    throw new Error(`changed_files starts with "${head}", not the number of changed files`);
  }
  return { paths, total: Number(total) };
}

describe("the triage pack's questions", () => {
  it("are a choice and two yes-or-no questions, and parse as the GitHub source's questions with no wording warning", () => {
    expect(triage.questions.map((question) => [question.name, question.type])).toEqual([
      ["kind", "choice"],
      ["missing_reproduction", "noul"],
      ["not_priority", "noul"],
    ]);
    const judged = applied(triage);
    if (!judged.ok) {
      throw new Error(
        `the pack does not parse as a source's questions: ${JSON.stringify(judged.issues)}`,
      );
    }
    expect(judged.questionSet.questions.map((question) => question.name)).toEqual([...QUESTIONS]);
    expect(judged.questionSet.read).toEqual([...FIELDS]);
    // The real check the loader and the studio run, never a copy of its rules.
    expect(judged.warnings).toEqual([]);
    expect(wordingWarnings(judged.questionSet, 0)).toEqual([]);
  });

  it("would be warned on by that same check had one of them a count, a date comparison or a double negative", () => {
    // The check above is live: the same path flags each kind of wording the pack avoids.
    const cases = [
      ["How many files does the pull request in `changed_files` change?", "counting"],
      ["Was the issue in `title` opened more than a week before the release?", "date-comparison"],
      ["Is it not true that the issue in `body` has no steps?", "double-negative"],
    ] as const;
    for (const [instructions, code] of cases) {
      const judged = applied(reworded(instructions));
      expect(judged.ok && judged.warnings.map((warning) => warning.code), code).toEqual([code]);
    }
  });

  it("are low stakes, and only not_priority sets thresholds of its own, the worked example's, stricter than the defaults", () => {
    expect(
      Object.fromEntries(triage.questions.map((question) => [question.name, question.stakes])),
    ).toEqual({ kind: "low", missing_reproduction: "low", not_priority: "low" });
    // kind decides at confidence 0.50 and missing_reproduction at 0.70 and 0.30: the low-stakes
    // defaults, which a project sees as they are. not_priority keeps the worked example's 0.8 and
    // 0.2.
    expect(triage.thresholds).toEqual({ not_priority: { yesAbove: 0.8, noBelow: 0.2 } });
    const own = triage.thresholds["not_priority"] ?? {};
    expect(own.yesAbove ?? LOW_STAKES.yesAbove).toBeGreaterThanOrEqual(LOW_STAKES.yesAbove);
    expect(own.noBelow ?? LOW_STAKES.noBelow).toBeLessThanOrEqual(LOW_STAKES.noBelow);
    const judged = applied(triage);
    expect(judged.ok && judged.questionSet.thresholds).toEqual(triage.thresholds);
  });

  it("name every option of kind by its content, never by its place", () => {
    const kind = questionOf("kind");
    if (kind.type !== "choice") {
      throw new Error("kind is a choice question");
    }
    expect(kind.options.map((option) => option.name)).toEqual([...KINDS]);
    for (const option of kind.options) {
      expect(option.name, option.name).not.toMatch(POSITIONAL);
      // The name is the kind its own description describes, word for word.
      const words = option.description.toLowerCase().match(/[a-z]+/g) ?? [];
      for (const part of option.name.split("_")) {
        expect(words, `${option.name}: ${part}`).toContain(part);
      }
    }
    // Wording two options share pulls probability between them: no run of three words with a
    // content word in it ("works as designed") appears in two descriptions.
    const runsOf = (text: string) =>
      new Set(wordRuns(text, 3).filter((run) => run.split(" ").some((word) => word.length >= 5)));
    kind.options.forEach((option, index) => {
      for (const other of kind.options.slice(index + 1)) {
        const theirs = runsOf(other.description);
        const shared = [...runsOf(option.description)].filter((run) => theirs.has(run));
        expect(shared, `${option.name} and ${other.name}`).toEqual([]);
      }
    });
  });

  it("read the four fields the issues source returns, as the description says", () => {
    const description = triage.description ?? "";
    expect([...new Set(contentNames(description))]).toEqual([...FIELDS]);
    expect(triage.reads).toEqual([...FIELDS]);
    expect(description).toContain("low stakes");
    expect(description).toContain("nothing irreversible");
    const named = new Set<string>();
    for (const question of triage.questions) {
      const names = contentNames(textsOf(question).join("\n"));
      expect(names.length, question.name).toBeGreaterThan(0);
      for (const name of names) {
        expect(FIELDS, `${question.name} names ${name}`).toContain(name);
        named.add(name);
      }
    }
    expect([...named].sort()).toEqual([...FIELDS].sort());
  });
});

describe("the triage pack's sample", () => {
  it("holds 50 complete records, each with an allowed answer to every question and its own id", async () => {
    const { pack, fields, answers, records: issues } = await sample();
    expect(pack).toBe("triage");
    expect(fields).toEqual([...FIELDS]);
    expect(answers).toEqual([...YES_NO]);
    expect(issues).toHaveLength(50);
    expect(new Set(issues.map((issue) => issue.id)).size).toBe(50);
    expect(issues.flatMap(problemsOf)).toEqual([]);
  });

  it("fails a record that lacks an expected answer, or carries one the question does not take", async () => {
    const [first] = (await sample()).records;
    if (first === undefined) {
      throw new Error("the sample is empty");
    }
    const { not_priority: _left, ...rest } = first.expected;
    expect(problemsOf({ ...first, expected: rest })).toEqual([
      `${first.id}: no expected answer to not_priority`,
    ]);
    const wrong = { ...first, expected: { ...first.expected, kind: "maybe" } };
    expect(problemsOf(wrong)).toEqual([
      `${first.id}: kind is "maybe", not one of ${ANSWERS.kind.join(", ")}`,
    ]);
  });

  it("holds each record as the state the issues source writes, issues and pull requests both", async () => {
    const { records: issues } = await sample();
    for (const issue of issues) {
      const files = filesOf(issue.changed_files);
      const state = stateOf(
        {
          number: 1,
          title: issue.title,
          body: issue.body,
          labels: issue.labels === "" ? [] : issue.labels.split("\n"),
          ...(files === undefined ? {} : { pull_request: {} }),
        },
        files,
        // The labels the worked example's label actions manage: none is in the sample.
        managedLabels([
          {
            action: "label",
            config: { add: ["Not Priority", "Impacts only OSS", "needs-triage"] },
          },
        ]),
      );
      expect(state, issue.id).toEqual({
        title: issue.title,
        body: issue.body,
        labels: issue.labels,
        changed_files: issue.changed_files,
      });
    }
    const pulls = issues.filter((issue) => issue.changed_files !== "");
    expect(pulls.length).toBeGreaterThanOrEqual(5);
    expect(issues.some((issue) => issue.body === null)).toBe(true);
    expect(issues.some((issue) => issue.labels.includes("\n"))).toBe(true);
  });

  it("spreads every question over each of its answers, and missing_reproduction over the bug reports alone", async () => {
    const { records: issues, about } = await sample();
    for (const question of QUESTIONS) {
      for (const [answer, least] of Object.entries(AT_LEAST[question] ?? {})) {
        const count = issues.filter((issue) => issue.expected[question] === answer).length;
        expect(count, `${question}: ${answer}`).toBeGreaterThanOrEqual(least);
      }
    }
    // Most of missing_reproduction's no answers are records that report no bug, so the live run
    // reports its agreement on the bug reports apart, and the sample spreads those too.
    const bugs = issues
      .filter((issue) => issue.expected["kind"] === "bug_report")
      .map((issue) => issue.expected["missing_reproduction"]);
    for (const [answer, least] of Object.entries(BUG_REPORTS_AT_LEAST)) {
      const count = bugs.filter((expected) => expected === answer).length;
      expect(count, `bug reports, missing_reproduction: ${answer}`).toBeGreaterThanOrEqual(least);
    }
    expect(about).toContain("the records labelled bug_report apart from the whole");
  });

  it("labels each record as the criteria read: no missing reproduction without a bug, no low priority on a security or regression label", async () => {
    const { records: issues } = await sample();
    for (const issue of issues) {
      const kind = issue.expected["kind"];
      if (issue.changed_files !== "" || (kind !== "bug_report" && kind !== "unsure")) {
        expect(issue.expected["missing_reproduction"], issue.id).toBe("no");
      }
      const labels = issue.labels.split("\n");
      if (labels.includes("security") || labels.includes("regression")) {
        expect(issue.expected["not_priority"], issue.id).toBe("no");
      }
    }
    // A template's label is not the kind: a usage question filed as a bug, a bug filed as an enhancement.
    expect(
      issues.some((issue) => issue.labels === "bug" && issue.expected["kind"] === "usage_question"),
    ).toBe(true);
    expect(
      issues.some(
        (issue) => issue.labels === "enhancement" && issue.expected["kind"] === "bug_report",
      ),
    ).toBe(true);
  });

  it("shares no quoted phrase and no run of four words with any question's wording", async () => {
    // Criteria that repeat the sample's own hard cases would test the sample against itself.
    const { records: issues } = await sample();
    const wording = triage.questions.flatMap(textsOf);
    const quoted = wording.flatMap((text) =>
      [...text.matchAll(/(?:^|[\s(])['"‘“]([^'"’”]+)['"’”](?=[\s.,;:)]|$)/g)].map((m) =>
        (m[1] ?? "").toLowerCase(),
      ),
    );
    const runs = new Set(wording.flatMap((text) => wordRuns(text, 4)));
    for (const issue of issues) {
      const text = [issue.title, issue.body ?? "", issue.labels, issue.changed_files].join("\n");
      for (const phrase of quoted) {
        expect(text.toLowerCase(), `${issue.id} repeats "${phrase}"`).not.toContain(phrase);
      }
      const shared = wordRuns(text, 4).filter((run) => runs.has(run));
      expect(shared, issue.id).toEqual([]);
    }
  });

  it("holds only invented text: no address, no link and no handle", async () => {
    const { records: issues } = await sample();
    const text = issues
      .map((issue) => [issue.title, issue.body ?? "", issue.labels, issue.changed_files].join("\n"))
      .join("\n");
    expect(text).not.toMatch(/https?:|www\./i);
    // An @ starts a handle or an email address, which a written sample has no use for.
    expect(text).not.toMatch(/@/);
  });
});

describe("the GitHub plugin with the pack", () => {
  it("passes loadPlugin's checks with triage as its pack, and matches its registry entry", async () => {
    const loaded = await loadPlugin("github", {
      coreVersion: VERSION,
      importModule: importing(await import("../index.ts")),
    });
    expect(loaded.manifest.kinds).toEqual(["source", "action", "pack"]);
    expect(Object.keys(loaded.packs)).toEqual(["triage"]);
    expect(loaded.packs["triage"]).toBe(triage);
    const entry = JSON.parse(
      await readFile(new URL("../../../../registry/plugins/github.json", import.meta.url), "utf8"),
    ) as { name: string; package: string; kinds: string[] };
    expect(entry.name).toBe(loaded.manifest.name);
    expect(entry.package).toBe("@facetdb/github");
    expect(entry.kinds).toEqual(loaded.manifest.kinds);
  });
});
