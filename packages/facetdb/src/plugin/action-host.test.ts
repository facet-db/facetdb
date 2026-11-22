import {
  type ActionDecisions,
  ActionNotQueued,
  type ActionRecord,
  type AnswerEntry,
  decideRecord,
  type HumanEntry,
  type LogEntry,
  type QuestionSet,
  type ReadResult,
  statusOf,
  WITHDRAWN,
} from "@facetdb/core";
import { FakeClock } from "@facetdb/core/testing";
import { type ActionDelivery, ActionFailed } from "@facetdb/server";
import { describe, expect, it } from "vitest";
import {
  type ActionCall,
  actionCall,
  env,
  facetdb,
  noul,
  type ProjectConfig,
} from "../config/index.ts";
import { VERSION } from "../index.ts";
import {
  type ActionContext,
  type ActionPayload,
  type ActionSource,
  action,
  actionSteps,
  checkActions,
  createActionRunner,
  createPluginHost,
  definePlugin,
  type PluginHost,
  PluginHostError,
  type QueuedAction,
  RECORD_CHANGED,
  RECORD_GONE,
  SUPERSEDED,
  WAITS_FOR_PERSON,
  z,
} from "./index.ts";

/**
 * The action host: a source's actions checked against the plugins the host loaded (an action the
 * plugin lacks, settings or an `else` its schema refuses, a secret written into the file, a
 * variable not set), one step per action that queues a row with the settings `when` and `else`
 * resolve, nothing of the record's state and never a variable's value, and the runner the outbox
 * calls, which reads the record through its source at delivery, closes a row whose record is gone
 * or whose decision is no longer the record's (by the log's order and the state hash, never a
 * clock), waits for a stopped source, and hands the plugin's own error on untouched.
 */

const SECRET = "trk_s3cret-token";
const HOOK_URL = "https://hooks.example.com/s3cret-path-token";
const ENV = { HOOK_URL };

type Ran = {
  readonly action: string;
  readonly ctx: ActionContext<unknown>;
  readonly record: ActionRecord;
  readonly decisions: ActionDecisions;
  readonly settings: unknown;
};

async function noop(): Promise<void> {}

function trackerPlugin(ran: Ran[]) {
  return definePlugin({
    name: "tracker",
    version: "1.0.0",
    facetdb: "*",
    config: z.object({ team: z.string() }),
    actions: {
      label: action({
        config: z.object({
          add: z.array(z.string()).default([]),
          remove: z.array(z.string()).default([]),
        }),
        run: async (ctx, record, decisions, settings) => {
          ran.push({ action: "label", ctx, record, decisions, settings });
        },
      }),
      ping: action({ config: z.object({}), run: noop }),
      // A secret under a name the file's own schema does not take for one.
      hook: action({
        config: z.object({ url: z.secret() }),
        run: async (ctx, record, decisions, settings) => {
          ran.push({ action: "hook", ctx, record, decisions, settings });
        },
      }),
      broken: action({
        config: z.object({}),
        run: () => Promise.reject(new Error(`the tracker refused ${SECRET}`)),
      }),
      vouched: action({
        config: z.object({}),
        run: () => Promise.reject(new ActionFailed(`the tracker refused ${SECRET}`)),
      }),
    },
  });
}

function project(actions: readonly ActionCall[]): ProjectConfig {
  return facetdb({
    model: "jev-1.14.0",
    plugins: { tracker: { team: "core" } },
    sources: [
      {
        name: "issues",
        api: true,
        read: ["title"],
        questions: { not_priority: noul("Would the maintainers treat this as low priority?") },
        thresholds: { not_priority: { yesAbove: 0.8, noBelow: 0.2 } },
        actions,
      },
    ],
  });
}

function hostFor(config: ProjectConfig, ran: Ran[] = []): Promise<PluginHost> {
  const tracker = trackerPlugin(ran);
  return createPluginHost({
    config,
    env: ENV,
    projectDir: "/work/shop",
    coreVersion: VERSION,
    importModule: (specifier) =>
      specifier === "@facetdb/tracker"
        ? Promise.resolve({ default: tracker })
        : Promise.reject(
            Object.assign(new Error(`Cannot find package '${specifier}'`), {
              code: "ERR_MODULE_NOT_FOUND",
            }),
          ),
    builtins: {},
  });
}

