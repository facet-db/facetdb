import { z } from "zod";

/**
 * The studio's one door to the worker's HTTP surface: every call is a method here, and every
 * response is parsed with zod before the app sees it (a response is a boundary). Each page adds its
 * endpoints as methods with their schemas; the pages call the client through TanStack Query
 * (`useApi()` in api/context.tsx) and never `fetch` themselves. A test passes the fake of
 * src/testing/fake-client.ts through the same `StudioDeps.api`.
 */

/** A refusal from the surface in its one shape: a stable code, the words, and the fix. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly fix: string;

  constructor(status: number, code: string, message: string, fix: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fix = fix;
  }
}

/** The code requireReviewer answers when this browser must sign in. */
export const SIGN_IN_CODE = "sign-in";

/** Whether a failure means "sign in first": the shell then shows the sign-in page. */
export function needsSignIn(error: unknown): boolean {
  return error instanceof ApiError && error.code === SIGN_IN_CODE;
}

const errorBody = z.object({
  error: z.object({ code: z.string(), message: z.string(), fix: z.string() }),
});

/** `GET /v1/project`: the one project this worker serves, and the reviewer on record. */
const projectSchema = z.object({ project: z.string().min(1), reviewer: z.string().min(1) });
export type Project = z.infer<typeof projectSchema>;

/** `GET /v1/review/queue`: the cards waiting for this reviewer, oldest first. */
const queueSchema = z.object({
  count: z.number().int().min(0),
  oldestSince: z.string().nullable(),
  oldestWaitMs: z.number().min(0).nullable(),
  cards: z.array(
    z.object({
      source: z.string(),
      key: z.string(),
      stateHash: z.string(),
      since: z.string(),
      skipped: z.boolean(),
      open: z.array(z.object({ name: z.string(), figure: z.number().min(0).max(1) })),
    }),
  ),
  // Every source the worker runs, with its questions, whatever the filter: what the filters offer.
  sources: z.array(z.object({ name: z.string(), questions: z.array(z.string()) })),
});
export type ReviewQueue = z.infer<typeof queueSchema>;

/** What narrows the queue and `open`: all optional, `below` strictly between 0 and 1. */
export type ReviewFilter = {
  readonly source?: string;
  readonly question?: string;
  readonly below?: number;
};

/** What `open` takes: a filter for the next card, or one record by its source and key (never both). */
export type ReviewOpenTarget = ReviewFilter | { readonly source: string; readonly key: string };

/** The card a request names: its source and the state hash it was opened at (the key rides in the path). */
export type ReviewCardId = {
  readonly source: string;
  readonly key: string;
  readonly stateHash: string;
};

// The review endpoints' answers: a card the reviewer holds is the one answer that carries a
// record's state; the question types are the product's three.
const questionType = z.enum(["noul", "choice", "score"]);
const reviewOption = z.object({
  name: z.string(),
  description: z.string().optional(),
  probability: z.number().min(0).max(1),
});
// The thresholds a question is decided by, resolved by the worker (its stakes defaults with the
// config's override): a yes-or-no pair for a noul, one confidence for a choice or a score.
const reviewThresholds = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("yes-no"),
    yesAbove: z.number().min(0).max(1),
    noBelow: z.number().min(0).max(1),
  }),
  z.object({ kind: z.literal("confidence"), confidenceAtLeast: z.number().min(0).max(1) }),
]);
const reviewOpenQuestion = z.object({
  name: z.string(),
  type: questionType,
  instructions: z.string(),
  said: z.string(),
  figure: z.number().min(0).max(1),
  top: z.string(),
  options: z.array(reviewOption),
  stakes: z.enum(["low", "high"]),
  thresholds: reviewThresholds,
});
const reviewDecidedQuestion = z.object({
  name: z.string(),
  type: questionType,
  instructions: z.string(),
  value: z.union([z.boolean(), z.string()]),
  said: z.string(),
});
const reviewCard = z.object({
  source: z.string(),
  key: z.string(),
  stateHash: z.string(),
  state: z.record(z.string(), z.string().nullable()),
  open: z.array(reviewOpenQuestion),
  decided: z.array(reviewDecidedQuestion),
  since: z.string(),
  lockedUntil: z.string(),
});
export type ReviewCard = z.infer<typeof reviewCard>;
export type ReviewOpenQuestion = z.infer<typeof reviewOpenQuestion>;
export type ReviewDecidedQuestion = z.infer<typeof reviewDecidedQuestion>;

/** `POST /v1/review/open`: the next card under the filter, or null when none is left. */
const openedSchema = z.object({ card: reviewCard.nullable() });
export type ReviewOpened = z.infer<typeof openedSchema>;

const recordStatus = z.enum(["pending", "done", "needs_review", "error", "unchecked", "skipped"]);

/** `POST /v1/review/:key/decide`: the record's status now, the questions still open, the actions that failed. */
const decidedSchema = z.object({
  status: recordStatus,
  open: z.array(z.string()),
  failedActions: z.array(z.string()),
});
export type ReviewDecided = z.infer<typeof decidedSchema>;

/** `POST /v1/review/undo`: the card back in the queue and held by this reviewer, or null when it is not theirs to hold. */
const undoneSchema = z.object({
  status: recordStatus,
  card: reviewCard.nullable(),
  failedActions: z.array(z.string()),
});
export type ReviewUndone = z.infer<typeof undoneSchema>;

const renewedSchema = z.object({ lockedUntil: z.string() });
const skippedSchema = z.object({ skipped: z.literal(true) });
const releasedSchema = z.object({ released: z.literal(true) });

/**
 * `GET /v1/home` as the rail's instrument and the Home page read it: the health checks, the records
 * answered today, the review queue, the month's spending against the cap and the recent alerts,
 * each figure with the words the page shows. Fields the studio does not name are dropped here,
 * never refused, so the server may add some.
 */
const figureWords = z.object({ figure: z.string(), sub: z.string() });

const homeSchema = z.object({
  health: z.object({
    status: z.enum(["running", "attention"]),
    words: z.string(),
    heartbeatAgeMs: z.number().min(0).nullable(),
    checks: z.array(
      z.object({
        name: z.enum(["worker", "model", "sources"]),
        status: z.enum(["ok", "warn", "fail"]),
        words: z.string(),
      }),
    ),
    sources: z.array(
      z.object({
        name: z.string(),
        verdict: z.enum(["healthy", "warning", "failing"]),
        words: z.string(),
      }),
    ),
  }),
  answered: z.object({
    today: z.number().int().min(0),
    yesterday: z.number().int().min(0),
    fraction: z.number().min(0).max(1).nullable(),
    words: figureWords,
  }),
  queue: z.object({
    waiting: z.number().int().min(0),
    oldestWaitMs: z.number().min(0).nullable(),
    decidedToday: z.number().int().min(0),
    reviewersToday: z.number().int().min(0),
    words: figureWords,
  }),
  spending: z.object({
    status: z.enum(["ok", "warned", "paused", "continuing", "uncapped"]),
    month: z.string(),
    /** This month's billable input tokens, which an estimate is set against what is left of the cap. */
    inputTokens: z.number().int().min(0),
    dollars: z.number().min(0),
    // The cap the worker enforces: as it started, and what it does at 100%.
    cap: z
      .object({
        inputTokens: z.number(),
        dollars: z.number().min(0),
        onCapReached: z.enum(["pause", "continue"]),
      })
      .nullable(),
    fraction: z.number().min(0).max(1).nullable(),
    words: figureWords,
  }),
  alerts: z.array(
    z.object({
      at: z.iso.datetime(),
      phase: z.enum(["raised", "resolved"]),
      severity: z.enum(["information", "warning", "critical"]),
      badge: z.string(),
      title: z.string(),
      words: z.string(),
      link: z.string(),
    }),
  ),
});
export type Home = z.infer<typeof homeSchema>;
export type HomeAlert = Home["alerts"][number];

