import { FakeClock } from "@facetdb/core/testing";
import { migrateStore, pgliteClient, sourceIdOf } from "@facetdb/postgres";
import { freshPglite, type PGlite, resetPglite } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ActionClose,
  type ActionDelivery,
  ActionFailed,
  ALERT_NOT_RAISED,
  CLAIM_LEASE_MS,
  createOutbox,
  DIGEST_AFTER,
  DIGEST_MINUTE_MS,
  type DigestDelivery,
  GIVE_UP_AFTER_MS,
  HELD_FOR_DIGEST,
  HELD_FOR_QUIET,
  type OutboxDeps,
  retryDelayMs,
  type TimeSpan,
  type WebhookGaveUp,
} from "./outbox.ts";

/**
 * The digest rule on PGlite and a stepped clock: of the rows one batch key queues in a clock
 * minute, the first 10 are run one by one as they happen and the rest wait for the minute's end,
 * then go to the digest's runner together, once. A digest that fails is retried as a whole with its
 * rows open; a crash loses nothing, as the rows are the state. A row queued while its channel is
 * quiet waits for the quiet hours' end and joins one digest then.
 */

const PROJECT = "project-1";
const SOURCE = "support";
const SOURCE_ID = sourceIdOf(PROJECT, SOURCE);
/** A whole minute since the epoch, so a test's rows fall inside one minute. */
const MINUTE = 1_700_000_040_000;
const URGENT = JSON.stringify([SOURCE, 0, "slack:#urgent"]);
const BILLING = JSON.stringify([SOURCE, 1, "slack:#billing"]);

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

type DigestRun = (digest: DigestDelivery) => Promise<ActionClose | undefined>;

async function rig(
  options: { readonly quiet?: (batchKey: string, at: number) => TimeSpan | undefined } = {},
) {
  const store = pgliteClient(pglite);
  await migrateStore(store);
  const clock = new FakeClock(MINUTE);
  const alone: ActionDelivery[] = [];
  const digests: DigestDelivery[] = [];
  const script: { digest: DigestRun; alertFails: boolean; placingFails: boolean } = {
    digest: () => Promise.resolve(undefined),
    alertFails: false,
    placingFails: false,
  };
  /** The store, whose statement that counts a minute's first rows fails while a test says so. */
  const client: OutboxDeps["client"] = {
    query: (text, params) =>
      script.placingFails && text.includes("offset $5::integer limit 1")
        ? Promise.reject(new Error("the store went away"))
        : store.query(text, params),
  };
  const gaveUp: WebhookGaveUp[] = [];
  const deps = (loopId: string): OutboxDeps => ({
    client,
    clock,
    fetch: () => Promise.resolve({ status: 204 }),
    abortAfter: () => new AbortController().signal,
    loopId,
    secretFor: () => Promise.resolve("whsec-test-secret"),
    onGiveUp: (event) => {
      if (script.alertFails) {
        return Promise.reject(new Error("the alerts table is unreachable"));
      }
      gaveUp.push(event);
      return Promise.resolve();
    },
    runAction: (row) => {
      alone.push(row);
      return Promise.resolve(undefined);
    },
    runDigest: (digest) => {
      digests.push(digest);
      return script.digest(digest);
    },
    ...(options.quiet === undefined ? {} : { quietPeriod: options.quiet }),
  });
  const outbox = createOutbox(deps("loop-a"));

  /** Queues `count` notifications of one batch key, 100 ms apart, each for its own record. */
  async function notify(count: number, batchKey = URGENT, from = 0): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(
        await outbox.enqueue({
          projectId: PROJECT,
          sourceId: SOURCE_ID,
          recordKey: `T-${from + index}`,
          plugin: "@facetdb/slack",
          action: "notify",
          position: batchKey === URGENT ? 0 : 1,
          payload: { decided: from + index },
          batchKey,
        }),
      );
      clock.advance(100);
    }
    return ids;
  }

  /** Runs passes at `now` until one claims nothing more: the claim takes 20 rows at a time. */
  async function drain(now: number) {
    const reports = [];
    for (let pass = 0; pass < 100; pass += 1) {
      const report = await outbox.deliverDue(now);
      reports.push(report);
      const touched =
        report.delivered.length +
        report.held.length +
        report.retrying.length +
        report.closed.length;
      if (touched === 0) {
        break;
      }
    }
    return {
      delivered: reports.flatMap((report) => report.delivered),
      held: reports.flatMap((report) => report.held),
      retrying: reports.flatMap((report) => report.retrying),
      lost: reports.flatMap((report) => report.lost),
    };
  }

  async function open(): Promise<number> {
    const [row] = await client.query(
      `select count(*)::int as n from facetdb.webhook_outbox where delivered_at is null and gave_up_at is null`,
    );
    return Number(row?.["n"]);
  }

  async function row(id: string) {
    const [found] = await client.query(
      `select attempts, next_attempt_at::text as next_attempt_at, delivered_at::text as delivered_at,
              gave_up_at::text as gave_up_at, last_error
         from facetdb.webhook_outbox where id = $1::bigint`,
      [id],
    );
    return found;
  }

  return { client, clock, deps, outbox, alone, digests, script, gaveUp, notify, drain, open, row };
}

