import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VERSION } from "../index.ts";
import {
  action,
  BUILTIN_PLUGINS,
  channel,
  checkChannels,
  createPluginHost,
  definePlugin,
  draftPlugins,
  type Plugin,
  PluginError,
  type PluginHost,
  provider,
  z,
} from "../plugin/index.ts";
import { type ApplyPlan, apply, type ConfigFiles, planApply } from "./apply.ts";
import type { ProjectDraft } from "./draft.ts";
import { configFileSource, env, facetdb, loadConfig, noul, type ProjectConfig } from "./index.ts";

/**
 * Apply learns the project's channels and a plugin's settings: a project draft carrying `alerts` or
 * `plugins` is judged with the loader's own checks, the plugin's schema and the channel binding
 * against the plugins the worker runs, before any diff; the diff is the file the exporter renders,
 * and the file written loads back through the real loader and binds (what the loader makes of the
 * written file is the point). A plugin's setting is a draft's only where the plugin's schema marks
 * it `z.editable()` (deny by default: any other can decide where a credential or a record's data
 * goes). What a draft still cannot do is refused in words of its own: change an unmarked setting,
 * name a variable the file does not name there (a secret's among them), put a value at a secret
 * path, name a plugin the worker does not run, change the settings of the plugin that supplies the
 * model provider. No refusal repeats a value.
 */

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const packageDir = join(fixtures, "..", "..", "..");
const PATH = "facetdb.config.ts";
const PROJECT_DIR = "/work/support-app";

const PAGER_TOKEN = "pgr_7e6d5c4b-PAGERSECRETVALUE";
const SOLAR_KEY = "sk-solar-SOLARSECRETVALUE";
const HOOK_SECRET = "whsec_HOOKSECRETVALUE";
/** A variable the machine holds that the file never names: no draft may make the worker read it. */
const MACHINE_ONLY = "machine-only-MACHINESECRETVALUE";
const RELAY_TOKEN = "rly_RELAYSECRETVALUE";
const ENV = {
  PAGER_TOKEN,
  SOLAR_KEY,
  RELAY_TOKEN,
  FACETDB_WEBHOOK_SECRET: HOOK_SECRET,
  AWS_SECRET_ACCESS_KEY: MACHINE_ONLY,
};
const FORBIDDEN = [PAGER_TOKEN, SOLAR_KEY, RELAY_TOKEN, HOOK_SECRET, MACHINE_ONLY, "SECRETVALUE"];

const pager: Plugin = definePlugin({
  name: "pager",
  version: "1.0.0",
  facetdb: "*",
  // Two settings that move no credential and no data, marked as the studio's to change.
  config: z.object({
    token: z.secret(),
    region: z.editable(z.enum(["eu", "us"])),
    mention: z.editable(z.string().optional()),
  }),
  channels: {
    pager: channel({
      config: z.object({ where: z.string().regex(/^[a-z]+$/, "a pager service is lowercase") }),
      check: (_ctx, settings: { where: string }) =>
        settings.where === "nowhere" ? "the pager has no service called nowhere" : undefined,
      deliver: async () => undefined,
    }),
  },
});

const solar: Plugin = definePlugin({
  name: "solar",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ key: z.secret(), endpoint: z.string() }),
  providers: {
    decide: provider({
      config: z.object({}),
      ask: () => Promise.reject(new Error("no model is asked in these tests")),
    }),
  },
});

/** A community plugin that marks nothing: every setting of it is the operator's. */
const relay: Plugin = definePlugin({
  name: "relay",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({
    token: z.secret(),
    url: z.string(),
    retries: z.number().int().default(3),
    labels: z.array(z.string()).default([]),
  }),
  actions: { forward: action({ config: z.object({}), run: async () => undefined }) },
});

const FILE: ProjectConfig = facetdb({
  model: "jev-1.14.0",
  provider: "solar/decide",
  alerts: { channels: ["pager:ops"] },
  plugins: {
    pager: { token: env("PAGER_TOKEN"), region: "eu" },
    relay: { token: env("RELAY_TOKEN"), url: "https://relay.example/in", retries: 3 },
    solar: { key: env("SOLAR_KEY"), endpoint: "https://solar.example/v1" },
    webhook: {
      secret: env("FACETDB_WEBHOOK_SECRET"),
      endpoints: { ops: "https://hooks.example/ops" },
    },
  },
  sources: [
    {
      name: "tickets",
      api: true,
      read: ["subject", "body"],
      questions: { urgent: noul("Is this ticket urgent?") },
    },
  ],
});
const TEXT = configFileSource(FILE);

