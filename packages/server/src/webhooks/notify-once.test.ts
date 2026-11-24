import { FakeClock } from "@facetdb/core/testing";
import { migrateStore, pgliteClient, sourceIdOf } from "@facetdb/postgres";
import { freshPglite, type PGlite, resetPglite } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  type ActionClose,
  type ActionDelivery,
  ActionFailed,
  createOutbox,
  DIGEST_AFTER,
  DIGEST_MINUTE_MS,
  type NewAction,
  type OutboxDeps,
} from "./outbox.ts";

/**
 * On PGlite and a stepped clock: a notification (an action row with a batch key) is queued once per
 * record state and status, so a person's partial decision, which runs the actions again and leaves
 * the record in review, sends nothing more. The latest row of the record's place decides: at the
 * same state, status and settings, not given up (or closed), it stands for the new one when,
 * delivered, it already held as unsure every question the new one holds as unsure (a question newly
 * unsure, as an added question's, is queued again), or, still waiting, it carries no decision the
 * record no longer holds (the runner would close it as superseded, so the new row replaces it).
 */

const PROJECT = "project-1";
const SOURCE = "support";
const SOURCE_ID = sourceIdOf(PROJECT, SOURCE);
/** A whole minute since the epoch, so a test's rows fall inside one minute. */
const MINUTE = 1_700_000_040_000;
const BATCH = JSON.stringify([SOURCE, 0, "slack:#urgent"]);

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

type Decided =
  | {
      readonly kind: "decided";
      readonly value: boolean | string;
      readonly probabilityOrConfidence: number;
    }
  | { readonly kind: "needs_review" };

const UNSURE: Decided = { kind: "needs_review" };
const URGENT: Decided = { kind: "decided", value: true, probabilityOrConfidence: 0.97 };
const NOT_URGENT: Decided = { kind: "decided", value: false, probabilityOrConfidence: 1 };

/** The example's notify: `slack.notify({ when: { status: "needs_review" }, channel: "#triage" })`. */
const IN_REVIEW = { status: "needs_review" } as const;
/** A notify with no `when`: every decision of the source is sent, `done` and `needs_review`. */
const EVERY_DECISION = {} as const;

/**
 * A notification's payload as `actionSteps` queues it (action-host.ts): by default the example's
 * notify, queued only while the record waits for a person.
 */
function notice(
  stateHash: string,
  status: "done" | "needs_review",
  decisions: Readonly<Record<string, Decided>>,
  options: { readonly condition?: object; readonly channel?: string } = {},
) {
  return {
    status,
    decidedAt: new Date(MINUTE).toISOString(),
    stateHash,
    decisions,
    settings: { channel: options.channel ?? "#triage" },
    condition: options.condition ?? IN_REVIEW,
  };
}

type Run = (row: ActionDelivery) => Promise<ActionClose | undefined>;

async function rig() {
  const client = pgliteClient(pglite);
  await migrateStore(client);
  const clock = new FakeClock(MINUTE);
  const runs: ActionDelivery[] = [];
  const script: { run: Run } = { run: () => Promise.resolve(undefined) };
  const deps: OutboxDeps = {
    client,
    clock,
    fetch: () => Promise.resolve({ status: 204 }),
    abortAfter: () => new AbortController().signal,
    loopId: "loop-main",
    secretFor: () => Promise.resolve("whsec-test-secret"),
    onGiveUp: () => Promise.resolve(),
    runAction: (row) => {
      runs.push(row);
      return script.run(row);
    },
  };
  const outbox = createOutbox(deps);

  /** Queues a notification of record 42 (or another), as the notify step does. */
  function notify(payload: unknown, overrides: Partial<NewAction> = {}): Promise<string> {
    return outbox.enqueue({
      projectId: PROJECT,
      sourceId: SOURCE_ID,
      recordKey: "42",
      plugin: "@facetdb/slack",
      action: "notify",
      position: 0,
      payload,
      batchKey: BATCH,
      ...overrides,
    });
  }

  /** An action row without a batch key (a plugin's action, not a notification) of record 42. */
  function plainAction(payload: unknown): Promise<string> {
    return outbox.enqueue({
      projectId: PROJECT,
      sourceId: SOURCE_ID,
      recordKey: "42",
      plugin: "github",
      action: "label",
      position: 1,
      payload,
    });
  }

  async function rowCount(): Promise<number> {
    const rows = await client.query("select count(*)::integer as n from facetdb.webhook_outbox");
    return Number(rows[0]?.["n"]);
  }

  async function dueAt(id: string): Promise<number> {
    const rows = await client.query(
      "select next_attempt_at::text as due from facetdb.webhook_outbox where id = $1::bigint",
      [id],
    );
    return Number(rows[0]?.["due"]);
  }

  /** One delivery pass now. */
  function deliver() {
    return outbox.deliverDue(clock.now());
  }

  return { clock, runs, script, notify, plainAction, rowCount, dueAt, deliver };
}

