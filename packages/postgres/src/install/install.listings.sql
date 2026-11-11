begin;

set local standard_conforming_strings = on;

set local lock_timeout = '10s';

create schema if not exists "facetdb";

create table if not exists facetdb.store_migrations (
  version integer primary key,
  applied_at timestamptz not null default now()
);

create table if not exists facetdb.install (
  key text primary key,
  value text not null
);

create table if not exists facetdb.projects (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

create table if not exists facetdb.sources (
  id text primary key,
  project_id text not null references facetdb.projects (id),
  name text not null,
  kind text not null check (kind in ('plugin', 'api')),
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

create table if not exists facetdb.question_set_versions (
  source_id text not null,
  version integer not null,
  content_hash text not null,
  question_set jsonb not null,
  created_at timestamptz not null default now(),
  primary key (source_id, version)
);

create table if not exists facetdb.decisions (
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
);

create index if not exists decisions_by_record on facetdb.decisions (source_id, record_key, id);

create schema if not exists "facetdb";

create table if not exists "facetdb"."jobs" (
  record_key text primary key,
  enqueued_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text
);

create index if not exists "jobs_queue" on "facetdb"."jobs" (enqueued_at, record_key);

create table if not exists facetdb.records (
  source_id text not null,
  record_key text not null,
  state jsonb not null,
  hash text not null,
  status text not null,
  decision jsonb,
  reviewed boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (source_id, record_key)
);

create table if not exists facetdb.credentials (
  project_id text not null references facetdb.projects (id),
  name text not null,
  ciphertext text not null,
  updated_at timestamptz not null default now(),
  primary key (project_id, name)
);

create table if not exists facetdb.api_keys (
  id text primary key,
  project_id text not null references facetdb.projects (id),
  name text not null,
  key_hash text not null unique,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create table if not exists facetdb.usage (
  project_id text not null,
  month text not null,
  input_tokens bigint not null default 0,
  primary key (project_id, month)
);

create table if not exists facetdb.usage_reservations (
  id uuid primary key default gen_random_uuid(),
  project_id text not null,
  month text not null,
  tokens bigint not null,
  expires_at bigint not null
);

create index if not exists usage_reservations_by_month on facetdb.usage_reservations (project_id, month);

create table if not exists facetdb.usage_alerts (
  project_id text not null,
  month text not null,
  kind text not null,
  primary key (project_id, month, kind)
);

create table if not exists facetdb.alerts (
  key text primary key,
  state jsonb not null
);

create table if not exists facetdb.alert_history (
  id bigserial primary key,
  record jsonb not null
);

create table if not exists facetdb.heartbeats (
  project text primary key,
  at bigint not null
);

create table if not exists facetdb.cursors (
  run text primary key,
  cursor text,
  done boolean not null
);

insert into facetdb.store_migrations (version) values (1) on conflict (version) do nothing;

create table if not exists "facetdb"."table_owners" (
  table_schema text not null,
  table_name text not null,
  project_id text not null references "facetdb"."projects" (id),
  installed_at timestamptz not null default now(),
  primary key (table_schema, table_name)
);

insert into "facetdb"."projects" (id, name) values ('proj_listings', 'Listings') on conflict (id) do nothing;

insert into "facetdb"."table_owners" (table_schema, table_name, project_id) values ('public', 'listings', 'proj_listings') on conflict (table_schema, table_name) do nothing;

alter table "public"."listings"
  add column if not exists "is_scam" boolean,
  add column if not exists "is_scam_probability" real,
  add column if not exists "facetdb_status" text not null default 'pending',
  add column if not exists "facetdb_updated_at" timestamptz,
  add column if not exists "facetdb_reviewed" boolean not null default false;

comment on column "public"."listings"."is_scam" is 'facetdb';

comment on column "public"."listings"."is_scam_probability" is 'facetdb';

comment on column "public"."listings"."facetdb_status" is 'facetdb';

comment on column "public"."listings"."facetdb_updated_at" is 'facetdb';

comment on column "public"."listings"."facetdb_reviewed" is 'facetdb';

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'facetdb_enqueue') then
    execute format('create role %I nologin', 'facetdb_enqueue');
  end if;
end $$;

grant "facetdb_enqueue" to current_user;

grant usage on schema "facetdb" to "facetdb_enqueue";

grant insert on "facetdb"."jobs" to "facetdb_enqueue";

grant select (record_key), update (claimed_at, claimed_by) on "facetdb"."jobs" to "facetdb_enqueue";

create or replace function "facetdb"."enqueue"() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  key text;
begin
  execute format('select ($1).%I::text', tg_argv[0]) into key using new;
  new."facetdb_status" := 'pending';
  insert into "facetdb"."jobs" (record_key)
  values (tg_argv[1] || key)
  on conflict (record_key) do update set claimed_at = null, claimed_by = null;
  perform pg_notify('facetdb_jobs', '');
  return new;
end $$;

create or replace function "facetdb"."enqueue_keep"() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  key text;
begin
  execute format('select ($1).%I::text', tg_argv[0]) into key using new;
  insert into "facetdb"."jobs" (record_key)
  values (tg_argv[1] || key)
  on conflict (record_key) do update set claimed_at = null, claimed_by = null;
  perform pg_notify('facetdb_jobs', '');
  return new;
end $$;

grant create on schema "facetdb" to "facetdb_enqueue";

alter function "facetdb"."enqueue"() owner to "facetdb_enqueue";

alter function "facetdb"."enqueue_keep"() owner to "facetdb_enqueue";

revoke create on schema "facetdb" from "facetdb_enqueue";

drop trigger if exists "facetdb_listings" on "public"."listings";

create trigger "facetdb_listings" before insert or update of "title", "description"
  on "public"."listings" for each row execute function "facetdb"."enqueue"('id', 't:15:public.listings:');

-- the worker password: set by `facetdb migrate` for the transaction, never printed;
-- run by hand, this script stops at the role below with a FacetDB message and changes nothing;

do $$
declare
  password text := nullif(current_setting('facetdb.worker_password', true), '');
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'facetdb_worker') then
    if password is null then
      raise exception 'FacetDB: the worker login facetdb_worker does not exist and no password was given for it';
    end if;
    execute format('create role %I login password %L', 'facetdb_worker', password);
  elsif password is not null then
    execute format('alter role %I with login password %L', 'facetdb_worker', password);
  end if;
end $$;

grant usage on schema "public" to "facetdb_worker";

grant select ("id", "title", "description", "is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed")
  on "public"."listings" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed")
  on "public"."listings" to "facetdb_worker";

select set_config('facetdb.install_schema', 'public', true), set_config('facetdb.install_table', 'listings', true);

do $$
begin
  if not exists (select 1 from pg_catalog.pg_policies
                 where schemaname = current_setting('facetdb.install_schema')
                   and tablename = current_setting('facetdb.install_table')
                   and policyname = 'facetdb_reads') then
    execute format('create policy %I on %I.%I for select to %I using (true)',
                   'facetdb_reads', current_setting('facetdb.install_schema'), current_setting('facetdb.install_table'), 'facetdb_worker');
  end if;
  if not exists (select 1 from pg_catalog.pg_policies
                 where schemaname = current_setting('facetdb.install_schema')
                   and tablename = current_setting('facetdb.install_table')
                   and policyname = 'facetdb_writes') then
    execute format('create policy %I on %I.%I for update to %I using (true)',
                   'facetdb_writes', current_setting('facetdb.install_schema'), current_setting('facetdb.install_table'), 'facetdb_worker');
  end if;
end $$;

do $$
begin
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = format('%I.%I', current_setting('facetdb.install_schema'), current_setting('facetdb.install_table'))::regclass
                and a.attname = 'created_at' and not a.attisdropped) then
    execute format('grant select (%I) on %I.%I to %I', 'created_at', current_setting('facetdb.install_schema'), current_setting('facetdb.install_table'), 'facetdb_worker');
  end if;
end $$;

grant usage on schema "facetdb" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."api_keys" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."credentials" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."sources" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."projects" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."question_set_versions" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."decisions" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."jobs" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."records" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."usage" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."usage_reservations" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."usage_alerts" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."alerts" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."alert_history" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."heartbeats" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."cursors" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."install" to "facetdb_worker";

grant select on "facetdb"."store_migrations" to "facetdb_worker";

grant usage, select on sequence "facetdb"."decisions_id_seq" to "facetdb_worker";

grant usage, select on sequence "facetdb"."alert_history_id_seq" to "facetdb_worker";

commit;
