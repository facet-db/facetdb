import { configFileSource, env, facetdb, noul, planApply, VERSION } from "facetdb";
import { BUILTIN_PLUGINS, createPluginHost, draftPlugins, type Plugin } from "facetdb/plugin";
import { describe, expect, it } from "vitest";
import github from "./index.ts";

/**
 * The GitHub plugin's settings from a studio draft: the plugin marks none of them `z.editable()`,
 * so every one stays a hand edit. A draft that keeps the token's variable and moves `apiUrl` to
 * another server would have every request carry the token there; it is refused before any diff, in
 * words that name the setting and never repeat the address it was given.
 */

const TOKEN = "ghp_GITHUBSECRETVALUE0123456789abcdef";
const ENV = { GITHUB_TOKEN: TOKEN };
const PROJECT_DIR = "/work/triage";

const FILE = facetdb({
  model: "jev-1.14.0",
  plugins: { github: { token: env("GITHUB_TOKEN") } },
  sources: [
    { name: "tickets", api: true, read: ["body"], questions: { urgent: noul("Is it urgent?") } },
  ],
});

async function judged(settings: Readonly<Record<string, unknown>>) {
  const host = await createPluginHost({
    config: FILE,
    env: ENV,
    projectDir: PROJECT_DIR,
    coreVersion: VERSION,
    importModule: (specifier) =>
      specifier === "@facetdb/github"
        ? Promise.resolve({ default: github as Plugin })
        : Promise.reject(Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" })),
    builtins: BUILTIN_PLUGINS,
  });
  return planApply(
    { path: "facetdb.config.ts", text: configFileSource(FILE), config: FILE },
    { project: { plugins: { github: settings } } },
    ENV,
    undefined,
    draftPlugins({ host: () => host, env: ENV, coreVersion: VERSION, projectDir: PROJECT_DIR }),
  );
}

describe("a studio draft of the GitHub plugin's settings", () => {
  it("refuses apiUrl moved to another server with the token's variable kept, never repeating the address", async () => {
    const result = await judged({
      token: env("GITHUB_TOKEN"),
      apiUrl: "https://attacker.example/api/v3",
    });
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: "plugins.github.apiUrl",
          message:
            "a draft cannot change plugins.github.apiUrl: the plugin \"@facetdb/github\" does not mark it as a setting the studio may change (z.editable()), and a plugin's setting can decide where it sends its credential or your records' data; edit plugins.github.apiUrl in facetdb.config.ts by hand",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("attacker.example");
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("refuses a webhook secret added, and takes the settings as the file writes them", async () => {
    expect(
      await judged({ token: env("GITHUB_TOKEN"), webhookSecret: env("GITHUB_TOKEN") }),
    ).toMatchObject({ ok: false, issues: [{ path: "plugins.github.webhookSecret" }] });
    expect(await judged({ token: env("GITHUB_TOKEN") })).toMatchObject({
      ok: true,
      plan: { changed: false },
    });
  });
});
