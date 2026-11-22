import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, type ProjectConfig } from "../../config/index.ts";
import { diskExamples } from "../examples.ts";
import { runInProcess, type Workspace } from "../program.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb init --example github-triage`: the GitHub triage, an example with no engine variant,
 * through the in-process runner in a temporary project on the real disk. It writes the example's
 * config and its steps (facetdb-github-triage.md, never a README.md: the example runs inside a
 * repository that has its own) as the package ships them, and names the two plugins to add; the
 * config loads once the project holds packages named @facetdb/github and @facetdb/slack (here
 * fixtures that build the same calls through facetdb's own helpers, since this package cannot
 * depend on its plugins); its dry run lists the files and writes nothing; a file already there is
 * named in the refusal, every one of them, before --force may replace it.
 */

const packageDir = fileURLToPath(new URL("../../../", import.meta.url));
const EXAMPLE_DIR = join(packageDir, "examples", "github-triage");
const REPO = "your-org/your-repo";
const STEPS = "facetdb-github-triage.md";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "facetdb-init-triage-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function workspaceOf(root: string): Workspace {
  return {
    exists: (path) =>
      readFile(join(root, path)).then(
        () => true,
        (error: NodeJS.ErrnoException) => error.code === "EISDIR",
      ),
    write: async (path, text, { overwrite }) => {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), text, { flag: overwrite ? "w" : "wx" });
    },
    writeParts: () => Promise.reject(new Error("init writes no file in parts")),
    peek: () => Promise.reject(new Error("init reads no file")),
    lines: () => {
      throw new Error("init reads no file");
    },
    hasClaudeCommand: () => false,
  };
}

function run(argv: readonly string[]) {
  return runInProcess(
    argv,
    {
      projectDir: dir,
      env: {},
      loadConfig: () => Promise.reject(new Error("init loads no config")),
      examples: diskExamples,
      connect: () => {
        throw new Error("init opens no database connection");
      },
      workspace: workspaceOf(dir),
    },
    COMMANDS,
  );
}

const shipped = (file: string) => readFile(join(EXAMPLE_DIR, file), "utf8");
const written = (file: string) => readFile(join(dir, file), "utf8");

/**
 * What `facetdb add github` and `facetdb add slack` would put in the project, as far as the config
 * file reads them: `github.issues`, `github.label` and `slack.notify`, built with facetdb's own
 * `sourceCall`, `actionCall` and `notifyCall` as the real plugins build them. Each lives outside
 * `node_modules` and is linked in, so it loads as this suite's own TypeScript.
 */
const FIXTURES = {
  github: [
    'import { actionCall, type JsonValue, sourceCall } from "facetdb";',
    "type Settings = { readonly [key: string]: JsonValue };",
    "const written = (options: object): Settings => JSON.parse(JSON.stringify(options)) as Settings;",
    "export const github = {",
    '  issues: (options: object) => sourceCall("@facetdb/github", "issues", written(options)),',
    '  label: (options: object) => actionCall("@facetdb/github", "label", written(options)),',
    "};",
  ],
  slack: [
    'import { type NotifyOptions, notifyCall } from "facetdb";',
    "export const slack = {",
    '  notify: (options: NotifyOptions) => notifyCall("@facetdb/slack", options),',
    "};",
  ],
} as const;

/** The project's packages: facetdb itself, linked as `pnpm add facetdb` would, and the two fixtures. */
async function installFixtures(): Promise<void> {
  await mkdir(join(dir, "node_modules", "@facetdb"), { recursive: true });
  await symlink(resolve(packageDir), join(dir, "node_modules", "facetdb"));
  for (const [name, lines] of Object.entries(FIXTURES)) {
    const at = join(dir, "fixture-plugins", name);
    await mkdir(at, { recursive: true });
    await writeFile(
      join(at, "package.json"),
      JSON.stringify({ name: `@facetdb/${name}`, type: "module", exports: "./index.ts" }),
    );
    await writeFile(join(at, "index.ts"), `${lines.join("\n")}\n`);
    await symlink(at, join(dir, "node_modules", "@facetdb", name));
  }
}

async function loadWritten(): Promise<ProjectConfig> {
  const loaded = await loadConfig("facetdb.config.ts", {
    projectDir: dir,
    env: {},
    stderr: { write: () => true },
    quiet: true,
  });
  return loaded.config;
}

