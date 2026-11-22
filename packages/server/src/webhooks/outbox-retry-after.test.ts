import { FakeClock } from "@facetdb/core/testing";
import { migrateStore, pgliteClient, sourceIdOf } from "@facetdb/postgres";
import { freshPglite, type PGlite, resetPglite } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GAVE_UP_DID, GAVE_UP_REFUSED_DID, gaveUpAlert } from "./gave-up.ts";
import {
  ACTION_ERROR_NOT_KEPT,
  type ActionClose,
  type ActionDelivery,
  ActionFailed,
  ALERT_NOT_RAISED,
  createOutbox,
  DIGEST_AFTER,
  DIGEST_MINUTE_MS,
  type DigestDelivery,
  GIVE_UP_AFTER_MS,
  type OutboxDeps,
  REFUSED_FOR_GOOD,
  RETRY_FIRST_MS,
  RETRY_MAX_MS,
  retryAfterDelayMs,
  retryDelayMs,
  type WebhookGaveUp,
} from "./outbox.ts";

/**
 * What an action's failure says of the next try, on PGlite and a stepped clock: a wait the service
 * asked for (`ActionFailed.retryAfterMs`, a 429's retry-after) is kept instead of the backoff, held
 * to an hour and to at least the first step, the attempt spent and the 24 hours still counted from
 * queueing; a refusal for good (`ActionFailed.permanent`) gives the row up at once with its words,
 * the alert raised now. A digest follows both as a whole.
 */

const PROJECT = "project-1";
const SOURCE = "issues";
const SOURCE_ID = sourceIdOf(PROJECT, SOURCE);
/** A whole minute since the epoch, so a test's notifications fall inside one minute. */
const START = 1_700_000_040_000;
const URGENT = JSON.stringify([SOURCE, 1, "slack:#urgent"]);

/** GitHub's words for a refused token, as the action host keeps them for a first-party plugin. */
const REFUSED_TOKEN =
  "github label on acme/shop#7: GitHub answered 401 to reading the issue: GitHub does not accept the token. the token is wrong, expired or revoked: put a valid one in the variable plugins.github.token names, then restart the worker";

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

type Run = (row: ActionDelivery) => Promise<ActionClose | undefined>;
type DigestRun = (digest: DigestDelivery) => Promise<ActionClose | undefined>;

async function rig() {
  const client = pgliteClient(pglite);
  await migrateStore(client);
  const clock = new FakeClock(START);
  const runs: ActionDelivery[] = [];
  const digests: DigestDelivery[] = [];
  /** What the runners do at each call, and whether the next give-up alert fails. */
  const script: { run: Run; digest: DigestRun; alertFails: boolean } = {
    run: () => Promise.resolve(undefined),
    digest: () => Promise.resolve(undefined),
    alertFails: false,
  };
  const gaveUp: { readonly event: WebhookGaveUp; readonly lastError: string }[] = [];
  const deps: OutboxDeps = {
    client,
    clock,
    fetch: () => Promise.resolve({ status: 204 }),
    abortAfter: () => new AbortController().signal,
    loopId: "loop-main",
    secretFor: () => Promise.resolve("whsec-test-secret"),
    onGiveUp: (event, _signal, lastError) => {
      if (script.alertFails) {
        script.alertFails = false;
        return Promise.reject(new Error("the alerts table is unreachable"));
      }
      gaveUp.push({ event, lastError });
      return Promise.resolve();
    },
    runAction: (row) => {
      runs.push(row);
      return script.run(row);
    },
    runDigest: (digest) => {
      digests.push(digest);
      return script.digest(digest);
    },
  };
  const outbox = createOutbox(deps);

  function action(): Promise<string> {
    return outbox.enqueue({
      projectId: PROJECT,
      sourceId: SOURCE_ID,
      recordKey: "7",
      plugin: "@facetdb/github",
      action: "label",
      position: 0,
      payload: { status: "done", decisions: {}, settings: { add: ["bug"] } },
    });
  }

  /** Queues `count` notifications of one batch key in this minute, 100 ms apart. */
  async function notify(count: number): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < count; index += 1) {
      ids.push(
        await outbox.enqueue({
          projectId: PROJECT,
          sourceId: SOURCE_ID,
          recordKey: `T-${index}`,
          plugin: "@facetdb/slack",
          action: "notify",
          position: 1,
          payload: { decided: index },
          batchKey: URGENT,
        }),
      );
      clock.advance(100);
    }
    return ids;
  }

  async function row(id: string) {
    const [found] = await client.query(
      `select attempts, next_attempt_at::text as next_attempt_at, delivered_at::text as delivered_at,
              gave_up_at::text as gave_up_at, last_error
         from facetdb.webhook_outbox where id = $1::bigint`,
      [id],
    );
    if (found === undefined) {
      throw new Error(`no outbox row ${id}`);
    }
    return found;
  }

  return { clock, outbox, runs, digests, script, gaveUp, action, notify, row };
}

