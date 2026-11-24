import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import { SESSION_COOKIE, type Sessions } from "../auth/sessions.ts";
import type { CheckService } from "../check/service.ts";
import type { DataServices } from "../data/routes.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import {
  type ConfigDraft,
  type ConfigFileDoor,
  capLoosenings,
  createConfigService,
  type ProjectDraft,
  type SpendingSettings,
} from "./service.ts";

/**
 * A project draft that loosens the spending cap (a higher cap, none, or `continue` where the
 * project pauses) is the operator's alone (a request from this machine with no sign-in). The
 * baseline is the stricter of the cap in force and the file's as it loads now, so a hand edit no
 * reload has put in force yet is never loosened. `capLoosenings` judges it; the CLI's file door
 * calls it in its queue (facetdb's apply-cap-operator.test.ts runs the real door). Here the route:
 * who it says is asking, and the 403 `operator_only` it answers, at the diff and at the confirm.
 */

const PROJECT = "listings-app";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const MAYA = { cookie: `${SESSION_COOKIE}=maya.valid` };

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: () => Promise.resolve(undefined),
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

/** A cap of a million input tokens a month, the project pausing at 100%. */
const CAPPED: SpendingSettings = { spendingCap: 1_000_000, onCapReached: "pause" };

const DIFF = "--- a/facetdb.config.ts\n+++ b/facetdb.config.ts\n";

/**
 * The worker as a rig: the spending settings in force and the file's (read at each call, so a
 * test can change them between the diff and the confirm), and the CLI's file door as a fake that
 * keeps its contract: `capLoosenings` against both for anyone but the operator, before any plan.
 * `asked` is who each call said was asking; `calls` what got past the judgment.
 */
function rig(
  options: {
    inForce?: SpendingSettings;
    file?: SpendingSettings;
    operatorByAddress?: boolean;
  } = {},
) {
  const state = { inForce: options.inForce ?? CAPPED, file: options.file ?? CAPPED };
  const asked: boolean[] = [];
  const calls: { kind: string; draft: ConfigDraft }[] = [];
  const refusal = (draft: ConfigDraft, operator: boolean) => {
    asked.push(operator);
    const changes = operator ? [] : capLoosenings(state, draft);
    return changes.length === 0 ? undefined : ({ kind: "operator_only", changes } as const);
  };
  const file: ConfigFileDoor = {
    reload: () => Promise.reject(new Error("Apply reloads inside its own write")),
    diff: (draft, asker) => {
      const refused = refusal(draft, asker.operator);
      if (refused !== undefined) {
        return Promise.resolve(refused);
      }
      calls.push({ kind: "diff", draft });
      return Promise.resolve({
        kind: "planned",
        path: "facetdb.config.ts",
        diff: DIFF,
        changed: true,
        plan: "plan-1",
        uncommitted: null,
        dropsOwnText: false,
        warnings: [],
      });
    },
    apply: (draft, _options, asker) => {
      const refused = refusal(draft, asker.operator);
      if (refused !== undefined) {
        return Promise.resolve(refused);
      }
      calls.push({ kind: "apply", draft });
      return Promise.resolve({
        kind: "applied",
        path: "facetdb.config.ts",
        diff: DIFF,
        reload: { loaded: true, sources: [], notes: [] },
      });
    },
  };
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: createConfigService({
      config: {
        projectId: PROJECT,
        json: () => ({}),
        validate: () => {
          throw new Error("Apply judges through its own door");
        },
        pending: () => [],
        history: {
          sources: () => {
            throw new Error("Apply reads no version history");
          },
          read: () => Promise.reject(new Error("Apply reads no version history")),
        },
        file,
      },
      preview: () => undefined,
      log: () => undefined,
    }),
    data: NO_DATA,
    review: NO_REVIEW,
    studio: {
      sessions,
      reviewers: {
        list: () => Promise.reject(new Error("these tests list no reviewers")),
        add: () => Promise.reject(new Error("these tests add no reviewer")),
        canAdd: () => Promise.resolve(false),
      },
      projectId: PROJECT,
      operatorByAddress: options.operatorByAddress ?? true,
      log: () => undefined,
    },
    newRequestId: () => "req-1",
  });
  const call = async (
    body: unknown,
    who: {
      readonly peer: { readonly remoteAddress: string };
      readonly headers?: Readonly<Record<string, string>>;
    },
  ) => {
    const response = await app.request(
      "/v1/apply",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...who.headers },
        body: JSON.stringify(body),
      },
      who.peer,
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
  return {
    asked,
    calls,
    state,
    /** A signed-in reviewer: maya's cookie, from another machine. */
    reviewer: (body: unknown) => call(body, { peer: ELSEWHERE, headers: MAYA }),
    /** The same account from this machine: a sign-in is that account, never the operator. */
    reviewerHere: (body: unknown) => call(body, { peer: THIS_MACHINE, headers: MAYA }),
    /** The operator: this machine, no cookie. */
    operator: (body: unknown) => call(body, { peer: THIS_MACHINE }),
  };
}

