import {
  ALERT_TITLES,
  type AlertRecord,
  type AlertSeverity,
  type Clock,
  compactTokens,
  HEARTBEAT_LOSS_MS,
  monthOf,
  readableTokenCounts,
  type SpendingCap,
  WORKER_NOT_RUNNING_WHAT,
  whenUtc,
} from "@facetdb/core";
import { Hono } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { type Doctors, INSTALL_CHECK, losesAccess, type Verdict } from "./doctor.ts";
import type { DashboardDoor, StoppedSource } from "./door.ts";
import { counted, dollarsOf, duration, grouped, money, percent } from "./figures.ts";
import { sourceIds, unknownProject } from "./project.ts";
import type { DashboardReads, Day } from "./reads.ts";

/**
 * `GET /v1/home`: health, the records answered today, the review queue, spending against the cap
 * and the recent alerts, each figure with the words the page shows. Reads only.
 */

/** Home shows the recent alerts, this many. */
export const RECENT_ALERTS = 10;

/** The warning goes out at 80% of the monthly cap. */
export const SPENDING_WARNING_PERCENT = 80;

const DAY_MS = 24 * 60 * 60_000;

/** A figure as a column of the page shows it: the large figure, and the sentence under it. */
export type FigureWords = { readonly figure: string; readonly sub: string };

/** One of Home's three health lines, in the alert's words when it fails. */
export type HealthCheck = {
  readonly name: "worker" | "model" | "sources";
  readonly status: "ok" | "warn" | "fail";
  readonly words: string;
};

export type Health = {
  /** `attention` when a check failed; the words are then that failure's alert title. */
  readonly status: "running" | "attention";
  readonly words: string;
  /** Since the worker's last heartbeat, in ms; null when none has ever beat. */
  readonly heartbeatAgeMs: number | null;
  readonly checks: readonly HealthCheck[];
  /** Each source's doctor in one word, in config order. */
  readonly sources: readonly {
    readonly name: string;
    readonly verdict: Verdict;
    readonly words: string;
  }[];
};

export type Answered = {
  readonly today: number;
  readonly yesterday: number;
  /** Today's share of yesterday's total, at most 1, for the strip; null when yesterday had none. */
  readonly fraction: number | null;
  readonly words: FigureWords;
};

export type Queue = {
  readonly waiting: number;
  /** How long the oldest card has waited, in ms; null when none waits. */
  readonly oldestWaitMs: number | null;
  /** Records people decided today, and how many people decided them. */
  readonly decidedToday: number;
  readonly reviewersToday: number;
  readonly words: FigureWords;
};

export type Spending = {
  /** As the spending gate judges it (`SpendingStatus`), or `uncapped` when the config sets no cap. */
  readonly status: "ok" | "warned" | "paused" | "continuing" | "uncapped";
  readonly month: string;
  readonly inputTokens: number;
  readonly dollars: number;
  /**
   * The cap the worker enforces now (each reload of the file replaces it), and what it does at
   * 100%. The Settings page compares it with the file, which differs only when edited by hand.
   */
  readonly cap: {
    readonly inputTokens: number;
    readonly dollars: number;
    readonly onCapReached: SpendingCap["onCapReached"];
  } | null;
  readonly warningAt: number;
  /** The month's share of the cap, at most 1, for the strip; null without a cap. */
  readonly fraction: number | null;
  readonly words: FigureWords;
};

/** An alert as every alert reads, with the page's words beside it. */
export type HomeAlert = {
  /** When it was raised or resolved, ISO 8601: the page words it in the viewer's zone. */
  readonly at: string;
  readonly phase: AlertRecord["phase"];
  readonly severity: AlertSeverity;
  /** `Information`, `Warning`, `Critical`, or `Resolved` once the event is over. */
  readonly badge: string;
  /** The event's name: `Backfill finished`. */
  readonly title: string;
  /** The line under it: the source, what happened and what FacetDB did. */
  readonly words: string;
  readonly what: string;
  readonly project: string;
  readonly source: string;
  readonly question: string | null;
  readonly did: string;
  readonly link: string;
};

export type Home = {
  readonly health: Health;
  readonly answered: Answered;
  readonly queue: Queue;
  readonly spending: Spending;
  readonly alerts: readonly HomeAlert[];
};

export type HomeOutcome =
  | { readonly kind: "home"; readonly home: Home }
  | { readonly kind: "unknown_project" };

export type HomeService = {
  home(projectId: string): Promise<HomeOutcome>;
};

