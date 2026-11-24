import {
  jobsTableSql,
  LOCK_TIMEOUT,
  lockTimeoutStatement,
  quoteIdent,
  quoteLiteral,
  type SqlClient,
  type SqlQuery,
  unlessColumn,
  unlessConstraint,
  unlessRelation,
} from "../sql/index.ts";

/**
 * The store's own migrations. Each is a numbered list of statements written to be idempotent (`if
 * not exists`; an index or a column looked up first, by `unlessRelation` and `unlessColumn`, so a
 * repeat run locks nothing: the install runs these again beside a live application, with the same
 * effect as the `if not exists` they replaced); `facetdb.store_migrations` records which numbers
 * ran, so a restart runs only what is new, and two processes starting at once take turns on an
 * advisory lock. A migration is only ever appended to the list, never edited once released, with
 * one exception made once: a later version rewrote the index and column statements of the released
 * migrations into their looked-up form, the same effect on every store and the version numbers
 * untouched, because the install re-runs every migration's text beside a live application and a new
 * migration would have left the locking text in it.
 */
type Migration = { readonly version: number; readonly statements: readonly string[] };

/** Admits one request against the spending cap in one statement (migration 3, `UsageStore.reserve`). */
export const RESERVE_USAGE_FUNCTION = "facetdb.reserve_usage";

/** The function with its argument types, as `grant`, `revoke` and `drop function` name it. */
export const RESERVE_USAGE_FUNCTION_SIGNATURE = `${RESERVE_USAGE_FUNCTION}(text, text, bigint, bigint, bigint, bigint)`;

/**
 * Migration 1's `facetdb.projects`, named so the install can tell it apart: `table_owners`
 * references it, so the source's database needs it whatever the store (install/sql.ts).
 */
