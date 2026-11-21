import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { planApply } from "./apply.ts";
import {
  actionCall,
  ConfigError,
  configFileSource,
  env,
  facetdb,
  fromProjectJson,
  loadConfig,
  noul,
  type PluginSettings,
  type ProjectConfig,
  parseProjectConfig,
  pluginVariables,
  toProjectJson,
} from "./index.ts";

/**
 * The config's `plugins` key: each plugin's settings in the file, every secret a variable's name,
 * `env("NAME")` in the file and `{ "env": "NAME" }` in the JSON, carried by the export, the import
 * and the file Apply writes, with no value of a secret anywhere.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const packageDir = join(fixtures, "..", "..", "..");

/** Values a variable holds where the worker runs: none of them may reach a file, a JSON or a message. */
const GITHUB_TOKEN = "ghp_s3cret-github-token";
const SMTP_PASSWORD = "smtp-s3cret-password";
const ENV = { GITHUB_TOKEN, SMTP_PASSWORD };

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A project directory holding `text` as its config, with `facetdb` linked as `pnpm add` would. */
async function projectWith(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facetdb-plugins-key-"));
  scratch.push(dir);
  await mkdir(join(dir, "node_modules"));
  await symlink(packageDir, join(dir, "node_modules", "facetdb"));
  await writeFile(join(dir, "facetdb.config.ts"), text);
  return dir;
}

function load(projectDir: string) {
  return loadConfig("facetdb.config.ts", {
    projectDir,
    env: ENV,
    stderr: { write: () => true },
    quiet: true,
  });
}

function project(plugins?: { readonly [name: string]: PluginSettings }): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    ...(plugins === undefined ? {} : { plugins }),
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgent: noul("Is this urgent?") },
        actions: [actionCall("@facetdb/slack", "notify", { channel: "#support" })],
      },
    ],
  });
}

function parsed(config: ProjectConfig): ProjectConfig {
  const result = parseProjectConfig(config);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.config;
}

function issuesOf(config: unknown): { path: string; message: string }[] {
  const result = parseProjectConfig(config);
  return result.ok ? [] : result.issues.map((issue) => ({ ...issue }));
}

/** Nested and optional secrets, a list, a number, a boolean, a key by package name. */
const PLUGINS = {
  github: {
    repo: "acme/web",
    token: env("GITHUB_TOKEN"),
    labels: ["bug", "question"],
    retries: 3,
    verifyToken: true,
  },
  "facetdb-plugin-mailer": {
    smtp: {
      host: "smtp.example.com",
      port: 587,
      auth: { user: "ops", password: env("SMTP_PASSWORD") },
    },
  },
  slack: { channel: "#ops" },
} as const;

const WITH_PLUGINS = `import { env, facetdb, noul } from "facetdb";

export default facetdb({
  model: "jev-1.14.0",
  plugins: {
    github: { repo: "acme/web", token: env("GITHUB_TOKEN"), labels: ["bug", "question"], retries: 3, verifyToken: true },
    "facetdb-plugin-mailer": { smtp: { host: "smtp.example.com", port: 587, auth: { user: "ops", password: env("SMTP_PASSWORD") } } },
    slack: { channel: "#ops" },
  },
  sources: [
    {
      name: "tickets",
      api: true,
      read: ["body"],
      questions: { urgent: noul("Is this urgent?") },
    },
  ],
});
`;

describe("the plugins key: a config without it", () => {
  it("loads and exports exactly as before: no plugins key in the JSON, no line in the file", async () => {
    const { config } = await loadConfig("facetdb.config.ts", {
      projectDir: fixtures,
      env: { DATABASE_URL: "postgres://app:pw@db.example.com/shop" },
      stderr: { write: () => true },
      quiet: true,
    });
    expect("plugins" in config).toBe(false);
    const json = toProjectJson(config);
    expect(Object.keys(json)).toEqual(["model", "alerts", "onCapReached", "sources"]);
    expect(JSON.stringify(json)).not.toContain("plugins");
    expect(configFileSource(config)).not.toContain("plugins");
    const imported = fromProjectJson(JSON.parse(JSON.stringify(json)), {
      DATABASE_URL: "postgres://app:pw@db.example.com/shop",
    });
    expect("plugins" in imported).toBe(false);
    expect(JSON.stringify(toProjectJson(imported))).toBe(JSON.stringify(json));
  });

  it("the DSL writes no plugins key when the project has none", () => {
    expect("plugins" in project()).toBe(false);
    expect("plugins" in parsed(project())).toBe(false);
  });
});

