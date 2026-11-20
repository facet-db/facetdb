import { describe, expect, it } from "vitest";
import { createApp, type StudioAccess } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import { openStudioBuild, type StudioBuild, type StudioFiles } from "./build.ts";

/**
 * The built studio on the HTTP surface, over a handwritten door: a map of the build's files by
 * path, which records every read. Each rule of serving it is a test: only the build's own files by
 * plain names, GET and HEAD only, content types with nosniff, hashed assets cached and the page
 * not, index.html for the app's routes and nothing else, nothing under /v1, public files and
 * reviewer-only data. Where the files really are (a link out of the directory) is the CLI's disk
 * door's rule, proven in packages/facetdb/src/cli/studio-files.test.ts.
 */

const PROJECT = "marketplace";
const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };

const INDEX = '<!doctype html><script type="module" src="/assets/index-a1b2c3.js"></script>';
const ROUTES = {
  routes: [
    "/",
    "/sources",
    "/sources/new",
    "/questions",
    "/review",
    "/decisions",
    "/decisions/$source/$key",
    "/plugins",
    "/alerts",
    "/settings",
    "/sign-in",
  ],
};

const encode = (text: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(text);

/** A build as a map of path to text, every read noted; what is not in the map is not there. */
function fakeFiles(files: Readonly<Record<string, string>>) {
  const reads: string[] = [];
  const door: StudioFiles = {
    read: (names) => {
      const path = names.join("/");
      reads.push(path);
      const text = files[path];
      return Promise.resolve(text === undefined ? undefined : encode(text));
    },
  };
  return { door, reads };
}

const BUILD_FILES = {
  "index.html": INDEX,
  "routes.json": JSON.stringify(ROUTES),
  "assets/index-a1b2c3.js": "console.log('studio')",
  "assets/index-d4e5f6.css": ":root{}",
  "assets/schibsted-grotesk-variable-0a1b2c.woff2": "wOF2",
  "favicon.svg": "<svg/>",
  "notes.unknown": "a file of a type the build never holds",
};

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: () => Promise.resolve(undefined),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
};

const NO_CONFIG: ConfigService = {
  json: () => {
    throw new Error("these tests read no config");
  },
  validate: () => {
    throw new Error("these tests validate no draft");
  },
  preview: () => Promise.reject(new Error("these tests preview nothing")),
  test: () => Promise.reject(new Error("these tests test nothing")),
  diff: () => Promise.reject(new Error("these tests apply nothing")),
  apply: () => Promise.reject(new Error("these tests apply nothing")),
};

/** This machine is the OS user; anyone else must sign in. */
const studio: StudioAccess = {
  sessions: {
    signIn: () => Promise.reject(new Error("these tests sign nobody in")),
    reviewerFor: ({ local }) =>
      Promise.resolve(
        local ? { kind: "reviewer", name: "os:alex" } : { kind: "sign-in", why: "no-cookie" },
      ),
  },
  reviewers: {
    list: () => Promise.resolve([]),
    add: () => Promise.reject(new Error("these tests add no reviewer")),
  },
  projectId: PROJECT,
};

function appWith(studioApp: StudioBuild | undefined) {
  return createApp({
    keys,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: {
      runs: { list: () => Promise.reject(new Error("these tests read no runs")) },
      decisions: {
        search: () => Promise.reject(new Error("these tests search no decisions")),
        why: () => Promise.reject(new Error("these tests explain no record")),
      },
      home: { home: () => Promise.reject(new Error("these tests read no home")) },
      sources: { sources: () => Promise.reject(new Error("these tests read no sources")) },
      alerts: { alerts: () => Promise.reject(new Error("these tests read no alerts")) },
      access: { access: () => Promise.reject(new Error("these tests read no studio access")) },
    },
    studio,
    review: NO_REVIEW,
    ...(studioApp === undefined ? {} : { studioApp }),
    newRequestId: () => "req-1",
  });
}

