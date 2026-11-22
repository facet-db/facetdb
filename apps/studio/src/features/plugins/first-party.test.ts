import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createApiClient, type InstalledPlugin } from "../../api/index.ts";
import { isControl, pathText, settingsOf } from "./settings.ts";

/**
 * The first-party plugins and the built-in webhook as the worker really describes them:
 * `first-party-plugins.snap` is what `GET /v1/plugins` answers for them, their schemas as zod
 * converts them, written by the door's own test in packages/facetdb
 * (`plugins-door-first-party.test.ts`), which fails while the file is not what the door answers
 * now. Here that answer goes through the studio's client and the page's reader: every setting drawn
 * by its shape, none a control, a secret never one even where a plugin would mark it editable, and
 * the webhook's endpoint its host alone.
 */

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), "first-party-plugins.snap");

async function received(): Promise<readonly InstalledPlugin[]> {
  const text = readFileSync(FIXTURE, "utf8");
  const api = createApiClient(() =>
    Promise.resolve(
      new Response(text, { status: 200, headers: { "content-type": "application/json" } }),
    ),
  );
  return (await api.plugins()).plugins;
}

/** The plugin with every setting its schema declares marked `z.editable()`, as a plugin could. */
function allEditable(plugin: InstalledPlugin): InstalledPlugin {
  const schema = structuredClone(plugin.settings.schema) as {
    properties: Record<string, Record<string, unknown>>;
  };
  for (const field of Object.values(schema.properties)) {
    field["editable"] = true;
  }
  return {
    ...plugin,
    settings: { ...plugin.settings, schema: schema as InstalledPlugin["settings"]["schema"] },
  };
}

function controls(plugin: InstalledPlugin): readonly string[] {
  return settingsOf(plugin)
    .filter((setting) => isControl(setting, plugin))
    .map((setting) => pathText(setting.path));
}

describe("the first-party plugins on the Plugins page", () => {
  it("draws each setting of the real schemas by its shape, with nothing sent to the file for want of a shape", async () => {
    const plugins = await received();

    expect(
      Object.fromEntries(
        plugins.map((plugin) => [
          plugin.name,
          settingsOf(plugin).map(
            (setting) =>
              `${pathText(setting.path)} ${setting.shape.kind}${setting.secret ? " secret" : ""}${setting.required ? " required" : ""}`,
          ),
        ]),
      ),
    ).toEqual({
      github: ["token text secret required", "webhookSecret text secret", "apiUrl text"],
      slack: ["token text secret", "webhooks map secret"],
      email: [
        "host text required",
        "port number",
        "secure boolean",
        "user text",
        "password text secret",
        "from text required",
      ],
      telegram: ["token text secret required"],
      packs: [],
      webhook: ["secret text secret required", "endpoints map"],
    });
  });

  it("makes none a control: no first-party plugin marks a setting editable", async () => {
    for (const plugin of await received()) {
      expect(controls(plugin)).toEqual([]);
    }
  });

  it("keeps a secret, a variable and an endpoint's host out of the controls even where every setting is marked editable", async () => {
    const plugins = await received();

    expect(
      Object.fromEntries(plugins.map((plugin) => [plugin.name, controls(allEditable(plugin))])),
    ).toEqual({
      // token and webhookSecret are secrets read from variables.
      github: ["apiUrl"],
      // webhooks is written nowhere in the file: only its schema's secret mark keeps it a text.
      slack: [],
      email: ["host", "port", "secure", "user", "from"],
      telegram: [],
      packs: [],
      // secret is a secret; endpoints holds an address the worker cut to its host.
      webhook: [],
    });
  });

  it("has the webhook's endpoint as its name and host, and nothing more of its address", async () => {
    const webhook = (await received()).find((plugin) => plugin.name === "webhook");

    expect(webhook?.settings.values).toEqual({
      secret: { env: "FACETDB_WEBHOOK_SECRET" },
      endpoints: { ops: "hooks.example.com" },
    });
    expect(webhook?.settings.hostOnly).toEqual(["endpoints.ops"]);
    expect(readFileSync(FIXTURE, "utf8")).not.toMatch(/https:\/\/hooks|token=/);
  });
});
