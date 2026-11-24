import type { Clock } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import { actionCall, env, facetdb, noul, type ProjectConfig } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import { action, createPluginHost, definePlugin, type Plugin, z } from "../../plugin/index.ts";
import { runInProcess } from "../program.ts";
import { COMMANDS } from "./index.ts";

/**
 * `facetdb worker`, `facetdb studio` and `facetdb dev` build the plugin host when the config loads,
 * and so does doctor's config check: a setting the plugin's schema refuses, a schema that throws,
 * or a variable that is not set stops them in the host's words, and no part of a value read from
 * the environment reaches stdout, stderr or `--json` output.
 */

const PROJECT_DIR = "/work/shop";
/** A clock whose sleeps never end: each doctor step's 10-second bound waits. */
const clock: Clock = { now: () => 1_700_000_000_000, sleep: () => new Promise(() => undefined) };
const GITHUB_TOKEN = "ghp_s3cret-github-token";
const OTHER_TOKEN = "xoxb-s3cret-other-token";
/** Not JSON, with characters JSON escapes: a parse error would quote its start. */
const VAULT_TOKEN = 'xoxb-s3cret"not\\json';
const ENV = {
  GITHUB_TOKEN,
  OTHER_TOKEN,
  VAULT_TOKEN,
  FACETDB_SECRET: "store-s3cret",
  TYPESAFE_API_KEY: "tsk-s3cret-model-key",
};
/** Every value, every value's first ten characters, and its JSON-escaped form. */
const FORBIDDEN = [GITHUB_TOKEN, OTHER_TOKEN, VAULT_TOKEN, ENV.FACETDB_SECRET, ENV.TYPESAFE_API_KEY]
  .flatMap((value) => [value, value.slice(0, 10), JSON.stringify(value).slice(1, -1)])
  .concat(["s3cret"]);

const noop = async () => undefined;

const github = definePlugin({
  name: "github",
  version: "1.2.0",
  facetdb: "*",
  config: z.object({
    repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo is owner/name, such as acme/web"),
    // A reason that quotes its input: never printed for a value read from a variable.
    token: z.secret().refine((token) => token.startsWith("ghp_"), {
      error: (issue) => `a token starts with ghp_, and ${String(issue.input)} does not`,
    }),
  }),
  actions: { label: action({ config: z.object({ add: z.string() }), run: noop }) },
});

/** A schema that throws on a value it cannot read: JSON.parse's error quotes the value's start. */
const vault = definePlugin({
  name: "vault",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret().transform((value): unknown => JSON.parse(value)) }),
  actions: { seal: action({ config: z.object({}), run: noop }) },
});

const INSTALLED: Readonly<Record<string, Plugin>> = {
  "@facetdb/github": github,
  "@facetdb/vault": vault,
};

function project(plugins: NonNullable<ProjectConfig["plugins"]>): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins,
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgent: noul("Is this urgent?") },
        actions: [actionCall("@facetdb/github", "label", { add: "urgent" })],
      },
    ],
  });
}

const GOOD = project({ github: { repo: "acme/web", token: env("GITHUB_TOKEN") } });
const BAD = project({ github: { repo: "not a repo", token: env("OTHER_TOKEN") } });
const THROWS = project({
  github: { repo: "acme/web", token: env("GITHUB_TOKEN") },
  vault: { token: env("VAULT_TOKEN") },
});

