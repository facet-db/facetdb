import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ZodObject, ZodType } from "zod";
import * as mini from "zod/mini";
import { noul, score } from "../config/index.ts";
import { VERSION } from "../index.ts";
import { PLUGIN_BRAND, shortName } from "./define.ts";
import {
  action,
  channel,
  definePlugin,
  type Infer,
  loadPlugin,
  type Plugin,
  type PluginContext,
  PluginError,
  pack,
  provider,
  satisfies,
  source,
  z,
} from "./index.ts";
import { type SecretStop, SecretWalkError, secretPaths } from "./zod.ts";

/** The GitHub plugin skeleton, with the manifest fields it leaves out. */
const githubConfig = z.object({ repo: z.string(), token: z.secret() });
type GithubContext = PluginContext<Infer<typeof githubConfig>>;

function githubPlugin() {
  return definePlugin({
    name: "github",
    version: "1.2.0",
    facetdb: ">=0.0.0 <1.0.0",
    config: githubConfig,
    sources: {
      issues: source({
        watch: async function* (ctx: GithubContext) {
          yield [`${ctx.config.repo}#1`];
        },
        read: async (ctx: GithubContext, keys) =>
          keys.map((key) => ({ key, state: { title: ctx.config.repo, body: "" } })),
        scan: async function* () {
          yield { rows: [], next: null };
        },
      }),
    },
    actions: {
      label: action({
        config: z.object({ add: z.array(z.string()), remove: z.array(z.string()).optional() }),
        run: async (ctx: GithubContext, record, decisions, cfg) => {
          // The author's types: the plugin config in ctx, the action's own settings in cfg.
          expect(typeof ctx.config.repo).toBe("string");
          expect(cfg.add).toBeInstanceOf(Array);
          expect(record.key).toBeDefined();
          expect(decisions).toBeDefined();
        },
      }),
    },
  });
}

describe("facetdb/plugin as a consumer sees it", () => {
  it("resolves through the package's exports and exposes the authoring API", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, string> };
    expect(manifest.exports["./plugin"]).toBe("./src/plugin/index.ts");

    const consumer = await import("facetdb/plugin");
    for (const name of ["definePlugin", "source", "action", "channel", "provider", "pack", "z"]) {
      expect(consumer).toHaveProperty(name);
    }
    expect(typeof consumer.definePlugin).toBe("function");
  });
});