/** The refusal `checkActions` throws for a config, with a host loaded from that config. */
async function refusalOf(
  config: ProjectConfig,
  environment: Readonly<Record<string, string>> = ENV,
): Promise<PluginHostError> {
  const host = await hostFor(config);
  try {
    checkActions(config, host, environment);
  } catch (error) {
    if (error instanceof PluginHostError) {
      return error;
    }
    throw error;
  }
  throw new Error("expected checkActions to refuse the config");
}

const DECIDED_AT = new Date("2026-11-13T10:00:00.000Z");
const YES: ActionDecisions = {
  not_priority: { kind: "decided", value: true, probabilityOrConfidence: 0.93 },
};
const NO: ActionDecisions = {
  not_priority: { kind: "decided", value: false, probabilityOrConfidence: 0.08 },
};
const WAITING: ActionDecisions = { not_priority: { kind: "needs_review" } };

/** The rows the source's steps queue for one decision, in the file's order. */
async function queued(
  config: ProjectConfig,
  decisions: ActionDecisions,
  status: ActionRecord["status"] = "done",
  queue?: (row: QueuedAction) => Promise<unknown>,
): Promise<QueuedAction[]> {
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  const rows: QueuedAction[] = [];
  const steps = actionSteps(
    source,
    queue ??
      ((row) => {
        rows.push(row);
        return Promise.resolve();
      }),
  );
  const record: ActionRecord = {
    key: "7",
    state: { title: "Typo in README" },
    status,
    stateHash: "h1",
    decidedAt: DECIDED_AT,
  };
  for (const step of steps) {
    await step.run(record, decisions);
  }
  return rows;
}

const LABEL = actionCall("@facetdb/tracker", "label", {
  add: ["Not Priority"],
  when: { not_priority: true },
  else: { add: [], remove: ["Not Priority"] },
});

