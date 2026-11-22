import {
  type AlertChannelEntry,
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
  type Gallery,
  type GalleryEntry,
  type Home,
  type Inspection,
  type InstalledPlugins,
  type Migrated,
  type MigratePlan,
  type Project,
  type ProjectConfig,
  type QuestionPack,
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
  // The fleet of SAMPLE_HOME with its questions: more than the one card waiting shows.
  sources: [
    { name: "listings", questions: ["is_scam", "category"] },
    { name: "support_messages", questions: ["urgency", "team", "wants_refund"] },
    { name: "profiles", questions: ["is_bot"] },
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
      // Low stakes with the config's own line (SAMPLE_PROJECT_CONFIG's override).
      stakes: "low",
      thresholds: { kind: "confidence", confidenceAtLeast: 0.6 },
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
      // High stakes on its defaults: the mockup's "decides on its own only at 90% or 10%".
      stakes: "high",
      thresholds: { kind: "yes-no", yesAbove: 0.9, noBelow: 0.1 },
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
      { name: "sources", status: "ok", words: "Three sources, reachable and installed" },
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
    words: {
      figure: "3.2M of 25M",
      sub: "Input tokens this month: 13% of the monthly cap, about $3.20 of $25. The project pauses at 100%.",
    },
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
      withdrawn: false,
      note: "gift-card payment, two-day-old seller",
    },
    {
      kind: "answer",
      time: "2026-11-06T14:14:00.000Z",
      record_key: "48213",
      version: 3,
      model: "jev-1.14.0",
      answers: {
        is_scam: {
          type: "noul",
          probability: 0.58,
          decision: "needs review",
          outcome: "needs_review",
        },
        category: {
          type: "choice",
          top: "electronics",
          probabilities: [0.95, 0.03, 0.02],
          decision: "electronics",
          outcome: "decided",
        },
      },
    },
    {
      kind: "answer",
      time: "2026-11-06T13:58:00.000Z",
      record_key: "48190",
      version: 3,
      model: "jev-1.14.0",
      answers: {
        is_scam: { type: "noul", probability: 0.02, decision: "no", outcome: "decided" },
      },
    },
  ],
  next: null,
};