describe("definePlugin", () => {
  it("accepts the GitHub skeleton and derives the manifest", () => {
    const plugin = githubPlugin();
    expect(plugin.manifest).toMatchObject({
      name: "github",
      version: "1.2.0",
      kinds: ["source", "action"],
      secrets: ["token"],
      coreVersions: ">=0.0.0 <1.0.0",
    });
    expect(Object.keys(plugin.sources)).toEqual(["issues"]);
    expect(Object.keys(plugin.actions)).toEqual(["label"]);
    // One schema for both audiences: the manifest carries the very schema that validates the config.
    expect(plugin.manifest.config.safeParse({ repo: "a/b", token: "t" }).success).toBe(true);
    expect(plugin.manifest.config.safeParse({ repo: "a/b" }).success).toBe(false);
  });

  it("lists secrets through optional wrappers and leaves plain strings out", () => {
    const plugin = definePlugin({
      name: "facetdb-plugin-chat",
      version: "0.1.0",
      facetdb: "^0.0.0",
      config: z.object({ channel: z.string(), webhook: z.secret().optional(), token: z.secret() }),
      channels: {
        post: channel({ config: z.object({}), deliver: async () => {} }),
      },
    });
    expect(plugin.manifest.secrets).toEqual(["webhook", "token"]);
    expect(plugin.manifest.kinds).toEqual(["channel"]);
  });

  it("lists secrets by dotted path through every wrapper and nested object", () => {
    const plugin = definePlugin({
      name: "chat",
      version: "0.1.0",
      facetdb: "^0.0.0",
      config: z.object({
        channel: z.string(),
        direct: z.secret(),
        optional: z.secret().optional(),
        nullable: z.secret().nullable(),
        defaulted: z.secret().default("x"),
        piped: z.secret().pipe(z.string()),
        transformed: z.secret().transform((value) => value.trim()),
        auth: z.object({
          user: z.string(),
          password: z.secret(),
          deeper: z.object({ key: z.secret().optional() }).optional(),
        }),
        maybe: z.object({ token: z.secret() }).nullable().default({ token: "t" }),
      }),
      channels: { post: channel({ config: z.object({}), deliver: async () => {} }) },
    });
    expect(plugin.manifest.secrets).toEqual([
      "direct",
      "optional",
      "nullable",
      "defaulted",
      "piped",
      "transformed",
      "auth.password",
      "auth.deeper.key",
      "maybe.token",
    ]);
  });

  it.each([
    ["an array of secrets", z.object({ tokens: z.array(z.secret()) }), ["tokens[]"]],
    [
      "an array of objects",
      z.object({ hooks: z.array(z.object({ url: z.string(), secret: z.secret() })) }),
      ["hooks[].secret"],
    ],
    ["an array of arrays", z.object({ grid: z.array(z.array(z.secret())) }), ["grid[][]"]],
    [
      "a tuple, its slots and its rest",
      z.object({ pair: z.tuple([z.string(), z.secret()], z.secret()) }),
      ["pair[1]", "pair[]"],
    ],
    ["a record of secrets", z.object({ headers: z.record(z.string(), z.secret()) }), ["headers.*"]],
    [
      "a record of objects",
      z.object({ accounts: z.record(z.string(), z.object({ key: z.secret() })) }),
      ["accounts.*.key"],
    ],
    ["an object with a catchall", z.object({ known: z.string() }).catchall(z.secret()), ["*"]],
    [
      "a union",
      z.object({
        auth: z.union([z.object({ token: z.secret() }), z.object({ user: z.string() })]),
      }),
      ["auth.token"],
    ],
    [
      "a discriminated union, a secret in two variants once",
      z.object({
        auth: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("token"), value: z.secret() }),
          z.object({ kind: z.literal("basic"), value: z.secret(), user: z.string() }),
          z.object({ kind: z.literal("none") }),
        ]),
      }),
      ["auth.value"],
    ],
    [
      "an intersection",
      z.object({ both: z.intersection(z.object({ a: z.secret() }), z.object({ b: z.string() })) }),
      ["both.a"],
    ],
    [
      "a lazy schema that does not contain itself",
      z.object({ later: z.lazy(() => z.object({ token: z.secret() })) }),
      ["later.token"],
    ],
    [
      "the other wrappers",
      z.object({
        a: z.array(z.secret()).optional(),
        b: z.array(z.secret()).readonly(),
        c: z.secret().catch("x"),
        d: z.secret().prefault("x"),
        e: z.secret().optional().nonoptional(),
        f: z.success(z.secret()),
      }),
      ["a[]", "b[]", "c", "d", "e", "f"],
    ],
  ])("lists a secret nested in %s", (_shape, config, expected) => {
    expect(secretPaths(config)).toEqual(expected);
    const plugin = definePlugin({
      name: "chat",
      version: "0.1.0",
      facetdb: "^0.0.0",
      config,
      channels: { post: channel({ config: z.object({}), deliver: async () => {} }) },
    });
    expect(plugin.manifest.secrets).toEqual(expected);
  });

  it("walks a recursive schema once when it holds no secret", () => {
    const tree: ZodType = z.object({ label: z.string(), kids: z.array(z.lazy(() => tree)) });
    expect(secretPaths(z.object({ tree }))).toEqual([]);
    // The same schema in two places is listed in both.
    const leaf = z.object({ token: z.secret() });
    expect(secretPaths(z.object({ one: leaf, two: z.array(leaf) }))).toEqual([
      "one.token",
      "two[].token",
    ]);
  });

  it("refuses a recursive schema that holds a secret, naming the path it stopped at", () => {
    const node: ZodType = z.object({
      token: z.secret(),
      children: z.array(z.lazy(() => node)),
    });
    expect(() => secretPaths(z.object({ root: node }))).toThrow(SecretWalkError);
    const attempt = () =>
      definePlugin({
        name: "chat",
        version: "0.1.0",
        facetdb: "^0.0.0",
        config: z.object({ root: node }),
        channels: { post: channel({ config: z.object({}), deliver: async () => {} }) },
      });
    expect(attempt).toThrow(PluginError);
    expect(attempt).toThrow(/config\.root\.children\[\]: this schema contains itself/);
  });

  it("follows a zod/mini wrapper around a secret and refuses what is not a zod schema", () => {
    expect(secretPaths(z.object({ tokens: z.array(mini.optional(z.secret())) }))).toEqual([
      "tokens[]",
    ]);
    // A lazy getter that returns something else is a stop with its path, not a skipped field.
    const config = z.object({ later: z.lazy(() => ({}) as never) });
    const stops = (): readonly SecretStop[] => {
      try {
        secretPaths(config);
      } catch (error) {
        return (error as SecretWalkError).stops;
      }
      return [];
    };
    expect(stops().map((stop) => stop.path)).toEqual(["later"]);
    expect(stops()[0]?.message).toMatch(/not a zod schema/);
  });

  it("reads a lazy getter once, and refuses one that throws or never settles, without a raw error", () => {
    let calls = 0;
    const shared = z.lazy(() => {
      calls += 1;
      return z.object({ token: z.secret() });
    });
    expect(secretPaths(z.object({ one: shared, two: shared }))).toEqual(["one.token", "two.token"]);
    expect(calls).toBe(1);

    // A getter that builds a new schema on each read has no cycle to find; the depth cap ends it.
    const fresh = (): ZodType => z.object({ token: z.secret(), next: z.lazy(fresh) });
    const endless = () => secretPaths(z.object({ root: z.lazy(fresh) }));
    expect(endless).toThrow(SecretWalkError);
    expect(endless).toThrow(/nests more than \d+ levels deep, or a z\.lazy builds a new schema/);

    const broken = z.object({
      bad: z.lazy(() => {
        throw new Error("boom");
      }),
    });
    const fresh1 = z.object({
      bad: z.lazy(() => {
        throw new Error("boom");
      }),
    });
    expect(() => secretPaths(fresh1)).toThrow(/bad: .*the getter of this z\.lazy threw \(boom\)/);
    const attempt = () =>
      definePlugin({
        name: "chat",
        version: "0.1.0",
        facetdb: "^0.0.0",
        config: broken,
        channels: { post: channel({ config: z.object({}), deliver: async () => {} }) },
      });
    expect(attempt).toThrow(PluginError);
    // zod answers `undefined` to every later read of a getter that failed: still a stop, not a skip.
    expect(attempt).toThrow(/config\.bad: a secret could hide here: the getter of this z\.lazy/);
  });

  it.each([
    ["a map", z.object({ tags: z.map(z.string(), z.secret()) }), "tags"],
    ["a set", z.object({ deep: z.object({ keys: z.set(z.secret()) }) }), "deep.keys"],
    ["a promise", z.object({ later: z.promise(z.secret()) }), "later"],
  ])("refuses %s: a secret could hide where the walker cannot look", (_shape, config, path) => {
    const attempt = () =>
      definePlugin({
        name: "chat",
        version: "0.1.0",
        facetdb: "^0.0.0",
        config,
        channels: { post: channel({ config: z.object({}), deliver: async () => {} }) },
      });
    expect(attempt).toThrow(PluginError);
    expect(attempt).toThrow(
      new RegExp(
        `config\\.${path}: a secret could hide here: this schema has a shape FacetDB cannot look inside; describe the setting with object, array`,
      ),
    );
  });

  it("refuses a missing config schema and names the field", () => {
    const withoutConfig = {
      name: "github",
      version: "1.0.0",
      facetdb: "^0.0.0",
      actions: { label: action({ config: z.object({}), run: async () => {} }) },
    };
    expect(() => definePlugin(withoutConfig as never)).toThrow(PluginError);
    expect(() => definePlugin(withoutConfig as never)).toThrow(/config: is missing/);
    const issues = catchIssues(() => definePlugin(withoutConfig as never));
    expect(issues.map((issue) => issue.field)).toEqual(["config"]);
  });

  it("refuses a config that is not an object schema", () => {
    const issues = catchIssues(() =>
      definePlugin({
        name: "github",
        version: "1.0.0",
        facetdb: "^0.0.0",
        config: z.string() as never,
        packs: { triage: pack({ questions: { urgent: noul("Is it urgent?") } }) },
      }),
    );
    expect(issues).toEqual([{ field: "config", message: expect.stringContaining("z.object") }]);
  });

  it("refuses a bad version, a bad core range and a bad name, each by field", () => {
    const issues = catchIssues(() =>
      definePlugin({
        name: "GitHub Plugin",
        version: "one",
        facetdb: "latest",
        config: z.object({}),
        packs: { triage: pack({ questions: { urgent: noul("Is it urgent?") } }) },
      }),
    );
    expect(issues.map((issue) => issue.field)).toEqual(["name", "version", "facetdb"]);
  });

  it("refuses a plugin that provides nothing", () => {
    const issues = catchIssues(() =>
      definePlugin({ name: "empty", version: "1.0.0", facetdb: "^0.0.0", config: z.object({}) }),
    );
    expect(issues[0]?.message).toContain("at least one of sources, actions");
  });

  it("refuses an entry that was not made by its helper, or lacks its function or settings schema", () => {
    const issues = catchIssues(() =>
      definePlugin({
        name: "broken",
        version: "1.0.0",
        facetdb: "^0.0.0",
        config: z.object({}),
        sources: { Issues: { watch: () => {} } as never },
        actions: {
          label: action({ config: z.object({}), run: undefined as never }),
          other: { kind: "action", run: async () => {} } as never,
        },
        providers: {
          model: provider({ config: undefined as never, ask: undefined as never }),
        },
      }),
    );
    expect(issues.map((issue) => issue.field)).toEqual([
      "sources.Issues",
      "sources.Issues",
      "actions.label.run",
      "actions.other.config",
      "providers.model.ask",
      "providers.model.config",
    ]);
  });

  it("takes a channel's optional check as a function, and refuses one that is not", () => {
    const deliver = async () => {};
    const plugin = definePlugin({
      name: "chat",
      version: "1.0.0",
      facetdb: "^0.0.0",
      config: z.object({}),
      channels: {
        post: channel({ config: z.object({}), check: () => undefined, deliver }),
        bare: channel({ config: z.object({}), deliver }),
      },
    });
    expect(typeof plugin.channels["post"]?.check).toBe("function");
    expect(plugin.channels["bare"]?.check).toBeUndefined();
    const issues = catchIssues(() =>
      definePlugin({
        name: "chat",
        version: "1.0.0",
        facetdb: "^0.0.0",
        config: z.object({}),
        channels: { post: channel({ config: z.object({}), check: "no" as never, deliver }) },
      }),
    );
    expect(issues).toEqual([
      { field: "channels.post.check", message: "must be a function, or be left out" },
    ]);
  });

  it("checks a question pack with the config's own question rules", () => {
    const good = definePlugin({
      name: "triage",
      version: "1.0.0",
      facetdb: "^0.0.0",
      config: z.object({}),
      packs: {
        support: pack({
          description: "Support triage",
          questions: {
            urgency: score("How urgent is it?", ["low", "high"], {
              thresholds: { confidenceAtLeast: 0.6 },
            }),
            wants_refund: noul("Is the customer asking for money back?", { stakes: "high" }),
          },
        }),
      },
    });
    expect(good.packs["support"]?.questions.map((q) => q.name)).toEqual([
      "urgency",
      "wants_refund",
    ]);
    expect(good.packs["support"]?.thresholds).toEqual({ urgency: { confidenceAtLeast: 0.6 } });

    const issues = catchIssues(() =>
      definePlugin({
        name: "triage",
        version: "1.0.0",
        facetdb: "^0.0.0",
        config: z.object({}),
        packs: { support: pack({ questions: { facetdb_x: noul("Is it a reserved name?") } }) },
      }),
    );
    expect(issues).toEqual([
      { field: "packs.support", message: expect.stringContaining("facetdb_x") },
    ]);
  });
});