/** The runner's failure for a rate limit that asked for `ms`. */
const limited = (ms: number) => () =>
  Promise.reject(
    new ActionFailed("GitHub's rate limit stopped adding the labels", { retryAfterMs: ms }),
  );

describe("a wait the service asked for (retry-after)", () => {
  it("@timing is kept instead of the backoff, on the fake clock, spending the attempt", async () => {
    const t = await rig();
    t.script.run = limited(90_000);
    const id = await t.action();

    expect((await t.outbox.deliverDue(START)).retrying).toEqual([id]);
    expect(await t.row(id)).toMatchObject({
      attempts: 1,
      next_attempt_at: String(START + 90_000),
      last_error: "GitHub's rate limit stopped adding the labels",
    });
    // The backoff would have tried it again after 10 seconds: the wait asked for holds.
    expect(retryDelayMs(1)).toBe(10_000);
    expect((await t.outbox.deliverDue(START + 89_999)).retrying).toEqual([]);
    expect(t.runs).toHaveLength(1);

    t.script.run = () => Promise.resolve(undefined);
    expect((await t.outbox.deliverDue(START + 90_000)).delivered).toEqual([id]);
    expect(t.runs.map((run) => run.attempt)).toEqual([1, 2]);
    expect(await t.row(id)).toMatchObject({ attempts: 2, last_error: null });
  });

  it("is held to an hour at most, and to the first backoff step at least", async () => {
    expect(retryAfterDelayMs(5 * 60 * 60_000)).toBe(RETRY_MAX_MS);
    expect(retryAfterDelayMs(0)).toBe(RETRY_FIRST_MS);
    expect(retryAfterDelayMs(30_000)).toBe(30_000);

    const t = await rig();
    t.script.run = limited(5 * 60 * 60_000);
    const long = await t.action();
    await t.outbox.deliverDue(START);
    expect((await t.row(long))["next_attempt_at"]).toBe(String(START + 60 * 60_000));

    t.script.run = limited(0);
    const short = await t.action();
    await t.outbox.deliverDue(START + 1);
    expect((await t.row(short))["next_attempt_at"]).toBe(String(START + 1 + RETRY_FIRST_MS));
  });

  it("@timing never moves the 24 hours: they count from queueing, and the failure at their end gives up as before", async () => {
    const t = await rig();
    t.script.run = limited(60 * 60_000);
    const id = await t.action();
    const deadline = START + GIVE_UP_AFTER_MS;

    const tried: number[] = [];
    let now = START;
    for (let pass = 0; pass < 100; pass += 1) {
      tried.push(now);
      const report = await t.outbox.deliverDue(now);
      if (report.gaveUp.length > 0) {
        expect(report.gaveUp).toEqual([id]);
        break;
      }
      now = Number((await t.row(id))["next_attempt_at"]);
    }

    // An hour apart, the 25th try on the deadline itself, never past it.
    expect(tried).toEqual(Array.from({ length: 25 }, (_, hour) => START + hour * 60 * 60_000));
    expect(tried.at(-1)).toBe(deadline);
    expect(t.gaveUp).toEqual([
      {
        event: expect.not.objectContaining({ refused: expect.anything() }),
        lastError: "GitHub's rate limit stopped adding the labels",
      },
    ]);
    const [given] = t.gaveUp;
    expect(given?.event.attempts).toBe(25);
    expect(gaveUpAlert(given?.event as WebhookGaveUp, given?.lastError ?? "", () => "l").did).toBe(
      GAVE_UP_DID,
    );
    expect(await t.row(id)).toMatchObject({
      gave_up_at: String(deadline),
      last_error: "GitHub's rate limit stopped adding the labels",
    });
  });

  it("@timing holds for a digest as a whole: every row waits it out, then the digest goes once", async () => {
    const t = await rig();
    const ids = await t.notify(DIGEST_AFTER + 2);
    const [eleventh, twelfth] = ids.slice(DIGEST_AFTER);
    const end = START + DIGEST_MINUTE_MS;
    t.script.digest = () =>
      Promise.reject(
        new ActionFailed("slack:#urgent was not delivered: Slack answered HTTP 429", {
          retryAfterMs: 120_000,
        }),
      );

    // The first ten go alone in their minute; the other two wait for its end, then fail as one.
    await t.outbox.deliverDue(START + 1_200);
    const report = await t.outbox.deliverDue(end);
    expect([...report.retrying].sort()).toEqual([eleventh, twelfth].sort());
    for (const id of [eleventh, twelfth]) {
      expect(await t.row(id as string)).toMatchObject({
        next_attempt_at: String(end + 120_000),
        last_error: "slack:#urgent was not delivered: Slack answered HTTP 429",
      });
    }
    expect(t.digests).toHaveLength(1);

    t.script.digest = () => Promise.resolve(undefined);
    expect((await t.outbox.deliverDue(end + 119_999)).delivered).toEqual([]);
    expect([...(await t.outbox.deliverDue(end + 120_000)).delivered].sort()).toEqual(
      [eleventh, twelfth].sort(),
    );
    expect(t.digests).toHaveLength(2);
    expect(t.digests[1]?.rows.map((row) => row.recordKey)).toEqual(["T-10", "T-11"]);
  });
});

