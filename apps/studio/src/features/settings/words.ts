/**
 * The small wordings the Settings page does itself, from what the endpoints carry (`GET /v1/studio`,
 * `/v1/project`, `/v1/config`, `/v1/home`). They state no number the endpoints do not give.
 */
import { compactTokens } from "../../shell/index.ts";
import type { FieldProblem } from "./Field.tsx";

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

/** What happens when the month's usage reaches the cap, as the mockup words it. */
export const AT_CAP_WORDS = {
  pause: "Pause the project; records wait as pending",
  continue: "Keep answering past the cap; the warning at 80% still goes out",
} as const;

// Whether the file sets another cap than the worker, and in what words, is the shell's
// (`fileDiffersFromWorker`, `fileSetsWords`): Home's spending column and the rail say it too.

/** A thousand, a million or a billion, as a person writes a cap: "500k", "3M", "1.5m", "2B". */
const CAP_UNITS: Readonly<Record<string, number>> = { k: 1_000, m: 1_000_000, b: 1_000_000_000 };

/**
 * The cap as typed into the form: a whole number of billable input tokens, with commas, spaces or
 * underscores between the digits as a person writes them, or a short form such as 5M or 500k
 * (one decimal place at most, and the result a whole number). The loader judges it again on save.
 */
export function capFromText(
  text: string,
):
  | { readonly ok: true; readonly tokens: number }
  | { readonly ok: false; readonly problem: FieldProblem } {
  const compact = text.replace(/[\s,_]/g, "");
  const short = /^(\d+)(?:\.(\d+))?([kKmMbB])$/.exec(compact);
  let tokens = Number.NaN;
  if (short?.[1] !== undefined && short[3] !== undefined) {
    // The decimal shifted on the digits, not a float product: "1.005M" is exactly 1,005,000.
    const zeros = Math.log10(CAP_UNITS[short[3].toLowerCase()] ?? Number.NaN);
    const fraction = short[2] ?? "";
    tokens =
      Number.isNaN(zeros) || fraction.length > zeros
        ? Number.NaN
        : Number(`${short[1]}${fraction.padEnd(zeros, "0")}`);
  } else if (/^\d+$/.test(compact)) {
    tokens = Number(compact);
  }
  if (Number.isSafeInteger(tokens) && tokens > 0) {
    return { ok: true, tokens };
  }
  return {
    ok: false,
    problem: {
      message:
        compact === ""
          ? "The cap is empty."
          : tokens === 0
            ? "The cap is 0 tokens, which would pause the project before its first record."
            : "The cap is a whole number of billable input tokens.",
      fix: "Type a number of tokens such as 5,000,000 or 5M, or tick No monthly cap.",
    },
  };
}

/** The cap as the form shows it: the short form when it says the whole number ("5M"), else the digits grouped. */
export function capText(tokens: number): string {
  const glance = compactTokens(tokens);
  const parsed = capFromText(glance);
  return parsed.ok && parsed.tokens === tokens ? glance : tokens.toLocaleString("en-US");
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
