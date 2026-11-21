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
  createConfigService,
  type FileApply,
  type FileDiff,
} from "./service.ts";

/**
 * `POST /v1/apply` on fakes: a studio route, so a reviewer's alone; a JSON body declared as such
 * and no other site's page; the diff without `confirm`, the write with the plan the diff named;
 * each refusal of the CLI's file door mapped to its status and words, nothing written by any.
 */

const PROJECT = "listings-app";
const KEY = "Bearer fdb_listings";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };
const MAYA = `${SESSION_COOKIE}=maya.valid`;

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

const DIFF =
  '--- a/facetdb.config.ts\n+++ b/facetdb.config.ts\n@@ -9,1 +9,1 @@\n-  "is_scam": noul("Is it a scam?"),\n+  "is_scam": noul("Is it a scam or a fake?"),\n';

const PLANNED: FileDiff = {
  kind: "planned",
  path: "facetdb.config.ts",
  diff: DIFF,
  changed: true,
  plan: "plan-1",
  uncommitted: null,
  dropsOwnText: false,
  warnings: [],
};

const APPLIED: FileApply = {
  kind: "applied",
  path: "facetdb.config.ts",
  diff: DIFF,
  reload: {
    loaded: true,
    sources: [{ source: "listings", outcome: "restarted", version: 2, message: "restarts" }],
    notes: [],
  },
};

/** The CLI's door as a recorder: what each call was asked, and the outcome the test hands back. */
function fileDoor(outcomes: { diff?: FileDiff; apply?: FileApply } = {}) {
  const calls: { kind: string; draft: ConfigDraft; options?: unknown }[] = [];
  const door: ConfigFileDoor = {
    reload: () => Promise.reject(new Error("Apply reloads inside its own write")),
    diff: (draft) => {
      calls.push({ kind: "diff", draft });
      return Promise.resolve(outcomes.diff ?? PLANNED);
    },
    apply: (draft, options) => {
      calls.push({ kind: "apply", draft, options });
      return Promise.resolve(outcomes.apply ?? APPLIED);
    },
  };
  return { calls, door };
}

