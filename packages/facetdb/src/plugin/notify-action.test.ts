import type {
  ActionDecisions,
  ActionRecord,
  ChannelMessage,
  Clock,
  ReadResult,
  RecordStatus,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { migrateStore, pgliteClient } from "@facetdb/postgres";
import { freshPglite, type PGlite, resetPglite } from "@facetdb/postgres/testing";
import { type ActionDelivery, createOutbox, DIGEST_MINUTE_MS, queueAction } from "@facetdb/server";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ActionCall,
  type ActionCondition,
  actionCall,
  choice,
  facetdb,
  type NotifyOptions,
  notifyCall,
  noul,
  type ProjectConfig,
  score,
} from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  type ActionSource,
  action,
  actionSteps,
  batchKeyOf,
  channel,
  checkActions,
  createActionRunner,
  createDigestRunner,
  createPluginHost,
  definePlugin,
  digestText,
  type NotifyDeps,
  notifyQuiet,
  PluginError,
  PluginHostError,
  type QueuedAction,
  z,
} from "./index.ts";

/**
 * A notify action: every plugin that provides an alert channel has one without declaring it. Its
 * `channel` (or `to`) is checked by the channel's schema when the config loads; its step queues a
 * row with a batch key and the condition, only when the condition holds; its runner sends the
 * record notification through the plugin's channel (the source, the key, each named question with
 * its value and how sure the model was, the record's page), and the digest's runner sends the rest
 * of a minute as one message with the Decisions list's link.
 */

const STUDIO = "https://studio.example.com";
const START = 1_700_000_040_000;
/** Words the record's state holds: no notification may say them. */
const STATE_WORDS = "Charged twice, card ending 4242";

type Sent = { readonly where: string; readonly message: ChannelMessage };

/** A channel plugin that records what it is given; `#closed` is a channel its bot is not in. */
function chatPlugin(sent: Sent[], failing: { fail: boolean }) {
  return definePlugin({
    name: "chat",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({}),
    channels: {
      chat: channel({
        config: z.object({
          where: z.string().regex(/^#[a-z-]+$/, {
            error: "a chat channel is # followed by lowercase letters and dashes",
          }),
        }),
        check: (_ctx, settings) =>
          settings.where === "#closed" ? "the bot is not in #closed: invite it first" : undefined,
        async deliver(_ctx, message, settings) {
          if (failing.fail) {
            throw new Error("chat answered 500 for token xoxb-secret");
          }
          sent.push({ where: settings.where, message });
        },
      }),
    },
  });
}

/** A plugin with actions and no channel. */
function trackerPlugin() {
  return definePlugin({
    name: "tracker",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({}),
    actions: { label: action({ config: z.object({}), run: () => Promise.resolve() }) },
  });
}

const QUESTIONS = {
  wants_refund: noul("Is the customer asking for their money back?"),
  team: choice("Which team should handle it?", {
    billing: "Charges, payments, invoices",
    shipping: "Delivery times, tracking, countries",
  }),
  urgency: score("How urgent is this message?", ["low", "medium", "high"]),
};

function project(actions: readonly ActionCall[], alerts?: ProjectConfig["alerts"]): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    ...(alerts === undefined ? {} : { alerts }),
    sources: [{ name: "support", api: true, read: ["body"], questions: QUESTIONS, actions }],
  });
}

const chat = (options: NotifyOptions) => notifyCall("@facetdb/chat", options);

async function hostFor(config: ProjectConfig, sent: Sent[] = [], failing = { fail: false }) {
  const plugins: Readonly<Record<string, unknown>> = {
    "@facetdb/chat": chatPlugin(sent, failing),
    "@facetdb/tracker": trackerPlugin(),
  };
  return createPluginHost({
    config,
    env: {},
    projectDir: "/work/shop",
    coreVersion: VERSION,
    importModule: (specifier) =>
      Object.hasOwn(plugins, specifier)
        ? Promise.resolve({ default: plugins[specifier] })
        : Promise.reject(
            Object.assign(new Error(`Cannot find package '${specifier}'`), {
              code: "ERR_MODULE_NOT_FOUND",
            }),
          ),
    builtins: {},
  });
}

