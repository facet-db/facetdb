import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { judgeDraftSource } from "./draft.ts";
import { ConfigError, choice, facetdb, loadConfig, noul } from "./index.ts";

/**
 * A choice question's `storeProbabilities: true` on a source with no table: an API source and a
 * plugin source have no `_probabilities` column, so the option is refused at the question, with
 * where the probabilities are read instead and the fix. A table source keeps it on every engine and
 * connector, side-table mode included. The main path is a config file written as users write it, a
 * table source's `database: env("...")` included, through `loadConfig`; the studio's draft meets
 * the same rule through `judgeDraftSource`, the door Apply and `POST /v1/config/validate` share.
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const ENV = { LISTINGS_URL: "postgres://app:s3cret@db.example.com:5432/shop" };

/** The `sources` entries as the config file writes them; `KIND(...)` is the choice question. */
async function loadIssues(
  sources: string,
  env: Readonly<Record<string, string>> = ENV,
): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), "facetdb-store-probabilities-"));
  scratch.push(dir);
  await mkdir(join(dir, "node_modules"));
  await symlink(packageDir, join(dir, "node_modules", "facetdb"));
  await writeFile(
    join(dir, "facetdb.config.ts"),
    `import { choice, env, facetdb, noul, sourceCall } from "facetdb";

const KIND = (storeProbabilities: boolean) =>
  choice("What kind of listing is it?", { car: "A vehicle", home: "A house or a flat" }, { storeProbabilities });

export default facetdb({
  model: "jev-1.14.0",
  sources: [${sources}],
});
`,
  );
  try {
    await loadConfig("facetdb.config.ts", {
      projectDir: dir,
      env,
      stderr: { write: () => true },
      quiet: true,
    });
  } catch (error) {
    if (error instanceof ConfigError) {
      return error.issues.map((issue) => `${issue.path}: ${issue.message}`);
    }
    throw error;
  }
  return [];
}

const table = (fields: string, stored = true) =>
  `{ name: "listings", database: env("LISTINGS_URL"), table: "listings", ${fields} read: ["title"], questions: { is_scam: noul("Is this listing a scam?"), kind: KIND(${stored}) } }`;
const api = (stored = true) =>
  `{ name: "checks", api: true, read: ["title"], questions: { kind: KIND(${stored}) } }`;
const plugin = (stored = true) =>
  `{ name: "issues", source: sourceCall("@facetdb/github", "issues", { repo: "acme/web" }), read: ["title"], questions: { kind: KIND(${stored}) } }`;

const refusal = (at: string, kind: string) =>
  `${at}.questions.kind.storeProbabilities: ${kind} has no table, so no column to store the probabilities in; FacetDB's decision log keeps every option's probability, returned by GET /v1/decisions; remove storeProbabilities`;

describe("storeProbabilities on a source with no table", () => {
  it("refuses it on an API source, at the question, with where the probabilities are and the fix", async () => {
    expect(await loadIssues(api())).toEqual([refusal("sources[0]", "an API source")]);
  });

  it("refuses it on a plugin source, at the question, with where the probabilities are and the fix", async () => {
    expect(await loadIssues(plugin())).toEqual([refusal("sources[0]", "a plugin source")]);
  });

  it("refuses only the question of the source with no table in a project that has both", async () => {
    expect(await loadIssues(`${table("")}, ${api()}`)).toEqual([
      refusal("sources[1]", "an API source"),
    ]);
    expect(await loadIssues(`${plugin()}, ${table("")}`)).toEqual([
      refusal("sources[0]", "a plugin source"),
    ]);
  });

  it("names every question that sets it, and none that does not", async () => {
    const issues = await loadIssues(
      `{ name: "checks", api: true, read: ["title"], questions: { kind: KIND(true), size: KIND(false), shape: KIND(true) } }`,
    );
    expect(issues.map((issue) => issue.split(":")[0])).toEqual([
      "sources[0].questions.kind.storeProbabilities",
      "sources[0].questions.shape.storeProbabilities",
    ]);
  });

  it("loads it on a table source on every engine and connector, and in side-table mode", async () => {
    const urls = [
      "postgres://app:s3cret@db.example.com:5432/shop",
      "mysql://app:s3cret@db.example.com:3306/shop",
      "sqlserver://app:s3cret@db.example.com:1433/shop",
      "sqlite:///srv/app/shop.db",
      "mongodb://app:s3cret@db.example.com:27017/shop?replicaSet=rs0",
      "oracle://app:s3cret@db.example.com:2484/shop",
    ];
    for (const url of urls) {
      expect(await loadIssues(table(""), { LISTINGS_URL: url }), url).toEqual([]);
    }
    expect(await loadIssues(table('connector: "polling",'))).toEqual([]);
    expect(await loadIssues(table('storage: "side-table",'))).toEqual([]);
  });

  it("loads storeProbabilities: false on every kind of source", async () => {
    expect(await loadIssues(`${table("", false)}, ${api(false)}, ${plugin(false)}`)).toEqual([]);
    expect(await loadIssues(table('connector: "polling",', false))).toEqual([]);
  });
});

describe("a studio draft that adds storeProbabilities", () => {
  const config = facetdb({
    model: "jev-1.14.0",
    sources: [
      {
        name: "checks",
        api: true,
        read: ["title"],
        questions: { is_scam: noul("Is this listing a scam?") },
      },
    ],
  });
  const kind = (storeProbabilities: boolean) => ({
    kind: choice(
      "What kind of listing is it?",
      { car: "A vehicle", home: "A house or a flat" },
      { storeProbabilities },
    ),
  });

  it("is refused on an API source in the same words as the file", () => {
    const judged = judgeDraftSource(config, { name: "checks", questions: kind(true) }, {});
    expect(
      judged.ok ? [] : judged.issues.map((issue) => `${issue.path}: ${issue.message}`),
    ).toEqual([refusal("sources[0]", "an API source")]);
  });

  it("is judged ok without it", () => {
    expect(judgeDraftSource(config, { name: "checks", questions: kind(false) }, {}).ok).toBe(true);
  });
});
