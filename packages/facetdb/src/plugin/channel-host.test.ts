import {
  type AlertEvent,
  type AlertSeverity,
  type BoundChannel,
  type ChannelFailure,
  type ChannelMessage,
  type Clock,
  createAlerts,
  eventKey,
  RETRY_EVERY_MS,
} from "@facetdb/core";
import { FakeAlertStore } from "@facetdb/core/testing";
import { DEFAULT_FETCH_TIMEOUT_MS } from "@facetdb/server";
import { describe, expect, it } from "vitest";
import {
  type AlertChannel,
  env,
  facetdb,
  noul,
  type PluginSettings,
  type ProjectConfig,
} from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  action,
  bindChannels,
  channel,
  checkChannels,
  createPluginHost,
  DELIVERY_BOUND_MS,
  DELIVERY_STOPPED,
  DELIVERY_TIMED_OUT,
  definePlugin,
  deliveryFailedWords,
  deliveryFailureLine,
  type Plugin,
  type PluginContext,
  type PluginHost,
  PluginHostError,
  revealsSecret,
  sendsSeverity,
  z,
} from "./index.ts";

/**
 * The channel host: each address of `alerts.channels` bound at load to its plugin's channel through
 * the plugin host (the entry named like the kind, or the plugin's only one, its settings `{ where
 * }` parsed by the entry's schema and judged by its `check`), each refusal in words with a fix and
 * never a secret; the bound channels deliver each system alert the channel's `sends` takes, side by
 * side, each call raced against a fixed bound and the worker's stop on the injected clock, the
 * alert recorded before any is tried and a failure kept as fixed words only.
 */

const SLACK_TOKEN = "xoxb-1234567890-s3cretSlackTokenValue";
const HOSTILE_TOKEN = "hst_9f8e7d6c5b4a3210-TOPSECRETVALUE";
const HOSTILE_HOOK = "https://hooks.example.com/services/T0/B0/s3cretHookPath";
const ENV = { SLACK_TOKEN, HOSTILE_TOKEN, HOSTILE_HOOK };
// The hook's scheme is in every alert's own link: the rest of the URL is the secret.
const SECRETS = [SLACK_TOKEN, HOSTILE_TOKEN, HOSTILE_HOOK.slice("https://".length)];
const START = Date.UTC(2026, 10, 14, 9, 0, 0);

/** Every 8 characters in a row of each secret: none may appear in a word FacetDB keeps or shows. */
function leaks(text: string): string[] {
  return SECRETS.flatMap((secret) => {
    const found: string[] = [];
    for (let at = 0; at + 8 <= secret.length; at += 1) {
      const piece = secret.slice(at, at + 8);
      if (text.includes(piece)) {
        found.push(piece);
      }
    }
    return found;
  });
}

/**
 * A clock whose sleeps end only when the test moves time past them, or when their signal aborts:
 * `pending` says which are still on it (what a settled delivery must not leave behind).
 */
class ManualClock implements Clock {
  #time = START;
  #sleepers: { readonly due: number; readonly wake: () => void }[] = [];

  now(): number {
    return this.#time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((wake) => {
      if (signal?.aborted === true) {
        wake();
        return;
      }
      const sleeper = { due: this.#time + ms, wake };
      this.#sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.#sleepers = this.#sleepers.filter((other) => other !== sleeper);
          wake();
        },
        { once: true },
      );
    });
  }

  pending(): readonly number[] {
    return this.#sleepers.map((sleeper) => sleeper.due - this.#time);
  }

  advance(ms: number): void {
    this.#time += ms;
    const due = this.#sleepers.filter((sleeper) => sleeper.due <= this.#time);
    this.#sleepers = this.#sleepers.filter((sleeper) => sleeper.due > this.#time);
    for (const sleeper of due) {
      sleeper.wake();
    }
  }
}

/** Lets every promise that can settle now settle. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

type Sent = {
  readonly plugin: string;
  readonly entry: string;
  readonly ctx: PluginContext<unknown>;
  readonly message: ChannelMessage;
  readonly settings: unknown;
  /** What the alert history held when the call was made. */
  readonly historyAtCall: number;
};