describe("checking a source's actions against the plugins the host loaded (action-host)", () => {
  it("passes actions the plugin provides, with settings and an else its schema takes", async () => {
    const config = project([
      LABEL,
      actionCall("@facetdb/tracker", "ping", { when: { status: "needs_review" } }),
      actionCall("@facetdb/tracker", "hook", { url: env("HOOK_URL") }),
    ]);
    const host = await hostFor(config);
    expect(() => checkActions(config, host, ENV)).not.toThrow();
  });

  it("refuses an action the plugin does not provide, listing the ones it does", async () => {
    const refused = await refusalOf(
      project([LABEL, actionCall("@facetdb/tracker", "lable", { add: ["x"] })]),
    );
    expect(refused.code).toBe("plugin-no-action");
    expect(refused.message).toBe(
      'sources[0].actions[1].action is "lable", but the plugin "@facetdb/tracker" has no action of that name: its actions are label, ping, hook, broken, vouched',
    );
    expect(refused.fix).toBe(
      "change sources[0].actions[1].action to one of label, ping, hook, broken, vouched",
    );
  });

  it("refuses a setting the action's schema refuses, at its place in the file", async () => {
    const refused = await refusalOf(project([actionCall("@facetdb/tracker", "label", { add: 3 })]));
    expect(refused.code).toBe("action-settings");
    expect(refused.message).toMatch(
      /^the settings of sources\[0\]\.actions\[0\] \(@facetdb\/tracker label\) are refused by the action's schema:\n {2}- sources\[0\]\.actions\[0\]\.add: /,
    );
    expect(refused.fix).toBe(
      "change sources[0].actions[0] in the config file, or the variable it names, as each line says",
    );
  });

  it("refuses an else that sets what the action has not, or a value its schema refuses", async () => {
    const stranger = await refusalOf(
      project([
        actionCall("@facetdb/tracker", "label", {
          add: ["x"],
          when: { not_priority: true },
          else: { delete: ["x"] },
        }),
      ]),
    );
    expect(stranger.code).toBe("action-settings");
    expect(stranger.message).toContain(
      "  - sources[0].actions[0].else.delete: is not a setting of this action, so else cannot set it (its settings: add, remove)",
    );

    const wrong = await refusalOf(
      project([
        actionCall("@facetdb/tracker", "label", {
          add: ["x"],
          when: { not_priority: true },
          else: { remove: "x" },
        }),
      ]),
    );
    expect(wrong.code).toBe("action-settings");
    expect(wrong.message).toMatch(/\n {2}- sources\[0\]\.actions\[0\]\.else\.remove: /);
  });

  it("refuses a secret of the action's schema written into the file, naming the place and never the value", async () => {
    const refused = await refusalOf(
      project([actionCall("@facetdb/tracker", "hook", { url: HOOK_URL })]),
    );
    expect(refused.code).toBe("plugin-secret-literal");
    expect(refused.message).toBe(
      "sources[0].actions[0].url is a secret of the action @facetdb/tracker hook written into the config file, and secrets never go in this file, its JSON export or a queued action",
    );
    expect(refused.fix).toContain('url: env("');
    expect(`${refused.message} ${refused.fix}`).not.toContain("s3cret");

    const inElse = await refusalOf(
      project([
        actionCall("@facetdb/tracker", "hook", {
          url: env("HOOK_URL"),
          when: { not_priority: true },
          else: { url: HOOK_URL },
        }),
      ]),
    );
    expect(inElse.message).toMatch(/^sources\[0\]\.actions\[0\]\.else\.url is a secret/);
  });

  it("refuses a variable an action's setting reads that is not set, naming it", async () => {
    const refused = await refusalOf(
      project([actionCall("@facetdb/tracker", "hook", { url: env("HOOK_URL") })]),
      {},
    );
    expect(refused.code).toBe("plugin-variable-unset");
    expect(refused.message).toBe(
      "sources[0].actions[0] (@facetdb/tracker hook) cannot run: HOOK_URL is not set (sources[0].actions[0].url reads it)",
    );
  });

  it("refuses an action whose plugin the host did not load, saying a restart loads it", async () => {
    // The worker started with no plugin named at all; the file named one since.
    const { plugins: _none, ...started } = project([]);
    const host = await hostFor(started);
    try {
      checkActions(project([LABEL]), host, ENV);
      expect.unreachable("the plugin is not loaded");
    } catch (error) {
      expect(error).toBeInstanceOf(PluginHostError);
      expect((error as PluginHostError).message).toBe(
        'sources[0].actions[0].plugin names the plugin "@facetdb/tracker", which this worker did not load when it started',
      );
    }
  });
});

describe("a step queues one row with what when and else resolve (action-host)", () => {
  it("when true: the action's own settings, and the decision without the record's state", async () => {
    expect(await queued(project([LABEL]), YES)).toEqual([
      {
        recordKey: "7",
        plugin: "@facetdb/tracker",
        action: "label",
        position: 0,
        payload: {
          status: "done",
          decidedAt: "2026-11-13T10:00:00.000Z",
          stateHash: "h1",
          decisions: YES,
          settings: { add: ["Not Priority"] },
        },
      },
    ]);
  });

  it("when false with an else: the settings with the else laid over them", async () => {
    const [row] = await queued(project([LABEL]), NO);
    expect(row?.payload.settings).toEqual({ add: [], remove: ["Not Priority"] });
  });

  it("when false with no else: no row", async () => {
    const config = project([
      actionCall("@facetdb/tracker", "label", { add: ["x"], when: { not_priority: true } }),
    ]);
    expect(await queued(config, NO)).toEqual([]);
  });

  it("a question still waiting for a person never matches, whatever the term says", async () => {
    const config = project([
      actionCall("@facetdb/tracker", "label", { add: ["yes"], when: { not_priority: true } }),
      actionCall("@facetdb/tracker", "label", { add: ["no"], when: { not_priority: false } }),
      actionCall("@facetdb/tracker", "label", {
        add: ["sure"],
        when: { "not_priority.probability": { atLeast: 0 } },
      }),
      LABEL,
      actionCall("@facetdb/tracker", "ping", { when: { status: "needs_review" } }),
    ]);
    const rows = await queued(config, WAITING, "needs_review");
    // Only the else of the fourth and the status test of the fifth: positions 3 and 4.
    expect(rows.map((row) => [row.position, row.payload.settings])).toEqual([
      [3, { add: [], remove: ["Not Priority"] }],
      [4, {}],
    ]);
  });

  it("queues a setting read from a variable as the variable's name, never its value", async () => {
    const [row] = await queued(
      project([actionCall("@facetdb/tracker", "hook", { url: env("HOOK_URL") })]),
      YES,
    );
    expect(row?.payload.settings).toEqual({ url: { env: "HOOK_URL" } });
    expect(JSON.stringify(row)).not.toContain("s3cret");
  });

  it("a row the store does not take is core's ActionNotQueued, so the worker's job is released", async () => {
    const refused = queued(project([LABEL]), YES, "done", () =>
      Promise.reject(new Error("connection reset")),
    );
    await expect(refused).rejects.toBeInstanceOf(ActionNotQueued);
    await expect(refused).rejects.toThrow(
      "it was not queued, as the store did not take it (connection reset); it is queued again when the worker next writes the record's decision, or a person decides it again",
    );
  });
});