describe("loadPlugin", () => {
  const modules = (known: Record<string, unknown>) => ({
    coreVersion: VERSION,
    importModule: async (specifier: string): Promise<unknown> => {
      if (specifier in known) {
        return known[specifier];
      }
      throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
        code: "ERR_MODULE_NOT_FOUND",
      });
    },
  });

  it("resolves a short name to @facetdb/<name>, then to facetdb-plugin-<name>", async () => {
    const plugin = githubPlugin();
    expect(await loadPlugin("github", modules({ "@facetdb/github": { default: plugin } }))).toBe(
      plugin,
    );
    expect(
      await loadPlugin("github", modules({ "facetdb-plugin-github": { default: plugin } })),
    ).toBe(plugin);
    expect(
      await loadPlugin(
        "facetdb-plugin-github",
        modules({ "facetdb-plugin-github": { default: plugin } }),
      ),
    ).toBe(plugin);
  });

  it("refuses a plugin whose core range excludes the running version, naming the field", async () => {
    const future = definePlugin({
      name: "github",
      version: "3.0.0",
      facetdb: "^2.0.0",
      config: z.object({}),
      packs: { triage: pack({ questions: { urgent: noul("Is it urgent?") } }) },
    });
    const attempt = loadPlugin("github", modules({ "@facetdb/github": { default: future } }));
    await expect(attempt).rejects.toThrow(
      /facetdb: supports FacetDB \^2\.0\.0, but this is FacetDB 0\.0\.0/,
    );
    const error = await attempt.catch((caught: unknown) => caught);
    expect((error as PluginError).issues.map((issue) => issue.field)).toEqual(["facetdb"]);
  });

  it("says what to do when no package is installed, when the name is wrong and when the export is not a plugin", async () => {
    await expect(loadPlugin("github", modules({}))).rejects.toThrow(/run `facetdb add github`/);
    await expect(loadPlugin("./local/thing", modules({}))).rejects.toThrow(
      /name: a plugin is named/,
    );
    await expect(
      loadPlugin("github", modules({ "@facetdb/github": { default: { name: "github" } } })),
    ).rejects.toThrow(/default export: is not a plugin/);
    await expect(
      loadPlugin("slack", modules({ "@facetdb/slack": { default: githubPlugin() } })),
    ).rejects.toThrow(/calls itself "github", not "slack"/);
  });

  it("re-checks the manifest of a branded object, naming the field and printing no stack", async () => {
    const forged = (manifest: unknown) => ({
      [PLUGIN_BRAND]: true,
      manifest,
      sources: {},
      actions: {},
      channels: {},
      providers: {},
      packs: {},
    });
    const good = githubPlugin().manifest;
    const fields = async (manifest: unknown) => {
      const error = await loadPlugin(
        "github",
        modules({ "@facetdb/github": { default: forged(manifest) } }),
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).message).not.toMatch(/\n\s+at /);
      return (error as PluginError).issues.map((issue) => issue.field);
    };
    expect(await fields(undefined)).toEqual(["manifest"]);
    expect(await fields({ ...good, version: "one" })).toEqual(["version"]);
    expect(await fields({ ...good, coreVersions: undefined })).toEqual(["facetdb"]);
    expect(await fields({ ...good, config: {} })).toEqual(["config"]);
    expect(await fields({ ...good, kinds: ["database"] })).toEqual(["kinds"]);
    expect(await fields({ ...good, secrets: [1] })).toEqual(["secrets"]);
    expect(await fields({ ...good, name: 7, version: undefined })).toEqual(["name", "version"]);
  });

  it("binds a manifest's name to the package it was loaded from", async () => {
    const named = (name: string) =>
      definePlugin({
        name,
        version: "1.0.0",
        facetdb: "^0.0.0",
        config: z.object({}),
        packs: { triage: pack({ questions: { urgent: noul("Is it urgent?") } }) },
      });
    // `@facetdb/github` loads only from a package named `@facetdb/github`.
    await expect(
      loadPlugin(
        "github",
        modules({ "facetdb-plugin-github": { default: named("@facetdb/github") } }),
      ),
    ).rejects.toThrow(/name: .*"@facetdb\/github", the name of a different package/);
    await expect(
      loadPlugin(
        "facetdb-plugin-github",
        modules({ "facetdb-plugin-github": { default: named("@facetdb/github") } }),
      ),
    ).rejects.toThrow(PluginError);
    await expect(
      loadPlugin(
        "github",
        modules({ "@facetdb/github": { default: named("facetdb-plugin-github") } }),
      ),
    ).rejects.toThrow(/different package/);
    for (const [spec, packageName, declared] of [
      ["github", "@facetdb/github", "@facetdb/github"],
      ["github", "@facetdb/github", "github"],
      ["github", "facetdb-plugin-github", "github"],
      ["github", "facetdb-plugin-github", "facetdb-plugin-github"],
    ] as const) {
      const plugin = named(declared);
      expect(await loadPlugin(spec, modules({ [packageName]: { default: plugin } }))).toBe(plugin);
    }
  });

  it("does not normalise a prefix found in the middle of a name", async () => {
    expect(shortName("facetdb-plugin-gi@facetdb/thub")).toBeUndefined();
    expect(shortName("gi@facetdb/thub")).toBeUndefined();
    expect(shortName("@facetdb/facetdb-plugin-github")).toBe("facetdb-plugin-github");
    expect(shortName("facetdb-plugin-github")).toBe("github");
    expect(() =>
      definePlugin({
        name: "facetdb-plugin-gi@facetdb/thub",
        version: "1.0.0",
        facetdb: "^0.0.0",
        config: z.object({}),
        packs: { triage: pack({ questions: { urgent: noul("Is it urgent?") } }) },
      }),
    ).toThrow(/name: must be the short name/);
    await expect(loadPlugin("facetdb-plugin-gi@facetdb/thub", modules({}))).rejects.toThrow(
      /name: a plugin is named/,
    );
  });

  it("lets a plugin that breaks while loading fail as itself", async () => {
    const options = {
      coreVersion: VERSION,
      importModule: async () => {
        throw new SyntaxError("unexpected token");
      },
    };
    await expect(loadPlugin("github", options)).rejects.toThrow(SyntaxError);
  });

  /** A plugin as an older copy of `facetdb/plugin` wrote it, or a forger: the same object, one field changed. */
  const nestedPlugin = () =>
    definePlugin({
      name: "chat",
      version: "0.1.0",
      facetdb: "^0.0.0",
      config: z.object({
        channel: z.string(),
        token: z.secret(),
        auth: z.object({ password: z.secret() }),
        hooks: z.array(z.object({ secret: z.secret() })),
      }),
      channels: { post: channel({ config: z.object({}), deliver: async () => {} }) },
    });
  const load = (plugin: unknown) =>
    loadPlugin("chat", modules({ "@facetdb/chat": { default: plugin } })).catch(
      (caught: unknown) => caught,
    );

  it("recomputes the secrets from the config schema, so a loaded plugin's list always equals it", async () => {
    const plugin = nestedPlugin();
    const loaded = await loadPlugin("chat", modules({ "@facetdb/chat": { default: plugin } }));
    expect(loaded.manifest.secrets).toEqual(secretPaths(loaded.manifest.config as ZodObject));
    expect(loaded.manifest.secrets).toEqual(["token", "auth.password", "hooks[].secret"]);
  });

  it("refuses a short list from an older plugin, naming the declared and the computed list", async () => {
    const plugin = nestedPlugin();
    const older = { ...plugin, manifest: { ...plugin.manifest, secrets: ["token"] } };
    const error = await load(older);
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).issues.map((issue) => issue.field)).toEqual(["secrets"]);
    expect((error as PluginError).message).toContain(
      "the plugin declares [token] but its config schema marks [token, auth.password, hooks[].secret] as z.secret()",
    );
    expect((error as PluginError).message).toContain("rebuild the plugin");
    // A list that claims more than the schema holds is as wrong as one that claims less.
    const longer = {
      ...plugin,
      manifest: { ...plugin.manifest, secrets: [...plugin.manifest.secrets, "ghost"] },
    };
    expect(((await load(longer)) as PluginError).message).toMatch(/declares \[token, .*ghost\]/);
    const none = { ...plugin, manifest: { ...plugin.manifest, secrets: [] } };
    expect(((await load(none)) as PluginError).message).toMatch(/declares no secrets but/);
  });

  it("accepts a complete list in another order, or with a repeat, as the same set", async () => {
    const plugin = nestedPlugin();
    const reordered = {
      ...plugin,
      manifest: { ...plugin.manifest, secrets: ["hooks[].secret", "token", "auth.password"] },
    };
    expect(await load(reordered)).toBe(reordered);
    const repeated = {
      ...plugin,
      manifest: {
        ...plugin.manifest,
        secrets: ["token", "token", "auth.password", "hooks[].secret"],
      },
    };
    expect(await load(repeated)).toBe(repeated);
  });

  it("refuses a plugin whose config holds a shape the walker cannot read, with the path", async () => {
    const plugin = nestedPlugin();
    const config = z.object({ tags: z.map(z.string(), z.string()) });
    const error = await load({ ...plugin, manifest: { ...plugin.manifest, config, secrets: [] } });
    expect(error).toBeInstanceOf(PluginError);
    expect((error as PluginError).issues.map((issue) => issue.field)).toEqual(["config.tags"]);
    expect((error as PluginError).message).toMatch(/a secret could hide here/);
  });

  it("confirms every list of entries and every entry of a branded plugin", async () => {
    const plugin = nestedPlugin();
    const withEntries = (changes: Record<string, unknown>) => ({ ...plugin, ...changes });
    const fields = async (forged: unknown) => {
      const error = await load(forged);
      expect(error).toBeInstanceOf(PluginError);
      expect((error as PluginError).message).not.toMatch(/\n\s+at /);
      return (error as PluginError).issues.map((issue) => issue.field);
    };
    // A list that is missing, not an object, or an array.
    const { sources: _sources, ...withoutSources } = plugin;
    expect(await fields(withoutSources)).toEqual(["sources"]);
    expect(await fields(withEntries({ actions: "label" }))).toEqual(["actions"]);
    expect(await fields(withEntries({ packs: [] }))).toEqual(["packs"]);
    expect(await fields(withEntries({ providers: null }))).toEqual(["providers"]);
    // An entry that is not an object, or was not made by its helper, or lacks what the registry calls.
    expect(await fields(withEntries({ sources: { issues: "oops" } }))).toEqual(["sources.issues"]);
    expect(await fields(withEntries({ sources: { issues: { kind: "action" } } }))).toEqual([
      "sources.issues",
    ]);
    expect(
      await fields(withEntries({ sources: { issues: { kind: "source", watch() {} } } })),
    ).toEqual(["sources.issues.read", "sources.issues.scan"]);
    expect(
      await fields(withEntries({ channels: { post: { kind: "channel", deliver() {} } } })),
    ).toEqual(["channels.post.config"]);
    expect(
      await fields(withEntries({ channels: { "Bad Name": plugin.channels["post"] } })),
    ).toEqual(["channels.Bad Name"]);
    expect(
      await fields(withEntries({ packs: { triage: { kind: "pack", questions: {} } } })),
    ).toEqual(["packs.triage"]);
  });

  it("accepts the entries definePlugin made", async () => {
    const plugin = githubPlugin();
    const loaded = await loadPlugin("github", modules({ "@facetdb/github": { default: plugin } }));
    expect(loaded).toBe(plugin);
  });
});