describe("the plugins key: file to JSON to file", () => {
  it("loads settings with env() at any depth, the names and never the values", async () => {
    const { config } = await load(await projectWith(WITH_PLUGINS));
    expect(config.plugins).toEqual(PLUGINS);
    const text = JSON.stringify(config);
    expect(text).not.toContain(GITHUB_TOKEN);
    expect(text).not.toContain(SMTP_PASSWORD);
  });

  it("exports { env: NAME } in the JSON and imports it back without loss", async () => {
    const { config } = await load(await projectWith(WITH_PLUGINS));
    const json = toProjectJson(config);
    expect(json.plugins).toEqual(PLUGINS);
    expect(json.plugins?.["github"]?.["token"]).toEqual({ env: "GITHUB_TOKEN" });
    const wire = JSON.stringify(json);
    expect(wire).toContain('"token":{"env":"GITHUB_TOKEN"}');
    expect(wire).not.toContain(GITHUB_TOKEN);
    expect(wire).not.toContain(SMTP_PASSWORD);
    const imported = fromProjectJson(JSON.parse(wire), ENV);
    expect(imported.plugins).toEqual(PLUGINS);
    expect(toProjectJson(imported)).toEqual(json);
  });

  it("writes env(NAME) in the exported file, which loads to the same project and exports the same text", async () => {
    const { config } = await load(await projectWith(WITH_PLUGINS));
    const file = configFileSource(config);
    expect(file).toContain('import { env, facetdb, noul } from "facetdb";');
    expect(file).toContain(
      '  plugins: {\n    "github": { "repo": "acme/web", "token": env("GITHUB_TOKEN"), "labels": ["bug", "question"], "retries": 3, "verifyToken": true },',
    );
    expect(file).toContain('"password": env("SMTP_PASSWORD")');
    expect(file).not.toContain(GITHUB_TOKEN);
    expect(file).not.toContain(SMTP_PASSWORD);
    const { config: reloaded } = await load(await projectWith(file));
    expect(reloaded).toEqual(config);
    expect(configFileSource(reloaded)).toBe(file);
  });

  it("imports env for plugin settings alone (an API project names no other variable)", () => {
    const file = configFileSource(parsed(project({ github: { token: env("GITHUB_TOKEN") } })));
    expect(file).toContain('import { actionCall, env, facetdb, noul } from "facetdb";');
    const plain = configFileSource(parsed(project({ slack: { channel: "#ops" } })));
    expect(plain).toContain('import { actionCall, facetdb, noul } from "facetdb";');
    expect(configFileSource(parsed(project({})))).toContain("  plugins: {},\n");
  });

  it("an optional secret left out loads, and the loader records only the variables named", () => {
    const config = parsed(project(PLUGINS));
    expect(pluginVariables(config)).toEqual([
      { plugin: "github", path: ["token"], variable: "GITHUB_TOKEN" },
      {
        plugin: "facetdb-plugin-mailer",
        path: ["smtp", "auth", "password"],
        variable: "SMTP_PASSWORD",
      },
    ]);
    expect(pluginVariables(parsed(project()))).toEqual([]);
  });

  it("Apply's exporter keeps the key: a spending cap changes one line and the plugins stay as they were", async () => {
    const { config } = await load(await projectWith(WITH_PLUGINS));
    const text = configFileSource(config);
    const result = planApply(
      { path: "facetdb.config.ts", text, config },
      { project: { spendingCap: 1000 } },
      ENV,
    );
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    const changed = result.plan.diff.split("\n").filter((line) => /^[-+][^-+]/.test(line));
    expect(changed).toEqual(["+  spendingCap: 1000,"]);
    expect(result.plan.config.plugins).toEqual(PLUGINS);
    expect(result.plan.after).not.toContain(GITHUB_TOKEN);
  });

  it("Apply's exporter keeps the key through a source's draft too", async () => {
    const { config } = await load(await projectWith(WITH_PLUGINS));
    const text = configFileSource(config);
    const result = planApply(
      { path: "facetdb.config.ts", text, config },
      {
        source: {
          name: "tickets",
          questions: {
            urgent: { type: "noul", instructions: "Is it urgent today?", stakes: "low" },
          },
        },
      },
      ENV,
    );
    if (!result.ok) {
      throw new Error(JSON.stringify(result.issues));
    }
    expect(result.plan.config.plugins).toEqual(PLUGINS);
    expect(result.plan.after).toContain('"token": env("GITHUB_TOKEN")');
  });
});