export const PROJECTS_TABLE_SQL = `create table if not exists facetdb.projects (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
)`;

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      // Per-install salt for the key derivation (crypto.ts); filled on first start.
      `create table if not exists facetdb.install (
  key text primary key,
  value text not null
)`,
      PROJECTS_TABLE_SQL,
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
      unlessRelation(
        "facetdb.decisions_by_record",
        `create index decisions_by_record on facetdb.decisions (source_id, record_key, id)`,
      ),
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
      unlessRelation(
        "facetdb.usage_reservations_by_month",
        `create index usage_reservations_by_month on facetdb.usage_reservations (project_id, month)`,
      ),
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
      // The webhook outbox (retried with backoff for 24 hours). It lives in the store so `facetdb
      // migrate` makes it with the admin credential: the worker login holds no CREATE on the schema
      // (found on Supabase, when the worker made it).
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
      unlessColumn(
        "facetdb.webhook_outbox",
        "claimed_by",
        `alter table facetdb.webhook_outbox add column claimed_by text`,
      ),
      unlessRelation(
        "facetdb.webhook_outbox_due",
        `create index webhook_outbox_due on facetdb.webhook_outbox (next_attempt_at)
  where delivered_at is null and gave_up_at is null`,
      ),
    ],
  },
  {
    version: 3,
    statements: [
      // A request is admitted against the month's count plus the open reservations, one step for
      // every process on the store. It is one statement (one round trip, no transaction to hold a
      // connection), and one statement alone cannot do it: its snapshot is taken before it waits
      // for the usage row's lock, so it never counts the reservation the lock holder commits
      // meanwhile (store.db.test.ts, "refuses when the reservation it waited behind fills the
      // cap"). Each statement of a volatile function takes a fresh snapshot under read committed,
      // so the count below, after the lock, sees it. Security invoker: it runs with the caller's
      // rights on the tables, and only the worker may call it.
      `create or replace function ${RESERVE_USAGE_FUNCTION}(
  for_project text, for_month text, request_tokens bigint, token_limit bigint, at_ms bigint,
  lease_ends bigint, out reservation_id text, out month_total bigint)
language plpgsql
set search_path = ''
as $$
begin
  -- The month's usage row is the lock: a second reserve of the project waits here for the first
  -- to commit, and a finish takes the same row before the reservation, so neither order deadlocks.
  -- A project with no limit keeps answering whatever the count, so it needs no lock.
  if token_limit is not null then
    insert into facetdb.usage (project_id, month, input_tokens) values (for_project, for_month, 0)
    on conflict (project_id, month) do update set input_tokens = facetdb.usage.input_tokens;
  end if;
  -- Reservations whose lease ended give their headroom back; clearing them keeps the table small.
  delete from facetdb.usage_reservations r where r.project_id = for_project and r.expires_at <= at_ms;
  month_total := coalesce((select u.input_tokens from facetdb.usage u
                            where u.project_id = for_project and u.month = for_month), 0);
  insert into facetdb.usage_reservations (project_id, month, tokens, expires_at)
  select for_project, for_month, request_tokens, lease_ends
   where token_limit is null
      or month_total + coalesce((select sum(r.tokens) from facetdb.usage_reservations r
                                  where r.project_id = for_project and r.month = for_month
                                    and r.expires_at > at_ms), 0) < token_limit
  returning id::text into reservation_id;
end
$$`,
      `revoke all on function ${RESERVE_USAGE_FUNCTION_SIGNATURE} from public`,
    ],
  },
  {
    version: 4,
    statements: [
      // A source's id is `<project>:<name>` (`sourceIdOf`). Every `sources` row whose id is still
      // the bare name is rekeyed with its own `project_id`, in the migration's transaction,
      // together with each column that holds the id: `decisions.source_id`,
      // `question_set_versions.source_id`, `records.source_id`, and `jobs.record_key`, which embeds
      // it as the store queue's prefix `<length>:<id>:` (connector.ts `queuePrefix`, the length in
      // UTF-16 code units as JavaScript counts it). Only a source holding records has store jobs: a
      // table source's jobs, in the same table when the store shares the customer's database, are
      // keyed by the table's own key and left alone. Nothing else embeds a source id: a cursor's
      // `run` is `all@v<version>` or `only@v<version>:<questions>`, and an outbox row holds the
      // project, the endpoint and the payload. A log a second project wrote under the first's row
      // cannot be told apart and stays with the first (`rekeyNotes` names it). A row already
      // rekeyed never has `id = name`, so the statement runs again harmlessly.
      `do $$
declare
  v_source record;
  v_old_prefix text;
  v_new_prefix text;
begin
  for v_source in select id, project_id, name from facetdb.sources where id = name loop
    v_old_prefix := (char_length(v_source.id)
        + (select count(*) from unnest(string_to_array(v_source.id, null)) c where ascii(c) > 65535))::text
      || ':' || v_source.id || ':';
    v_new_prefix := (char_length(v_source.project_id || ':' || v_source.name)
        + (select count(*) from unnest(string_to_array(v_source.project_id || ':' || v_source.name, null)) c
            where ascii(c) > 65535))::text
      || ':' || v_source.project_id || ':' || v_source.name || ':';
    if exists (select 1 from facetdb.records r where r.source_id = v_source.id) then
      update facetdb.jobs set record_key = v_new_prefix || substr(record_key, char_length(v_old_prefix) + 1)
       where left(record_key, char_length(v_old_prefix)) = v_old_prefix;
    end if;
    update facetdb.records set source_id = v_source.project_id || ':' || v_source.name
     where source_id = v_source.id;
    update facetdb.decisions set source_id = v_source.project_id || ':' || v_source.name
     where source_id = v_source.id;
    update facetdb.question_set_versions set source_id = v_source.project_id || ':' || v_source.name
     where source_id = v_source.id;
    update facetdb.sources set id = v_source.project_id || ':' || v_source.name
     where id = v_source.id;
  end loop;
end
$$`,
    ],
  },
  {
    version: 5,
    statements: [
      // The export pages one source's log oldest first by `where source_id = $1 and id > $2 order
      // by id` (decision-log.ts, `page`); `decisions_by_record` leads with the record's key, so
      // without this index that page reads every row of the source. A plain `create index` (not
      // `concurrently`, which cannot run inside the migration's transaction) holds off the
      // worker's appends to the log while it builds, once, during `facetdb migrate`.
      unlessRelation(
        "facetdb.decisions_by_source",
        `create index decisions_by_source on facetdb.decisions (source_id, id)`,
      ),
    ],
  },
  {
    version: 6,
    statements: [
      // The review queue, one row per record that needs review, kept by the worker (a needs_review
      // write adds or refreshes it, any other status deletes it). The state hash is the version of
      // the record the card shows, so a withdrawal at an old hash leaves a newer card alone;
      // `numbers` holds the model's answers for the probability band filter. An opened card is
      // locked for 10 minutes, so its holder and the lease's end are set together or not at all.
      `create table if not exists facetdb.reviews (
  source_id text not null,
  record_key text not null,
  state_hash text not null,
  open_questions jsonb not null,
  numbers jsonb not null,
  since timestamptz not null,
  locked_by text,
  locked_until timestamptz,
  skipped_by jsonb not null default '[]'::jsonb,
  primary key (source_id, record_key),
  check ((locked_by is null) = (locked_until is null))
)`,
      // The open-source studio's reviewer accounts, made by `facetdb users add`. A scrypt hash
      // only, never the password; the worker login reads the table and writes nothing to it.
      `create table if not exists facetdb.users (
  name text primary key,
  password_hash text not null,
  created_at timestamptz not null default now()
)`,
      // The run log, one row per worker pass that did work, pruned by the worker after 30 days.
      `create table if not exists facetdb.runs (
  id bigserial primary key,
  source_id text not null,
  started_at timestamptz not null,
  ended_at timestamptz not null,
  claimed integer not null,
  answered integer not null,
  to_review integer not null,
  errors integer not null,
  discarded integer not null,
  tokens bigint not null
)`,
      // The Decisions page searches one source's log by a time range, newest first, paged by the
      // log's id; neither `decisions_by_record` nor `decisions_by_source` orders by time. A plain
      // `create index` inside the migration's transaction, as migration 5's.
      unlessRelation(
        "facetdb.decisions_by_time",
        `create index decisions_by_time on facetdb.decisions (source_id, at desc, id)`,
      ),
    ],
  },
  {
    version: 7,
    statements: [
      // Seen in a real run: a spending alert claimed once a month stayed claimed when the cap
      // changed, so a cap raised and reached again the same month raised nothing, and the alert
      // kept the old cap's figures. The cap (its input tokens) is part of the claim: another cap,
      // another alert. A claim a version-6 store holds reads as one under cap 0, which no config
      // sets, so the first reading under the real cap raises afresh. Both statements are looked up
      // first (sql/ddl.ts): the install runs them again beside a live application.
      unlessColumn(
        "facetdb.usage_alerts",
        "cap",
        `alter table facetdb.usage_alerts add column cap bigint not null default 0`,
      ),
      unlessConstraint(
        "facetdb.usage_alerts",
        "usage_alerts_by_cap",
        `alter table facetdb.usage_alerts drop constraint usage_alerts_pkey, add constraint usage_alerts_by_cap primary key (project_id, month, kind, cap)`,
      ),
    ],
  },
  {
    version: 8,
    statements: [
      // The set each source's worker runs, one row per source, written at every loop open (the
      // worker's `start`). A version's content hash leaves out the thresholds, the where filter,
      // the stakes, the probability columns and the questions' order, so a change to any of them
      // makes no new version and the append-only `question_set_versions` keeps the set as it was
      // when the version was made. `facetdb review` and `facetdb test` judged by that stale set:
      // cards decided under thresholds the worker no longer ran, and a file put back to the stored
      // values passed while the worker ran the new ones. This row is what the worker runs, so the
      // terminal review judges by it and compares the file with it exactly. Mutable (the worker
      // inserts and updates it), so not among the append-only grants.
      `create table if not exists facetdb.question_sets_in_force (
  source_id text primary key,
  version integer not null,
  question_set jsonb not null,
  recorded_at timestamptz not null
)`,
    ],
  },
  {
    version: 9,
    statements: [
      // Every plugin action goes through the outbox, so a row is a webhook (an endpoint) or a
      // plugin's action on one record (the plugin, the action, its place in the record's pipeline
      // and the batch it joins), never neither. The table keeps its name: its grants and
      // uninstall's reads name it. No column holds a record's state: the payload is what is
      // delivered. Each statement is looked up first (sql/ddl.ts, or the catalog below), so the
      // install's rerun beside a live application takes no lock on the outbox.
      `do $$
begin
  if exists (select 1 from pg_catalog.pg_attribute
              where attrelid = to_regclass('facetdb.webhook_outbox') and attname = 'endpoint'
                and attnum > 0 and not attisdropped and attnotnull) then
    alter table facetdb.webhook_outbox alter column endpoint drop not null;
  end if;
end $$`,
      unlessColumn(
        "facetdb.webhook_outbox",
        "source_id",
        `alter table facetdb.webhook_outbox add column source_id text`,
      ),
      unlessColumn(
        "facetdb.webhook_outbox",
        "record_key",
        `alter table facetdb.webhook_outbox add column record_key text`,
      ),
      unlessColumn(
        "facetdb.webhook_outbox",
        "plugin",
        `alter table facetdb.webhook_outbox add column plugin text`,
      ),
      unlessColumn(
        "facetdb.webhook_outbox",
        "action",
        `alter table facetdb.webhook_outbox add column action text`,
      ),
      unlessColumn(
        "facetdb.webhook_outbox",
        "position",
        `alter table facetdb.webhook_outbox add column position integer`,
      ),
      unlessColumn(
        "facetdb.webhook_outbox",
        "batch_key",
        `alter table facetdb.webhook_outbox add column batch_key text`,
      ),
      unlessColumn(
        "facetdb.webhook_outbox",
        "superseded_at",
        `alter table facetdb.webhook_outbox add column superseded_at bigint`,
      ),
      unlessConstraint(
        "facetdb.webhook_outbox",
        "webhook_outbox_endpoint_or_plugin",
        `alter table facetdb.webhook_outbox add constraint webhook_outbox_endpoint_or_plugin check (endpoint is not null or plugin is not null)`,
      ),
      // A record's actions in pipeline order, found by the record. Partial: a webhook row has no
      // plugin and stays out of it. A plain `create index` inside the migration's transaction, as
      // migration 2's `webhook_outbox_due`: it holds off appends to the outbox while it builds,
      // once, during `facetdb migrate`.
      unlessRelation(
        "facetdb.webhook_outbox_action",
        `create index webhook_outbox_action on facetdb.webhook_outbox (project_id, source_id, record_key, plugin, action, position, id)
  where plugin is not null`,
      ),
      // One row per running worker, so a worker notices another's death. The project's own
      // `heartbeats` row (one per project, the alerts' timer) stays as it is.
      unlessRelation(
        "facetdb.worker_heartbeats",
        `create table facetdb.worker_heartbeats (
  project text not null,
  worker text not null,
  at bigint not null,
  primary key (project, worker)
)`,
      ),
      // A plugin source (the decomposition's note): its own kind, since 'plugin' already names a
      // table source. Migration 1 wrote the check inline, so Postgres named it `sources_kind_check`.
      unlessConstraint(
        "facetdb.sources",
        "sources_kind_allowed",
        `alter table facetdb.sources drop constraint sources_kind_check, add constraint sources_kind_allowed check (kind in ('plugin', 'plugin-source', 'api'))`,
      ),
    ],
  },
  {
    version: 10,
    statements: [
      // The digest rule reads the rows one batch key queued in a clock minute (the first 10 run
      // alone, the rest go as one digest at its end) and the rows a quiet period held, in an outbox
      // that is never pruned. Partial: only a notification's row has a batch key. A plain `create
      // index` inside the migration's transaction, as migration 9's `webhook_outbox_action`: it
      // holds off appends to the outbox once, during `facetdb migrate`, while it builds.
      unlessRelation(
        "facetdb.webhook_outbox_batch",
        `create index webhook_outbox_batch on facetdb.webhook_outbox (project_id, batch_key, created_at, id)
  where batch_key is not null`,
      ),
    ],
  },
  {
    version: 11,
    statements: [
      // The model the first answer under a version named, which every later answer of the version
      // must name. Nullable, with no default: a version nothing has answered holds none, and adding
      // the column rewrites no row. A version made before this migration is held by its next
      // answer.
      unlessColumn(
        "facetdb.question_set_versions",
        "answered_by",
        `alter table facetdb.question_set_versions add column answered_by text`,
      ),
    ],
  },
  {
    version: 12,
    statements: [
      // A version's hold, kept in the store so a restarted or second worker starts held and one
      // probe serves every worker: the name the holding response gave, and when the next probe may
      // go (ms on the workers' clock). Both null while the version is not held. Nullable, with no
      // default: adding them rewrites no row and takes only the brief lock an added column takes.
      unlessColumn(
        "facetdb.question_set_versions",
        "held_by",
        `alter table facetdb.question_set_versions add column held_by text`,
      ),
      unlessColumn(
        "facetdb.question_set_versions",
        "probe_at",
        `alter table facetdb.question_set_versions add column probe_at bigint`,
      ),
    ],
  },
];