const keysOf = (digest: DigestDelivery | undefined) => digest?.rows.map((row) => row.recordKey);

describe("the first 10 of a minute go out as they happen", () => {
  it("runs 9 rows of a minute one by one, and no digest", async () => {
    const t = await rig();
    const ids = await t.notify(9);

    expect((await t.drain(t.clock.now())).delivered.sort()).toEqual([...ids].sort());
    expect(t.alone.map((row) => row.recordKey)).toEqual(
      Array.from({ length: 9 }, (_, index) => `T-${index}`),
    );
    await t.drain(MINUTE + DIGEST_MINUTE_MS);
    expect(t.digests).toEqual([]);
    expect(await t.open()).toBe(0);
  });

  it("runs 10 rows of a minute one by one, and no digest", async () => {
    const t = await rig();
    await t.notify(10);

    await t.drain(t.clock.now());
    await t.drain(MINUTE + DIGEST_MINUTE_MS);
    expect(t.alone).toHaveLength(10);
    expect(t.digests).toEqual([]);
    expect(await t.open()).toBe(0);
  });

  it("@timing holds the 11th until the minute ends, then sends it as a digest of one", async () => {
    const t = await rig();
    const ids = await t.notify(11);
    const eleventh = ids[10] as string;

    const during = await t.drain(t.clock.now());
    expect(t.alone).toHaveLength(10);
    // Queued past the first 10, it was due at the minute's end from the start: never claimed.
    expect(during.held).toEqual([]);
    expect(await t.row(eleventh)).toMatchObject({
      attempts: 0,
      next_attempt_at: String(MINUTE + DIGEST_MINUTE_MS),
      delivered_at: null,
    });
    expect((await t.drain(MINUTE + DIGEST_MINUTE_MS - 1)).delivered).toEqual([]);

    const after = await t.drain(MINUTE + DIGEST_MINUTE_MS);
    expect(after.delivered).toEqual([eleventh]);
    expect(t.digests).toHaveLength(1);
    expect(t.digests[0]).toMatchObject({
      projectId: PROJECT,
      sourceId: SOURCE_ID,
      plugin: "@facetdb/slack",
      action: "notify",
      position: 0,
      batchKey: URGENT,
      window: { kind: "minute", start: MINUTE, end: MINUTE + DIGEST_MINUTE_MS },
      attempt: 1,
      rows: [{ deliveryId: eleventh, recordKey: "T-10", payload: { decided: 10 } }],
    });
    expect(t.alone).toHaveLength(10);
    expect(await t.open()).toBe(0);
  });

  it("@timing sends 500 matches of a minute as 10 messages and one digest of the other 490", async () => {
    const t = await rig();
    const ids = await t.notify(500);
    expect(t.clock.now()).toBeLessThan(MINUTE + DIGEST_MINUTE_MS);

    await t.drain(t.clock.now());
    expect(t.alone.map((row) => row.deliveryId)).toEqual(ids.slice(0, DIGEST_AFTER));

    const after = await t.drain(MINUTE + DIGEST_MINUTE_MS);
    expect(t.digests).toHaveLength(1);
    const [digest] = t.digests;
    expect(digest?.rows.map((row) => row.deliveryId)).toEqual(ids.slice(DIGEST_AFTER));
    expect(keysOf(digest)).toHaveLength(490);
    expect(after.delivered.sort()).toEqual(ids.slice(DIGEST_AFTER).sort());
    expect(t.alone).toHaveLength(DIGEST_AFTER);
    expect(await t.open()).toBe(0);
  });

  it("decides by the rows' order in the store when two processes both counted nine at queueing", async () => {
    const t = await rig();
    const ids = await t.notify(13);
    // As if every row had been queued due now: the guess at queueing was wrong for the last three.
    await t.client.query(`update facetdb.webhook_outbox set next_attempt_at = created_at`);

    const during = await t.drain(t.clock.now());
    expect(t.alone.map((row) => row.deliveryId)).toEqual(ids.slice(0, DIGEST_AFTER));
    expect(during.held.sort()).toEqual(ids.slice(DIGEST_AFTER).sort());
    // Held, the attempt it was claimed for given back, its reason said.
    expect(await t.row(ids[12] as string)).toMatchObject({
      attempts: 0,
      next_attempt_at: String(MINUTE + DIGEST_MINUTE_MS),
      last_error: HELD_FOR_DIGEST,
    });

    await t.drain(MINUTE + DIGEST_MINUTE_MS);
    expect(t.digests.map(keysOf)).toEqual([["T-10", "T-11", "T-12"]]);
    expect(await t.open()).toBe(0);
  });

  it("counts each batch key on its own: two in one minute, two first tens and two digests", async () => {
    const t = await rig();
    const urgent = await t.notify(12, URGENT, 0);
    const billing = await t.notify(13, BILLING, 100);

    await t.drain(t.clock.now());
    expect(t.alone.filter((row) => row.position === 0)).toHaveLength(DIGEST_AFTER);
    expect(t.alone.filter((row) => row.position === 1)).toHaveLength(DIGEST_AFTER);

    await t.drain(MINUTE + DIGEST_MINUTE_MS);
    const byKey = new Map(t.digests.map((digest) => [digest.batchKey, digest]));
    expect(t.digests).toHaveLength(2);
    expect(byKey.get(URGENT)?.rows.map((row) => row.deliveryId)).toEqual(urgent.slice(10));
    expect(byKey.get(BILLING)?.rows.map((row) => row.deliveryId)).toEqual(billing.slice(10));
    expect(await t.open()).toBe(0);
  });

  it("starts a new count in the next minute", async () => {
    const t = await rig();
    await t.notify(12);
    t.clock.advance(MINUTE + DIGEST_MINUTE_MS - t.clock.now());
    await t.notify(3, URGENT, 50);

    await t.drain(t.clock.now());
    expect(t.digests.map(keysOf)).toEqual([["T-10", "T-11"]]);
    expect(t.alone.map((row) => row.recordKey)).toEqual([
      ...Array.from({ length: 10 }, (_, index) => `T-${index}`),
      "T-50",
      "T-51",
      "T-52",
    ]);
  });
});