type Hanging = {
  readonly started: { readonly signal: AbortSignal; readonly settings: unknown }[];
  /** Ends every call so far: fulfilled, or rejected with `error`. */
  end(error?: Error): void;
};

/** The worlds a test builds its plugins in: what each call was given, and the history then. */
type Rig = {
  readonly sent: Sent[];
  readonly hanging: Hanging;
  readonly checked: { readonly ctx: PluginContext<unknown>; readonly settings: unknown }[];
  history(): number;
};

function hostileError(): Error {
  // A community plugin's error holding its secrets everywhere an error can hold them.
  const error = Object.assign(
    new Error(`POST ${HOSTILE_HOOK} refused with Authorization: Bearer ${HOSTILE_TOKEN}`, {
      cause: new Error(`token ${HOSTILE_TOKEN}`),
    }),
    { url: HOSTILE_HOOK, token: HOSTILE_TOKEN, status: 401 },
  );
  error.stack = `Error: ${HOSTILE_TOKEN}\n    at ${HOSTILE_HOOK}`;
  return error;
}

function pluginsOf(rig: Rig): Readonly<Record<string, Plugin>> {
  const record =
    (plugin: string, entry: string) =>
    async (ctx: PluginContext<unknown>, message: ChannelMessage, settings: unknown) => {
      rig.sent.push({ plugin, entry, ctx, message, settings, historyAtCall: rig.history() });
    };
  const slack = definePlugin({
    name: "slack",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({ token: z.secret().optional() }),
    channels: {
      slack: channel({
        config: z.object({
          where: z.string().regex(/^#[a-z0-9-]+$/, "a Slack channel is written as #name"),
        }),
        check: (ctx, settings) => {
          rig.checked.push({ ctx, settings });
          return ctx.secrets["token"] === undefined
            ? 'the slack plugin has no token: set plugins.slack.token to env("SLACK_TOKEN")'
            : undefined;
        },
        deliver: record("slack", "slack"),
      }),
    },
  });
  // A kind whose plugin's only channel is named otherwise.
  const mailer = definePlugin({
    name: "mailer",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({}),
    channels: {
      email: channel({
        config: z.object({ where: z.string().email() }),
        deliver: record("mailer", "email"),
      }),
    },
  });
  const hollow = definePlugin({
    name: "hollow",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({}),
    actions: { ping: action({ config: z.object({}), run: async () => undefined }) },
  });
  const multi = definePlugin({
    name: "multi",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({}),
    channels: {
      sms: channel({ config: z.object({ where: z.string() }), deliver: record("multi", "sms") }),
      pager: channel({
        config: z.object({ where: z.string() }),
        deliver: record("multi", "pager"),
      }),
    },
  });
  const hostile = definePlugin({
    name: "hostile",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({ token: z.secret(), hook: z.secret() }),
    channels: {
      hostile: channel({
        config: z.object({ where: z.string() }),
        // A check that answers with the secrets it holds, in the form its `where` asks for.
        check: (ctx, settings: { where: string }) => {
          const token = ctx.secrets["token"] ?? "";
          const forms: Record<string, () => unknown> = {
            quiet: () => undefined,
            raw: () => `token ${token} is refused`,
            piece: () => `the token ends in ${token.slice(-10)}`,
            url: () => `refused ${encodeURIComponent(`${token}/x y`)}`,
            base64: () => `Basic ${Buffer.from(`ops:${token}`).toString("base64")}`,
            base64url: () => `id ${Buffer.from(`${token}`).toString("base64url")}`,
            // Broken up by zero-width spaces, which cleaning would take out of the shown words.
            zerowidth: () => `token ${[...token].join(String.fromCharCode(0x200b))} refused`,
            // Broken up by a bidi mark and spaces.
            spaced: () =>
              `token ${token.slice(0, 6)} ${token.slice(6, 14)}${String.fromCharCode(0x202e)}${token.slice(14)}`,
            upper: () => `TOKEN ${token.toUpperCase()} REFUSED`,
            lower: () => `token ${token.toLowerCase()} refused`,
            hook: () => `the hook ${ctx.secrets["hook"]} answered 404`,
            throws: () => {
              throw new Error(`exploded on ${token}`);
            },
            number: () => 42,
            promise: () => Promise.reject(new Error(`later ${token}`)),
            control: () => `bad\u0007where\u001b[31m red‮${"x".repeat(1000)}`,
          };
          return (forms[settings.where] ?? forms["quiet"])?.() as string | undefined;
        },
        deliver: async (ctx, message, settings: { where: string }) => {
          rig.sent.push({
            plugin: "hostile",
            entry: "hostile",
            ctx,
            message,
            settings,
            historyAtCall: rig.history(),
          });
          if (settings.where === "sync") {
            // Thrown before any promise exists.
            throw hostileError();
          }
          if (settings.where !== "quiet") {
            return Promise.reject(hostileError());
          }
        },
      }),
    },
  });
  const hangs = definePlugin({
    name: "hangs",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({}),
    channels: {
      hangs: channel({
        config: z.object({ where: z.string() }),
        deliver: (ctx, _message, settings) =>
          new Promise<void>((resolve, reject) => {
            rig.hanging.started.push({ signal: ctx.signal, settings });
            ends.push((error) => (error === undefined ? resolve() : reject(error)));
          }),
      }),
    },
  });
  const ends: ((error?: Error) => void)[] = [];
  Object.assign(rig.hanging, {
    end: (error?: Error) => {
      for (const end of ends.splice(0)) {
        end(error);
      }
    },
  });
  return {
    "@facetdb/slack": slack,
    "@facetdb/mailer": mailer,
    "@facetdb/hollow": hollow,
    "@facetdb/multi": multi,
    "facetdb-plugin-hostile": hostile,
    "facetdb-plugin-hangs": hangs,
  };
}

function project(
  channels: readonly AlertChannel[] | undefined,
  plugins: { readonly [name: string]: PluginSettings } = { slack: { token: env("SLACK_TOKEN") } },
): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins,
    ...(channels === undefined ? {} : { alerts: { channels } }),
    sources: [
      {
        name: "tickets",
        api: true,
        read: ["body"],
        questions: { urgent: noul("Does the customer need an answer today?") },
      },
    ],
  });
}