/** `POST /v1/session`: who signed in, and until when. */
const signedInSchema = z.object({ reviewer: z.string().min(1), expiresAt: z.string() });
export type SignedIn = z.infer<typeof signedInSchema>;

const signedOutSchema = z.object({ signedOut: z.literal(true) });

/*
 * The Decisions page and the why page: the log of one source, one record's history, the run log and
 * the sources' names.
 */

/**
 * What an answer came to, as the worker tags it beside the words: an option or a level may be named
 * "needs review" or "unknown", so the page reads the tag and shows the words.
 */
const decisionOutcomeSchema = z.enum(["decided", "needs_review", "unknown"]);
export type DecisionOutcome = z.infer<typeof decisionOutcomeSchema>;

/** One model answer as the log search carries it: the raw figures and what its version's thresholds made of it. */
const loggedAnswerSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    probability: z.number(),
    decision: z.string(),
    outcome: decisionOutcomeSchema,
  }),
  z.object({
    type: z.literal("choice"),
    top: z.string(),
    probabilities: z.array(z.number()),
    decision: z.string(),
    outcome: decisionOutcomeSchema,
  }),
  z.object({
    type: z.literal("score"),
    probabilities: z.array(z.number()),
    confidence: z.number(),
    /** The most likely level's name by the levels of its version; empty when the worker no longer keeps that version. */
    value: z.string(),
    decision: z.string(),
    outcome: decisionOutcomeSchema,
  }),
]);
export type LoggedAnswer = z.infer<typeof loggedAnswerSchema>;

/** One row of the decision log (`GET /v1/decisions`), in the export's shape: a model call or a person's decision. */
const decisionRowSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    time: z.string(),
    record_key: z.string(),
    version: z.number(),
    model: z.string(),
    answers: z.record(z.string(), loggedAnswerSchema),
  }),
  z.object({
    kind: z.literal("human"),
    time: z.string(),
    record_key: z.string(),
    version: z.number(),
    question: z.string(),
    value: z.string(),
    decision: z.string(),
    decided_by: z.string(),
    /** A reviewer took back their own decision: the row is an undo, whatever its word says. */
    withdrawn: z.boolean(),
    note: z.string().optional(),
  }),
]);
export type DecisionRow = z.infer<typeof decisionRowSchema>;

const decisionsPageSchema = z.object({
  decisions: z.array(decisionRowSchema),
  /** The cursor of the page after this one, as the worker made it; null on the last page. */
  next: z.string().nullable(),
});
export type DecisionsPage = z.infer<typeof decisionsPageSchema>;

/** The filters of `GET /v1/decisions`: the source is required, every other one narrows the log. */
export type DecisionFilters = {
  readonly source: string;
  readonly key?: string;
  readonly question?: string;
  readonly status?: "decided" | "needs_review";
  readonly reviewer?: string;
  /** ISO 8601, included. */
  readonly from?: string;
  /** ISO 8601, not included (a digest's link). */
  readonly to?: string;
};

/** `GET /v1/decisions/:source/:key`: the entries `facetdb explain` prints, oldest first, in its words. */
const explainedEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    at: z.string(),
    model: z.string(),
    version: z.number(),
    /** The hash of the state the model was shown: another hash on a later answer is a changed record. */
    stateHash: z.string(),
    answers: z.array(
      z.object({
        question: z.string(),
        wording: z.string(),
        said: z.string(),
        decision: z.string(),
        outcome: decisionOutcomeSchema,
      }),
    ),
  }),
  z.object({
    kind: z.literal("human"),
    at: z.string(),
    version: z.number(),
    /** The state the reviewer saw; the decision stands while the record still has it. */
    stateHash: z.string(),
    question: z.string(),
    wording: z.string(),
    decided: z.string(),
    reviewer: z.string(),
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal("withdrawal"),
    at: z.string(),
    version: z.number(),
    stateHash: z.string(),
    question: z.string(),
    wording: z.string(),
    reviewer: z.string(),
  }),
]);
export type ExplainedEntry = z.infer<typeof explainedEntrySchema>;

const decisionHistorySchema = z.object({
  source: z.string(),
  key: z.string(),
  /**
   * The record's status now, read from the record itself, and whether a person ever decided one
   * of its questions; both null when the source does not run in the worker or the record is gone.
   */
  status: recordStatus.nullable(),
  reviewed: z.boolean().nullable(),
  entries: z.array(explainedEntrySchema),
});
export type DecisionHistory = z.infer<typeof decisionHistorySchema>;

/** `GET /v1/runs`: one page of the run log, newest first, 50 a page. */
const runsPageSchema = z.object({
  runs: z.array(
    z.object({
      source: z.string(),
      kind: z.enum(["pass", "backfill"]),
      startedAt: z.string(),
      endedAt: z.string(),
      claimed: z.number(),
      answered: z.number(),
      toReview: z.number(),
      errors: z.number(),
      discarded: z.number(),
      tokens: z.number(),
    }),
  ),
  page: z.number(),
  perPage: z.number(),
  more: z.boolean(),
});
export type RunsPage = z.infer<typeof runsPageSchema>;
export type Run = RunsPage["runs"][number];

/**
 * `GET /v1/config`, the source names only: the project JSON is answered from the worker's memory
 * and touches no source database, unlike `GET /v1/sources`, whose doctors connect to each one.
 */
const sourceNamesSchema = z.object({ sources: z.array(z.object({ name: z.string().min(1) })) });

/*
 * The Alerts and Settings pages: the alert channels and history, the reviewer accounts, who may
 * open the studio, and the project's spending cap.
 */

/** `GET /v1/alerts`: the channels as a kind and a name (never a setting), and the history newest first. */
const alertsSchema = z.object({
  /**
   * The channels the worker runs with (the config as it started): what each sends, its quiet hours,
   * whether the worker bound it, and its newest delivery.
   */
  channels: z.array(
    z.object({
      kind: z.string().min(1),
      name: z.string().nullable(),
      address: z.string().nullable(),
      sends: z.enum(["critical", "warnings", "everything"]),
      quiet: z.object({ from: z.string(), to: z.string(), zone: z.string().nullable() }).nullable(),
      bound: z.boolean(),
      delivering: z.boolean().nullable(),
      last: z
        .object({
          at: z.iso.datetime(),
          kind: z.string(),
          title: z.string(),
          phase: z.enum(["raised", "resolved"]),
          ok: z.boolean(),
          error: z.string().nullable(),
        })
        .nullable(),
      /**
       * Its latest quiet-hours summary that had something to say: sent at `at`, or tried at `at`
       * and not taken yet, `failing` once a try past its retry was not taken either. Never a
       * history line, so `last` never holds it.
       */
      summary: z
        .object({ at: z.iso.datetime(), sent: z.boolean(), failing: z.boolean() })
        .nullable(),
    }),
  ),
  /** True when facetdb.config.ts names other channels than the ones in force (not reloaded, or not bindable). */
  fileChannelsDiffer: z.boolean(),
  /** The worker machine's time zone, which quiet hours with no zone are read in; null when unreadable. */
  workerZone: z.string().nullable(),
  events: z.array(
    z.object({
      at: z.iso.datetime(),
      kind: z.string(),
      severity: z.enum(["information", "warning", "critical"]),
      title: z.string(),
      what: z.string(),
      project: z.string(),
      source: z.string(),
      question: z.string().nullable(),
      did: z.string(),
      link: z.string(),
      // `raised` is a kind nothing ever resolves: it says when it was raised and nothing more.
      standing: z.discriminatedUnion("phase", [
        z.object({ phase: z.literal("open") }),
        z.object({ phase: z.literal("resolved"), at: z.iso.datetime() }),
        z.object({ phase: z.literal("raised") }),
      ]),
      /** A resolved message whose alert was raised before the history the worker reads. */
      raisedBeforeHistory: z.boolean(),
      delivered: z.boolean(),
      /** Its channels were still being tried, or the worker stopped first: not known whether any took it. */
      pending: z.boolean(),
      /** The channels whose quiet hours held it, named as `channels` names them. */
      held: z.array(
        z.object({ kind: z.string(), name: z.string().nullable(), address: z.string().nullable() }),
      ),
    }),
  ),
  /** The most history lines the worker reads; `capped` says older ones exist. */
  limit: z.number().int().positive(),
  capped: z.boolean(),
});
export type Alerts = z.infer<typeof alertsSchema>;
export type AlertEvent = Alerts["events"][number];
export type AlertChannel = Alerts["channels"][number];