describe("a digest that fails", () => {
  it("@timing is retried as a whole on the webhook's schedule, its rows open, and delivered once", async () => {
    const t = await rig();
    const ids = await t.notify(15);
    await t.drain(t.clock.now());
    const digestIds = ids.slice(DIGEST_AFTER);
    let failures = 0;
    t.script.digest = () => {
      failures += 1;
      return failures <= 2
        ? Promise.reject(new ActionFailed("Slack answered 503"))
        : Promise.resolve(undefined);
    };

    const end = MINUTE + DIGEST_MINUTE_MS;
    expect((await t.drain(end)).retrying.sort()).toEqual([...digestIds].sort());
    for (const id of digestIds) {
      expect(await t.row(id)).toMatchObject({
        attempts: 1,
        next_attempt_at: String(end + retryDelayMs(1)),
        delivered_at: null,
        last_error: "Slack answered 503",
      });
    }
    expect((await t.drain(end + retryDelayMs(1) - 1)).retrying).toEqual([]);
    expect((await t.drain(end + retryDelayMs(1))).retrying).toHaveLength(5);
    const third = end + retryDelayMs(1) + retryDelayMs(2);
    expect((await t.drain(third)).delivered.sort()).toEqual([...digestIds].sort());

    expect(t.digests).toHaveLength(3);
    expect(t.digests.map((digest) => digest.attempt)).toEqual([1, 2, 3]);
    for (const digest of t.digests) {
      expect(digest.rows.map((row) => row.deliveryId)).toEqual(digestIds);
    }
    expect(await t.row(digestIds[0] as string)).toMatchObject({ last_error: null });
    expect(await t.open()).toBe(0);
    expect(t.alone).toHaveLength(DIGEST_AFTER);
  });

  it("is given up past 24 hours with one alert, every row of it closed", async () => {
    const t = await rig();
    const ids = await t.notify(13);
    await t.drain(t.clock.now());
    t.script.digest = () => Promise.reject(new ActionFailed("Slack answered 503"));
    await t.drain(MINUTE + DIGEST_MINUTE_MS);

    // A moment before the 24 hours of its oldest row are spent, it is retried once more.
    const queuedAt = MINUTE + DIGEST_AFTER * 100;
    expect((await t.drain(queuedAt + GIVE_UP_AFTER_MS - 1)).retrying).toHaveLength(3);
    const late = queuedAt + GIVE_UP_AFTER_MS;
    const report = await t.drain(late);
    expect(report.retrying).toEqual([]);
    expect(t.gaveUp).toEqual([
      expect.objectContaining({
        deliveryId: ids[10],
        sourceId: SOURCE_ID,
        plugin: "@facetdb/slack",
        action: "notify",
        queuedAt,
      }),
    ]);
    for (const id of ids.slice(DIGEST_AFTER)) {
      expect((await t.row(id))?.["gave_up_at"]).toBe(String(late));
    }
    expect((await t.row(ids[11] as string))?.["last_error"]).toBe(
      `Slack answered 503 (given up with its digest; delivery ${ids[10]} raised its alert)`,
    );
    expect(await t.open()).toBe(0);
  });

  it("says so when its give-up alert could not be raised, and tries the alert alone once more", async () => {
    const t = await rig();
    const ids = await t.notify(13);
    await t.drain(t.clock.now());
    t.script.digest = () => Promise.reject(new ActionFailed("Slack answered 503"));
    await t.drain(MINUTE + DIGEST_MINUTE_MS);
    const late = MINUTE + DIGEST_AFTER * 100 + GIVE_UP_AFTER_MS;
    t.script.alertFails = true;

    const report = await t.outbox.deliverDue(late);
    expect(report.alertFailures).toEqual([
      expect.objectContaining({
        final: false,
        event: expect.objectContaining({ deliveryId: ids[10] }),
      }),
    ]);
    // The oldest row waits for its alert's one more try; the others are closed, saying so truly.
    expect(report.retrying).toEqual([ids[10]]);
    expect((await t.row(ids[10] as string))?.["last_error"]).toBe(
      `Slack answered 503; ${ALERT_NOT_RAISED}`,
    );
    expect((await t.row(ids[11] as string))?.["last_error"]).toBe(
      `Slack answered 503 (given up with its digest; its alert could not be raised, and delivery ${ids[10]} tries it once more)`,
    );

    // The alert's one more try: the oldest row alone, never sent again, then closed.
    t.script.alertFails = false;
    const digestsBefore = t.digests.length;
    const retry = Number((await t.row(ids[10] as string))?.["next_attempt_at"]);
    expect((await t.outbox.deliverDue(retry)).gaveUp).toEqual([ids[10]]);
    expect(t.gaveUp).toEqual([expect.objectContaining({ deliveryId: ids[10] })]);
    expect(t.digests).toHaveLength(digestsBefore);
    expect(await t.open()).toBe(0);
  });

  it("never gathers a row awaiting its give-up alert's one more try into a digest", async () => {
    const t = await rig();
    const ids = await t.notify(36);
    await t.drain(t.clock.now());
    const end = MINUTE + DIGEST_MINUTE_MS;
    // The newest row of the minute's digest awaits its alert's one more try, due with the others:
    // the claim takes 20 of the 26 due, and the digest gathers the others but that one.
    const awaiting = ids[35] as string;
    await t.client.query(
      `update facetdb.webhook_outbox set last_error = $2, next_attempt_at = $3::bigint where id = $1::bigint`,
      [awaiting, `Slack answered 503; ${ALERT_NOT_RAISED}`, end],
    );

    const report = await t.outbox.deliverDue(end);
    expect(t.digests.map((digest) => digest.rows.map((row) => row.deliveryId))).toEqual([
      ids.slice(DIGEST_AFTER, 35),
    ]);
    expect(report.delivered).not.toContain(awaiting);
    expect((await t.row(awaiting))?.["last_error"]).toBe(`Slack answered 503; ${ALERT_NOT_RAISED}`);

    // Its own pass raises the alert and closes it, unsent.
    expect((await t.outbox.deliverDue(end)).gaveUp).toEqual([awaiting]);
    expect(t.digests).toHaveLength(1);
    expect(await t.open()).toBe(0);
  });

  it("closes every row untried when its runner says so", async () => {
    const t = await rig();
    await t.notify(12);
    await t.drain(t.clock.now());
    t.script.digest = () => Promise.resolve({ close: "the source is no longer in the config" });

    await t.drain(MINUTE + DIGEST_MINUTE_MS);
    expect(t.digests).toHaveLength(1);
    expect(await t.open()).toBe(0);
    const [closed] = await t.client.query(
      `select count(*)::int as n from facetdb.webhook_outbox
        where gave_up_at is not null and last_error = 'the source is no longer in the config'`,
    );
    expect(closed?.["n"]).toBe(2);
  });
});