const HOSTILE_SETTINGS = { hostile: { token: env("HOSTILE_TOKEN"), hook: env("HOSTILE_HOOK") } };

function world() {
  const clock = new ManualClock();
  const store = new FakeAlertStore(clock);
  const rig: Rig = {
    sent: [],
    hanging: { started: [], end: () => undefined },
    checked: [],
    history: () => store.history.length,
  };
  const installed = pluginsOf(rig);
  const stop = new AbortController();
  const hostFor = (config: ProjectConfig): Promise<PluginHost> =>
    createPluginHost({
      config,
      env: ENV,
      projectDir: "/work/shop",
      coreVersion: VERSION,
      importModule: (specifier) => {
        const plugin = installed[specifier];
        return plugin === undefined
          ? Promise.reject(
              Object.assign(new Error(`Cannot find package '${specifier}'`), {
                code: "ERR_MODULE_NOT_FOUND",
              }),
            )
          : Promise.resolve({ default: plugin });
      },
      builtins: {},
    });
  const failures: ChannelFailure[] = [];
  const printed: string[] = [];
  /** The bound channels of a config and the alerts module over them, as the worker wires them. */
  async function alertsFor(config: ProjectConfig) {
    const host = await hostFor(config);
    const channels = bindChannels({ config, host, env: ENV, clock, stop: () => stop.signal });
    const alerts = createAlerts({
      store,
      clock,
      channels,
      report: (failure) => {
        failures.push(failure);
        printed.push(deliveryFailureLine(failure));
      },
    });
    return { channels, alerts };
  }
  async function refusal(config: ProjectConfig, host?: PluginHost): Promise<PluginHostError> {
    try {
      checkChannels(config, host ?? (await hostFor(config)), ENV);
    } catch (error) {
      if (error instanceof PluginHostError) {
        return error;
      }
      throw error;
    }
    throw new Error("expected checkChannels to refuse the config");
  }
  return { clock, store, rig, stop, hostFor, alertsFor, refusal, failures, printed };
}