/** The migration that rekeys every source id to `<project>:<name>`. */
const REKEY_VERSION = 4;

/**
 * What migration 4 cannot settle, said before it runs: a source registered under its bare name
 * whose log another project of the store may have written to (before version 4 a second project's
 * registration of the same name was skipped, and its worker wrote under the first's id). Those rows
 * cannot be told apart, so they stay with the registered project; each note names the source.
 * Empty on a store without sources, or once every id is rekeyed.
 */
export async function rekeyNotes(query: SqlQuery): Promise<string[]> {
  const present = await query(
    `select to_regclass('facetdb.sources') is not null and to_regclass('facetdb.projects') is not null as present`,
  );
  if (present[0]?.["present"] !== true) {
    return [];
  }
  const rows = await query(
    `select s.name, s.project_id, string_agg(p.id, ', ' order by p.id) as others
       from facetdb.sources s join facetdb.projects p on p.id <> s.project_id
      where s.id = s.name
      group by s.name, s.project_id
      order by s.name, s.project_id`,
  );
  return rows.map((row) => {
    const name = String(row["name"]);
    const project = String(row["project_id"]);
    return `the decision log of source "${name}" is now keyed by project ${project} and its name; if project(s) ${String(row["others"])} of this store also ran a source named "${name}" before, their rows cannot be told apart from ${project}'s and stay in ${project}'s log`;
  });
}

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
  "question_sets_in_force",
  "decisions",
  "jobs",
  "records",
  "usage",
  "usage_reservations",
  "usage_alerts",
  "alerts",
  "alert_history",
  "heartbeats",
  "worker_heartbeats",
  "cursors",
  "install",
  "webhook_outbox",
  "reviews",
  "users",
  "runs",
];

