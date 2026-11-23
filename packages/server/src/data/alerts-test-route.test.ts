import {
  type BoundChannel,
  ChannelFailed,
  createAlerts,
  DELIVERY_ERROR_NOT_KEPT,
} from "@facetdb/core";
import { FakeAlertStore, FakeClock } from "@facetdb/core/testing";
import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import { SESSION_COOKIE, type Sessions } from "../auth/sessions.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import { type AlertTestDoor, type AlertTestOutcome, NO_ALERT_TEST } from "./alerts-test.ts";
import type { DataServices } from "./routes.ts";

/**
 * `POST /v1/alerts/test`: a reviewer's alone, and only from the studio's own page or a program; the
 * body `{ channel }` parsed at the boundary and refused before the door hears of it; `{ sent: true
 * }`, 404 `unknown_channel` and 502 `channel_failed` with the words the history keeps; no address,
 * secret or plugin error repeated; a worker that offers no door (`--once`) refusing; and, through
 * core's alerts, a test that goes through a quiet channel that sends only critical alerts, and is
 * never written to the history.
 */

const PROJECT = "marketplace";
const KEY = "Bearer fdb_marketplace";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const MAYA = `${SESSION_COOKIE}=maya.valid`;
const SECRET = "xoxb-4207-9d8c7b6a5f4e3d2c";

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: (header) =>
    Promise.resolve(header === KEY ? { id: "key-1", projectId: PROJECT } : undefined),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

/** This machine is the OS user; a cookie `maya.valid` is maya, from anywhere. */
const sessions: Sessions = {
  signIn: () => Promise.reject(new Error("these tests sign nobody in")),
  reviewerFor: ({ local, cookie }) =>
    Promise.resolve(
      cookie === "maya.valid"
        ? { kind: "reviewer", name: "maya" }
        : cookie === undefined && local
          ? { kind: "reviewer", name: "os:alex" }
          : { kind: "sign-in", why: cookie === undefined ? "no-cookie" : "invalid" },
    ),
};

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
};

const NO_CONFIG: ConfigService = {
  json: () => Promise.reject(new Error("these tests read no configuration")),
  validate: () => {
    throw new Error("these tests judge no draft");
  },
  preview: () => Promise.reject(new Error("these tests preview nothing")),
  test: () => Promise.reject(new Error("these tests test no draft")),
  diff: () => Promise.reject(new Error("these tests ask for no diff")),
  apply: () => Promise.reject(new Error("these tests apply nothing")),
  reload: () => Promise.reject(new Error("these tests reload nothing")),
};

const NO_DATA: DataServices = {
  runs: { list: () => Promise.reject(new Error("these tests read no runs")) },
  decisions: {
    search: () => Promise.reject(new Error("these tests search no decisions")),
    why: () => Promise.reject(new Error("these tests explain no record")),
  },
  home: { home: () => Promise.reject(new Error("these tests read no home")) },
  sources: { sources: () => Promise.reject(new Error("these tests read no sources")) },
  alerts: { alerts: () => Promise.reject(new Error("these tests read no alerts")) },
  access: { access: () => Promise.reject(new Error("these tests read no studio access")) },
};

/** A door that records the addresses it was asked for and answers what the test hands it. */
function recordingDoor(outcome: AlertTestOutcome = { kind: "sent" }) {
  const asked: string[] = [];
  const door: AlertTestDoor = {
    available: true,
    send: (address) => {
      asked.push(address);
      return Promise.resolve(outcome);
    },
  };
  return { asked, door };
}

type Who = {
  readonly peer?: { readonly remoteAddress: string };
  readonly headers?: Readonly<Record<string, string>>;
};

/** The app with the door given, or with none: a worker that sends no test (`--once`). */
function rig(door: AlertTestDoor | undefined) {
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: { ...NO_DATA, ...(door === undefined ? {} : { alertTest: door }) },
    review: NO_REVIEW,
    studio: {
      sessions,
      reviewers: {
        list: () => Promise.reject(new Error("these tests list no reviewers")),
        add: () => Promise.reject(new Error("these tests add no reviewer")),
        canAdd: () => Promise.resolve(false),
      },
      projectId: PROJECT,
      operatorByAddress: true,
      log: () => undefined,
    },
    newRequestId: () => "req-1",
  });
  return async (body: unknown, who: Who = {}) => {
    const response = await app.request(
      "/v1/alerts/test",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...who.headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      who.peer ?? THIS_MACHINE,
    );
    const text = await response.text();
    return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
  };
}

