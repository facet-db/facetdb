/**
 * The small wordings the Settings page does itself, from what the endpoints carry (`GET /v1/studio`,
 * `/v1/project`, `/v1/config`, `/v1/home`). They state no number the endpoints do not give.
 */
import type { SpendingConfig } from "../../api/index.ts";

/** The prefix of a reviewer who did not sign in: the operating system's user (`OS_REVIEWER_PREFIX` of the server). */
const OS_PREFIX = "os:";

/** The account a signed-in reviewer is, or null for the OS user of this computer. */
export function accountNamed(reviewer: string): string | null {
  return reviewer.startsWith(OS_PREFIX) ? null : reviewer;
}

/** The OS user's name behind `os:alex`; undefined for a signed-in account. */
export function osUserOf(reviewer: string): string | undefined {
  return reviewer.startsWith(OS_PREFIX) ? reviewer.slice(OS_PREFIX.length) : undefined;
}

/** Dollars as the rail shows a cap: whole when whole, cents otherwise. */
export function money(dollars: number): string {
  return Number.isInteger(dollars) ? `$${String(dollars)}` : `$${dollars.toFixed(2)}`;
}

export function tokenWords(tokens: number): string {
  return `${tokens.toLocaleString("en-US")} billable input tokens`;
}

/** What happens when the month's usage reaches the cap, as the mockup words it. */
export const AT_CAP_WORDS = {
  pause: "Pause the project; records wait as pending",
  continue: "Keep answering past the cap; the warning at 80% still goes out",
} as const;

/**
 * Whether the file sets another cap than the worker enforces: a different number of tokens, a cap
 * where there was none or none where there was one, or another choice at 100% (which only matters
 * while there is a cap). `inForce` is the cap the worker started with, null for none.
 */
export function fileDiffersFromWorker(
  inForce: {
    readonly inputTokens: number;
    readonly onCapReached: SpendingConfig["onCapReached"];
  } | null,
  file: SpendingConfig,
): boolean {
  if (inForce === null || file.tokens === null) {
    return inForce !== null || file.tokens !== null;
  }
  return inForce.inputTokens !== file.tokens || inForce.onCapReached !== file.onCapReached;
}

/** What the file sets, in words: "a monthly cap of 1,000,000 billable input tokens, and the project pauses at 100%". */
export function fileSetsWords(file: SpendingConfig): string {
  if (file.tokens === null) {
    return "no monthly cap";
  }
  const atCap =
    file.onCapReached === "pause"
      ? "the project pauses at 100%"
      : "the project keeps answering past 100%";
  return `a monthly cap of ${tokenWords(file.tokens)}, and ${atCap}`;
}

/** The addresses that mean "every interface": the studio is then open to the network. */
const EVERY_INTERFACE = ["0.0.0.0", "::"];

/** Where the studio listens, in words. */
export function listensWords(host: string): string {
  return EVERY_INTERFACE.includes(host)
    ? `${host}, every network interface of this computer`
    : host;
}

/** "no accounts", "one account", "2 accounts". */
export function accountsWords(count: number): string {
  if (count === 0) {
    return "no reviewer accounts";
  }
  return count === 1 ? "one reviewer account" : `${String(count)} reviewer accounts`;
}
