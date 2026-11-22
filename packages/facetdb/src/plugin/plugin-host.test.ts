import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ZodObject } from "zod";
import {
  actionCall,
  env,
  facetdb,
  noul,
  type PluginSettings,
  type ProjectConfig,
} from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  action,
  channel,
  createPluginHost,
  definePlugin,
  importFromProject,
  type Plugin,
  type PluginHostError,
  type PluginHostOptions,
  z,
} from "./index.ts";

/**
 * The plugin host: every plugin the config names is loaded once through an injected `importModule`,
 * checked against the running core, its settings parsed by its own schema and each variable its
 * settings name read from `env`. A secret's value never reaches an error (the worker's and doctor's
 * printed lines and `--json` are cli/commands/worker-plugin-host.test.ts), and a plugin never sees
 * a variable its settings do not name.
 */

const PROJECT_DIR = "/work/shop";

/** What each variable holds where the worker runs; every value is one a refusal must never print. */
const GITHUB_TOKEN = "ghp_s3cret-github-token";
const SLACK_TOKEN = "xoxb-s3cret-slack-token";
const SHARED_KEY = "shared-s3cret-key";
const SMTP_PASSWORD = "smtp-s3cret-password";
const UNNAMED = "unnamed-s3cret-the-config-never-reads";
const ENV = {
  GITHUB_TOKEN,
  SLACK_TOKEN,
  SHARED_KEY,
  SMTP_PASSWORD,
  UNNAMED_SECRET: UNNAMED,
  FACETDB_SECRET: "store-s3cret",
  TYPESAFE_API_KEY: "tsk-s3cret-model-key",
};
const VALUES = [GITHUB_TOKEN, SLACK_TOKEN, SHARED_KEY, SMTP_PASSWORD, UNNAMED];

const noop = async () => undefined;

function githubPlugin(range = ">=0.0.0 <1.0.0") {
  return definePlugin({
    name: "github",
    version: "1.2.0",
    facetdb: range,
    config: z.object({
      repo: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "repo is owner/name, such as acme/web"),
      // A schema whose reason quotes its input: the host blanks what it read from the environment.
      token: z.secret().refine((token) => token.startsWith("ghp_"), {
        error: (issue) => `a token starts with ghp_, and ${String(issue.input)} does not`,
      }),
      webhookSecret: z.secret().optional(),
      shared: z.secret().optional(),
    }),
    actions: { label: action({ config: z.object({ add: z.string() }), run: noop }) },
  });
}

function slackPlugin() {
  return definePlugin({
    name: "slack",
    version: "0.3.0",
    facetdb: "*",
    config: z.object({
      // Neither key reads as a secret by its name: only the manifest says these are.
      bot: z.secret().optional(),
      shared: z.secret().optional(),
      defaultChannel: z.string().default("#general"),
    }),
    // Its `notify` is FacetDB's own, which a plugin with a channel has without declaring it.
    channels: { slack: channel({ config: z.object({ where: z.string() }), deliver: noop }) },
  });
}

function mailerPlugin() {
  return definePlugin({
    name: "mailer",
    version: "2.0.0",
    facetdb: "*",
    config: z.object({
      smtp: z.object({
        host: z.string(),
        auth: z.object({ user: z.string(), password: z.secret() }).optional(),
      }),
      relays: z.array(z.object({ host: z.string(), key: z.secret() })).default([]),
    }),
    channels: { email: channel({ config: z.object({ where: z.string() }), deliver: noop }) },
  });
}

/** An `importModule` over a fixed set of packages; every import is counted. */
function packages(installed: Readonly<Record<string, Plugin>>) {
  const imports: string[] = [];
  const importModule = async (specifier: string): Promise<unknown> => {
    imports.push(specifier);
    const plugin = installed[specifier];
    if (plugin === undefined) {
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    }
    return { default: plugin };
  };
  return { imports, importModule };
}

const INSTALLED = {
  "@facetdb/github": githubPlugin(),
  "@facetdb/slack": slackPlugin(),
  "facetdb-plugin-mailer": mailerPlugin(),
};

