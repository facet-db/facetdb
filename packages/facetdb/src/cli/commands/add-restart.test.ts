import { describe, expect, it } from "vitest";
import { action, definePlugin, type Plugin, z } from "../../plugin/index.ts";
import { runInProcess, type Workspace } from "../program.ts";
import { DEFAULT_REGISTRY } from "../registry/index.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb add` ends with the restart: a worker loads plugin code only when it starts, so after the
 * lines to paste and the variables' line comes "Restart facetdb worker to load it.", whether or not
 * the plugin names a variable. A dry run installs nothing and says no such thing. The registry is a
 * fake `fetch`, the package manager a recording runner: nothing leaves the test.
 */

const RESTART = "Restart facetdb worker to load it.";
const noop = async () => undefined;

const github = definePlugin({
  name: "github",
  version: "1.2.0",
  facetdb: "*",
  config: z.object({ repo: z.string(), token: z.secret() }),
  actions: { label: action({ config: z.object({ add: z.string() }), run: noop }) },
});

/** A plugin with no secret: its closing lines name no variable. */
const ping = definePlugin({
  name: "ping",
  version: "0.1.0",
  facetdb: "*",
  config: z.object({}),
  actions: { send: action({ config: z.object({}), run: noop }) },
});

const PACKAGES: Readonly<Record<string, Plugin>> = {
  "@facetdb/github": github,
  "facetdb-plugin-ping": ping,
};

function listing(name: string, pkg: string) {
  return {
    name,
    package: pkg,
    description: `Does what ${name} does`,
    kinds: ["action"],
    facetdb: "*",
    verified: true,
    downloads: 1,
  };
}

const INDEX = JSON.stringify({
  format: 1,
  generatedAt: "2026-11-19T09:00:00.000Z",
  plugins: [listing("github", "@facetdb/github"), listing("ping", "facetdb-plugin-ping")],
});

function run(argv: readonly string[]) {
  const installed = new Map<string, Plugin>();
  const workspace: Workspace = {
    exists: (path) => Promise.resolve(path === "package.json" || path === "pnpm-lock.yaml"),
    write: () => Promise.reject(new Error("facetdb add writes no file")),
    writeParts: () => Promise.reject(new Error("facetdb add writes no file")),
    peek: () => Promise.resolve({ kind: "none" }),
    lines: async function* () {},
    hasClaudeCommand: () => false,
  };
  return runInProcess(
    argv,
    {
      projectDir: "/work/shop",
      env: {},
      loadConfig: () => Promise.reject(new Error("facetdb add reads no config")),
      connect: () => {
        throw new Error("facetdb add opens no database");
      },
      workspace,
      fetch: (url) =>
        url === DEFAULT_REGISTRY
          ? Promise.resolve(new Response(INDEX))
          : Promise.reject(new Error(`getaddrinfo ENOTFOUND ${url}`)),
      abortAfter: () => new AbortController().signal,
      runCommand: (_command, args) => {
        for (const [name, plugin] of Object.entries(PACKAGES)) {
          if (args.includes(name)) {
            installed.set(name, plugin);
          }
        }
        return Promise.resolve(0);
      },
      importPlugin: (specifier) => {
        const plugin = installed.get(specifier);
        return plugin === undefined
          ? Promise.reject(
              Object.assign(new Error(`Cannot find package '${specifier}'`), {
                code: "ERR_MODULE_NOT_FOUND",
              }),
            )
          : Promise.resolve({ default: plugin });
      },
    },
    COMMANDS,
  );
}

/** The printed lines, trailing blank lines dropped. */
function linesOf(stdout: string): string[] {
  return stdout.trimEnd().split("\n");
}

describe("facetdb add ends with the restart that loads the plugin", () => {
  it("says it on the line after the variables' line, as the last line", async () => {
    const result = await run(["add", "github"]);
    expect(result.code, result.stderr).toBe(0);
    const lines = linesOf(result.stdout);
    const variables = lines.findIndex((line) => line.includes("Set GITHUB_TOKEN"));
    expect(variables).toBeGreaterThan(0);
    expect(lines[variables + 1]).toBe(RESTART);
    expect(lines.at(-1)).toBe(RESTART);
    expect(result.stdout.split(RESTART)).toHaveLength(2);
  });

  it("says it after the settings' line of a plugin that names no variable", async () => {
    const result = await run(["add", "ping"]);
    expect(result.code, result.stderr).toBe(0);
    const lines = linesOf(result.stdout);
    expect(result.stdout).not.toContain("where the worker runs");
    expect(lines.at(-2)).toMatch(/^Its other settings go in the same entry/);
    expect(lines.at(-1)).toBe(RESTART);
  });

  it("a dry run, which installs nothing, says nothing of a restart", async () => {
    const result = await run(["add", "github", "--dry-run"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("Restart");
  });
});
