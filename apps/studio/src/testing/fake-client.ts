import {
  type Alerts,
  type ApiClient,
  ApiError,
  type ApplyDiff,
  type ApplyWritten,
  type BackfillStatus,
  type DecisionHistory,
  type DecisionsPage,
  type DraftPreview,
  type DraftValidation,
  type Home,
  type Inspection,
  type Migrated,
  type MigratePlan,
  type Project,
  type ProjectConfig,
  type ReviewCard,
  type ReviewCardId,
  type ReviewerAccounts,
  type ReviewQueue,
  type RunsPage,
  type SetupAccess,
  type SetupInstalled,
  type SetupPlan,
  type SourceRow,
  type SpendingConfig,
  type StudioAccess,
  type TestEstimate,
  type TestResult,
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
    inputTokens: 3_200_000,
    dollars: 3.2,
    cap: { inputTokens: 25_000_000, dollars: 25, onCapReached: "pause" },
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

/*
 * The Alerts and Settings pages: the mockups' channels and events, two reviewer accounts, a studio
 * on this machine alone and the $25 cap. Times are built in the machine's zone, so the words a page
 * shows for them ("11:02 pm") are the same wherever a test runs.
 */

/** An instant of the machine's own calendar, as the worker sends one (ISO 8601). */
function local(month: number, day: number, hour: number, minute: number): string {
  return new Date(2026, month - 1, day, hour, minute).toISOString();
}

export const SAMPLE_ALERTS: Alerts = {
  channels: [
    { kind: "slack", name: "#ops" },
    { kind: "email", name: "ops@example.com" },
  ],
  events: [
    {
      at: local(11, 6, 11, 10),
      kind: "backfill_finished",
      severity: "information",
      title: "Backfill finished",
      what: "The backfill finished: 50000 records queued for the worker, 0 answered.",
      project: "marketplace",
      source: "listings",
      question: null,
      did: "Every page was settled; the cursor is cleared.",
      link: "https://docs.facetdb.dev/fix/backfill",
      standing: { phase: "raised" },
      raisedBeforeHistory: false,
      delivered: true,
    },
    {
      at: local(11, 5, 23, 2),
      kind: "model_failing",
      severity: "critical",
      title: "Model failing",
      what: "6 of 100 model calls failed in the last 5 minutes.",
      project: "marketplace",
      source: "support_messages",
      question: null,
      did: "Retrying with backoff; a record that cannot be answered is marked error and asked again.",
      link: "https://docs.facetdb.dev/fix/worker",
      standing: { phase: "resolved", at: local(11, 5, 23, 9) },
      raisedBeforeHistory: false,
      delivered: true,
    },
    {
      at: local(11, 2, 8, 15),
      kind: "worker_not_running",
      severity: "critical",
      title: "Worker not running",
      what: "The worker has sent no heartbeat for 2 minutes.",
      project: "marketplace",
      source: "all sources",
      question: null,
      did: "Records stay queued and are answered when the worker is back.",
      link: "https://docs.facetdb.dev/fix/worker",
      standing: { phase: "resolved", at: local(11, 2, 8, 21) },
      raisedBeforeHistory: false,
      delivered: true,
    },
    {
      at: local(10, 29, 16, 2),
      kind: "spending_80",
      severity: "warning",
      title: "Spending at 80% of the cap",
      what: "The month's usage reached 80% of the monthly cap.",
      project: "marketplace",
      source: "all sources",
      question: null,
      did: "Kept running; the cap pauses the project at 100%.",
      link: "/settings",
      standing: { phase: "raised" },
      raisedBeforeHistory: false,
      delivered: true,
    },
  ],
  fileChannelsDiffer: false,
  limit: 100,
  capped: false,
};

export const SAMPLE_ACCESS: StudioAccess = { host: "127.0.0.1", loopback: true, reviewers: 2 };

export const SAMPLE_REVIEWERS: ReviewerAccounts = [
  { name: "sam", createdAt: local(11, 3, 10, 0) },
  { name: "maya", createdAt: local(11, 4, 9, 30) },
];

/** $25 at $1 per million input tokens, pausing at the cap, as SAMPLE_HOME has it. */
export const SAMPLE_SPENDING_CONFIG: SpendingConfig = { tokens: 25_000_000, onCapReached: "pause" };

/*
 * The Questions page: the mockup's marketplace configuration with its version history, a draft
 * judged clean, a preview of six rows, a test and Apply, shaped as the worker answers.
 */

export const SAMPLE_PROJECT_CONFIG: ProjectConfig = {
  model: "jev-1.14.0",
  // Every loop runs the file; a test that needs a source waiting for migrate sets this list.
  pending: [],
  sources: [
    {
      name: "listings",
      read: ["title", "price"],
      questions: {
        is_scam: {
          type: "noul",
          instructions: "Is this listing likely a scam?",
          criteria: {
            true: "A price far below market, payment outside the platform, a seller a few days old, urgency.",
            false: "A plausible price, a seller with history, ordinary payment.",
          },
          stakes: "high",
        },
        category: {
          type: "choice",
          instructions: "Which category fits this listing?",
          options: [
            { name: "electronics", description: "phones, computers, consoles, cameras, audio" },
            { name: "furniture", description: "tables, sofas, shelves, desks, beds" },
            { name: "vehicles", description: "cars, motorbikes, scooters, parts" },
            { name: "clothing", description: "clothes, shoes, bags, accessories" },
            { name: "other", description: "anything that fits none of the above" },
          ],
          stakes: "low",
          storeProbabilities: false,
        },
      },
      thresholds: {},
    },
    {
      name: "support_messages",
      read: ["subject", "body"],
      questions: {
        urgency: {
          type: "score",
          instructions: "How urgent is this message?",
          levels: [{ name: "low" }, { name: "medium" }, { name: "high" }],
          stakes: "low",
        },
      },
      thresholds: { urgency: { confidenceAtLeast: 0.6 } },
    },
  ],
  versions: {
    listings: {
      inForce: 3,
      earlier: false,
      note: null,
      versions: [
        {
          version: 3,
          createdAt: "2026-11-02T09:40:00.000Z",
          changes: "The wording and the criteria of is_scam",
        },
        { version: 2, createdAt: "2026-11-01T15:10:00.000Z", changes: "category added" },
        { version: 1, createdAt: "2026-10-30T11:00:00.000Z", changes: "Created, with is_scam" },
      ],
    },
    support_messages: {
      inForce: 1,
      earlier: false,
      note: null,
      versions: [
        { version: 1, createdAt: "2026-11-01T15:10:00.000Z", changes: "Created, with urgency" },
      ],
    },
  },
};

export const SAMPLE_VALIDATION: DraftValidation = { valid: true, issues: [], warnings: [] };

/** A category's probabilities, its top option first in the mockup's option order. */
const categories = (top: number, at: number): number[] =>
  [0, 1, 2, 3, 4].map((index) => (index === at ? top : (1 - top) / 4));

/**
 * The newest listings answered at the sample's thresholds (is_scam high stakes: yes at 90%, no at
 * 10%; category low: 50% confidence): two rows decided, three to review, one left out by `where`.
 */
export const SAMPLE_PREVIEW: DraftPreview = {
  rows: [
    {
      key: "48213",
      kind: "answered",
      state: { title: "iPhone 15 Pro, sealed, 60% off, pay by gift card", price: "390" },
      model: "jev-1.14.0",
      answers: {
        is_scam: { type: "noul", probability: 0.58 },
        category: { type: "choice", top: "electronics", probabilities: categories(0.95, 0) },
      },
    },
    {
      key: "48190",
      kind: "answered",
      state: { title: "Oak dining table, 6 chairs, pickup only", price: "420" },
      model: "jev-1.14.0",
      answers: {
        is_scam: { type: "noul", probability: 0.03 },
        category: { type: "choice", top: "furniture", probabilities: categories(0.97, 1) },
      },
    },
    {
      key: "48177",
      kind: "answered",
      state: { title: "MacBook Air M3, brand new, send the deposit first", price: "450" },
      model: "jev-1.14.0",
      answers: {
        is_scam: { type: "noul", probability: 0.94 },
        category: { type: "choice", top: "electronics", probabilities: categories(0.95, 0) },
      },
    },
    {
      key: "48160",
      kind: "answered",
      state: { title: "PS5 bundle, two controllers", price: "380" },
      model: "jev-1.14.0",
      answers: {
        is_scam: { type: "noul", probability: 0.12 },
        category: { type: "choice", top: "electronics", probabilities: categories(0.98, 0) },
      },
    },
    {
      key: "48151",
      kind: "answered",
      state: { title: "Rolex Submariner, no box, cash only, today", price: "1200" },
      model: "jev-1.14.0",
      answers: {
        is_scam: { type: "noul", probability: 0.91 },
        category: { type: "choice", top: "other", probabilities: categories(0.41, 4) },
      },
    },
    { key: "48140", kind: "skipped", reason: "filtered-out" },
  ],
  decided: 2,
  review: 3,
  cost: { inputTokens: 3_750, dollars: 0.000_157_5 },
  warnings: [],
};

export const SAMPLE_TEST_ESTIMATE: TestEstimate = {
  sampleRecords: 1_000,
  reviewedRecords: 212,
  requests: 1_212,
  inputTokens: 909_000,
  dollars: 0.038_178,
};

/** The mockup's test: 41 of 1,000 is_scam answers would change, agreement 91% now and 96% with the draft. */
export const SAMPLE_TEST_RESULT: TestResult = {
  sample: { records: 1_000, asked: 1_000 },
  reviewed: { records: 212, asked: 212 },
  skipped: {},
  removed: [],
  questions: [
    {
      question: "is_scam",
      comparison: "compared",
      compared: 1_000,
      changed: 41,
      toDecided: 29,
      toReview: 12,
      toAnotherValue: 0,
      noCurrentAnswer: 0,
      keptForPeople: 0,
      agreement: {
        kind: "measured",
        records: 212,
        now: { agreed: 180, disagreed: 18, unsure: 14, rate: 0.909 },
        draft: { agreed: 196, disagreed: 8, unsure: 8, rate: 0.961 },
      },
    },
    {
      question: "category",
      comparison: "compared",
      compared: 1_000,
      changed: 0,
      toDecided: 0,
      toReview: 0,
      toAnotherValue: 0,
      noCurrentAnswer: 0,
      keptForPeople: 0,
      agreement: { kind: "none", reason: "no-reviewed-records" },
    },
  ],
  cost: { inputTokens: 905_000, dollars: 0.038_01 },
  estimate: SAMPLE_TEST_ESTIMATE,
  warnings: [],
};

export const SAMPLE_APPLY_DIFF: ApplyDiff = {
  written: false,
  path: "facetdb.config.ts",
  diff: [
    "--- a/facetdb.config.ts",
    "+++ b/facetdb.config.ts",
    "@@ -9,3 +9,3 @@",
    "       questions: {",
    '-        "is_scam": noul("Is this listing likely a scam?", { stakes: "high" }),',
    '+        "is_scam": noul("Is this listing a scam or a fake?", { stakes: "high" }),',
    "       },",
    "",
  ].join("\n"),
  changed: true,
  plan: "plan-1",
  uncommitted: null,
  warnings: [],
};

export const SAMPLE_APPLIED: ApplyWritten = {
  written: true,
  path: "facetdb.config.ts",
  diff: SAMPLE_APPLY_DIFF.diff,
  reload: {
    loaded: true,
    sources: [
      {
        source: "listings",
        outcome: "restarted",
        version: 4,
        message:
          "the question set changed: it finishes the batch in hand, then answers with version 4; nothing already answered is asked again.",
      },
      { source: "support_messages", outcome: "unchanged", version: 1, message: null },
    ],
    notes: [],
  },
};

/*
 * The Sources page and the setup flow: the mockups' sources, an inspection of the marketplace
 * database, a plan and an install, shaped as the worker answers.
 */

export const SAMPLE_SOURCES: readonly SourceRow[] = [
  {
    name: "listings",
    kind: "table",
    connector: "Postgres, trigger",
    install: { status: "ok", words: "installed, version 3" },
    how: {
      label: "Wakes",
      words: "Instantly, on the trigger's notification. Last change seen 12 seconds ago.",
    },
    lastChangeAt: "2026-11-06T11:59:48.000Z",
    answers: "Inline columns on public.listings. 2 questions, version 3.",
    backfill: {
      state: "finished",
      fraction: 1,
      words: "Finished the whole question set: 41,200 records answered under version 3.",
    },
    login: {
      label: "Login",
      words: "facetdb_worker reads title and price, and writes only FacetDB's own columns.",
    },
  },
  {
    name: "support_tickets",
    kind: "api",
    connector: "API",
    install: null,
    how: {
      label: "Arrives",
      words:
        "Your code sends each record to POST /v1/check and gets the answer back in about a second. Last change seen 40 seconds ago.",
    },
    lastChangeAt: "2026-11-06T11:59:20.000Z",
    answers: "Kept in the FacetDB store. 1 question, version 2. Unsure records land in Review.",
    backfill: { state: "none", fraction: null, words: "None: records arrive one by one." },
    login: null,
  },
];

export const SAMPLE_SETUP_ACCESS: SetupAccess = { open: true };

export const SAMPLE_TABLES: Inspection = {
  database: "Postgres",
  tables: ["listings", "sellers", "orders"],
  table: null,
  sharedWith: null,
};

/** The sellers table as an inspection reads it: its key, its columns and three of its rows. */
export const SAMPLE_SELLERS: Inspection = {
  ...SAMPLE_TABLES,
  table: {
    name: "sellers",
    key: "id",
    columns: [
      { name: "id", type: "integer" },
      { name: "bio", type: "text" },
      { name: "country", type: "text" },
      { name: "joined", type: "timestamp with time zone" },
    ],
    rows: [
      { id: "203", bio: "New here, cash only, <b>today</b>", country: "BE", joined: null },
      { id: "202", bio: "Selling my old bikes", country: "NL", joined: "2024-03-01 10:00:00+00" },
      { id: "201", bio: "Vintage furniture since 2011", country: "BE", joined: null },
    ],
  },
};

/** The plan of the sellers source: the install as `facetdb migrate --dry-run` prints it. */
export const SAMPLE_SETUP_PLAN: SetupPlan = {
  token: "plan-token-1",
  expiresInSeconds: 600,
  table: "public.sellers",
  sql: [
    "-- facetdb migrate: sellers (public.sellers)",
    "begin;",
    "",
    'alter table "public"."sellers" add column "is_fake" boolean',
    "",
    "commit;",
    "note: the worker login reads bio and writes only FacetDB's columns",
    "",
  ].join("\n"),
  transactional: true,
  path: "facetdb.config.ts",
  diff: [
    "--- a/facetdb.config.ts",
    "+++ b/facetdb.config.ts",
    "@@ -20,0 +21,4 @@",
    "+    {",
    '+      name: "sellers",',
    "+      database: process.env.DATABASE_URL,",
    "+    },",
    "",
  ].join("\n"),
  uncommitted: null,
  warnings: [],
  backfill: {
    records: 50_000,
    inputTokens: 2_000_000,
    dollars: 0.084,
    pace: 50,
    seconds: 1_000,
    command: "facetdb backfill --source sellers",
    counted: "statistics",
  },
  storeElsewhere: false,
};

/** The reload's why for a source it did not start: its database could not be read for the check. */
const SELLERS_NOT_STARTED =
  "new in facetdb.config.ts and not answered yet: its database could not be read to check its install (connect ECONNREFUSED 10.0.0.5:5432). Check again once the database answers; facetdb doctor says what is wrong.";

/** An install whose reload did not start the source: the why and the restart. */
export const SAMPLE_INSTALLED: SetupInstalled = {
  installed: true,
  table: "public.sellers",
  path: "facetdb.config.ts",
  reload: {
    loaded: true,
    sources: [
      { source: "sellers", outcome: "not-started", version: null, message: SELLERS_NOT_STARTED },
    ],
    notes: [],
  },
  worker: {
    running: false,
    why: SELLERS_NOT_STARTED,
    restart:
      "Until then the worker that is running does not answer sellers. To restart it, stop facetdb worker (Ctrl+C) and start it again: it reads facetdb.config.ts as it is and answers every change to public.sellers from then on.",
  },
  backfill:
    "Then answer the records already in public.sellers: facetdb backfill --source sellers shows its estimate before it asks anything.",
};

/** The same install, whose reload started the source: running, its backfill offered. */
export const SAMPLE_INSTALLED_RUNNING: SetupInstalled = {
  ...SAMPLE_INSTALLED,
  reload: {
    loaded: true,
    sources: [
      {
        source: "sellers",
        outcome: "started",
        version: 1,
        message:
          "its install is in its database and the worker login may write its columns, so it started: it answers every change from now on with version 1. The records already in the table are answered by a backfill, which shows its cost first.",
      },
    ],
    notes: [],
  },
  worker: {
    running: true,
    version: 1,
    words:
      "sellers is running with version 1: it answers every change to public.sellers from now on.",
  },
};

/** An added question's install for listings, as `facetdb migrate --dry-run` prints it. */
export const SAMPLE_MIGRATE_PLAN: MigratePlan = {
  token: "migrate-token-1",
  expiresInSeconds: 600,
  table: "public.listings",
  sql: [
    "-- facetdb migrate: listings (public.listings)",
    "begin;",
    'alter table "public"."listings" add column if not exists "is_vehicle" boolean;',
    'grant update ("is_vehicle") on "public"."listings" to facetdb_worker;',
    "commit;",
    "",
  ].join("\n"),
  transactional: true,
  questions: ["is_vehicle"],
  storeElsewhere: false,
};

export const SAMPLE_MIGRATED: Migrated = {
  migrated: true,
  table: "public.listings",
  reload: {
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
  },
};

/**
 * A backfill job of `source` in `state`, shaped as the worker's door reports one: the sample
 * estimate is 1,200 records at about $0.0043, paced at 50 a second; a test overrides what differs.
 */
export function sampleBackfill(
  state: BackfillStatus["state"],
  more: Partial<BackfillStatus> = {},
): BackfillStatus {
  return {
    source: "listings",
    state,
    questions: null,
    version: 3,
    surveyed: 1_200,
    estimate: {
      records: 1_200,
      sampled: 100,
      tokensPerRecord: 85,
      tokens: 102_000,
      dollars: 0.0043,
    },
    pace: 50,
    token: null,
    expiresAt: null,
    counts: { records: 0, queued: 0, answered: 0, alreadyAnswered: 0, deferred: 0 },
    since: "2026-11-06T12:00:00.000Z",
    endedAt: null,
    why: null,
    words: `The backfill of listings is ${state}.`,
    ...more,
  };
}

/** No job since the worker started: what GET /v1/sources/:name/backfill answers at first. */
export const SAMPLE_BACKFILL_IDLE: BackfillStatus = {
  source: "listings",
  state: "idle",
  questions: null,
  version: null,
  surveyed: null,
  estimate: null,
  pace: null,
  token: null,
  expiresAt: null,
  counts: null,
  since: null,
  endedAt: null,
  why: null,
  words: "No backfill is running. Estimate one to see its cost first.",
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
  /**
   * The admin connection string each setup call carried, in order, kept apart from `calls` so a
   * failing assertion on the calls never prints it.
   */
  readonly admins: readonly string[];
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
    alerts: () => Promise.resolve(SAMPLE_ALERTS),
    studioAccess: () => Promise.resolve(SAMPLE_ACCESS),
    reviewers: () => Promise.resolve(SAMPLE_REVIEWERS),
    addReviewer: () => Promise.resolve(),
    spendingConfig: () => Promise.resolve(SAMPLE_SPENDING_CONFIG),
    // The Questions page's.
    projectConfig: () => Promise.resolve(SAMPLE_PROJECT_CONFIG),
    validateDraft: () => Promise.resolve(SAMPLE_VALIDATION),
    previewDraft: () => Promise.resolve(SAMPLE_PREVIEW),
    testEstimate: () => Promise.resolve(SAMPLE_TEST_ESTIMATE),
    testDraft: () => Promise.resolve(SAMPLE_TEST_RESULT),
    applyDiff: () => Promise.resolve(SAMPLE_APPLY_DIFF),
    applyWrite: () => Promise.resolve(SAMPLE_APPLIED),
    reload: () => Promise.resolve({ loaded: true, sources: [], notes: [] }),
    // The Sources page and the setup flow.
    sources: () => Promise.resolve(SAMPLE_SOURCES),
    setupAccess: () => Promise.resolve(SAMPLE_SETUP_ACCESS),
    setupInspect: (_admin, table) =>
      Promise.resolve(table === undefined ? SAMPLE_TABLES : SAMPLE_SELLERS),
    setupPreview: () => Promise.resolve(SAMPLE_PREVIEW),
    setupPlan: () => Promise.resolve(SAMPLE_SETUP_PLAN),
    setupInstall: () => Promise.resolve(SAMPLE_INSTALLED),
    // An added question's install.
    migratePlan: () => Promise.resolve(SAMPLE_MIGRATE_PLAN),
    migrateRun: () => Promise.resolve(SAMPLE_MIGRATED),
    // A source's backfill: idle until a test scripts the job's states.
    backfillStatus: (source) => Promise.resolve({ ...SAMPLE_BACKFILL_IDLE, source }),
    backfillEstimate: (source, questions) =>
      Promise.resolve(
        sampleBackfill("estimating", {
          source,
          questions: questions === undefined ? null : [...questions],
          surveyed: 0,
          estimate: null,
        }),
      ),
    backfillStart: (source) => Promise.resolve(sampleBackfill("running", { source })),
    backfillStop: (source) => Promise.resolve(sampleBackfill("stopping", { source })),
    ...answers,
  };
  const admins: string[] = [];
  return {
    calls,
    refs,
    admins,
    sources: () => {
      calls.push("sources");
      return answer.sources();
    },
    setupAccess: () => {
      calls.push("setupAccess");
      return answer.setupAccess();
    },
    setupInspect: (admin, table) => {
      admins.push(admin);
      calls.push(`setupInspect${table === undefined ? "" : ` ${table}`}`);
      return answer.setupInspect(admin, table);
    },
    setupPreview: (admin, draft) => {
      admins.push(admin);
      calls.push(`setupPreview ${JSON.stringify(draft)}`);
      return answer.setupPreview(admin, draft);
    },
    setupPlan: (admin, draft) => {
      admins.push(admin);
      calls.push(`setupPlan ${JSON.stringify(draft)}`);
      return answer.setupPlan(admin, draft);
    },
    setupInstall: (admin, draft, confirm) => {
      admins.push(admin);
      calls.push(`setupInstall ${JSON.stringify({ ...confirm, draft })}`);
      return answer.setupInstall(admin, draft, confirm);
    },
    migratePlan: (source, admin) => {
      admins.push(admin);
      calls.push(`migratePlan ${source}`);
      return answer.migratePlan(source, admin);
    },
    migrateRun: (source, admin, token) => {
      admins.push(admin);
      calls.push(`migrateRun ${source} ${token}`);
      return answer.migrateRun(source, admin, token);
    },
    // The backfill calls: the questions named ride in the note, the token too.
    backfillStatus: (source) => {
      calls.push(`backfillStatus ${source}`);
      return answer.backfillStatus(source);
    },
    backfillEstimate: (source, questions) => {
      calls.push(
        `backfillEstimate ${source}${questions === undefined ? "" : ` ${questions.join(",")}`}`,
      );
      return answer.backfillEstimate(source, questions);
    },
    backfillStart: (source, token) => {
      calls.push(`backfillStart ${source} ${token}`);
      return answer.backfillStart(source, token);
    },
    backfillStop: (source) => {
      calls.push(`backfillStop ${source}`);
      return answer.backfillStop(source);
    },
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
    alerts: () => {
      calls.push("alerts");
      return answer.alerts();
    },
    studioAccess: () => {
      calls.push("studioAccess");
      return answer.studioAccess();
    },
    reviewers: () => {
      calls.push("reviewers");
      return answer.reviewers();
    },
    // Only the name is noted: a password is never written where a test log or a failure shows it.
    addReviewer: (name, password) => {
      calls.push(`addReviewer ${name}`);
      return answer.addReviewer(name, password);
    },
    spendingConfig: () => {
      calls.push("spendingConfig");
      return answer.spendingConfig();
    },
    // The Questions page's: the draft each call sent rides in the note as JSON.
    projectConfig: () => {
      calls.push("projectConfig");
      return answer.projectConfig();
    },
    validateDraft: (draft) => {
      calls.push(`validateDraft ${JSON.stringify(draft)}`);
      return answer.validateDraft(draft);
    },
    previewDraft: (draft) => {
      calls.push(`previewDraft ${JSON.stringify(draft)}`);
      return answer.previewDraft(draft);
    },
    testEstimate: (draft) => {
      calls.push(`testEstimate ${JSON.stringify(draft)}`);
      return answer.testEstimate(draft);
    },
    testDraft: (draft) => {
      calls.push(`testDraft ${JSON.stringify(draft)}`);
      return answer.testDraft(draft);
    },
    applyDiff: (draft) => {
      calls.push(`applyDiff ${JSON.stringify(draft)}`);
      return answer.applyDiff(draft);
    },
    applyWrite: (draft, confirm) => {
      calls.push(`applyWrite ${JSON.stringify({ ...confirm, draft })}`);
      return answer.applyWrite(draft, confirm);
    },
    reload: () => {
      calls.push("reload");
      return answer.reload();
    },
  };
}
