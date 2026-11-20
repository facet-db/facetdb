import type { RunsQuery, RunsReader, StoredRun } from "@facetdb/postgres";
import { describe, expect, it } from "vitest";
import { createApp, type StudioAccess } from "../app.ts";
import type { ApiKeys } from "../auth/api-keys.ts";
import type { CheckService } from "../check/service.ts";
import type { ConfigService } from "../config/service.ts";
import { NO_REVIEW } from "../review/no-review.ts";
import { createRunsService, RUNS_PER_PAGE } from "./runs.ts";

/**
 * `GET /v1/runs` on a handwritten reader: the key's project, one source or all, 50 a page from page
 * 1, and the query's problems in the stable error shape. The store's order and project scoping are
 * proven on PGlite (packages/postgres/src/store/runs.test.ts).
 */

const PROJECT = "listings-app";
const KEY = "Bearer fdb_listings";
const START = Date.UTC(2026, 10, 5, 14, 0, 0);

const keys: ApiKeys = {
  create: () => Promise.reject(new Error("the routes never create a key")),
  verify: (header) =>
    Promise.resolve(header === KEY ? { id: "key-1", projectId: PROJECT } : undefined),
  revoke: () => Promise.reject(new Error("the routes never revoke a key")),
};

const NO_CHECK: CheckService = {
  check: () => Promise.reject(new Error("these tests make no check call")),
};

const THIS_MACHINE = { remoteAddress: "127.0.0.1" };
const ELSEWHERE = { remoteAddress: "203.0.113.7" };

/** The studio as the reviewer middleware sees it: this machine is the OS user, anyone else signs in. */
function localStudio(projectId: string): StudioAccess {
  return {
    sessions: {
      signIn: () => Promise.reject(new Error("these tests sign nobody in")),
      reviewerFor: ({ local }) =>
        Promise.resolve(
          local ? { kind: "reviewer", name: "os:alex" } : { kind: "sign-in", why: "no-cookie" },
        ),
    },
    reviewers: {
      list: () => Promise.reject(new Error("these tests list no reviewers")),
      add: () => Promise.reject(new Error("these tests add no reviewer")),
    },
    projectId,
  };
}

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

/** A reader over `total` runs of `listings`, newest first a second apart, noting every query. */
class FakeReader implements RunsReader {
  readonly queries: RunsQuery[] = [];
  readonly #total: number;

  constructor(total: number) {
    this.#total = total;
  }

  page(query: RunsQuery): Promise<readonly StoredRun[]> {
    this.queries.push(query);
    const runs: StoredRun[] = [];
    for (let n = query.offset; n < Math.min(this.#total, query.offset + query.limit); n += 1) {
      runs.push({
        source: "listings",
        kind: n === 0 ? "backfill" : "pass",
        startedAt: new Date(START - n * 1_000),
        endedAt: new Date(START - n * 1_000 + 900),
        claimed: 20,
        answered: 18,
        toReview: 2,
        errors: 0,
        discarded: 0,
        tokens: 14_900,
      });
    }
    return Promise.resolve(runs);
  }
}

function rig(total: number) {
  const reader = new FakeReader(total);
  const app = createApp({
    keys,
    check: NO_CHECK,
    config: NO_CONFIG,
    data: {
      runs: createRunsService({ reader }),
      decisions: {
        search: () => Promise.reject(new Error("these tests search no decisions")),
        why: () => Promise.reject(new Error("these tests explain no record")),
      },
      home: { home: () => Promise.reject(new Error("these tests read no home")) },
      sources: { sources: () => Promise.reject(new Error("these tests read no sources")) },
    },
    studio: localStudio(PROJECT),
    review: NO_REVIEW,
    newRequestId: () => "req-1",
  });
  // The pages are the studio's: a call from this machine is the OS user's; `null` is a stranger
  // elsewhere with no session.
  const get = async (path: string, authorization: string | null = KEY) => {
    const response = await app.request(
      path,
      { headers: authorization === null ? {} : { authorization } },
      authorization === null ? ELSEWHERE : THIS_MACHINE,
    );
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { reader, get };
}

describe("GET /v1/runs", () => {
  it("answers the key's project's first page, newest first, with ISO times and the run's kind", async () => {
    const t = rig(3);

    const { status, body } = await t.get("/v1/runs");

    expect(status).toBe(200);
    expect(t.reader.queries).toEqual([
      { projectId: PROJECT, source: undefined, limit: RUNS_PER_PAGE + 1, offset: 0 },
    ]);
    expect(body).toEqual({
      runs: [0, 1, 2].map((n) => ({
        source: "listings",
        kind: n === 0 ? "backfill" : "pass",
        startedAt: new Date(START - n * 1_000).toISOString(),
        endedAt: new Date(START - n * 1_000 + 900).toISOString(),
        claimed: 20,
        answered: 18,
        toReview: 2,
        errors: 0,
        discarded: 0,
        tokens: 14_900,
      })),
      page: 1,
      perPage: 50,
      more: false,
    });
  });

  it("pages 50 at a time and says when an older page has runs", async () => {
    const t = rig(120);

    const first = await t.get("/v1/runs?source=listings");
    const third = await t.get("/v1/runs?source=listings&page=3");

    expect((first.body["runs"] as unknown[]).length).toBe(50);
    expect(first.body["more"]).toBe(true);
    expect((third.body["runs"] as unknown[]).length).toBe(20);
    expect(third.body["more"]).toBe(false);
    expect(t.reader.queries.map((query) => [query.source, query.offset])).toEqual([
      ["listings", 0],
      ["listings", 100],
    ]);
  });

  it("refuses a request without a valid key before reading anything", async () => {
    const t = rig(3);

    const { status, body } = await t.get("/v1/runs", null);

    expect(status).toBe(401);
    expect(body["error"]).toMatchObject({ code: "sign-in" });
    expect(t.reader.queries).toEqual([]);
  });

  it.each([
    ["/v1/runs?page=0", "page"],
    ["/v1/runs?page=two", "page"],
    ["/v1/runs?page=1.5", "page"],
    ["/v1/runs?source=Listings", "source"],
    ["/v1/runs?sources=listings", "sources"],
  ])("answers %s with a 400 naming %s, and the fix", async (path, field) => {
    const t = rig(3);

    const { status, body } = await t.get(path);

    expect(status).toBe(400);
    const error = body["error"] as { code: string; message: string; fix: string };
    expect(error.code).toBe("invalid_request");
    expect(error.message).toContain(field);
    expect(error.fix).toContain("?page=2");
    expect(t.reader.queries).toEqual([]);
  });
});