async function rig(files: Readonly<Record<string, string>> = BUILD_FILES) {
  const fake = fakeFiles(files);
  const build = await openStudioBuild(fake.door);
  if (build === undefined) {
    throw new Error("the test build has index.html and routes.json");
  }
  fake.reads.length = 0;
  const app = appWith(build);
  const request = (path: string, init: RequestInit = {}, peer = ELSEWHERE) =>
    app.request(path, init, peer);
  return { app, reads: fake.reads, request };
}

/** The policy of every file but the page. */
const FILE_POLICY = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

const NOT_FOUND = {
  error: {
    code: "not_found",
    message: "There is no such endpoint.",
    fix: "See the API reference for the endpoints under /v1.",
  },
};

describe("a studio build", () => {
  it("is a directory with index.html and the routes.json the app's build writes", async () => {
    const built = await openStudioBuild(fakeFiles(BUILD_FILES).door);
    expect(built?.routes).toContainEqual(["decisions", "$source", "$key"]);
    expect(built?.routes).toContainEqual([]);
  });

  it("is not there without index.html, without routes.json, or with a routes.json the app never writes", async () => {
    const { "index.html": _index, ...noIndex } = BUILD_FILES;
    const { "routes.json": _routes, ...noRoutes } = BUILD_FILES;
    expect(await openStudioBuild(fakeFiles(noIndex).door)).toBeUndefined();
    expect(await openStudioBuild(fakeFiles(noRoutes).door)).toBeUndefined();
    for (const routes of ["not json", "{}", '{"routes": []}', '{"routes": ["/../etc"]}']) {
      expect(
        await openStudioBuild(fakeFiles({ ...BUILD_FILES, "routes.json": routes }).door),
      ).toBeUndefined();
    }
  });
});

describe("the app's pages", () => {
  it("answers index.html for every route the build lists, to anyone, without a session", async () => {
    const t = await rig();
    for (const path of [
      "/",
      "/review",
      "/review/",
      "/sources/new",
      "/sign-in",
      "/decisions/listings/T-1042",
      "/decisions/listings/maya%40example.com",
    ]) {
      const response = await t.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(await response.text()).toBe(INDEX);
    }
  });

  it("sends the page uncached, unsniffed, unframed and under a policy of its own origin", async () => {
    const t = await rig();
    const response = await t.request("/questions");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).not.toContain("unsafe-eval");
  });

  it("answers a path the app does not route with the API's 404, never the page", async () => {
    const t = await rig();
    for (const path of [
      "/reviews",
      "/review/extra",
      "/decisions/listings",
      "/decisions/listings/key/more",
      "/settings//",
    ]) {
      const response = await t.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual(NOT_FOUND);
    }
  });
});

