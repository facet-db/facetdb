import {
  BACKFILL_RUN_PREFIX,
  BACKFILL_RUN_SUFFIX,
  type Clock,
  type DoctorCheck,
} from "@facetdb/core";
import { sourceIdOf } from "@facetdb/postgres";
import { Hono } from "hono";
import type { AppEnv } from "../auth/middleware.ts";
import { CAPTURE_CHECK, type Doctors, INSTALL_CHECK, type Verdict } from "./doctor.ts";
import type { Capture, DashboardDoor, SourceFacts, TableFacts } from "./door.ts";
import { counted, duration, grouped, listed } from "./figures.ts";
import { unknownProject } from "./project.ts";
import type { CursorRow, DashboardReads } from "./reads.ts";

/**
 * `GET /v1/sources`: per source its connector, how it notices a change and when it last saw one,
 * where its answers live, its backfill, and the worker login's permissions, in the Sources page's
 * words. Reads only; each table source's doctor runs at most once a minute (`DOCTOR_FRESH_MS`).
 */

/** Where a source's backfill stands, from its cursor in the store. */
export type BackfillState = {
  /** `none`: no cursor, so no backfill has run (never 0%). `part-way`: a run's last page is not settled. */
  readonly state: "none" | "part-way" | "finished";
  /**
   * The share done, for the strip: 1 once finished, else null. A cursor is a place in the table,
   * not a count, and the store keeps no total, so a run part way has no share to show.
   */
  readonly fraction: number | null;
  /** Records the model answered under the run's question-set version; null without a run. */
  readonly answered: number | null;
  readonly version: number | null;
  /** When the run's finished alert was raised, ISO 8601; null when none was. */
  readonly finishedAt: string | null;
  readonly words: string;
};

/** One labelled line of a source's row: `Wakes`, `Arrives`, `Login`. */
export type Line = { readonly label: string; readonly words: string };

export type SourceRow = {
  readonly name: string;
  readonly kind: "table" | "api" | "plugin";
  /** The connector in words, the row's tag: `Postgres, trigger`, `API`, `Plugin @facetdb/github, issues`. */
  readonly connector: string;
  /**
   * Doctor's install line under the worker login: its status and words, the capture check's when
   * that one fails; null for an API source.
   */
  readonly install: { readonly status: DoctorCheck["status"]; readonly words: string } | null;
  readonly verdict: Verdict;
  /** How a change reaches the worker, with when it last saw one. */
  readonly how: Line;
  /** The start of the worker's newest pass that claimed a change, ISO 8601; null when none has. */
  readonly lastChangeAt: string | null;
  readonly answers: string;
  /**
   * The database's estimate of the table's rows (its statistics, no count run); null when it has
   * none, and for an API source, which has no table.
   */
  readonly rows: number | null;
  readonly backfill: BackfillState;
  /** What the worker login may read and write; null for an API source, which has no login. */
  readonly login: Line | null;
};

export type SourcesOutcome =
  | { readonly kind: "sources"; readonly sources: readonly SourceRow[] }
  | { readonly kind: "unknown_project" };

export type SourcesService = {
  sources(projectId: string): Promise<SourcesOutcome>;
};

export type SourcesDeps = {
  readonly door: DashboardDoor;
  readonly reads: DashboardReads;
  readonly doctors: Doctors;
  readonly clock: Clock;
};

const CAPTURE_WORDS: Readonly<Record<Capture, string>> = {
  trigger: "trigger",
  "change-tracking": "Change Tracking",
  "change-stream": "change stream",
  polling: "polling",
};

/** How a change wakes the worker. */
function wakes(table: TableFacts): string {
  switch (table.capture) {
    case "trigger":
      return table.pushWakeup
        ? "Instantly, on the trigger's notification."
        : "Within a second, on the poll of facetdb_jobs.";
    case "change-tracking":
      return "Within a second, on the poll of SQL Server's Change Tracking.";
    case "change-stream":
      return "Instantly, on the collection's change stream.";
    case "polling":
      return "Within 10 seconds, on a poll for rows whose state changed.";
  }
}

function answersWords(source: SourceFacts): string {
  const questions = `${counted(source.questions, "question", "questions")}, version ${source.version}.`;
  const { table } = source;
  if (table === undefined) {
    return `Kept in the FacetDB store. ${questions} Unsure records land in Review.`;
  }
  const where =
    table.storage === "side-table"
      ? `In a side table beside ${table.label}.`
      : `Inline ${table.answersIn} on ${table.label}.`;
  return `${where} ${questions}`;
}

function loginWords(source: SourceFacts, table: TableFacts): string {
  const { login } = table;
  const own =
    table.storage === "side-table" ? "its side table" : `FacetDB's own ${table.answersIn}`;
  switch (login.kind) {
    case "file":
      return "No login: the worker opens the database file, so this machine's permissions on the file are the limit.";
    case "token":
      return `No login: the worker connects with the auth token in ${login.variable}, which reaches the whole database.`;
    case "user":
      switch (login.reach) {
        case "columns":
          return `${login.user} reads ${listed(source.read)}, and writes only ${own}.`;
        case "reads-table":
          return `${login.user} reads every column of ${table.label}, and writes only ${own}.`;
        case "table":
          return `${login.user} may read and update every ${table.answersIn === "fields" ? "field" : "column"} of ${table.label}, as the database grants no narrower right; FacetDB writes only ${table.storage === "side-table" ? own : `its own ${table.answersIn}`}.`;
      }
  }
}