export type HomeDeps = {
  readonly door: DashboardDoor;
  readonly reads: DashboardReads;
  readonly doctors: Doctors;
  readonly clock: Clock;
};

const SEVERITY_WORDS: Readonly<Record<AlertSeverity, string>> = {
  information: "Information",
  warning: "Warning",
  critical: "Critical",
};

/** The UTC day a clock reading falls in, as the spending cap counts UTC months. */
function dayOf(ms: number): Day {
  const at = new Date(ms);
  const from = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  return { from, to: from + DAY_MS };
}

function workerCheck(last: number | undefined, now: number): HealthCheck {
  if (last === undefined) {
    return {
      name: "worker",
      status: "fail",
      words: `${ALERT_TITLES.worker_not_running}. ${WORKER_NOT_RUNNING_WHAT} None has beat for this project yet.`,
    };
  }
  const age = now - last;
  return age >= HEARTBEAT_LOSS_MS
    ? {
        name: "worker",
        status: "fail",
        words: `${ALERT_TITLES.worker_not_running}. ${WORKER_NOT_RUNNING_WHAT} The last beat was ${duration(age)} ago.`,
      }
    : {
        name: "worker",
        status: "ok",
        words: `Worker beating, ${Math.max(0, Math.floor(age / 1000))} s ago`,
      };
}

function modelCheck(failing: Awaited<ReturnType<DashboardReads["modelFailing"]>>): HealthCheck {
  return failing.length === 0
    ? { name: "model", status: "ok", words: "Model healthy" }
    : {
        name: "model",
        status: "fail",
        words: `${ALERT_TITLES.model_failing}. ${failing.map((event) => `${event.source}: ${event.what}`).join(" ")}`,
      };
}

/** A source's doctor verdict, and which of its checks failed (not part of the page's source rows). */
type SourceState = Health["sources"][number] & { readonly failedCheck: string | null };

/**
 * The title for a source whose database is reachable but lacks what facetdb.config.ts asks for (a
 * question added and not migrated yet). It is no alert kind: nothing was lost, the install is behind.
 */
export const INSTALL_BEHIND_TITLE = "The install is behind facetdb.config.ts";

/** Doctor words often begin with the source's name already; the sentence names it once. */
function withoutName(source: SourceState): string {
  const prefix = `${source.name}: `;
  const words = source.words.startsWith(prefix) ? source.words.slice(prefix.length) : source.words;
  return words.replace(/\.$/, "");
}

const behind = (source: SourceState) =>
  source.verdict === "failing" && source.failedCheck === INSTALL_CHECK;
// The rule the worker raises Connector lost access by, so Home and the alert agree.
const lost = (source: SourceState) => losesAccess(source);

/**
 * A failing source reads as a lost connector unless its failing check is the install one: then the
 * database answers and the install is what is missing, which `facetdb migrate` fixes.
 */
function failingWords(sources: readonly SourceState[]): string {
  const lostAccess = sources.filter(lost);
  const notInstalled = sources.filter(behind);
  return [
    ...(lostAccess.length === 0
      ? []
      : [
          `${ALERT_TITLES.connector_lost_access}. ${lostAccess.map((source) => `${source.name}: ${source.words}`).join(" ")}`,
        ]),
    ...(notInstalled.length === 0
      ? []
      : [
          `${INSTALL_BEHIND_TITLE}. ${notInstalled
            .map(
              (source) =>
                `${source.name}: ${withoutName(source)}. Run facetdb migrate --source ${source.name}, then restart facetdb worker.`,
            )
            .join(" ")}`,
        ]),
  ].join(" ");
}

/**
 * The title of Home's state when a source's loop failed and it stopped alone, and no failure the
 * alerts name comes first. It is no alert kind: the worker raises "connector lost access" for a
 * stop only when its login or credential was refused, and Home names it from the doctor's verdict.
 */
export const SOURCE_STOPPED_TITLE = "A source stopped";

/** Times in the house form, as the worker's own lines say them: `YYYY-MM-DD HH:MM UTC`. */
function stoppedWords(stopped: StoppedSource): string {
  const said = `${stopped.source} stopped: ${stopped.why.replace(/\.$/, "")}.`;
  return stopped.retryAt === null
    ? `${said} Not tried again until it is fixed: then Check again on the Sources page, or restart facetdb worker.`
    : `${said} Trying again at ${whenUtc(new Date(stopped.retryAt))}.`;
}

