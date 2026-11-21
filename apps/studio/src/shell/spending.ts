import type { StatusKind } from "@facetdb/ui";
import { useQuery } from "@tanstack/react-query";
import { type Home, type SpendingConfig, spendingConfigQuery } from "../api/index.ts";
import { useApi } from "../deps.tsx";

/**
 * The project's spending against its cap as a status word, one table for Home's column and the
 * rail's foot so the two never disagree (a warning at 80%, critical when the cap is reached and the
 * project pauses). The figures round a count past the cap to the cap's own ("$0.04 of $0.04", a
 * real run), so the word says what they cannot. Under the cap and with no cap set, there is no
 * word.
 */
export const SPENDING_STATE: Readonly<
  Partial<
    Record<Home["spending"]["status"], { readonly status: StatusKind; readonly label: string }>
  >
> = {
  warned: { status: "warning", label: "Past the warning line" },
  paused: { status: "critical", label: "Paused at the cap" },
  continuing: { status: "warning", label: "Cap reached, still answering" },
};

const TOKEN_UNITS = [
  { from: 999_500_000, per: 1_000_000_000, mark: "B" },
  { from: 999_500, per: 1_000_000, mark: "M" },
  { from: 10_000, per: 1_000, mark: "k" },
] as const;

/** "3,000,134": the whole count with its thousands grouped. */
export function groupedTokens(tokens: number): string {
  return Math.max(0, Math.round(tokens)).toLocaleString("en-US");
}

/**
 * "3M", "1.5M", "850k", "12.5k", "8,500": a token count as a person reads it at a glance, the
 * same form as core's `compactTokens`, which words the worker's figures and alerts (the studio
 * bundle takes no core code, so the rule is spelled here too, and shell.test.tsx pins both agree).
 */
export function compactTokens(tokens: number): string {
  const whole = Math.max(0, Math.round(tokens));
  for (const unit of TOKEN_UNITS) {
    if (whole >= unit.from) {
      const value = whole / unit.per;
      const text =
        value < 100
          ? (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/, "")
          : String(Math.round(value));
      return `${text}${unit.mark}`;
    }
  }
  return whole.toLocaleString("en-US");
}

/** "$3.20"; "$25" for whole dollars; "less than $0.01" for a cost the cents cannot show; "$0" for none. */
export function moneyWords(dollars: number): string {
  const cents = Math.round(dollars * 100);
  if (cents === 0) {
    return dollars > 0 ? "less than $0.01" : "$0";
  }
  return cents % 100 === 0
    ? `$${(cents / 100).toLocaleString("en-US")}`
    : `$${(cents / 100).toFixed(2)}`;
}

/** The rail's second line under the token figure: "$0.14 of $0.25", or "$0.14" with no cap. */
export function spentMoneyWords(spending: Home["spending"]): string {
  const spent = moneyWords(spending.dollars);
  return spending.cap === null ? spent : `${spent} of ${moneyWords(spending.cap.dollars)}`;
}

/** "40M billable input tokens (40,000,000)"; "8,500 billable input tokens" where the glance is exact. */
export function tokenWords(tokens: number): string {
  const glance = compactTokens(tokens);
  const exact = groupedTokens(tokens);
  return `${glance} billable input tokens${glance === exact ? "" : ` (${exact})`}`;
}

/**
 * Whether the file sets another cap than the worker enforces: a different number of tokens, a cap
 * where there was none or none where there was one, or another choice at 100% (which only matters
 * while there is a cap). `inForce` is the cap the worker enforces now (`GET /v1/home`), null for
 * none. The worker takes the file's cap at every Apply and reload, so the two differ only when the
 * file was edited by hand since, or its last reload did not load; Settings offers the reload then.
 * Settings, Home's spending column and the rail's foot all ask this one question.
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

/** Home's sentence under the worker's figures when the file sets another cap. */
export function fileCapAheadWords(sets: string): string {
  return `facetdb.config.ts sets ${sets}, which the worker has not taken up: apply it from Settings.`;
}

/** The rail's shorter line for the same: its column is too narrow for the whole cap in words. */
export const FILE_CAP_AHEAD_SHORT = "facetdb.config.ts sets another cap: apply it from Settings.";

/**
 * What facetdb.config.ts sets, in words, when it is not the cap the worker enforces; null while they
 * agree or either is not known (a read that fails says nothing here: Settings says it). Home and
 * the rail show it beside the worker's figures, which are the cap in force.
 */
export function useFileCapAhead(inForce: Home["spending"]["cap"] | undefined): string | null {
  const api = useApi();
  const file = useQuery(spendingConfigQuery(api));
  return inForce !== undefined &&
    file.data !== undefined &&
    fileDiffersFromWorker(inForce, file.data)
    ? fileSetsWords(file.data)
    : null;
}
