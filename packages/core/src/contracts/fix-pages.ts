/**
 * Every docs page FacetDB's own words link to: each code a `see:` line, a doctor line or an alert's
 * fallback link can print as `https://docs.facetdb.dev/fix/<code>`, and the two pages that are not
 * fix pages. Plain data, with no import: the CLI and the engines make their codes where they always
 * have, and fix-pages.test.ts reads their sources and fails when one makes a code this table lacks,
 * or when the table holds one nothing makes. A change that adds a code a link can print adds it
 * here.
 *
 * Each code sits in the docs area that owns its page. A code only the MySQL, MariaDB, SQL Server
 * and Azure SQL engines give (packages/mysql, packages/mssql) is `mysql-sqlserver`'s; one only
 * MongoDB, SQLite, libSQL, or the CockroachDB and Oracle dialects give (packages/mongodb,
 * packages/sqlite, packages/sql-polling/src/dialects) is `mongodb-sqlite-polling`'s; one that more
 * than one of those groups gives, or Postgres, the polling engine every dialect shares, or the CLI
 * also gives, is in `doctor`, `init`, `install`, `migrate` or `uninstall`. Two codes are placed by
 * name before a second engine gives them: `grants`, every engine's one check of the worker's
 * rights, and `table-busy`, which other engines will give beside Oracle's.
 */

/** Each docs area, with the number its pages are tracked under. */
export const FIX_AREAS = {
  doctor: 220,
  init: 319,
  install: 319,
  migrate: 319,
  uninstall: 319,
  worker: 221,
  studio: 221,
  alerts: 221,
  backfill: 221,
  plugins: 221,
  config: 320,
  commands: 320,
  reference: 223,
  engines: 224,
  "mysql-sqlserver": 301,
  "mongodb-sqlite-polling": 302,
} as const;

export type FixArea = keyof typeof FIX_AREAS;

/**
 * The name of every check `facetdb doctor` runs, the CLI's and each engine's, by the area that owns
 * its page. A check's code is `doctor-<name>`, derived here and written nowhere else.
 */
export const DOCTOR_CHECKS_BY_AREA = {
  doctor: [
    "capture",
    "config",
    "database",
    "distance",
    "engine",
    "grants",
    "install",
    "model-key",
    "model-name",
    "model-reachable",
    "plugins",
    "polling",
    "pooler",
    "queue",
    "secret",
    "store",
    "version",
    "worker",
  ],
  "mysql-sqlserver": [
    "app-writes",
    "binlog",
    "change-tracking",
    "containment",
    "sql-mode",
    "trigger",
  ],
  "mongodb-sqlite-polling": [
    "dialect",
    "file",
    "lock",
    "login",
    "marks",
    "oplog",
    "oplog-window",
    "replica-set",
    "server",
    "sqlite",
    "token",
    "wal",
  ],
} as const satisfies Partial<Record<FixArea, readonly string[]>>;

export type DoctorCheckName =
  (typeof DOCTOR_CHECKS_BY_AREA)[keyof typeof DOCTOR_CHECKS_BY_AREA][number];