async function refusalOf(config: ProjectConfig): Promise<PluginHostError> {
  const host = await hostFor(config);
  try {
    checkActions(config, host, {});
  } catch (error) {
    if (error instanceof PluginHostError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected checkActions to refuse the config");
}

const DECIDED_AT = new Date("2026-11-14T09:30:00.000Z");

const REFUND_YES: ActionDecisions = {
  wants_refund: { kind: "decided", value: true, probabilityOrConfidence: 0.97 },
};
const BILLING: ActionDecisions = {
  team: { kind: "decided", value: "billing", probabilityOrConfidence: 0.88 },
};
const HIGH: ActionDecisions = {
  urgency: { kind: "decided", value: "high", probabilityOrConfidence: 0.91, expected: 2.8 },
};

function recordOf(
  key: string,
  status: RecordStatus = "done",
  decidedAt = DECIDED_AT,
): ActionRecord {
  return { key, state: { body: STATE_WORDS }, status, stateHash: "h1", decidedAt };
}

/** The rows the source's steps queue for one decision. */
async function queued(
  config: ProjectConfig,
  decisions: ActionDecisions,
  record: ActionRecord = recordOf("T-1042"),
): Promise<QueuedAction[]> {
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  const rows: QueuedAction[] = [];
  for (const step of actionSteps(source, (row) => {
    rows.push(row);
    return Promise.resolve();
  })) {
    await step.run(record, decisions);
  }
  return rows;
}

/** The studio's links as cli/links.ts builds them (studio-url.test.ts proves those, `.` and `..` keys too). */
const links = {
  record: (source: string, key: string) =>
    `${STUDIO}/decisions/${encodeURIComponent(source)}/${encodeURIComponent(key)}`,
  list: (source: string, range: { readonly from: Date; readonly to: Date }) =>
    `${STUDIO}/decisions?source=${encodeURIComponent(source)}&from=${encodeURIComponent(range.from.toISOString())}&to=${encodeURIComponent(range.to.toISOString())}`,
};

/**
 * The channel host's clock: the test's time, and a sleep that ends only when its signal aborts, so
 * the 20-second bound (proven in channel-host.test.ts) never cuts a delivery here.
 */
function patient(clock: FakeClock): Clock {
  return {
    now: () => clock.now(),
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        if (signal?.aborted === true) {
          resolve();
        } else {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        }
      }),
  };
}

function notifyDeps(clock = new FakeClock(START)): NotifyDeps {
  return {
    clock: patient(clock),
    stop: () => new AbortController().signal,
    recordLink: links.record,
    listLink: links.list,
  };
}

/** The source as the worker runs it: the record read with the decision's hash, a log that cannot judge. */
function running(): ActionSource {
  return {
    kind: "running",
    name: "support",
    connector: {
      read: (keys): Promise<ReadResult> =>
        Promise.resolve({
          rows: keys.map((key) => ({
            key,
            state: { body: STATE_WORDS },
            hash: "h1",
            excluded: false,
          })),
          missing: [],
        }),
    },
    log: { history: () => Promise.resolve([]) },
    questionSet: {
      questions: [],
      read: ["body"],
      model: "jev-1.14.0",
      thresholds: {},
    },
  };
}

/** A queued row as the outbox hands it back: through JSON, as the store keeps it. */
function delivery(row: QueuedAction, deliveryId = "1"): ActionDelivery {
  return {
    deliveryId,
    projectId: "shop",
    sourceId: "shop:support",
    recordKey: row.recordKey,
    plugin: row.plugin,
    action: row.action,
    position: row.position,
    payload: JSON.parse(JSON.stringify(row.payload)) as unknown,
    batchKey: row.batchKey,
    attempt: 1,
    queuedAt: START,
  };
}

/** Queues one decision and runs its row alone, as one of the first 10 of a minute: what was sent. */
async function sentFor(
  options: NotifyOptions,
  decisions: ActionDecisions,
  key = "T-1042",
  status: RecordStatus = "done",
): Promise<Sent[]> {
  const config = project([chat(options)]);
  const sent: Sent[] = [];
  const host = await hostFor(config, sent);
  checkActions(config, host, {});
  const rows = await queued(config, decisions, recordOf(key, status));
  const run = createActionRunner({ host, env: {}, notify: notifyDeps(), source: running });
  for (const row of rows) {
    expect(await run(delivery(row), new AbortController().signal)).toBeUndefined();
  }
  return sent;
}

