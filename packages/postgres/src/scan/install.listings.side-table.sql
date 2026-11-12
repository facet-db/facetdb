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

create table if not exists facetdb.webhook_outbox (
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
);

alter table facetdb.webhook_outbox add column if not exists claimed_by text;

create index if not exists webhook_outbox_due on facetdb.webhook_outbox (next_attempt_at)
  where delivered_at is null and gave_up_at is null;

insert into facetdb.store_migrations (version) values (2) on conflict (version) do nothing;

create or replace function facetdb.reserve_usage(
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
$$;

revoke all on function facetdb.reserve_usage(text, text, bigint, bigint, bigint, bigint) from public;

insert into facetdb.store_migrations (version) values (3) on conflict (version) do nothing;

create table if not exists "facetdb"."table_owners" (
  table_schema text not null,
  table_name text not null,
  project_id text not null references "facetdb"."projects" (id),
  installed_at timestamptz not null default now(),
  primary key (table_schema, table_name)
);

insert into "facetdb"."projects" (id, name) values ('proj_listings', 'Listings') on conflict (id) do nothing;

insert into "facetdb"."table_owners" (table_schema, table_name, project_id) values ('public', 'listings', 'proj_listings') on conflict (table_schema, table_name) do nothing;

select set_config('facetdb.install_view_schema', 'public', true), set_config('facetdb.install_view', 'listings_with_answers', true), set_config('facetdb.install_side_table', 'listings_answers', true), set_config('facetdb.install_schema', 'public', true), set_config('facetdb.install_table', 'listings', true);

create table if not exists "facetdb"."listings_answers" (
  "id" integer primary key
);

alter table "facetdb"."listings_answers"
  add column if not exists "is_scam" boolean,
  add column if not exists "is_scam_probability" real,
  add column if not exists "facetdb_status" text not null default 'pending',
  add column if not exists "facetdb_updated_at" timestamptz,
  add column if not exists "facetdb_reviewed" boolean not null default false;

do $fdb$
begin
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'listings_answers_key_fkey'
                    and conrelid = format('%I.%I', 'facetdb', current_setting('facetdb.install_side_table'))::regclass) then
    execute format('alter table %I.%I add constraint %I foreign key (%I) references %I.%I (%I) on delete cascade',
                   'facetdb', current_setting('facetdb.install_side_table'), 'listings_answers_key_fkey',
                   'id', current_setting('facetdb.install_schema'), current_setting('facetdb.install_table'), 'id');
  end if;
end $fdb$;

comment on table "facetdb"."listings_answers" is 'facetdb';

do $$
begin
  create temp table if not exists facetdb_view_grants (grantee_sql text, privilege text, grantable boolean) on commit drop;
  delete from facetdb_view_grants;
  insert into facetdb_view_grants
    select case when a.grantee = 0 then 'public' else quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) end,
           a.privilege_type, a.is_grantable
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(c.relacl) a
     where n.nspname = current_setting('facetdb.install_view_schema') and c.relname = current_setting('facetdb.install_view')
       and a.grantee <> c.relowner;
end $$;

drop view if exists "public"."listings_with_answers";

create view "public"."listings_with_answers" with (security_invoker = true) as
select t.*,
  a."is_scam",
  a."is_scam_probability",
  coalesce(a."facetdb_status", 'pending') as "facetdb_status",
  a."facetdb_updated_at",
  coalesce(a."facetdb_reviewed", false) as "facetdb_reviewed"
  from "public"."listings" t
  left join "facetdb"."listings_answers" a on a."id" = t."id";

comment on view "public"."listings_with_answers" is 'facetdb';

do $$
declare
  g record;
begin
  for g in select * from facetdb_view_grants loop
    execute format('grant %s on %I.%I to %s%s', g.privilege, current_setting('facetdb.install_view_schema'),
                   current_setting('facetdb.install_view'), g.grantee_sql,
                   case when g.grantable then ' with grant option' else '' end);
  end loop;
end $$;

do $$
declare
  r record;