function hostFor(config: ProjectConfig, environment: Record<string, string> = ENV) {
  return createPluginHost({
    config,
    env: environment,
    projectDir: PROJECT_DIR,
    coreVersion: VERSION,
    importModule: (specifier) => {
      const found = {
        "facetdb-plugin-pager": pager,
        "facetdb-plugin-relay": relay,
        "facetdb-plugin-solar": solar,
      }[specifier];
      return found === undefined
        ? Promise.reject(
            Object.assign(new Error(`Cannot find package '${specifier}'`), {
              code: "ERR_MODULE_NOT_FOUND",
            }),
          )
        : Promise.resolve({ default: found });
    },
    builtins: BUILTIN_PLUGINS,
  });
}

/** The environment as a draft's judgement reads it, every variable it reads recorded. */
function watched(environment: Record<string, string>) {
  const read = new Set<string>();
  const proxy = new Proxy(environment, {
    get: (target, name) => {
      if (typeof name === "string") {
        read.add(name);
      }
      return Reflect.get(target, name);
    },
  });
  return { env: proxy as Record<string, string | undefined>, read };
}

async function planned(
  project: ProjectDraft,
  environment: Record<string, string | undefined> = ENV,
  host?: PluginHost,
) {
  const hosted = host ?? (await hostFor(FILE));
  return planApply(
    { path: PATH, text: TEXT, config: FILE },
    { project },
    environment,
    undefined,
    draftPlugins({
      host: () => hosted,
      env: environment,
      coreVersion: VERSION,
      projectDir: PROJECT_DIR,
      machineZone: () => "UTC",
    }),
  );
}

async function plan(project: ProjectDraft): Promise<ApplyPlan> {
  const result = await planned(project);
  if (!result.ok) {
    throw new Error(`the draft was refused: ${JSON.stringify(result.issues)}`);
  }
  return result.plan;
}

async function refused(project: ProjectDraft, environment: Record<string, string> = ENV) {
  const result = await planned(project, environment);
  if (result.ok) {
    throw new Error("the draft was taken");
  }
  for (const fragment of FORBIDDEN) {
    expect(JSON.stringify(result.issues)).not.toContain(fragment);
  }
  return result.issues;
}

/**
 * The host loading a plugin built by another copy of facetdb/plugin, whose manifest names `config`
 * as its schema and `secrets` as its secrets, made by hand rather than by `definePlugin`.
 */
function loadForged(config: Plugin["manifest"]["config"], secrets: readonly string[]) {
  const built = definePlugin({
    name: "leaky",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({ token: z.secret() }),
    actions: { send: action({ config: z.object({}), run: async () => undefined }) },
  });
  const forged = { ...built, manifest: { ...built.manifest, config, secrets } };
  return createPluginHost({
    config: facetdb({
      model: "jev-1.14.0",
      plugins: { leaky: { token: env("PAGER_TOKEN") } },
      sources: [
        { name: "tickets", api: true, read: ["body"], questions: { urgent: noul("Urgent?") } },
      ],
    }),
    env: ENV,
    projectDir: PROJECT_DIR,
    coreVersion: VERSION,
    importModule: (specifier) =>
      specifier === "facetdb-plugin-leaky"
        ? Promise.resolve({ default: forged })
        : Promise.reject(
            Object.assign(new Error(`Cannot find package '${specifier}'`), {
              code: "ERR_MODULE_NOT_FOUND",
            }),
          ),
    builtins: {},
  });
}

/** The lines a diff takes out and puts in, without its headers. */
const changes = (diff: string) => diff.split("\n").filter((line) => /^[-+][^-+]/.test(line));

const scratch: string[] = [];

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** The plan's file written into a project and read back by the real loader, then hosted and bound. */
async function writtenAndLoaded(written: ApplyPlan) {
  const dir = await mkdtemp(join(tmpdir(), "facetdb-apply-project-keys-"));
  scratch.push(dir);
  await mkdir(join(dir, "node_modules"));
  await symlink(packageDir, join(dir, "node_modules", "facetdb"));
  await writeFile(join(dir, PATH), written.after);
  const { config } = await loadConfig(PATH, {
    projectDir: dir,
    env: ENV,
    stderr: { write: () => true },
    quiet: true,
  });
  const host = await hostFor(config);
  return { config, host, bound: checkChannels(config, host, ENV, () => "UTC") };
}

