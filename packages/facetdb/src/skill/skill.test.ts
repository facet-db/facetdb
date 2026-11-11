import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RECORD_STATUSES } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { COMMANDS } from "../cli/commands/index.ts";
import { SKILL_METHODS } from "../cli/commands/init.ts";

/**
 * The product's agent skill lives at the repository root, in the format of the TypeSafe skill.
 * These tests hold its structure to the code: its commands are the CLI's, its statuses are core's,
 * and it never names an alias as a model.
 */

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..", "..");
const skillPath = join(root, "skills", "facetdb", "SKILL.md");

const text = await readFile(skillPath, "utf8");

/** The frontmatter as `key: value` pairs; a `>` value is folded from its indented lines. */
function frontmatter(source: string): Record<string, string> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(source);
  if (match === null) {
    throw new Error("the skill has no frontmatter between --- lines");
  }
  const fields: Record<string, string> = {};
  let current: string | undefined;
  for (const line of (match[1] ?? "").split("\n")) {
    const field = /^([a-z][a-z-]*):\s*(>|.*)$/.exec(line);
    if (field !== null && !line.startsWith(" ")) {
      current = field[1] ?? "";
      fields[current] = field[2] === ">" ? "" : (field[2] ?? "");
    } else if (current !== undefined) {
      fields[current] = `${fields[current] ?? ""} ${line.trim()}`.trim();
    }
  }
  return fields;
}

/** The first cell of every row of the table under "## Commands", without the backticks. */
function commandTable(source: string): string[] {
  const section = /^## Commands\n([\s\S]*?)(?=^## )/m.exec(source)?.[1];
  if (section === undefined) {
    throw new Error("the skill has no ## Commands section");
  }
  return section
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .slice(2)
    .map((row) => (row.split("|")[1] ?? "").trim().replaceAll("`", ""));
}

describe("the FacetDB agent skill", () => {
  it("has frontmatter with a name, a license and a description under 1024 characters", () => {
    const fields = frontmatter(text);
    expect(fields["name"]).toBe("facetdb");
    expect(fields["license"]).toBe("MIT");
    const description = fields["description"] ?? "";
    expect(description.length).toBeGreaterThan(0);
    expect(description.length).toBeLessThan(1024);
  });

  it("ships its MIT license beside it", async () => {
    const license = await readFile(join(root, "skills", "facetdb", "LICENSE"), "utf8");
    expect(license.startsWith("MIT License")).toBe(true);
  });

  it("lists every registered command in its table and no command that is not registered", () => {
    const rows = commandTable(text);
    const registered = COMMANDS.map((command) => `facetdb ${command.name}`);
    const named = rows.map((row) => row.split(" ").slice(0, 2).join(" "));
    expect([...named].sort()).toEqual([...registered].sort());
  });

  it("mentions every record status of core", () => {
    for (const status of RECORD_STATUSES) {
      expect(text, status).toContain(`\`${status}\``);
    }
  });

  it("never names an alias as a model", () => {
    expect(text).not.toContain("jev-latest");
    expect(text).toContain("jev-1.14.0");
  });

  it("teaches the install commands `facetdb init` prints", () => {
    for (const command of [...SKILL_METHODS.plugin, ...SKILL_METHODS.npx]) {
      if (command.includes("facetdb")) {
        expect(text, command).toContain(command);
      }
    }
  });

  it("sends the reader to the schemas and to the TypeSafe skill for question wording", () => {
    expect(text).toContain("`facetdb/schema`");
    expect(text).toContain("typesafe-ai");
  });
});

describe("the plugin manifests", () => {
  it("name the facetdb plugin and the marketplace that lists it", async () => {
    const plugin = JSON.parse(
      await readFile(join(root, ".claude-plugin", "plugin.json"), "utf8"),
    ) as { name: string; license: string };
    const marketplace = JSON.parse(
      await readFile(join(root, ".claude-plugin", "marketplace.json"), "utf8"),
    ) as { name: string; plugins: { name: string; source: string }[] };
    expect(plugin.name).toBe("facetdb");
    expect(plugin.license).toBe("MIT");
    expect(marketplace.name).toBe("facetdb");
    expect(marketplace.plugins.map((entry) => entry.name)).toEqual(["facetdb"]);
  });
});