describe("nothing is lost to a crash", () => {
  it("sends the digest from another worker when the first stopped between the tenth and the digest", async () => {
    const t = await rig();
    const ids = await t.notify(14);
    await t.drain(t.clock.now());
    expect(t.alone).toHaveLength(DIGEST_AFTER);

    // The first loop is gone; another, started after it, finds the rows as the store keeps them.
    const second = createOutbox(t.deps("loop-b"));
    const report = await second.deliverDue(MINUTE + DIGEST_MINUTE_MS);
    expect([...report.delivered].sort()).toEqual(ids.slice(DIGEST_AFTER).sort());
    expect(t.digests.map(keysOf)).toEqual([["T-10", "T-11", "T-12", "T-13"]]);
    expect(await t.open()).toBe(0);
  });

  it("sends a digest again after the lease when its loop stopped before marking it sent", async () => {
    const t = await rig();
    const ids = await t.notify(12);
    await t.drain(t.clock.now());
    // The first loop's digest never comes back: its process stopped while it ran.
    let calledBack: () => void = () => undefined;
    const called = new Promise<void>((resolve) => {
      calledBack = resolve;
    });
    t.script.digest = () => {
      calledBack();
      return new Promise<undefined>(() => undefined);
    };
    const end = MINUTE + DIGEST_MINUTE_MS;
    void t.outbox.deliverDue(end);
    await called;

    t.script.digest = () => Promise.resolve(undefined);
    const second = createOutbox(t.deps("loop-b"));
    expect((await second.deliverDue(end + CLAIM_LEASE_MS - 1)).delivered).toEqual([]);
    const report = await second.deliverDue(end + CLAIM_LEASE_MS);
    expect([...report.delivered].sort()).toEqual(ids.slice(DIGEST_AFTER).sort());
    // At least once: the same digest went to the runner twice, its rows delivered once.
    expect(t.digests.map(keysOf)).toEqual([
      ["T-10", "T-11"],
      ["T-10", "T-11"],
    ]);
    expect(await t.open()).toBe(0);
  });
});

