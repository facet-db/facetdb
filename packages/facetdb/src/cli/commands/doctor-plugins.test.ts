import type { Clock } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { actionCall, env, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import { action, createPluginHost, definePlugin, type Plugin, z } from "../../plugin/index.ts";
import { runInProcess } from "../program.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb doctor`'s `plugins` check: present only when the config names a plugin, it says each
 * plugin loads, supports this FacetDB and has settings its schema accepts; when one does not (a
 * range that no longer holds after an upgrade, a setting, a package that is gone) the line names
 * the plugin, its range, this version and the fix. A config with no plugin has no such line.
 */

const PROJECT_DIR = "/work/shop";
const ENV = { GITHUB_TOKEN: "ghp_s3cret-github-token", FACETDB_SECRET: "store-s3cret" };
/** A clock whose sleeps never end: each doctor step's 10-second bound waits. */
const clock: Clock = { now: () => 1_700_000_000_000, sleep: () => new Promise(() => undefined) };
const noop = async () => undefined;

function github(range: string): Plugin {
  return definePlugin({
    name: "github",
    version: "1.2.0",
    facetdb: range,
    config: z.object({ repo: z.string(), token: z.secret() }),
    actions: { label: action({ config: z.object({ add: z.string() }), run: noop }) },
  });
}

function project(plugins?: NonNullable<ProjectConfig["plugins"]>): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    ...(plugins === undefined ? {} : { plugins }),
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgent: noul("Is this urgent?") },
        ...(plugins === undefined
          ? {}
          : { actions: [actionCall("@facetdb/github", "label", { add: "urgent" })] }),
      },
    ],
  });
}

const GOOD = project({ github: { repo: "acme/web", token: env("GITHUB_TOKEN") } });

type Check = { readonly id: string; readonly status: string; readonly detail: string };

function run(config: ProjectConfig, installed: Readonly<Record<string, Plugin>>, flags: string[]) {
  return runInProcess(
    ["doctor", "--offline", ...flags],
    {
      projectDir: PROJECT_DIR,
      env: ENV,
      clock,
      setEnv: () => undefined,
      loadConfig: () => Promise.resolve(config),
      connect: (url) => {
        throw new Error(`a connection was opened to ${url}`);
      },
      pluginHost: (loaded) =>
        createPluginHost({
          config: loaded,
          env: ENV,
          projectDir: PROJECT_DIR,
          coreVersion: VERSION,
          importModule: async (specifier) => {
            const plugin = installed[specifier];
            if (plugin !== undefined) {
              return { default: plugin };
            }
            throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
              code: "ERR_MODULE_NOT_FOUND",
            });
          },
          builtins: {},
        }),
    },
    COMMANDS,
  );
}

/** One doctor run, as the text a person reads and as the checks `--json` carries. */
async function doctor(config: ProjectConfig, installed: Readonly<Record<string, Plugin>> = {}) {
  const text = await run(config, installed, []);
  const json = await run(config, installed, ["--json"]);
  // A run with a failing check prints its checks as the error's details.
  const body = JSON.parse(json.stdout) as { checks?: Check[]; details?: { checks?: Check[] } };
  const checks = body.checks ?? body.details?.checks ?? [];
  return { text, checks, check: (id: string) => checks.find((entry) => entry.id === id) };
}

describe("doctor's plugins check", () => {
  it("is absent when the config names no plugin, so the check counts are as they were", async () => {
    const without = await doctor(project());
    expect(without.text.stdout).not.toContain("plugins:");
    expect(without.check("plugins")).toBeUndefined();
    expect(without.checks.map(({ id }) => id)).toEqual([
      "config",
      "database",
      "pooler",
      "install",
      "worker",
      "model-key",
      "model-reachable",
      "secret",
    ]);
    // One more check than this, and only for a config that names a plugin.
    const withPlugin = await doctor(GOOD, { "@facetdb/github": github("*") });
    expect(withPlugin.checks).toHaveLength(without.checks.length + 1);
  });

  it("says each plugin loads and supports this FacetDB, with its version and range", async () => {
    const found = await doctor(GOOD, { "@facetdb/github": github("^0.0.0") });
    expect(found.text.stdout).toContain(
      `ok    plugins: @facetdb/github 1.2.0 (FacetDB ^0.0.0): each loads, supports this FacetDB (${VERSION}) and has settings its schema accepts`,
    );
    expect(found.check("plugins")?.status).toBe("ok");
    expect(found.text.stdout).not.toContain(ENV.GITHUB_TOKEN);
  });

  it("fails when a plugin's range no longer holds, naming the plugin, its range, this version and the fix", async () => {
    const found = await doctor(GOOD, { "@facetdb/github": github(">=99.0.0") });
    expect(found.text.code).toBe(1);
    const line = found.text.stdout.split("\n").find((text) => text.includes("plugins:"));
    expect(line).toContain("FAIL");
    expect(line).toContain(
      `the plugin "@facetdb/github" 1.2.0 supports FacetDB >=99.0.0, but this is FacetDB ${VERSION}`,
    );
    expect(line).toContain("Fix: install a version of the plugin that supports FacetDB");
    expect(line).toContain("https://docs.facetdb.dev/fix/doctor-plugins");
    expect(found.check("plugins")?.status).toBe("fail");
  });

  it("fails for a setting the plugin's schema refuses, and for a plugin that is not installed", async () => {
    const refused = await doctor(project({ github: { repo: 7, token: env("GITHUB_TOKEN") } }), {
      "@facetdb/github": github("*"),
    });
    expect(refused.text.code).toBe(1);
    expect(refused.check("plugins")?.status).toBe("fail");
    expect(refused.check("plugins")?.detail).toContain("plugins.github.repo");

    const gone = await doctor(GOOD);
    expect(gone.text.code).toBe(1);
    expect(gone.check("plugins")?.detail).toContain('names the plugin "github": no package');
    expect(gone.text.stdout).toContain("facetdb add github");
  });
});
