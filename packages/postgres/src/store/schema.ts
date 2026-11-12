import { jobsTableSql, quoteIdent, type SqlClient, type SqlQuery } from "../sql/index.ts";

/**
 * The store's own migrations. Each is a numbered list of statements written to be idempotent
 * (`if not exists`); `facetdb.store_migrations` records which numbers ran, so a restart runs only
 * what is new, and two processes starting at once take turns on an advisory lock. A migration is
 * only ever appended to the list, never edited once released.
 */
type Migration = { readonly version: number; readonly statements: readonly string[] };

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      // Per-install salt for the key derivation (crypto.ts); filled on first start.
      `create table if not exists facetdb.install (
  key text primary key,
  value text not null
)`,
      `create table if not exists facetdb.projects (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
)`,
      `create table if not exists facetdb.sources (
  id text primary key,
  project_id text not null references facetdb.projects (id),
  name text not null,
  kind text not null check (kind in ('plugin', 'api')),
  created_at timestamptz not null default now(),
  unique (project_id, name)
)`,
      `create table if not exists facetdb.question_set_versions (
  source_id text not null,
  version integer not null,
  content_hash text not null,
  question_set jsonb not null,
  created_at timestamptz not null default now(),
  primary key (source_id, version)
)`,
      // One row per model call holding every answer as JSON, one row per human decision.
      `create table if not exists facetdb.decisions (
  id bigserial primary key,
  source_id text not null,
  record_key text not null,
  kind text not null check (kind in ('answer', 'human')),
  version integer not null,
  state_hash text not null,
  model text,
  answers jsonb,
  usage jsonb,
  question text,
  value jsonb,
  reviewer text,
  note text,
  at timestamptz not null,
  check ((kind = 'answer' and model is not null and answers is not null and usage is not null)
      or (kind = 'human' and question is not null and value is not null and reviewer is not null))
)`,
      `create index if not exists decisions_by_record on facetdb.decisions (source_id, record_key, id)`,
      ...jobsTableSql(),
      // Records of plugin and API sources: the state the model is shown, its hash, and the decision.
      `create table if not exists facetdb.records (
  source_id text not null,
  record_key text not null,
  state jsonb not null,
  hash text not null,
  status text not null,
  decision jsonb,
  reviewed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (source_id, record_key)
)`,
      // Ciphertext only: crypto.ts seals every value, and nothing here is ever a plaintext credential.
      `create table if not exists facetdb.credentials (
  project_id text not null references facetdb.projects (id),
  name text not null,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, name)
)`,
      // Hashes only: the key itself is shown once, when it is created.
      `create table if not exists facetdb.api_keys (
  id text primary key,
  project_id text not null references facetdb.projects (id),
  name text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
)`,
      `create table if not exists facetdb.usage (
  project_id text not null,
  month text not null,
  input_tokens bigint not null default 0,
  primary key (project_id, month)
)`,
      `create table if not exists facetdb.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  month text not null,
  tokens bigint not null,
  expires_at bigint not null
)`,
      `create index if not exists usage_reservations_by_month on facetdb.usage_reservations (project_id, month)`,
      `create table if not exists facetdb.usage_alerts (
  project_id text not null,
  month text not null,
  kind text not null,
  primary key (project_id, month, kind)
)`,
      // The alerts awaiting resolution, their history and each project's last heartbeat.
      `create table if not exists facetdb.alerts (
  key text primary key,
  state jsonb not null
)`,
      `create table if not exists facetdb.alert_history (
  id bigserial primary key,
  record jsonb not null
)`,
      `create table if not exists facetdb.heartbeats (
  project text primary key,
  at bigint not null
)`,
      `create table if not exists facetdb.cursors (
  run text primary key,
  cursor text,
  done boolean not null
)`,
    ],
  },
  {
    version: 2,
    statements: [
      // The webhook outbox (retried with backoff for 24 hours). It lives in the store so
      // `facetdb migrate` makes it with the admin credential: the worker login holds no CREATE
      // on the schema (found on Supabase, when the worker made it).
      `create table if not exists facetdb.webhook_outbox (
  id bigserial primary key,
  project_id text not null,
  endpoint text not null,
  payload text not null,
  attempts integer not null default 0,
  created_at bigint not null,
  next_attempt_at bigint not null,
  delivered_at bigint,
  gave_up_at bigint,
  last_error text,
  claimed_by text
)`,
      // An outbox a worker made before outcomes were checked against the claim has no `claimed_by`.
      `alter table facetdb.webhook_outbox add column if not exists claimed_by text`,
      `create index if not exists webhook_outbox_due on facetdb.webhook_outbox (next_attempt_at)
  where delivered_at is null and gave_up_at is null`,
    ],
  },
];

/** The newest migration number this version of FacetDB knows. */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

/**
 * Every table the store's migrations create, in an order a drop can follow (referencing tables
 * before the ones they reference). `facetdb migrate` grants the worker login its rights on these
 * and `facetdb uninstall` removes them; a test compares the list with what the migrations really
 * create, so a new table missing here fails the suite instead of failing the worker at run time.
 */