function project(
  plugins: { readonly [name: string]: PluginSettings } | undefined,
  extra: { actions?: boolean; channels?: readonly string[] } = {},
): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    ...(plugins === undefined ? {} : { plugins }),
    ...(extra.channels === undefined ? {} : { alerts: { channels: extra.channels } }),
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgent: noul("Is this urgent?") },
        ...(extra.actions === true
          ? {
              actions: [
                actionCall("@facetdb/github", "label", { add: "urgent" }),
                actionCall("@facetdb/slack", "notify", { channel: "#support" }),
              ],
            }
          : {}),
      },
    ],
  });
}

function host(config: ProjectConfig, options: Partial<Omit<PluginHostOptions, "config">> = {}) {
  const installed = packages(INSTALLED);
  return {
    imports: installed.imports,
    built: createPluginHost({
      config,
      env: ENV,
      projectDir: PROJECT_DIR,
      coreVersion: VERSION,
      importModule: installed.importModule,
      builtins: {},
      ...options,
    }),
  };
}

async function refusal(built: Promise<unknown>): Promise<PluginHostError> {
  const error = await built.then(
    () => {
      throw new Error("the host was built, and a refusal was expected");
    },
    (caught: unknown) => caught,
  );
  expect((error as Error).name).toBe("PluginHostError");
  const refused = error as PluginHostError;
  // Whatever the refusal, no value read from the environment is in its words.
  for (const value of VALUES) {
    expect(`${refused.message}\n${refused.fix}`).not.toContain(value);
  }
  return refused;
}

const signal = new AbortController().signal;

describe("the plugin host loads every plugin the config names, once", () => {
  it("from the plugins key, an action's plugin and an alert channel's kind, each package imported once", async () => {
    const { built, imports } = host(
      project(
        {
          github: { repo: "acme/web", token: env("GITHUB_TOKEN") },
          "facetdb-plugin-mailer": { smtp: { host: "smtp.example.com" } },
        },
        { actions: true, channels: ["slack:#ops", "slack:#alerts", "mailer:ops@example.com"] },
      ),
    );
    const plugins = await built;
    expect(plugins.all().map((hosted) => [hosted.name, hosted.packageName])).toEqual([
      ["github", "@facetdb/github"],
      ["mailer", "facetdb-plugin-mailer"],
      ["slack", "@facetdb/slack"],
    ]);
    // `github` and `@facetdb/github` are one package: imported once, found by either name.
    expect(imports.filter((specifier) => specifier === "@facetdb/github")).toEqual([
      "@facetdb/github",
    ]);
    expect(imports.filter((specifier) => specifier === "@facetdb/slack")).toEqual([
      "@facetdb/slack",
    ]);
    expect(plugins.plugin("github")).toBe(plugins.plugin("@facetdb/github"));
    expect(plugins.plugin("slack")?.packageName).toBe("@facetdb/slack");
    expect(plugins.plugin("mailer")?.packageName).toBe("facetdb-plugin-mailer");
    expect(plugins.plugin("telegram")).toBeUndefined();
  });

  it("a config that names no plugin imports nothing", async () => {
    const { built, imports } = host(project(undefined));
    expect((await built).all()).toEqual([]);
    expect(imports).toEqual([]);
  });

  it("a built-in is found by its package name and never imported", async () => {
    const hook = definePlugin({
      name: "hook",
      version: "1.0.0",
      facetdb: "*",
      config: z.object({}),
      channels: { hook: channel({ config: z.object({ where: z.string() }), deliver: noop }) },
    });
    const { built, imports } = host(project(undefined, { channels: ["hook:ops"] }), {
      builtins: { "@facetdb/hook": hook },
    });
    expect((await built).plugin("hook")?.packageName).toBe("@facetdb/hook");
    expect(imports).toEqual([]);
  });
});

