import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../../config/index.ts";
import { runInProcess, type Workspace } from "../program.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb init` through the in-process runner, in a temporary project directory on the real disk:
 * the scaffold loads with the config loader, a Prisma or Drizzle schema recommends side-table mode
 * with a printed reason, Claude Code gets the skill offer with one install method, and `--dry-run`
 * writes nothing.
 */

const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
const DATABASE_URL = "postgres://facetdb_worker:s3cret-worker-password@db.example.com:5432/app";

let dir: string;
const scratch: string[] = [];
let originalDatabaseUrl: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "facetdb-init-"));
  scratch.push(dir);
  // What `pnpm add facetdb` would put in the project: the generated file imports "facetdb".
  await mkdir(join(dir, "node_modules"));
  await symlink(resolve(packageDir), join(dir, "node_modules", "facetdb"));
  originalDatabaseUrl = process.env["DATABASE_URL"];
  process.env["DATABASE_URL"] = DATABASE_URL;
});

afterEach(async () => {
  if (originalDatabaseUrl === undefined) {
    delete process.env["DATABASE_URL"];
  } else {
    process.env["DATABASE_URL"] = originalDatabaseUrl;
  }
  await Promise.all(scratch.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function workspaceOf(root: string, claudeOnPath: boolean): Workspace {
  return {
    exists: (path) =>
      readFile(join(root, path)).then(
        () => true,
        // A directory (`.claude`) cannot be read as a file, but it exists.
        (error: NodeJS.ErrnoException) => error.code === "EISDIR",
      ),
    write: async (path, text, { overwrite }) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text, { flag: overwrite ? "w" : "wx" });
    },
    hasClaudeCommand: () => claudeOnPath,
  };
}

function run(
  argv: readonly string[],
  options: {
    readonly answers?: readonly string[];
    readonly claudeOnPath?: boolean;
    readonly env?: Record<string, string | undefined>;
  } = {},
) {
  return runInProcess(
    argv,
    {
      projectDir: dir,
      env: options.env ?? {},
      loadConfig: async (path) =>
        (await loadConfig(path, { projectDir: dir, env: process.env, stderr: process.stderr }))
          .config,
      connect: () => {
        throw new Error("init opens no database connection");
      },
      workspace: workspaceOf(dir, options.claudeOnPath ?? false),
      ...(options.answers === undefined ? {} : { answers: options.answers }),
    },
    COMMANDS,
  );
}

const flags = ["init", "--database-url", DATABASE_URL, "--table", "support_messages"] as const;

const configFile = () => readFile(join(dir, "facetdb.config.ts"), "utf8");

describe("facetdb init", () => {
  it("writes a config that loads: one source, one example question, nothing secret", async () => {
    const result = await run(flags);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(
      "Created facetdb.config.ts for support_messages on db.example.com",
    );

    const file = await configFile();
    expect(file).toContain("database: process.env.DATABASE_URL");
    expect(file).not.toContain("s3cret");
    expect(file).not.toContain("db.example.com");
    expect(result.stdout + result.stderr).not.toContain("s3cret");

    const { config, warnings } = await loadConfig("facetdb.config.ts", {
      projectDir: dir,
      env: process.env,
      stderr: { write: () => true },
      quiet: true,
    });
    expect(warnings).toEqual([]);
    expect(config.model).toBe("jev-1.14.0");
    expect(config.sources).toHaveLength(1);
    const source = config.sources[0];
    expect(source?.name).toBe("support_messages");
    expect(source?.table).toBe("support_messages");
    expect(source?.storage).toBe("inline");
    expect(source?.questions.map((question) => question.name)).toEqual(["is_urgent"]);
  });

  it("asks for the connection string (hidden) and the table when no flag gives them", async () => {
    const result = await run(["init"], { answers: [DATABASE_URL, "app.Orders-2024"] });
    // The table name is judged before anything is written.
    expect(result.code).toBe(2);
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[0]).toContain("Database connection string");
    expect(result.prompts[1]).toContain("Which table");
    expect(result.stderr).toContain('"app.Orders-2024" is not a table name');
    expect(result.stderr).toContain("see: https://docs.facetdb.dev/fix/init-table");
    await expect(configFile()).rejects.toThrow();

    const second = await run(["init"], { answers: [DATABASE_URL, "app.support_messages"] });
    expect(second.code, second.stderr).toBe(0);
    expect(await configFile()).toContain('table: "app.support_messages"');
    expect(await configFile()).toContain('name: "support_messages"');
  });

  it("takes the connection string from DATABASE_URL when it is set, and does not ask", async () => {
    const result = await run(["init", "--table", "listings"], {
      env: { DATABASE_URL },
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
  });

  it("refuses something that is not a Postgres connection string, without echoing it", async () => {
    const result = await run([
      "init",
      "--database-url",
      "mysql://root:hunter2@host/db",
      "--table",
      "t",
    ]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("not a Postgres connection string");
    expect(result.stderr).not.toContain("hunter2");
    await expect(configFile()).rejects.toThrow();
  });

  it("does not replace a config that exists, unless told to", async () => {
    await writeFile(join(dir, "facetdb.config.ts"), "// my own edits\n");
    const refused = await run(flags);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("facetdb.config.ts already exists");
    expect(refused.stderr).toContain(
      "fix: edit facetdb.config.ts by hand, or run facetdb init --force",
    );
    expect(await configFile()).toBe("// my own edits\n");

    const forced = await run([...flags, "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(await configFile()).toContain("export default facetdb(");
  });

  it("refuses a config path outside the project", async () => {
    const result = await run([...flags, "--config", "../elsewhere.config.ts"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("outside the project directory");
  });

  it("--dry-run prints the file and writes nothing, and asks nothing about skills", async () => {
    await mkdir(join(dir, ".claude"));
    const result = await run([...flags, "--dry-run"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain("export default facetdb(");
    expect(result.stdout).toContain("dry run: nothing is written");
    await expect(configFile()).rejects.toThrow();
  });

  it("--json prints one document with the file and what was detected", async () => {
    const result = await run([...flags, "--json"]);
    expect(result.code, result.stderr).toBe(0);
    const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      ok: true,
      created: true,
      table: "support_messages",
      storage: "inline",
      claudeCode: false,
    });
    expect(parsed["file"]).toBe(await configFile());
  });
});

describe("facetdb init detects an ORM", () => {
  it("recommends side-table mode on a Prisma schema, saying why, and the file still loads", async () => {
    await mkdir(join(dir, "prisma"));
    await writeFile(join(dir, "prisma", "schema.prisma"), "model Message { id Int @id }\n");
    const result = await run(flags);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("Found Prisma (prisma/schema.prisma)");
    expect(result.stdout).toContain("chose side-table mode");
    expect(result.stdout).toContain("support_messages_with_answers");
    expect(await configFile()).toContain('storage: "side-table"');
    const { config } = await loadConfig("facetdb.config.ts", {
      projectDir: dir,
      env: process.env,
      stderr: { write: () => true },
      quiet: true,
    });
    expect(config.sources[0]?.storage).toBe("side-table");
  });

  it.each(["drizzle.config.ts", "drizzle.config.mjs"])(
    "recommends side-table mode on %s",
    async (name) => {
      await writeFile(join(dir, name), "export default {};\n");
      const result = await run(flags);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(`Found Drizzle (${name})`);
      expect(await configFile()).toContain('storage: "side-table"');
    },
  );

  it("keeps inline columns, and says nothing about an ORM, when there is none", async () => {
    const result = await run(flags);
    expect(result.stdout).not.toContain("side-table mode");
    expect(await configFile()).toContain('storage: "inline"');
  });

  it("names the ORM in --json", async () => {
    await mkdir(join(dir, "prisma"));
    await writeFile(join(dir, "prisma", "schema.prisma"), "");
    const parsed = JSON.parse((await run([...flags, "--json"])).stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({ orm: "Prisma", storage: "side-table" });
    expect(String(parsed["reason"])).toContain("Prisma");
  });
});

describe("facetdb init offers the agent skills", () => {
  it("says nothing about skills when Claude Code is not there", async () => {
    const result = await run(flags);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).not.toContain("claude plugin");
    expect(result.stdout).not.toContain("skills add");
  });

  it("detects a .claude directory, prints both skills' commands and asks for one method", async () => {
    await mkdir(join(dir, ".claude"));
    const result = await run(flags, { answers: ["plugin"] });
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual(["Which one install method? Type plugin, npx or none: "]);
    // The offer: TypeSafe's two commands and FacetDB's, and the npx alternative.
    expect(result.stdout).toContain("claude plugin marketplace add typesafe-ai/skills");
    expect(result.stdout).toContain("claude plugin install typesafe@typesafe-ai");
    expect(result.stdout).toContain("claude plugin install facetdb@facetdb");
    expect(result.stdout).toContain("npx skills add typesafe-ai/skills --skill typesafe-ai");
    expect(result.stdout).toContain("npx skills add facetdb/facetdb --skill facetdb");
    expect(result.stdout).toContain("TypeSafe asks for one install method per project");
    // After the answer, only the chosen method is repeated, as the thing to run.
    const chosen = result.stdout.slice(result.stdout.indexOf("Install the skills with the plugin"));
    expect(chosen).toContain("claude plugin install facetdb@facetdb");
    expect(chosen).not.toContain("npx skills add");
    expect(chosen).toContain("runs none of them");
  });

  it("detects the claude command on the PATH", async () => {
    const result = await run(flags, { answers: ["npx"], claudeOnPath: true });
    expect(result.code, result.stderr).toBe(0);
    const chosen = result.stdout.slice(result.stdout.indexOf("Install the skills with the npx"));
    expect(chosen).toContain("npx skills add facetdb/facetdb --skill facetdb");
    expect(chosen).not.toContain("claude plugin");
  });

  it("installs nothing when the answer is none", async () => {
    await mkdir(join(dir, ".claude"));
    const result = await run(flags, { answers: ["none"] });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Install the skills with");
  });

  it("does not ask when --skills gives the method", async () => {
    await mkdir(join(dir, ".claude"));
    const result = await run([...flags, "--skills", "npx"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain("Install the skills with the npx method");
  });

  it("refuses a method that is not one of the three", async () => {
    await mkdir(join(dir, ".claude"));
    const flagged = await run([...flags, "--skills", "both"]);
    expect(flagged.code).toBe(2);
    expect(flagged.stderr).toContain("pass --skills plugin, --skills npx or --skills none");
    expect((await run(flags, { answers: ["both"] })).code).toBe(2);
  });
});
