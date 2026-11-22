import type { BoundChannel } from "@facetdb/core";
import { describe, expect, it } from "vitest";
import {
  type AlertChannel,
  actionCall,
  env,
  facetdb,
  noul,
  type ProjectConfig,
} from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  action,
  channel,
  createPluginHost,
  createSettingsInForce,
  definePlugin,
  livePluginHost,
  z,
} from "./index.ts";
import { batchKeyOf } from "./notify.ts";

/**
 * The settings in force of a running worker: a reload puts the file's channels and plugin settings
 * in force together, the notifications' quiet hours following the channels, or puts nothing in
 * force and answers why; a changed plugin restarts its sources alone.
 */

const ENV = { PAGER_TOKEN: "pgr_PAGERSECRETVALUE" };
const pager = definePlugin({
  name: "pager",
  version: "1.0.0",
  facetdb: "*",
  config: z.object({ token: z.secret(), region: z.editable(z.enum(["eu", "us"])) }),
  channels: {
    pager: channel({
      config: z.object({ where: z.string().min(1) }),
      deliver: async () => undefined,
    }),
  },
  actions: { page: action({ config: z.object({}), run: async () => undefined }) },
});

const NIGHT = { from: "22:00", to: "07:00", zone: "UTC" };

function configWith(channels: readonly AlertChannel[], region = "eu"): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    alerts: { channels },
    plugins: { pager: { token: env("PAGER_TOKEN"), region } },
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgent: noul("Is it urgent?") },
        actions: [actionCall("facetdb-plugin-pager", "page")],
      },
      { name: "orders", api: true, read: ["body"], questions: { urgent: noul("Is it urgent?") } },
    ],
  });
}

async function rig(start: ProjectConfig) {
  const host = livePluginHost(
    await createPluginHost({
      config: start,
      env: ENV,
      projectDir: "/work/shop",
      coreVersion: VERSION,
      importModule: (specifier) =>
        specifier === "facetdb-plugin-pager"
          ? Promise.resolve({ default: pager })
          : Promise.reject(Object.assign(new Error("not found"), { code: "ERR_MODULE_NOT_FOUND" })),
      builtins: {},
    }),
  );
  const rebound: (readonly BoundChannel[])[] = [];
  const settings = createSettingsInForce({
    config: start,
    host,
    env: ENV,
    coreVersion: VERSION,
    projectDir: "/work/shop",
    bind: (config) =>
      configWith(config.alerts?.channels ?? []).alerts?.channels.map((each) => ({
        name: typeof each === "string" ? each : each.to,
        deliver: async () => undefined,
      })) ?? [],
    rebind: (channels) => rebound.push(channels),
    machineZone: () => "UTC",
  });
  return { host, rebound, settings };
}

const AT_THREE = Date.UTC(2026, 10, 15, 3, 0);
const ops = batchKeyOf("tickets", 0, "pager:ops");

describe("the settings in force", () => {
  it("hands the notifications the quiet hours of the channels in force, from each reload that bound them", async () => {
    const start = configWith(["pager:ops"]);
    const { rebound, settings } = await rig(start);
    expect(settings.quietPeriod(ops, AT_THREE)).toBeUndefined();

    const quiet = configWith([{ to: "pager:ops", quiet: NIGHT }]);
    expect(settings.reload(quiet)).toMatchObject({ ok: true });
    expect(rebound).toHaveLength(1);
    expect(settings.quietPeriod(ops, AT_THREE)).toEqual({
      start: Date.UTC(2026, 10, 14, 22, 0),
      end: Date.UTC(2026, 10, 15, 7, 0),
    });
    expect(settings.channels().map((binding) => binding.quiet)).toEqual([NIGHT]);
  });

  it("puts nothing in force when the file's cannot be, and says why", async () => {
    const start = configWith(["pager:ops"]);
    const { host, rebound, settings } = await rig(start);
    const before = host.current();
    const refused = settings.reload(configWith([{ to: "pager:ops", quiet: NIGHT }], "mars"));
    expect(refused).toMatchObject({
      ok: false,
      message: expect.stringContaining(
        'the alert channels and plugin settings it names cannot be put in force: the settings of the plugin "facetdb-plugin-pager" are refused by its schema',
      ) as string,
    });
    expect(JSON.stringify(refused)).not.toContain("PAGERSECRETVALUE");
    expect(host.current()).toBe(before);
    expect(rebound).toEqual([]);
    expect(settings.channels().map((binding) => binding.address)).toEqual(["pager:ops"]);
    expect(settings.quietPeriod(ops, AT_THREE)).toBeUndefined();
  });

  it("swaps the plugin host for changed settings, and restarts only the sources that use the plugin", async () => {
    const start = configWith(["pager:ops"]);
    const { host, settings } = await rig(start);
    const next = configWith(["pager:ops"], "us");
    const reload = settings.reload(next);
    if (!reload.ok) {
      throw new Error(reload.message);
    }
    const [tickets, orders] = next.sources;
    if (tickets === undefined || orders === undefined) {
      throw new Error("the test config has two sources");
    }
    expect(reload.restarts(tickets)).toBe("facetdb-plugin-pager");
    expect(reload.restarts(orders)).toBeUndefined();
    expect(host.contextFor("pager", new AbortController().signal).config).toMatchObject({
      region: "us",
    });
    // The same file again: nothing changes, nothing restarts.
    const again = settings.reload(next);
    if (!again.ok) {
      throw new Error(again.message);
    }
    expect(again.notes).toEqual([]);
    expect(again.restarts(tickets)).toBeUndefined();
  });
});