describe("contextFor: a plugin's settings and secrets, and nothing else", () => {
  it("parses the settings by the plugin's schema, reading each variable, with secrets by path", async () => {
    const { built } = host(
      project({
        github: { repo: "acme/web", token: env("GITHUB_TOKEN") },
        "facetdb-plugin-mailer": {
          smtp: { host: "smtp.example.com", auth: { user: "ops", password: env("SMTP_PASSWORD") } },
          relays: [{ host: "relay.example.com", key: env("SHARED_KEY") }],
        },
      }),
    );
    const plugins = await built;
    const github = plugins.contextFor("github", signal);
    expect(github.config).toEqual({ repo: "acme/web", token: GITHUB_TOKEN });
    expect(github.secrets).toEqual({ token: GITHUB_TOKEN });
    expect(github.signal).toBe(signal);
    const mailer = plugins.contextFor("facetdb-plugin-mailer", signal);
    expect(mailer.secrets).toEqual({
      "smtp.auth.password": SMTP_PASSWORD,
      "relays[0].key": SHARED_KEY,
    });
    // What the host shows of a plugin is the file's: the variable's name, never its value.
    const mailerHosted = plugins.plugin("mailer");
    expect(mailerHosted?.variables).toEqual([
      { path: "smtp.auth.password", variable: "SMTP_PASSWORD", secret: true },
      { path: "relays[0].key", variable: "SHARED_KEY", secret: true },
    ]);
    const shown = JSON.stringify(
      plugins.all().map(({ name, packageName, settings, variables }) => ({
        name,
        packageName,
        settings,
        variables,
      })),
    );
    for (const value of VALUES) {
      expect(shown).not.toContain(value);
    }
  });

  it("an optional secret left out is absent from both, and a default is filled", async () => {
    const plugins = await host(project({ slack: {} }, { channels: ["slack:#ops"] })).built;
    expect(plugins.contextFor("slack", signal)).toMatchObject({
      config: { defaultChannel: "#general" },
      secrets: {},
    });
  });

  it("two plugins that read the same variable each get it; neither sees one it does not name", async () => {
    const plugins = await host(
      project({
        github: { repo: "acme/web", token: env("GITHUB_TOKEN"), shared: env("SHARED_KEY") },
        slack: { bot: env("SLACK_TOKEN"), shared: env("SHARED_KEY") },
      }),
    ).built;
    const github = plugins.contextFor("github", signal);
    const slack = plugins.contextFor("slack", signal);
    expect(github.secrets).toEqual({ token: GITHUB_TOKEN, shared: SHARED_KEY });
    expect(slack.secrets).toEqual({ bot: SLACK_TOKEN, shared: SHARED_KEY });
    const seenByGithub = JSON.stringify({ config: github.config, secrets: github.secrets });
    const seenBySlack = JSON.stringify({ config: slack.config, secrets: slack.secrets });
    expect(seenByGithub).not.toContain(SLACK_TOKEN);
    expect(seenBySlack).not.toContain(GITHUB_TOKEN);
    for (const seen of [seenByGithub, seenBySlack]) {
      expect(seen).not.toContain(UNNAMED);
      expect(seen).not.toContain(ENV.FACETDB_SECRET);
      expect(seen).not.toContain(ENV.TYPESAFE_API_KEY);
      expect(seen).not.toContain(SMTP_PASSWORD);
    }
  });

  it("hands every call the same settings and secrets, frozen to the deepest level", async () => {
    const plugins = await host(
      project({
        "facetdb-plugin-mailer": {
          smtp: { host: "smtp.example.com", auth: { user: "ops", password: env("SMTP_PASSWORD") } },
          relays: [{ host: "relay.example.com", key: env("SHARED_KEY") }],
        },
      }),
    ).built;
    const first = plugins.contextFor("mailer", signal);
    const second = plugins.contextFor("mailer", signal);
    expect(second.config).toBe(first.config);
    const config = first.config as {
      smtp: { auth: { user: string } };
      relays: { host: string }[];
    };
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.smtp.auth)).toBe(true);
    expect(Object.isFrozen(config.relays)).toBe(true);
    expect(Object.isFrozen(config.relays[0])).toBe(true);
    expect(Object.isFrozen(first.secrets)).toBe(true);
    expect(() => {
      config.smtp.auth.user = "root";
    }).toThrow(TypeError);
    expect(() => {
      config.relays.push({ host: "evil.example.com" });
    }).toThrow(TypeError);
    expect(plugins.contextFor("mailer", signal).config).toMatchObject({
      smtp: { auth: { user: "ops" } },
    });
  });

  it("refuses a context for a plugin the config does not name", async () => {
    const plugins = await host(project(undefined)).built;
    expect(() => plugins.contextFor("github", signal)).toThrow(
      'the plugin "github" is not one the config names',
    );
  });
});

