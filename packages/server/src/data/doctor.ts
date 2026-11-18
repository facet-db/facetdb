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

export type SourceVerdict = {
  readonly verdict: Verdict;
  /** What doctor found, in its own words: the first failure, else the first warning. */
  readonly words: string;
  /** The checks it ran; empty for an API source, which has no database to check. */
  readonly checks: readonly DoctorCheck[];
};

export type Doctors = {
  verdict(source: SourceFacts): Promise<SourceVerdict>;
};

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
      if (source.table === undefined) {
        return {
          verdict: "healthy",
          words: "answered through POST /v1/check, with no database to check",
          checks: [],
        };
      }
      const checks = await checksOf(source, source.table);
      // The worker's heartbeat is Home's own line; the source's verdict is its database and install.
      const counted = checks.filter((check) => check.name !== "worker" && check.status !== "skip");
      const failed = counted.find((check) => check.status === "fail");
      if (failed !== undefined) {
        return { verdict: "failing", words: failed.detail, checks };
      }
      const warned = counted.find((check) => check.status === "warn");
      return warned === undefined
        ? { verdict: "healthy", words: "as installed", checks }
        : { verdict: "warning", words: warned.detail, checks };
    },
  };
}