describe("POST /v1/alerts/test", () => {
  it("sends through the channel the body names and answers { sent: true }", async () => {
    const t = recordingDoor();
    const post = rig(t.door);
    expect(await post({ channel: "slack:#ops" })).toMatchObject({
      status: 200,
      json: { sent: true },
    });
    expect(t.asked).toEqual(["slack:#ops"]);
  });

  it("answers 404 unknown_channel for an address the config does not name, repeating none", async () => {
    const t = recordingDoor({ kind: "unknown_channel" });
    const post = rig(t.door);
    const answer = await post({ channel: "slack:#nowhere" });
    expect(answer).toMatchObject({
      status: 404,
      json: {
        error: {
          code: "unknown_channel",
          message:
            "This worker runs no alert channel at that address, so no test message was sent.",
        },
      },
    });
    expect(answer.text).not.toContain("#nowhere");
    // An address that carries a credential is no channel either, and is not repeated.
    const url = await post({ channel: `https://hooks.slack.com/services/${SECRET}` });
    expect(url.status).toBe(404);
    expect(url.text).not.toContain(SECRET);
    expect(url.text).not.toContain("hooks.slack.com");
  });

  it("answers 502 channel_failed with the words the door kept, and no address", async () => {
    const t = recordingDoor({ kind: "failed", error: "the channel refused it" });
    const post = rig(t.door);
    const answer = await post({ channel: "slack:#ops" });
    expect(answer).toMatchObject({
      status: 502,
      json: {
        error: {
          code: "channel_failed",
          message: "The channel did not take the test message: the channel refused it.",
        },
      },
    });
    expect(answer.text).not.toContain("#ops");
  });

  it("refuses a body that is not { channel: <address> } before the door hears of it, repeating nothing given", async () => {
    const t = recordingDoor();
    const post = rig(t.door);
    for (const body of [
      {},
      { channel: "" },
      { channel: 42 },
      { channel: "ops" },
      { channel: "slack:#ops", extra: true },
      { channel: `slack:${SECRET}${"x".repeat(600)}` },
      { channel: ` slack:${SECRET}` },
    ]) {
      const answer = await post(body);
      expect(answer.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(answer.json).toMatchObject({ error: { code: "invalid_request" } });
      expect(answer.text).not.toContain(SECRET);
    }
    expect(await post("{not json")).toMatchObject({
      status: 400,
      json: { error: { code: "invalid_json" } },
    });
    expect(t.asked).toEqual([]);
  });

  it("is a reviewer's alone, from the studio's own page or a program", async () => {
    const t = recordingDoor();
    const post = rig(t.door);
    for (const headers of [{}, { authorization: KEY }]) {
      expect(await post({ channel: "slack:#ops" }, { peer: ELSEWHERE, headers })).toMatchObject({
        status: 401,
        json: { error: { code: "sign-in" } },
      });
    }
    expect(
      await post(JSON.stringify({ channel: "slack:#ops" }), {
        headers: { "content-type": "text/plain" },
      }),
    ).toMatchObject({ status: 415, json: { error: { code: "json_only" } } });
    expect(
      await post(
        { channel: "slack:#ops" },
        { peer: ELSEWHERE, headers: { cookie: MAYA, "sec-fetch-site": "cross-site" } },
      ),
    ).toMatchObject({ status: 403, json: { error: { code: "cross_origin" } } });
    expect(t.asked).toEqual([]);

    expect(
      await post(
        { channel: "slack:#ops" },
        { peer: ELSEWHERE, headers: { cookie: MAYA, "sec-fetch-site": "same-origin" } },
      ),
    ).toMatchObject({ status: 200, json: { sent: true } });
  });

  it("answers 409 alert_test_unavailable from a worker that offers no door, as under --once", async () => {
    for (const post of [rig(undefined), rig(NO_ALERT_TEST)]) {
      expect(await post({ channel: "slack:#ops" })).toMatchObject({
        status: 409,
        json: {
          error: {
            code: "alert_test_unavailable",
            message:
              "This worker sends no test message: facetdb worker --once answers what is queued and exits.",
          },
        },
      });
    }
  });
});

describe("the test message through the worker's alerts", () => {
  /** 03:00Z, inside the channel's quiet hours of 22:00 to 07:00. */
  const NIGHT = Date.UTC(2026, 10, 14, 3, 0);

  function throughAlerts(channels: readonly BoundChannel[]) {
    const clock = new FakeClock(NIGHT);
    const store = new FakeAlertStore(clock);
    const alerts = createAlerts({ store, clock, channels });
    const door: AlertTestDoor = {
      available: true,
      send: (address) =>
        alerts.test(address, { project: PROJECT, link: "https://studio.test/alerts" }),
    };
    return { store, post: rig(door) };
  }

  it("goes through a quiet channel that sends only critical alerts, and is never written to the history", async () => {
    const sent: unknown[] = [];
    const { store, post } = throughAlerts([
      {
        name: "slack:#ops",
        takes: (severity) => severity === "critical",
        quiet: { from: "22:00", to: "07:00", zone: "UTC" },
        deliver: (message) => {
          sent.push(message);
          return Promise.resolve();
        },
      },
    ]);
    expect(await post({ channel: "slack:#ops" })).toMatchObject({
      status: 200,
      json: { sent: true },
    });
    expect(sent).toEqual([
      expect.objectContaining({
        severity: "information",
        text: expect.stringMatching(/^Test message from FacetDB/),
      }),
    ]);
    expect(await post({ channel: "slack:#data" })).toMatchObject({
      status: 404,
      json: { error: { code: "unknown_channel" } },
    });
    expect(store.history).toEqual([]);
    expect(store.active.size).toBe(0);
  });

  it("answers a channel plugin's own error with the fixed words, and a channel host's in its words", async () => {
    const { store, post } = throughAlerts([
      {
        name: "slack:#ops",
        deliver: () => Promise.reject(new Error(`invalid_auth for ${SECRET}`)),
      },
      {
        name: "slack:#data",
        deliver: () =>
          Promise.reject(new ChannelFailed("the channel did not answer within 20 seconds")),
      },
    ]);
    const leaky = await post({ channel: "slack:#ops" });
    expect(leaky).toMatchObject({
      status: 502,
      json: {
        error: {
          code: "channel_failed",
          message: `The channel did not take the test message: ${DELIVERY_ERROR_NOT_KEPT}.`,
        },
      },
    });
    expect(leaky.text).not.toContain(SECRET);
    expect(leaky.text).not.toContain("invalid_auth");
    expect(await post({ channel: "slack:#data" })).toMatchObject({
      status: 502,
      json: {
        error: {
          message:
            "The channel did not take the test message: the channel did not answer within 20 seconds.",
        },
      },
    });
    expect(store.history).toEqual([]);
  });
});
