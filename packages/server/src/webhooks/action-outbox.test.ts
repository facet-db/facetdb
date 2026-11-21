import { ALERT_SEVERITY, ALERT_TITLES, alertMessage } from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { migrateStore, pgliteClient, sourceIdOf } from "@facetdb/postgres";
import { freshPglite, type PGlite, resetPglite } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GAVE_UP_DID, gaveUpAlert } from "./gave-up.ts";
import {
  ACTION_ERROR_NOT_KEPT,
  type ActionClose,
  type ActionDelivery,
  ActionFailed,
  CLAIM_LEASE_MS,
  createOutbox,
  DEFAULT_FETCH_TIMEOUT_MS,
  GIVE_UP_AFTER_MS,
  type NewAction,
  type OutboxDeps,
  retryDelayMs,
  type WebhookFetch,
  type WebhookGaveUp,
} from "./outbox.ts";

/**
 * Plugin actions through the outbox on PGlite: an action row is tried at the next pass by the
 * runner, retried on the webhook's schedule, closed untried when a later decision queued the same
 * action for the record, and given up after 24 hours with the action's names; a webhook row beside
 * it behaves as before. Concurrency is the `.db.test.ts`.
 */

const PROJECT = "project-1";
const SOURCE = "issues";
const SOURCE_ID = sourceIdOf(PROJECT, SOURCE);
const ENDPOINT = "https://hooks.example.com/facetdb";
const START = 1_700_000_000_000;

/** One engine for the file, emptied after every test. */
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

/** Timeout signals on the fake clock: `advance` aborts every signal whose time has come. */
function fakeTimeouts(clock: FakeClock) {
  const armed: { readonly at: number; readonly controller: AbortController }[] = [];
  return {
    abortAfter: (ms: number): AbortSignal => {
      const controller = new AbortController();
      armed.push({ at: clock.now() + ms, controller });
      return controller.signal;
    },
    advance(ms: number): void {
      clock.advance(ms);
      for (const timer of armed) {
        if (timer.at <= clock.now()) {
          timer.controller.abort(new Error("timed out on the fake clock"));
        }
      }
    },
  };
}

type Run = (row: ActionDelivery, signal: AbortSignal) => Promise<ActionClose | undefined>;

async function rig(options: { readonly runner?: "none" } = {}) {
  const client = pgliteClient(pglite);
  await migrateStore(client);
  const clock = new FakeClock(START);
  const timers = fakeTimeouts(clock);
  const runs: ActionDelivery[] = [];
  /** What the runner does at each call; it succeeds unless a test says otherwise. */
  const script: { run: Run } = { run: () => Promise.resolve(undefined) };
  const sent: string[] = [];
  const fetch: WebhookFetch = (url, init) => {
    sent.push(`${url} ${init.headers["facetdb-delivery"] ?? ""}`);
    return Promise.resolve({ status: 204 });
  };
  const gaveUp: { readonly event: WebhookGaveUp; readonly lastError: string }[] = [];
  const deps: OutboxDeps = {
    client,
    clock,
    fetch,
    abortAfter: timers.abortAfter,
    loopId: "loop-main",
    secretFor: () => Promise.resolve("whsec-test-secret"),
    onGiveUp: (event, _signal, lastError) => {
      gaveUp.push({ event, lastError });
      return Promise.resolve();
    },
  };
  const outbox = createOutbox(
    options.runner === "none"
      ? deps
      : {
          ...deps,
          runAction: (row, signal) => {
            runs.push(row);
            return script.run(row, signal);
          },
        },
  );

  function action(overrides: Partial<NewAction> = {}): Promise<string> {
    return outbox.enqueue({
      projectId: PROJECT,
      sourceId: SOURCE_ID,
      recordKey: "42",
      plugin: "github",
      action: "label",
      position: 0,
      payload: { status: "done", decisions: { kind: "bug" }, settings: { label: "bug" } },
      ...overrides,
    });
  }

  async function row(id: string) {
    const [found] = await client.query(
      `select attempts, next_attempt_at::text as next_attempt_at, delivered_at::text as delivered_at,
              gave_up_at::text as gave_up_at, superseded_at::text as superseded_at, last_error, endpoint
         from facetdb.webhook_outbox where id = $1::bigint`,
      [id],
    );
    if (found === undefined) {
      throw new Error(`no outbox row ${id}`);
    }
    return found;
  }

  return { client, clock, timers, outbox, script, runs, sent, gaveUp, action, row };
}

