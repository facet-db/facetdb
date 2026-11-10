set local standard_conforming_strings = on;

create schema if not exists "facetdb";

create table if not exists "facetdb"."jobs" (
  record_key text primary key,
  enqueued_at timestamptz not null default now(),
  claimed_at timestamptz,
  claimed_by text
);

create index if not exists "jobs_queue" on "facetdb"."jobs" (enqueued_at, record_key);

create table if not exists "facetdb"."projects" (
  id text primary key,
  name text not null,
  created_at timestamptz not null default now()
);

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

grant select (record_key) on "facetdb"."jobs" to "facetdb_enqueue";

create or replace function "facetdb"."enqueue"() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  key text;
begin
  execute format('select ($1).%I::text', tg_argv[0]) into key using new;
  new."facetdb_status" := 'pending';
  insert into "facetdb"."jobs" (record_key)
  values (tg_argv[1] || key)
  on conflict (record_key) do nothing;
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
  on conflict (record_key) do nothing;
  perform pg_notify('facetdb_jobs', '');
  return new;
end $$;

grant create on schema "facetdb" to "facetdb_enqueue";

alter function "facetdb"."enqueue"() owner to "facetdb_enqueue";

alter function "facetdb"."enqueue_keep"() owner to "facetdb_enqueue";

revoke create on schema "facetdb" from "facetdb_enqueue";

drop trigger if exists "facetdb_listings" on "public"."listings";

create trigger "facetdb_listings" before insert or update of "title", "description"
  on "public"."listings" for each row execute function "facetdb"."enqueue"('id', 'public.listings:');

select set_config('facetdb.worker_password', '<the worker password, never printed>', true);

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

grant usage on schema "facetdb" to "facetdb_worker";

grant select, insert, update, delete on "facetdb"."jobs" to "facetdb_worker";
