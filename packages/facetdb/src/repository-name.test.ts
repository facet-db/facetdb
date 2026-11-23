import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SKILL_METHODS } from "./cli/commands/init.ts";
import { PUBLIC_REPOSITORY } from "./public-repository.ts";

/**
 * The public repository is `facet-db/facetdb` while the npm names stay `facetdb` and `@facetdb/*`.
 * These tests hold every place that names the repository to the one constant: the commands `facetdb
 * init` prints, the agent skill, and the `repository` field of every publishable package.json.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** The publishable packages: the workspace directory and the npm name it keeps. */
const PUBLISHABLE: readonly { readonly dir: string; readonly name: string }[] = [
  { dir: "packages/facetdb", name: "facetdb" },
  { dir: "packages/core", name: "@facetdb/core" },
  { dir: "packages/model", name: "@facetdb/model" },
  { dir: "packages/postgres", name: "@facetdb/postgres" },
  { dir: "packages/sql-polling", name: "@facetdb/sql-polling" },
  { dir: "packages/mysql", name: "@facetdb/mysql" },
  { dir: "packages/mssql", name: "@facetdb/mssql" },
  { dir: "packages/sqlite", name: "@facetdb/sqlite" },
  { dir: "packages/mongodb", name: "@facetdb/mongodb" },
  { dir: "packages/server", name: "@facetdb/server" },
  { dir: "apps/studio", name: "@facetdb/studio" },
  { dir: "plugins/email", name: "@facetdb/email" },
  { dir: "plugins/github", name: "@facetdb/github" },
  { dir: "plugins/packs", name: "@facetdb/packs" },
  { dir: "plugins/slack", name: "@facetdb/slack" },
  { dir: "plugins/telegram", name: "@facetdb/telegram" },
];

/** The workspace packages that are never published: the studio bundles the UI kit. */
const NEVER_PUBLISHED: readonly string[] = ["@facetdb/ui"];

const REPOSITORY_URL = `git+https://github.com/${PUBLIC_REPOSITORY}.git`;

/** The old name, the npm scope twice, built here so that this file does not hold it. */
const OLD_NAME = ["facetdb", "facetdb"].join("/");

/**
 * The old name as a repository, standing alone. A scoped package name such as
 * `@facetdb/facetdb-plugin-github` is not one, nor is the right name (`facet-db/facetdb`).
 */
const OLD_REPOSITORY = /(?<![@\w.-])facetdb\/facetdb(?![\w-])/;

type PackageJson = {
  readonly name?: unknown;
  readonly repository?: unknown;
};

async function packageJson(dir: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(root, dir, "package.json"), "utf8")) as PackageJson;
}

/** The workspace's package directories under one parent (`packages`, `plugins`), relative to the root. */
async function workspaceDirs(parent: string): Promise<string[]> {
  const entries = await readdir(join(root, parent), { withFileTypes: true });
  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dir = `${parent}/${entry.name}`;
    const files = await readdir(join(root, dir));
    if (files.includes("package.json")) {
      dirs.push(dir);
    }
  }
  return dirs;
}

/** Every file under a directory, `node_modules` and `dist` left out; none when the directory is absent. */
async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter((path) => !/[/\\](node_modules|dist)[/\\]/.test(path));
}

describe("the public repository's name", () => {
  it("is facet-db/facetdb", () => {
    expect(PUBLIC_REPOSITORY).toBe("facet-db/facetdb");
  });

  it("is in both skill-install commands facetdb init prints", () => {
    expect(SKILL_METHODS.plugin).toContain("claude plugin marketplace add facet-db/facetdb");
    expect(SKILL_METHODS.npx).toContain("npx skills add facet-db/facetdb --skill facetdb");
  });

  it("is in both commands of the agent skill", async () => {
    const skill = await readFile(join(root, "skills", "facetdb", "SKILL.md"), "utf8");
    expect(skill).toContain("claude plugin marketplace add facet-db/facetdb\n");
    expect(skill).toContain("npx skills add facet-db/facetdb --skill facetdb\n");
  });

  it.each(PUBLISHABLE)("is the repository of $name, at $dir", async ({ dir, name }) => {
    const json = await packageJson(dir);
    expect(json.name).toBe(name);
    expect(json.repository, `${dir}/package.json has no repository field`).toEqual({
      type: "git",
      url: REPOSITORY_URL,
      directory: dir,
    });
  });

  it("is checked for every package under packages/ and plugins/ but the private ones", async () => {
    const dirs = [...(await workspaceDirs("packages")), ...(await workspaceDirs("plugins"))];
    const listed = new Set(PUBLISHABLE.map((entry) => entry.dir));
    const unlisted: string[] = [];
    for (const dir of dirs) {
      const { name } = await packageJson(dir);
      if (!listed.has(dir) && !(typeof name === "string" && NEVER_PUBLISHED.includes(name))) {
        unlisted.push(dir);
      }
    }
    expect(unlisted, "a new package: add it to PUBLISHABLE or NEVER_PUBLISHED").toEqual([]);
  });

  it("is never written the old way in sources or the skills", async () => {
    const parents = ["packages", "plugins", "apps"];
    const files: string[] = [];
    for (const parent of parents) {
      for (const dir of await workspaceDirs(parent)) {
        files.push(...(await filesUnder(join(root, dir, "src"))));
      }
    }
    files.push(...(await filesUnder(join(root, "skills"))));
    expect(files.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      if (OLD_REPOSITORY.test(text)) {
        offenders.push(relative(root, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("tells the old name from a scoped package name and the right name", () => {
    expect(OLD_REPOSITORY.test(`npx skills add ${OLD_NAME} --skill facetdb`)).toBe(true);
    expect(OLD_REPOSITORY.test(`claude plugin marketplace add ${OLD_NAME}\n`)).toBe(true);
    expect(OLD_REPOSITORY.test(`git+https://github.com/${OLD_NAME}.git`)).toBe(true);
    expect(OLD_REPOSITORY.test("@facetdb/facetdb-plugin-github")).toBe(false);
    expect(OLD_REPOSITORY.test("facet-db/facetdb")).toBe(false);
  });
});