/** The source's question set, as its loop runs it. */
function questionSetOf(config: ProjectConfig): QuestionSet {
  const [source] = config.sources;
  if (source === undefined) {
    throw new Error("the test config has a source");
  }
  return {
    model: config.model,
    read: source.read,
    questions: source.questions,
    thresholds: source.thresholds,
  };
}

const QUESTION_SET = questionSetOf(project([LABEL]));

/** The same set with a question added since: `oss_only`, which older answers do not hold. */
const ADDED: QuestionSet = {
  ...QUESTION_SET,
  questions: [
    ...QUESTION_SET.questions,
    ...QUESTION_SET.questions.map((question) => ({ ...question, name: "oss_only" })),
  ],
};
const STATE = { title: "Typo in README" };

function answerAt(
  at: string,
  probability: number,
  options: { readonly stateHash?: string; readonly also?: Record<string, number> } = {},
): AnswerEntry {
  return {
    kind: "answer",
    key: "7",
    version: 1,
    model: "jev-1.14.0",
    stateHash: options.stateHash ?? "h1",
    answers: {
      not_priority: { type: "noul", probability },
      ...Object.fromEntries(
        Object.entries(options.also ?? {}).map(([name, p]) => [
          name,
          { type: "noul" as const, probability: p },
        ]),
      ),
    },
    usage: { inputTokens: 10, outputTokens: 1 },
    at: new Date(at),
  };
}

function humanAt(
  at: string,
  value: HumanEntry["value"],
  options: { readonly stateHash?: string; readonly question?: string } = {},
): HumanEntry {
  return {
    kind: "human",
    key: "7",
    question: options.question ?? "not_priority",
    value,
    reviewer: "os:alex",
    stateHash: options.stateHash ?? "h1",
    version: 1,
    at: new Date(at),
  };
}

/**
 * The payload the steps queued for the decision the record held when `history` was its whole log:
 * what the worker or a person's decision wrote then, through core's own function.
 */
function payloadAfter(history: readonly LogEntry[]): ActionPayload {
  const answers = history.filter((entry): entry is AnswerEntry => entry.kind === "answer");
  const latest = answers[answers.length - 1];
  if (latest === undefined) {
    throw new Error("a decision stands on an answer");
  }
  const decisions = decideRecord(QUESTION_SET, QUESTION_SET.thresholds, latest, history);
  if (decisions === undefined) {
    throw new Error("the answer holds every question");
  }
  const last = history[history.length - 1];
  return {
    status: statusOf(decisions),
    decidedAt: (last?.at ?? DECIDED_AT).toISOString(),
    stateHash: latest.stateHash,
    decisions,
    settings: { add: ["Not Priority"] },
  };
}