/**
 * The source's backfill: its newest run's cursor (the highest question-set version, a run part way
 * before a finished one). A key is the source's only when what follows its prefix is a whole run
 * suffix (`backfillRun`), so another source whose name extends this one's is never read as it.
 */
function newestRun(prefix: string, rows: readonly CursorRow[]) {
  const suffix = new RegExp(BACKFILL_RUN_SUFFIX);
  const runs = rows.flatMap((row) => {
    const rest = row.run.slice(prefix.length);
    const version = /@v([0-9]+)/.exec(rest)?.[1];
    return suffix.test(rest) && version !== undefined
      ? [{ done: row.done, version: Number(version), only: rest.startsWith("only@") }]
      : [];
  });
  runs.sort((a, b) =>
    a.version === b.version ? Number(a.done) - Number(b.done) : b.version - a.version,
  );
  return runs[0];
}

async function backfillOf(
  door: DashboardDoor,
  source: SourceFacts,
  reads: DashboardReads,
): Promise<BackfillState> {
  const none = (words: string): BackfillState => ({
    state: "none",
    fraction: null,
    answered: null,
    version: null,
    finishedAt: null,
    words,
  });
  // An API source's records arrive one by one; a plugin source's are paged through `scan` by a
  // backfill, whose cursor is read as a table source's is.
  if (source.table === undefined && source.plugin === undefined) {
    return none("None: records arrive one by one.");
  }
  const prefix = `${BACKFILL_RUN_PREFIX}${door.projectId}:${source.name}:`;
  const run = newestRun(prefix, await reads.cursors(prefix));
  if (run === undefined) {
    return none("None: no backfill has run on this source.");
  }
  const id = sourceIdOf(door.projectId, source.name);
  const answered = await reads.answeredUnder(id, run.version);
  const what = run.only ? "added questions" : "whole question set";
  if (!run.done) {
    // A table's scan goes newest first; a plugin's in whatever order the plugin yields, which the
    // SDK leaves to the plugin.
    const order = source.plugin === undefined ? "newest first" : "in the plugin's order";
    return {
      state: "part-way",
      fraction: null,
      answered,
      version: run.version,
      finishedAt: null,
      words: `Part way through the ${what}, ${order}: ${grouped(answered)} records answered under version ${run.version} so far. The next run resumes where this one stopped.`,
    };
  }
  const finished = await reads.backfillFinishedAt(door.projectId, source.name);
  return {
    state: "finished",
    fraction: 1,
    answered,
    version: run.version,
    finishedAt: finished === undefined ? null : new Date(finished).toISOString(),
    words: `Finished the ${what}: ${grouped(answered)} records answered under version ${run.version}.`,
  };
}

export function createSourcesService(deps: SourcesDeps): SourcesService {
  const { door, reads, doctors, clock } = deps;

  async function rowOf(source: SourceFacts): Promise<SourceRow> {
    const [seen, verdict, backfill, rows] = await Promise.all([
      reads.lastChange(sourceIdOf(door.projectId, source.name)),
      doctors.verdict(source),
      backfillOf(door, source, reads),
      source.table === undefined ? null : source.table.estimateRows(),
    ]);
    const lastSeen =
      seen === undefined
        ? "No change seen yet."
        : `Last change seen ${duration(clock.now() - seen)} ago.`;
    const common = {
      name: source.name,
      verdict: verdict.verdict,
      lastChangeAt: seen === undefined ? null : new Date(seen).toISOString(),
      answers: answersWords(source),
      rows,
      backfill,
    };
    const { table, plugin } = source;
    if (plugin !== undefined) {
      // A plugin source: the plugin says which records changed, the store keeps them.
      return {
        ...common,
        kind: "plugin",
        connector: `Plugin ${plugin.packageName}, ${plugin.source}`,
        install: null,
        how: {
          label: "Arrives",
          words: `The plugin ${plugin.packageName} reports each changed record of its ${plugin.source}, and the worker reads it into the FacetDB store and queues it. ${lastSeen}`,
        },
        login: null,
      };
    }
    if (table === undefined) {
      return {
        ...common,
        kind: "api",
        connector: "API",
        install: null,
        how: {
          label: "Arrives",
          words: `Your code sends each record to POST /v1/check and gets the answer back in about a second. ${lastSeen}`,
        },
        login: null,
      };
    }
    // The install line is the install check's, unless the capture check failed: a dropped trigger
    // was the install line's failure before the split, and is still said there.
    const install =
      verdict.checks.find((check) => check.name === CAPTURE_CHECK && check.status === "fail") ??
      verdict.checks.find((check) => check.name === INSTALL_CHECK);
    return {
      ...common,
      kind: "table",
      connector: `${table.database}, ${CAPTURE_WORDS[table.capture]}`,
      install: install === undefined ? null : { status: install.status, words: install.detail },
      how: { label: "Wakes", words: `${wakes(table)} ${lastSeen}` },
      login: { label: "Login", words: loginWords(source, table) },
    };
  }

  return {
    async sources(projectId) {
      if (projectId !== door.projectId) {
        return { kind: "unknown_project" };
      }
      return { kind: "sources", sources: await Promise.all(door.sources.map(rowOf)) };
    },
  };
}

/** `GET /v1/sources`: the API key was checked by the middleware; one service call, mapped. */
export function sourcesRoutes(service: SourcesService): Hono<AppEnv> {
  const route = new Hono<AppEnv>();
  route.get("/sources", async (c) => {
    const outcome = await service.sources(c.get("projectId"));
    if (outcome.kind === "unknown_project") {
      throw unknownProject();
    }
    return c.json({ sources: outcome.sources });
  });
  return route;
}
