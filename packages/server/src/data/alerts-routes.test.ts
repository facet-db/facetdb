import type { AlertEvent, AlertKind, AlertRecord } from "@facetdb/core";
import type { ReviewerAccount } from "@facetdb/postgres";
import { describe, expect, it } from "vitest";
import { createApp, type StudioAccess } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import { createAccessService } from "./access.ts";
import { ALERT_HISTORY_LINES, channelOf, createAlertsService } from "./alerts.ts";

/**
 * `GET /v1/alerts` and `GET /v1/studio` on handwritten fakes: the channels as a kind and a name and
 * never anything else of the config, the history newest first with a resolved message folded into
 * the alert it ends, the cap on the lines read, and who may ask.
 */

const PROJECT = "marketplace";
const HOUR = 60 * 60_000;
/** Thursday 5 November 2026, 2:10 pm UTC. */
const NOW = Date.UTC(2026, 10, 5, 14, 10);

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: () => Promise.resolve(undefined),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
};

const NO_CONFIG: ConfigService = {
  json: () => {
    throw new Error("these tests read no config");
  },
  validate: () => {
    throw new Error("these tests validate no draft");
  },
  preview: () => Promise.reject(new Error("these tests preview nothing")),
  test: () => Promise.reject(new Error("these tests test nothing")),
  diff: () => Promise.reject(new Error("these tests apply nothing")),
  apply: () => Promise.reject(new Error("these tests apply nothing")),
  reload: () => Promise.reject(new Error("these tests reload nothing")),
};

const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };

function localStudio(projectId: string): StudioAccess {
  return {
    sessions: {
      signIn: () => Promise.reject(new Error("these tests sign nobody in")),
      reviewerFor: ({ local }) =>
        Promise.resolve(
          local ? { kind: "reviewer", name: "os:alex" } : { kind: "sign-in", why: "no-cookie" },
        ),
    },
    reviewers: {
      list: () => Promise.reject(new Error("these tests list no reviewers")),
      add: () => Promise.reject(new Error("these tests add no reviewer")),
      canAdd: () => Promise.resolve(false),
    },
    projectId,
  };
}

function event(
  kind: AlertKind,
  overrides: Partial<AlertEvent> & Pick<AlertEvent, "what" | "did">,
): AlertEvent {
  return {
    kind,
    project: PROJECT,
    source: "listings",
    question: null,
    link: "https://docs.facetdb.dev/fix/worker",
    ...overrides,
  };
}

function record(
  phase: AlertRecord["phase"],
  at: number,
  alert: AlertEvent,
  overrides: Partial<AlertRecord> = {},
): AlertRecord {
  return {
    at,
    key: `${alert.kind}|${alert.project}|${alert.source}|${alert.question ?? ""}`,
    phase,
    severity: phase === "resolved" ? "information" : "critical",
    event: alert,
    delivered: true,
    ...overrides,
  };
}

/** What a channel of the rig answers beside its kind, name and address: as written, bound, never tried. */
const UNTRIED = {
  sends: "everything",
  quiet: null,
  bound: true,
  delivering: null,
  last: null,
  summary: null,
} as const;

const ACCOUNTS: readonly ReviewerAccount[] = [
  { name: "sam", createdAt: new Date(NOW - 5 * HOUR) },
  { name: "maya", createdAt: new Date(NOW - 2 * HOUR) },
];