/** Makes the runner hang; resolves once it has been called, so a test advances the clock after. */
function startedRunner(t: { readonly script: { run: Run } }): Promise<void> {
  return new Promise<void>((resolve) => {
    t.script.run = () => {
      resolve();
      return new Promise<undefined>(() => undefined);
    };
  });
}

describe("an action row", () => {
  it("is tried at the next pass, handed to the runner with what was queued, and closed as delivered", async () => {
    const t = await rig();
    const id = await t.action({ batchKey: "issues:digest" });

    const report = await t.outbox.deliverDue(START);

    expect(report).toMatchObject({ delivered: [id], retrying: [], superseded: [], closed: [] });
    expect(t.runs).toEqual([
      {
        deliveryId: id,
        projectId: PROJECT,
        sourceId: SOURCE_ID,
        recordKey: "42",
        plugin: "github",
        action: "label",
        position: 0,
        payload: { status: "done", decisions: { kind: "bug" }, settings: { label: "bug" } },
        batchKey: "issues:digest",
        attempt: 1,
        queuedAt: START,
      },
    ]);
    // No URL, no signature: an action row is never sent as a webhook.
    expect(t.sent).toEqual([]);
    expect(await t.row(id)).toMatchObject({
      attempts: 1,
      delivered_at: String(START),
      gave_up_at: null,
      superseded_at: null,
      last_error: null,
      endpoint: null,
    });
    expect((await t.outbox.deliverDue(START + GIVE_UP_AFTER_MS)).delivered).toEqual([]);
    expect(t.runs).toHaveLength(1);
  });

  it("@timing follows the webhook's schedule after a failure, on a stepped clock, keeping the runner's words", async () => {
    const t = await rig();
    t.script.run = () => Promise.reject(new ActionFailed("GitHub answered 502"));
    const id = await t.action();

    let now = START;
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      // A moment before it is due, nothing runs.
      if (attempt > 1) {
        expect((await t.outbox.deliverDue(now - 1)).retrying).toEqual([]);
      }
      const report = await t.outbox.deliverDue(now);
      expect(report.retrying).toEqual([id]);
      const stored = await t.row(id);
      expect(stored).toMatchObject({ attempts: attempt, last_error: "GitHub answered 502" });
      expect(Number(stored["next_attempt_at"])).toBe(now + retryDelayMs(attempt));
      now = Number(stored["next_attempt_at"]);
    }
    expect(t.runs.map((run) => run.attempt)).toEqual([1, 2, 3, 4, 5]);

    // It succeeds at last: delivered, the error cleared.
    t.script.run = () => Promise.resolve(undefined);
    expect((await t.outbox.deliverDue(now)).delivered).toEqual([id]);
    expect(await t.row(id)).toMatchObject({ delivered_at: String(now), last_error: null });
  });

  it("@timing keeps no text of an error the runner does not vouch for, and counts a runner past the timeout as failed", async () => {
    const t = await rig();
    t.script.run = () =>
      Promise.reject(new Error("401 for token ghp_secret123 at https://api.github.com"));
    const id = await t.action();

    await t.outbox.deliverDue(START);
    const stored = await t.row(id);
    expect(stored["last_error"]).toBe(ACTION_ERROR_NOT_KEPT);
    expect(JSON.stringify(stored)).not.toContain("ghp_secret123");

    // A runner that never settles: the timeout ends the attempt, on the fake clock.
    const started = startedRunner(t);
    t.timers.advance(retryDelayMs(1));
    const pending = t.outbox.deliverDue(t.clock.now());
    await started;
    t.timers.advance(DEFAULT_FETCH_TIMEOUT_MS);
    expect((await pending).retrying).toEqual([id]);
    expect((await t.row(id))["last_error"]).toBe(
      `the action did not finish within ${DEFAULT_FETCH_TIMEOUT_MS} ms`,
    );
  });

  it("is closed untried, never deleted, when a later row queued the same action for the record", async () => {
    const t = await rig();
    const first = await t.action();
    const later = await t.action({ payload: { status: "done", decisions: { kind: "feature" } } });
    // Another record, another action, another place in the pipeline: none of them supersedes.
    const otherRecord = await t.action({ recordKey: "43" });
    const otherAction = await t.action({ action: "comment" });
    const otherPlace = await t.action({ position: 1 });

    const report = await t.outbox.deliverDue(START);

    expect(report.superseded).toEqual([first]);
    expect([...report.delivered].sort()).toEqual(
      [later, otherRecord, otherAction, otherPlace].sort(),
    );
    expect(t.runs.map((run) => run.deliveryId)).not.toContain(first);
    expect(t.runs.find((run) => run.deliveryId === later)?.payload).toEqual({
      status: "done",
      decisions: { kind: "feature" },
    });
    // The row stays, and says what happened to it and why.
    expect(await t.row(first)).toMatchObject({
      superseded_at: String(START),
      gave_up_at: String(START),
      delivered_at: null,
      last_error: `superseded by delivery ${later}: a later decision queued the same action for this record`,
    });
    expect(t.gaveUp).toEqual([]);
  });

  it("@timing is closed untried at its next attempt when a later decision arrives while it is failing", async () => {
    const t = await rig();
    t.script.run = () => Promise.reject(new ActionFailed("GitHub answered 502"));
    const first = await t.action();
    await t.outbox.deliverDue(START);
    t.clock.advance(1_000);
    const later = await t.action();

    t.script.run = () => Promise.resolve(undefined);
    const report = await t.outbox.deliverDue(START + retryDelayMs(1));
    expect(report).toMatchObject({ superseded: [first], delivered: [later] });
    expect(t.runs.filter((run) => run.deliveryId === first)).toHaveLength(1);
    expect(await t.row(first)).toMatchObject({ superseded_at: String(START + retryDelayMs(1)) });
  });

  it("@timing gives up 24 hours after it was queued, calling onGiveUp once with the action's names", async () => {
    const t = await rig();
    t.script.run = () => Promise.reject(new ActionFailed("GitHub answered 502"));
    const id = await t.action();
    const deadline = START + GIVE_UP_AFTER_MS;

    let now = START;
    for (let pass = 0; pass < 200; pass += 1) {
      const report = await t.outbox.deliverDue(now);
      if (report.gaveUp.length > 0) {
        expect(report.gaveUp).toEqual([id]);
        break;
      }
      expect(report.retrying).toEqual([id]);
      now = Number((await t.row(id))["next_attempt_at"]);
    }

    expect(now).toBe(deadline);
    expect(t.gaveUp).toEqual([
      {
        event: {
          projectId: PROJECT,
          deliveryId: id,
          sourceId: SOURCE_ID,
          plugin: "github",
          action: "label",
          attempts: t.runs.length,
          queuedAt: START,
        },
        lastError: "GitHub answered 502",
      },
    ]);
    expect(await t.row(id)).toMatchObject({
      gave_up_at: String(deadline),
      superseded_at: null,
      delivered_at: null,
      last_error: "GitHub answered 502",
    });
    const runs = t.runs.length;
    await t.outbox.deliverDue(deadline + 7 * GIVE_UP_AFTER_MS);
    expect(t.runs).toHaveLength(runs);
    expect(t.gaveUp).toHaveLength(1);
  });

  it("keeps a runner's own close with its reason, and never runs the row again", async () => {
    const t = await rig();
    t.script.run = () => Promise.resolve({ close: "record gone" });
    const id = await t.action();

    const report = await t.outbox.deliverDue(START);

    expect(report).toMatchObject({ closed: [id], delivered: [], retrying: [], superseded: [] });
    expect(await t.row(id)).toMatchObject({
      superseded_at: String(START),
      gave_up_at: String(START),
      delivered_at: null,
      last_error: "record gone",
    });
    await t.outbox.deliverDue(START + GIVE_UP_AFTER_MS);
    expect(t.runs).toHaveLength(1);
    expect(t.gaveUp).toEqual([]);
  });

  it("@timing writes nothing for a row whose claim another loop took after the lease", async () => {
    const t = await rig();
    let finish: (value: ActionClose | undefined) => void = () => undefined;
    let started: () => void = () => undefined;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    t.script.run = () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      });
    const id = await t.action();
    const slow = t.outbox.deliverDue(START);
    await running;

    // Another loop takes the row once the lease is over and runs it to the end.
    const other = createOutbox({
      client: t.client,
      clock: t.clock,
      fetch: () => Promise.resolve({ status: 204 }),
      abortAfter: () => new AbortController().signal,
      loopId: "loop-other",
      secretFor: () => Promise.resolve("whsec-test-secret"),
      onGiveUp: () => Promise.resolve(),
      runAction: () => Promise.resolve(undefined),
    });
    expect((await other.deliverDue(START + CLAIM_LEASE_MS)).delivered).toEqual([id]);

    finish({ close: "record gone" });
    expect(await slow).toMatchObject({ closed: [], lost: [id] });
    expect(await t.row(id)).toMatchObject({ superseded_at: null, last_error: null });
  });
});