describe("a project draft's alerts and plugins through Apply", () => {
  it("adds a channel with what it sends and its quiet hours: the diff shows it, and the written file loads and binds", async () => {
    const channels = [
      "pager:ops",
      {
        to: "pager:night",
        sends: "warnings",
        quiet: { from: "22:00", to: "07:00", zone: "Europe/Berlin" },
      },
    ] as const;
    const written = await plan({ alerts: { channels } });
    expect(changes(written.diff)).toEqual([
      '-  alerts: {"channels":["pager:ops"]},',
      `+  alerts: ${JSON.stringify({ channels })},`,
    ]);
    expect(written.warnings).toEqual([]);
    const loaded = await writtenAndLoaded(written);
    expect(loaded.config.alerts).toEqual({ channels });
    expect(loaded.config).toEqual({ ...FILE, alerts: { channels } });
    expect(loaded.bound.map((binding) => binding.address)).toEqual(["pager:ops", "pager:night"]);
  });

  it("changes a plugin's settings, each variable kept where the file names it, the other plugins untouched", async () => {
    const settings = { token: env("PAGER_TOKEN"), region: "us", mention: "@oncall" };
    const written = await plan({ plugins: { pager: settings } });
    expect(changes(written.diff)).toEqual([
      '-    "pager": { "token": env("PAGER_TOKEN"), "region": "eu" },',
      '+    "pager": { "token": env("PAGER_TOKEN"), "region": "us", "mention": "@oncall" },',
    ]);
    const loaded = await writtenAndLoaded(written);
    expect(loaded.config.plugins).toEqual({ ...FILE.plugins, pager: settings });
    // The host the worker would build from the written file runs the plugin with them.
    expect(loaded.host.contextFor("pager", new AbortController().signal).config).toEqual({
      token: PAGER_TOKEN,
      region: "us",
      mention: "@oncall",
    });
  });

  it("routes alerts to a webhook endpoint the file names, never to one a draft adds: endpoints are where data goes", async () => {
    const written = await plan({ alerts: { channels: ["pager:ops", "webhook:ops"] } });
    const loaded = await writtenAndLoaded(written);
    expect(loaded.bound.map((binding) => binding.address)).toEqual(["pager:ops", "webhook:ops"]);
    // The built-in webhook marks nothing editable: a new endpoint is the operator's to add.
    const endpoints = { ops: "https://hooks.example/ops", data: "https://attacker.example/in" };
    const added = await refused({
      alerts: { channels: ["pager:ops", "webhook:data"] },
      plugins: { webhook: { secret: env("FACETDB_WEBHOOK_SECRET"), endpoints } },
    });
    expect(added).toEqual([
      {
        path: "plugins.webhook.endpoints.data",
        message:
          "a draft cannot change plugins.webhook.endpoints.data: the plugin \"@facetdb/webhook\" does not mark it as a setting the studio may change (z.editable()), and a plugin's setting can decide where it sends its credential or your records' data; edit plugins.webhook.endpoints.data in facetdb.config.ts by hand",
      },
    ]);
    expect(JSON.stringify(added)).not.toContain("attacker.example");
    // Without the endpoint the same channel is the loader's refusal, before any diff.
    const issues = await refused({ alerts: { channels: ["pager:ops", "webhook:data"] } });
    expect(issues).toEqual([
      {
        path: "alerts",
        message: expect.stringContaining(
          "plugins.webhook.endpoints has no endpoint named data",
        ) as string,
      },
    ]);
  });

  it("takes every channel out with null, and the file loads with no alerts", async () => {
    const written = await plan({ alerts: null });
    expect(changes(written.diff)).toEqual(['-  alerts: {"channels":["pager:ops"]},']);
    const loaded = await writtenAndLoaded(written);
    expect(loaded.config.alerts).toBeUndefined();
    expect(loaded.bound).toEqual([]);
  });

  it("judges a draft that changes only the spending cap exactly as before, with or without the plugins", async () => {
    const withPlugins = await plan({ spendingCap: 5_000_000 });
    const without = planApply(
      { path: PATH, text: TEXT, config: FILE },
      { project: { spendingCap: 5_000_000 } },
      ENV,
    );
    expect(without.ok && without.plan).toEqual(withPlugins);
    expect(changes(withPlugins.diff)).toEqual(["+  spendingCap: 5000000,"]);
  });

  it("writes what the diff showed, and refuses a file changed on disk since (plan_changed)", async () => {
    const shown = await plan({ alerts: { channels: ["pager:ops", "pager:data"] } });
    const disk = { text: TEXT, writes: [] as string[] };
    const files: ConfigFiles = {
      read: () => Promise.resolve({ kind: "file", text: disk.text }),
      replace: (_path, text) => {
        disk.writes.push(text);
        disk.text = text;
        return Promise.resolve();
      },
      gitState: () => Promise.resolve({ kind: "clean" }),
    };
    disk.text = `${TEXT}// edited by hand\n`;
    expect(await apply(shown, { force: false, files })).toEqual({ kind: "moved" });
    disk.text = TEXT;
    expect(await apply(shown, { force: false, files })).toEqual({ kind: "written" });
    expect(disk.writes).toEqual([shown.after]);
  });
});