function event(kind: AlertEvent["kind"], overrides: Partial<AlertEvent> = {}): AlertEvent {
  return {
    kind,
    what: "Something happened.",
    project: "shop",
    source: "tickets",
    question: null,
    did: "Nothing yet.",
    link: "https://docs.facetdb.dev/fix/worker",
    ...overrides,
  };
}

/** One event of each severity. */
const BY_SEVERITY: Readonly<Record<AlertSeverity, AlertEvent>> = {
  critical: event("model_failing"),
  warning: event("backfill_failed"),
  information: event("backfill_finished"),
};

describe("binding a channel", () => {
  it("binds each address to the entry named like its kind, or the plugin's only one, with { where } as its settings", async () => {
    const w = world();
    const config = project(["slack:#ops", { to: "mailer:ops@example.com", sends: "critical" }]);
    const { channels, alerts } = await w.alertsFor(config);
    expect(channels.map((bound) => bound.name)).toEqual(["slack:#ops", "mailer:ops@example.com"]);

    await alerts.raise(BY_SEVERITY.critical);

    expect(w.rig.sent.map(({ plugin, entry, settings }) => ({ plugin, entry, settings }))).toEqual([
      { plugin: "slack", entry: "slack", settings: { where: "#ops" } },
      { plugin: "mailer", entry: "email", settings: { where: "ops@example.com" } },
    ]);
    // The plugin's own context: its secrets, read from the environment by the host.
    expect(w.rig.sent[0]?.ctx.secrets).toEqual({ token: SLACK_TOKEN });
    expect(w.rig.sent[0]?.message.text).toContain("Something happened.");
  });

  it("asks the entry's check once at load, with the plugin's context and the parsed settings", async () => {
    const w = world();
    const config = project(["slack:#ops"]);
    expect(checkChannels(config, await w.hostFor(config), ENV)).toEqual([
      { address: "slack:#ops", kind: "slack", where: "#ops", sends: "everything" },
    ]);
    expect(w.rig.checked).toHaveLength(1);
    expect(w.rig.checked[0]?.settings).toEqual({ where: "#ops" });
    expect(w.rig.checked[0]?.ctx.secrets).toEqual({ token: SLACK_TOKEN });
  });

  it("carries sends and quiet hours on the binding, quiet acted on by no one yet", async () => {
    const w = world();
    const config = project([
      { to: "slack:#ops", sends: "warnings", quiet: { from: "22:00", to: "07:00", zone: "UTC" } },
    ]);
    expect(checkChannels(config, await w.hostFor(config), ENV)).toEqual([
      {
        address: "slack:#ops",
        kind: "slack",
        where: "#ops",
        sends: "warnings",
        quiet: { from: "22:00", to: "07:00", zone: "UTC" },
      },
    ]);
  });

  it("binds nothing for a config with no alerts, and every alert is recorded and reached as before", async () => {
    const w = world();
    const { channels, alerts } = await w.alertsFor(project(undefined));
    expect(channels).toEqual([]);

    const outcome = await alerts.raise(BY_SEVERITY.critical);

    expect(outcome).toEqual({ status: "sent", failures: [] });
    // The line is the one it always was: no deliveries key.
    expect(w.store.history).toEqual([
      {
        at: START,
        key: eventKey(BY_SEVERITY.critical),
        phase: "raised",
        severity: "critical",
        event: BY_SEVERITY.critical,
        delivered: true,
      },
    ]);
    expect(w.store.active.get(eventKey(BY_SEVERITY.critical))?.lastSentAt).toBe(START);
  });
});

