import type { AlertEvent, AlertOutcome, Alerts } from "../alerts/index.ts";
import type { Clock } from "../contracts/index.ts";

/**
 * The cap a project sets: billable input tokens a calendar month may use, and what happens at 100%.
 */
export type SpendingCap = {
  readonly inputTokens: number;
  readonly onCapReached: "pause" | "continue";
};

/**
 * Where a project stands this month. `ok` is under 80%; `warned` is at 80% or more and under the
 * cap; `paused` and `continuing` are at the cap, with the project paused or still answering.
 */
export type SpendingStatus = "ok" | "warned" | "paused" | "continuing";

/** The two alerts the spending cap raises. */
export type SpendingAlertKind = Extract<AlertEvent["kind"], "spending_80" | "spending_paused">;

/** Names one admitted request's reservation in the usage store. */
export type ReservationId = string;

/**
 * How long a reservation holds headroom if its request never settles, as when its process dies in
 * flight. Longer than the 10-minute retry window, so a live request is never expired early;
 * a dead one gives its headroom back within this.
 */
export const RESERVATION_LEASE_MS = 15 * 60_000;

/**
 * Where billable input tokens are counted, per project and per UTC month (`YYYY-MM`). The store also
 * remembers which alerts went out this month, so each is raised once a month even across restarts.
 * It also holds the reservations of requests in flight, so every process on the same store shares
 * the headroom. `reserve` must check and insert in one atomic step (a single conditional update in a
 * database), or two processes can both pass the check.
 */
export type UsageStore = {
  add(projectId: string, month: string, inputTokens: number): Promise<void>;
  total(projectId: string, month: string): Promise<number>;
  /**
   * Reserves `requestTokens` for one request in flight, unless the month's count plus the project's
   * open reservations for that month already reach `limit`. `limit` is undefined for a project that
   * keeps answering, and then the reservation always goes through. A reservation is open until it is
   * released, or until `expiresAt` is no later than `now`, so a request whose process died in flight
   * gives its headroom back. Resolves the new reservation's id, or undefined when refused.
   */
  reserve(
    projectId: string,
    month: string,
    requestTokens: number,
    limit: number | undefined,
    now: number,
    expiresAt: number,
  ): Promise<ReservationId | undefined>;
  /**
   * Releases a reservation once its answer is counted, or has failed. A reservation already released
   * or expired is left as it is.
   */
  release(projectId: string, reservation: ReservationId): Promise<void>;
  /**
   * `add` and `release` in one atomic step (one statement or one transaction in a database): counts
   * an answer's input tokens and releases its request's reservation, so the reservation gives way to
   * the count with no moment where both or neither hold the headroom, in one round trip. A
   * reservation already released or expired is left as it is; the tokens are counted either way.
   */
  finish(
    projectId: string,
    month: string,
    reservation: ReservationId,
    inputTokens: number,
  ): Promise<void>;
  /** True only for the first claim of this alert in this month; false for every later one. */
  claimAlert(projectId: string, month: string, kind: SpendingAlertKind): Promise<boolean>;
  /** Gives a claim back when the alert reached no channel, so the next check raises it again. */
  releaseAlert(projectId: string, month: string, kind: SpendingAlertKind): Promise<void>;
};

export type SpendingDeps = {
  readonly usageStore: UsageStore;
  readonly clock: Clock;
  readonly alerts: Pick<Alerts, "raise">;
  /** The page where a project's cap is set; both spending alerts link to it. */
  readonly capLink: (projectId: string) => string;
};

