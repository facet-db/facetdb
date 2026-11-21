/**
 * How the page tells an install that ran nothing from one that started. Plain data, imported by
 * nothing but the service and the studio's drift test, so the studio's copy
 * (features/setup/outcome.ts) is held to it.
 *
 * Every code `POST /v1/sources/install` is refused with before facetdb.config.ts was written or any
 * statement ran: the HTTP surface's own refusals, which come before the service, and the service's
 * refusals before the door writes (install-routes.test.ts holds the service to this list). `POST
 * /v1/sources/:name/migrate/run` answers from the same list, and with the same stopped and unknown
 * codes, so the page sorts an added question's install as it sorts a setup's.
 */
export const INSTALL_NOTHING_RAN = [
  // The surface, before the service is called.
  "sign-in",
  "operator_only",
  "json_only",
  "cross_origin",
  "invalid_json",
  "invalid_request",
  // The service and the door, before the file is written.
  "setup_unavailable",
  "plan_not_shown",
  "plan_changed",
  "database_changed",
  "uncommitted_changes",
  "invalid_draft",
  "install_refused",
  // A table facetdb.config.ts already names under another source: refused by the plan in its own
  // code, and by an install as `install_refused`, before anything connects.
  "table-taken",
] as const;

/** The install started and stopped; the database and the file are as its words say. */
export const INSTALL_STOPPED = "install_stopped";

/** The install was started and how it ended is not known: the page says to look first. */
export const INSTALL_OUTCOME_UNKNOWN = "install_outcome_unknown";
