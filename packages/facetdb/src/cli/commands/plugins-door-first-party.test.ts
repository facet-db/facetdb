import { FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import email from "../../../../../plugins/email/src/index.ts";
import github from "../../../../../plugins/github/src/index.ts";
import packs from "../../../../../plugins/packs/src/index.ts";
import slack from "../../../../../plugins/slack/src/index.ts";
import telegram from "../../../../../plugins/telegram/src/index.ts";
import { env, facetdb, noul } from "../../config/index.ts";
import { VERSION } from "../../index.ts";
import { BUILTIN_PLUGINS, createPluginHost, type Plugin } from "../../plugin/index.ts";
import { createPluginsDoor } from "./plugins-door.ts";

/**
 * The first-party plugins and the built-in webhook as the studio's Plugins page receives them:
 * their real schemas, as zod converts them, their values with every secret a variable, and the
 * webhook's endpoint cut to its host. The answer is written, as `GET /v1/plugins` sends it, to the
 * studio's fixture `apps/studio/src/features/plugins/first-party-plugins.snap`, where the page's
 * own test reads it through the client and draws it (`first-party.test.ts`): a schema that changes
 * here fails this test until the fixture is written again (`vitest -u`), and then the page's test
 * judges the new one. Nothing reaches a network.
 */

const ENV: Readonly<Record<string, string>> = {
  GITHUB_TOKEN: "ghp_s3cretGithubToken0123456789abcdef0123",
  GITHUB_WEBHOOK_SECRET: "s3cret-hook-signing",
  SLACK_BOT_TOKEN: "xoxb-s3cret-slack-token",
  TELEGRAM_BOT_TOKEN: "123456789:s3cret-telegram_token",
  EMAIL_PASSWORD: "s3cret-smtp-password",
  FACETDB_WEBHOOK_SECRET: "s3cret-webhook-signing",
};

const ENDPOINT = "https://hooks.example.com/facetdb/s3cret-path?token=s3cret-query";

const FIRST_PARTY: Readonly<Record<string, Plugin>> = {
  "@facetdb/github": github,
  "@facetdb/slack": slack,
  "@facetdb/email": email,
  "@facetdb/telegram": telegram,
  "@facetdb/packs": packs,
};

const FIXTURE = "../../../../../apps/studio/src/features/plugins/first-party-plugins.snap";

describe("the first-party plugins as the Plugins page receives them", () => {
  it("carries their schemas and values, no secret's value and no endpoint beyond its host, and is the studio's fixture", async () => {
    const config = facetdb({
      model: "jev-1.14.0",
      plugins: {
        github: { token: env("GITHUB_TOKEN"), webhookSecret: env("GITHUB_WEBHOOK_SECRET") },
        slack: { token: env("SLACK_BOT_TOKEN") },
        email: {
          host: "smtp.example.com",
          port: 587,
          user: "alerts@example.com",
          password: env("EMAIL_PASSWORD"),
          from: "alerts@example.com",
        },
        telegram: { token: env("TELEGRAM_BOT_TOKEN") },
        packs: {},
        webhook: { secret: env("FACETDB_WEBHOOK_SECRET"), endpoints: { ops: ENDPOINT } },
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
    const host = await createPluginHost({
      config,
      env: ENV,
      projectDir: "/work/shop",
      coreVersion: VERSION,
      importModule: async (specifier) => {
        const plugin = FIRST_PARTY[specifier];
        if (plugin !== undefined) {
          return { default: plugin };
        }
        throw Object.assign(new Error(`Cannot find package '${specifier}'`), {
          code: "ERR_MODULE_NOT_FOUND",
        });
      },
      builtins: BUILTIN_PLUGINS,
    });
    const door = createPluginsDoor({
      host,
      config: () => config,
      env: ENV,
      coreVersion: VERSION,
      registry: "https://registry.example.com/index.json",
      fetch: () => Promise.reject(new Error("this test reads no registry")),
      abortAfter: () => new AbortController().signal,
      workspace: {
        peek: () => Promise.resolve({ kind: "none" }),
        lines: async function* () {},
      },
      projectDir: "/work/shop",
      clock: new FakeClock(0),
    });

    // As the route answers it.
    const answer = `${JSON.stringify({ facetdb: door.facetdb, plugins: door.installed() }, null, 2)}\n`;

    expect(door.installed().map((plugin) => plugin.name)).toEqual([
      "github",
      "slack",
      "email",
      "telegram",
      "packs",
      "webhook",
    ]);
    expect(answer).not.toMatch(/s3cret|token=|\/facetdb\b/);
    expect(door.installed().find((plugin) => plugin.name === "webhook")?.settings).toMatchObject({
      values: { endpoints: { ops: "hooks.example.com" } },
      hostOnly: ["endpoints.ops"],
    });
    await expect(answer).toMatchFileSnapshot(FIXTURE);
  });
});
