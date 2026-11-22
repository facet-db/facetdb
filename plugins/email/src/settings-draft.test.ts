import { configFileSource, env, facetdb, noul, planApply, VERSION } from "facetdb";
import { BUILTIN_PLUGINS, createPluginHost, draftPlugins, type Plugin } from "facetdb/plugin";
import { describe, expect, it } from "vitest";
import email from "./index.ts";

/**
 * The email plugin's settings from a studio draft: it marks none of them `z.editable()`. The
 * server, its port, TLS and the login decide where the password goes, and the sender's address
 * where the bounces and replies of every notification go (no envelope sender of its own), so a
 * draft that moves any of them (the password's variable kept) is refused before any diff, in words
 * that never repeat what it was given.
 */

const PASSWORD = "smtp-EMAILSECRETVALUE";
const ENV = { EMAIL_PASSWORD: PASSWORD };
const PROJECT_DIR = "/work/alerts";
const SETTINGS = {
  host: "smtp.example.com",
  port: 587,
  user: "alerts",
  password: env("EMAIL_PASSWORD"),
  from: "alerts@example.com",
};

const FILE = facetdb({
  model: "jev-1.14.0",
  alerts: { channels: ["email:ops@example.com"] },
  plugins: { email: SETTINGS },
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
      specifier === "@facetdb/email"
        ? Promise.resolve({ default: email as Plugin })
        : Promise.reject(Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" })),
    builtins: BUILTIN_PLUGINS,
  });
  return planApply(
    { path: "facetdb.config.ts", text: configFileSource(FILE), config: FILE },
    { project: { plugins: { email: settings } } },
    ENV,
    undefined,
    draftPlugins({ host: () => host, env: ENV, coreVersion: VERSION, projectDir: PROJECT_DIR }),
  );
}

describe("a studio draft of the email plugin's settings", () => {
  it("refuses the server, its port, TLS and the login moved, the password's variable kept", async () => {
    const result = await judged({
      ...SETTINGS,
      host: "smtp.attacker.example",
      port: 2525,
      secure: true,
      user: "someone-else",
    });
    expect(!result.ok && result.issues.map((issue) => issue.path)).toEqual([
      "plugins.email.host",
      "plugins.email.port",
      "plugins.email.user",
      "plugins.email.secure",
    ]);
    for (const issue of result.ok ? [] : result.issues) {
      expect(issue.message).toContain('the plugin "@facetdb/email" does not mark it');
    }
    expect(JSON.stringify(result)).not.toContain("attacker.example");
    expect(JSON.stringify(result)).not.toContain(PASSWORD);
  });

  it("refuses a new sender address too: the bounces and replies of every notification go to it", async () => {
    const result = await judged({ ...SETTINGS, from: "reviewer@attacker.example" });
    expect(result).toEqual({
      ok: false,
      issues: [
        {
          path: "plugins.email.from",
          message:
            "a draft cannot change plugins.email.from: the plugin \"@facetdb/email\" does not mark it as a setting the studio may change (z.editable()), and a plugin's setting can decide where it sends its credential or your records' data; edit plugins.email.from in facetdb.config.ts by hand",
        },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("attacker.example");
    // The settings as the file writes them change nothing, and are no refusal.
    expect(await judged(SETTINGS)).toMatchObject({ ok: true, plan: { changed: false } });
  });
});