function sourcesCheck(
  sources: readonly SourceState[],
  stopped: readonly StoppedSource[],
): HealthCheck {
  if (sources.length === 0 && stopped.length === 0) {
    return { name: "sources", status: "ok", words: "No source is installed yet" };
  }
  const failing = sources.some((source) => source.verdict === "failing");
  if (failing || stopped.length > 0) {
    return {
      name: "sources",
      status: "fail",
      words: [...(failing ? [failingWords(sources)] : []), ...stopped.map(stoppedWords)].join(" "),
    };
  }
  const all =
    sources.length === 1
      ? "One source, reachable and installed"
      : `${counted(sources.length, "source", "sources")}, reachable and installed`;
  const warned = sources.filter((source) => source.verdict === "warning");
  return warned.length === 0
    ? { name: "sources", status: "ok", words: all }
    : {
        name: "sources",
        status: "warn",
        words: `${all}; ${warned.map((source) => `${source.name}: ${source.words}`).join("; ")}`,
      };
}

/** The first failed check names the state, in the words of the alert it would raise. */
function attentionOf(failed: HealthCheck, sources: readonly SourceState[]): string {
  switch (failed.name) {
    case "worker":
      return ALERT_TITLES.worker_not_running;
    case "model":
      return ALERT_TITLES.model_failing;
    case "sources":
      // Lost access wins over a missing install when a project has both, and both over a source
      // whose loop stopped (which alone fails the check otherwise).
      return sources.some(lost)
        ? ALERT_TITLES.connector_lost_access
        : sources.some(behind)
          ? INSTALL_BEHIND_TITLE
          : SOURCE_STOPPED_TITLE;
  }
}

function answeredOf(today: number, yesterday: number): Answered {
  return {
    today,
    yesterday,
    fraction: yesterday === 0 ? null : Math.min(1, today / yesterday),
    words: {
      figure: today === 0 ? "None" : grouped(today),
      sub:
        yesterday === 0
          ? "None were answered yesterday."
          : `${percent(today, yesterday)}% of yesterday's ${grouped(yesterday)}.`,
    },
  };
}

function queueOf(
  waiting: number,
  oldestSince: number | undefined,
  decided: { readonly records: number; readonly reviewers: number },
  now: number,
): Queue {
  const oldestWaitMs = oldestSince === undefined ? null : Math.max(0, now - oldestSince);
  const wait =
    waiting === 0 || oldestWaitMs === null
      ? "No card is waiting."
      : `Oldest ${duration(oldestWaitMs)}.`;
  const people =
    decided.records === 0
      ? ""
      : ` ${counted(decided.reviewers, "reviewer", "reviewers")} decided ${grouped(decided.records)} today.`;
  return {
    waiting,
    oldestWaitMs,
    decidedToday: decided.records,
    reviewersToday: decided.reviewers,
    words: { figure: waiting === 0 ? "None" : grouped(waiting), sub: `${wait}${people}` },
  };
}

/** "about $3.20"; "$0" and "less than $0.01" as they are, since neither is an approximation. */
function aboutMoney(dollars: number): string {
  const words = money(dollars);
  return words.startsWith("$") && words !== "$0" ? `about ${words}` : words;
}

/**
 * The month's input tokens as the figure, at a glance ("3.2M of 25M"; a real run: the cap is set in
 * tokens, so the figure is in tokens, and the dollars follow in the sentence), and the sentence
 * under it: the share of the cap, the price, and what happens at 100%.
 */