export type Spending = {
  /**
   * Counts one answer's billable input tokens against the project's current month. A count whose write
   * fails is thrown here and written by the next call that reads the count, never dropped.
   */
  record(projectId: string, inputTokens: number): Promise<void>;
  /** The UTC calendar month's count so far. */
  monthlyTotal(projectId: string): Promise<number>;
  /**
   * The project's status against `cap`, computed from the stored count, so a pause ends by itself
   * when the month resets or the cap changes. The 80% warning and the pause alert are raised here
   * the first time their level is seen this month. If an alert could not be raised, this throws a
   * `SpendingAlertError` that still carries the status.
   */
  status(projectId: string, cap: SpendingCap): Promise<SpendingStatus>;
  /**
   * Admits one request of the project against `cap`, for every process whose spending shares the usage
   * store. The store counts the open reservations of the requests admitted before it (not yet counted or
   * expired), so one request may cross the cap and no more follow. Resolves the admitted request's
   * reservation, which holds `requestTokens` until `finish` or `settle`, or until its lease ends; undefined when
   * refused. `onAlertFailure` hears an alert that could not be raised; the decision stands either way.
   */
  admit(
    projectId: string,
    cap: SpendingCap,
    requestTokens: number,
    onAlertFailure?: (error: SpendingAlertError) => void,
  ): Promise<ReservationId | undefined>;
  /** Releases the reservation of a request that produced no answer. */
  settle(projectId: string, reservation: ReservationId): Promise<void>;
  /**
   * `record` and `settle` for an answered request in one store call: counts the answer's input tokens
   * and releases its reservation together. A write that fails is held and retried, reservation and
   * all, by the next call that reads the count, exactly as `record` holds a count; never dropped.
   */
  finish(projectId: string, reservation: ReservationId, inputTokens: number): Promise<void>;
};

/**
 * What the worker needs from spending, bound to one project. `allowsWork` is checked before every
 * claim and `admit` before every request. An answered request ends with `finish`, which counts the
 * answer, releases the reservation and re-checks the cap so the warning goes out at once; a request
 * with no answer ends with `settle`. `record` counts tokens with no reservation to release. The
 * reservations live in the usage store, so every process on the same store shares them.
 */
export type SpendingGate = {
  /**
   * `onAlertFailure` hears an alert that could not be raised; the decision is made either way, so a
   * failed alert never lets a project past its cap.
   */
  allowsWork(onAlertFailure?: (error: SpendingAlertError) => void): Promise<boolean>;
  /** Resolves the reservation of an admitted request, until `finish` or `settle`; see `Spending.admit`. */
  admit(
    requestTokens: number,
    onAlertFailure?: (error: SpendingAlertError) => void,
  ): Promise<ReservationId | undefined>;
  settle(reservation: ReservationId): Promise<void>;
  record(inputTokens: number): Promise<void>;
  /**
   * Counts an answered request's input tokens and releases its reservation in one store call, then
   * re-checks the cap. The count is stored before any alert is raised, so a `SpendingAlertError`
   * from here leaves nothing uncounted.
   */
  finish(reservation: ReservationId, inputTokens: number): Promise<void>;
};

/**
 * An alert that could not be raised. The status was settled before the alert went out, so it travels
 * with the error: a failed alert never changes whether a project may answer, only that it was not sent.
 */
export class SpendingAlertError extends Error {
  readonly status: SpendingStatus;

  constructor(status: SpendingStatus, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SpendingAlertError";
    this.status = status;
  }
}

/** An alert about every source of a project names no source. */
const EVERY_SOURCE = "all sources";

/**
 * A count of input tokens and the month it belongs to, held until the store takes it, with the
 * reservation of the request it paid for when that is released in the same write.
 */
type Uncounted = {
  readonly projectId: string;
  readonly month: string;
  readonly inputTokens: number;
  readonly reservation?: ReservationId;
};

/** The UTC calendar month of a clock reading, as `YYYY-MM`. */
export function monthOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}

/**
 * The status, with an alert that could not be raised reported to `onAlertFailure`. The status was
 * settled before the alert went out, so it still decides.
 */
async function statusReported(
  spending: Pick<Spending, "status">,
  projectId: string,
  cap: SpendingCap,
  onAlertFailure?: (error: SpendingAlertError) => void,
): Promise<SpendingStatus> {
  try {
    return await spending.status(projectId, cap);
  } catch (error) {
    if (!(error instanceof SpendingAlertError)) {
      throw error;
    }
    onAlertFailure?.(error);
    return error.status;
  }
}