describe("the plugin host refuses, in words that say what to do", () => {
  it("a package that is not installed: the loader's words and facetdb add", async () => {
    const refused = await refusal(host(project({ telegram: { chat: "42" } })).built);
    expect(refused.code).toBe("plugin-not-installed");
    expect(refused.message).toBe(
      'plugins.telegram names the plugin "telegram": no package `@facetdb/telegram` or `facetdb-plugin-telegram` is installed; run `facetdb add telegram`',
    );
    expect(refused.fix).toBe(
      `run facetdb add telegram in ${PROJECT_DIR}, or take "telegram" out of the config`,
    );
    const channel = await refusal(host(project(undefined, { channels: ["pager:ops"] })).built);
    expect(channel.message).toContain('alerts.channels[0] names the plugin "pager"');
  });

  it("a setting the schema refuses: the reason for a literal, the variable's name for a value it read", async () => {
    const refused = await refusal(
      host(project({ github: { repo: "not a repo", token: env("SLACK_TOKEN") } })).built,
    );
    expect(refused.code).toBe("plugin-settings");
    expect(refused.message).toBe(
      [
        'the settings of the plugin "@facetdb/github" are refused by its schema:',
        "  - plugins.github.repo: repo is owner/name, such as acme/web",
        "  - plugins.github.token: the value of SLACK_TOKEN is refused by the plugin's schema (its reason is not shown, as it could quote the value)",
      ].join("\n"),
    );
    expect(refused.fix).toBe(
      "change plugins.github in the config file, or the variable it names, as each line says",
    );
  });

  it("a plugin named only by an action, whose schema needs settings: where to add them", async () => {
    const refused = await refusal(host(project(undefined, { actions: true })).built);
    expect(refused.code).toBe("plugin-settings");
    expect(refused.message).toContain("plugins.github.repo:");
    expect(refused.fix).toContain('add plugins: { "github": { ... } }');
  });

  it("a secret the manifest declares, given as a literal under a name that does not look like one", async () => {
    const refused = await refusal(
      host(project({ slack: { bot: SLACK_TOKEN } }, { channels: ["slack:#ops"] })).built,
    );
    expect(refused.code).toBe("plugin-secret-literal");
    expect(refused.message).toBe(
      'plugins.slack.bot is a secret of the plugin "@facetdb/slack" written into the config file, and secrets never go in this file or its JSON export',
    );
    expect(refused.fix).toBe(
      'put it in an environment variable and name the variable there: bot: env("SLACK_BOT"), then set SLACK_BOT where the worker runs',
    );
  });

  it("a variable that is not set: its name and where to set it", async () => {
    const refused = await refusal(
      host(project({ github: { repo: "acme/web", token: env("GITHUB_TOKEN") } }), {
        env: { ...ENV, GITHUB_TOKEN: "" },
      }).built,
    );
    expect(refused.code).toBe("plugin-variable-unset");
    expect(refused.message).toBe(
      'the plugin "@facetdb/github" cannot start: GITHUB_TOKEN is not set (plugins.github.token reads it)',
    );
    expect(refused.fix).toBe("set GITHUB_TOKEN where the worker runs, then start it again");
  });

  it("a core range the running version does not satisfy: both named", async () => {
    const refused = await refusal(
      host(project({ github: { repo: "acme/web", token: env("GITHUB_TOKEN") } }), {
        importModule: packages({ "@facetdb/github": githubPlugin("^2.0.0") }).importModule,
      }).built,
    );
    expect(refused.code).toBe("plugin-core-version");
    expect(refused.message).toBe(
      `the plugin "@facetdb/github" 1.2.0 supports FacetDB ^2.0.0, but this is FacetDB ${VERSION}`,
    );
    expect(refused.fix).toContain("facetdb add github");
  });

  it("two keys for one package, and a package that is not a plugin", async () => {
    const twice = await refusal(
      host(
        project({
          github: { repo: "acme/web", token: env("GITHUB_TOKEN") },
          "@facetdb/github": { repo: "acme/api", token: env("GITHUB_TOKEN") },
        }),
      ).built,
    );
    expect(twice.code).toBe("plugin-named-twice");
    expect(twice.message).toContain("plugins.github and plugins.@facetdb/github are both");

    const notPlugin = await refusal(
      host(project({ slack: {} }), {
        importModule: async () => ({ default: { hello: "world" } }),
      }).built,
    );
    expect(notPlugin.code).toBe("plugin-invalid");
    expect(notPlugin.message).toContain("is not a plugin");
  });
});