function run(argv: readonly string[], config: ProjectConfig, environment = ENV) {
  return runInProcess(
    argv,
    {
      projectDir: PROJECT_DIR,
      env: environment,
      clock,
      setEnv: () => undefined,
      loadConfig: () => Promise.resolve(config),
      connect: (url) => {
        throw new Error(`a connection was opened to ${url}`);
      },
      pluginHost: (loaded) =>
        createPluginHost({
          config: loaded,
          env: environment,
          projectDir: PROJECT_DIR,
          coreVersion: VERSION,
          importModule: async (specifier) => {
            const plugin = INSTALLED[specifier];
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

function printsNoSecret(result: { readonly stdout: string; readonly stderr: string }) {
  for (const fragment of FORBIDDEN) {
    expect(result.stdout).not.toContain(fragment);
    expect(result.stderr).not.toContain(fragment);
  }
}

const REFUSED = [
  'the settings of the plugin "@facetdb/github" are refused by its schema:',
  "  - plugins.github.repo: repo is owner/name, such as acme/web",
  "  - plugins.github.token: the value of OTHER_TOKEN is refused by the plugin's schema (its reason is not shown, as it could quote the value)",
].join("\n");
const REFUSED_FIX =
  "change plugins.github in the config file, or the variable it names, as each line says";

const FAILED =
  'the schema of the plugin "@facetdb/vault" failed while it read plugins.vault, which reads VAULT_TOKEN, instead of refusing a value in words';
const FAILED_FIX =
  "check what plugins.vault holds and the value of VAULT_TOKEN; if they are what the plugin documents, ask its author to make its schema refuse a value rather than fail";

describe("the worker builds the plugin host when the config loads (plugin-host)", () => {
  it("--dry-run starts with good settings and prints no secret, in text and in --json", async () => {
    const text = await run(["worker", "--dry-run"], GOOD);
    expect(text.code, text.stderr).toBe(0);
    printsNoSecret(text);
    const json = await run(["worker", "--dry-run", "--json"], GOOD);
    expect(json.code, json.stderr).toBe(0);
    printsNoSecret(json);
  });

  it("stops on a setting the schema refuses, in the host's words, with no secret in text or --json", async () => {
    const text = await run(["worker", "--dry-run"], BAD);
    expect(text.code).toBe(1);
    expect(text.stderr).toBe(
      `error: ${REFUSED}\nfix: ${REFUSED_FIX}\nsee: https://docs.facetdb.dev/fix/plugin-settings\n`,
    );
    printsNoSecret(text);

    const json = await run(["worker", "--dry-run", "--json"], BAD);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({
      ok: false,
      error: {
        code: "plugin-settings",
        message: REFUSED,
        fix: REFUSED_FIX,
        docs: "https://docs.facetdb.dev/fix/plugin-settings",
      },
    });
    printsNoSecret(json);
  });

  it("stops on a schema that throws on a variable's value, never printing what it threw", async () => {
    const text = await run(["worker", "--dry-run"], THROWS);
    expect(text.code).toBe(1);
    expect(text.stderr).toBe(
      `error: ${FAILED}\nfix: ${FAILED_FIX}\nsee: https://docs.facetdb.dev/fix/plugin-settings\n`,
    );
    expect(text.stderr).not.toContain("JSON");
    printsNoSecret(text);

    const json = await run(["worker", "--dry-run", "--json"], THROWS);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: false,
      error: { code: "plugin-settings", message: FAILED, fix: FAILED_FIX },
    });
    printsNoSecret(json);
  });

  it("stops on a variable that is not set, naming it and where to set it", async () => {
    const result = await run(["worker", "--dry-run"], GOOD, { ...ENV, GITHUB_TOKEN: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'error: the plugin "@facetdb/github" cannot start: GITHUB_TOKEN is not set (plugins.github.token reads it)',
    );
    expect(result.stderr).toContain(
      "fix: set GITHUB_TOKEN where the worker runs, then start it again",
    );
    printsNoSecret(result);
  });
});

describe("studio and dev refuse a bad plugin setting at start as the worker does (plugin-host)", () => {
  for (const command of ["studio", "dev"]) {
    it(`facetdb ${command} --dry-run stops in the host's words`, async () => {
      const refused = await run([command, "--dry-run"], BAD);
      expect(refused.code).toBe(1);
      expect(refused.stderr).toContain(`error: ${REFUSED}\nfix: ${REFUSED_FIX}\n`);
      printsNoSecret(refused);

      const failed = await run([command, "--dry-run", "--json"], THROWS);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toContain('"code":"plugin-settings"');
      printsNoSecret(failed);
    });
  }
});

describe("doctor's config check builds the plugin host (plugin-host)", () => {
  it("fails the config line on a bad plugin setting, in one line, with no secret in text or --json", async () => {
    const text = await run(["doctor", "--offline"], BAD);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(
      `facetdb.config.ts loads, but ${REFUSED.replace(":\n  - ", ": ").replace("\n  - ", "; ")}`,
    );
    printsNoSecret(text);
    const json = await run(["doctor", "--offline", "--json"], BAD);
    expect(json.code).toBe(1);
    printsNoSecret(json);
  });

  it("fails the config line on a schema that throws, with the host's fix and not the file's", async () => {
    const text = await run(["doctor", "--offline"], THROWS);
    expect(text.code).toBe(1);
    expect(text.stdout).toContain(`facetdb.config.ts loads, but ${FAILED}`);
    expect(text.stdout).toContain(FAILED_FIX);
    expect(text.stdout).not.toContain("valid TypeScript");
    expect(text.stdout).not.toContain("could not be read");
    printsNoSecret(text);
    const json = await run(["doctor", "--offline", "--json"], THROWS);
    expect(json.code).toBe(1);
    expect(json.stdout).toContain(JSON.stringify(FAILED).slice(1, -1));
    printsNoSecret(json);
  });

  it("passes the config line with good settings", async () => {
    const text = await run(["doctor", "--offline"], GOOD);
    expect(text.stdout).toMatch(/facetdb\.config\.ts loads, with 1 source/);
    printsNoSecret(text);
  });
});