/** A runner over one source whose record `7` holds `STATE` at `hash`, with the log `history`. */
async function runnerFor(
  options: {
    readonly history?: readonly LogEntry[];
    readonly hash?: string;
    readonly gone?: boolean;
    readonly source?: ActionSource;
    readonly questionSet?: QuestionSet;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
) {
  const ran: Ran[] = [];
  const config = project([LABEL]);
  const host = await hostFor(config, ran);
  const reads: string[][] = [];
  const running: ActionSource = {
    kind: "running",
    name: "issues",
    connector: {
      read: (keys): Promise<ReadResult> => {
        reads.push([...keys]);
        return Promise.resolve(
          options.gone === true
            ? { rows: [], missing: [...keys] }
            : {
                rows: [{ key: "7", state: STATE, hash: options.hash ?? "h1", excluded: false }],
                missing: [],
              },
        );
      },
    },
    log: { history: () => Promise.resolve(options.history ?? [ANSWER_YES]) },
    questionSet: options.questionSet ?? QUESTION_SET,
  };
  const run = createActionRunner({
    host,
    source: () => options.source ?? running,
    env: options.env ?? ENV,
    // No row here is a notification (notify-action.test.ts sends those).
    notify: {
      clock: new FakeClock(0),
      stop: () => new AbortController().signal,
      recordLink: () => undefined,
      listLink: () => undefined,
    },
  });
  return { ran, reads, run };
}

const ANSWER_YES = answerAt(DECIDED_AT.toISOString(), 0.93);

function delivery(overrides: Partial<ActionDelivery> = {}): ActionDelivery {
  return {
    deliveryId: "1",
    projectId: "shop",
    sourceId: "shop:issues",
    recordKey: "7",
    plugin: "@facetdb/tracker",
    action: "label",
    position: 0,
    payload: payloadAfter([ANSWER_YES]),
    batchKey: undefined,
    attempt: 1,
    queuedAt: DECIDED_AT.getTime(),
    ...overrides,
  };
}

function never(): AbortSignal {
  return new AbortController().signal;
}

describe("the runner the outbox calls for an action row (action-host)", () => {
  it("reads the record at delivery and calls the plugin's run with it, the decisions and the settings", async () => {
    const t = await runnerFor();
    const signal = new AbortController().signal;

    expect(await t.run(delivery(), signal)).toBeUndefined();

    expect(t.reads).toEqual([["7"]]);
    expect(t.ran).toHaveLength(1);
    const [call] = t.ran;
    expect(call?.record).toEqual({
      key: "7",
      state: STATE,
      status: "done",
      stateHash: "h1",
      decidedAt: DECIDED_AT,
    });
    expect(call?.decisions).toMatchObject({ not_priority: { kind: "decided", value: true } });
    // Parsed by the action's schema again: its default fills what the row left out.
    expect(call?.settings).toEqual({ add: ["Not Priority"], remove: [] });
    expect(call?.ctx.config).toEqual({ team: "core" });
    expect(call?.ctx.source).toEqual({ name: "issues", settings: null });
    expect(call?.ctx.signal).toBe(signal);
  });

  it('closes the row as "record gone" when the record is no longer in its source', async () => {
    const t = await runnerFor({ gone: true });
    expect(await t.run(delivery(), never())).toEqual({ close: RECORD_GONE });
    expect(t.ran).toEqual([]);
  });

  it("closes the row when the record changed since its decision, though nothing answered it yet", async () => {
    const t = await runnerFor({ hash: "h2" });
    expect(await t.run(delivery(), never())).toEqual({ close: RECORD_CHANGED });
    expect(t.ran).toEqual([]);

    // Asked again at another state since, the record back at this one: the trigger queued it again.
    const back = await runnerFor({
      history: [ANSWER_YES, answerAt("2026-11-13T11:00:00.000Z", 0.93, { stateHash: "h2" })],
    });
    expect(await back.run(delivery(), never())).toEqual({ close: RECORD_CHANGED });
  });

  it("a question added and not yet answered moves nothing: an older row runs, and so does a person's decision on the partial card", async () => {
    const answer = answerAt("2026-11-13T10:00:00.000Z", 0.5);
    const person = humanAt("2026-11-13T10:05:00.000Z", true);

    // Queued before the question was added; the loop now runs the larger set.
    const before = await runnerFor({ history: [answer], questionSet: ADDED });
    expect(await before.run(delivery({ payload: payloadAfter([answer]) }), never())).toBe(
      undefined,
    );
    expect(before.ran).toHaveLength(1);

    // The review service judges the card on the questions its answer has: so does this.
    const partial = await runnerFor({ history: [answer, person], questionSet: ADDED });
    expect(
      await partial.run(delivery({ payload: payloadAfter([answer, person]) }), never()),
    ).toBeUndefined();
    expect(partial.ran.map((call) => call.record.status)).toEqual(["done"]);
    // The answer's own row, after the person's decision, is still the older decision.
    expect(await partial.run(delivery({ payload: payloadAfter([answer]) }), never())).toEqual({
      close: SUPERSEDED,
    });
  });

  it("the backfill answers the added question confidently and the status stays the row's: the row runs as queued", async () => {
    const answer = answerAt("2026-11-13T10:00:00.000Z", 0.5);
    const person = humanAt("2026-11-13T10:05:00.000Z", true);
    // The backfill's answer keeps the answers the record had and adds the new question's.
    const backfilled = answerAt("2026-11-13T12:00:00.000Z", 0.5, { also: { oss_only: 0.97 } });
    const t = await runnerFor({ history: [answer, person, backfilled], questionSet: ADDED });
    const queued = payloadAfter([answer, person]);
    expect(await t.run(delivery({ payload: queued }), never())).toBeUndefined();
    // With its payload as queued: no word of the question it never carried.
    expect(t.ran.map((call) => [call.record.status, Object.keys(call.decisions)])).toEqual([
      ["done", ["not_priority"]],
    ]);
  });

  it("the backfill's answer on the added question is unsure and the record waits for a person: the row closes, naming the person's decision", async () => {
    const answer = answerAt("2026-11-13T10:00:00.000Z", 0.5);
    const person = humanAt("2026-11-13T10:05:00.000Z", true);
    const backfilled = answerAt("2026-11-13T12:00:00.000Z", 0.5, { also: { oss_only: 0.5 } });
    const t = await runnerFor({ history: [answer, person, backfilled], questionSet: ADDED });
    expect(await t.run(delivery({ payload: payloadAfter([answer, person]) }), never())).toEqual({
      close: WAITS_FOR_PERSON,
    });
    expect(WAITS_FOR_PERSON).toContain("the person's decision runs the actions");
    expect(t.ran).toEqual([]);
  });

  it("runs a row the log cannot judge: no answer logged, or none of the questions asked now", async () => {
    const empty = await runnerFor({ history: [] });
    expect(await empty.run(delivery(), never())).toBeUndefined();

    const renamed = await runnerFor({
      questionSet: {
        ...QUESTION_SET,
        questions: QUESTION_SET.questions.map((question) => ({ ...question, name: "renamed" })),
      },
    });
    expect(await renamed.run(delivery(), never())).toBeUndefined();
    expect([...empty.ran, ...renamed.ran]).toHaveLength(2);
  });

  it("a person's decision after an answer at the same state: the answer's row closes, the person's runs", async () => {
    const answer = answerAt("2026-11-13T10:00:00.000Z", 0.5);
    const person = humanAt("2026-11-13T10:05:00.000Z", true);
    const history = [answer, person];
    const t = await runnerFor({ history });

    expect(await t.run(delivery({ payload: payloadAfter([answer]) }), never())).toEqual({
      close: SUPERSEDED,
    });
    expect(await t.run(delivery({ payload: payloadAfter(history) }), never())).toBeUndefined();
    expect(t.ran.map((call) => call.record.status)).toEqual(["done"]);
  });

  it("an undo: the person's row closes, the undo's runs", async () => {
    const answer = answerAt("2026-11-13T10:00:00.000Z", 0.5);
    const person = humanAt("2026-11-13T10:05:00.000Z", true);
    const undo = humanAt("2026-11-13T10:06:00.000Z", WITHDRAWN);
    const history = [answer, person, undo];
    const t = await runnerFor({ history });

    expect(await t.run(delivery({ payload: payloadAfter([answer, person]) }), never())).toEqual({
      close: SUPERSEDED,
    });
    expect(await t.run(delivery({ payload: payloadAfter(history) }), never())).toBeUndefined();
    expect(t.ran.map((call) => call.record.status)).toEqual(["needs_review"]);
  });

  it("a re-ask at the same state: an older row closes when the answer moved, and runs when it did not", async () => {
    const first = answerAt("2026-11-13T10:00:00.000Z", 0.5);
    const moved = answerAt("2026-11-13T11:00:00.000Z", 0.93);
    const t = await runnerFor({ history: [first, moved] });
    expect(await t.run(delivery({ payload: payloadAfter([first]) }), never())).toEqual({
      close: SUPERSEDED,
    });

    const again = answerAt("2026-11-13T11:00:00.000Z", 0.93);
    const same = await runnerFor({ history: [ANSWER_YES, again] });
    expect(await same.run(delivery(), never())).toBeUndefined();
  });

  it("a person's decision on a question no longer asked moves nothing: the answer's row runs", async () => {
    const answer = answerAt(DECIDED_AT.toISOString(), 0.93, { also: { duplicate: 0.5 } });
    const removed = humanAt("2026-11-13T10:05:00.000Z", true, { question: "duplicate" });
    const t = await runnerFor({ history: [answer, removed] });
    expect(await t.run(delivery({ payload: payloadAfter([answer]) }), never())).toBeUndefined();
    expect(t.ran).toHaveLength(1);
  });

  it("two decisions inside the same millisecond are told apart by the log's order, not the clock", async () => {
    const at = "2026-11-13T10:00:00.000Z";
    const answer = answerAt(at, 0.5);
    const person = humanAt(at, false);
    const history = [answer, person];
    const t = await runnerFor({ history });
    expect(await t.run(delivery({ payload: payloadAfter([answer]) }), never())).toEqual({
      close: SUPERSEDED,
    });
    expect(await t.run(delivery({ payload: payloadAfter(history) }), never())).toBeUndefined();
  });

  it("reads a setting's variable at delivery, so the plugin gets the value and the row only the name", async () => {
    const t = await runnerFor();
    const row = delivery({
      action: "hook",
      payload: { ...payloadAfter([ANSWER_YES]), settings: { url: { env: "HOOK_URL" } } },
    });
    expect(JSON.stringify(row.payload)).not.toContain("s3cret");
    expect(await t.run(row, never())).toBeUndefined();
    expect(t.ran.map((call) => call.settings)).toEqual([{ url: HOOK_URL }]);

    const unset = await runnerFor({ env: {} });
    await expect(unset.run(row, never())).rejects.toThrow(
      new ActionFailed(
        "HOOK_URL is not set where the worker runs, and the action's settings read it",
      ),
    );
  });

  it("hands the plugin's own error on as it is, never as words the outbox keeps", async () => {
    const t = await runnerFor();
    const plain = { ...payloadAfter([ANSWER_YES]), settings: {} };
    const failed = await t
      .run(delivery({ action: "broken", payload: plain }), never())
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(ActionFailed);

    // A plugin's own ActionFailed would be kept by the outbox: its words are dropped here.
    const vouched = await t
      .run(delivery({ action: "vouched", payload: plain }), never())
      .catch((error: unknown) => error);
    expect(vouched).not.toBeInstanceOf(ActionFailed);
    expect(String(vouched)).not.toContain(SECRET);
  });

  it("defers a row whose source is stopped, and closes one whose source or action left the config", async () => {
    const stopped = await runnerFor({ source: { kind: "stopped", name: "issues" } });
    expect(await stopped.run(delivery(), never())).toEqual({
      defer: "the source issues is stopped, so the record cannot be read; the action waits for it",
    });

    const gone = await runnerFor({ source: { kind: "gone" } });
    expect(await gone.run(delivery(), never())).toEqual({
      close: "the source is no longer in the config, so the action is not run",
    });

    const t = await runnerFor();
    expect(await t.run(delivery({ action: "unlabel" }), never())).toEqual({
      close:
        "the action @facetdb/tracker unlabel is no longer one this worker runs, so it is not run",
    });
  });

  it("fails in its own words on a payload it cannot read back, or settings the schema refuses now", async () => {
    const t = await runnerFor();
    await expect(t.run(delivery({ payload: { status: "done" } }), never())).rejects.toThrow(
      new ActionFailed("the queued decision could not be read back from the store"),
    );
    await expect(
      t.run(
        delivery({ payload: { ...payloadAfter([ANSWER_YES]), settings: { add: "x" } } }),
        never(),
      ),
    ).rejects.toThrow(
      new ActionFailed(
        "the settings the action was queued with are refused by its schema now (the plugin, or a variable they read, changed since)",
      ),
    );
    expect(t.ran).toEqual([]);
  });
});