const NOT_OPERATOR_FIX =
  "Edit facetdb.config.ts on the machine that runs facetdb worker, or apply this in the studio opened there with no sign-in. Lowering the cap, or pausing at 100%, can be applied here.";

/** Each draft that loosens a cap of 1,000,000 that pauses, and what the refusal says it does. */
const LOOSENING: readonly (readonly [string, ProjectDraft, string])[] = [
  [
    "a higher cap",
    { spendingCap: 2_000_000 },
    "raises the spending cap from 1,000,000 to 2,000,000 input tokens a month",
  ],
  [
    "a higher cap sent with pause, as Settings' form sends it",
    { spendingCap: 2_000_000, onCapReached: "pause" },
    "raises the spending cap from 1,000,000 to 2,000,000 input tokens a month",
  ],
  ["no cap", { spendingCap: null }, "removes the spending cap of 1,000,000 input tokens a month"],
  [
    "continue",
    { onCapReached: "continue" },
    "keeps the project answering past the cap instead of pausing",
  ],
  [
    "a lower cap sent with continue",
    { spendingCap: 500_000, onCapReached: "continue" },
    "keeps the project answering past the cap instead of pausing",
  ],
  [
    "no cap and continue",
    { spendingCap: null, onCapReached: "continue" },
    "removes the spending cap of 1,000,000 input tokens a month and keeps the project answering past the cap instead of pausing",
  ],
];

describe("capLoosenings: the stricter of the cap in force and the file's", () => {
  const judge = (inForce: SpendingSettings, file: SpendingSettings, project: ProjectDraft) =>
    capLoosenings({ inForce, file }, { project });

  it("judges a hand edit that lowered the cap by the file's figure (2M in force, 1M written)", () => {
    const inForce = { spendingCap: 2_000_000, onCapReached: "pause" } as const;
    const file = { spendingCap: 1_000_000, onCapReached: "pause" } as const;
    expect(judge(inForce, file, { spendingCap: 1_900_000 })).toEqual([
      { kind: "raises", from: 1_000_000, to: 1_900_000 },
    ]);
    // The same, the other way round: the cap in force is the lower one.
    expect(judge(file, inForce, { spendingCap: 1_900_000 })).toEqual([
      { kind: "raises", from: 1_000_000, to: 1_900_000 },
    ]);
    expect(judge(inForce, file, { spendingCap: 900_000 })).toEqual([]);
  });

  it("keeps a cap the file sets where none is in force (no cap in force, 1M written)", () => {
    const none = { onCapReached: "pause" } as const;
    expect(judge(none, CAPPED, { spendingCap: null })).toEqual([
      { kind: "removes", from: 1_000_000 },
    ]);
    expect(judge(none, CAPPED, { spendingCap: 3_000_000 })).toEqual([
      { kind: "raises", from: 1_000_000, to: 3_000_000 },
    ]);
    expect(judge(none, none, { spendingCap: null })).toEqual([]);
    expect(judge(none, none, { spendingCap: 3_000_000 })).toEqual([]);
  });

  it("keeps pause the file sets where continue is in force", () => {
    const continuing = { spendingCap: 1_000_000, onCapReached: "continue" } as const;
    expect(judge(continuing, CAPPED, { onCapReached: "continue" })).toEqual([
      { kind: "continues" },
    ]);
    expect(judge(CAPPED, continuing, { onCapReached: "continue" })).toEqual([
      { kind: "continues" },
    ]);
    expect(judge(continuing, continuing, { onCapReached: "continue" })).toEqual([]);
  });

  it("finds nothing in a source draft, or a project draft of channels or plugin settings", () => {
    const none = { onCapReached: "pause" } as const;
    const drafts: ConfigDraft[] = [
      { source: { name: "listings" } },
      { project: { alerts: null } },
      { project: { plugins: { slack: { mention: "@here" } } } },
    ];
    for (const draft of drafts) {
      expect(capLoosenings({ inForce: CAPPED, file: none }, draft)).toEqual([]);
    }
  });
});

