import {
  type ActiveAlert,
  ALERT_WINDOW_MS,
  alertMessage,
  type BoundChannel,
  type ChannelMessage,
  createAlerts,
  eventKey,
} from "@facetdb/core";
import { FakeAlertStore, FakeClock } from "@facetdb/core/testing";
import { migrateStore, pgliteClient, sourceIdOf } from "@facetdb/postgres";
import { freshPglite, type PGlite, resetPglite } from "@facetdb/postgres/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CREDENTIAL_REFUSED_DID,
  CREDENTIAL_WORDS_WITHHELD,
  credentialRefusedAlert,
  credentialRefusedKey,
  credentialSubject,
} from "./credential-refused.ts";
import { GAVE_UP_DID, gaveUpAlert } from "./gave-up.ts";
import {
  type ActionClose,
  type ActionCredentialRefused,
  type ActionDelivered,
  type ActionDelivery,
  ActionFailed,
  createOutbox,
  DIGEST_AFTER,
  DIGEST_MINUTE_MS,
  type DigestDelivery,
  GIVE_UP_AFTER_MS,
  type OutboxDeps,
  REFUSED_FOR_GOOD,
  retryDelayMs,
  type WebhookGaveUp,
} from "./outbox.ts";

/**
 * An action refused with a 401, on PGlite and a stepped clock: a try whose `ActionFailed` says
 * `credentialRefused` keeps its row on the backoff and its 24 hours (a rotated credential comes
 * back), and raises Action credential refused through `onCredentialRefused` at that try, one alert
 * per plugin of a source per 30 minutes (core's rule, the plugin in the key); a later delivered try
 * of that plugin on that source resolves it through `onActionDelivered`; at the end of the 24 hours
 * the row gives up with Action gave up as before. Any other refusal for good still gives up at
 * once. A digest follows the rule as a whole.
 */

const PROJECT = "project-1";
const SOURCE = "issues";
const SOURCE_ID = sourceIdOf(PROJECT, SOURCE);
/** A whole minute since the epoch, so a test's notifications fall inside one minute. */
const START = 1_700_000_040_000;
const URGENT = JSON.stringify([SOURCE, 1, "telegram:-100123"]);
const LINK = "https://facetdb.example.com/alerts";

/** GitHub's words for a refused token, as the action host keeps them for a first-party plugin. */
const REFUSED_TOKEN =
  "github label on acme/shop#7: GitHub answered 401 to adding the labels: GitHub does not accept the token. the token is wrong, expired or revoked: put a valid one in the variable plugins.github.token names, then restart the worker";

/** The runner's failure for a refused credential: GitHub's 401, as the action host passes it on. */
const unauthorized = () =>
  Promise.reject(new ActionFailed(REFUSED_TOKEN, { credentialRefused: true }));

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

/**
 * The fake alert store, its reads counted per key, and each read held for a few milliseconds while
 * `slow` is set: long enough that every resolve a pass starts is in flight at once.
 */
class SlowAlertStore extends FakeAlertStore {
  readonly reads: string[] = [];
  slow = false;
  /** Every read fails, as an alert store that is down. */
  failReads = false;

  override async getActive(key: string): Promise<ActiveAlert | undefined> {
    this.reads.push(key);
    if (this.slow) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (this.failReads) {
      throw new Error("the alerts table is unreachable");
    }
    return super.getActive(key);
  }
}

/**
 * The outbox with core's alerts on a fake store and one channel, wired as `facetdb worker` wires
 * them: a refused credential raises `credentialRefusedAlert`, a delivered try resolves
 * `credentialRefusedKey` through `resolveOpen`.
 */