describe("an endpoint row beside action rows", () => {
  it("is sent as before, and the runner never sees it", async () => {
    const t = await rig();
    const hook = await t.outbox.enqueue({ projectId: PROJECT, endpoint: ENDPOINT, payload: {} });
    const act = await t.action();

    const report = await t.outbox.deliverDue(START);

    expect([...report.delivered].sort()).toEqual([hook, act].sort());
    expect(t.sent).toEqual([`${ENDPOINT} ${hook}`]);
    expect(t.runs.map((run) => run.deliveryId)).toEqual([act]);
  });

  it("@timing gives up with the host as before", async () => {
    const t = await rig();
    const fails = createOutbox({
      client: t.client,
      clock: t.clock,
      fetch: () => Promise.resolve({ status: 500 }),
      abortAfter: t.timers.abortAfter,
      loopId: "loop-main",
      secretFor: () => Promise.resolve("whsec-test-secret"),
      onGiveUp: (event, _signal, lastError) => {
        t.gaveUp.push({ event, lastError });
        return Promise.resolve();
      },
      runAction: () => Promise.resolve(undefined),
    });
    const id = await fails.enqueue({ projectId: PROJECT, endpoint: ENDPOINT, payload: {} });
    let now = START;
    for (let pass = 0; pass < 200 && t.gaveUp.length === 0; pass += 1) {
      await fails.deliverDue(now);
      now = Number((await t.row(id))["next_attempt_at"]);
    }
    expect(t.gaveUp).toEqual([
      {
        event: {
          projectId: PROJECT,
          deliveryId: id,
          host: "hooks.example.com",
          attempts: expect.any(Number) as number,
          queuedAt: START,
        },
        lastError: "the receiver answered 500",
      },
    ]);
  });

  it("is the only kind an outbox with no runner claims: action rows wait for a loop that has one", async () => {
    const t = await rig({ runner: "none" });
    const hook = await t.outbox.enqueue({ projectId: PROJECT, endpoint: ENDPOINT, payload: {} });
    const act = await t.action();

    expect((await t.outbox.deliverDue(START + GIVE_UP_AFTER_MS)).delivered).toEqual([hook]);
    expect(await t.row(act)).toMatchObject({
      attempts: 0,
      delivered_at: null,
      gave_up_at: null,
      next_attempt_at: String(START),
    });
  });
});