export function createSpending(deps: SpendingDeps): Spending {
  const { usageStore, clock, alerts, capLink } = deps;
  /** Each project's admissions in this process, one at a time, so an alert is never raised twice in a row. */
  const admissions = new Map<string, Promise<unknown>>();
  /**
   * Counts whose write failed. The answer was paid for, so its tokens must reach the store: they wait
   * here and are written by the next call that reads the count. Held in memory, so a crash loses them.
   * Known gap: the store that owns `facetdb.usage` must persist a failed count before the process
   * can die. Pinned by the `it.fails` known-gap test in spending.test.ts; flip it to `it` then.
   */
  const uncounted: Uncounted[] = [];
  /** Each project's writes of held counts, one at a time, so a count already being written is waited for. */
  const writes = new Map<string, Promise<unknown>>();

  /** Takes one held count of the project out of the list, so no other call writes it too. */
  function takeHeld(projectId: string): Uncounted | undefined {
    const index = uncounted.findIndex((entry) => entry.projectId === projectId);
    return index === -1 ? undefined : uncounted.splice(index, 1)[0];
  }

  /**
   * Writes every held count of the project. A call starts only after the writes before it finish, so
   * when it resolves, every count held when it began is in the store, including one another call was
   * writing. A count whose write fails goes back, and the failure is thrown.
   */
  function countOwed(projectId: string): Promise<void> {
    const previous = writes.get(projectId) ?? Promise.resolve();
    const next = previous.then(async () => {
      for (let held = takeHeld(projectId); held !== undefined; held = takeHeld(projectId)) {
        try {
          if (held.reservation === undefined) {
            await usageStore.add(held.projectId, held.month, held.inputTokens);
          } else {
            await usageStore.finish(held.projectId, held.month, held.reservation, held.inputTokens);
          }
        } catch (error) {
          uncounted.push(held);
          throw error;
        }
      }
    });
    writes.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  }

  /** Returns the error when the raise itself failed; a refused channel is not an error here. */
  async function raiseOnce(
    projectId: string,
    month: string,
    kind: SpendingAlertKind,
    event: Omit<AlertEvent, "kind" | "project" | "source" | "question" | "link">,
  ): Promise<{ readonly error: unknown } | undefined> {
    if (!(await usageStore.claimAlert(projectId, month, kind))) {
      return undefined;
    }
    // The claim stands only once the alert is out cleanly. A channel that refused it, a raise that
    // threw, or a raise the alerts window held back gives the claim back, so the next check raises it
    // again (the alerts module sets the cadence), and a month's only alert is never lost to an outage.
    let outcome: AlertOutcome;
    try {
      outcome = await alerts.raise({
        ...event,
        kind,
        project: projectId,
        source: EVERY_SOURCE,
        question: null,
        link: capLink(projectId),
      });
    } catch (error) {
      await usageStore.releaseAlert(projectId, month, kind);
      return { error };
    }
    if (outcome.status !== "sent" || outcome.failures.length > 0) {
      await usageStore.releaseAlert(projectId, month, kind);
    }
    return undefined;
  }

  async function monthlyTotal(projectId: string): Promise<number> {
    await countOwed(projectId);
    return usageStore.total(projectId, monthOf(clock.now()));
  }

  async function record(projectId: string, inputTokens: number): Promise<void> {
    uncounted.push({ projectId, month: monthOf(clock.now()), inputTokens });
    await countOwed(projectId);
  }

  async function status(projectId: string, cap: SpendingCap): Promise<SpendingStatus> {
    await countOwed(projectId);
    const month = monthOf(clock.now());
    const total = await usageStore.total(projectId, month);
    // Integer comparisons only: 80% of the cap is `cap * 80 / 100`, never a rounded figure.
    const warningLevel = total * 100 >= cap.inputTokens * 80;
    const atCap = total >= cap.inputTokens;
    const pauses = cap.onCapReached === "pause";
    const usage = `${total} of ${cap.inputTokens} input tokens`;
    // Settled before any alert goes out, so a failed alert cannot change it.
    let current: SpendingStatus;
    if (!warningLevel) {
      current = "ok";
    } else if (!atCap) {
      current = "warned";
    } else {
      current = pauses ? "paused" : "continuing";
    }

    const warning = warningLevel
      ? await raiseOnce(projectId, month, "spending_80", {
          what: `This month's usage is at 80% of the spending cap: ${usage}.`,
          did: pauses
            ? "Nothing is paused yet; at 100% the project pauses and records stay pending."
            : "Nothing is paused yet; at 100% the project keeps answering.",
        })
      : undefined;
    const pause =
      atCap && pauses
        ? await raiseOnce(projectId, month, "spending_paused", {
            what: `This month's usage reached the spending cap: ${usage}.`,
            did: "Paused: records stay pending and are answered when the month resets or the cap changes.",
          })
        : undefined;

    const failed = warning ?? pause;
    if (failed !== undefined) {
      throw new SpendingAlertError(current, failed.error);
    }
    return current;
  }

  /**
   * A request may go only while the count plus every open reservation of the month is under the cap, so
   * one request crosses it and no more follow. The store makes that check and the reservation in one
   * step, so two processes on the same store cannot both pass it. A request is released only after its
   * answer is counted, so no answer is ever missed between them; a reservation whose process died is
   * released by its lease instead.
   */
  async function admit(
    projectId: string,
    cap: SpendingCap,
    requestTokens: number,
    onAlertFailure?: (error: SpendingAlertError) => void,
  ): Promise<ReservationId | undefined> {
    const previous = admissions.get(projectId) ?? Promise.resolve();
    const next = previous.then(async () => {
      // A refused write of an earlier answer fails this admission too: the store must take it first.
      await countOwed(projectId);
      // The status was settled before any alert went out, so it decides even when an alert failed.
      if ((await statusReported({ status }, projectId, cap, onAlertFailure)) === "paused") {
        return undefined;
      }
      const now = clock.now();
      return usageStore.reserve(
        projectId,
        monthOf(now),
        requestTokens,
        cap.onCapReached === "pause" ? cap.inputTokens : undefined,
        now,
        now + RESERVATION_LEASE_MS,
      );
    });
    admissions.set(
      projectId,
      next.catch(() => undefined),
    );
    return next;
  }

  function settle(projectId: string, reservation: ReservationId): Promise<void> {
    return usageStore.release(projectId, reservation);
  }

  /**
   * Through the held list, as `record`: a write that fails keeps the count and its reservation for
   * the next call that reads the count, so the cap never misses a paid answer. Until then the
   * reservation still holds the request's estimate, which errs toward the cap, never past it.
   */
  async function finish(
    projectId: string,
    reservation: ReservationId,
    inputTokens: number,
  ): Promise<void> {
    uncounted.push({ projectId, month: monthOf(clock.now()), inputTokens, reservation });
    await countOwed(projectId);
  }

  return { record, monthlyTotal, status, admit, settle, finish };
}

/**
 * Binds spending to one project for the worker. `readCap` is read on every check, so a changed cap
 * takes effect on the next pass.
 */
export function spendingGate(
  spending: Spending,
  projectId: string,
  readCap: () => Promise<SpendingCap>,
): SpendingGate {
  return {
    async allowsWork(onAlertFailure) {
      const status = await statusReported(spending, projectId, await readCap(), onAlertFailure);
      return status !== "paused";
    },
    async admit(requestTokens, onAlertFailure) {
      return spending.admit(projectId, await readCap(), requestTokens, onAlertFailure);
    },
    async settle(reservation) {
      await spending.settle(projectId, reservation);
    },
    async record(inputTokens) {
      await spending.record(projectId, inputTokens);
      await spending.status(projectId, await readCap());
    },
    async finish(reservation, inputTokens) {
      // The count is stored before the status raises any alert, so an alert failure loses nothing.
      await spending.finish(projectId, reservation, inputTokens);
      await spending.status(projectId, await readCap());
    },
  };
}