begin
  for r in
    select case when a.grantee = 0 then 'public' else quote_ident(pg_catalog.pg_get_userbyid(a.grantee)) end as grantee_sql
      from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      cross join lateral pg_catalog.aclexplode(c.relacl) a
     where n.nspname = current_setting('facetdb.install_schema') and c.relname = current_setting('facetdb.install_table')
       and a.privilege_type = 'SELECT' and a.grantee <> c.relowner
  loop
    execute format('grant usage on schema %I to %s', 'facetdb', r.grantee_sql);
    execute format('grant select on %I.%I to %s', 'facetdb', current_setting('facetdb.install_side_table'), r.grantee_sql);
    execute format('grant select on %I.%I to %s', current_setting('facetdb.install_view_schema'), current_setting('facetdb.install_view'), r.grantee_sql);
  end loop;
end $$;

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

grant select ("id", "facetdb_status"), update ("facetdb_status") on "facetdb"."listings_answers" to "facetdb_enqueue";

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

create or replace function "facetdb"."enqueue_side"() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  key text;
begin
  execute format('select ($1).%I::text', tg_argv[0]) into key using new;
  execute format('update %I.%I set %I = ''pending'' where %I = ($1).%I and %I is distinct from ''pending''',
                 tg_argv[2], tg_argv[3], 'facetdb_status', tg_argv[0], tg_argv[0], 'facetdb_status') using new;
  insert into "facetdb"."jobs" (record_key)
  values (tg_argv[1] || key)
  on conflict (record_key) do update set claimed_at = null, claimed_by = null;
  perform pg_notify('facetdb_jobs', '');
  return new;
end $$;

grant create on schema "facetdb" to "facetdb_enqueue";

alter function "facetdb"."enqueue"() owner to "facetdb_enqueue";

alter function "facetdb"."enqueue_keep"() owner to "facetdb_enqueue";

alter function "facetdb"."enqueue_side"() owner to "facetdb_enqueue";

revoke create on schema "facetdb" from "facetdb_enqueue";

drop trigger if exists "facetdb_listings" on "public"."listings";

create trigger "facetdb_listings" before insert or update of "title", "description"
  on "public"."listings" for each row execute function "facetdb"."enqueue_side"('id', 't:15:public.listings:', 'facetdb', 'listings_answers');

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

grant select ("id", "title", "description")
  on "public"."listings" to "facetdb_worker";

grant select ("id", "is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed") on "facetdb"."listings_answers" to "facetdb_worker";

grant insert ("id", "is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed") on "facetdb"."listings_answers" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed") on "facetdb"."listings_answers" to "facetdb_worker";

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
end $$;

do $$
begin
  if exists (select 1 from pg_catalog.pg_attribute a
              where a.attrelid = format('%I.%I', current_setting('facetdb.install_schema'), current_setting('facetdb.install_table'))::regclass
                and a.attname = 'created_at' and not a.attisdropped) then
    execute format('grant select (%I) on %I.%I to %I', 'created_at', current_setting('facetdb.install_schema'), current_setting('facetdb.install_table'), 'facetdb_worker');
  end if;
end $$;

alter table "facetdb"."listings_answers" enable row level security;

do $fdb$
begin
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'facetdb'
                  and tablename = current_setting('facetdb.install_side_table') and policyname = 'facetdb_side_reads') then
    execute format('create policy %I on %I.%I for select using (exists (select 1 from %I.%I s where s.%I = %I.%I.%I))',
                   'facetdb_side_reads', 'facetdb', current_setting('facetdb.install_side_table'),
                   current_setting('facetdb.install_schema'), current_setting('facetdb.install_table'), 'id',
                   'facetdb', current_setting('facetdb.install_side_table'), 'id');
  end if;
  if not exists (select 1 from pg_catalog.pg_policies where schemaname = 'facetdb'
                  and tablename = current_setting('facetdb.install_side_table') and policyname = 'facetdb_side_workers') then
    execute format('create policy %I on %I.%I to %I, %I using (true) with check (true)',
                   'facetdb_side_workers', 'facetdb', current_setting('facetdb.install_side_table'), 'facetdb_worker', 'facetdb_enqueue');
  end if;
end $fdb$;

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

grant select, insert, update, delete on "facetdb"."webhook_outbox" to "facetdb_worker";

grant select on "facetdb"."store_migrations" to "facetdb_worker";

grant usage, select on sequence "facetdb"."decisions_id_seq" to "facetdb_worker";

grant usage, select on sequence "facetdb"."alert_history_id_seq" to "facetdb_worker";

grant usage, select on sequence "facetdb"."webhook_outbox_id_seq" to "facetdb_worker";

grant execute on function facetdb.reserve_usage(text, text, bigint, bigint, bigint, bigint) to "facetdb_worker";

commit;
