import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import { SESSION_COOKIE, type Sessions } from "../auth/sessions.ts";
import type { CheckService } from "../check/service.ts";
import type { DataServices } from "../data/routes.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import { type ConfigFileDoor, createConfigService, type ReloadSummary } from "./service.ts";

/**
 * `POST /v1/reload`: Check again on the Questions page. Guarded as Apply is (a reviewer, the
 * studio's own page or a program, a JSON request), no body read, the CLI's file door's reload and
 * its summary back; refused where the worker writes no config file (`facetdb dev`, `--once`).
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

const SWITCHED: ReloadSummary = {
  loaded: true,
  sources: [
    {
      source: "listings",
      outcome: "restarted",
      version: 4,
      message:
        "the columns of the question is_vehicle are in its database and the worker login may write them: it finishes the batch in hand, then answers with version 4; nothing already answered is asked again.",
    },
  ],
  notes: [],
};

/** The CLI's door as a recorder: how many reloads were asked for. */
function fileDoor(summary: ReloadSummary = SWITCHED) {
  const calls: string[] = [];
  const door: ConfigFileDoor = {
    reload: () => {
      calls.push("reload");
      return Promise.resolve(summary);
    },
    diff: () => Promise.reject(new Error("Check again makes no diff")),
    apply: () => Promise.reject(new Error("Check again writes nothing")),
  };
  return { calls, door };
}

function rig(file: ConfigFileDoor | undefined, projectId = PROJECT) {
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: createConfigService({
      config: {
        projectId,
        json: () => ({}),
        validate: () => {
          throw new Error("Check again judges no draft");
        },
        pending: () => [],
        history: {
          sources: () => {
            throw new Error("Check again reads no version history");
          },
          read: () => Promise.reject(new Error("Check again reads no version history")),
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
      },
      projectId: PROJECT,
    },
    newRequestId: () => "req-1",
  });
  return async (
    who: {
      readonly peer?: { readonly remoteAddress: string };
      readonly headers?: Readonly<Record<string, string>>;
      readonly body?: string;
    } = {},
  ) => {
    const response = await app.request(
      "/v1/reload",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...who.headers },
        ...(who.body === undefined ? {} : { body: who.body }),
      },
      who.peer ?? THIS_MACHINE,
    );
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  };
}

describe("POST /v1/reload", () => {
  it("asks the worker for the reload and answers its summary, with no body", async () => {
    const t = fileDoor();
    const response = await rig(t.door)();

    expect(response).toEqual({ status: 200, json: SWITCHED });
    expect(t.calls).toEqual(["reload"]);
    // A body, if one is sent, is not read: `{}` from the studio is the same request.
    expect(await rig(t.door)({ body: "{}" })).toEqual({ status: 200, json: SWITCHED });
  });

  it("answers a file that does not load as the reload says it, a 200 with its words", async () => {
    const summary: ReloadSummary = {
      loaded: false,
      message: "facetdb.config.ts was written but does not load",
      fix: "Fix each line named in facetdb.config.ts, then apply again or restart facetdb worker.",
    };
    expect(await rig(fileDoor(summary).door)()).toEqual({ status: 200, json: summary });
  });

  it("is a reviewer's alone: no session elsewhere, and a project API key, are refused", async () => {
    const t = fileDoor();
    const call = rig(t.door);
    for (const headers of [{}, { authorization: KEY }]) {
      const response = await call({ peer: ELSEWHERE, headers });
      expect(response).toMatchObject({ status: 401, json: { error: { code: "sign-in" } } });
    }
    expect(t.calls).toEqual([]);
  });

  it("takes only a request declared as JSON, and never one from a page of another site", async () => {
    const t = fileDoor();
    const call = rig(t.door);
    const plain = await call({ headers: { "content-type": "text/plain" } });
    expect(plain).toMatchObject({ status: 415, json: { error: { code: "json_only" } } });
    for (const headers of [
      { cookie: MAYA, origin: "https://evil.example" },
      { cookie: MAYA, "sec-fetch-site": "cross-site" },
    ]) {
      const response = await call({ peer: ELSEWHERE, headers });
      expect(response).toMatchObject({
        status: 403,
        json: {
          error: {
            code: "cross_origin",
            message:
              "This request came from a page on another site, and Check again makes this worker reload facetdb.config.ts on this machine.",
          },
        },
      });
    }
    expect(t.calls).toEqual([]);
    // A signed-in reviewer on the studio's own page may ask, from another machine too.
    const own = await call({
      peer: ELSEWHERE,
      headers: { cookie: MAYA, origin: "http://localhost", "sec-fetch-site": "same-origin" },
    });
    expect(own).toEqual({ status: 200, json: SWITCHED });
  });

  it("says a worker without the file's door does not reload it", async () => {
    expect(await rig(undefined)()).toMatchObject({
      status: 409,
      json: {
        error: {
          code: "reload_unavailable",
          message:
            "This worker does not reload facetdb.config.ts: facetdb worker --once never does.",
          fix: expect.any(String),
        },
      },
    });
  });
});