/**
 * The store's append-only logs: the decision log and the question-set versions are only ever read
 * and inserted into (a correction is a new row), so the worker login holds select and insert on
 * them and nothing more. Only the admin's `uninstall
 * --purge` deletes from them. The exceptions are columns: `STORE_WORKER_SET_ONCE_COLUMN` and
 * `STORE_WORKER_HOLD_COLUMNS`.
 */
export const STORE_APPEND_ONLY_TABLES: readonly string[] = ["question_set_versions", "decisions"];

/**
 * The one column of an append-only log the worker sets (store migration 11): a version's model,
 * written once by its first answer. The worker login holds update on this column alone.
 */
export const STORE_WORKER_SET_ONCE_COLUMN = {
  table: "question_set_versions",
  column: "answered_by",
} as const;

/**
 * A version's hold (store migration 12): set, cleared and its probe claimed by the workers, so the
 * worker login holds update on these columns of the versions too, and on no other.
 */
export const STORE_WORKER_HOLD_COLUMNS = {
  table: "question_set_versions",
  columns: ["held_by", "probe_at"],
} as const;

/**
 * The store's tables the worker login only reads: the reviewer accounts, whose passwords the studio
 * checks; `facetdb users add` writes them with the admin's or the store's credential, so the worker
 * login holds select on them and nothing more.
 */