describe("facetdb init --example github-triage", () => {
  it("writes the example's config and its steps as shipped, and names the two plugins to add", async () => {
    const result = await run(["init", "--example", "github-triage"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.prompts).toEqual([]);
    expect(result.stdout).toContain(
      `Copied the github-triage example: facetdb.config.ts, ${STEPS}.`,
    );
    expect(result.stdout).toContain(
      "1. Add the plugins its config imports: facetdb add github and facetdb add slack (the packages @facetdb/github and @facetdb/slack).",
    );
    expect(result.stdout).toContain(`2. Follow ${STEPS} from its step 2`);
    expect(result.stdout).not.toContain("Replaced");
    // The file a user gets is the example itself, byte for byte: the e2e runs this same file.
    expect(await written("facetdb.config.ts")).toBe(await shipped("facetdb.config.ts"));
    expect(await written(STEPS)).toBe(await shipped(STEPS));
  });

  it("loads with the two plugins installed: the example's source, questions, thresholds and actions, every secret a variable", async () => {
    expect((await run(["init", "--example", "github-triage"])).code).toBe(0);
    await installFixtures();
    const config = await loadWritten();

    expect(config.model).toBe("jev-1.14.0");
    // GitHub's own API by default (no apiUrl), as the example is written.
    expect(config.plugins).toEqual({
      github: {
        token: { env: "GITHUB_TOKEN" },
        webhookSecret: { env: "GITHUB_WEBHOOK_SECRET" },
      },
      slack: { webhooks: { "#triage": { env: "SLACK_WEBHOOK_TRIAGE" } } },
    });
    expect(config.sources).toHaveLength(1);
    const [source] = config.sources;
    expect(source?.name).toBe("issues");
    expect(source?.source).toEqual({
      plugin: "@facetdb/github",
      source: "issues",
      settings: { repo: REPO, include: ["issues", "pull_requests"] },
    });
    expect(source?.read).toEqual(["title", "body", "labels", "changed_files"]);
    expect(source?.questions.map((question) => [question.name, question.type])).toEqual([
      ["not_priority", "noul"],
      ["impacts_only_oss", "noul"],
    ]);
    expect(source?.questions.map((question) => question.instructions)).toEqual([
      "Would the maintainers treat this as low priority? Low priority means cosmetic issues, feature requests with no concrete use case, questions the docs answer, and unsupported setups.",
      "Does this affect only the self-hosted open-source version and not the hosted platform? Hosted-only parts: billing, team management, cloud sync.",
    ]);
    expect(source?.thresholds).toEqual({
      not_priority: { yesAbove: 0.8, noBelow: 0.2 },
      impacts_only_oss: { yesAbove: 0.8, noBelow: 0.2 },
    });
    // The example's three labels and its notification; every label action names the repository
    // (until an action can see its source when the config loads), and the third takes needs-triage
    // away once a person decides.
    expect(source?.actions).toEqual([
      {
        plugin: "@facetdb/github",
        action: "label",
        config: {
          repo: REPO,
          when: { not_priority: true },
          add: ["Not Priority"],
          else: { remove: ["Not Priority"] },
        },
      },
      {
        plugin: "@facetdb/github",
        action: "label",
        config: {
          repo: REPO,
          when: { impacts_only_oss: true },
          add: ["Impacts only OSS"],
          else: { remove: ["Impacts only OSS"] },
        },
      },
      {
        plugin: "@facetdb/github",
        action: "label",
        config: {
          repo: REPO,
          when: { status: "needs_review" },
          add: ["needs-triage"],
          else: { remove: ["needs-triage"] },
        },
      },
      {
        plugin: "@facetdb/slack",
        action: "notify",
        config: { channel: "#triage", when: { status: "needs_review" } },
      },
    ]);
  });

  it("--dry-run lists the files and prints the config, writing nothing", async () => {
    const dry = await run(["init", "--example", "github-triage", "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(
      `-- the github-triage example (dry run: nothing is written): facetdb.config.ts, ${STEPS}`,
    );
    expect(dry.stdout).toContain(await shipped("facetdb.config.ts"));
    await expect(written("facetdb.config.ts")).rejects.toThrow();
    await expect(written(STEPS)).rejects.toThrow();
  });

  it("leaves a repository's own README.md alone, with and without --force", async () => {
    const own = "# my project\n";
    await writeFile(join(dir, "README.md"), own);
    const plain = await run(["init", "--example", "github-triage"]);
    expect(plain.code, plain.stderr).toBe(0);
    expect(await written("README.md")).toBe(own);
    // Once more with --force over the example's own files: they are named, the README is not.
    const forced = await run(["init", "--example", "github-triage", "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stdout).toContain(
      `Replaced facetdb.config.ts and ${STEPS} with the example's (--force).`,
    );
    expect(await written("README.md")).toBe(own);
  });

  it("refuses naming every file it would replace, and --force replaces exactly those", async () => {
    await writeFile(join(dir, "facetdb.config.ts"), "// my own config\n");
    await writeFile(join(dir, STEPS), "my own notes\n");
    const kept = await run(["init", "--example", "github-triage"]);
    expect(kept.code).toBe(1);
    expect(kept.stderr).toContain(
      `error: facetdb.config.ts and ${STEPS} already exist, and init does not replace a file you may have edited`,
    );
    expect(kept.stderr).toContain(
      `move them away, or run facetdb init --example github-triage --force to replace facetdb.config.ts and ${STEPS} with the example's`,
    );
    expect(await written("facetdb.config.ts")).toBe("// my own config\n");
    expect(await written(STEPS)).toBe("my own notes\n");

    // One file there: named alone, and its dry run under --force says it would go.
    await rm(join(dir, "facetdb.config.ts"));
    const one = await run(["init", "--example", "github-triage"]);
    expect(one.code).toBe(1);
    expect(one.stderr).toContain(`error: ${STEPS} already exists`);
    expect(one.stderr).toContain(`move it away, or run`);
    const dry = await run(["init", "--example", "github-triage", "--force", "--dry-run"]);
    expect(dry.code, dry.stderr).toBe(0);
    expect(dry.stdout).toContain(`(dry run: nothing is written; --force would replace ${STEPS})`);
    expect(await written(STEPS)).toBe("my own notes\n");

    const forced = await run(["init", "--example", "github-triage", "--force"]);
    expect(forced.code, forced.stderr).toBe(0);
    expect(forced.stdout).toContain(`Replaced ${STEPS} with the example's (--force).`);
    expect(await written(STEPS)).toBe(await shipped(STEPS));
  });

  it("refuses --engine and the table flags", async () => {
    const engine = await run(["init", "--example", "github-triage", "--engine", "postgres"]);
    expect(engine.code).toBe(2);
    expect(engine.stderr).toContain(
      "the github-triage example has no database to pick: its records are read by a plugin and kept in the FacetDB store",
    );
    const table = await run(["init", "--example", "github-triage", "--table", "issues"]);
    expect(table.code).toBe(2);
    expect(table.stderr).toContain(
      "--example copies a finished project, so --table would change nothing",
    );
    await expect(written("facetdb.config.ts")).rejects.toThrow();
  });
});