describe("the build's files", () => {
  it("serves a hashed asset with its type, nosniff, and a year's cache", async () => {
    const t = await rig();
    const script = await t.request("/assets/index-a1b2c3.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(script.headers.get("x-content-type-options")).toBe("nosniff");
    expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(script.headers.get("content-security-policy")).toBe(FILE_POLICY);
    expect(await script.text()).toBe("console.log('studio')");
    const style = await t.request("/assets/index-d4e5f6.css");
    expect(style.headers.get("content-type")).toBe("text/css; charset=utf-8");
    const font = await t.request("/assets/schibsted-grotesk-variable-0a1b2c.woff2");
    expect(font.headers.get("content-type")).toBe("font/woff2");
  });

  it("sends every file but the page a policy that runs and loads nothing, so an SVG opened alone is inert", async () => {
    const t = await rig();
    for (const path of ["/favicon.svg", "/assets/index-a1b2c3.js", "/assets/index-d4e5f6.css"]) {
      const response = await t.request(path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-security-policy"), path).toBe(FILE_POLICY);
      expect(response.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
    for (const path of ["/", "/index.html"]) {
      const page = await t.request(path);
      const policy = page.headers.get("content-security-policy") ?? "";
      expect(policy, path).toContain("script-src 'self'");
      expect(policy, path).not.toContain("sandbox");
    }
  });

  it("serves an unhashed file with no long cache", async () => {
    const t = await rig();
    const icon = await t.request("/favicon.svg");
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(icon.headers.get("cache-control")).toBe("no-cache");
  });

  it("answers HEAD with the headers and no body", async () => {
    const t = await rig();
    const response = await t.request("/assets/index-a1b2c3.js", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(response.headers.get("content-length")).toBe(String("console.log('studio')".length));
    expect(await response.text()).toBe("");
  });

  it("answers no other method", async () => {
    const t = await rig();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      for (const path of ["/", "/review", "/assets/index-a1b2c3.js"]) {
        const response = await t.request(path, { method });
        expect(response.status, `${method} ${path}`).toBe(404);
        expect(await response.json()).toEqual(NOT_FOUND);
      }
    }
    expect(t.reads).toEqual([]);
  });

  it("reads nothing for a path that is not plain names: no traversal, no dotfile, no encoded separator", async () => {
    const t = await rig();
    for (const path of [
      "/.env",
      "/assets/.hidden.js",
      "/assets%2findex-a1b2c3.js",
      "/assets%5cindex-a1b2c3.js",
      "/assets/..%2f..%2fsecret.json",
      "/%2fetc/passwd.txt",
      "/assets/index%00.js",
      "/assets/%E0%A4%A.js",
      "/C:%5cWindows%5cwin.ini",
    ]) {
      const response = await t.request(path);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual(NOT_FOUND);
    }
    expect(t.reads).toEqual([]);
  });

  it("resolves dot segments before it looks, so a climb out lands inside or on nothing", async () => {
    const t = await rig();
    const climbed = await t.request("/assets/../../../index.html");
    expect(climbed.status).toBe(200);
    // Encoded dots are dot segments too: this asks the build for its own etc/passwd.txt.
    const encoded = await t.request("/assets/%2e%2e/%2e%2e/etc/passwd.txt");
    expect(encoded.status).toBe(404);
    expect(t.reads).toEqual(["index.html", "etc/passwd.txt"]);
  });

  it("serves no file of a type the build does not hold, and nothing the build lacks", async () => {
    const t = await rig();
    expect((await t.request("/notes.unknown")).status).toBe(404);
    expect((await t.request("/assets/missing-000000.js")).status).toBe(404);
    expect(t.reads).toEqual(["assets/missing-000000.js"]);
  });
});

describe("the API beside the app", () => {
  it("keeps an unknown /v1 path the API's JSON 404, never the page, on this machine", async () => {
    const t = await rig();
    for (const path of ["/v1", "/v1/", "/v1/nope", "/v1/review", "/v1/index.html", "/v1/session"]) {
      const response = await t.request(path, {}, THIS_MACHINE);
      expect(response.status, path).toBe(404);
      expect(response.headers.get("content-type")).toContain("application/json");
      expect(await response.json()).toEqual(NOT_FOUND);
    }
    expect(t.reads).toEqual([]);
  });

  it("keeps the studio's data behind the reviewer while the page is public", async () => {
    const t = await rig();
    expect((await t.request("/review")).status).toBe(200);
    const data = await t.request("/v1/reviewers");
    expect(data.status).toBe(401);
    expect(await data.json()).toMatchObject({ error: { code: "sign-in" } });
    expect((await t.request("/v1/nope")).status).toBe(401);
  });

  it("names the project and the reviewer for the rail, to a reviewer only", async () => {
    const t = await rig();
    const here = await t.request("/v1/project", {}, THIS_MACHINE);
    expect(here.status).toBe(200);
    expect(await here.json()).toEqual({ project: PROJECT, reviewer: "os:alex" });
    expect((await t.request("/v1/project")).status).toBe(401);
  });

  it("serves no file at all without a build", async () => {
    const app = appWith(undefined);
    for (const path of ["/", "/review", "/assets/index-a1b2c3.js"]) {
      const response = await app.request(path, {}, THIS_MACHINE);
      expect(response.status, path).toBe(404);
      expect(await response.json()).toEqual(NOT_FOUND);
    }
  });
});