describe("a notify's message", () => {
  it("names a noul with its value and how likely yes, and links the record's page", async () => {
    expect(
      await sentFor({ channel: "#support", when: { wants_refund: true } }, REFUND_YES),
    ).toEqual([
      {
        where: "#support",
        message: {
          kind: "record-notification",
          severity: "information",
          text: "Record T-1042 on support matched: wants_refund is yes (97% likely yes).",
          link: `${STUDIO}/decisions/support/T-1042`,
        },
      },
    ]);
  });

  it("names a choice with its option and how sure", async () => {
    const [sent] = await sentFor({ channel: "#billing", when: { team: "billing" } }, BILLING);
    expect(sent?.message.text).toBe(
      "Record T-1042 on support matched: team is billing (88% sure).",
    );
  });

  it("names a score with its level and how sure, and never the record's state", async () => {
    const [sent] = await sentFor(
      { channel: "#urgent", when: { urgency: "high", status: "done" } },
      HIGH,
    );
    expect(sent?.message.text).toBe(
      "Record T-1042 on support matched: urgency is high (91% sure) and its status is done.",
    );
    expect(JSON.stringify(sent)).not.toContain("4242");
  });

  it("names every question a condition names, once, a probability test included", async () => {
    const both: ActionDecisions = { ...REFUND_YES, ...BILLING, ...HIGH };
    const [sent] = await sentFor(
      {
        channel: "#urgent",
        when: { "wants_refund.probability": { atLeast: 0.9 }, wants_refund: true, team: "billing" },
      },
      both,
    );
    expect(sent?.message.text).toBe(
      "Record T-1042 on support matched: wants_refund is yes (97% likely yes) and team is billing (88% sure).",
    );
  });

  it("shows a key as printableKey does, and says every decision when it has no condition", async () => {
    const [dot] = await sentFor({ channel: "#urgent" }, HIGH, "..");
    expect(dot?.message).toEqual({
      kind: "record-notification",
      severity: "information",
      text: "Record .. on support was decided (its status is done).",
      link: `${STUDIO}/decisions/support/..`,
    });
    const [hidden] = await sentFor({ channel: "#urgent" }, HIGH, "T-1‮42");
    // A right-to-left override would turn the words around it: the key is shown without it.
    expect(hidden?.message.text).toBe(
      "Record T-142… (a key of 6 characters, shown in part) on support was decided (its status is done).",
    );
  });

  it("says a record waits for a person's review, not that it was decided, when it has no condition", async () => {
    const [waiting] = await sentFor(
      { channel: "#urgent" },
      { urgency: { kind: "needs_review" } },
      "T-7",
      "needs_review",
    );
    expect(waiting?.message.text).toBe(
      "Record T-7 on support waits for a person's review: the model was not sure enough to decide it.",
    );
  });
});

describe("a digest's words", () => {
  it("say the count is as each record was decided at the time, which the records are not read for", () => {
    const window = { kind: "quiet" as const, start: START, end: START + 9 * 3_600_000 };
    expect(
      digestText({
        source: "support",
        records: 6,
        condition: { urgency: "high", "wants_refund.probability": { atLeast: 0.9 } },
        window,
        address: "chat:#urgent",
      }),
    ).toBe(
      "While chat:#urgent was in quiet hours, 6 records on support matched urgency is high and wants_refund's probability is at least 90%; the count is as each was decided at the time.",
    );
    expect(
      digestText({
        source: "support",
        records: 1,
        condition: {},
        window: { ...window, kind: "minute" },
        address: "chat:#urgent",
      }),
    ).toBe(
      "1 more record on support was decided or left for a person's review within the same minute, after the first 10 were sent one by one; the count is as each was decided at the time.",
    );
  });
});

describe("a notify's condition", () => {
  it("queues a row on a probability at least the number, and none below it", async () => {
    const config = project([
      chat({ channel: "#urgent", when: { "wants_refund.probability": { atLeast: 0.9 } } }),
    ]);
    expect(await queued(config, REFUND_YES)).toHaveLength(1);
    expect(
      await queued(config, {
        wants_refund: { kind: "decided", value: true, probabilityOrConfidence: 0.85 },
      }),
    ).toEqual([]);
  });

  it("never queues a notification for a question still waiting for a person", async () => {
    const config = project([chat({ channel: "#urgent", when: { urgency: "high" } })]);
    expect(
      await queued(config, { urgency: { kind: "needs_review" } }, recordOf("T-1", "needs_review")),
    ).toEqual([]);
  });

  it("queues the row with its batch and its condition, never the record's state", async () => {
    const when: ActionCondition = { urgency: "high" };
    const [row] = await queued(project([chat({ channel: "#urgent", when })]), HIGH);
    expect(row).toEqual({
      recordKey: "T-1042",
      plugin: "@facetdb/chat",
      action: "notify",
      position: 0,
      batchKey: batchKeyOf("support", 0, "chat:#urgent"),
      payload: {
        status: "done",
        decidedAt: DECIDED_AT.toISOString(),
        stateHash: "h1",
        decisions: HIGH,
        settings: { channel: "#urgent" },
        condition: when,
      },
    });
    expect(JSON.stringify(row)).not.toContain("4242");
  });
});

