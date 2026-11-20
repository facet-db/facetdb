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
const reviewOpenQuestion = z.object({
  name: z.string(),
  type: questionType,
  instructions: z.string(),
  said: z.string(),
  figure: z.number().min(0).max(1),
  top: z.string(),
  options: z.array(reviewOption),
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

/** One model answer as the log search carries it: the raw figures and what its version's thresholds made of it. */
const loggedAnswerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("noul"), probability: z.number(), decision: z.string() }),
  z.object({
    type: z.literal("choice"),
    top: z.string(),
    probabilities: z.array(z.number()),
    decision: z.string(),
  }),
  z.object({
    type: z.literal("score"),
    probabilities: z.array(z.number()),
    confidence: z.number(),
    decision: z.string(),
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
};

/** `GET /v1/decisions/:source/:key`: the entries `facetdb explain` prints, oldest first, in its words. */
const explainedEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("answer"),
    at: z.string(),
    model: z.string(),
    version: z.number(),
    answers: z.array(
      z.object({
        question: z.string(),
        wording: z.string(),
        said: z.string(),
        decision: z.string(),
      }),
    ),
  }),
  z.object({
    kind: z.literal("human"),
    at: z.string(),
    version: z.number(),
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
    question: z.string(),
    wording: z.string(),
    reviewer: z.string(),
  }),
]);
export type ExplainedEntry = z.infer<typeof explainedEntrySchema>;

const decisionHistorySchema = z.object({
  source: z.string(),
  key: z.string(),
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
  /** The channels the worker runs with (the config as it started). */
  channels: z.array(z.object({ kind: z.string().min(1), name: z.string().nullable() })),
  /** True when facetdb.config.ts now names other channels, which apply at the next restart. */
  fileChannelsDiffer: z.boolean(),
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
    }),
  ),
  /** The most history lines the worker reads; `capped` says older ones exist. */
  limit: z.number().int().positive(),
  capped: z.boolean(),
});
export type Alerts = z.infer<typeof alertsSchema>;
export type AlertEvent = Alerts["events"][number];
export type AlertChannel = Alerts["channels"][number];

/** `GET /v1/studio`: the host the studio listens on, whether only this machine can reach it, and the accounts. */
const studioAccessSchema = z.object({
  host: z.string().min(1),
  loopback: z.boolean(),
  reviewers: z.number().int().min(0),
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
  /** One record's history; the key is as the log shows it, encoded once into the path here. */
  readonly decisionHistory: (source: string, key: string) => Promise<DecisionHistory>;
  /** One page of the run log from 1; one source by name, or every source. */
  readonly runs: (options: {
    readonly source?: string;
    readonly page: number;
  }) => Promise<RunsPage>;
  // The Alerts and Settings pages.
  readonly alerts: () => Promise<Alerts>;
  readonly studioAccess: () => Promise<StudioAccess>;
  readonly reviewers: () => Promise<ReviewerAccounts>;
  /**
   * Makes a reviewer account, as `facetdb users add` does. The password is a request's body and
   * nothing else: it is in no address, and the client keeps no copy of it.
   */
  readonly addReviewer: (name: string, password: string) => Promise<void>;
  readonly spendingConfig: () => Promise<SpendingConfig>;
};

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
    const response = await fetch(`${API}${path}`, {
      method,
      ...(keepalive ? { keepalive: true } : {}),
      headers:
        body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
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
        `/decisions/${encodeURIComponent(source)}/${encodeURIComponent(key)}`,
      ),
    runs: ({ source, page }) =>
      call(
        runsPageSchema,
        "GET",
        `/runs?${source === undefined ? "" : `source=${encodeURIComponent(source)}&`}page=${String(page)}`,
      ),
    alerts: () => call(alertsSchema, "GET", "/alerts"),
    studioAccess: () => call(studioAccessSchema, "GET", "/studio"),
    reviewers: async () => (await call(reviewersSchema, "GET", "/reviewers")).reviewers,
    addReviewer: async (name, password) => {
      await call(reviewerAddedSchema, "POST", "/reviewers", { name, password });
    },
    spendingConfig: async () => {
      const config = await call(spendingConfigSchema, "GET", "/config");
      return { tokens: config.spendingCap ?? null, onCapReached: config.onCapReached };
    },
  };
}