describe("a notification is queued once per record state and status", () => {
  it("queues the same record, state and status once, delivered or still waiting", async () => {
    const t = await rig();
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }));
    expect(await t.notify(notice("h1", "needs_review", { urgent: UNSURE }))).toBe(first);
    expect(await t.rowCount()).toBe(1);

    expect((await t.deliver()).delivered).toEqual([first]);
    t.clock.advance(1_000);
    expect(await t.notify(notice("h1", "needs_review", { urgent: UNSURE }))).toBe(first);
    expect(await t.rowCount()).toBe(1);
    await t.deliver();
    expect(t.runs.map((run) => run.deliveryId)).toEqual([first]);
  });

  it("sends nothing more for a person's partial decision once the notification went out", async () => {
    const t = await rig();
    const unsure = { urgent: UNSURE, topic: UNSURE };
    const first = await t.notify(notice("h1", "needs_review", unsure));
    await t.deliver();
    t.clock.advance(5_000);
    // A person decides one of the two questions: the record stays in review at the same state.
    const partial = { urgent: URGENT, topic: UNSURE };
    expect(await t.notify(notice("h1", "needs_review", partial))).toBe(first);
    expect(await t.rowCount()).toBe(1);
    expect((await t.deliver()).delivered).toEqual([]);
    expect(t.runs).toHaveLength(1);
  });

  it("queues a partial decision while the first still waits, which then replaces it: one message", async () => {
    const t = await rig();
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE, topic: UNSURE }));
    // Still waiting: the runner would close it as superseded, a question it carries decided since.
    const second = await t.notify(notice("h1", "needs_review", { urgent: URGENT, topic: UNSURE }));
    expect(second).not.toBe(first);
    const report = await t.deliver();
    expect(report.superseded).toEqual([first]);
    expect(t.runs.map((run) => run.deliveryId)).toEqual([second]);
  });

  it("queues a second for a new status, or a new state (a notify with no when)", async () => {
    const t = await rig();
    const every = { condition: EVERY_DECISION };
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }, every));
    await t.deliver();
    const done = await t.notify(notice("h1", "done", { urgent: URGENT }, every));
    expect(done).not.toBe(first);
    await t.deliver();
    const changed = await t.notify(notice("h2", "done", { urgent: URGENT }, every));
    expect(changed).not.toBe(done);
    expect(await t.rowCount()).toBe(3);
  });

  it("compares the latest row only: a status that changed and changed back is queued again, where the notify queued a row at each (no when)", async () => {
    const t = await rig();
    const every = { condition: EVERY_DECISION };
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }, every));
    await t.deliver();
    await t.notify(notice("h1", "done", { urgent: NOT_URGENT }, every));
    await t.deliver();
    // An undo: back in review at the same state, after a `done` the channel heard of.
    const again = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }, every));
    expect(again).not.toBe(first);
    expect(await t.rowCount()).toBe(3);
  });

  it("notifies a record back in review at the same state on a question added since, the done between queueing nothing", async () => {
    const t = await rig();
    // (1) Record 42 at state h1 waits for a person on `urgent`: #triage hears of it.
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }));
    expect((await t.deliver()).delivered).toEqual([first]);
    // (2) A reviewer decides `urgent`: the record is done, and the notify's `when` queues nothing.
    // (3) A question `topic` is added; its backfill answers at the same state, unsure.
    t.clock.advance(60_000);
    const back = await t.notify(
      notice("h1", "needs_review", { urgent: NOT_URGENT, topic: UNSURE }),
    );
    expect(back).not.toBe(first);
    expect((await t.deliver()).delivered).toEqual([back]);
    // The same again (a retried pass, the worker's own write) sends nothing more.
    expect(
      await t.notify(notice("h1", "needs_review", { urgent: NOT_URGENT, topic: UNSURE })),
    ).toBe(back);
    await t.deliver();
    expect(t.runs.map((run) => run.deliveryId)).toEqual([first, back]);
  });

  it("queues again for a question newly unsure at the same state and status", async () => {
    const t = await rig();
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE, topic: URGENT }));
    await t.deliver();
    // A re-answer at the same state leaves `topic` unsure too: still in review, on more.
    const more = await t.notify(notice("h1", "needs_review", { urgent: UNSURE, topic: UNSURE }));
    expect(more).not.toBe(first);
    expect(await t.rowCount()).toBe(2);
  });

  it("deliberately does not notify again an undo back to needs_review at the same state with the same questions open", async () => {
    const t = await rig();
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE, topic: UNSURE }));
    await t.deliver();
    // A reviewer decides both (done: nothing queued), then undoes one: `urgent` open again.
    expect(
      await t.notify(notice("h1", "needs_review", { urgent: UNSURE, topic: NOT_URGENT })),
    ).toBe(first);
    expect(await t.rowCount()).toBe(1);
  });

  it("queues again when the notify's settings changed: a new channel hears of the record", async () => {
    const t = await rig();
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }));
    await t.deliver();
    const moved = await t.notify(
      notice("h1", "needs_review", { urgent: UNSURE }, { channel: "#support" }),
    );
    expect(moved).not.toBe(first);
    await t.deliver();
    expect(t.runs.map((run) => run.deliveryId)).toEqual([first, moved]);
    expect(t.runs[1]?.payload).toMatchObject({ settings: { channel: "#support" } });
  });

  it("queues again after a given-up or closed latest row", async () => {
    const t = await rig();
    t.script.run = () =>
      Promise.reject(new ActionFailed("the channel is gone", { permanent: true }));
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }));
    expect((await t.deliver()).gaveUp).toEqual([first]);
    const second = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }));
    expect(second).not.toBe(first);

    t.script.run = () => Promise.resolve({ close: "record gone" });
    expect((await t.deliver()).closed).toEqual([second]);
    const third = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }));
    expect(third).not.toBe(second);
    expect(await t.rowCount()).toBe(3);
  });

  it("keeps another record, and a row of another shape, apart", async () => {
    const t = await rig();
    const first = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }));
    const other = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }), {
      recordKey: "43",
    });
    expect(other).not.toBe(first);
    // A row queued in another shape (no state hash) never stands for a notification.
    const old = await t.notify({ decided: 1 }, { recordKey: "44" });
    expect(
      await t.notify(notice("h1", "needs_review", { urgent: UNSURE }), { recordKey: "44" }),
    ).not.toBe(old);
    expect(await t.rowCount()).toBe(4);
  });

  it("queues an action row without a batch key every time, as before", async () => {
    const t = await rig();
    const payload = notice("h1", "done", { urgent: URGENT });
    const first = await t.plainAction(payload);
    await t.deliver();
    const second = await t.plainAction(payload);
    const third = await t.plainAction(payload);
    expect(new Set([first, second, third]).size).toBe(3);
    expect(await t.rowCount()).toBe(3);
  });

  it("leaves the digest's count unchanged: a notification not queued is not counted", async () => {
    const t = await rig();
    const firsts: string[] = [];
    for (let index = 0; index < DIGEST_AFTER - 1; index += 1) {
      firsts.push(
        await t.notify(notice("h1", "needs_review", { urgent: UNSURE }), {
          recordKey: `T-${index}`,
        }),
      );
      t.clock.advance(100);
    }
    // Each record queued again at the same state and status: nothing is written, nothing counted.
    for (let index = 0; index < DIGEST_AFTER - 1; index += 1) {
      expect(
        await t.notify(notice("h1", "needs_review", { urgent: UNSURE }), {
          recordKey: `T-${index}`,
        }),
      ).toBe(firsts[index]);
    }
    const tenth = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }), {
      recordKey: "T-tenth",
    });
    expect(await t.dueAt(tenth)).toBe(t.clock.now());
    const eleventh = await t.notify(notice("h1", "needs_review", { urgent: UNSURE }), {
      recordKey: "T-eleventh",
    });
    expect(await t.dueAt(eleventh)).toBe(MINUTE + DIGEST_MINUTE_MS);
    expect(await t.rowCount()).toBe(DIGEST_AFTER + 1);
  });
});