/*
 * The Alerts page's channels: the test button, the channels as the config in force writes them, and
 * Apply of a project draft's `alerts`. The channel plugins a channel can be added with are the
 * Plugins page's reads (`plugins`, `gallery`).
 */

/** `POST /v1/alerts/test`: the channel took the test message. */
const alertTestSentSchema = z.object({ sent: z.literal(true) });

const sendsSchema = z.enum(["critical", "warnings", "everything"]);
export type ChannelSends = z.infer<typeof sendsSchema>;

/** One channel as the project JSON writes it: an address, or the address under `to` with its settings. */
const channelEntrySchema = z.union([
  z.string(),
  z.object({
    to: z.string(),
    sends: sendsSchema.exactOptional(),
    quiet: z
      .object({ from: z.string(), to: z.string(), zone: z.string().exactOptional() })
      .exactOptional(),
  }),
]);
export type AlertChannelEntry = z.infer<typeof channelEntrySchema>;

/** `GET /v1/config`, `alerts` only: the channels in the file's own form, which a draft is built over. */
const alertsConfigSchema = z.object({
  alerts: z.object({ channels: z.array(channelEntrySchema) }).exactOptional(),
});

/** A project draft's `alerts`: the whole list, or null for no channel at all. */
export type AlertsDraft = { readonly channels: readonly AlertChannelEntry[] } | null;

/** `GET /v1/studio`: the host the studio listens on, whether only this machine can reach it, and the accounts. */
const studioAccessSchema = z.object({
  host: z.string().min(1),
  loopback: z.boolean(),
  reviewers: z.number().int().min(0),
  /** Whether the worker's login may make an account; false in the default install (select only). */
  accountsWritable: z.boolean(),
});
export type StudioAccess = z.infer<typeof studioAccessSchema>;

/** `GET /v1/reviewers`: the accounts `facetdb users add` makes; a name and when it was made, never a hash. */
const reviewersSchema = z.object({
  reviewers: z.array(z.object({ name: z.string().min(1), createdAt: z.iso.datetime() })),
});
export type ReviewerAccounts = z.infer<typeof reviewersSchema>["reviewers"];

/** `POST /v1/reviewers`: the account made. */
const reviewerAddedSchema = z.object({ name: z.string().min(1), added: z.literal(true) });

/** `GET /v1/config`, the project-level cap only: the rest of the project JSON is other pages' to read. */
const spendingConfigSchema = z.object({
  spendingCap: z.number().int().positive().optional(),
  onCapReached: z.enum(["pause", "continue"]),
});
/** The month's cap in billable input tokens (null when the config sets none), and what happens at 100%. */
export type SpendingConfig = {
  readonly tokens: number | null;
  readonly onCapReached: "pause" | "continue";
};

/**
 * Settings' save of the spending cap, as `POST /v1/apply` takes a project draft: the cap in
 * billable input tokens, null removing it, and what happens at 100%.
 */
export type SpendingDraft = {
  readonly spendingCap: number | null;
  readonly onCapReached: "pause" | "continue";
};

/*
 * The Questions page: the project's configuration with each source's version history, a draft's
 * judgement, its live preview, its test against the version in force, and Apply.
 */

const stakesSchema = z.enum(["low", "high"]);

/** One question as the project JSON writes it (the exporter's `Omit<Question, "name">`). */
const questionJsonSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("noul"),
    instructions: z.string(),
    criteria: z
      .object({ true: z.string().exactOptional(), false: z.string().exactOptional() })
      .exactOptional(),
    stakes: stakesSchema,
  }),
  z.object({
    type: z.literal("choice"),
    instructions: z.string(),
    options: z.array(z.object({ name: z.string(), description: z.string() })),
    stakes: stakesSchema,
    storeProbabilities: z.boolean(),
  }),
  z.object({
    type: z.literal("score"),
    instructions: z.string(),
    levels: z.array(z.object({ name: z.string(), description: z.string().exactOptional() })),
    stakes: stakesSchema,
  }),
]);
export type QuestionJson = z.infer<typeof questionJsonSchema>;

/** A question's thresholds as the config overrides them; a key left out is the stakes default. */
const thresholdOverrideSchema = z.object({
  yesAbove: z.number().min(0).max(1).exactOptional(),
  noBelow: z.number().min(0).max(1).exactOptional(),
  confidenceAtLeast: z.number().min(0).max(1).exactOptional(),
});
export type ThresholdOverride = z.infer<typeof thresholdOverrideSchema>;

/** A source of the project JSON, the fields the Questions page reads; the rest are the file's. */
const configSourceSchema = z.object({
  name: z.string().min(1),
  /** The variable a table source reads its connection from (the setup flow suggests one, 117). */
  database: z.object({ env: z.string() }).exactOptional(),
  /** The table a table source reads, as the config names it (the setup flow reads it, 117). */
  table: z.string().exactOptional(),
  read: z.array(z.string()),
  where: z.string().exactOptional(),
  model: z.string().exactOptional(),
  questions: z.record(z.string(), questionJsonSchema),
  thresholds: z.record(z.string(), thresholdOverrideSchema),
});
export type ConfigSource = z.infer<typeof configSourceSchema>;

/**
 * A source whose loop does not run the file as last loaded: written to facetdb.config.ts, and
 * waiting for `facetdb migrate` and a restart of the worker.
 */
const pendingSourceSchema = z.object({
  source: z.string(),
  outcome: z.enum(["kept", "not-started"]),
  /** The reload's own words: why it is not running yet. */
  message: z.string(),
  /** False for a source that answers through POST /v1/check: it has no install to migrate. */
  migrate: z.boolean(),
  /** Questions the file holds that the loop does not run. */
  added: z.array(z.string()),
  /** Questions the loop runs that the file no longer holds. */
  removed: z.array(z.string()),
  /** A reload switches it once its database holds the change: "Check again" asks for one. */
  checkAgain: z.boolean(),
});
export type PendingSource = z.infer<typeof pendingSourceSchema>;