describe("the core version range", () => {
  it.each([
    ["1.2.3", "^1.0.0", true],
    ["2.0.0", "^1.0.0", false],
    ["0.2.5", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["0.0.3", "^0.0.3", true],
    ["0.0.4", "^0.0.3", false],
    ["1.2.9", "~1.2.3", true],
    ["1.3.0", "~1.2.3", false],
    ["1.4.0", ">=1.2.0 <2.0.0", true],
    ["2.0.0", ">=1.2.0 <2.0.0", false],
    ["0.0.0", "*", true],
    ["1.9.9", "1.x", true],
    ["2.0.0", "1", false],
    ["1.2.7", "1.2", true],
    ["3.1.0", "^1.0.0 || ^3.0.0", true],
    ["2.1.0", "^1.0.0 || ^3.0.0", false],
    ["1.0.0", "1.0.0", true],
    ["1.0.1", "1.0.0", false],
    ["1.5.0-beta.1", "^1.0.0", false],
    ["1.5.0-beta.1", "^1.5.0-beta.0", true],
    ["1.0.0-rc.1", "<1.0.0", false],
  ])("%s in %s is %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it("reads an invalid range or version as not satisfied", () => {
    expect(satisfies("1.0.0", "latest")).toBe(false);
    expect(satisfies("1.0", "^1.0.0")).toBe(false);
    expect(satisfies("1.0.0", "1.0.0 - 2.0.0")).toBe(false);
  });
});

function catchIssues(define: () => Plugin): readonly { field: string; message: string }[] {
  try {
    define();
  } catch (error) {
    if (error instanceof PluginError) {
      return error.issues;
    }
    throw error;
  }
  throw new Error("definePlugin accepted a definition it should have refused");
}