describe("a schema that quotes or throws on a value read from a variable never prints it", () => {
  /** A value with characters JSON escapes, so an escaped quote of it is told apart from the value. */
  const TRICKY = 'vlt-s3cret"value\\with-escapes';
  const FORBIDDEN = [
    TRICKY,
    TRICKY.slice(0, 6),
    JSON.stringify(TRICKY),
    JSON.stringify(TRICKY).slice(1, -1),
    "s3cret",
  ];

  function vault(config: ZodObject) {
    return definePlugin({
      name: "vault",
      version: "1.0.0",
      facetdb: "*",
      config,
      actions: { seal: action({ config: z.object({}), run: noop }) },
    });
  }

  async function refusedBy(plugin: Plugin, settings: PluginSettings): Promise<PluginHostError> {
    const refused = await refusal(
      host(project({ vault: settings }), {
        env: { ...ENV, VAULT_TOKEN: TRICKY },
        importModule: packages({ "@facetdb/vault": plugin }).importModule,
      }).built,
    );
    for (const fragment of FORBIDDEN) {
      expect(`${refused.message}\n${refused.fix}`).not.toContain(fragment);
    }
    return refused;
  }

  const TOKEN = { token: env("VAULT_TOKEN") };

  it("a reason quoting a prefix of the value, or the value JSON-escaped: only the variable is named", async () => {
    for (const quote of [
      (input: unknown) => `it starts ${String(input).slice(0, 10)}`,
      (input: unknown) => `got ${JSON.stringify(input)}`,
    ]) {
      const refused = await refusedBy(
        vault(
          z.object({
            token: z.secret().refine(() => false, { error: (issue) => quote(issue.input) }),
          }),
        ),
        TOKEN,
      );
      expect(refused.code).toBe("plugin-settings");
      expect(refused.message).toBe(
        'the settings of the plugin "@facetdb/vault" are refused by its schema:\n  - plugins.vault.token: the value of VAULT_TOKEN is refused by the plugin\'s schema (its reason is not shown, as it could quote the value)',
      );
    }
  });

  it("a reason at a parent of a value read from a variable is not printed either", async () => {
    const refused = await refusedBy(
      vault(
        z.object({
          auth: z
            .object({ user: z.string(), password: z.secret() })
            .refine(() => false, { error: (issue) => `refused ${JSON.stringify(issue.input)}` }),
        }),
      ),
      { auth: { user: "ops", password: env("VAULT_TOKEN") } },
    );
    expect(refused.message).toContain(
      "plugins.vault.auth: the value of VAULT_TOKEN is refused by the plugin's schema",
    );
    expect(refused.message).not.toContain("refused {");
  });

  it("a transform or a refine that throws is a refusal naming the plugin and the variable, never the thrown words", async () => {
    const transform = await refusedBy(
      vault(z.object({ token: z.secret().transform((value): unknown => JSON.parse(value)) })),
      TOKEN,
    );
    const refine = await refusedBy(
      vault(
        z.object({
          token: z.secret().refine((value) => {
            throw new Error(`cannot read ${value}`);
          }),
        }),
      ),
      TOKEN,
    );
    for (const refused of [transform, refine]) {
      expect(refused.code).toBe("plugin-settings");
      expect(refused.message).toBe(
        'the schema of the plugin "@facetdb/vault" failed while it read plugins.vault, which reads VAULT_TOKEN, instead of refusing a value in words',
      );
      expect(refused.fix).toBe(
        "check what plugins.vault holds and the value of VAULT_TOKEN; if they are what the plugin documents, ask its author to make its schema refuse a value rather than fail",
      );
      expect(refused.message).not.toContain("JSON");
      expect(refused.message).not.toContain("cannot read");
    }
  });
});