export const STORE_TABLES: readonly string[] = [
  "api_keys",
  "credentials",
  "sources",
  "projects",
  "question_set_versions",
  "decisions",
  "jobs",
  "records",
  "usage",
  "usage_reservations",
  "usage_alerts",
  "alerts",
  "alert_history",
  "heartbeats",
  "cursors",
  "install",
  "webhook_outbox",
];

/** The version table: the worker reads it to see that nothing is left to migrate, and writes nothing. */
export const STORE_VERSION_TABLE = "store_migrations";

/** The sequences behind the store's `bigserial` columns; the worker needs `usage, select` on them. */
export const STORE_SEQUENCES: readonly string[] = [
  "decisions_id_seq",
  "alert_history_id_seq",
  "webhook_outbox_id_seq",
];

const VERSION_TABLE_SQL = `create table if not exists facetdb.store_migrations (
  version integer primary key,
  applied_at timestamptz not null default now()
)`;

/** The statement that records one migration as applied; written to be run again. */
function recordMigration(version: number): string {
  return `insert into facetdb.store_migrations (version) values (${version}) on conflict (version) do nothing`;
}

/**
 * The store's whole DDL as one idempotent script, for the install script `facetdb migrate` prints
 * and runs with the admin credential: the schema, the version table, every migration in order and
 * the rows that mark them applied. `migrateStore` runs the same statements, so the two cannot drift.
 */
export function storeInstallStatements(): string[] {
  return [
    `create schema if not exists ${quoteIdent("facetdb")}`,
    VERSION_TABLE_SQL,
    ...MIGRATIONS.flatMap((migration) => [
      ...migration.statements,
      recordMigration(migration.version),
    ]),
  ];
}

const SCHEMA_LOCK = "facetdb.store_migrations";

/** The store is behind this FacetDB and the login cannot create what is missing (it is not an admin). */
export class StoreNotInstalledError extends Error {
  constructor(found: number) {
    const state =
      found === 0
        ? "not installed"
        : `at schema version ${found}, behind this FacetDB (${SCHEMA_VERSION})`;
    super(
      `the FacetDB store is ${state}, and this login may not create tables; run \`facetdb migrate\` with the admin credential`,
    );
    this.name = "StoreNotInstalledError";
  }
}

/**
 * Brings the store to `SCHEMA_VERSION`. Safe to call on every start and from several processes at
 * once. A store written by a newer FacetDB is refused rather than guessed at. A store that is
 * already current is only read, with no DDL (not even `if not exists`, which a login without CREATE
 * is refused); one that is behind is migrated when the login may create, and otherwise the error
 * names the fix (`StoreNotInstalledError`).
 */
export async function migrateStore(client: SqlClient): Promise<void> {
  const seen = await currentVersions(client.query);
  if (seen !== undefined && isCurrent(seen)) {
    return;
  }
  const may = await client.query(
    `select case when to_regnamespace('facetdb') is null
                 then has_database_privilege(current_database(), 'create')
                 else has_schema_privilege('facetdb', 'create') end as may`,
  );
  if (may[0]?.["may"] !== true) {
    throw new StoreNotInstalledError(Math.max(0, ...(seen ?? [])));
  }
  await client.transaction(async (query) => {
    await query("select pg_advisory_xact_lock(hashtext($1))", [SCHEMA_LOCK]);
    await query(`create schema if not exists ${quoteIdent("facetdb")}`);
    await query(VERSION_TABLE_SQL);
    const applied = await appliedVersions(query);
    refuseNewer(applied);
    for (const migration of MIGRATIONS) {
      if (applied.includes(migration.version)) {
        continue;
      }
      for (const statement of migration.statements) {
        await query(statement);
      }
      await query(recordMigration(migration.version));
    }
  });
}

function refuseNewer(applied: readonly number[]): void {
  const newest = Math.max(0, ...applied);
  if (newest > SCHEMA_VERSION) {
    throw new Error(
      `the FacetDB store is at schema version ${newest}, newer than this FacetDB knows (${SCHEMA_VERSION}); upgrade FacetDB`,
    );
  }
}

function isCurrent(applied: readonly number[]): boolean {
  return MIGRATIONS.every((migration) => applied.includes(migration.version));
}

/** The applied versions, or undefined when the version table does not exist; a newer store is refused. */
async function currentVersions(query: SqlQuery): Promise<number[] | undefined> {
  const present = await query(
    "select to_regclass('facetdb.store_migrations') is not null as present",
  );
  if (present[0]?.["present"] !== true) {
    return undefined;
  }
  const applied = await appliedVersions(query);
  refuseNewer(applied);
  return applied;
}

async function appliedVersions(query: SqlQuery): Promise<number[]> {
  const rows = await query("select version::text as version from facetdb.store_migrations");
  return rows.map((row) => Number(row["version"]));
}