describe("the refusals at load", () => {
  it("a channel whose plugin is not installed stops the host itself, with facetdb add", async () => {
    const w = world();
    await expect(w.hostFor(project(["pagerduty:ops"]))).rejects.toMatchObject({
      code: "plugin-not-installed",
      fix: expect.stringContaining("run facetdb add pagerduty"),
    });
  });

  it("a channel the host did not load (named since the worker started) says to add it and restart", async () => {
    const w = world();
    const started = await w.hostFor(project(undefined, {}));
    const refused = await w.refusal(project(["slack:#ops"]), started);
    expect(refused.code).toBe("plugin-not-installed");
    expect(refused.message).toBe(
      'alerts.channels[0] (slack:#ops) names the channel "slack", and no plugin of that name was loaded when this worker started',
    );
    expect(refused.fix).toContain("run facetdb add slack");
  });

  it("refuses a plugin that provides no channel", async () => {
    const refused = await world().refusal(project(["hollow:ops"]));
    expect(refused.code).toBe("plugin-no-channel");
    expect(refused.message).toBe(
      'alerts.channels[0] (hollow:ops) names the plugin "@facetdb/hollow", which provides no alert channel',
    );
    expect(refused.fix).toContain("take hollow:ops out of alerts.channels");
  });

  it("refuses a plugin of several channels with none named like the kind", async () => {
    const refused = await world().refusal(project(["multi:ops"]));
    expect(refused.code).toBe("plugin-no-channel");
    expect(refused.message).toContain('whose channels are sms, pager, none of them named "multi"');
  });

  it("refuses a where the channel's schema refuses, in the schema's words", async () => {
    const refused = await world().refusal(project(["slack:ops"]));
    expect(refused.code).toBe("channel-where");
    expect(refused.message).toBe(
      'alerts.channels[0] (slack:ops) is refused by the plugin "@facetdb/slack": a Slack channel is written as #name',
    );
    expect(refused.fix).toContain("after the colon");
  });

  it("refuses an address the entry's check refuses, in the check's words", async () => {
    const refused = await world().refusal(project(["slack:#ops"], { slack: {} }));
    expect(refused.code).toBe("channel-where");
    expect(refused.message).toBe(
      'alerts.channels[0] (slack:#ops) cannot be delivered to: the slack plugin has no token: set plugins.slack.token to env("SLACK_TOKEN")',
    );
  });

  it("names which address of several is refused", async () => {
    const refused = await world().refusal(project(["slack:#ops", "mailer:not-an-address"]));
    expect(refused.message).toContain("alerts.channels[1] (mailer:not-an-address)");
  });

  it.each([
    "raw",
    "piece",
    "url",
    "base64",
    "base64url",
    "hook",
    "zerowidth",
    "spaced",
    "upper",
    "lower",
  ])("never shows a check's words that repeat a secret it holds (%s)", async (form) => {
    const refused = await world().refusal(project([`hostile:${form}`], HOSTILE_SETTINGS));
    expect(leaks(`${refused.message} ${refused.fix}`)).toEqual([]);
    expect(refused.code).toBe("channel-where");
    expect(refused.message).toBe(
      `alerts.channels[0] (hostile:${form}) cannot be delivered to: the hostile plugin's reason is not shown, as it repeats a value its settings read from the environment`,
    );
  });

  it("keeps nothing of a check that throws, and refuses one that answers anything but words", async () => {
    const w = world();
    const threw = await w.refusal(project(["hostile:throws"], HOSTILE_SETTINGS));
    expect(leaks(`${threw.message} ${threw.fix}`)).toEqual([]);
    expect(threw.message).toContain("failed while it checked the channel");
    expect(threw.cause).toBeUndefined();

    const number = await w.refusal(project(["hostile:number"], HOSTILE_SETTINGS));
    expect(number.message).toContain("with something other than words");
    // A promise is refused too, and its later rejection stops nothing.
    const promise = await w.refusal(project(["hostile:promise"], HOSTILE_SETTINGS));
    expect(promise.message).toContain("with something other than words");
    await settle();
  });

  it("strips control and bidi characters from a check's words and holds them to a length", async () => {
    const refused = await world().refusal(project(["hostile:control"], HOSTILE_SETTINGS));
    const shown = refused.message.slice(refused.message.indexOf("to: ") + 4);
    expect(shown).not.toMatch(/[\p{Cc}\p{Cf}]/u);
    expect(shown.startsWith("bad where")).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(300);
  });

  it("finds a secret in each form the host searches for, and not in words that hold none", () => {
    const token = "abcdefghijklmnop";
    expect(revealsSecret(`x ${token} y`, [token])).toBe(true);
    expect(revealsSecret("ends in ijklmnop", [token])).toBe(true);
    expect(revealsSecret(encodeURIComponent(`${token}/`), [`${token}/`])).toBe(true);
    for (const prefix of ["", "a", "ab", "abc"]) {
      expect(revealsSecret(Buffer.from(`${prefix}${token}`).toString("base64"), [token])).toBe(
        true,
      );
      expect(revealsSecret(Buffer.from(`${prefix}${token}`).toString("base64url"), [token])).toBe(
        true,
      );
    }
    expect(revealsSecret("the channel has no token", [token])).toBe(false);
    // A short value counts whole.
    expect(revealsSecret("key k3y is wrong", ["k3y"])).toBe(true);
  });
});