describe("quiet hours", () => {
  const QUIET: TimeSpan = {
    start: MINUTE + 5 * DIGEST_MINUTE_MS,
    end: MINUTE + 65 * DIGEST_MINUTE_MS,
  };
  const quiet = (batchKey: string, at: number): TimeSpan | undefined =>
    batchKey === URGENT && at >= QUIET.start && at < QUIET.end ? QUIET : undefined;

  it("@timing holds every row queued inside them, the first 10 too, and sends one digest when they end", async () => {
    const t = await rig({ quiet });
    t.clock.advance(QUIET.start - t.clock.now());
    const night = await t.notify(4);
    t.clock.advance(20 * DIGEST_MINUTE_MS);
    const later = await t.notify(2, URGENT, 10);
    // Another batch key, whose channel has no quiet hours, goes out as it happens.
    await t.notify(1, BILLING, 90);

    const during = await t.drain(t.clock.now());
    expect(t.alone.map((row) => row.recordKey)).toEqual(["T-90"]);
    expect(during.held.sort()).toEqual([...night, ...later].sort());
    expect(await t.row(night[0] as string)).toMatchObject({
      attempts: 0,
      next_attempt_at: String(QUIET.end),
      last_error: HELD_FOR_QUIET,
    });
    expect((await t.drain(QUIET.end - 1)).delivered).toEqual([]);

    const after = await t.drain(QUIET.end);
    expect(after.delivered.sort()).toEqual([...night, ...later].sort());
    expect(t.digests).toHaveLength(1);
    expect(t.digests[0]).toMatchObject({
      batchKey: URGENT,
      window: { kind: "quiet", start: QUIET.start, end: QUIET.end },
    });
    expect(keysOf(t.digests[0])).toEqual(["T-0", "T-1", "T-2", "T-3", "T-10", "T-11"]);
    expect(t.alone).toHaveLength(1);
    expect(await t.open()).toBe(0);
  });

  it("holds a row of the minute before them that comes due inside them, then sends it as it was", async () => {
    const t = await rig({ quiet });
    t.clock.advance(QUIET.start - 1000 - t.clock.now());
    const [before] = await t.notify(1);

    const during = await t.drain(QUIET.start);
    expect(during.held).toEqual([before]);
    expect(t.alone).toEqual([]);

    await t.drain(QUIET.end);
    expect(t.alone.map((row) => row.deliveryId)).toEqual([before]);
    expect(t.digests).toEqual([]);
  });

  it("leaves a row awaiting its give-up alert's one more try as it is when it holds the others", async () => {
    const t = await rig({ quiet });
    t.clock.advance(QUIET.start - t.clock.now());
    const ids = await t.notify(21);
    // Every row due now; the last one's 24 hours were spent and its alert awaits one more try. It
    // comes due last, so the first pass claims the 20 others and holds it with them, or would.
    const awaiting = ids[20] as string;
    const note = `Slack answered 503; ${ALERT_NOT_RAISED}`;
    await t.client.query(`update facetdb.webhook_outbox set next_attempt_at = created_at`);
    await t.client.query(
      `update facetdb.webhook_outbox set last_error = $2, next_attempt_at = $3::bigint where id = $1::bigint`,
      [awaiting, note, t.clock.now()],
    );

    const first = await t.outbox.deliverDue(t.clock.now());
    expect(first.held).toHaveLength(20);
    expect(first.held).not.toContain(awaiting);
    expect(await t.row(awaiting)).toMatchObject({
      last_error: note,
      next_attempt_at: String(t.clock.now()),
    });

    // Its own pass, quiet hours or not: the alert alone, then closed, never sent.
    expect((await t.outbox.deliverDue(t.clock.now())).gaveUp).toEqual([awaiting]);
    expect(t.gaveUp).toEqual([expect.objectContaining({ deliveryId: awaiting })]);
    await t.drain(QUIET.end);
    expect(t.digests.flatMap((digest) => digest.rows.map((row) => row.deliveryId))).toEqual(
      ids.slice(0, 20),
    );
    expect(t.alone).toEqual([]);
  });
});

