import {
  type ApiClient,
  ApiError,
  type Home,
  type Project,
  type ReviewQueue,
} from "../api/index.ts";

/**
 * The fake API client every studio test passes as `StudioDeps.api`: each method answers from a
 * sample shaped as the worker answers (the mockups' marketplace project), or from the answer a test
 * gives it, and every call is noted by name. A page adds its methods here with a sample of their
 * own; a method a test did not expect to be called can answer `unexpected(name)`.
 */

export const SAMPLE_PROJECT: Project = { project: "marketplace", reviewer: "os:alex" };

export const SAMPLE_QUEUE: ReviewQueue = {
  count: 37,
  oldestSince: "2026-11-05T13:56:00.000Z",
  oldestWaitMs: 14 * 60_000,
  cards: [
    {
      source: "listings",
      key: "L-2207",
      stateHash: "h-2207",
      since: "2026-11-05T13:56:00.000Z",
      skipped: false,
      open: [{ name: "is_scam", figure: 0.58 }],
    },
  ],
};

export const SAMPLE_HOME: Home = {
  health: {
    status: "running",
    words: "Running",
    heartbeatAgeMs: 2_000,
    checks: [
      { name: "worker", status: "ok", words: "Worker beating, 2 s ago" },
      { name: "model", status: "ok", words: "Model healthy" },
      { name: "sources", status: "ok", words: "Three sources, logins as installed" },
    ],
    sources: [
      { name: "listings", verdict: "healthy", words: "Reachable, login as installed." },
      { name: "support_messages", verdict: "healthy", words: "Reachable, login as installed." },
      { name: "profiles", verdict: "healthy", words: "Reachable, login as installed." },
    ],
  },
  answered: {
    today: 12_480,
    yesterday: 20_100,
    fraction: 0.621,
    words: { figure: "12,480", sub: "62% of yesterday's 20,100." },
  },
  queue: {
    waiting: 37,
    oldestWaitMs: 14 * 60_000,
    decidedToday: 212,
    reviewersToday: 3,
    words: { figure: "37", sub: "Oldest 14 minutes. Three reviewers decided 212 today." },
  },
  spending: {
    status: "ok",
    month: "2026-11",
    dollars: 3.2,
    cap: { inputTokens: 25_000_000, dollars: 25 },
    fraction: 0.128,
    words: { figure: "$3.20", sub: "13% of the $25 monthly cap. The project pauses at 100%." },
  },
  alerts: [
    {
      at: "2026-11-05T14:10:00.000Z",
      phase: "raised",
      severity: "information",
      badge: "Information",
      title: "Backfill finished",
      words:
        "listings: 50,000 records in 41 minutes, newest first, for $1.20 of model usage. Every page was settled.",
      link: "https://docs.facetdb.dev/fix/backfill",
    },
    {
      at: "2026-11-04T23:09:00.000Z",
      phase: "resolved",
      severity: "warning",
      badge: "Resolved",
      title: "Model failing",
      words:
        "support_messages: 6% of calls failed over 5 minutes. FacetDB retried and held 12 records; all were answered.",
      link: "https://docs.facetdb.dev/fix/worker",
    },
  ],
};

/** What the worker answers a browser on another machine with no session. */
export function signInRequired(): ApiError {
  return new ApiError(
    401,
    "sign-in",
    "This request is not signed in.",
    'Sign in with POST /v1/session and a body of {"name", "password"}.',
  );
}

/** A method this test did not expect the studio to call. */
export function unexpected(name: string): () => Promise<never> {
  return () => Promise.reject(new Error(`this test expected no call to ${name}`));
}

export type FakeApi = ApiClient & { readonly calls: readonly string[] };

export function fakeApi(answers: Partial<ApiClient> = {}): FakeApi {
  const calls: string[] = [];
  const answer: ApiClient = {
    project: () => Promise.resolve(SAMPLE_PROJECT),
    reviewQueue: () => Promise.resolve(SAMPLE_QUEUE),
    home: () => Promise.resolve(SAMPLE_HOME),
    signIn: (name) => Promise.resolve({ reviewer: name, expiresAt: "2026-11-06T02:00:00.000Z" }),
    signOut: () => Promise.resolve(),
    ...answers,
  };
  return {
    calls,
    project: () => {
      calls.push("project");
      return answer.project();
    },
    reviewQueue: (options) => {
      calls.push("reviewQueue");
      return answer.reviewQueue(options);
    },
    home: () => {
      calls.push("home");
      return answer.home();
    },
    signIn: (name, password) => {
      calls.push(`signIn ${name}`);
      return answer.signIn(name, password);
    },
    signOut: () => {
      calls.push("signOut");
      return answer.signOut();
    },
  };
}