describe("the plugins key refuses what would put a secret in the file", () => {
  const SECRET_WORDS = "looks like a secret, and secrets never go in this file or its JSON export";

  it("a literal under a key that reads as a secret, with the existing words and the env() fix", () => {
    const issues = issuesOf(project({ github: { repo: "acme/web", token: GITHUB_TOKEN } }));
    expect(issues).toEqual([
      {
        path: "plugins.github.token",
        message: `"token" ${SECRET_WORDS}. Put the secret in an environment variable and name the variable here: token: env("GITHUB_TOKEN").`,
      },
    ]);
    expect(JSON.stringify(issues)).not.toContain(GITHUB_TOKEN);
  });

  it("text directly under a secret-looking key, nested and under a package name, at its own path", () => {
    const issues = issuesOf(
      project({
        "facetdb-plugin-mailer": {
          smtp: { auth: { user: "ops", password: SMTP_PASSWORD } },
          apiKey: "k1",
          webhookSecret: "whsec_1",
        },
      }),
    );
    expect(issues.map((issue) => issue.path)).toEqual([
      "plugins.facetdb-plugin-mailer.smtp.auth.password",
      "plugins.facetdb-plugin-mailer.apiKey",
      "plugins.facetdb-plugin-mailer.webhookSecret",
    ]);
    expect(issues[0]?.message).toContain('password: env("MAILER_PASSWORD")');
    expect(issues[1]?.message).toContain('apiKey: env("MAILER_API_KEY")');
    expect(JSON.stringify(issues)).not.toContain(SMTP_PASSWORD);
  });

  it("passes ordinary settings whose keys only resemble a secret's: numbers, lists, plain keys", () => {
    expect(
      issuesOf(
        project({
          github: {
            maxTokens: 500,
            primaryKey: "id",
            labelKeys: ["bug", "question"],
            verifyToken: true,
            tokens: { limit: 3 },
          },
        }),
      ),
    ).toEqual([]);
    // A token written as text under such a key is still refused.
    expect(issuesOf(project({ github: { token: GITHUB_TOKEN } })).map((i) => i.path)).toEqual([
      "plugins.github.token",
    ]);
  });

  it("a URL that carries a credential or is a bearer webhook, under any key", () => {
    const issues = issuesOf(
      project({
        slack: { hook: "https://hooks.slack.com/services/T000/B000/XXXX" },
        "@facetdb/webhook": { endpoint: "https://ops:pw@example.com/in" },
      }),
    );
    expect(issues).toEqual([
      {
        path: "plugins.slack.hook",
        message: expect.stringContaining("incoming-webhook URL that acts as a secret by itself"),
      },
      {
        path: "plugins.@facetdb/webhook.endpoint",
        message: expect.stringContaining('endpoint: env("WEBHOOK_ENDPOINT")'),
      },
    ]);
  });

  it("env() must name a variable, and a key ending in Env must hold a name", () => {
    expect(
      issuesOf(
        project({ github: { token: env("ghp_not_a_name") }, slack: { tokenEnv: "xoxb-1" } }),
      ),
    ).toEqual([
      {
        path: "plugins.github.token",
        message: expect.stringContaining("env(...) must name an environment variable"),
      },
      {
        path: "plugins.slack.tokenEnv",
        message: expect.stringContaining("must name an environment variable"),
      },
    ]);
  });

  it("a key that is not a plugin's name, and settings that are not an object", () => {
    const issues = issuesOf(
      project({ "Not A Plugin": {}, github: "acme/web" as unknown as PluginSettings }),
    );
    expect(issues.map((issue) => issue.path)).toEqual(["plugins.Not A Plugin", "plugins.github"]);
    expect(issues[0]?.message).toContain('short name ("github") or its package name');
    expect(issues[1]?.message).toContain("a plugin's settings are an object");
  });

  it("the project JSON refuses a literal secret as the file does", () => {
    const json = toProjectJson(parsed(project()));
    const run = () =>
      fromProjectJson({ ...json, plugins: { github: { token: GITHUB_TOKEN } } }, ENV);
    expect(run).toThrow(ConfigError);
    expect(run).toThrow(/plugins\.github\.token: "token" looks like a secret/);
    try {
      run();
    } catch (error) {
      expect((error as Error).message).not.toContain(GITHUB_TOKEN);
    }
  });
});