function rig(
  options: {
    readonly channels?: readonly string[];
    /** The channels facetdb.config.ts names now; the same as `channels` unless given. */
    readonly fileChannels?: readonly string[];
    readonly history?: readonly AlertRecord[];
    readonly host?: string;
    /** Whether the login may make an account; the default install's worker login may not. */
    readonly accountsWritable?: boolean;
    readonly alertsProject?: string;
  } = {},
) {
  const asked: number[] = [];
  const history = options.history ?? [];
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: {
      runs: { list: () => Promise.reject(new Error("these tests read no runs")) },
      decisions: {
        search: () => Promise.reject(new Error("these tests search no decisions")),
        why: () => Promise.reject(new Error("these tests explain no record")),
      },
      home: { home: () => Promise.reject(new Error("these tests read no home")) },
      sources: { sources: () => Promise.reject(new Error("these tests read no sources")) },
      alerts: createAlertsService({
        projectId: options.alertsProject ?? PROJECT,
        // An address alone, as the config writes it: sends everything, no quiet hours, bound.
        channels: () =>
          (options.channels ?? []).map((address) => ({
            address,
            sends: "everything" as const,
            bound: true,
          })),
        fileChannels: () =>
          (options.fileChannels ?? options.channels ?? []).map((address) => ({
            address,
            sends: "everything" as const,
          })),
        machineZone: () => "Europe/Berlin",
        reads: {
          recentAlerts: (_project, limit) => {
            asked.push(limit);
            return Promise.resolve(history.slice(0, limit));
          },
          lastDeliveries: () => Promise.resolve(new Map()),
          quietSummaries: () => Promise.resolve(new Map()),
        },
      }),
      access: createAccessService({
        host: options.host ?? "127.0.0.1",
        reviewers: {
          list: () => Promise.resolve(ACCOUNTS),
          canAdd: () => Promise.resolve(options.accountsWritable ?? false),
        },
      }),
    },
    studio: localStudio(PROJECT),
    review: NO_REVIEW,
    newRequestId: () => "req-1",
  });
  const get = async (path: string, from = THIS_MACHINE) => {
    const response = await app.request(path, {}, from);
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  };
  return { asked, get };
}

describe("a channel as the endpoint names it", () => {
  it("is the kind before the first colon and the name after it", () => {
    expect(channelOf("slack:#ops")).toEqual({ kind: "slack", name: "#ops" });
    expect(channelOf("email:ops@example.com")).toEqual({ kind: "email", name: "ops@example.com" });
    expect(channelOf("telegram:-100123")).toEqual({ kind: "telegram", name: "-100123" });
  });

  it("keeps no name that reads as a URL or carries a credential", () => {
    expect(channelOf("webhook:https://hooks.example.com/services/T0/B0/SECRET")).toEqual({
      kind: "webhook",
      name: null,
    });
    expect(channelOf("webhook:ops:hunter2@hooks.example.com")).toEqual({
      kind: "webhook",
      name: null,
    });
    expect(channelOf("not an address")).toEqual({ kind: "unknown", name: null });
  });
});