describe("what a channel sends", () => {
  it("is decided by its sends for each severity", () => {
    const table = (["critical", "warnings", "everything"] as const).map((sends) => [
      sends,
      (["critical", "warning", "information"] as const).filter((severity) =>
        sendsSeverity(sends, severity),
      ),
    ]);
    expect(table).toEqual([
      ["critical", ["critical"]],
      ["warnings", ["critical", "warning"]],
      ["everything", ["critical", "warning", "information"]],
    ]);
  });

  it("drops a message below a channel's level for that channel alone: not a delivery, not a failure", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(
      project([
        { to: "slack:#crit", sends: "critical" },
        { to: "slack:#warn", sends: "warnings" },
        "slack:#all",
      ]),
    );
    const heard: Record<AlertSeverity, string[]> = { critical: [], warning: [], information: [] };
    for (const severity of ["critical", "warning", "information"] as const) {
      const before = w.rig.sent.length;
      const outcome = await alerts.raise(BY_SEVERITY[severity]);
      expect(outcome.failures).toEqual([]);
      heard[severity] = w.rig.sent
        .slice(before)
        .map((sent) => (sent.settings as { where: string }).where);
    }
    expect(heard).toEqual({
      critical: ["#crit", "#warn", "#all"],
      warning: ["#warn", "#all"],
      information: ["#all"],
    });
    // Each line lists the channels tried, and only those.
    expect(w.store.history.map((line) => line.deliveries?.map((entry) => entry.channel))).toEqual([
      ["slack:#crit", "slack:#warn", "slack:#all"],
      ["slack:#warn", "slack:#all"],
      ["slack:#all"],
    ]);
    expect(w.store.history.every((line) => line.delivered)).toBe(true);
    expect(w.failures).toEqual([]);
  });

  it("records a message every channel drops as one no channel was tried for", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project([{ to: "slack:#crit", sends: "critical" }]));
    await alerts.raise(BY_SEVERITY.information);
    expect(w.rig.sent).toEqual([]);
    expect(w.store.history).toHaveLength(1);
    expect(w.store.history[0]?.delivered).toBe(true);
    expect("deliveries" in (w.store.history[0] ?? {})).toBe(false);
  });

  it("sends the resolved message to the channels that heard the alert, by the alert's own severity", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project([{ to: "slack:#crit", sends: "critical" }]));
    await alerts.raise(BY_SEVERITY.critical);
    const resolved = await alerts.resolve(eventKey(BY_SEVERITY.critical));
    expect(resolved.status).toBe("resolved");
    expect(w.rig.sent.map((sent) => sent.message.text.startsWith("Resolved:"))).toEqual([
      false,
      true,
    ]);
    expect(w.store.history[1]).toMatchObject({
      phase: "resolved",
      deliveries: [{ channel: "slack:#crit", ok: true }],
    });
  });
});