function rig(file: ConfigFileDoor | undefined) {
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
        ...(file === undefined ? {} : { file }),
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
    },
    newRequestId: () => "req-1",
  });
  return async (
    body: unknown,
    who: {
      readonly peer?: { readonly remoteAddress: string };
      readonly headers?: Readonly<Record<string, string>>;
      /** The request's address as the worker sees it (from the Host header, as serve.ts builds it). */
      readonly url?: string;
    } = {},
  ) => {
    const response = await app.request(
      who.url ?? "/v1/apply",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...who.headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      who.peer ?? THIS_MACHINE,
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
}

const DRAFT = { name: "listings", questions: { is_scam: { type: "noul" } } };

describe("POST /v1/apply", () => {
  it("is a reviewer's alone: no session elsewhere, and a project API key, are refused", async () => {
    const t = fileDoor();
    const call = rig(t.door);
    for (const headers of [{}, { authorization: KEY }]) {
      const response = await call({ source: DRAFT }, { peer: ELSEWHERE, headers });
      expect(response).toMatchObject({ status: 401, json: { error: { code: "sign-in" } } });
    }
    expect(t.calls).toEqual([]);
  });

  it("takes only a JSON body declared as such, and never a page of another site", async () => {
    const t = fileDoor();
    const call = rig(t.door);
    // A form or text/plain body is what a page on another site can send without asking first.
    const plain = await call(JSON.stringify({ source: DRAFT }), {
      headers: { "content-type": "text/plain" },
    });
    expect(plain).toMatchObject({ status: 415, json: { error: { code: "json_only" } } });
    // A signed-in reviewer's browser carries the cookie to any page's request: the site decides.
    for (const headers of [
      { cookie: MAYA, origin: "https://evil.example" },
      { cookie: MAYA, "sec-fetch-site": "cross-site" },
      { cookie: MAYA, "sec-fetch-site": "same-site" },
    ]) {
      const response = await call({ source: DRAFT }, { peer: ELSEWHERE, headers });
      expect(response).toMatchObject({ status: 403, json: { error: { code: "cross_origin" } } });
    }
    expect(t.calls).toEqual([]);
    // The studio's own page, or a program that sends neither header, is let through.
    const own = await call(
      { source: DRAFT },
      {
        peer: ELSEWHERE,
        headers: { cookie: MAYA, origin: "http://localhost", "sec-fetch-site": "same-origin" },
      },
    );
    expect(own.status).toBe(200);
  });

  it("takes the studio's own page behind a reverse proxy that rewrites Host", async () => {
    const t = fileDoor();
    const call = rig(t.door);
    // nginx's default: the worker sees its own address as Host, while the page's Origin is the
    // public one. The browser computed Sec-Fetch-Site against the public address, so it decides.
    const proxied = await call(
      { source: DRAFT },
      {
        url: "http://127.0.0.1:4040/v1/apply",
        peer: ELSEWHERE,
        headers: {
          cookie: MAYA,
          host: "127.0.0.1:4040",
          origin: "https://studio.example.com",
          "sec-fetch-site": "same-origin",
        },
      },
    );
    expect(proxied.status).toBe(200);
    // The same Origin with no Sec-Fetch-Site (an older browser) is still held to the Host.
    const old = await call(
      { source: DRAFT },
      {
        url: "http://127.0.0.1:4040/v1/apply",
        peer: ELSEWHERE,
        headers: { cookie: MAYA, host: "127.0.0.1:4040", origin: "https://studio.example.com" },
      },
    );
    expect(old).toMatchObject({ status: 403, json: { error: { code: "cross_origin" } } });
  });

  it("answers the diff and its plan without confirm, and writes nothing", async () => {
    const t = fileDoor();
    const response = await rig(t.door)({ source: DRAFT });

    expect(response).toEqual({
      status: 200,
      json: {
        written: false,
        path: "facetdb.config.ts",
        diff: DIFF,
        changed: true,
        plan: "plan-1",
        uncommitted: null,
        dropsOwnText: false,
        warnings: [],
      },
    });
    expect(t.calls).toEqual([{ kind: "diff", draft: { source: DRAFT } }]);
  });

  it("passes what git says of the file, and whether lines of the person's own go, to the studio", async () => {
    const uncommitted = {
      state: "ignored",
      message: "facetdb.config.ts is ignored by git, so git keeps no copy of it",
      fix: 'apply again with force ("force": true) to replace it',
    } as const;
    const t = fileDoor({ diff: { ...PLANNED, uncommitted, dropsOwnText: true } });
    const response = await rig(t.door)({ source: DRAFT });

    expect(response).toMatchObject({
      status: 200,
      json: { written: false, uncommitted, dropsOwnText: true },
    });
  });

  it("writes on confirm with the plan, and answers the reload", async () => {
    const t = fileDoor();
    const response = await rig(t.door)({ source: DRAFT, confirm: "plan-1" });

    expect(response).toEqual({
      status: 200,
      json: {
        written: true,
        path: "facetdb.config.ts",
        diff: DIFF,
        reload: {
          loaded: true,
          sources: [{ source: "listings", outcome: "restarted", version: 2, message: "restarts" }],
          notes: [],
        },
      },
    });
    expect(t.calls).toEqual([
      { kind: "apply", draft: { source: DRAFT }, options: { plan: "plan-1", force: false } },
    ]);
    await rig(t.door)({ source: DRAFT, confirm: "plan-1", force: true });
    expect(t.calls.at(-1)?.options).toEqual({ plan: "plan-1", force: true });
  });

  it.each([
    [{ kind: "stale" } as const, 409, "plan_changed"],
    [
      {
        kind: "reverted",
        message: "facetdb.config.ts was written, but it does not load, so it was put back",
        fix: "fix facetdb.config.ts by hand so it loads, then apply again",
      } as const,
      409,
      "apply_reverted",
    ],
    [
      {
        kind: "uncommitted",
        state: "modified",
        message:
          "facetdb.config.ts has changes git has not committed, and Apply would replace them",
        fix: 'commit them, or apply again with force ("force": true) to replace them',
      } as const,
      409,
      "uncommitted_changes",
    ],
    [
      { kind: "invalid", issues: [{ path: "sources[0].thresholds", message: "no" }] } as const,
      400,
      "invalid_draft",
    ],
    [
      {
        kind: "unreadable",
        message: "facetdb.config.ts is a link",
        fix: "make it a file",
      } as const,
      409,
      "config_unreadable",
    ],
  ])("maps the door's %o to %i %s, nothing written", async (outcome, status, code) => {
    const t = fileDoor({ apply: outcome });
    const response = await rig(t.door)({ source: DRAFT, confirm: "plan-1" });
    expect(response).toMatchObject({
      status,
      json: { error: { code, message: expect.any(String), fix: expect.any(String) } },
    });
  });

  it("says why a confirm wrote nothing when the draft changes nothing", async () => {
    const t = fileDoor({ apply: { kind: "unchanged", path: "facetdb.config.ts" } });
    expect(await rig(t.door)({ source: DRAFT, confirm: "plan-1" })).toEqual({
      status: 200,
      json: { written: false, path: "facetdb.config.ts", changed: false },
    });
  });

  it("says a worker without the file's door does not write it, and refuses a body of another shape", async () => {
    const call = rig(undefined);
    expect(await call({ source: DRAFT })).toMatchObject({
      status: 409,
      json: { error: { code: "apply_unavailable" } },
    });
    const t = fileDoor();
    const shaped = await rig(t.door)({ source: DRAFT, confirm: "plan-1", overwrite: true });
    expect(shaped).toMatchObject({ status: 400, json: { error: { code: "invalid_request" } } });
    expect(t.calls).toEqual([]);
  });

  it("carries the project's spending settings as a draft of their own, null removing the cap", async () => {
    const t = fileDoor();
    const call = rig(t.door);
    expect(
      (await call({ project: { spendingCap: 2_000_000, onCapReached: "continue" } })).status,
    ).toBe(200);
    expect(
      (await call({ project: { spendingCap: null }, confirm: "plan-1", force: true })).status,
    ).toBe(200);
    expect(t.calls).toEqual([
      {
        kind: "diff",
        draft: { project: { spendingCap: 2_000_000, onCapReached: "continue" } },
      },
      {
        kind: "apply",
        draft: { project: { spendingCap: null } },
        options: { plan: "plan-1", force: true },
      },
    ]);
  });

  it("refuses a body with both drafts, with neither, and a project key a draft does not change", async () => {
    const t = fileDoor();
    const call = rig(t.door);
    const both = await call({ source: DRAFT, project: { spendingCap: 1000 } });
    expect(both).toMatchObject({ status: 400, json: { error: { code: "invalid_request" } } });
    expect(JSON.stringify(both.json)).toContain("both");
    const neither = await call({ confirm: "plan-1" });
    expect(neither).toMatchObject({ status: 400, json: { error: { code: "invalid_request" } } });
    expect(JSON.stringify(neither.json)).toContain("no draft");
    // modelUrl decides where every record's state is sent: the operator's, never a draft's.
    for (const project of [
      { modelUrl: "https://elsewhere.example" },
      { alerts: { channels: ["slack:#x"] } },
      { spendingCap: 0 },
      { spendingCap: 1.5 },
      { onCapReached: "stop" },
    ]) {
      const response = await call({ project });
      expect(response).toMatchObject({ status: 400, json: { error: { code: "invalid_request" } } });
    }
    expect(t.calls).toEqual([]);
  });
});