describe("GET /v1/alerts", () => {
  it("answers the channels as kinds and names and never a secret of the config", async () => {
    const secrets = ["SECRETTOKEN", "hunter2", "tokenvalue"];
    const t = rig({
      channels: [
        "slack:#ops",
        "email:ops@example.com",
        `webhook:https://hooks.example.com/services/T0/B0/${secrets[0]}`,
        `slack:ops:${secrets[1]}@hooks.example.com`,
        "telegram:-100123",
        // No scheme, and a token in the path and the query.
        `webhook:example.com/hook?token=${secrets[2]}`,
      ],
    });

    const { status, text, json } = await t.get("/v1/alerts");

    expect(status).toBe(200);
    // Every field of each channel: nothing beyond these is answered.
    expect(json["channels"]).toEqual(
      [
        { kind: "slack", name: "#ops", address: "slack:#ops" },
        { kind: "email", name: "ops@example.com", address: "email:ops@example.com" },
        { kind: "webhook", name: null, address: null },
        { kind: "slack", name: null, address: null },
        { kind: "telegram", name: "-100123", address: "telegram:-100123" },
        { kind: "webhook", name: null, address: null },
      ].map((channel) => ({ ...channel, ...UNTRIED })),
    );
    for (const secret of secrets) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("hooks.example.com");
    expect(text).not.toContain("example.com/hook");
  });

  it("says only whether the file names other channels than the ones the worker runs with", async () => {
    const same = rig({ channels: ["slack:#ops", "email:ops@example.com"] });
    expect((await same.get("/v1/alerts")).json["fileChannelsDiffer"]).toBe(false);

    // Order does not matter; a different list does, and no address of the file is answered.
    const reordered = rig({
      channels: ["slack:#ops", "email:ops@example.com"],
      fileChannels: ["email:ops@example.com", "slack:#ops"],
    });
    expect((await reordered.get("/v1/alerts")).json["fileChannelsDiffer"]).toBe(false);

    const changed = rig({
      channels: ["slack:#ops"],
      fileChannels: ["slack:#ops", "telegram:-100999"],
    });
    const { json, text } = await changed.get("/v1/alerts");
    expect(json["fileChannelsDiffer"]).toBe(true);
    expect(json["channels"]).toEqual([
      { kind: "slack", name: "#ops", address: "slack:#ops", ...UNTRIED },
    ]);
    expect(text).not.toContain("-100999");
  });

  it("answers the history newest first, a resolved message folded into the alert it ends", async () => {
    const failing = event("model_failing", {
      source: "support_messages",
      what: "6 of 100 model calls failed in the last 5 minutes.",
      did: "Retrying with backoff; a record that cannot be answered is marked error.",
    });
    const finished = event("backfill_finished", {
      what: "The backfill finished.",
      did: "Every page was settled.",
      link: "https://docs.facetdb.dev/fix/backfill",
    });
    const t = rig({
      history: [
        // Held for a channel in its quiet hours; an address that is not a name is not repeated.
        record("raised", NOW, finished, {
          severity: "information",
          held: ["slack:#ops", "hook:https://hooks.example.com/T0?token=s3cret"],
        }),
        record("resolved", NOW - 15 * HOUR, failing),
        record("raised", NOW - 16 * HOUR, failing),
      ],
    });

    const { json } = await t.get("/v1/alerts");

    expect(json["events"]).toEqual([
      {
        at: "2026-11-05T14:10:00.000Z",
        kind: "backfill_finished",
        severity: "information",
        title: "Backfill finished",
        what: "The backfill finished.",
        project: PROJECT,
        source: "listings",
        question: null,
        did: "Every page was settled.",
        link: "https://docs.facetdb.dev/fix/backfill",
        // Nothing ever resolves a finished backfill, so it claims neither open nor resolved.
        standing: { phase: "raised" },
        raisedBeforeHistory: false,
        delivered: true,
        pending: false,
        held: [
          { kind: "slack", name: "#ops", address: "slack:#ops" },
          { kind: "hook", name: null, address: null },
        ],
      },
      {
        at: "2026-11-04T22:10:00.000Z",
        kind: "model_failing",
        severity: "critical",
        title: "Model failing",
        what: "6 of 100 model calls failed in the last 5 minutes.",
        project: PROJECT,
        source: "support_messages",
        question: null,
        did: "Retrying with backoff; a record that cannot be answered is marked error.",
        link: "https://docs.facetdb.dev/fix/worker",
        standing: { phase: "resolved", at: "2026-11-04T23:10:00.000Z" },
        raisedBeforeHistory: false,
        delivered: true,
        pending: false,
        held: [],
      },
    ]);
    expect(JSON.stringify(json)).not.toContain("s3cret");
  });

  it("counts an alert raised again every 30 minutes as sent each time, resolved once", async () => {
    // A kind the code resolves (worker_not_running is raised once and never resolves).
    const down = event("model_failing", {
      source: "all sources",
      what: "6 of 100 model calls failed in the last 5 minutes.",
      did: "Retrying with backoff.",
    });
    const t = rig({
      history: [
        record("resolved", NOW, down),
        record("raised", NOW - 30 * 60_000, down),
        record("raised", NOW - 60 * 60_000, down),
      ],
    });

    const events = (await t.get("/v1/alerts")).json["events"] as readonly {
      readonly standing: unknown;
    }[];

    expect(events.map((one) => one.standing)).toEqual([
      { phase: "resolved", at: "2026-11-05T14:10:00.000Z" },
      { phase: "resolved", at: "2026-11-05T14:10:00.000Z" },
    ]);
  });

  it("keeps a new episode open beside the resolved one before it", async () => {
    const failing = event("model_failing", { what: "6 of 100 calls failed.", did: "Retrying." });
    const t = rig({
      history: [
        record("raised", NOW, failing),
        record("resolved", NOW - 2 * HOUR, failing),
        record("raised", NOW - 3 * HOUR, failing),
      ],
    });

    const events = (await t.get("/v1/alerts")).json["events"] as readonly {
      readonly standing: unknown;
    }[];

    expect(events.map((one) => one.standing)).toEqual([
      { phase: "open" },
      { phase: "resolved", at: "2026-11-05T12:10:00.000Z" },
    ]);
  });

  it("claims nothing about being over for a kind that nothing ever resolves", async () => {
    // A row written by an earlier version, with bare digits: read at a glance, the exact pair
    // after.
    const spending = event("spending_80", {
      what: "80% of the cap: 2400097 of 3000000 input tokens.",
      did: "Kept running.",
    });
    const t = rig({ history: [record("raised", NOW, spending, { severity: "warning" })] });

    const events = (await t.get("/v1/alerts")).json["events"] as readonly {
      readonly standing: unknown;
      readonly what: string;
    }[];

    expect(events.map((one) => one.standing)).toEqual([{ phase: "raised" }]);
    expect(events[0]?.what).toBe(
      "80% of the cap: 2.4M of 3M input tokens (2,400,097 of 3,000,000).",
    );
  });

  it("lists an action that gave up with the title core gives the kind", async () => {
    const gaveUp = event("action_gave_up", {
      source: "issues",
      what: "The action label of plugin github for source issues did not succeed after 31 attempts in 24 hours (delivery 7); the last error: GitHub answered 502.",
      did: "stopped trying after 24 hours; the decision is in the log",
      link: "https://docs.facetdb.dev/fix/actions",
    });
    const t = rig({ history: [record("raised", NOW, gaveUp, { severity: "warning" })] });

    const events = (await t.get("/v1/alerts")).json["events"] as readonly Record<string, unknown>[];

    expect(events).toEqual([
      expect.objectContaining({
        kind: "action_gave_up",
        title: "Action gave up",
        severity: "warning",
        source: "issues",
        standing: { phase: "raised" },
      }),
    ]);
  });

  it("keeps a resolved message whose alert is older than the lines read, marked as raised earlier", async () => {
    const lost = event("connector_lost_access", { what: "The login lost access.", did: "Held." });
    const t = rig({ history: [record("resolved", NOW, lost)] });

    const events = (await t.get("/v1/alerts")).json["events"] as readonly {
      readonly severity: string;
      readonly standing: unknown;
      readonly raisedBeforeHistory: boolean;
    }[];

    expect(events).toHaveLength(1);
    expect(events[0]?.severity).toBe("critical");
    expect(events[0]?.standing).toEqual({ phase: "resolved", at: "2026-11-05T14:10:00.000Z" });
    expect(events[0]?.raisedBeforeHistory).toBe(true);
  });

  it("reads at most the newest lines and says when older ones exist", async () => {
    const note = event("backfill_finished", { what: "Finished.", did: "Settled." });
    const many = Array.from({ length: ALERT_HISTORY_LINES + 20 }, (_, n) =>
      record("raised", NOW - n * 60_000, { ...note, source: `source_${String(n)}` }),
    );
    const t = rig({ history: many });

    const { json } = await t.get("/v1/alerts");

    expect(t.asked).toEqual([ALERT_HISTORY_LINES + 1]);
    expect((json["events"] as readonly unknown[]).length).toBe(ALERT_HISTORY_LINES);
    expect(json["limit"]).toBe(ALERT_HISTORY_LINES);
    expect(json["capped"]).toBe(true);
  });

  it("says the history is whole when fewer lines than the limit exist", async () => {
    const t = rig({ history: [] });
    const { json } = await t.get("/v1/alerts");
    expect(json).toEqual({
      channels: [],
      fileChannelsDiffer: false,
      workerZone: "Europe/Berlin",
      events: [],
      limit: ALERT_HISTORY_LINES,
      capped: false,
    });
  });

  it("refuses a studio that serves another project than the history's", async () => {
    const t = rig({ alertsProject: "another" });
    const { status, json } = await t.get("/v1/alerts");
    expect(status).toBe(404);
    expect(json["error"]).toMatchObject({ code: "unknown_project" });
  });

  it("asks a stranger elsewhere to sign in", async () => {
    const t = rig();
    for (const path of ["/v1/alerts", "/v1/studio"]) {
      const { status, json } = await t.get(path, ELSEWHERE);
      expect(status, path).toBe(401);
      expect(json["error"], path).toMatchObject({ code: "sign-in" });
    }
  });
});

describe("GET /v1/studio", () => {
  it("answers the host, that it is this machine alone, how many accounts exist, and that this login cannot make one", async () => {
    const t = rig({ host: "127.0.0.1" });
    const { json, text } = await t.get("/v1/studio");
    expect(json).toEqual({
      host: "127.0.0.1",
      loopback: true,
      reviewers: 2,
      accountsWritable: false,
    });
    expect(text).not.toContain("sam");
    expect(text).not.toContain("maya");
  });

  it("says a studio bound to every interface is not this machine alone, and when accounts can be made here", async () => {
    const t = rig({ host: "0.0.0.0", accountsWritable: true });
    expect((await t.get("/v1/studio")).json).toEqual({
      host: "0.0.0.0",
      loopback: false,
      reviewers: 2,
      accountsWritable: true,
    });
  });
});