describe("channel and to", () => {
  it("reads the same channel under either name", async () => {
    expect(notifyCall("@facetdb/chat", { to: "#urgent" })).toEqual({
      plugin: "@facetdb/chat",
      action: "notify",
      config: { to: "#urgent" },
    });
    const [sent] = await sentFor({ to: "#urgent", when: { urgency: "high" } }, HIGH);
    expect(sent?.where).toBe("#urgent");
    const [row] = await queued(project([chat({ to: "#urgent" })]), HIGH);
    expect(row?.batchKey).toBe(batchKeyOf("support", 0, "chat:#urgent"));
  });

  it("refuses both, neither, another setting and an else at load, each line saying what to do", async () => {
    const refused = await refusalOf(
      project([
        actionCall("@facetdb/chat", "notify", {
          channel: "#a",
          to: "#b",
          colour: "red",
          when: { urgency: "high" },
          else: { channel: "#low" },
        }),
      ]),
    );
    expect(refused.code).toBe("action-settings");
    expect(refused.message).toContain("sources[0].actions[0].else: a notification has no else");
    expect(refused.message).toContain("sources[0].actions[0].colour: is not a setting of notify");
    expect(refused.message).toContain("channel and to are the same setting; write one of them");

    const missing = await refusalOf(project([actionCall("@facetdb/chat", "notify", {})]));
    expect(missing.message).toContain("sources[0].actions[0].channel: is the channel to send to");
  });

  it("refuses a channel the plugin's schema refuses, and one its check says it can never reach", async () => {
    const refused = await refusalOf(project([chat({ channel: "support" })]));
    expect(refused.code).toBe("channel-where");
    expect(refused.message).toBe(
      'sources[0].actions[0] (@facetdb/chat notify) sends to chat:support, which the plugin "@facetdb/chat" refuses: a chat channel is # followed by lowercase letters and dashes',
    );
    const closed = await refusalOf(project([chat({ channel: "#closed" })]));
    expect(closed.message).toContain(
      "cannot be delivered to: the bot is not in #closed: invite it first",
    );
  });
});

describe("a plugin with no channel", () => {
  it("refuses notify at load, naming the plugin's own actions", async () => {
    const refused = await refusalOf(
      project([actionCall("@facetdb/tracker", "notify", { channel: "#urgent" })]),
    );
    expect(refused.code).toBe("plugin-no-action");
    expect(refused.message).toBe(
      'sources[0].actions[0] (@facetdb/tracker notify): notify sends a record notification through the plugin\'s alert channel, and the plugin "@facetdb/tracker" provides none (its actions are label)',
    );
    expect(refused.fix).toContain("change sources[0].actions[0].action to one of label");
  });

  it("cannot declare an action named notify, which is FacetDB's own", () => {
    expect(() =>
      definePlugin({
        name: "pager",
        version: "1.0.0",
        facetdb: "*",
        config: z.object({}),
        actions: { notify: action({ config: z.object({}), run: () => Promise.resolve() }) },
      }),
    ).toThrow(PluginError);
  });
});

describe("a notification's delivery", () => {
  it("fails in the channel host's words, never the plugin's, so the outbox retries it", async () => {
    const config = project([chat({ channel: "#urgent" })]);
    const failing = { fail: true };
    const host = await hostFor(config, [], failing);
    const [row] = await queued(config, HIGH);
    const run = createActionRunner({ host, env: {}, notify: notifyDeps(), source: running });
    await expect(run(delivery(row as QueuedAction), new AbortController().signal)).rejects.toThrow(
      "the channel plugin @facetdb/chat did not deliver the notification; its own error is not kept, as it may hold a secret",
    );
  });

  it("closes a row whose condition does not hold, as a process that checks no plugin may queue one", async () => {
    const config = project([chat({ channel: "#urgent", when: { urgency: "high" } })]);
    const sent: Sent[] = [];
    const host = await hostFor(config, sent);
    const [row] = await queued(config, HIGH);
    const low = {
      ...(row as QueuedAction),
      payload: {
        ...(row as QueuedAction).payload,
        decisions: {
          urgency: { kind: "decided", value: "low", probabilityOrConfidence: 0.7 },
        } as ActionDecisions,
      },
    };
    const run = createActionRunner({ host, env: {}, notify: notifyDeps(), source: running });
    expect(await run(delivery(low), new AbortController().signal)).toMatchObject({
      close: expect.stringContaining("condition does not hold"),
    });
    expect(sent).toEqual([]);
  });
});