describe("importFromProject resolves a plugin from the project's directory", () => {
  const scratch: string[] = [];
  afterEach(async () => {
    await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("imports the project's package, and not one only facetdb itself depends on", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facetdb-plugin-host-"));
    scratch.push(dir);
    const probe = join(dir, "node_modules", "facetdb-plugin-probe");
    await mkdir(probe, { recursive: true });
    await writeFile(
      join(probe, "package.json"),
      JSON.stringify({ name: "facetdb-plugin-probe", type: "module", main: "index.js" }),
    );
    await writeFile(join(probe, "index.js"), 'export default { from: "the project" };\n');
    const importModule = importFromProject(join(dir, "facetdb.config.ts"));
    expect(await importModule("facetdb-plugin-probe")).toMatchObject({
      default: { from: "the project" },
    });
    // zod is facetdb's own dependency, not the project's: a plugin is never found there.
    // `pnpm run` sets NODE_PATH to the monorepo's own store, where zod is: never a plugin's home.
    await expect(importModule("zod")).rejects.toMatchObject({ code: "MODULE_NOT_FOUND" });
    await expect(importModule("@facetdb/github")).rejects.toMatchObject({
      code: "MODULE_NOT_FOUND",
    });
  });

  /** A package in the project's node_modules, with the given package.json and files. */
  async function installed(
    dir: string,
    name: string,
    manifest: Record<string, unknown>,
    files: Readonly<Record<string, string>>,
  ): Promise<void> {
    const at = join(dir, "node_modules", name);
    await mkdir(at, { recursive: true });
    await writeFile(join(at, "package.json"), JSON.stringify({ name, ...manifest }));
    for (const [file, text] of Object.entries(files)) {
      await mkdir(dirname(join(at, file)), { recursive: true });
      await writeFile(join(at, file), text);
    }
  }

  it("honours a package whose exports name only an import condition, as Node's import does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "facetdb-plugin-host-"));
    scratch.push(dir);
    await installed(
      dir,
      "facetdb-plugin-esm",
      { type: "module", exports: { ".": { import: "./dist/index.js" } } },
      { "dist/index.js": 'export default { from: "the import condition" };\n' },
    );
    // Conditions are taken in the order the package writes them, the first one Node's import
    // knows wins: here "import" before "require".
    await installed(
      dir,
      "@facetdb/both",
      {
        type: "module",
        exports: { ".": { import: "./esm.js", require: "./cjs.cjs" } },
      },
      {
        "esm.js": 'export default { from: "esm" };\n',
        "cjs.cjs": 'module.exports = { from: "cjs" };\n',
      },
    );
    await installed(
      dir,
      "facetdb-plugin-plain",
      { type: "module", exports: "./main.js" },
      { "main.js": 'export default { from: "a string export" };\n' },
    );
    const importModule = importFromProject(join(dir, "facetdb.config.ts"));
    expect(await importModule("facetdb-plugin-esm")).toMatchObject({
      default: { from: "the import condition" },
    });
    expect(await importModule("@facetdb/both")).toMatchObject({ default: { from: "esm" } });
    expect(await importModule("facetdb-plugin-plain")).toMatchObject({
      default: { from: "a string export" },
    });
  });
});