function spendingOf(inputTokens: number, cap: SpendingCap | undefined, month: string): Spending {
  const dollars = dollarsOf(inputTokens);
  if (cap === undefined) {
    return {
      status: "uncapped",
      month,
      inputTokens,
      dollars,
      cap: null,
      warningAt: SPENDING_WARNING_PERCENT / 100,
      fraction: null,
      words: {
        figure: compactTokens(inputTokens),
        sub: `Input tokens this month, ${aboutMoney(dollars)}. No monthly cap is set, so the project never pauses.`,
      },
    };
  }
  const figure = `${compactTokens(inputTokens)} of ${compactTokens(cap.inputTokens)}`;
  const capMoney = money(dollarsOf(cap.inputTokens));
  const pauses = cap.onCapReached === "pause";
  const atHundred = pauses
    ? "The project pauses at 100%."
    : "The project keeps answering past 100%.";
  // Integer comparisons, as the spending gate makes them: 80% is `cap * 80 / 100`, never rounded.
  const atCap = inputTokens >= cap.inputTokens;
  const warned = inputTokens * 100 >= cap.inputTokens * SPENDING_WARNING_PERCENT;
  // Rounded to the nearest, but never up onto a line not crossed: 79.6% reads 79%, 99.6% reads 99%.
  const shown = Math.min(
    percent(inputTokens, cap.inputTokens),
    warned ? 99 : SPENDING_WARNING_PERCENT - 1,
  );
  const price = `${aboutMoney(dollars)} of ${capMoney}`;
  const [status, sub]: [Spending["status"], string] = atCap
    ? pauses
      ? [
          "paused",
          `Input tokens this month: the monthly cap is reached (${aboutMoney(dollars)}), so the project is paused until the month resets or the cap changes.`,
        ]
      : [
          "continuing",
          `Input tokens this month: the monthly cap is reached (${aboutMoney(dollars)}); the project keeps answering, as the config says.`,
        ]
    : warned
      ? [
          "warned",
          `Input tokens this month: ${shown}% of the monthly cap, past the 80% warning, ${price}. ${atHundred}`,
        ]
      : ["ok", `Input tokens this month: ${shown}% of the monthly cap, ${price}. ${atHundred}`];
  return {
    status,
    month,
    inputTokens,
    dollars,
    cap: {
      inputTokens: cap.inputTokens,
      dollars: dollarsOf(cap.inputTokens),
      onCapReached: cap.onCapReached,
    },
    warningAt: SPENDING_WARNING_PERCENT / 100,
    fraction: Math.min(1, inputTokens / cap.inputTokens),
    words: { figure, sub },
  };
}

function alertOf(record: AlertRecord): HomeAlert {
  const { event } = record;
  // Rows written before the compact figures carry bare digits: read at a glance, as new rows are.
  const what = readableTokenCounts(event.what);
  return {
    at: new Date(record.at).toISOString(),
    phase: record.phase,
    severity: record.severity,
    badge: record.phase === "resolved" ? "Resolved" : SEVERITY_WORDS[record.severity],
    title: ALERT_TITLES[event.kind],
    words: `${event.source}: ${what} ${event.did}`,
    what,
    project: event.project,
    source: event.source,
    question: event.question,
    did: event.did,
    link: event.link,
  };
}

export function createHomeService(deps: HomeDeps): HomeService {
  const { door, reads, doctors, clock } = deps;
  return {
    async home(projectId) {
      if (projectId !== door.projectId) {
        return { kind: "unknown_project" };
      }
      const now = clock.now();
      const ids = sourceIds(door);
      const today = dayOf(now);
      const yesterday = { from: today.from - DAY_MS, to: today.from };
      const month = monthOf(now);
      const [
        last,
        failing,
        sources,
        answeredToday,
        answeredYesterday,
        queue,
        decided,
        tokens,
        alerts,
      ] = await Promise.all([
        reads.lastHeartbeat(projectId),
        reads.modelFailing(projectId),
        Promise.all(
          door.sources.map(async (source) => {
            const { verdict, words, failedCheck } = await doctors.verdict(source);
            return { name: source.name, verdict, words, failedCheck };
          }),
        ),
        reads.answered(ids, today),
        reads.answered(ids, yesterday),
        reads.queue(ids),
        reads.decided(ids, today),
        reads.monthTokens(projectId, month),
        reads.recentAlerts(projectId, RECENT_ALERTS),
      ]);
      // Read after the doctors: a source that stopped meanwhile is named here, not dropped.
      const checks = [
        workerCheck(last, now),
        modelCheck(failing),
        sourcesCheck(sources, door.stopped),
      ];
      const failed = checks.find((check) => check.status === "fail");
      return {
        kind: "home",
        home: {
          health: {
            status: failed === undefined ? "running" : "attention",
            words: failed === undefined ? "Running" : attentionOf(failed, sources),
            heartbeatAgeMs: last === undefined ? null : now - last,
            checks,
            sources: sources.map(({ name, verdict, words }) => ({ name, verdict, words })),
          },
          answered: answeredOf(answeredToday, answeredYesterday),
          queue: queueOf(queue.waiting, queue.oldestSince, decided, now),
          spending: spendingOf(tokens, door.cap, month),
          alerts: alerts.map(alertOf),
        },
      };
    },
  };
}

/** `GET /v1/home`: the API key was checked by the middleware; one service call, mapped. */
export function homeRoutes(service: HomeService): Hono<AppEnv> {
  const route = new Hono<AppEnv>();
  route.get("/home", async (c) => {
    const outcome = await service.home(c.get("projectId"));
    if (outcome.kind === "unknown_project") {
      throw unknownProject();
    }
    return c.json(outcome.home);
  });
  return route;
}