describe("quiet hours", () => {
  it("are the alert channel's of the same plugin and channel, read in their zone", async () => {
    const config = project([chat({ channel: "#urgent" })], {
      channels: [{ to: "chat:#urgent", quiet: { from: "22:00", to: "07:00", zone: "UTC" } }],
    });
    const host = await hostFor(config);
    const quiet = notifyQuiet(config, host, () => "UTC");
    const night = Date.parse("2026-11-14T23:30:00.000Z");
    expect(quiet(batchKeyOf("support", 0, "chat:#urgent"), night)).toEqual({
      start: Date.parse("2026-11-14T22:00:00.000Z"),
      end: Date.parse("2026-11-15T07:00:00.000Z"),
    });
    expect(
      quiet(batchKeyOf("support", 0, "chat:#urgent"), Date.parse("2026-11-15T09:00:00.000Z")),
    ).toBeUndefined();
    // Another channel of the same plugin has none, and a key that cannot be read has none.
    expect(quiet(batchKeyOf("support", 0, "chat:#other"), night)).toBeUndefined();
    expect(quiet("not json", night)).toBeUndefined();
  });
});

describe("500 matches in a minute", () => {
  let pglite: PGlite;

  beforeAll(async () => {
    pglite = await freshPglite();
  });

  afterEach(async () => {
    await resetPglite(pglite);
  });

  afterAll(async () => {
    await pglite.close();
  });

  it("@timing are 10 messages and one digest, whose link opens the list of the other 490", async () => {
    const client = pgliteClient(pglite);
    await migrateStore(client);
    const clock = new FakeClock(START);
    const config = project([chat({ channel: "#urgent", when: { urgency: "high" } })]);
    const sent: Sent[] = [];
    const host = await hostFor(config, sent);
    checkActions(config, host, {});
    const deps = { host, env: {}, notify: notifyDeps(clock), source: running };
    const outbox = createOutbox({
      client,
      clock,
      fetch: () => Promise.resolve({ status: 204 }),
      abortAfter: () => new AbortController().signal,
      secretFor: () => Promise.reject(new Error("no webhook here")),
      onGiveUp: () => Promise.resolve(),
      runAction: createActionRunner(deps),
      runDigest: createDigestRunner(deps),
      quietPeriod: notifyQuiet(config, host, () => "UTC"),
    });
    const [source] = config.sources;
    const steps = actionSteps(source as (typeof config.sources)[number], (row) =>
      queueAction(client, clock, { projectId: "shop", sourceId: "shop:support", ...row }),
    );

    const decidedAt: Date[] = [];
    for (let index = 0; index < 500; index += 1) {
      decidedAt.push(new Date(clock.now()));
      for (const step of steps) {
        await step.run(recordOf(`T-${index}`, "done", new Date(clock.now())), HIGH);
      }
      clock.advance(100);
    }
    const drain = async (now: number) => {
      for (let pass = 0; pass < 50; pass += 1) {
        const report = await outbox.deliverDue(now);
        if (report.delivered.length + report.held.length === 0) {
          return;
        }
      }
    };

    await drain(clock.now());
    expect(sent.map((one) => one.message.text)).toEqual(
      Array.from(
        { length: 10 },
        (_, index) => `Record T-${index} on support matched: urgency is high (91% sure).`,
      ),
    );

    await drain(START + DIGEST_MINUTE_MS);
    expect(sent).toHaveLength(11);
    const digest = sent[10];
    expect(digest?.where).toBe("#urgent");
    expect(digest?.message.text).toBe(
      "490 more records on support matched urgency is high within the same minute, after the first 10 were sent one by one; the count is as each was decided at the time.",
    );
    // The list of that source from the 11th record's decision to just after the 500th's: every
    // decision of the 490, none of the first 10.
    const link = new URL(digest?.message.link ?? "");
    expect(`${link.origin}${link.pathname}`).toBe(`${STUDIO}/decisions`);
    expect(link.searchParams.get("source")).toBe("support");
    const from = Date.parse(link.searchParams.get("from") ?? "");
    const to = Date.parse(link.searchParams.get("to") ?? "");
    const listed = decidedAt.filter((at) => at.getTime() >= from && at.getTime() < to);
    expect(listed).toEqual(decidedAt.slice(10));
  });
});
