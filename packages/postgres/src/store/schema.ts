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
];

/** The newest migration number this version of FacetDB knows. */
export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

const SCHEMA_LOCK = "facetdb.store_migrations";

/**
 * Brings the store to `SCHEMA_VERSION`. Safe to call on every start and from several processes at
 * once. A store written by a newer FacetDB is refused rather than guessed at.
 */
export async function migrateStore(client: SqlClient): Promise<void> {
  await client.transaction(async (query) => {
    await query("select pg_advisory_xact_lock(hashtext($1))", [SCHEMA_LOCK]);
    await query(`create schema if not exists ${quoteIdent("facetdb")}`);
    await query(`create table if not exists facetdb.store_migrations (
  version integer primary key,
  applied_at timestamptz not null default now()
)`);
    const applied = await appliedVersions(query);
    const newest = Math.max(0, ...applied);
    if (newest > SCHEMA_VERSION) {
      throw new Error(
        `the FacetDB store is at schema version ${newest}, newer than this FacetDB knows (${SCHEMA_VERSION}); upgrade FacetDB`,
      );
    }
    for (const migration of MIGRATIONS) {
      if (applied.includes(migration.version)) {
        continue;
      }
      for (const statement of migration.statements) {
        await query(statement);
      }
      await query("insert into facetdb.store_migrations (version) values ($1)", [
        migration.version,
      ]);
    }
  });
}

async function appliedVersions(query: SqlQuery): Promise<number[]> {
  const rows = await query("select version::text as version from facetdb.store_migrations");
  return rows.map((row) => Number(row["version"]));
}