async function rig() {
  const client = pgliteClient(pglite);
  await migrateStore(client);
  const clock = new FakeClock(START);
  const store = new SlowAlertStore(clock);
  /** Every message the channel took. */
  const sent: ChannelMessage[] = [];
  const channel: BoundChannel = {
    name: "fake:#ops",
    deliver: (message) => {
      sent.push(message);
      return Promise.resolve();
    },
  };
  const alerts = createAlerts({ store, clock, channels: [channel] });
  const runs: ActionDelivery[] = [];
  const digests: DigestDelivery[] = [];
  /** What the runners do at each call, and whether the next credential raise fails. */
  const script: { run: Run; digest: DigestRun; raiseFails: boolean } = {
    run: () => Promise.resolve(undefined),
    digest: () => Promise.resolve(undefined),
    raiseFails: false,
  };
  const gaveUp: { readonly event: WebhookGaveUp; readonly lastError: string }[] = [];
  const refusals: { readonly event: ActionCredentialRefused; readonly lastError: string }[] = [];
  const delivered: ActionDelivered[] = [];
  const deps: OutboxDeps = {
    client,
    clock,
    fetch: () => Promise.resolve({ status: 204 }),
    abortAfter: () => new AbortController().signal,
    loopId: "loop-main",
    secretFor: () => Promise.resolve("whsec-test-secret"),
    onGiveUp: (event, _signal, lastError) => {
      gaveUp.push({ event, lastError });
      return Promise.resolve();
    },
    onCredentialRefused: async (event, _signal, lastError) => {
      if (script.raiseFails) {
        script.raiseFails = false;
        throw new Error("the alerts table is unreachable");
      }
      refusals.push({ event, lastError });
      await alerts.raise(credentialRefusedAlert(event, lastError, () => LINK));
    },
    onActionDelivered: async (event) => {
      delivered.push(event);
      await alerts.resolveOpen(credentialRefusedKey(event));
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

  function action(
    plugin = "@facetdb/github",
    sourceId = SOURCE_ID,
    recordKey = "7",
  ): Promise<string> {
    return outbox.enqueue({
      projectId: PROJECT,
      sourceId,
      recordKey,
      plugin,
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
          plugin: "@facetdb/telegram",
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

  /** One delivery pass at `at`, the alerts' clock moved there first (their 30 minutes run on it). */
  function pass(at: number) {
    if (at > clock.now()) {
      clock.advance(at - clock.now());
    }
    return outbox.deliverDue(at);
  }

  /** The history lines of the credential alerts, as the Alerts page reads them. */
  function credentialLines() {
    return store.history.filter((line) => line.event.kind === "action_credential_refused");
  }

  return {
    clock,
    store,
    alerts,
    sent,
    pass,
    runs,
    digests,
    script,
    gaveUp,
    refusals,
    delivered,
    action,
    notify,
    row,
    credentialLines,
  };
}

const GITHUB: ActionDelivered = {
  projectId: PROJECT,
  sourceId: SOURCE_ID,
  plugin: "@facetdb/github",
};

describe("a 401 (credential refused)", () => {
  it("keeps the row on its backoff, the alert raised at the first 401 with the plugin's words and the fix", async () => {
    const t = await rig();
    t.script.run = unauthorized;
    const id = await t.action();

    const report = await t.pass(START);
    expect(report).toMatchObject({ retrying: [id], gaveUp: [], credentialAlertFailures: [] });
    expect(await t.row(id)).toMatchObject({
      attempts: 1,
      gave_up_at: null,
      next_attempt_at: String(START + retryDelayMs(1)),
      last_error: REFUSED_TOKEN,
    });
    expect(t.gaveUp).toEqual([]);
    expect(t.refusals).toEqual([
      {
        event: {
          projectId: PROJECT,
          deliveryId: id,
          sourceId: SOURCE_ID,
          plugin: "@facetdb/github",
          action: "label",
          attempts: 1,
          queuedAt: START,
        },
        lastError: REFUSED_TOKEN,
      },
    ]);
    const [line] = t.credentialLines();
    expect(t.credentialLines()).toHaveLength(1);
    expect(line?.phase).toBe("raised");
    expect(line?.key).toBe(credentialRefusedKey(GITHUB));
    expect(line?.event).toEqual({
      kind: "action_credential_refused",
      what: `@facetdb/github was refused its credential (source issues, action label): ${REFUSED_TOKEN}.`,
      project: PROJECT,
      source: SOURCE,
      question: null,
      did: CREDENTIAL_REFUSED_DID,
      link: LINK,
      plugin: "@facetdb/github",
    });
    // Every alert says the source, the plugin and action, that FacetDB keeps trying, and the fix.
    if (line === undefined) {
      throw new Error("the alert was recorded");
    }
    const message = alertMessage(line.event);
    expect(message.text).toBe(
      `@facetdb/github was refused its credential (source issues, action label): ${REFUSED_TOKEN}. Project ${PROJECT}, source issues, all questions. FacetDB: Each action is retried for 24 hours from when it was queued. Put a valid credential in place and restart the worker; this clears when the next action goes through.`,
    );
    expect(message.severity).toBe("warning");
  });

  it("names no words of the plugin's when they were withheld", () => {
    const event: ActionCredentialRefused = {
      projectId: PROJECT,
      deliveryId: "4",
      sourceId: SOURCE_ID,
      plugin: "@facetdb/github",
      action: "label",
      attempts: 1,
      queuedAt: START,
    };
    expect(credentialRefusedAlert(event, CREDENTIAL_WORDS_WITHHELD, () => LINK).what).toBe(
      "@facetdb/github was refused its credential (source issues, action label).",
    );
  });

  it("raises it once per 30 minutes per plugin of a source, on every refused try in between", async () => {
    const t = await rig();
    t.script.run = unauthorized;
    const id = await t.action();
    // The same action on another record of the same source shares its alert.
    const other = await t.action("@facetdb/github", SOURCE_ID, "8");
    // The same plugin on another source, and another plugin on this one, hold their own.
    const elsewhere = await t.action("@facetdb/github", sourceIdOf(PROJECT, "pulls"));
    const telegram = await t.action("@facetdb/telegram");

    await t.pass(START);
    expect(t.refusals.map((refusal) => refusal.event.deliveryId).sort()).toEqual(
      [id, other, elsewhere, telegram].sort(),
    );
    expect(new Set(t.credentialLines().map((line) => line.key))).toEqual(
      new Set([
        credentialRefusedKey(GITHUB),
        credentialRefusedKey({ ...GITHUB, sourceId: sourceIdOf(PROJECT, "pulls") }),
        credentialRefusedKey({ ...GITHUB, plugin: "@facetdb/telegram" }),
      ]),
    );

    // Each later refused try is told to the worker; the alert stays one within its window.
    const nextTry = async () => Number((await t.row(id))["next_attempt_at"]);
    let passes = 1;
    while ((await nextTry()) - START < ALERT_WINDOW_MS) {
      await t.pass(await nextTry());
      passes += 1;
    }
    expect(passes).toBeGreaterThan(5);
    expect(t.refusals).toHaveLength(4 * passes);
    expect(t.credentialLines()).toHaveLength(3);
    // Past 30 minutes, the next refused try raises each again.
    await t.pass(await nextTry());
    expect(t.credentialLines()).toHaveLength(6);
    expect(
      t.credentialLines().filter((line) => line.key === credentialRefusedKey(GITHUB)),
    ).toHaveLength(2);
  });

  it("is resolved by the plugin's next delivered try on that source, and only that one", async () => {
    const t = await rig();
    t.script.run = unauthorized;
    const id = await t.action();
    const telegram = await t.action("@facetdb/telegram");
    await t.pass(START);
    expect(t.credentialLines()).toHaveLength(2);

    // Telegram goes through: GitHub's alert stays open.
    t.script.run = (row) =>
      row.plugin === "@facetdb/telegram" ? Promise.resolve(undefined) : unauthorized();
    const next = START + retryDelayMs(1);
    const report = await t.pass(next);
    expect(report.delivered).toEqual([telegram]);
    expect(t.delivered).toEqual([{ ...GITHUB, plugin: "@facetdb/telegram" }]);
    expect(t.store.active.has(credentialRefusedKey(GITHUB))).toBe(true);
    expect(
      t.store.active.has(credentialRefusedKey({ ...GITHUB, plugin: "@facetdb/telegram" })),
    ).toBe(false);

    // The token works again: GitHub's next try is delivered, and its alert resolves.
    t.script.run = () => Promise.resolve(undefined);
    const after = Number((await t.row(id))["next_attempt_at"]);
    expect((await t.pass(after)).delivered).toEqual([id]);
    expect(t.store.active.has(credentialRefusedKey(GITHUB))).toBe(false);
    expect(
      t
        .credentialLines()
        .filter((line) => line.key === credentialRefusedKey(GITHUB))
        .map((line) => line.phase),
    ).toEqual(["raised", "resolved"]);
    expect(await t.row(id)).toMatchObject({ attempts: 3, gave_up_at: null, last_error: null });
  });

  it("@timing never closes the row before its 24 hours: at their end it gives up with Action gave up, as before", async () => {
    const t = await rig();
    t.script.run = unauthorized;
    const id = await t.action();
    const deadline = START + GIVE_UP_AFTER_MS;

    const tried: number[] = [];
    let now = START;
    for (let pass = 0; pass < 100; pass += 1) {
      tried.push(now);
      const report = await t.pass(now);
      if (report.gaveUp.length > 0) {
        expect(report.gaveUp).toEqual([id]);
        break;
      }
      expect(report.retrying, String(now)).toEqual([id]);
      expect((await t.row(id))["gave_up_at"]).toBeNull();
      now = Number((await t.row(id))["next_attempt_at"]);
    }

    // The webhook's schedule: 10 s, 20 s, … an hour at most, the last try on the deadline itself.
    expect(tried.at(-1)).toBe(deadline);
    expect(tried.length).toBeGreaterThan(20);
    for (let index = 1; index < tried.length - 1; index += 1) {
      expect(tried[index], String(index)).toBe(
        Math.min((tried[index - 1] as number) + retryDelayMs(index), deadline),
      );
    }
    expect(t.gaveUp).toEqual([
      {
        event: expect.not.objectContaining({ refused: expect.anything() }),
        lastError: REFUSED_TOKEN,
      },
    ]);
    const [given] = t.gaveUp;
    expect(gaveUpAlert(given?.event as WebhookGaveUp, given?.lastError ?? "", () => "l").did).toBe(
      GAVE_UP_DID,
    );
    expect(await t.row(id)).toMatchObject({
      gave_up_at: String(deadline),
      last_error: REFUSED_TOKEN,
    });
    // Every refused try was told but the last, which gave up: its alert is Action gave up alone,
    // never "each action is retried". The alert went out once per 30 minutes.
    expect(t.refusals).toHaveLength(tried.length - 1);
    expect(t.refusals.at(-1)?.event.attempts).toBe(tried.length - 1);
    expect(t.credentialLines().length).toBeLessThanOrEqual(
      Math.ceil(GIVE_UP_AFTER_MS / ALERT_WINDOW_MS) + 1,
    );
  });

  it("reports a raise that failed, keeps the row on its backoff, and raises at its next refused try", async () => {
    const t = await rig();
    t.script.run = unauthorized;
    t.script.raiseFails = true;
    const id = await t.action();

    const first = await t.pass(START);
    expect(first).toMatchObject({
      retrying: [id],
      credentialAlertFailures: [
        { phase: "raise", event: expect.objectContaining({ deliveryId: id, attempts: 1 }) },
      ],
    });
    expect(t.credentialLines()).toEqual([]);
    expect((await t.row(id))["next_attempt_at"]).toBe(String(START + retryDelayMs(1)));

    const second = await t.pass(START + retryDelayMs(1));
    expect(second.credentialAlertFailures).toEqual([]);
    expect(t.credentialLines()).toHaveLength(1);
  });

  it("is never followed when the try also says it is refused for good: that gives up at once", async () => {
    const t = await rig();
    t.script.run = () =>
      Promise.reject(new ActionFailed(REFUSED_TOKEN, { permanent: true, credentialRefused: true }));
    const id = await t.action();

    expect((await t.pass(START)).gaveUp).toEqual([id]);
    expect(t.refusals).toEqual([]);
    expect(t.gaveUp).toEqual([
      { event: expect.objectContaining({ refused: true }), lastError: REFUSED_TOKEN },
    ]);
  });
});

describe("any other refusal for good", () => {
  it("still gives up at once, raising no credential alert", async () => {
    const t = await rig();
    const words = "github label on acme/shop#7: GitHub answered 404: GitHub found nothing there";
    t.script.run = () => Promise.reject(new ActionFailed(words, { permanent: true }));
    const id = await t.action();

    expect((await t.pass(START)).gaveUp).toEqual([id]);
    expect(await t.row(id)).toMatchObject({
      attempts: 1,
      gave_up_at: String(START),
      last_error: `${words}; ${REFUSED_FOR_GOOD}`,
    });
    expect(t.refusals).toEqual([]);
    expect(t.credentialLines()).toEqual([]);
  });

  it("and a failure that says nothing of a credential raises none", async () => {
    const t = await rig();
    t.script.run = () => Promise.reject(new ActionFailed("GitHub failed on its side (502)"));
    await t.action();
    await t.pass(START);
    expect(t.refusals).toEqual([]);
  });
});

describe("a digest", () => {
  it("follows the rule as a whole: every row on the backoff, one alert, resolved when the digest goes", async () => {
    const t = await rig();
    const ids = await t.notify(DIGEST_AFTER + 2);
    const [eleventh, twelfth] = ids.slice(DIGEST_AFTER);
    const end = START + DIGEST_MINUTE_MS;
    const words =
      "telegram:-100123 was not delivered: Telegram answered 401 Unauthorized. Telegram does not know this bot token";
    t.script.digest = () => Promise.reject(new ActionFailed(words, { credentialRefused: true }));

    // The first ten go alone in their minute; the other two wait for its end, then fail as one.
    await t.pass(START + 1_200);
    const report = await t.pass(end);
    expect([...report.retrying].sort()).toEqual([eleventh, twelfth].sort());
    expect(report.gaveUp).toEqual([]);
    for (const id of [eleventh, twelfth]) {
      expect(await t.row(id as string)).toMatchObject({
        gave_up_at: null,
        next_attempt_at: String(end + retryDelayMs(1)),
        last_error: words,
      });
    }
    expect(t.refusals).toEqual([
      {
        event: expect.objectContaining({
          deliveryId: eleventh,
          plugin: "@facetdb/telegram",
          action: "notify",
        }),
        lastError: words,
      },
    ]);
    expect(t.credentialLines()).toHaveLength(1);

    t.script.digest = () => Promise.resolve(undefined);
    const delivered = await t.pass(end + retryDelayMs(1));
    expect([...delivered.delivered].sort()).toEqual([eleventh, twelfth].sort());
    expect(t.delivered).toContainEqual({ ...GITHUB, plugin: "@facetdb/telegram" });
    expect(t.credentialLines().map((line) => line.phase)).toEqual(["raised", "resolved"]);
  });

  it("given up at its deadline raises Action gave up alone, never the credential alert", async () => {
    const t = await rig();
    const ids = await t.notify(DIGEST_AFTER + 2);
    const [eleventh, twelfth] = ids.slice(DIGEST_AFTER);
    t.script.digest = () =>
      Promise.reject(new ActionFailed("telegram refused the token", { credentialRefused: true }));

    await t.pass(START + 1_200);
    // Held for its minute, then not claimed again until a day later: its 24 hours are spent.
    const report = await t.pass(START + GIVE_UP_AFTER_MS + DIGEST_MINUTE_MS);
    expect([...report.gaveUp].sort()).toEqual([eleventh, twelfth].sort());
    expect(t.gaveUp).toHaveLength(1);
    expect(t.refusals).toEqual([]);
    expect(t.credentialLines()).toEqual([]);
  });
});

describe("the resolve", () => {
  /** Six rows of the GitHub label on one source, refused once: the alert is open. */
  async function refusedSix() {
    const t = await rig();
    t.script.run = unauthorized;
    const ids: string[] = [];
    for (let index = 0; index < 6; index += 1) {
      ids.push(await t.action("@facetdb/github", SOURCE_ID, `r${index}`));
    }
    await t.pass(START);
    expect(t.credentialLines()).toHaveLength(1);
    t.script.run = () => Promise.resolve(undefined);
    return { t, ids };
  }

  const KEY = credentialRefusedKey(GITHUB);

  it("goes once for many rows of one plugin and source delivered in one pass, the store slow enough that they overlap", async () => {
    const { t, ids } = await refusedSix();
    t.store.slow = true;
    const readsBefore = t.store.reads.length;

    const report = await t.pass(START + retryDelayMs(1));

    expect([...report.delivered].sort()).toEqual([...ids].sort());
    expect(report.credentialAlertFailures).toEqual([]);
    // One resolved message to the channel, one resolved line on the Alerts page, one read.
    expect(t.sent.filter((message) => message.text.startsWith("Resolved:"))).toHaveLength(1);
    expect(t.credentialLines().map((line) => line.phase)).toEqual(["raised", "resolved"]);
    expect(t.store.reads.slice(readsBefore).filter((key) => key === KEY)).toHaveLength(1);
  });

  it("reads the key at most once in a pass with no alert open, and not at all once known clear", async () => {
    const t = await rig();
    t.store.slow = true;
    for (let index = 0; index < 6; index += 1) {
      await t.action("@facetdb/github", SOURCE_ID, `r${index}`);
    }
    expect((await t.pass(START)).delivered).toHaveLength(6);
    expect(t.store.reads.filter((key) => key === KEY)).toHaveLength(1);

    for (let index = 6; index < 12; index += 1) {
      await t.action("@facetdb/github", SOURCE_ID, `r${index}`);
    }
    expect((await t.pass(START + 1)).delivered).toHaveLength(6);
    expect(t.store.reads.filter((key) => key === KEY)).toHaveLength(1);
    expect(t.credentialLines()).toEqual([]);
    expect(t.sent).toEqual([]);
  });

  it("resolves an alert another worker raised: at its first delivered try, and after its source's heartbeat once known clear", async () => {
    const t = await rig();
    // Another worker over the same store raises it: this one never saw the raise.
    const other = createAlerts({ store: t.store, clock: t.clock, channels: [] });
    const refused: ActionCredentialRefused = {
      ...GITHUB,
      deliveryId: "99",
      action: "label",
      attempts: 1,
      queuedAt: START,
    };
    await other.raise(credentialRefusedAlert(refused, REFUSED_TOKEN, () => LINK));
    await t.action("@facetdb/github", SOURCE_ID, "r1");
    await t.pass(START);
    expect(t.store.active.has(KEY)).toBe(false);
    expect(t.credentialLines().map((line) => line.phase)).toEqual(["raised", "resolved"]);

    // Known clear now: the other worker raises it again; this one's source beats, and reads again.
    t.clock.advance(ALERT_WINDOW_MS);
    await other.raise(credentialRefusedAlert(refused, REFUSED_TOKEN, () => LINK));
    await t.action("@facetdb/github", SOURCE_ID, "r2");
    await t.pass(t.clock.now());
    expect(t.store.active.has(KEY)).toBe(true);
    await t.alerts.signals({ project: PROJECT, source: SOURCE, link: LINK }).beat();
    await t.action("@facetdb/github", SOURCE_ID, "r3");
    await t.pass(t.clock.now() + 1);
    expect(t.store.active.has(KEY)).toBe(false);
  });

  it("reports a resolve the store failed once for the pass, however many rows were delivered", async () => {
    const { t } = await refusedSix();
    t.store.failReads = true;
    const report = await t.pass(START + retryDelayMs(1));
    expect(report.delivered).toHaveLength(6);
    expect(report.credentialAlertFailures).toEqual([
      { phase: "resolve", event: GITHUB, error: expect.any(Error) },
    ]);
  });
});

describe("the words", () => {
  it("name whose credential, and the key holds the project, the source and the plugin", () => {
    expect(credentialSubject(GITHUB)).toBe("plugin @facetdb/github on source issues");
    expect(credentialRefusedKey(GITHUB)).toBe(
      eventKey({
        kind: "action_credential_refused",
        project: PROJECT,
        source: SOURCE,
        question: null,
        plugin: "@facetdb/github",
      }),
    );
  });
});