describe("a channel that fails", () => {
  it("leaves the others delivered and the event recorded, keeping fixed words and no secret", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(
      project(["hostile:rejects", "slack:#ops", "hostile:sync"], {
        slack: { token: env("SLACK_TOKEN") },
        ...HOSTILE_SETTINGS,
      }),
    );

    const outcome = await alerts.raise(BY_SEVERITY.critical);

    expect(outcome.status).toBe("sent");
    const words = deliveryFailedWords("facetdb-plugin-hostile");
    expect(outcome.failures).toEqual([
      { channel: "hostile:rejects", error: words },
      { channel: "hostile:sync", error: words },
    ]);
    expect(w.store.history).toEqual([
      expect.objectContaining({
        phase: "raised",
        delivered: true,
        deliveries: [
          { channel: "hostile:rejects", ok: false, error: words },
          { channel: "slack:#ops", ok: true },
          { channel: "hostile:sync", ok: false, error: words },
        ],
      }),
    ]);
    expect(w.rig.sent.map((sent) => sent.plugin)).toEqual(["hostile", "slack", "hostile"]);
    expect(w.printed).toEqual([
      `alert channel hostile:rejects: ${words}. The alert is recorded, with this delivery's outcome, on the Alerts page.`,
      `alert channel hostile:sync: ${words}. The alert is recorded, with this delivery's outcome, on the Alerts page.`,
    ]);
    // Nothing the plugin threw (its message, cause, stack or properties) reaches a kept word.
    expect(leaks(JSON.stringify(w.store.history))).toEqual([]);
    expect(leaks(JSON.stringify(w.store.active.get(eventKey(BY_SEVERITY.critical))))).toEqual([]);
    expect(leaks(JSON.stringify(outcome))).toEqual([]);
    expect(leaks(w.printed.join("\n"))).toEqual([]);
  });

  it("@timing never throws out of raise when every channel fails; the alert stays recorded, and is tried again only past the retry interval", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project(["hostile:rejects"], HOSTILE_SETTINGS));
    const outcome = await alerts.raise(BY_SEVERITY.warning);
    expect(outcome.failures).toHaveLength(1);
    expect(w.store.history).toMatchObject([{ phase: "raised", delivered: false }]);
    expect(w.store.active.get(eventKey(BY_SEVERITY.warning))).toMatchObject({
      lastSentAt: null,
      lastTriedAt: START,
    });
    // Within the interval: no channel call, no line, no printed line.
    w.clock.advance(RETRY_EVERY_MS - 1);
    expect((await alerts.raise(BY_SEVERITY.warning)).status).toBe("suppressed");
    expect(w.store.history).toHaveLength(1);
    expect(w.printed).toHaveLength(1);
    expect(w.rig.sent).toHaveLength(1);
    // Past it: one more attempt, recorded as its own line.
    w.clock.advance(1);
    expect((await alerts.raise(BY_SEVERITY.warning)).status).toBe("sent");
    expect(w.store.history).toHaveLength(2);
    expect(w.printed).toHaveLength(2);
  });

  it("@timing a stop while a resolved message is on its way: the healthy call returned at once, drain ends with the delivery cut off, the alert stays open", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project(["hangs:forever"]));
    const failing = BY_SEVERITY.critical;
    const raising = alerts.raise(failing);
    await settle();
    w.rig.hanging.end();
    await raising;
    w.clock.advance(6 * 60_000);

    const signals = alerts.signals({
      project: failing.project,
      source: failing.source,
      link: failing.link,
    });
    // The healthy call returns while the resolved message hangs.
    await signals.modelCall(true);
    expect(w.rig.hanging.started).toHaveLength(2);
    expect(w.rig.hanging.started[1]?.signal.aborted).toBe(false);

    w.stop.abort();
    await alerts.drain();
    expect(w.rig.hanging.started[1]?.signal.aborted).toBe(true);
    expect(w.failures.at(-1)).toEqual({ channel: "hangs:forever", error: DELIVERY_STOPPED });
    expect(w.store.active.has(eventKey(failing))).toBe(true);
    expect(w.store.history.map((line) => line.phase)).toEqual(["raised"]);
    expect(w.clock.pending()).toEqual([]);
  });

  it("bounds a delivery strictly below the outbox's wait on a give-up alert, with room for the store's writes", () => {
    expect(DELIVERY_BOUND_MS).toBe(20_000);
    expect(DELIVERY_BOUND_MS).toBeLessThanOrEqual(DEFAULT_FETCH_TIMEOUT_MS - 10_000);
  });

  it("is tried only after the alert is recorded", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project(["slack:#ops"]));
    await alerts.raise(BY_SEVERITY.critical);
    expect(w.rig.sent[0]?.historyAtCall).toBe(1);
  });

  it("keeps the 30-minute rule: a delivered alert is not sent again within the window", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project(["slack:#ops"]));
    await alerts.raise(BY_SEVERITY.critical);
    expect((await alerts.raise(BY_SEVERITY.critical)).status).toBe("suppressed");
    expect(w.rig.sent).toHaveLength(1);
  });
});

