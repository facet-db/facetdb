import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../index.ts";
import {
  action,
  channel,
  checkChannels,
  checkSources,
  createPluginHost,
  definePlugin,
  type Plugin,
  source,
  z,
} from "../plugin/index.ts";
import { planApply } from "./apply.ts";
import { judgeDraftProject } from "./draft.ts";
import {
  actionCall,
  configFileSource,
  env,
  facetdb,
  fromProjectJson,
  loadConfig,
  noul,
  type ProjectConfig,
  parseProjectConfig,
  sourceCall,
  toProjectJson,
} from "./index.ts";

/**
 * The config's plugin source: `source: sourceCall(plugin, source, settings)` on a `sources` entry,
 * the one-source form `facetdb({ source, read, questions, ... })`, what may stand beside it, and
 * the export, the import and the file Apply writes carrying it with every variable as its name. A
 * config without a plugin source loads and exports as before.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const packageDir = join(fixtures, "..", "..", "..");

const HOOK_SECRET = "whsec_s3cret-hook";
const ENV = { HOOK_SECRET, DATABASE_URL: "postgres://app@db.internal/app" };

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function projectWith(text: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "facetdb-plugin-source-"));
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

function parsed(input: unknown): ProjectConfig {
  const result = parseProjectConfig(input);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.issues));
  }
  return result.config;
}

const QUESTIONS = { not_priority: noul("Would the maintainers treat this as low priority?") };

/** The worked example, in the one-source form. */
const ONE_SOURCE = `import { actionCall, env, facetdb, noul, sourceCall } from "facetdb";

export default facetdb({
  source: sourceCall("@facetdb/github", "issues", { repo: "your-org/your-repo", include: ["issues", "pull_requests"], hookSecret: env("HOOK_SECRET") }),
  read: ["title", "body", "labels", "changed_files"],
  model: "jev-1.14.0",
  questions: {
    not_priority: noul("Would the maintainers treat this as low priority?"),
  },
  thresholds: { not_priority: { yesAbove: 0.8, noBelow: 0.2 } },
  actions: [
    actionCall("@facetdb/github", "label", { when: { not_priority: true }, add: ["Not Priority"] }),
  ],
});
`;

