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
    cap: z.object({ inputTokens: z.number(), dollars: z.number().min(0) }).nullable(),
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

export type ApiClient = {
  readonly project: () => Promise<Project>;
  readonly reviewQueue: (options?: { readonly limit?: number }) => Promise<ReviewQueue>;
  readonly home: () => Promise<Home>;
  readonly signIn: (name: string, password: string) => Promise<SignedIn>;
  readonly signOut: () => Promise<void>;
};

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
  ): Promise<z.output<Schema>> {
    const response = await fetch(`${API}${path}`, {
      method,
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
    reviewQueue: (options) =>
      call(queueSchema, "GET", `/review/queue?limit=${String(options?.limit ?? 1)}`),
    home: () => call(homeSchema, "GET", "/home"),
    signIn: (name, password) => call(signedInSchema, "POST", "/session", { name, password }),
    signOut: async () => {
      await call(signedOutSchema, "DELETE", "/session");
    },
  };
}
