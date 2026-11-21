import type { StatusKind } from "@facetdb/ui";
import type { Home } from "../api/index.ts";

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