/** The page the worker would name for each kind: the alert carries what it is given, never its own. */
const linkOf = (kind: "action" | "webhook"): string => `studio:${kind}`;

describe("the Action gave up alert", () => {
  it("names the source, the action, the attempts and the last error, and what FacetDB did", () => {
    const event = gaveUpAlert(
      {
        projectId: PROJECT,
        deliveryId: "7",
        sourceId: SOURCE_ID,
        plugin: "github",
        action: "label",
        attempts: 31,
        queuedAt: START,
      },
      "GitHub answered 502",
      linkOf,
    );
    expect(event).toEqual({
      kind: "action_gave_up",
      what: "The action label of plugin github for source issues did not succeed after 31 attempts in 24 hours (delivery 7); the last error: GitHub answered 502.",
      project: PROJECT,
      source: SOURCE,
      question: null,
      did: GAVE_UP_DID,
      link: "studio:action",
    });
    expect(GAVE_UP_DID).toBe("stopped trying after 24 hours; the decision is in the log");
    expect(ALERT_TITLES.action_gave_up).toBe("Action gave up");
    expect(ALERT_SEVERITY.action_gave_up).toBe("warning");
    expect(alertMessage(event)).toMatchObject({ severity: "warning", link: "studio:action" });
  });

  it("names a webhook by its host alone, for the whole project", () => {
    const event = gaveUpAlert(
      {
        projectId: PROJECT,
        deliveryId: "8",
        host: "hooks.example.com",
        attempts: 1,
        queuedAt: START,
      },
      "the receiver answered 500",
      linkOf,
    );
    expect(event).toMatchObject({
      kind: "action_gave_up",
      what: "The webhook to hooks.example.com did not succeed after 1 attempt in 24 hours (delivery 8); the last error: the receiver answered 500.",
      source: "all sources",
      link: "studio:webhook",
    });
    expect(JSON.stringify(event)).not.toContain("/facetdb");
  });
});