/**
 * `GET /v1/config`: the project JSON, each source's question-set versions by name, and the sources
 * that do not run the file yet (empty when every loop runs it).
 */
const projectConfigSchema = z.object({
  model: z.string(),
  sources: z.array(configSourceSchema),
  pending: z.array(pendingSourceSchema),
  versions: z.record(
    z.string(),
    z.object({
      /** The version the worker answers under now; null when it does not run the source. */
      inForce: z.number().int().nullable(),
      /** Newest first: the number, when a worker first ran it, what changed in words. */
      versions: z.array(
        z.object({ version: z.number().int(), createdAt: z.string(), changes: z.string() }),
      ),
      /** Older versions are kept than the ones listed. */
      earlier: z.boolean(),
      /** What of the history could not be read from the store, in words; null when all of it was. */
      note: z.string().nullable(),
    }),
  ),
});
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type SourceVersions = ProjectConfig["versions"][string];

/**
 * `GET /v1/packs`: the question packs of the plugins the worker hosts, each in the shape a source
 * draft takes, for "Start from a pack". `reads` is null when the pack does not say which state
 * fields its questions read.
 */
const packsSchema = z.object({
  packs: z.array(
    z.object({
      plugin: z.string().min(1),
      package: z.string().min(1),
      name: z.string().min(1),
      description: z.string().nullable(),
      reads: z.array(z.string()).nullable(),
      questions: z.record(z.string(), questionJsonSchema),
      thresholds: z.record(z.string(), thresholdOverrideSchema),
    }),
  ),
});
export type QuestionPack = z.infer<typeof packsSchema>["packs"][number];

/** What the page sends: one source by name, its questions and thresholds, merged over the file's. */
export type SourceDraft = {
  readonly name: string;
  readonly questions: Readonly<Record<string, QuestionJson>>;
  readonly thresholds: Readonly<Record<string, ThresholdOverride>>;
};

/** A wording warning in the CLI's shape: the words `facetdb preview` prints. */
const wordingWarningSchema = z.object({
  source: z.string(),
  question: z.string().nullable(),
  code: z.string(),
  message: z.string(),
  fix: z.string(),
});
export type WordingWarning = z.infer<typeof wordingWarningSchema>;

/** `POST /v1/config/validate`: the loader's problems by field path, or its warnings. */
const draftValidationSchema = z.object({
  valid: z.boolean(),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
  warnings: z.array(wordingWarningSchema),
});
export type DraftValidation = z.infer<typeof draftValidationSchema>;
export type DraftIssue = DraftValidation["issues"][number];

const probability = z.number().min(0).max(1);

/** One model answer with every probability, so a threshold is re-applied without a call. */
const previewAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), probability }),
  z.object({ type: z.literal("choice"), top: z.string(), probabilities: z.array(probability) }),
  z.object({
    type: z.literal("score"),
    probabilities: z.array(probability),
    confidence: probability,
  }),
]);
export type PreviewAnswer = z.infer<typeof previewAnswerSchema>;

const costSchema = z.object({ inputTokens: z.number().min(0), dollars: z.number().min(0) });
export type Cost = z.infer<typeof costSchema>;

/** `POST /v1/preview`: the newest rows, each answered or skipped with why, and what it cost. */
const draftPreviewSchema = z.object({
  rows: z.array(
    z.discriminatedUnion("kind", [
      z.object({ key: z.string(), kind: z.literal("skipped"), reason: z.string() }),
      z.object({
        key: z.string(),
        kind: z.literal("answered"),
        state: z.record(z.string(), z.string().nullable()),
        model: z.string(),
        answers: z.record(z.string(), previewAnswerSchema),
      }),
    ]),
  ),
  decided: z.number().int().min(0),
  review: z.number().int().min(0),
  cost: costSchema,
  warnings: z.array(wordingWarningSchema),
});
export type DraftPreview = z.infer<typeof draftPreviewSchema>;
export type PreviewRow = DraftPreview["rows"][number];

/** What a test would read, ask and cost, before anything is asked. */
const testEstimateSchema = z.object({
  sampleRecords: z.number().int().min(0),
  reviewedRecords: z.number().int().min(0),
  requests: z.number().int().min(0),
  inputTokens: z.number().min(0),
  dollars: z.number().min(0),
});
export type TestEstimate = z.infer<typeof testEstimateSchema>;

const testEstimatedSchema = z.object({
  estimate: testEstimateSchema,
  warnings: z.array(wordingWarningSchema),
});

const agreementSideSchema = z.object({
  agreed: z.number().int().min(0),
  disagreed: z.number().int().min(0),
  unsure: z.number().int().min(0),
  rate: probability.nullable(),
});
export type AgreementSide = z.infer<typeof agreementSideSchema>;

/** `POST /v1/test` run: per question of the draft, what would change and the agreement with people. */
const testResultSchema = z.object({
  sample: z.object({ records: z.number().int().min(0), asked: z.number().int().min(0) }),
  reviewed: z.object({ records: z.number().int().min(0), asked: z.number().int().min(0) }),
  skipped: z.record(z.string(), z.number().int().min(0)),
  removed: z.array(z.string()),
  questions: z.array(
    z.object({
      question: z.string(),
      comparison: z.enum(["compared", "new", "kind-changed"]),
      compared: z.number().int().min(0),
      changed: z.number().int().min(0),
      toDecided: z.number().int().min(0),
      toReview: z.number().int().min(0),
      toAnotherValue: z.number().int().min(0),
      noCurrentAnswer: z.number().int().min(0),
      keptForPeople: z.number().int().min(0),
      agreement: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("none"), reason: z.string() }),
        z.object({
          kind: z.literal("measured"),
          records: z.number().int().min(0),
          now: agreementSideSchema.nullable(),
          draft: agreementSideSchema,
        }),
      ]),
    }),
  ),
  cost: costSchema,
  estimate: testEstimateSchema,
  warnings: z.array(wordingWarningSchema),
});
export type TestResult = z.infer<typeof testResultSchema>;
export type TestQuestionRow = TestResult["questions"][number];

/** A refusal or a note in plain words, with what to do about it. */
const wordsSchema = z.object({ message: z.string(), fix: z.string() });

/**
 * Why the write is refused without `force`: what git says of the file, which the studio words its
 * own way, and the terminal's words (they name commands and `force`, so the page does not show them).
 */
const uncommittedSchema = wordsSchema.extend({
  state: z.enum(["modified", "untracked", "ignored", "no-repository", "no-git", "unreadable"]),
});
export type UncommittedState = z.infer<typeof uncommittedSchema>["state"];

/** `POST /v1/apply` without `confirm`: the file's diff and the plan that names it; nothing written. */
const applyDiffSchema = z.object({
  written: z.literal(false),
  path: z.string(),
  diff: z.string(),
  changed: z.boolean(),
  plan: z.string(),
  uncommitted: uncommittedSchema.nullable(),
  /** The file holds lines of the person's own (comments, code) the whole-file write drops. */
  dropsOwnText: z.boolean(),
  warnings: z.array(wordingWarningSchema),
});
export type ApplyDiff = z.infer<typeof applyDiffSchema>;

const reloadSchema = z.discriminatedUnion("loaded", [
  z.object({
    loaded: z.literal(true),
    sources: z.array(
      z.object({
        source: z.string(),
        outcome: z.enum([
          "unchanged",
          "restarted",
          "stopped",
          "started",
          "not-started",
          "kept",
          "failed",
        ]),
        version: z.number().int().nullable(),
        message: z.string().nullable(),
      }),
    ),
    notes: z.array(z.string()),
  }),
  z.object({ loaded: z.literal(false), message: z.string(), fix: z.string() }),
]);
export type ApplyReload = z.infer<typeof reloadSchema>;