describe("a refusal for good", () => {
  it("gives the row up at its first attempt, with its words, and raises the alert now", async () => {
    const t = await rig();
    // A wait beside it changes nothing: refused for good is the end.
    t.script.run = () =>
      Promise.reject(new ActionFailed(REFUSED_TOKEN, { permanent: true, retryAfterMs: 60_000 }));
    const id = await t.action();

    const report = await t.outbox.deliverDue(START);
    expect(report.gaveUp).toEqual([id]);
    expect(report.retrying).toEqual([]);
    expect(t.runs).toHaveLength(1);
    expect(t.gaveUp).toEqual([
      {
        event: {
          projectId: PROJECT,
          deliveryId: id,
          sourceId: SOURCE_ID,
          plugin: "@facetdb/github",
          action: "label",
          attempts: 1,
          queuedAt: START,
          refused: true,
        },
        lastError: REFUSED_TOKEN,
      },
    ]);
    expect(await t.row(id)).toMatchObject({
      attempts: 1,
      gave_up_at: String(START),
      delivered_at: null,
      last_error: `${REFUSED_TOKEN}; ${REFUSED_FOR_GOOD}`,
    });

    const [given] = t.gaveUp;
    const alert = gaveUpAlert(
      given?.event as WebhookGaveUp,
      given?.lastError ?? "",
      () => "studio",
    );
    expect(alert.what).toBe(
      `The action label of plugin @facetdb/github for source issues was given up at once, refused for good after 1 attempt (delivery ${id}), as FacetDB reads this refusal as one that comes back on every try: ${REFUSED_TOKEN}.`,
    );
    expect(alert.what).toContain("put a valid one in the variable plugins.github.token names");
    expect(alert.did).toBe(GAVE_UP_REFUSED_DID);

    await t.outbox.deliverDue(START + GIVE_UP_AFTER_MS);
    expect(t.runs).toHaveLength(1);
  });

  it("says so again on its alert's one more try, when the first could not be raised", async () => {
    const t = await rig();
    t.script.run = () => Promise.reject(new ActionFailed(REFUSED_TOKEN, { permanent: true }));
    t.script.alertFails = true;
    const id = await t.action();

    const first = await t.outbox.deliverDue(START);
    expect(first.retrying).toEqual([id]);
    expect(first.alertFailures).toMatchObject([{ event: { deliveryId: id, refused: true } }]);
    expect((await t.row(id))["last_error"]).toBe(
      `${REFUSED_TOKEN}; ${REFUSED_FOR_GOOD}; ${ALERT_NOT_RAISED}`,
    );

    const due = Number((await t.row(id))["next_attempt_at"]);
    expect((await t.outbox.deliverDue(due)).gaveUp).toEqual([id]);
    // Only the alert was tried again, the refusal named as such, the action never run twice.
    expect(t.runs).toHaveLength(1);
    expect(t.gaveUp).toEqual([
      { event: expect.objectContaining({ attempts: 1, refused: true }), lastError: REFUSED_TOKEN },
    ]);
    expect((await t.row(id))["last_error"]).toBe(`${REFUSED_TOKEN}; ${REFUSED_FOR_GOOD}`);
  });

  it("gives a digest up at once as a whole, with one alert", async () => {
    const t = await rig();
    const ids = await t.notify(DIGEST_AFTER + 2);
    const [eleventh, twelfth] = ids.slice(DIGEST_AFTER);
    const words =
      "slack:#urgent was not delivered: Slack answered channel_not_found; invite the app";
    t.script.digest = () => Promise.reject(new ActionFailed(words, { permanent: true }));

    await t.outbox.deliverDue(START + 1_200);
    const report = await t.outbox.deliverDue(START + DIGEST_MINUTE_MS);
    expect([...report.gaveUp].sort()).toEqual([eleventh, twelfth].sort());
    expect(t.gaveUp).toEqual([
      { event: expect.objectContaining({ deliveryId: eleventh, refused: true }), lastError: words },
    ]);
    expect((await t.row(twelfth as string))["last_error"]).toBe(
      `${words}; ${REFUSED_FOR_GOOD} (given up with its digest; delivery ${eleventh} raised its alert)`,
    );
  });

  it("is never forged by kept words that end in a note's text, as an SMTP reply ends an email's", async () => {
    const t = await rig();
    // Words ending as a row awaiting its alert's one more try does: kept, the note's text taken out.
    const awaiting = `the SMTP server refused the message. The server said: 451 4.3.0 x; ${ALERT_NOT_RAISED}`;
    t.script.run = () => Promise.reject(new ActionFailed(awaiting));
    const id = await t.action();

    expect((await t.outbox.deliverDue(START)).retrying).toEqual([id]);
    const kept = String((await t.row(id))["last_error"]);
    expect(kept).toBe("the SMTP server refused the message. The server said: 451 4.3.0 x; …");
    expect(kept).not.toContain(ALERT_NOT_RAISED);
    // Its next attempt runs the action: no alert is raised, nothing is given up untried.
    const due = Number((await t.row(id))["next_attempt_at"]);
    expect((await t.outbox.deliverDue(due)).retrying).toEqual([id]);
    expect(t.runs).toHaveLength(2);
    expect(t.gaveUp).toEqual([]);

    // Words ending as a refusal for good's note: a row given up after its 24 hours is not called
    // refused on its alert's one more try.
    const refused = `the server said: 550 x; ${REFUSED_FOR_GOOD}`;
    t.script.run = () => Promise.reject(new ActionFailed(refused));
    t.script.alertFails = true;
    expect((await t.outbox.deliverDue(START + GIVE_UP_AFTER_MS)).alertFailures).toEqual([
      expect.objectContaining({ event: expect.not.objectContaining({ refused: true }) }),
    ]);
    const retry = Number((await t.row(id))["next_attempt_at"]);
    expect((await t.outbox.deliverDue(retry)).gaveUp).toEqual([id]);
    expect(t.gaveUp).toEqual([
      {
        event: expect.not.objectContaining({ refused: expect.anything() }),
        lastError: "the server said: 550 x; …",
      },
    ]);
  });

  it("is only ever an ActionFailed's: any other error keeps the backoff and the fixed words", async () => {
    const t = await rig();
    t.script.run = () =>
      Promise.reject(Object.assign(new Error("refused"), { permanent: true, retryAfterMs: 1 }));
    const id = await t.action();

    expect((await t.outbox.deliverDue(START)).retrying).toEqual([id]);
    expect(await t.row(id)).toMatchObject({
      next_attempt_at: String(START + retryDelayMs(1)),
      last_error: ACTION_ERROR_NOT_KEPT,
      gave_up_at: null,
    });
    expect(t.gaveUp).toEqual([]);
  });
});
