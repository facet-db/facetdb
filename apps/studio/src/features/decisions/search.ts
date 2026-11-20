/**
 * The Decisions page's view as the address holds it: the tab, the source, the record key, the
 * status, the time as four plain choices, and behind "More filters" the question and the reviewer.
 * A reload and a shared link show the same view, so everything the page filters by is here and
 * nothing is kept in a component. A value that is not one of these falls back to the default: a
 * hand-typed or stale address never reaches an error page, and never sends the worker a query it
 * refuses.
 */

export const TIME_CHOICES = ["today", "week", "month", "all"] as const;
export type TimeChoice = (typeof TIME_CHOICES)[number];

/** The words of each choice, as the mockup has them. */
export const TIME_WORDS: Readonly<Record<TimeChoice, string>> = {
  today: "Today",
  week: "7 days",
  month: "30 days",
  all: "All",
};

export const STATUS_CHOICES = ["decided", "needs_review"] as const;
export type StatusChoice = (typeof STATUS_CHOICES)[number];

/**
 * Every key is absent when it holds its default, so the plain page has the plain address:
 * decisions, today, any status, every record.
 */
export type DecisionsSearch = {
  /** `runs` for the run log; absent for the decisions. */
  readonly tab?: "runs" | undefined;
  /** A source of the config; absent: the first one on the Decisions tab, every one on Runs. */
  readonly source?: string | undefined;
  /** One record's key, exactly as the log shows it. */
  readonly q?: string | undefined;
  readonly status?: StatusChoice | undefined;
  /** Absent: today. */
  readonly time?: Exclude<TimeChoice, "today"> | undefined;
  readonly question?: string | undefined;
  readonly reviewer?: string | undefined;
  /** The run log's page from 1; absent: the first. */
  readonly page?: number | undefined;
};

/** A change to the view: a key set to `undefined` goes back to its default. */
export type DecisionsPatch = DecisionsSearch;

/** The server's own rule for a source's name (`GET /v1/runs` refuses any other). */
const SOURCE_NAME = /^[a-z][a-z0-9_]*$/;

/** The largest run-log page whose offset the server holds exactly (50 runs a page). */
export const MAX_RUNS_PAGE = Math.floor(Number.MAX_SAFE_INTEGER / 50);

/**
 * A text value: a string, as the router's search parser leaves the four text keys as written
 * (routes/search.ts), so `1e3`, `1.0`, a 17-digit id and `true` are the keys they spell. A number
 * or a flag is not text and is the default.
 */
function text(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function pageNumber(value: unknown): number | undefined {
  const page = typeof value === "string" ? Number(value) : value;
  return typeof page === "number" && Number.isInteger(page) && page >= 2 && page <= MAX_RUNS_PAGE
    ? page
    : undefined;
}

/** Whatever the address holds, as a view: unknown or malformed values are the default. */
export function decisionsSearch(raw: Record<string, unknown>): DecisionsSearch {
  const source = text(raw["source"]);
  const status = STATUS_CHOICES.find((choice) => choice === raw["status"]);
  const time = TIME_CHOICES.find((choice) => choice === raw["time"]);
  const q = text(raw["q"]);
  const question = text(raw["question"]);
  const reviewer = text(raw["reviewer"]);
  const page = pageNumber(raw["page"]);
  // Every key is named, `undefined` when it is the default: the router keeps the raw value of a
  // key the validator leaves out (as sign-in.tsx does), and a refused value must not survive.
  const runs = raw["tab"] === "runs";
  return {
    tab: runs ? "runs" : undefined,
    source: source !== undefined && SOURCE_NAME.test(source) ? source : undefined,
    q,
    status,
    time: time === "today" ? undefined : time,
    question,
    reviewer,
    // Only the run log has pages, and only the ones after the first need saying.
    page: runs ? page : undefined,
  };
}

/**
 * The view after a change. Any change but a page's own goes back to the first page: a different
 * source or tab has other pages.
 */
export function patched(current: DecisionsSearch, patch: DecisionsPatch): DecisionsSearch {
  const merged: Record<string, unknown> = { ...current };
  if (!("page" in patch)) {
    delete merged["page"];
  }
  for (const [name, value] of Object.entries(patch)) {
    if (value === undefined) {
      delete merged[name];
    } else {
      merged[name] = value;
    }
  }
  return decisionsSearch(merged);
}

/** Whether any filter narrows the log: what "Clear the filters" would undo. */
export function narrowed(search: DecisionsSearch): boolean {
  return (
    search.q !== undefined ||
    search.status !== undefined ||
    search.question !== undefined ||
    search.reviewer !== undefined ||
    (search.time ?? "today") !== "all"
  );
}

/**
 * Where the time choice starts, from the clock: today is since this machine's midnight; seven and
 * thirty days are counted back from now; all has no start. Changes the query only: the model is
 * never asked anything by choosing a time.
 */
export function timeStart(choice: TimeChoice, now: Date): Date | undefined {
  const day = 24 * 60 * 60 * 1000;
  switch (choice) {
    case "today":
      return new Date(now.getFullYear(), now.getMonth(), now.getDate());
    case "week":
      return new Date(now.getTime() - 7 * day);
    case "month":
      return new Date(now.getTime() - 30 * day);
    case "all":
      return undefined;
  }
}
