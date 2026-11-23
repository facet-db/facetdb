import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { ConfigError, loadConfig } from "../config/index.ts";
import { DATABASES } from "./engines.ts";

/**
 * The loader's refusal of `lastChanged` and the engine table agree: on every scheme of every
 * database FacetDB connects to, a config file whose source reads `env("LISTINGS_URL")` loads with
 * `lastChanged` exactly when the engine the scheme picks polls, so a polling engine added to the
 * table with a scheme the loader does not know fails here; and a database that does not poll is
 * named by its scheme in the refusal, so one added to the table without the loader's words fails
 * too.
 */

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const scratch: string[] = [];

afterAll(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(lastChanged: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facetdb-engines-last-changed-"));
  scratch.push(dir);
  await mkdir(join(dir, "node_modules"));
  await symlink(packageDir, join(dir, "node_modules", "facetdb"));
  await writeFile(
    join(dir, "facetdb.config.ts"),
    `import { env, facetdb, noul } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
  sources: [
    {
      name: "listings",
      database: env("LISTINGS_URL"),
      table: "listings",
      lastChanged: ${lastChanged},
      read: ["title"],
      questions: { is_scam: noul("Is this listing a scam?") },
    },
  ],
});
`,
  );
  return dir;
}

async function issuesFor(dir: string, url: string): Promise<string[]> {
  try {
    await loadConfig("facetdb.config.ts", {
      projectDir: dir,
      env: { LISTINGS_URL: url },
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

describe("lastChanged and the engine table", () => {
  it("loads on a scheme exactly when its engine polls, and names the scheme where it does not", async () => {
    const schemes = DATABASES.flatMap((database) =>
      database.schemes.map((scheme) => ({ scheme, polls: database.polls })),
    );
    expect(schemes.filter(({ polls }) => polls).map(({ scheme }) => scheme)).toEqual([
      "cockroachdb",
      "oracle",
    ]);
    const column = await project('"changed_on"');
    const hourly = await project("false");
    for (const { scheme, polls } of schemes) {
      const issues = await issuesFor(column, `${scheme}://app@db.example.com/shop`);
      if (polls) {
        expect(issues, scheme).toEqual([]);
      } else {
        expect(issues, scheme).toHaveLength(1);
        expect(issues[0], scheme).toContain(`FacetDB watches this ${scheme}: database by its`);
      }
      // In capitals too, as the loader reads a scheme.
      const upper = scheme.toUpperCase();
      const shouting = await issuesFor(hourly, `${upper}://app@db.example.com/shop`);
      expect(shouting.length === 0, upper).toBe(polls);
    }
  });
});