/** Every other code a docs link can print, by the area that owns its page. */
export const FIX_CODES_BY_AREA = {
  init: [
    "admin-url",
    "admin-url-scheme",
    "admin-url-tls",
    "connector-polling",
    "database-changed",
    "database-url",
    "database-url-tls",
    "init-answer",
    "init-azure-database",
    "init-config-exists",
    "init-config-path",
    "init-database-url",
    "init-engine",
    "init-example",
    "init-oracle-schema",
    "init-oracle-service",
    "init-skills",
    "init-store-url",
    "init-table",
    "init-triggers",
    "store-not-postgres",
    "store-pglite",
    "store-polling",
    "store-secret",
    "unknown-scheme",
  ],
  install: [
    "another-project",
    "last-changed-column",
    "no-database",
    "no-table",
    "not-installed",
    "polling-read",
    "polling-scheme",
    "polling-side-table",
    "primary-key",
    "server-version",
    "side-table",
    "state-field",
    "table-busy",
    "worker-login",
    "worker-login-busy",
    "worker-login-created",
    "worker-password",
  ],
  migrate: [
    "migrate-refused",
    "store-busy",
    "store-left-behind",
    "store-login",
    "store-newer",
    "store-not-current",
  ],
  uninstall: ["prune-refused", "several-names", "uninstall-refused"],
  worker: [
    "connections",
    "missing-object",
    "model-call",
    "model-key",
    "model-provider",
    "no-worker-yet",
    "question-set",
    "question-set-version",
    "source-stopped",
    "spending-cap",
    "too-many-connections",
    "worker",
  ],
  studio: ["host", "port", "studio-not-built", "table-taken"],
  alerts: [
    "action-credential",
    "actions",
    "alerts",
    "channel-quiet-zone",
    "channel-where",
    "webhooks",
  ],
  backfill: [
    "backfill",
    "backfill-paused",
    "backfill-plugin",
    "backfill-stopped",
    "from-log-question",
    "pace",
  ],
  plugins: [
    "action-settings",
    "add-usage",
    "install-failed",
    "install-not-started",
    "no-package-json",
    "plugin-core-version",
    "plugin-invalid",
    "plugin-name",
    "plugin-named-twice",
    "plugin-no-action",
    "plugin-no-channel",
    "plugin-no-source",
    "plugin-not-installed",
    "plugin-package",
    "plugin-secret-literal",
    "plugin-settings",
    "plugin-unknown",
    "plugin-variable-unset",
    "registry-address",
    "registry-invalid",
    "registry-unreadable",
    "source-settings",
  ],
  config: [
    "config",
    "config-differs",
    "config-may-differ",
    "no-table-source",
    "several-connectors",
    "several-databases",
    "unknown-question",
    "unknown-source",
    "which-source",
  ],
  commands: [
    "dev-address",
    "export-out-exists",
    "limit",
    "no-account",
    "no-answer",
    "no-password",
    "no-such-user",
    "no-terminal",
    "no-version",
    "not-confirmed",
    "password-mismatch",
    "review-below",
    "review-from-failed",
    "review-from-file",
    "review-from-flags",
    "review-from-source",
    "review-limit",
    "review-queue",
    "review-user",
    "review-yes",
    "row-read",
    "rows-refused",
    "sample",
    "seed-empty",
    "seed-failed",
    "seed-file",
    "seed-transaction",
    "test-fields",
    "types-out-exists",
    "unexpected",
    "unsure",
    "usage",
    "user-exists",
    "users-not-writable",
    "weak-password",
    "wrong-login",
  ],
  "mysql-sqlserver": [
    "admin-rights",
    "binlog-format",
    "change-tracking-columns",
    "change-tracking-off",
    "change-tracking-retention",
    "column-collision",
    "column-type",
    "database-owner",
    "jobs-table",
    "key-type",
    "log-bin",
    "memory-optimized",
    "missing-column",
    "name-length",
    "name-taken",
    "name-too-long",
    "no-side-table",
    "not-a-table",
    "queue-key",
    "sql-mode",
    "state-column",
    "state-type",
    "storage-mode",
    "table-engine",
    "table-owner",
    "trigger-name",
    "view-bound",
    "worker-host",
    "worker-roles",
    "worker-user",
  ],
  "mongodb-sqlite-polling": [
    "database-login",
    "journal-mode",
    "libsql-auth-token",
    "libsql-token-in-url",
    "libsql-url",
    "no-file",
    "no-replica-set",
    "one-worker",
    "oracle-schema",
    "polling-table",
    "sqlite-path",
    "users-refused",
    "where-unsupported",
  ],
} as const satisfies Partial<Record<FixArea, readonly string[]>>;

/** A code of the table: its page is `https://docs.facetdb.dev/fix/<code>`. */
export type FixCode =
  | `doctor-${DoctorCheckName}`
  | (typeof FIX_CODES_BY_AREA)[keyof typeof FIX_CODES_BY_AREA][number];

/** One entry per code, each with the area that owns its page: every doctor check's, then the rest. */
export const FIX_CODES = Object.fromEntries([
  ...Object.entries(DOCTOR_CHECKS_BY_AREA).flatMap(([area, names]) =>
    names.map((name) => [`doctor-${name}`, area]),
  ),
  ...Object.entries(FIX_CODES_BY_AREA).flatMap(([area, codes]) =>
    codes.map((code) => [code, area]),
  ),
]) as Readonly<Record<FixCode, FixArea>>;

/**
 * The two pages the CLI links to that are not fix pages, each at `https://docs.facetdb.dev/<page>`:
 * every database's connection string (`DATABASES_PAGE`) and the config file (`init`'s comment).
 */
export const OTHER_DOCS_PAGES = {
  databases: "engines",
  config: "reference",
} as const satisfies Readonly<Record<string, FixArea>>;

export type OtherDocsPage = keyof typeof OTHER_DOCS_PAGES;
