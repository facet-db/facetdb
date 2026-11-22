import type { Clock, DoctorCheck } from "@facetdb/core";
import type { SourceFacts } from "./door.ts";

/**
 * Each source's doctor, as Home and Sources show it. A doctor connects and makes a few round trips,
 * so one result stands for a minute: a page that refreshes does not open connections on every
 * load, and two requests at once share one run.
 */

/** How long one doctor's checks stand before a request runs them again. */
export const DOCTOR_FRESH_MS = 60_000;

/** A source's doctor in one word: `failing` is the "Connector lost access" alert. */
export type Verdict = "healthy" | "warning" | "failing";

/** The name every engine's doctor gives the check of the install in the database. */
export const INSTALL_CHECK = "install";

export type SourceVerdict = {
  readonly verdict: Verdict;
  /** What doctor found, in its own words: the first failure, else the first warning. */
  readonly words: string;
  /**
   * The name of the check whose failure `words` is, so a page can tell a missing install (the
   * `install` check) from a lost login or connection; null unless the verdict is `failing`.
   */
  readonly failedCheck: string | null;
  /** The checks it ran; empty for an API source, which has no database to check. */
  readonly checks: readonly DoctorCheck[];
};

export type Doctors = {
  verdict(source: SourceFacts): Promise<SourceVerdict>;
};

/**
 * A table source's doctor in one word, from the checks it ran: what Home and Sources show, and what
 * the worker's own reading every 5 minutes raises Connector lost access on, so the two always name
 * the same failed check in the same words.
 */
export function doctorVerdict(checks: readonly DoctorCheck[]): SourceVerdict {
  // The worker's heartbeat is Home's own line; the source's verdict is its database and install.
  const counted = checks.filter((check) => check.name !== "worker" && check.status !== "skip");
  const failed = counted.find((check) => check.status === "fail");
  if (failed !== undefined) {
    return { verdict: "failing", words: failed.detail, failedCheck: failed.name, checks };
  }
  const warned = counted.find((check) => check.status === "warn");
  return warned === undefined
    ? { verdict: "healthy", words: "as installed", failedCheck: null, checks }
    : { verdict: "warning", words: warned.detail, failedCheck: null, checks };
}

/**
 * "Connector lost access": a failing verdict whose failed check is not the install one. A failing
 * install check means the database answers and lacks what facetdb.config.ts asks for, which
 * `facetdb migrate` fixes: Home names that "the install is behind", and no alert is raised for it.
 */
export function losesAccess(verdict: Pick<SourceVerdict, "verdict" | "failedCheck">): boolean {
  return verdict.verdict === "failing" && verdict.failedCheck !== INSTALL_CHECK;
}

export function createDoctors(clock: Clock, freshMs: number = DOCTOR_FRESH_MS): Doctors {
  const results = new Map<
    string,
    { readonly at: number; readonly checks: Promise<readonly DoctorCheck[]> }
  >();

  function checksOf(source: SourceFacts, table: NonNullable<SourceFacts["table"]>) {
    const now = clock.now();
    const held = results.get(source.name);
    if (held !== undefined && now - held.at < freshMs) {
      return held.checks;
    }
    // A run that failed is not kept: the next request runs it again.
    const checks: Promise<readonly DoctorCheck[]> = table.doctor().catch((error: unknown) => {
      if (results.get(source.name)?.checks === checks) {
        results.delete(source.name);
      }
      throw error;
    });
    results.set(source.name, { at: now, checks });
    return checks;
  }

  return {
    async verdict(source) {
      if (source.plugin !== undefined) {
        // A plugin source has no database of its own to check: its loop says when its plugin fails,
        // by stopping alone.
        return {
          verdict: "healthy",
          words: `read by the plugin ${source.plugin.packageName}, with no database to check`,
          failedCheck: null,
          checks: [],
        };
      }
      if (source.table === undefined) {
        return {
          verdict: "healthy",
          words: "answered through POST /v1/check, with no database to check",
          failedCheck: null,
          checks: [],
        };
      }
      return doctorVerdict(await checksOf(source, source.table));
    },
  };
}
