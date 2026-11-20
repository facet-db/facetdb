import { ApiError } from "../../api/index.ts";

/**
 * What a failed install left (review blocks B and C): the page says "nothing has changed" only for
 * a refusal the worker gives before it writes the file or runs a statement. The list is the
 * server's own (packages/server, sources/install-codes.ts), copied here since the studio does not
 * depend on the server; outcome.test.ts holds the copy to the original.
 */
export const INSTALL_NOTHING_RAN: readonly string[] = [
  "sign-in",
  "operator_only",
  "json_only",
  "cross_origin",
  "invalid_json",
  "invalid_request",
  "setup_unavailable",
  "plan_not_shown",
  "plan_changed",
  "database_changed",
  "uncommitted_changes",
  "invalid_draft",
  "install_refused",
  "table-taken",
];

/** The install started and stopped: the database and the file are as the worker's words say. */
export const INSTALL_STOPPED = "install_stopped";

export type InstallFailure =
  /** Refused before anything was written or run: the SQL is shown again, then installed. */
  | { readonly kind: "nothing-ran"; readonly error: ApiError }
  /** Started and stopped: the worker's words say what stays and what to run. */
  | { readonly kind: "stopped"; readonly error: ApiError }
  /**
   * No answer that says: the network failed after the request left, the answer was not the
   * worker's, or the worker itself could not learn how the run ended.
   */
  | { readonly kind: "unknown"; readonly error: Error };

export function installFailure(error: unknown): InstallFailure {
  if (error instanceof ApiError) {
    if (INSTALL_NOTHING_RAN.includes(error.code)) {
      return { kind: "nothing-ran", error };
    }
    if (error.code === INSTALL_STOPPED) {
      return { kind: "stopped", error };
    }
  }
  return {
    kind: "unknown",
    error: error instanceof Error ? error : new Error(String(error)),
  };
}