/** `POST /v1/apply` with `confirm`: written and reloaded, or nothing to write after all. */
const applyWrittenSchema = z.discriminatedUnion("written", [
  z.object({ written: z.literal(true), path: z.string(), diff: z.string(), reload: reloadSchema }),
  z.object({ written: z.literal(false), path: z.string(), changed: z.literal(false) }),
]);
export type ApplyWritten = z.infer<typeof applyWrittenSchema>;

/*
 * The Sources page and the setup flow: GET /v1/sources, and the setup's endpoints. The admin
 * connection string is a body of the setup's four requests and nothing else: in no address, no
 * error this client makes (they name the path, never the body), and the client keeps no copy.
 */

/** One labelled line of a source's row: `Wakes`, `Arrives`, `Login`. */
const sourceLineSchema = z.object({ label: z.string(), words: z.string() });

/** `GET /v1/sources`: a ruled row per source, in the words of the Sources page. */
const sourcesSchema = z.object({
  sources: z.array(
    z.object({
      name: z.string().min(1),
      kind: z.enum(["table", "api", "plugin"]),
      connector: z.string(),
      install: z
        .object({ status: z.enum(["ok", "fail", "skip", "warn"]), words: z.string() })
        .nullable(),
      how: sourceLineSchema,
      lastChangeAt: z.string().nullable(),
      answers: z.string(),
      /** The database's estimate of the table's rows; null when unknown, and for an API source. */
      rows: z.number().int().nonnegative().nullable(),
      backfill: z.object({
        state: z.enum(["none", "part-way", "finished"]),
        fraction: probability.nullable(),
        words: z.string(),
      }),
      login: sourceLineSchema.nullable(),
    }),
  ),
});
export type SourceRow = z.infer<typeof sourcesSchema>["sources"][number];

/** `GET /v1/sources/setup`: whether this browser may add a source here, and if not why. */
const setupAccessSchema = z.discriminatedUnion("open", [
  z.object({ open: z.literal(true) }),
  z.object({ open: z.literal(false), code: z.string(), message: z.string(), fix: z.string() }),
]);
export type SetupAccess = z.infer<typeof setupAccessSchema>;

/** `POST /v1/sources/inspect`: the tables, and for one its columns, its key and five rows. */
const inspectionSchema = z.object({
  database: z.string(),
  tables: z.array(z.string()),
  /**
   * A source the file already reads in this very database, and the variable it reads it through:
   * the variable to suggest, so one database stays one string (two variables holding one string
   * leave Apply unable to tell which source reads which).
   */
  sharedWith: z.object({ source: z.string(), variable: z.string() }).nullable(),
  table: z
    .object({
      name: z.string(),
      key: z.string().nullable(),
      columns: z.array(z.object({ name: z.string(), type: z.string() })),
      rows: z.array(z.record(z.string(), z.string().nullable())),
      /** The database's estimate of the table's rows from its statistics; null when it has none. */
      estimatedRows: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
});
export type Inspection = z.infer<typeof inspectionSchema>;
export type InspectedTable = NonNullable<Inspection["table"]>;

/** What the setup sends: a new source in the project JSON's shape, its connection by variable. */
export type SetupDraft = SourceDraft & {
  readonly table: string;
  readonly database: { readonly env: string };
  readonly read: readonly string[];
  readonly where?: string;
  readonly storage: "inline" | "side-table";
};

/** `POST /v1/sources/plan`: the install as `facetdb migrate --dry-run` prints it, and the diff. */
const setupPlanSchema = z.object({
  token: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  table: z.string(),
  sql: z.string(),
  transactional: z.boolean(),
  path: z.string(),
  diff: z.string(),
  uncommitted: uncommittedSchema.nullable(),
  warnings: z.array(wordingWarningSchema),
  backfill: z.object({
    records: z.number().int().min(0),
    inputTokens: z.number().min(0),
    dollars: z.number().min(0),
    pace: z.number().positive(),
    seconds: z.number().int().min(0),
    command: z.string(),
    /** The records counted by the database's statistics (an estimate), or the rows read. */
    counted: z.enum(["statistics", "rows-read"]),
  }),
  /**
   * The store is another database than the source's. Migrate prints the store's part above this
   * script wherever the store is, so the page's words do not depend on it.
   */
  storeElsewhere: z.boolean(),
});
export type SetupPlan = z.infer<typeof setupPlanSchema>;

/**
 * Whether the worker answers the new source now: the reload after the install started it, under
 * this version; or it did not, with the reload's own why and how to restart the worker.
 */
const setupWorkerSchema = z.discriminatedUnion("running", [
  z.object({ running: z.literal(true), version: z.number().int(), words: z.string() }),
  z.object({ running: z.literal(false), why: z.string(), restart: z.string() }),
]);
export type SetupWorker = z.infer<typeof setupWorkerSchema>;

/** `POST /v1/sources/install`: installed, the file written, whether it runs, and the backfill. */
const setupInstalledSchema = z.object({
  installed: z.literal(true),
  table: z.string(),
  path: z.string(),
  reload: reloadSchema,
  worker: setupWorkerSchema,
  backfill: z.string(),
});
export type SetupInstalled = z.infer<typeof setupInstalledSchema>;

/**
 * `POST /v1/sources/:name/migrate/plan`: an added question's install as `facetdb migrate
 * --source <name> --dry-run` prints the source's part, with the token that runs exactly it.
 */
const migratePlanSchema = z.object({
  token: z.string().min(1),
  expiresInSeconds: z.number().int().positive(),
  table: z.string(),
  sql: z.string(),
  transactional: z.boolean(),
  /** The questions the file adds to what the source runs. */
  questions: z.array(z.string()),
  /** The store is another database; migrate prints its part above this one wherever it is. */
  storeElsewhere: z.boolean(),
});
export type MigratePlan = z.infer<typeof migratePlanSchema>;

/** `POST /v1/sources/:name/migrate/run`: the install ran, and the worker reloaded the file. */
const migratedSchema = z.object({
  migrated: z.literal(true),
  table: z.string(),
  reload: reloadSchema,
});
export type Migrated = z.infer<typeof migratedSchema>;

/**
 * A source's backfill from the page: where the job stands, as `GET /v1/sources/:name/backfill` and
 * the three POSTs answer it. The nine states are the door's
 * (packages/server/src/sources/backfill-door.ts); `words` is the worker's own sentence for the
 * state, and the page composes the estimate's line from the figures.
 */
const backfillStateSchema = z.enum([
  "idle",
  "estimating",
  "waiting",
  "running",
  "stopping",
  "stopped",
  "finished",
  "failed",
  "paused",
]);
const backfillEstimateSchema = z.object({
  records: z.number().int().min(0),
  sampled: z.number().int().min(0),
  tokensPerRecord: z.number().min(0),
  tokens: z.number().min(0),
  dollars: z.number().min(0),
});
const backfillStatusSchema = z.object({
  source: z.string().min(1),
  state: backfillStateSchema,
  /** The added questions the job asks alone; null for the whole question set. */
  questions: z.array(z.string()).nullable(),
  version: z.number().nullable(),
  /** Records the survey has counted so far, while estimating. */
  surveyed: z.number().int().min(0).nullable(),
  estimate: backfillEstimateSchema.nullable(),
  /** Records started per second. */
  pace: z.number().positive().nullable(),
  /** What a start takes; only while waiting. */
  token: z.string().nullable(),
  /** When an estimate nobody started is dropped; only while waiting. */
  expiresAt: z.string().nullable(),
  counts: z
    .object({
      records: z.number().int().min(0),
      queued: z.number().int().min(0),
      answered: z.number().int().min(0),
      alreadyAnswered: z.number().int().min(0),
      deferred: z.number().int().min(0),
    })
    .nullable(),
  since: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** Why it stopped, failed or paused, in the worker's words. */
  why: z.string().nullable(),
  words: z.string(),
});
export type BackfillStatus = z.infer<typeof backfillStatusSchema>;
export type BackfillState = BackfillStatus["state"];
export type BackfillEstimate = z.infer<typeof backfillEstimateSchema>;

/*
 * The Plugins page: GET /v1/plugins and GET /v1/plugins/gallery, and a plugin's settings saved
 * through Apply as a project draft. A setting's schema and its values are JSON the page reads with
 * its own narrow questions; a variable is its name and whether it is set, never a value.
 */

/** A JSON object the page reads without trusting its shape: a settings schema, a plugin's values. */
const jsonObjectSchema = z.record(z.string(), z.json());

const pluginKindSchema = z.enum(["source", "action", "channel", "provider", "pack"]);
export type PluginKind = z.infer<typeof pluginKindSchema>;

const installedPluginSchema = z.object({
  name: z.string().min(1),
  /** Its key in the config's `plugins`: what a draft names it by. */
  key: z.string().min(1),
  version: z.string(),
  builtIn: z.boolean(),
  /** The names of what it provides, by kind. */
  provides: z.record(pluginKindSchema, z.array(z.string())),
  core: z.object({ range: z.string(), holds: z.boolean() }),
  settings: z.object({
    /** The JSON schema of its settings (`secret` and `editable` marks on fields), or null. */
    schema: jsonObjectSchema.nullable(),
    /** As the file writes them: a variable is `{ "env": "NAME" }`. */
    values: jsonObjectSchema,
    variables: z.array(
      z.object({
        path: z.string(),
        variable: z.string(),
        secret: z.boolean(),
        set: z.boolean(),
      }),
    ),
    /** Where `values` holds an address cut to its host. */
    hostOnly: z.array(z.string()),
  }),
});
export type InstalledPlugin = z.infer<typeof installedPluginSchema>;

const pluginsSchema = z.object({
  /** The FacetDB the worker runs; empty when the surface hosts no plugin. */
  facetdb: z.string(),
  plugins: z.array(installedPluginSchema),
});
export type InstalledPlugins = z.infer<typeof pluginsSchema>;

const galleryEntrySchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  kinds: z.array(pluginKindSchema),
  /** Whether its core range holds for the FacetDB the worker runs. */
  holds: z.boolean(),
  verified: z.boolean(),
  downloads: z.number().int().min(0),
  installed: z.boolean(),
  // The answer's `command` is not read: the page builds `facetdb add <name>` from a short name.
});
export type GalleryEntry = z.infer<typeof galleryEntrySchema>;