describe("a plugin source in the config", () => {
  it("expands the one-source form to one sources entry named after the plugin's source", () => {
    const config = facetdb({
      model: "jev-1.14.0",
      source: sourceCall("@facetdb/github", "pull-requests", { repo: "acme/web" }),
      read: ["title"],
      questions: QUESTIONS,
      onOutage: "release",
    });
    expect(config.sources).toHaveLength(1);
    expect(config.sources[0]).toMatchObject({
      name: "pull_requests",
      api: false,
      source: {
        plugin: "@facetdb/github",
        source: "pull-requests",
        settings: { repo: "acme/web" },
      },
      read: ["title"],
      onOutage: "release",
      storage: "inline",
      actions: [],
    });
    expect(parsed(config).sources[0]?.source).toEqual(config.sources[0]?.source);

    const named = facetdb({
      model: "jev-1.14.0",
      name: "issues_web",
      source: sourceCall("@facetdb/github", "issues"),
      read: ["title"],
      questions: QUESTIONS,
    });
    expect(named.sources[0]?.name).toBe("issues_web");
    expect(named.sources[0]?.source?.settings).toEqual({});
  });

  it("refuses beside source what only a table or the check API has, each at its own path", () => {
    const result = parseProjectConfig({
      model: "jev-1.14.0",
      sources: [
        {
          name: "issues",
          source: sourceCall("@facetdb/github", "issues"),
          table: "issues",
          where: "open",
          database: "postgres://app@db/app",
          connector: "polling",
          capture: "trigger",
          lastChanged: "changed_on",
          api: true,
          storage: "side-table",
          read: ["title"],
          questions: [{ type: "noul", name: "q", instructions: "Is it?", stakes: "low" }],
        },
      ],
    });
    expect(result.ok).toBe(false);
    const paths = result.ok ? [] : result.issues.map((issue) => issue.path);
    expect(paths).toEqual(
      expect.arrayContaining([
        "sources[0].table",
        "sources[0].where",
        "sources[0].database",
        "sources[0].connector",
        "sources[0].capture",
        "sources[0].lastChanged",
        "sources[0].api",
        "sources[0].storage",
      ]),
    );
    const words = result.ok ? "" : result.issues.map((issue) => issue.message).join("\n");
    expect(words).toContain(
      "a plugin source has no table: the plugin @facetdb/github reads its records; remove table, or remove source to read a table",
    );
    expect(words).toContain(
      "a plugin source keeps its answers in the FacetDB store; remove storage, or remove source to read a table",
    );
  });

  it("refuses in the one-source form what only a table or the check API has, as a JavaScript file may write it", () => {
    const written: readonly (readonly [string, unknown, string])[] = [
      ["table", "issues", "a plugin source has no table"],
      ["where", "open = true", "a plugin source has no where"],
      ["api", true, "a source is read by a plugin or sent by your code, not both"],
      ["storage", "side-table", "a plugin source keeps its answers in the FacetDB store"],
      ["database", "postgres://app@db.internal/app", "a plugin source has no database"],
      ["connector", "polling", "a plugin source has no connector"],
      ["capture", "trigger", "a plugin source has no capture"],
      ["lastChanged", "changed_on", "a plugin source has no lastChanged"],
    ];
    for (const [key, value, words] of written) {
      // Not a form TypeScript allows beside `source`; a JavaScript config file may still write it.
      const config = facetdb({
        model: "jev-1.14.0",
        source: sourceCall("@facetdb/github", "issues"),
        read: ["title"],
        questions: QUESTIONS,
        [key]: value,
      } as never);
      const result = parseProjectConfig(config);
      expect(result.ok, key).toBe(false);
      expect(result.ok ? [] : result.issues, key).toEqual([
        { path: `sources[0].${key}`, message: expect.stringContaining(words) as string },
      ]);
    }
  });

  it("refuses a secret written into the source's settings, and takes env(NAME) at any depth", () => {
    const refused = parseProjectConfig({
      model: "jev-1.14.0",
      sources: [
        {
          name: "issues",
          source: { plugin: "@facetdb/github", source: "issues", settings: { hookSecret: "x" } },
          read: ["title"],
          questions: [{ type: "noul", name: "q", instructions: "Is it?", stakes: "low" }],
        },
      ],
    });
    expect(refused.ok).toBe(false);
    expect(refused.ok ? [] : refused.issues).toEqual([
      {
        path: "sources[0].source.settings.hookSecret",
        message: expect.stringContaining('hookSecret: env("GITHUB_HOOK_SECRET")') as string,
      },
    ]);

    const taken = parsed({
      model: "jev-1.14.0",
      sources: [
        {
          name: "issues",
          source: sourceCall("@facetdb/github", "issues", {
            hooks: [{ secret: env("HOOK_SECRET") }],
          }),
          read: ["title"],
          questions: [{ type: "noul", name: "q", instructions: "Is it?", stakes: "low" }],
        },
      ],
    });
    expect(taken.sources[0]?.source?.settings).toEqual({
      hooks: [{ secret: { env: "HOOK_SECRET" } }],
    });
    // A plugin is named by its package, as an action's is.
    const short = parseProjectConfig({
      model: "jev-1.14.0",
      sources: [
        {
          name: "issues",
          source: { plugin: "github", source: "issues" },
          read: ["title"],
          questions: [{ type: "noul", name: "q", instructions: "Is it?", stakes: "low" }],
        },
      ],
    });
    expect(short.ok ? [] : short.issues.map((issue) => issue.path)).toEqual([
      "sources[0].source.plugin",
    ]);
  });

  it("carries the source through the JSON with each variable as its name, and back to the same project", () => {
    const config = parsed(
      facetdb({
        model: "jev-1.14.0",
        source: sourceCall("@facetdb/github", "issues", {
          repo: "acme/web",
          hookSecret: env("HOOK_SECRET"),
        }),
        read: ["title", "body"],
        questions: QUESTIONS,
      }),
    );
    const json = toProjectJson(config);
    const wire = JSON.stringify(json);
    expect(wire).toContain(
      '"source":{"plugin":"@facetdb/github","source":"issues","settings":{"repo":"acme/web","hookSecret":{"env":"HOOK_SECRET"}}}',
    );
    expect(wire).not.toContain(HOOK_SECRET);
    const imported = fromProjectJson(JSON.parse(wire), ENV);
    expect(imported).toEqual(config);
    expect(toProjectJson(imported)).toEqual(json);
  });

  it("writes the one-source form back as a sources entry that loads to the same project and the same text", async () => {
    const { config } = await load(await projectWith(ONE_SOURCE));
    expect(config.sources.map((source) => source.name)).toEqual(["issues"]);
    const file = configFileSource(config);
    expect(file).toContain('import { actionCall, env, facetdb, noul, sourceCall } from "facetdb";');
    expect(file).toContain(
      '      source: sourceCall("@facetdb/github", "issues", { "repo": "your-org/your-repo", "include": ["issues", "pull_requests"], "hookSecret": env("HOOK_SECRET") }),',
    );
    expect(file).not.toContain("database:");
    expect(file).not.toContain("table:");
    expect(file).not.toContain(HOOK_SECRET);
    const { config: reloaded } = await load(await projectWith(file));
    expect(reloaded).toEqual(config);
    expect(configFileSource(reloaded)).toBe(file);
  });

  it("carries alerts in the one-source form: it loads, binds its channels and exports as the file wrote it", async () => {
    const text = ONE_SOURCE.replace(
      '  model: "jev-1.14.0",\n',
      '  model: "jev-1.14.0",\n  alerts: { channels: ["slack:#ops", { to: "email:ops@example.com", sends: "critical" }] },\n',
    );
    const { config } = await load(await projectWith(text));
    expect(config.alerts).toEqual({
      channels: ["slack:#ops", { to: "email:ops@example.com", sends: "critical" }],
    });

    // Bound by the channel host against the plugins the file names, beside the plugin source.
    const channelOf = (name: string) =>
      definePlugin({
        name,
        version: "1.0.0",
        facetdb: "*",
        config: z.object({}),
        channels: {
          [name]: channel({ config: z.object({ where: z.string() }), deliver: async () => {} }),
        },
      });
    const plugins: Readonly<Record<string, Plugin>> = {
      "@facetdb/github": definePlugin({
        name: "github",
        version: "1.0.0",
        facetdb: "*",
        config: z.object({}),
        sources: {
          issues: source({
            config: z.object({
              repo: z.string(),
              include: z.array(z.string()),
              hookSecret: z.secret(),
            }),
            watch: async function* () {},
            read: async () => [],
            scan: async function* () {},
          }),
        },
        actions: {
          label: action({ config: z.object({ add: z.array(z.string()) }), run: async () => {} }),
        },
      }),
      "@facetdb/slack": channelOf("slack"),
      "@facetdb/email": channelOf("email"),
    };
    const host = await createPluginHost({
      config,
      env: ENV,
      projectDir: "/work/app",
      coreVersion: VERSION,
      importModule: (specifier) =>
        plugins[specifier] === undefined
          ? Promise.reject(Object.assign(new Error("no"), { code: "ERR_MODULE_NOT_FOUND" }))
          : Promise.resolve({ default: plugins[specifier] }),
      builtins: {},
    });
    expect(checkChannels(config, host, ENV)).toEqual([
      { address: "slack:#ops", kind: "slack", where: "#ops", sends: "everything" },
      {
        address: "email:ops@example.com",
        kind: "email",
        where: "ops@example.com",
        sends: "critical",
      },
    ]);
    checkSources(config, host, ENV);

    const file = configFileSource(config);
    expect(file).toContain(
      '  alerts: {"channels":["slack:#ops",{"to":"email:ops@example.com","sends":"critical"}]},',
    );
    const { config: reloaded } = await load(await projectWith(file));
    expect(reloaded).toEqual(config);
    expect(configFileSource(reloaded)).toBe(file);
  });

  it("exports a project without a plugin source as before: no sourceCall import, no source key", () => {
    const config = parsed(
      facetdb({
        model: "jev-1.14.0",
        sources: [{ name: "support", api: true, read: ["body"], questions: QUESTIONS }],
      }),
    );
    expect(Object.hasOwn(config.sources[0] ?? {}, "source")).toBe(false);
    expect(JSON.stringify(toProjectJson(config))).not.toContain('"source"');
    const file = configFileSource(config);
    expect(file).toContain('import { facetdb, noul } from "facetdb";');
    expect(file).not.toContain("sourceCall");
  });

  it("a draft cannot give a source a plugin source, change one, or carry it as a project key", () => {
    const config = parsed(
      facetdb({
        model: "jev-1.14.0",
        source: sourceCall("@facetdb/github", "issues", { repo: "acme/web" }),
        read: ["title"],
        questions: QUESTIONS,
      }),
    );
    const current = { path: "facetdb.config.ts", text: configFileSource(config), config };
    const changed = planApply(
      current,
      {
        source: {
          name: "issues",
          source: { plugin: "@facetdb/github", source: "issues", settings: { repo: "evil/x" } },
        },
      },
      ENV,
    );
    expect(changed).toMatchObject({
      ok: false,
      issues: [
        {
          path: "sources[0].source",
          message:
            "a draft cannot change source: it names the plugin that reads every record and the settings it reads them with; edit source in facetdb.config.ts by hand",
        },
      ],
    });
    const added = planApply(
      current,
      {
        source: {
          name: "pulls",
          source: { plugin: "@facetdb/github", source: "pulls", settings: {} },
          read: ["title"],
          questions: { q: { type: "noul", instructions: "Is it?", stakes: "low" } },
        },
      },
      ENV,
    );
    expect(added).toMatchObject({
      ok: false,
      issues: [
        {
          path: "sources[1].source",
          message: expect.stringContaining("a draft cannot give a new source source:") as string,
        },
      ],
    });
    // A draft that changes the questions of a plugin source keeps its source as the file has it.
    const reworded = planApply(
      current,
      {
        source: {
          name: "issues",
          questions: {
            not_priority: { type: "noul", instructions: "Is it minor?", stakes: "low" },
          },
        },
      },
      ENV,
    );
    expect(reworded.ok).toBe(true);
    expect(judgeDraftProject(config, { source: { plugin: "x" } }, ENV)).toEqual({
      ok: false,
      issues: [
        {
          path: "source",
          message:
            "a draft cannot change source: it names the plugin that reads every record and the settings it reads them with; edit source in facetdb.config.ts by hand",
        },
      ],
    });
  });

  it("keeps an action of the source's plugin beside it, as any action", () => {
    const config = parsed(
      facetdb({
        model: "jev-1.14.0",
        source: sourceCall("@facetdb/github", "issues"),
        read: ["title"],
        questions: QUESTIONS,
        actions: [
          actionCall("@facetdb/github", "label", { when: { not_priority: true }, add: ["x"] }),
        ],
      }),
    );
    expect(config.sources[0]?.actions).toHaveLength(1);
  });
});