export const STORE_WORKER_READ_ONLY_TABLES: readonly string[] = ["users"];

/**
 * The store's tables the worker login writes but never deletes from (store migration 8): the set
 * each source's worker runs, upserted at every loop open. Only the admin's `uninstall` and the
 * store's purge delete a source's row, so the worker holds select, insert and update.
 */
export const STORE_WORKER_UPSERT_TABLES: readonly string[] = ["question_sets_in_force"];

/**
 * Every function the store's migrations create, by signature: `facetdb migrate` grants the worker
 * login EXECUTE on each (the migration revokes it from everyone else), and `facetdb uninstall`
 * drops them with the store's tables.
 */
export const STORE_FUNCTIONS: readonly string[] = [RESERVE_USAGE_FUNCTION_SIGNATURE];

/** The version table: the worker reads it to see that nothing is left to migrate, and writes nothing. */
export const STORE_VERSION_TABLE = "store_migrations";

/** The sequences behind the store's `bigserial` columns; the worker needs `usage, select` on them. */
export const STORE_SEQUENCES: readonly string[] = [
  "decisions_id_seq",
  "alert_history_id_seq",
  "webhook_outbox_id_seq",
  "runs_id_seq",
];

const SCHEMA_SQL = `create schema if not exists ${quoteIdent("facetdb")}`;

const VERSION_TABLE_SQL = `create table if not exists facetdb.store_migrations (
  version integer primary key,
  applied_at timestamptz not null default now()
)`;

/** The statement that records one migration as applied; written to be run again. */
function recordMigration(version: number): string {
  return `insert into facetdb.store_migrations (version) values (${version}) on conflict (version) do nothing`;
}

/**
 * The store's whole DDL as one idempotent script: the schema, the version table, every migration in
 * order and the rows that mark them applied. The install script of a source whose database is the
 * store holds it, run with the admin credential after the store's own step (`storeStepStatements`)
 * has brought the store to this version, so there it finds everything and changes nothing.
 * `migrateStore` and the store's step run the same statements, so none of them can drift.
 */