const gallerySchema = z.discriminatedUnion("reachable", [
  z.object({
    reachable: z.literal(true),
    address: z.string(),
    plugins: z.array(galleryEntrySchema),
  }),
  z.object({ reachable: z.literal(false), address: z.string(), why: z.string() }),
]);
export type Gallery = z.infer<typeof gallerySchema>;

/**
 * Plugin settings saved through Apply, by the plugin's key in `plugins`: each entry replaces that
 * plugin's settings whole, and only what its schema marks editable may differ from the file's.
 */
export type PluginsDraft = { readonly [key: string]: { readonly [setting: string]: unknown } };

export type ApiClient = {
  readonly project: () => Promise<Project>;
  readonly reviewQueue: (
    options?: ReviewFilter & { readonly limit?: number },
  ) => Promise<ReviewQueue>;
  // The Review page: the card's life, one method per endpoint.
  /** The next card under a filter, or the one record named by its source and key. */
  readonly reviewOpen: (target?: ReviewOpenTarget) => Promise<ReviewOpened>;
  readonly reviewRenew: (card: ReviewCardId) => Promise<{ readonly lockedUntil: string }>;
  readonly reviewDecide: (
    card: ReviewCardId,
    decision: {
      readonly question: string;
      readonly value: boolean | string;
      readonly note?: string;
    },
  ) => Promise<ReviewDecided>;
  readonly reviewSkip: (card: ReviewCardId) => Promise<void>;
  /** Also sent as the page closes, so it asks the browser to finish the request after the page is gone. */
  readonly reviewRelease: (card: ReviewCardId) => Promise<void>;
  readonly reviewUndo: () => Promise<ReviewUndone>;
  readonly home: () => Promise<Home>;
  readonly signIn: (name: string, password: string) => Promise<SignedIn>;
  readonly signOut: () => Promise<void>;
  /** The names of the project's sources, in the config's order (the Decisions page's source choice). */
  readonly sourceNames: () => Promise<readonly string[]>;
  /** One page of one source's log, newest first; `cursor` is the previous page's `next`. */
  readonly decisions: (filters: DecisionFilters, cursor?: string) => Promise<DecisionsPage>;
  /**
   * One record's history; the key is as the log shows it, encoded once into the path here, or
   * into the query for a key of `.` or `..` (isDotSegment).
   */
  readonly decisionHistory: (source: string, key: string) => Promise<DecisionHistory>;
  /** One page of the run log from 1; one source by name, or every source. */
  readonly runs: (options: {
    readonly source?: string;
    readonly page: number;
  }) => Promise<RunsPage>;
  // The Alerts and Settings pages.
  readonly alerts: () => Promise<Alerts>;
  // The Alerts page's channels.
  /** Sends one test message through the channel at `address` now; resolves when the channel took it. */
  readonly testAlertChannel: (address: string) => Promise<void>;
  /** The channels as facetdb.config.ts writes them (the worker's config in force); empty for none. */
  readonly alertChannelsInFile: () => Promise<readonly AlertChannelEntry[]>;
  /** The diff the channels draft makes to facetdb.config.ts, and its plan; nothing is written. */
  readonly applyAlertsDiff: (alerts: AlertsDraft) => Promise<ApplyDiff>;
  /** Writes the channels draft the plan names; the worker's reload puts them in force at once. */
  readonly applyAlertsWrite: (
    alerts: AlertsDraft,
    confirm: { readonly plan: string; readonly force: boolean },
  ) => Promise<ApplyWritten>;
  readonly studioAccess: () => Promise<StudioAccess>;
  readonly reviewers: () => Promise<ReviewerAccounts>;
  /**
   * Makes a reviewer account, as `facetdb users add` does. The password is a request's body and
   * nothing else: it is in no address, and the client keeps no copy of it.
   */
  readonly addReviewer: (name: string, password: string) => Promise<void>;
  readonly spendingConfig: () => Promise<SpendingConfig>;
  // The Questions page: one method per endpoint.
  /** The project JSON from the worker's memory, and each source's version history. */
  readonly projectConfig: () => Promise<ProjectConfig>;
  /** The question packs of the hosted plugins, for "Start from a pack". */
  readonly packs: () => Promise<readonly QuestionPack[]>;
  /** The loader's judgement of a draft: its problems by field path, or its wording warnings. */
  readonly validateDraft: (draft: SourceDraft) => Promise<DraftValidation>;
  /** The draft asked of the 20 newest rows: one model call per row, under the spending cap. */
  readonly previewDraft: (draft: SourceDraft) => Promise<DraftPreview>;
  /** What testing the draft would read and cost; the model is not called. */
  readonly testEstimate: (draft: SourceDraft) => Promise<TestEstimate>;
  /** The test itself: up to 1,000 model requests, sent only after the estimate was accepted. */
  readonly testDraft: (draft: SourceDraft) => Promise<TestResult>;
  /** The diff the draft makes to facetdb.config.ts and the plan naming it; nothing is written. */
  readonly applyDiff: (draft: SourceDraft) => Promise<ApplyDiff>;
  /** Writes the file the plan names and reloads the worker; `force` only when the person chose it. */
  readonly applyWrite: (
    draft: SourceDraft,
    confirm: { readonly plan: string; readonly force: boolean },
  ) => Promise<ApplyWritten>;
  /** Settings: the diff the spending draft makes to facetdb.config.ts and its plan; nothing is written. */
  readonly applySpendingDiff: (draft: SpendingDraft) => Promise<ApplyDiff>;
  /** Writes the spending draft the plan names; the worker reloads and enforces the new cap at once. */
  readonly applySpendingWrite: (
    draft: SpendingDraft,
    confirm: { readonly plan: string; readonly force: boolean },
  ) => Promise<ApplyWritten>;
  /** `POST /v1/reload`, Check again: the worker reads the file and its databases again. */
  readonly reload: () => Promise<ApplyReload>;
  // The Sources page and the setup flow.
  readonly sources: () => Promise<readonly SourceRow[]>;
  /** Whether this browser may add a source here: the operator on the worker's machine alone. */
  readonly setupAccess: () => Promise<SetupAccess>;
  /** The tables the admin string reaches, and with `table` that table's columns and rows. */
  readonly setupInspect: (admin: string, table?: string) => Promise<Inspection>;
  /** The new source's questions asked of its 20 newest rows, read with the admin string. */
  readonly setupPreview: (admin: string, draft: SetupDraft) => Promise<DraftPreview>;
  /** The install SQL and the config file's diff, with the token that installs exactly them. */
  readonly setupPlan: (admin: string, draft: SetupDraft) => Promise<SetupPlan>;
  /** Writes the file and runs the plan the token names; `force` only when the person chose it. */
  readonly setupInstall: (
    admin: string,
    draft: SetupDraft,
    confirm: { readonly token: string; readonly force: boolean },
  ) => Promise<SetupInstalled>;
  // An added question's install: the admin string in the body of these two alone.
  /** The install of the questions the file adds to `source`, shown before anything runs. */
  readonly migratePlan: (source: string, admin: string) => Promise<MigratePlan>;
  /** Runs the install the token names, then the worker reloads the file. */
  readonly migrateRun: (source: string, admin: string, token: string) => Promise<Migrated>;
  // A source's backfill from the page: the worker's job, at most one per source.
  /** Where the source's job stands: idle, the estimate, the counts so far, why it ended. */
  readonly backfillStatus: (source: string) => Promise<BackfillStatus>;
  /**
   * Starts the count and the pricing, for the whole set or for the questions named (added ones,
   * asked alone); nothing is asked until a start. Answers the job as it begins to count.
   */
  readonly backfillEstimate: (
    source: string,
    questions?: readonly string[],
  ) => Promise<BackfillStatus>;
  /** Lets the estimated job run; `token` is the one the estimate shown on the page gave. */
  readonly backfillStart: (source: string, token: string) => Promise<BackfillStatus>;
  /** Stops the job after the page in hand (at once, when nothing was asked yet). */
  readonly backfillStop: (source: string) => Promise<BackfillStatus>;
  // The Plugins page.
  /** The plugins the worker hosts, each with its settings schema, values and variables. */
  readonly plugins: () => Promise<InstalledPlugins>;
  /** The registry's entries matching every word of `search` (all without one), or why it cannot be read. */
  readonly gallery: (search?: string) => Promise<Gallery>;
  /** The diff the plugin settings make to facetdb.config.ts and its plan; nothing is written. */
  readonly applyPluginsDiff: (draft: PluginsDraft) => Promise<ApplyDiff>;
  /** Writes the settings the plan names; the worker reloads and puts them in force with no restart. */
  readonly applyPluginsWrite: (
    draft: PluginsDraft,
    confirm: { readonly plan: string; readonly force: boolean },
  ) => Promise<ApplyWritten>;
};

