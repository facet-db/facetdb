import {
  type ApiClient,
  ApiError,
  type DecisionHistory,
  type DecisionsPage,
  type Home,
  type Project,
  type ReviewCard,
  type ReviewCardId,
  type ReviewQueue,
  type RunsPage,
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

/** The Review page's sample card (the mockup's): two open questions and one decided. */
export const SAMPLE_CARD: ReviewCard = {
  source: "support_messages",
  key: "5521",
  stateHash: "h-5521",
  state: {
    subject: "Charged twice",
    body: "I was charged twice for order 5521 and I want the second charge back today.",
    channel: "email",
    customer: '{"plan":"pro","orders":14,"since":"2024-03"}',
  },
  open: [
    {
      name: "urgency",
      type: "score",
      instructions: "How urgent is this message?",
      said: "high, 62% sure",
      figure: 0.62,
      top: "high",
      options: [
        { name: "low", probability: 0.07 },
        { name: "medium", probability: 0.31 },
        { name: "high", probability: 0.62 },
      ],
    },
    {
      name: "wants_refund",
      type: "noul",
      instructions: "Is the customer asking for their money back?",
      said: "84% likely yes",
      figure: 0.84,
      top: "yes",
      options: [
        { name: "yes", probability: 0.84 },
        { name: "no", probability: 0.16 },
      ],
    },
  ],
  decided: [
    {
      name: "team",
      type: "choice",
      instructions: "Which team should handle it?",
      value: "billing",
      said: "billing",
    },
  ],
  since: "2026-11-06T11:46:00.000Z",
  lockedUntil: "2026-11-06T12:10:00.000Z",
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

/*
 * The Decisions page and the why page: the mockups' marketplace log, shaped as the worker answers.
 */

export const SAMPLE_SOURCE_NAMES: readonly string[] = ["listings", "support_messages"];

export const SAMPLE_DECISIONS: DecisionsPage = {
  decisions: [
    {
      kind: "human",
      time: "2026-11-06T14:31:00.000Z",
      record_key: "48213",
      version: 3,
      question: "is_scam",
      value: "yes",
      decision: "yes",
      decided_by: "hailey",
      note: "gift-card payment, two-day-old seller",
    },
    {
      kind: "answer",
      time: "2026-11-06T14:14:00.000Z",
      record_key: "48213",
      version: 3,
      model: "jev-1.14.0",
      answers: {
        is_scam: { type: "noul", probability: 0.58, decision: "needs review" },
        category: {
          type: "choice",
          top: "electronics",
          probabilities: [0.95, 0.03, 0.02],
          decision: "electronics",
        },
      },
    },
    {
      kind: "answer",
      time: "2026-11-06T13:58:00.000Z",
      record_key: "48190",
      version: 3,
      model: "jev-1.14.0",
      answers: { is_scam: { type: "noul", probability: 0.02, decision: "no" } },
    },
  ],
  next: null,
};

/** The history of the mockup's record 48213, oldest first, as `facetdb explain` words it. */
export function sampleHistory(source: string, key: string): DecisionHistory {
  return {
    source,
    key,
    entries: [
      {
        kind: "answer",
        at: "2026-11-03T10:02:00.000Z",
        model: "jev-1.14.0",
        version: 2,
        answers: [
          {
            question: "is_scam",
            wording: "Is this listing a scam?",
            said: "27% likely yes",
            decision: "no",
          },
          {
            question: "category",
            wording: "Which category is this listing?",
            said: "electronics, 93% sure",
            decision: "electronics",
          },
        ],
      },
      {
        kind: "answer",
        at: "2026-11-06T14:14:00.000Z",
        model: "jev-1.14.0",
        version: 3,
        answers: [
          {
            question: "is_scam",
            wording: "Is this listing a scam?",
            said: "58% likely yes",
            decision: "needs review",
          },
        ],
      },
      {
        kind: "human",
        at: "2026-11-06T14:31:00.000Z",
        version: 3,
        question: "is_scam",
        wording: "Is this listing a scam?",
        decided: "yes",
        reviewer: "hailey",
        note: "gift-card payment, two-day-old seller",
      },
    ],
  };
}

export const SAMPLE_RUNS: RunsPage = {
  runs: [
    {
      source: "listings",
      kind: "pass",
      startedAt: "2026-11-06T14:14:02.000Z",
      endedAt: "2026-11-06T14:14:04.000Z",
      claimed: 20,
      answered: 18,
      toReview: 2,
      errors: 0,
      discarded: 0,
      tokens: 14_900,
    },
    {
      source: "listings",
      kind: "backfill",
      startedAt: "2026-11-06T14:10:11.000Z",
      endedAt: "2026-11-06T14:10:22.400Z",
      claimed: 500,
      answered: 497,
      toReview: 3,
      errors: 0,
      discarded: 0,
      tokens: 361_000,
    },
  ],
  page: 1,
  perPage: 50,
  more: false,
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

/**
 * `calls` notes each call by name; `refs` notes the card each review call was sent for, as the
 * request names it (`reviewDecide support_messages/5521@h-5521`), so a test holds the page to
 * sending the state hash of the card it showed.
 */
export type FakeApi = ApiClient & {
  readonly calls: readonly string[];
  readonly refs: readonly string[];
};

/** A filter in the call log: ` source=listings below=0.6`, nothing for no filter. */
function filterWords(filter: Parameters<ApiClient["reviewOpen"]>[0]): string {
  return Object.entries(filter ?? {})
    .map(([name, value]) => ` ${name}=${String(value)}`)
    .join("");
}

export function fakeApi(answers: Partial<ApiClient> = {}): FakeApi {
  const calls: string[] = [];
  const refs: string[] = [];
  const noted = (name: string, card: ReviewCardId) => {
    refs.push(`${name} ${card.source}/${card.key}@${card.stateHash}`);
  };
  const answer: ApiClient = {
    project: () => Promise.resolve(SAMPLE_PROJECT),
    reviewQueue: () => Promise.resolve(SAMPLE_QUEUE),
    reviewOpen: () => Promise.resolve({ card: SAMPLE_CARD }),
    reviewRenew: () => Promise.resolve({ lockedUntil: "2026-11-06T12:11:00.000Z" }),
    reviewDecide: () => Promise.resolve({ status: "done", open: [], failedActions: [] }),
    reviewSkip: () => Promise.resolve(),
    reviewRelease: () => Promise.resolve(),
    reviewUndo: () =>
      Promise.resolve({ status: "needs_review", card: SAMPLE_CARD, failedActions: [] }),
    home: () => Promise.resolve(SAMPLE_HOME),
    signIn: (name) => Promise.resolve({ reviewer: name, expiresAt: "2026-11-06T02:00:00.000Z" }),
    signOut: () => Promise.resolve(),
    sourceNames: () => Promise.resolve(SAMPLE_SOURCE_NAMES),
    decisions: () => Promise.resolve(SAMPLE_DECISIONS),
    decisionHistory: (source, key) => Promise.resolve(sampleHistory(source, key)),
    runs: () => Promise.resolve(SAMPLE_RUNS),
    ...answers,
  };
  return {
    calls,
    refs,
    project: () => {
      calls.push("project");
      return answer.project();
    },
    reviewQueue: (options) => {
      calls.push("reviewQueue");
      return answer.reviewQueue(options);
    },
    reviewOpen: (filter) => {
      calls.push(`reviewOpen${filterWords(filter)}`);
      return answer.reviewOpen(filter);
    },
    reviewRenew: (card) => {
      calls.push(`reviewRenew ${card.key}`);
      noted("reviewRenew", card);
      return answer.reviewRenew(card);
    },
    reviewDecide: (card, decision) => {
      const note = decision.note === undefined ? "" : ` note=${decision.note}`;
      calls.push(`reviewDecide ${card.key} ${decision.question}=${String(decision.value)}${note}`);
      noted("reviewDecide", card);
      return answer.reviewDecide(card, decision);
    },
    reviewSkip: (card) => {
      calls.push(`reviewSkip ${card.key}`);
      noted("reviewSkip", card);
      return answer.reviewSkip(card);
    },
    reviewRelease: (card) => {
      calls.push(`reviewRelease ${card.key}`);
      noted("reviewRelease", card);
      return answer.reviewRelease(card);
    },
    reviewUndo: () => {
      calls.push("reviewUndo");
      return answer.reviewUndo();
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
    // The arguments ride in the note as JSON, so a test reads what the page asked for.
    sourceNames: () => {
      calls.push("sourceNames");
      return answer.sourceNames();
    },
    decisions: (filters, cursor) => {
      calls.push(`decisions ${JSON.stringify({ ...filters, cursor })}`);
      return answer.decisions(filters, cursor);
    },
    decisionHistory: (source, key) => {
      calls.push(`decisionHistory ${JSON.stringify({ source, key })}`);
      return answer.decisionHistory(source, key);
    },
    runs: (options) => {
      calls.push(`runs ${JSON.stringify(options)}`);
      return answer.runs(options);
    },
  };
}