/** The history of the mockup's record 48213, oldest first, as `facetdb explain` words it. */
export function sampleHistory(source: string, key: string): DecisionHistory {
  return {
    source,
    key,
    // The mockup's "Done, reviewed": hailey's decision settled the one question in review.
    status: "done",
    reviewed: true,
    entries: [
      {
        kind: "answer",
        at: "2026-11-03T10:02:00.000Z",
        model: "jev-1.14.0",
        version: 2,
        stateHash: "hash-at-420",
        answers: [
          {
            question: "is_scam",
            wording: "Is this listing a scam?",
            said: "27% likely yes",
            decision: "no",
            outcome: "decided",
          },
          {
            question: "category",
            wording: "Which category is this listing?",
            said: "electronics, 93% sure",
            decision: "electronics",
            outcome: "decided",
          },
        ],
      },
      {
        // The seller edited the listing: another state, asked again under the version then in force.
        kind: "answer",
        at: "2026-11-06T14:14:00.000Z",
        model: "jev-1.14.0",
        version: 3,
        stateHash: "hash-at-390",
        answers: [
          {
            question: "is_scam",
            wording: "Is this listing a scam?",
            said: "58% likely yes",
            decision: "needs review",
            outcome: "needs_review",
          },
        ],
      },
      {
        kind: "human",
        at: "2026-11-06T14:31:00.000Z",
        version: 3,
        stateHash: "hash-at-390",
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

/**
 * The mockup's channels: Slack #ops quiet at night in the worker's zone, its summary the newest
 * thing it was sent; Email delivering everything; Slack #oncall failing, in the Slack plugin's own
 * words; a webhook endpoint with quiet hours in its own zone that was sent nothing yet.
 */
export const SAMPLE_ALERTS: Alerts = {
  channels: [
    {
      kind: "slack",
      name: "#ops",
      address: "slack:#ops",
      sends: "warnings",
      quiet: { from: "22:00", to: "07:00", zone: null },
      bound: true,
      delivering: true,
      last: {
        at: local(11, 5, 23, 9),
        kind: "model_failing",
        title: "Model failing",
        phase: "resolved",
        ok: true,
        error: null,
      },
      summary: { at: local(11, 6, 7, 0), sent: true, failing: false },
    },
    {
      kind: "email",
      name: "ops@example.com",
      address: "email:ops@example.com",
      sends: "everything",
      quiet: null,
      bound: true,
      delivering: true,
      last: {
        at: local(11, 6, 14, 10),
        kind: "backfill_finished",
        title: "Backfill finished",
        phase: "raised",
        ok: true,
        error: null,
      },
      summary: null,
    },
    {
      kind: "slack",
      name: "#oncall",
      address: "slack:#oncall",
      sends: "critical",
      quiet: null,
      bound: true,
      delivering: false,
      last: {
        at: local(11, 2, 8, 15),
        kind: "worker_not_running",
        title: "Worker not running",
        phase: "raised",
        ok: false,
        error:
          "slack:#oncall was not delivered: the app is not in #oncall; invite it with /invite @your-app",
      },
      summary: null,
    },
    {
      kind: "webhook",
      name: "ops",
      address: "webhook:ops",
      sends: "warnings",
      quiet: { from: "23:00", to: "08:00", zone: "Europe/Berlin" },
      bound: true,
      delivering: null,
      last: null,
      summary: null,
    },
  ],
  workerZone: "Africa/Addis_Ababa",
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
      pending: false,
      held: [],
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
      pending: false,
      held: [],
    },
    {
      at: local(11, 2, 8, 15),
      kind: "worker_not_running",
      severity: "critical",
      title: "Worker not running",
      what: "Worker worker-5d1c has sent no heartbeat for 2 minutes; its last beat was 2026-11-02 08:13 UTC. 1 worker of the project still beats.",
      project: "marketplace",
      source: "all sources",
      question: null,
      did: "Records stay queued; the workers that still beat answer them.",
      link: "https://docs.facetdb.dev/fix/worker",
      // Raised once by another worker and never resolved.
      standing: { phase: "raised" },
      raisedBeforeHistory: false,
      delivered: true,
      pending: false,
      held: [],
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
      pending: false,
      // Raised at 4:02 pm, outside the quiet hours: held for none. The Alerts page's tests hold
      // one.
      held: [],
    },
  ],
  fileChannelsDiffer: false,
  limit: 100,
  capped: false,
};

/** The mockup's channels as facetdb.config.ts writes them, in the order `SAMPLE_ALERTS` lists them. */
export const SAMPLE_ALERT_CHANNELS_IN_FILE: readonly AlertChannelEntry[] = [
  { to: "slack:#ops", sends: "warnings", quiet: { from: "22:00", to: "07:00" } },
  "email:ops@example.com",
  { to: "slack:#oncall", sends: "critical" },
  {
    to: "webhook:ops",
    sends: "warnings",
    quiet: { from: "23:00", to: "08:00", zone: "Europe/Berlin" },
  },
];

/** The diff adding Slack #trust-and-safety makes (the mockup's). */
export const SAMPLE_ALERTS_DIFF: ApplyDiff = {
  written: false,
  path: "facetdb.config.ts",
  diff: [
    "--- a/facetdb.config.ts",
    "+++ b/facetdb.config.ts",
    "@@ -9,6 +9,7 @@",
    "   alerts: {",
    "     channels: [",
    '       { to: "slack:#ops", sends: "warnings", quiet: { from: "22:00", to: "07:00" } },',
    '       "email:ops@example.com",',
    '+      { to: "slack:#trust-and-safety", sends: "warnings" },',
    "     ],",
    "   },",
  ].join("\n"),
  changed: true,
  plan: "plan-alerts",
  uncommitted: null,
  dropsOwnText: false,
  warnings: [],
};

/** The channels written, and the reload put them in force with no restart. */
export const SAMPLE_ALERTS_APPLIED: ApplyWritten = {
  written: true,
  path: "facetdb.config.ts",
  diff: SAMPLE_ALERTS_DIFF.diff,
  reload: {
    loaded: true,
    sources: [
      { source: "listings", outcome: "unchanged", version: 3, message: null },
      { source: "support_messages", outcome: "unchanged", version: 1, message: null },
    ],
    notes: [
      "The alert channels facetdb.config.ts names are in force now, with no restart: each alert from now on goes to the 5 channels it names.",
    ],
  },
};

export const SAMPLE_ACCESS: StudioAccess = {
  host: "127.0.0.1",
  loopback: true,
  reviewers: 2,
  accountsWritable: true,
};

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

/**
 * `GET /v1/packs` with both first-party packs installed: the marketplace pack of `@facetdb/packs`
 * and GitHub's triage pack, their questions and criteria as the packs write them
 * (plugins/packs/src/marketplace.ts, plugins/github/src/packs/triage.ts), each description cut to
 * its first two sentences.
 */
export const SAMPLE_PACKS: readonly QuestionPack[] = [
  {
    plugin: "packs",
    package: "@facetdb/packs",
    name: "marketplace",
    description:
      "Marketplace trust and safety: four yes-or-no questions on a listing's text, read from `title` and `description` (no images). They ask whether the listing is a scam, written to take a buyer's money or details without a real sale, whether it offers something of a kind general marketplaces commonly ban, whether it asks buyers to contact or pay the seller outside the marketplace, and whether the seller calls the item a counterfeit or replica of a branded product.",
    reads: ["title", "description"],
    questions: {
      scam: {
        type: "noul",
        instructions:
          "Is the listing in `title` and `description` written to take a buyer's money or personal details without a real sale behind it?",
        criteria: {
          true: "The listing asks for money or personal details in a way that leaves the buyer unable to check the item first: payment in gift cards or crypto, an item held by an agent or a courier, or a place to rent that nobody can visit, while the seller is far away, pressure to pay a deposit at once, a request for the buyer's bank or identity details, or a price far below the item's worth explained by a story. A money transfer ahead of any viewing is a sign of a scam only together with one of these.",
          false:
            "The listing describes a real sale of an item the seller has: the buyer can view or collect the item and pay at that moment, or pays through the marketplace's checkout for an item described plainly at a believable price. A listing that breaks the marketplace's rules in another way, with an item that may be fake, banned or of unclear origin, is still a real sale when the buyer can check the item before paying.",
        },
        stakes: "high",
      },
      banned_item: {
        type: "noul",
        instructions:
          "Does the listing in `title` and `description` offer an item or a service of a kind that general marketplaces commonly ban?",
        criteria: {
          true: "The listing offers something of these kinds: weapons made to injure, including firearms, air guns, crossbows, their parts and ammunition, and self-defence weapons such as stun guns and irritant sprays; explosives and fireworks; illegal drugs and the equipment for taking them; prescription medicines; alcohol; tobacco and vaping products; live animals; human remains or body parts; stolen goods; counterfeit money; passports, identity documents and official badges; hazardous chemicals; recalled products; sexual services or adult content.",
          false:
            "The listing offers an ordinary product or service of another kind, such as tools, kitchen knives, ordinary sports gear like a bat, a ball, a racket or a bow for target archery, toys, furniture, containers or pet supplies sold on their own, including one whose name uses a word from these kinds in an everyday sense. Being a copy or a fake of a branded product does not by itself make an item one of these kinds, and a copy of an item of these kinds, such as a fake branded vape or medicine, is still that kind.",
        },
        stakes: "high",
      },
      off_platform: {
        type: "noul",
        instructions:
          "Does the listing in `title` and `description` ask buyers to take the deal off this marketplace, to contact the seller elsewhere or to pay outside the marketplace?",
        criteria: {
          true: "The listing gives buyers a way to reach the seller outside the marketplace, such as a phone number, an email address, a messaging app or a website, or asks for money sent to the seller by a route other than the marketplace's checkout, such as a bank transfer, a payment app, gift cards or crypto, or offers better terms, such as a lower price, for settling the deal outside the marketplace.",
          false:
            "The listing keeps the conversation in the marketplace's messages, and the money goes through the marketplace's checkout, on its website or in its own app, or changes hands in person at collection.",
        },
        stakes: "low",
      },
      counterfeit: {
        type: "noul",
        instructions:
          "Does the listing in `title` and `description` say, in the seller's own words, that the item is a counterfeit, a replica or a copy of a branded product?",
        criteria: {
          true: "The seller says the item imitates a brand's product: it is called a fake, a replica, a copy or an imitation of that brand's goods, or it carries a brand's name or logo that the brand did not put there. A copy of a brand's product that the brand did not make or license is a counterfeit whatever it is sold as, including decoration or display.",
          false:
            "The seller presents the item as the brand's own product or as goods the brand licensed: an official replica kit, the licensed fan version of a team's shirt, and a licensed model, toy or piece of merchandise of a branded product are genuine. The item can also be a generic product with no brand at all, or a reproduction of a historical object, an unbranded film prop or a scale model of a building.",
        },
        stakes: "high",
      },
    },
    thresholds: {},
  },
  {
    plugin: "github",
    package: "@facetdb/github",
    name: "triage",
    description:
      "GitHub issue triage for any repository: three questions about an issue or a pull request. They read the four fields the GitHub source returns: `title`, `body`, `labels` and `changed_files`, which is empty for an issue and lists a pull request's changed files.",
    reads: ["title", "body", "labels", "changed_files"],
    questions: {
      kind: {
        type: "choice",
        instructions:
          "What kind of issue do `title` and `body` describe? A pull request, which lists the files it changes in `changed_files`, takes the kind of the change it makes. A label in `labels` is a hint that can be wrong.",
        options: [
          {
            name: "bug_report",
            description:
              "A bug report: someone says the software fails or gives a wrong result, such as a crash, an error message, wrong output, lost data, a failed install or something that broke in an upgrade.",
          },
          {
            name: "feature_request",
            description:
              "A feature request: a wish for new behaviour, or for a change to behaviour that works as designed, including support for a platform, a format or an integration the project has never had.",
          },
          {
            name: "usage_question",
            description:
              "A usage question: someone asks how to install, configure or use the software for their own case, and makes no claim that it is broken.",
          },
          {
            name: "documentation_problem",
            description:
              "A documentation problem: the README, the guides, the reference or the examples leave something out, state something wrong, read unclearly or are out of date, and the fix belongs in that text rather than in the code.",
          },
          {
            name: "something_else",
            description:
              "Something else about the project: upkeep such as a dependency update, a build or test pipeline change or a refactor that keeps behaviour the same; a question about releases; a discussion of the roadmap or of how the project is run; thanks or an announcement; or text that asks for nothing, such as spam or a test post.",
          },
        ],
        stakes: "low",
        storeProbabilities: false,
      },
      missing_reproduction: {
        type: "noul",
        instructions:
          "Does the issue in `title` and `body` report a bug while leaving out what a maintainer needs to make the bug happen on their own machine?",
        criteria: {
          true: "The issue says something is broken but gives only the symptom: it leaves out the steps, the command, the code or the input that cause it, so a maintainer would have to ask the reporter how to see it happen.",
          false:
            "The issue gives the steps, the command, the code or the input that cause the bug, with the error output or the version where it helps; naming the setting or the action that causes the bug is enough. The item can also report a wish, a question, a documentation problem or project upkeep instead of a bug, or be a pull request, which lists the files it changes in `changed_files`.",
        },
        stakes: "low",
      },
      not_priority: {
        type: "noul",
        instructions:
          "Would the maintainers treat the issue or pull request in `title` and `body` as low priority?",
        criteria: {
          true: "It is cosmetic: something looks or reads slightly off while it still works, such as a typo, a spacing or a colour; it asks for a feature, a format or a platform with no concrete use case behind it; it asks a basic question of the kind a getting-started guide covers, such as how to install the software, what it needs to run or how to change a common setting; it happens only on a setup the project does not support, such as an end-of-life runtime or a modified build; or it asks nothing of the project's software or documentation, such as a test post, spam, thanks or a question about release plans.",
          false:
            "It reports a fault on a supported setup that crashes, loses or corrupts data, gives wrong results, breaks a feature or blocks people from their work; it reports a security weakness; it reports or fixes documentation that would lead people to a wrong result or leaves out what they need to use a feature; it plans or tracks the maintainers' work for a coming release; it asks for a feature and names the concrete use case it serves; or a label in `labels` already marks it as urgent, a regression or a security issue.",
        },
        stakes: "low",
      },
    },
    thresholds: { not_priority: { yesAbove: 0.8, noBelow: 0.2 } },
  },
];

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
  dropsOwnText: false,
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

/** Settings' save of the cap (25,000,000 tokens to 40,000,000, keep answering): the diff it shows. */
export const SAMPLE_SPENDING_DIFF: ApplyDiff = {
  written: false,
  path: "facetdb.config.ts",
  diff: [
    "--- a/facetdb.config.ts",
    "+++ b/facetdb.config.ts",
    "@@ -1,6 +1,7 @@",
    ' import { facetdb, noul } from "facetdb";',
    "",
    " export default facetdb({",
    '   model: "jev-1.14.0",',
    "-  spendingCap: 25000000,",
    "+  spendingCap: 40000000,",
    '+  onCapReached: "continue",',
    "   sources: [",
    "",
  ].join("\n"),
  changed: true,
  plan: "plan-spending",
  uncommitted: null,
  dropsOwnText: false,
  warnings: [],
};

/** The cap written: every source runs on, and the worker took the cap up in the reload (no note). */
export const SAMPLE_SPENDING_APPLIED: ApplyWritten = {
  written: true,
  path: "facetdb.config.ts",
  diff: SAMPLE_SPENDING_DIFF.diff,
  reload: {
    loaded: true,
    sources: [
      { source: "listings", outcome: "unchanged", version: 3, message: null },
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
    rows: 41_237,
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
    rows: null,
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
    estimatedRows: 4_137,
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
    '+      database: env("DATABASE_URL"),',
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

/*
 * The Plugins page: the mockup's plugins. GitHub with a secret not set, Slack, email with its
 * default, a community `discord` that marks three settings editable and has one the form cannot
 * draw, `linear` made for an older FacetDB, the packs with no settings, and the built-in webhook
 * whose endpoint is its host alone. Then the registry's gallery, and discord's settings through
 * Apply.
 */

const secretText = { type: "string", minLength: 1, secret: true } as const;

export const SAMPLE_PLUGINS: InstalledPlugins = {
  facetdb: "0.4.0",
  plugins: [
    {
      name: "github",
      key: "github",
      version: "0.4.0",
      builtIn: false,
      provides: {
        source: ["issues"],
        action: ["label", "comment", "assign"],
        channel: [],
        provider: [],
        pack: ["triage"],
      },
      core: { range: ">=0.4.0 <0.5.0", holds: true },
      settings: {
        schema: {
          type: "object",
          properties: { token: secretText, webhookSecret: secretText, apiUrl: { type: "string" } },
          required: ["token"],
        },
        values: {
          token: { env: "GITHUB_TOKEN" },
          webhookSecret: { env: "GITHUB_WEBHOOK_SECRET" },
        },
        variables: [
          { path: "token", variable: "GITHUB_TOKEN", secret: true, set: true },
          { path: "webhookSecret", variable: "GITHUB_WEBHOOK_SECRET", secret: true, set: false },
        ],
        hostOnly: [],
      },
    },
    {
      name: "slack",
      key: "slack",
      version: "0.4.0",
      builtIn: false,
      provides: { source: [], action: [], channel: ["slack"], provider: [], pack: [] },
      core: { range: ">=0.4.0 <0.5.0", holds: true },
      settings: {
        schema: {
          type: "object",
          properties: {
            token: secretText,
            webhooks: {
              type: "object",
              propertyNames: { type: "string" },
              additionalProperties: secretText,
            },
          },
        },
        values: { token: { env: "SLACK_BOT_TOKEN" } },
        variables: [{ path: "token", variable: "SLACK_BOT_TOKEN", secret: true, set: true }],
        hostOnly: [],
      },
    },
    {
      name: "email",
      key: "email",
      version: "0.4.0",
      builtIn: false,
      provides: { source: [], action: [], channel: ["email"], provider: [], pack: [] },
      core: { range: ">=0.4.0 <0.5.0", holds: true },
      settings: {
        schema: {
          type: "object",
          properties: {
            host: { type: "string" },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            secure: { default: false, type: "boolean" },
            user: { type: "string", minLength: 1 },
            password: secretText,
            from: { type: "string" },
          },
          required: ["host", "from"],
          additionalProperties: false,
        },
        values: {
          host: "smtp.example.com",
          port: 587,
          user: "alerts@example.com",
          password: { env: "EMAIL_PASSWORD" },
          from: "FacetDB <alerts@example.com>",
        },
        variables: [{ path: "password", variable: "EMAIL_PASSWORD", secret: true, set: true }],
        hostOnly: [],
      },
    },
    {
      name: "discord",
      key: "discord",
      version: "0.6.2",
      builtIn: false,
      provides: { source: [], action: [], channel: ["discord"], provider: [], pack: [] },
      core: { range: ">=0.4.0 <0.5.0", holds: true },
      settings: {
        schema: {
          type: "object",
          properties: {
            webhooks: {
              type: "object",
              propertyNames: { type: "string" },
              additionalProperties: secretText,
            },
            username: { default: "FacetDB", editable: true, type: "string" },
            style: { type: "string", enum: ["compact", "full"], editable: true },
            mentionRoles: { type: "array", items: { type: "string" }, editable: true },
            embeds: {
              type: "array",
              items: { type: "object", properties: { title: { type: "string" } } },
            },
          },
          required: ["webhooks"],
        },
        values: {
          webhooks: { "#alerts": { env: "DISCORD_WEBHOOK_ALERTS" } },
          username: "FacetDB",
          style: "compact",
          mentionRoles: ["oncall"],
          embeds: [{ title: "FacetDB" }],
        },
        variables: [
          {
            path: "webhooks.#alerts",
            variable: "DISCORD_WEBHOOK_ALERTS",
            secret: true,
            set: true,
          },
        ],
        hostOnly: [],
      },
    },
    {
      name: "linear",
      key: "linear",
      version: "0.1.4",
      builtIn: false,
      provides: { source: [], action: ["label"], channel: [], provider: [], pack: [] },
      core: { range: ">=0.2.0 <0.4.0", holds: false },
      settings: {
        schema: {
          type: "object",
          properties: { apiKey: secretText, team: { type: "string" } },
          required: ["apiKey", "team"],
        },
        values: { apiKey: { env: "LINEAR_API_KEY" }, team: "MKT" },
        variables: [{ path: "apiKey", variable: "LINEAR_API_KEY", secret: true, set: true }],
        hostOnly: [],
      },
    },
    {
      name: "packs",
      key: "packs",
      version: "0.4.0",
      builtIn: false,
      provides: { source: [], action: [], channel: [], provider: [], pack: ["marketplace"] },
      core: { range: ">=0.4.0 <0.5.0", holds: true },
      settings: {
        schema: { type: "object", properties: {}, additionalProperties: false },
        values: {},
        variables: [],
        hostOnly: [],
      },
    },
    {
      name: "webhook",
      key: "webhook",
      version: "0.4.0",
      builtIn: true,
      provides: { source: [], action: ["send"], channel: ["webhook"], provider: [], pack: [] },
      core: { range: "*", holds: true },
      settings: {
        schema: {
          type: "object",
          properties: {
            secret: secretText,
            endpoints: {
              default: {},
              type: "object",
              propertyNames: { type: "string" },
              additionalProperties: { type: "string" },
            },
          },
          required: ["secret"],
          additionalProperties: false,
        },
        values: {
          secret: { env: "FACETDB_WEBHOOK_SECRET" },
          endpoints: { ops: "hooks.example.com" },
        },
        variables: [
          { path: "secret", variable: "FACETDB_WEBHOOK_SECRET", secret: true, set: true },
        ],
        hostOnly: ["endpoints.ops"],
      },
    },
  ],
};

/** One registry entry as the gallery endpoint answers it. */
function galleryEntry(
  name: string,
  more: Omit<GalleryEntry, "name" | "holds"> & { readonly holds?: boolean },
): GalleryEntry {
  return { name, holds: true, ...more };
}

export const SAMPLE_GALLERY: Gallery = {
  reachable: true,
  address: "https://registry.facetdb.dev/index.json",
  plugins: [
    galleryEntry("github", {
      description:
        "Issues and pull requests as a source; labels, comments and assignees as actions; the issue triage pack.",
      kinds: ["source", "action", "pack"],
      verified: true,
      downloads: 4210,
      installed: true,
    }),
    galleryEntry("slack", {
      description:
        "Alerts and record notifications in Slack, through a bot token or a channel's incoming webhook.",
      kinds: ["channel"],
      verified: true,
      downloads: 3880,
      installed: true,
    }),
    galleryEntry("telegram", {
      description: "Alerts and record notifications in a Telegram chat, through your own bot.",
      kinds: ["channel"],
      verified: true,
      downloads: 1630,
      installed: false,
    }),
    galleryEntry("zendesk", {
      description: "Zendesk tickets as a source, and a tag on the ticket as an action.",
      kinds: ["source", "action"],
      verified: false,
      downloads: 520,
      installed: false,
    }),
    galleryEntry("intercom", {
      description: "Intercom conversations as a source.",
      kinds: ["source"],
      verified: false,
      downloads: 240,
      installed: false,
      holds: false,
    }),
  ],
};

/** Discord's username and a second role to mention, through Apply: the diff it shows. */
export const SAMPLE_PLUGINS_DIFF: ApplyDiff = {
  written: false,
  path: "facetdb.config.ts",
  diff: [
    "--- a/facetdb.config.ts",
    "+++ b/facetdb.config.ts",
    "@@ -4,9 +4,9 @@",
    "   plugins: {",
    "     discord: {",
    '       webhooks: { "#alerts": env("DISCORD_WEBHOOK_ALERTS") },',
    '-      username: "FacetDB",',
    '+      username: "Marketplace alerts",',
    '       style: "compact",',
    '-      mentionRoles: ["oncall"],',
    '+      mentionRoles: ["oncall", "trust-and-safety"],',
    "",
  ].join("\n"),
  changed: true,
  plan: "plan-plugins",
  uncommitted: null,
  dropsOwnText: false,
  warnings: [],
};

/** The settings written: the reload put them in force with no restart, in its own words. */
export const SAMPLE_PLUGINS_APPLIED: ApplyWritten = {
  written: true,
  path: "facetdb.config.ts",
  diff: SAMPLE_PLUGINS_DIFF.diff,
  reload: {
    loaded: true,
    sources: [{ source: "listings", outcome: "unchanged", version: 3, message: null }],
    notes: [
      "The settings of the plugin facetdb-plugin-discord in facetdb.config.ts are in force now, with no restart: each action and notification run from now on is handed them.",
    ],
  },
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
    // The Alerts page's channels; its channel kinds are `plugins` and `gallery` below.
    testAlertChannel: () => Promise.resolve(),
    alertChannelsInFile: () => Promise.resolve(SAMPLE_ALERT_CHANNELS_IN_FILE),
    applyAlertsDiff: () => Promise.resolve(SAMPLE_ALERTS_DIFF),
    applyAlertsWrite: () => Promise.resolve(SAMPLE_ALERTS_APPLIED),
    studioAccess: () => Promise.resolve(SAMPLE_ACCESS),
    reviewers: () => Promise.resolve(SAMPLE_REVIEWERS),
    addReviewer: () => Promise.resolve(),
    spendingConfig: () => Promise.resolve(SAMPLE_SPENDING_CONFIG),
    // The Questions page's.
    projectConfig: () => Promise.resolve(SAMPLE_PROJECT_CONFIG),
    packs: () => Promise.resolve(SAMPLE_PACKS),
    validateDraft: () => Promise.resolve(SAMPLE_VALIDATION),
    previewDraft: () => Promise.resolve(SAMPLE_PREVIEW),
    testEstimate: () => Promise.resolve(SAMPLE_TEST_ESTIMATE),
    testDraft: () => Promise.resolve(SAMPLE_TEST_RESULT),
    applyDiff: () => Promise.resolve(SAMPLE_APPLY_DIFF),
    applyWrite: () => Promise.resolve(SAMPLE_APPLIED),
    applySpendingDiff: () => Promise.resolve(SAMPLE_SPENDING_DIFF),
    applySpendingWrite: () => Promise.resolve(SAMPLE_SPENDING_APPLIED),
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
    // The Plugins page.
    plugins: () => Promise.resolve(SAMPLE_PLUGINS),
    gallery: () => Promise.resolve(SAMPLE_GALLERY),
    applyPluginsDiff: () => Promise.resolve(SAMPLE_PLUGINS_DIFF),
    applyPluginsWrite: () => Promise.resolve(SAMPLE_PLUGINS_APPLIED),
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
    // The Alerts page's channels: the address and each draft ride in the note.
    testAlertChannel: (address) => {
      calls.push(`testAlertChannel ${address}`);
      return answer.testAlertChannel(address);
    },
    alertChannelsInFile: () => {
      calls.push("alertChannelsInFile");
      return answer.alertChannelsInFile();
    },
    applyAlertsDiff: (alerts) => {
      calls.push(`applyAlertsDiff ${JSON.stringify(alerts)}`);
      return answer.applyAlertsDiff(alerts);
    },
    applyAlertsWrite: (alerts, confirm) => {
      calls.push(`applyAlertsWrite ${JSON.stringify({ ...confirm, alerts })}`);
      return answer.applyAlertsWrite(alerts, confirm);
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
    packs: () => {
      calls.push("packs");
      return answer.packs();
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
    applySpendingDiff: (draft) => {
      calls.push(`applySpendingDiff ${JSON.stringify(draft)}`);
      return answer.applySpendingDiff(draft);
    },
    applySpendingWrite: (draft, confirm) => {
      calls.push(`applySpendingWrite ${JSON.stringify({ ...confirm, draft })}`);
      return answer.applySpendingWrite(draft, confirm);
    },
    reload: () => {
      calls.push("reload");
      return answer.reload();
    },
    // The Plugins page's: the search and the draft ride in the note.
    plugins: () => {
      calls.push("plugins");
      return answer.plugins();
    },
    gallery: (search) => {
      calls.push(`gallery${search === undefined ? "" : ` ${search}`}`);
      return answer.gallery(search);
    },
    applyPluginsDiff: (draft) => {
      calls.push(`applyPluginsDiff ${JSON.stringify(draft)}`);
      return answer.applyPluginsDiff(draft);
    },
    applyPluginsWrite: (draft, confirm) => {
      calls.push(`applyPluginsWrite ${JSON.stringify({ ...confirm, draft })}`);
      return answer.applyPluginsWrite(draft, confirm);
    },
  };
}