/**
 * Whether a record's key is a dot segment, `.` or `..`: the URL standard resolves one away in any
 * path, percent-encoded or not, so such a key reaches its record only as a query value.
 */
export function isDotSegment(key: string): boolean {
  return key === "." || key === "..";
}

/** A record's key as one path segment: the surface reads it back URL-decoded. */
const keyPath = (card: ReviewCardId) => encodeURIComponent(card.key);

/** The body every card call carries; the strict surface refuses anything else. */
const idBody = (card: ReviewCardId) => ({ source: card.source, stateHash: card.stateHash });

/** The surface's path prefix (`API_VERSION` of @facetdb/server). */
const API = "/v1";

/** The part of `fetch` the client uses; the composition root passes the window's. */
export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The client over `fetch`, same-origin: the worker serves the app and the API from one address
 * (the session cookie rides along), and Vite's dev server proxies `/v1` to the worker.
 */
export function createApiClient(fetch: Fetch): ApiClient {
  async function call<Schema extends z.ZodType>(
    schema: Schema,
    method: "GET" | "POST" | "DELETE",
    path: string,
    body?: unknown,
    keepalive = false,
  ): Promise<z.output<Schema>> {
    // Every write carries a JSON body declared as such, `{}` when there is nothing to say: that
    // header is what the surface asks of a write to tell the studio's own page from another site's.
    const written = method !== "GET";
    const response = await fetch(`${API}${path}`, {
      method,
      ...(keepalive ? { keepalive: true } : {}),
      headers: written
        ? { accept: "application/json", "content-type": "application/json" }
        : { accept: "application/json" },
      ...(written ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    let json: unknown;
    try {
      json = await response.json();
    } catch {
      throw new ApiError(
        response.status,
        "unreadable",
        `The worker answered ${method} ${API}${path} with something that is not JSON (status ${response.status}).`,
        "Check that this address is a FacetDB worker, then reload the page.",
      );
    }
    if (!response.ok) {
      const refusal = errorBody.safeParse(json);
      if (refusal.success) {
        const { code, message, fix } = refusal.data.error;
        throw new ApiError(response.status, code, message, fix);
      }
      throw new ApiError(
        response.status,
        "unreadable",
        `The worker refused ${method} ${API}${path} (status ${response.status}) without saying why.`,
        "Reload the page; if it keeps failing, look at the worker's output.",
      );
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ApiError(
        response.status,
        "unexpected-answer",
        `The worker's answer to ${method} ${API}${path} is not what this studio expects: ${parsed.error.issues.map((issue) => `${issue.path.length === 0 ? "body" : issue.path.join(".")}: ${issue.message}`).join("; ")}.`,
        "The studio and the worker may be different versions: run pnpm build, restart the worker, and reload.",
      );
    }
    return parsed.data;
  }

  return {
    project: () => call(projectSchema, "GET", "/project"),
    reviewQueue: (options) => {
      const query = new URLSearchParams({ limit: String(options?.limit ?? 1) });
      for (const name of ["source", "question", "below"] as const) {
        const value = options?.[name];
        if (value !== undefined) {
          query.set(name, String(value));
        }
      }
      return call(queueSchema, "GET", `/review/queue?${query.toString()}`);
    },
    reviewOpen: (target) => call(openedSchema, "POST", "/review/open", target ?? {}),
    reviewRenew: (card) =>
      call(renewedSchema, "POST", `/review/${keyPath(card)}/renew`, idBody(card)),
    reviewDecide: (card, decision) =>
      call(decidedSchema, "POST", `/review/${keyPath(card)}/decide`, {
        ...idBody(card),
        ...decision,
      }),
    reviewSkip: async (card) => {
      await call(skippedSchema, "POST", `/review/${keyPath(card)}/skip`, idBody(card));
    },
    reviewRelease: async (card) => {
      await call(releasedSchema, "POST", `/review/${keyPath(card)}/release`, idBody(card), true);
    },
    reviewUndo: () => call(undoneSchema, "POST", "/review/undo", {}),
    home: () => call(homeSchema, "GET", "/home"),
    signIn: (name, password) => call(signedInSchema, "POST", "/session", { name, password }),
    signOut: async () => {
      await call(signedOutSchema, "DELETE", "/session");
    },
    sourceNames: async () =>
      (await call(sourceNamesSchema, "GET", "/config")).sources.map((source) => source.name),
    decisions: (filters, cursor) => {
      const { source, ...narrowing } = filters;
      const query = [
        `source=${encodeURIComponent(source)}`,
        ...Object.entries({ ...narrowing, cursor }).flatMap(([name, value]) =>
          value === undefined ? [] : [`${name}=${encodeURIComponent(value)}`],
        ),
      ];
      return call(decisionsPageSchema, "GET", `/decisions?${query.join("&")}`);
    },
    decisionHistory: (source, key) =>
      call(
        decisionHistorySchema,
        "GET",
        isDotSegment(key)
          ? `/decisions/history?source=${encodeURIComponent(source)}&key=${encodeURIComponent(key)}`
          : `/decisions/${encodeURIComponent(source)}/${encodeURIComponent(key)}`,
      ),
    runs: ({ source, page }) =>
      call(
        runsPageSchema,
        "GET",
        `/runs?${source === undefined ? "" : `source=${encodeURIComponent(source)}&`}page=${String(page)}`,
      ),
    alerts: () => call(alertsSchema, "GET", "/alerts"),
    testAlertChannel: async (address) => {
      await call(alertTestSentSchema, "POST", "/alerts/test", { channel: address });
    },
    alertChannelsInFile: async () =>
      (await call(alertsConfigSchema, "GET", "/config")).alerts?.channels ?? [],
    // The channels ride as the project draft's `alerts`, the whole list, null for none.
    applyAlertsDiff: (alerts) => call(applyDiffSchema, "POST", "/apply", { project: { alerts } }),
    applyAlertsWrite: (alerts, { plan, force }) =>
      call(applyWrittenSchema, "POST", "/apply", { project: { alerts }, confirm: plan, force }),
    studioAccess: () => call(studioAccessSchema, "GET", "/studio"),
    reviewers: async () => (await call(reviewersSchema, "GET", "/reviewers")).reviewers,
    addReviewer: async (name, password) => {
      await call(reviewerAddedSchema, "POST", "/reviewers", { name, password });
    },
    spendingConfig: async () => {
      const config = await call(spendingConfigSchema, "GET", "/config");
      return { tokens: config.spendingCap ?? null, onCapReached: config.onCapReached };
    },
    projectConfig: () => call(projectConfigSchema, "GET", "/config"),
    packs: async () => (await call(packsSchema, "GET", "/packs")).packs,
    validateDraft: (draft) =>
      call(draftValidationSchema, "POST", "/config/validate", { source: draft }),
    previewDraft: (draft) => call(draftPreviewSchema, "POST", "/preview", { source: draft }),
    testEstimate: async (draft) =>
      (await call(testEstimatedSchema, "POST", "/test", { source: draft, estimate: true }))
        .estimate,
    testDraft: (draft) =>
      call(testResultSchema, "POST", "/test", { source: draft, estimate: false }),
    applyDiff: (draft) => call(applyDiffSchema, "POST", "/apply", { source: draft }),
    applyWrite: (draft, { plan, force }) =>
      call(applyWrittenSchema, "POST", "/apply", { source: draft, confirm: plan, force }),
    // The project's own spending settings ride as `project`, never inside a source.
    applySpendingDiff: (draft) => call(applyDiffSchema, "POST", "/apply", { project: draft }),
    applySpendingWrite: (draft, { plan, force }) =>
      call(applyWrittenSchema, "POST", "/apply", { project: draft, confirm: plan, force }),
    // An empty JSON body: the header is the guard the route takes (Apply's), nothing in it is read.
    reload: () => call(reloadSchema, "POST", "/reload", {}),
    sources: async () => (await call(sourcesSchema, "GET", "/sources")).sources,
    setupAccess: () => call(setupAccessSchema, "GET", "/sources/setup"),
    setupInspect: (admin, table) =>
      call(inspectionSchema, "POST", "/sources/inspect", {
        admin,
        ...(table === undefined ? {} : { table }),
      }),
    setupPreview: (admin, draft) =>
      call(draftPreviewSchema, "POST", "/sources/preview", { admin, source: draft }),
    setupPlan: (admin, draft) =>
      call(setupPlanSchema, "POST", "/sources/plan", { admin, source: draft }),
    setupInstall: (admin, draft, { token, force }) =>
      call(setupInstalledSchema, "POST", "/sources/install", {
        admin,
        source: draft,
        token,
        force,
      }),
    migratePlan: (source, admin) =>
      call(migratePlanSchema, "POST", `/sources/${encodeURIComponent(source)}/migrate/plan`, {
        admin,
      }),
    migrateRun: (source, admin, token) =>
      call(migratedSchema, "POST", `/sources/${encodeURIComponent(source)}/migrate/run`, {
        admin,
        token,
      }),
    backfillStatus: (source) =>
      call(backfillStatusSchema, "GET", `/sources/${encodeURIComponent(source)}/backfill`),
    // The route's body: {} for the whole set, {"questions": [...]} for the ones named.
    backfillEstimate: (source, questions) =>
      call(
        backfillStatusSchema,
        "POST",
        `/sources/${encodeURIComponent(source)}/backfill/estimate`,
        questions === undefined ? {} : { questions: [...questions] },
      ),
    backfillStart: (source, token) =>
      call(backfillStatusSchema, "POST", `/sources/${encodeURIComponent(source)}/backfill/start`, {
        token,
      }),
    backfillStop: (source) =>
      call(
        backfillStatusSchema,
        "POST",
        `/sources/${encodeURIComponent(source)}/backfill/stop`,
        {},
      ),
    plugins: () => call(pluginsSchema, "GET", "/plugins"),
    gallery: (search) =>
      call(
        gallerySchema,
        "GET",
        `/plugins/gallery${search === undefined || search.trim() === "" ? "" : `?q=${encodeURIComponent(search.trim())}`}`,
      ),
    // A plugin's settings ride in the project draft's `plugins`, as the spending cap rides beside them.
    applyPluginsDiff: (draft) =>
      call(applyDiffSchema, "POST", "/apply", { project: { plugins: draft } }),
    applyPluginsWrite: (draft, { plan, force }) =>
      call(applyWrittenSchema, "POST", "/apply", {
        project: { plugins: draft },
        confirm: plan,
        force,
      }),
  };
}