export function storeInstallStatements(): string[] {
  return [SCHEMA_SQL, VERSION_TABLE_SQL, ...migrationStatements()];
}

/** Every migration's statements in order, each followed by the row that marks it applied. */
function migrationStatements(): string[] {
  return MIGRATIONS.flatMap((migration) => [
    ...migration.statements,
    recordMigration(migration.version),
  ]);
}

const SCHEMA_LOCK = "facetdb.store_migrations";

/**
 * The SQLSTATE the store's step raises when, under the store's lock, it finds the store written by
 * a newer FacetDB (one that migrated it between the show and the run): the step rolls back whole.
 */
export const STORE_NEWER_STATE = "FD053";

/**
 * The store's step of `facetdb migrate` as one script, run in its own transaction before any
 * source's, so no lock on a customer's table is held while the store's migrations run (an index
 * built on a large log): the store's advisory lock first, the one `migrateStore` takes, so two
 * migrates or a migrate and a worker's start take turns; then the lock timeout the install pins
 * (`LOCK_TIMEOUT`), so a statement waiting behind a transaction left open on a store table stops
 * instead of queueing the worker's reads and appends behind it for ever (after the advisory lock,
 * so a second migrate waits its turn behind a first that is itself bounded); then the schema and
 * the version table; then the check that no newer FacetDB wrote the store meanwhile; then the
 * store's whole idempotent DDL (`storeInstallStatements`' migrations), each statement written to be
 * run again (an index or a column looked up first), so a migration already applied finds its
 * objects and changes nothing. The lock's key is a literal, so the script printed is the script
 * run. `lockTimeout` is for tests that cannot wait ten seconds.
 */
export function storeStepStatements(lockTimeout: string = LOCK_TIMEOUT): string[] {
  return [
    `select pg_advisory_xact_lock(hashtext(${quoteLiteral(SCHEMA_LOCK)}))`,
    lockTimeoutStatement(lockTimeout),
    SCHEMA_SQL,
    VERSION_TABLE_SQL,
    `do $$
begin
  if exists (select 1 from facetdb.store_migrations where version > ${SCHEMA_VERSION}) then
    raise exception using errcode = '${STORE_NEWER_STATE}',
      message = 'FacetDB: the FacetDB store is newer than this FacetDB knows (${SCHEMA_VERSION})';
  end if;
end $$`,
    ...migrationStatements(),
  ];
}

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
 * names the fix (`StoreNotInstalledError`). Returns the notes of the migrations it ran (store
 * version 4's shared logs, `rekeyNotes`), for the caller to print.
 */
export async function migrateStore(client: SqlClient): Promise<readonly string[]> {
  const seen = await currentVersions(client.query);
  if (seen !== undefined && isCurrent(seen)) {
    return [];
  }
  const may = await client.query(
    `select case when to_regnamespace('facetdb') is null
                 then has_database_privilege(current_database(), 'create')
                 else has_schema_privilege('facetdb', 'create') end as may`,
  );
  if (may[0]?.["may"] !== true) {
    throw new StoreNotInstalledError(Math.max(0, ...(seen ?? [])));
  }
  return client.transaction(async (query) => {
    await query("select pg_advisory_xact_lock(hashtext($1))", [SCHEMA_LOCK]);
    await query(`create schema if not exists ${quoteIdent("facetdb")}`);
    await query(VERSION_TABLE_SQL);
    const applied = await appliedVersions(query);
    refuseNewer(applied);
    const notes = applied.includes(REKEY_VERSION) ? [] : await rekeyNotes(query);
    for (const migration of MIGRATIONS) {
      if (applied.includes(migration.version)) {
        continue;
      }
      for (const statement of migration.statements) {
        await query(statement);
      }
      await query(recordMigration(migration.version));
    }
    return notes;
  });
}

/**
 * Where the store stands against this FacetDB, read and nothing else (`facetdb doctor`'s store
 * check): absent before its first migration, else the newest version applied and whether every
 * migration this FacetDB knows is. A newer store is reported, never refused here.
 */
export async function storeVersion(
  query: SqlQuery,
): Promise<
  | { readonly kind: "absent" }
  | { readonly kind: "found"; readonly newest: number; readonly current: boolean }
> {
  const present = await query(
    "select to_regclass('facetdb.store_migrations') is not null as present",
  );
  if (present[0]?.["present"] !== true) {
    return { kind: "absent" };
  }
  const applied = await appliedVersions(query);
  return { kind: "found", newest: Math.max(0, ...applied), current: isCurrent(applied) };
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