describe("a store failure while the digest rule places a row", () => {
  it("lets every other row of the pass run, then fails the pass; the row is placed after its lease", async () => {
    const t = await rig();
    const [batched] = await t.notify(1);
    const plain = await t.outbox.enqueue({
      projectId: PROJECT,
      sourceId: SOURCE_ID,
      recordKey: "T-0",
      plugin: "@facetdb/github",
      action: "label",
      position: 2,
      payload: { label: "urgent" },
    });
    t.script.placingFails = true;

    await expect(t.outbox.deliverDue(t.clock.now())).rejects.toThrow("the store went away");
    expect(t.alone.map((row) => row.deliveryId)).toEqual([plain]);
    expect((await t.row(plain))?.["delivered_at"]).not.toBeNull();
    expect((await t.row(batched as string))?.["delivered_at"]).toBeNull();

    t.script.placingFails = false;
    const later = t.clock.now() + CLAIM_LEASE_MS;
    expect((await t.outbox.deliverDue(later)).delivered).toEqual([batched]);
    expect(t.alone.map((row) => row.deliveryId)).toEqual([plain, batched]);
  });
});

describe("a row that is not a notification", () => {
  it("is delivered exactly as before beside batched rows", async () => {
    const t = await rig();
    await t.notify(11);
    const plain = await t.outbox.enqueue({
      projectId: PROJECT,
      sourceId: SOURCE_ID,
      recordKey: "T-0",
      plugin: "@facetdb/github",
      action: "label",
      position: 2,
      payload: { label: "urgent" },
    });

    await t.drain(t.clock.now());
    expect(t.alone.filter((row) => row.deliveryId === plain)).toEqual([
      expect.objectContaining({ batchKey: undefined, attempt: 1, action: "label" }),
    ]);
    expect(await t.row(plain)).toMatchObject({ attempts: 1, last_error: null });
    expect((await t.row(plain))?.["delivered_at"]).not.toBeNull();
  });
});