describe("POST /v1/apply: a draft that loosens the spending cap", () => {
  it("tells the door who asks: the operator only from this machine with no sign-in", async () => {
    const t = rig();
    const project = { spendingCap: 500_000 };
    await t.operator({ project });
    await t.reviewer({ project });
    await t.reviewerHere({ project, confirm: "plan-1" });
    await t.operator({ project, confirm: "plan-1" });
    expect(t.asked).toEqual([true, false, false, true]);
    const nobody = rig({ operatorByAddress: false });
    await nobody.reviewerHere({ project });
    await nobody.reviewer({ project, confirm: "plan-1" });
    expect(nobody.asked).toEqual([false, false]);
  });

  it.each(LOOSENING)(
    "refuses %s from a signed-in reviewer at the diff and at the confirm, nothing planned",
    async (_name, project, does) => {
      const t = rig();
      for (const send of [t.reviewer, t.reviewerHere]) {
        for (const body of [{ project }, { project, confirm: "plan-1", force: true }]) {
          const response = await send(body);
          expect(response).toEqual({
            status: 403,
            json: {
              error: {
                code: "operator_only",
                message: `This draft ${does}. Only the operator can do that.`,
                fix: NOT_OPERATOR_FIX,
              },
            },
          });
        }
      }
      expect(t.calls).toEqual([]);
    },
  );

  it.each(LOOSENING)("lets the operator apply %s", async (_name, project) => {
    const t = rig();
    expect((await t.operator({ project })).status).toBe(200);
    expect((await t.operator({ project, confirm: "plan-1" })).status).toBe(200);
    expect(t.calls).toEqual([
      { kind: "diff", draft: { project } },
      { kind: "apply", draft: { project } },
    ]);
  });

  it("lets a reviewer lower the cap, keep it, or pause", async () => {
    const t = rig();
    const drafts: ProjectDraft[] = [
      { spendingCap: 500_000 },
      { spendingCap: 1_000_000 },
      { onCapReached: "pause" },
      { spendingCap: 500_000, onCapReached: "pause" },
    ];
    for (const project of drafts) {
      expect((await t.reviewer({ project })).status).toBe(200);
      expect((await t.reviewer({ project, confirm: "plan-1" })).status).toBe(200);
    }
    expect(t.calls.map((call) => call.kind)).toEqual(drafts.flatMap(() => ["diff", "apply"]));
  });

  it("names the operator's figure: the file's hand edit, where it is the stricter", async () => {
    const t = rig({
      inForce: { spendingCap: 2_000_000, onCapReached: "pause" },
      file: { spendingCap: 1_000_000, onCapReached: "pause" },
    });
    const response = await t.reviewer({ project: { spendingCap: 1_900_000 }, confirm: "plan-1" });
    expect(response).toEqual({
      status: 403,
      json: {
        error: {
          code: "operator_only",
          message:
            "This draft raises the spending cap from 1,000,000 to 1,900,000 input tokens a month. Only the operator can do that.",
          fix: NOT_OPERATOR_FIX,
        },
      },
    });
    expect(t.calls).toEqual([]);
  });

  it("judges the confirm on its own draft, against the settings as they are then", async () => {
    const t = rig();
    // A diff shown for a lower cap, and a confirm that sends a higher one instead.
    expect((await t.reviewer({ project: { spendingCap: 800_000 } })).status).toBe(200);
    const edited = await t.reviewer({ project: { spendingCap: 2_000_000 }, confirm: "plan-1" });
    expect(edited).toMatchObject({ status: 403, json: { error: { code: "operator_only" } } });
    // The operator wrote a lower cap meanwhile: what was a lower cap at the diff now raises it.
    t.state.file = { spendingCap: 500_000, onCapReached: "pause" };
    const raised = await t.reviewer({ project: { spendingCap: 800_000 }, confirm: "plan-1" });
    expect(raised).toMatchObject({
      status: 403,
      json: {
        error: {
          code: "operator_only",
          message: expect.stringContaining("from 500,000 to 800,000"),
        },
      },
    });
    expect(t.calls).toEqual([{ kind: "diff", draft: { project: { spendingCap: 800_000 } } }]);
  });

  it("where a studioUrl names another host nobody is the operator: the file's hand edit is the way", async () => {
    const t = rig({ operatorByAddress: false });
    for (const send of [t.reviewer, t.reviewerHere]) {
      for (const body of [
        { project: { spendingCap: 2_000_000 } },
        { project: { spendingCap: 2_000_000 }, confirm: "plan-1" },
      ]) {
        expect(await send(body)).toEqual({
          status: 403,
          json: {
            error: {
              code: "operator_only",
              message:
                "This draft raises the spending cap from 1,000,000 to 2,000,000 input tokens a month. A studio reached from other machines (studioUrl) never does that.",
              fix: "Edit facetdb.config.ts on the machine that runs facetdb worker, then press Check again or restart the worker. Lowering the cap, or pausing at 100%, can be applied here.",
            },
          },
        });
      }
    }
    // This machine with no cookie signs in like everyone else there.
    expect((await t.operator({ project: { spendingCap: 2_000_000 } })).status).toBe(401);
    // Lowering stays open.
    expect(
      (await t.reviewer({ project: { spendingCap: 500_000 }, confirm: "plan-1" })).status,
    ).toBe(200);
    expect(t.calls).toEqual([{ kind: "apply", draft: { project: { spendingCap: 500_000 } } }]);
  });
});