describe("the bound on a delivery", () => {
  it("@timing gives up a channel that never answers at the bound, the others delivered beside it, no timer left", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project(["hangs:forever", "slack:#ops"]));

    const raising = alerts.raise(BY_SEVERITY.critical);
    await settle();
    // Side by side: the second channel delivered while the first still hangs.
    expect(w.rig.hanging.started).toHaveLength(1);
    expect(w.rig.sent.map((sent) => sent.plugin)).toEqual(["slack"]);
    expect(w.clock.pending()).toEqual([DELIVERY_BOUND_MS]);
    expect(w.rig.hanging.started[0]?.signal.aborted).toBe(false);

    w.clock.advance(DELIVERY_BOUND_MS);
    const outcome = await raising;

    expect(outcome.failures).toEqual([{ channel: "hangs:forever", error: DELIVERY_TIMED_OUT }]);
    expect(w.store.history[0]?.deliveries).toEqual([
      { channel: "hangs:forever", ok: false, error: DELIVERY_TIMED_OUT },
      { channel: "slack:#ops", ok: true },
    ]);
    // The plugin's own signal fired, so it can stop its request.
    expect(w.rig.hanging.started[0]?.signal.aborted).toBe(true);
    expect(w.clock.pending()).toEqual([]);
    // Its late rejection, secret and all, goes nowhere.
    w.rig.hanging.end(hostileError());
    await settle();
    expect(leaks(JSON.stringify(w.store.history))).toEqual([]);
  });

  it("@timing gives up every delivery in flight when the worker stops", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project(["hangs:forever"]));
    const raising = alerts.raise(BY_SEVERITY.critical);
    await settle();
    w.stop.abort();
    const outcome = await raising;
    expect(outcome.failures).toEqual([{ channel: "hangs:forever", error: DELIVERY_STOPPED }]);
    expect(w.rig.hanging.started[0]?.signal.aborted).toBe(true);
    expect(w.clock.pending()).toEqual([]);
  });

  it("@timing does not start a delivery once the worker is stopping", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project(["hangs:forever"]));
    w.stop.abort();
    const outcome = await alerts.raise(BY_SEVERITY.critical);
    expect(outcome.failures).toEqual([{ channel: "hangs:forever", error: DELIVERY_STOPPED }]);
    expect(w.rig.hanging.started).toEqual([]);
    expect(w.store.history).toHaveLength(1);
  });

  it("@timing leaves no timer behind a delivery that answers", async () => {
    const w = world();
    const { alerts } = await w.alertsFor(project(["slack:#ops", "hangs:quick"]));
    const raising = alerts.raise(BY_SEVERITY.critical);
    await settle();
    w.rig.hanging.end();
    await raising;
    expect(w.clock.pending()).toEqual([]);
    expect(w.store.history[0]?.deliveries).toEqual([
      { channel: "slack:#ops", ok: true },
      { channel: "hangs:quick", ok: true },
    ]);
  });
});

describe("a bound channel's contract with core", () => {
  it("is a BoundChannel named by its address, taking the severities its sends names", async () => {
    const w = world();
    const config = project([{ to: "slack:#ops", sends: "warnings" }]);
    const [bound] = bindChannels({
      config,
      host: await w.hostFor(config),
      env: ENV,
      clock: w.clock,
      stop: () => w.stop.signal,
    }) as BoundChannel[];
    expect(bound?.name).toBe("slack:#ops");
    expect(
      ["critical", "warning", "information"].map((severity) =>
        bound?.takes?.(severity as AlertSeverity),
      ),
    ).toEqual([true, true, false]);
  });
});