describe("what a project draft still cannot do, each in its own words", () => {
  it("never changes which variable a secret reads, in the same words whether the other is set or not", async () => {
    const draft = { plugins: { pager: { token: env("AWS_SECRET_ACCESS_KEY"), region: "eu" } } };
    const issues = await refused(draft);
    expect(issues).toEqual([
      {
        path: "plugins.pager.token",
        message:
          "a draft cannot change which variable plugins.pager.token reads: facetdb.config.ts names PAGER_TOKEN there, and the variable a plugin reads is named in facetdb.config.ts by hand",
      },
    ]);
    const { AWS_SECRET_ACCESS_KEY: _unset, ...withoutIt } = ENV;
    expect(await refused(draft, withoutIt)).toEqual(issues);
  });

  it("never makes a setting read a variable the file does not name there, nor moves one", async () => {
    expect(
      await refused({
        plugins: {
          pager: { token: env("PAGER_TOKEN"), region: "eu", mention: env("AWS_SECRET_ACCESS_KEY") },
        },
      }),
    ).toEqual([
      {
        path: "plugins.pager.mention",
        message: expect.stringContaining(
          "a draft cannot make plugins.pager.mention read a variable",
        ) as string,
      },
    ]);
    // The secret the file names, moved where the plugin would send it as a mention.
    expect(
      await refused({
        plugins: {
          pager: { token: env("PAGER_TOKEN"), region: "eu", mention: env("PAGER_TOKEN") },
        },
      }),
    ).toEqual([expect.objectContaining({ path: "plugins.pager.mention" })]);
  });

  it("reads no variable the file does not name, whatever the draft says", async () => {
    const drafts: ProjectDraft[] = [
      { plugins: { pager: { token: env("AWS_SECRET_ACCESS_KEY"), region: "eu" } } },
      {
        plugins: {
          pager: { token: env("PAGER_TOKEN"), region: "eu", mention: env("AWS_SECRET_ACCESS_KEY") },
        },
      },
      { plugins: { webhook: { secret: env("AWS_SECRET_ACCESS_KEY") } } },
      {
        alerts: { channels: ["pager:ops"] },
        plugins: { solar: { key: env("AWS_SECRET_ACCESS_KEY"), endpoint: "x" } },
      },
    ];
    const host = await hostFor(FILE);
    for (const draft of drafts) {
      const seen = watched(ENV);
      const result = await planned(draft, seen.env, host);
      expect(result.ok).toBe(false);
      expect([...seen.read]).not.toContain("AWS_SECRET_ACCESS_KEY");
    }
    // The watch sees what a draft the worker takes does read: the variables the file names.
    const taken = watched(ENV);
    const result = await planned(
      { plugins: { pager: { token: env("PAGER_TOKEN"), region: "us" } } },
      taken.env,
      host,
    );
    expect(result.ok).toBe(true);
    expect(taken.read).toContain("PAGER_TOKEN");
    expect([...taken.read]).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  it("never puts a value at a path the plugin's schema marks secret, nor repeats it", async () => {
    const literal = "pgr_literal-SECRETVALUE";
    const issues = await refused({ plugins: { pager: { token: literal, region: "eu" } } });
    expect(issues).toEqual([
      {
        path: "plugins.pager.token",
        message:
          'a draft cannot put a value at plugins.pager.token: it is a secret of the plugin "facetdb-plugin-pager", and a secret is read from an environment variable that facetdb.config.ts names, never written in it; name its variable in facetdb.config.ts by hand, such as env("PAGER_TOKEN")',
      },
    ]);
    // A secret the schema marks under a name no rule of the file reads as one: the same words.
    const hook = await refused({
      plugins: { webhook: { secret: literal, endpoints: { ops: "https://hooks.example/ops" } } },
    });
    expect(hook).toEqual([expect.objectContaining({ path: "plugins.webhook.secret" })]);
    expect(hook[0]?.message).toContain("a draft cannot put a value at plugins.webhook.secret");
  });

  it("never names a plugin this worker does not run", async () => {
    expect(await refused({ plugins: { github: { repo: "acme/web" } } })).toEqual([
      {
        path: "plugins.github",
        message:
          'a draft changes the settings of a plugin this worker runs, and "github" is not one: it is not installed here, or facetdb.config.ts did not name it when the worker started; run facetdb add github on the worker\'s machine, name it in facetdb.config.ts by hand and restart facetdb worker',
      },
    ]);
    // A key no plugin can have is the schema's to refuse: no command is built from it.
    const odd = await refused({ plugins: { "pager; rm -rf ~": { region: "eu" } } });
    expect(odd).toEqual([
      expect.objectContaining({
        message: expect.stringContaining("a plugin is named by its short name"),
      }),
    ]);
    expect(JSON.stringify(odd)).not.toContain("facetdb add");
  });

  it("never changes a setting the plugin does not mark z.editable(): one that marks none has every setting refused", async () => {
    const issues = await refused({
      plugins: {
        relay: {
          token: env("RELAY_TOKEN"),
          url: "https://attacker.example/collect",
          retries: 9,
          labels: ["urgent"],
        },
      },
    });
    expect(issues.map((issue) => issue.path)).toEqual([
      "plugins.relay.url",
      "plugins.relay.retries",
      "plugins.relay.labels[0]",
    ]);
    for (const issue of issues) {
      expect(issue.message).toContain('the plugin "facetdb-plugin-relay" does not mark it');
      expect(issue.message).toContain("where it sends its credential or your records' data");
    }
    expect(JSON.stringify(issues)).not.toContain("attacker.example");
    // Settings left as the file writes them, or a key taken out of an entry, are no change of a
    // marked setting either way: the second is refused like any other.
    expect(
      await refused({
        plugins: { relay: { token: env("RELAY_TOKEN"), url: "https://relay.example/in" } },
      }),
    ).toEqual([expect.objectContaining({ path: "plugins.relay.retries" })]);
    // A marked setting changes beside unmarked ones left as they are.
    expect(
      (
        await planned({
          plugins: { pager: { token: env("PAGER_TOKEN"), region: "us", mention: "@oncall" } },
        })
      ).ok,
    ).toBe(true);
  });

  it("refuses the z.editable() mark on a secret, or on what holds one, when the plugin is defined and when it is loaded", async () => {
    for (const config of [
      z.object({ token: z.editable(z.secret()) }),
      z.object({ auth: z.editable(z.object({ user: z.string(), password: z.secret() })) }),
    ]) {
      expect(() =>
        definePlugin({
          name: "leaky",
          version: "1.0.0",
          facetdb: "*",
          config,
          actions: { send: action({ config: z.object({}), run: async () => undefined }) },
        }),
      ).toThrow(/a z\.editable\(\) setting is a z\.secret\(\), holds one/);
    }
    // A plugin built by another copy of facetdb/plugin, its manifest made by hand: refused at load.
    await expect(
      loadForged(z.object({ token: z.editable(z.secret()) }), ["token"]),
    ).rejects.toMatchObject({
      name: "PluginHostError",
      code: "plugin-invalid",
      message: expect.stringContaining(
        "a z.editable() setting is a z.secret(), holds one",
      ) as string,
    });
  });

  it("refuses the mark where its path would reach past the setting: an object's catchall, one option of a union or an intersection", async () => {
    const catchall = /on an object's catchall, or inside it, would cover every key at that level/;
    const option = /inside one option of a union or an intersection would cover the same place/;
    const cases = [
      [
        z.object({ hooks: z.object({ url: z.string() }).catchall(z.editable(z.string())) }),
        "config.hooks.*",
        catchall,
      ],
      [
        z.object({
          hooks: z
            .object({ url: z.string() })
            .catchall(z.object({ label: z.editable(z.string()) })),
        }),
        "config.hooks.*.label",
        catchall,
      ],
      [
        z.object({ target: z.union([z.editable(z.string()), z.object({ url: z.string() })]) }),
        "config.target",
        option,
      ],
      [
        z.object({
          target: z.object({ url: z.string() }).and(z.object({ label: z.editable(z.string()) })),
        }),
        "config.target.label",
        option,
      ],
    ] as const;
    for (const [config, field, words] of cases) {
      let caught: unknown;
      try {
        definePlugin({
          name: "wide",
          version: "1.0.0",
          facetdb: "*",
          config,
          actions: { send: action({ config: z.object({}), run: async () => undefined }) },
        });
      } catch (error) {
        caught = error;
      }
      expect(caught, field).toBeInstanceOf(PluginError);
      expect((caught as PluginError).issues).toEqual([
        { field, message: expect.stringMatching(words) as string },
      ]);
    }
    // At load too, for a manifest made by hand.
    await expect(
      loadForged(
        z.object({ token: z.secret(), target: z.union([z.editable(z.string()), z.number()]) }),
        ["token"],
      ),
    ).rejects.toMatchObject({
      code: "plugin-invalid",
      message: expect.stringMatching(option) as string,
    });
    // Where the path is the setting's own, the mark holds: a record's values, a whole union.
    expect(() =>
      definePlugin({
        name: "narrow",
        version: "1.0.0",
        facetdb: "*",
        config: z.object({
          teams: z.record(z.string(), z.editable(z.string())),
          mode: z.editable(z.union([z.literal("calm"), z.literal("loud")])),
        }),
        actions: { send: action({ config: z.object({}), run: async () => undefined }) },
      }),
    ).not.toThrow();
  });

  it("never changes the settings of the plugin that supplies the model provider, as modelUrl stays the operator's", async () => {
    expect(
      await refused({
        plugins: { solar: { key: env("SOLAR_KEY"), endpoint: "https://elsewhere.example/v1" } },
      }),
    ).toEqual([
      {
        path: "plugins.solar",
        message: expect.stringContaining(
          'a draft cannot change the settings of the plugin "facetdb-plugin-solar": it supplies the model provider',
        ) as string,
      },
    ]);
    expect(await refused({ modelUrl: "https://elsewhere.example" })).toEqual([
      expect.objectContaining({ path: "modelUrl" }),
    ]);
  });

  it("refuses a draft the loader would not load, in the loader's words, before any diff", async () => {
    const cases: [ProjectDraft, string, string][] = [
      [
        { alerts: { channels: ["pager:ops", "slack:#ops"] } },
        "alerts",
        'alerts.channels[1] (slack:#ops) names the channel "slack", and no plugin of that name was loaded when this worker started',
      ],
      [
        { alerts: { channels: ["pager:Ops"] } },
        "alerts",
        'alerts.channels[0] (pager:Ops) is refused by the plugin "facetdb-plugin-pager": a pager service is lowercase',
      ],
      [
        { alerts: { channels: ["pager:nowhere"] } },
        "alerts",
        "alerts.channels[0] (pager:nowhere) cannot be delivered to: the pager has no service called nowhere",
      ],
      [
        { plugins: { pager: { token: env("PAGER_TOKEN"), region: "mars" } } },
        "plugins",
        'the settings of the plugin "facetdb-plugin-pager" are refused by its schema',
      ],
      [
        { alerts: { channels: ["pager:ops", "pager:ops"] } },
        "alerts.channels",
        "pager:ops is named twice",
      ],
    ];
    for (const [draft, path, words] of cases) {
      const issues = await refused(draft);
      expect(issues, JSON.stringify(draft)).toEqual([
        {
          path: expect.stringContaining(path) as string,
          message: expect.stringContaining(words) as string,
        },
      ]);
    }
  });

  it("keeps a source's actions and where filter, and the project's sources, hand edits", () => {
    const result = planApply(
      { path: PATH, text: TEXT, config: FILE },
      { project: { sources: [] } },
      ENV,
    );
    expect(!result.ok && result.issues).toEqual([
      expect.objectContaining({ path: "sources", message: expect.stringContaining("by hand") }),
    ]);
  });
});
