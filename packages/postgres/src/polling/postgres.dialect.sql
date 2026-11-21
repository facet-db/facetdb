-- The Postgres dialect: every operation's SQL for the listings example (the conformance suite).
-- plan, install: a fresh table, the worker login missing
begin;

set local standard_conforming_strings = on;

set local lock_timeout = '10s';

lock table "public"."listings" in share row exclusive mode;

alter table "public"."listings"
  add column if not exists "is_scam" boolean,
  add column if not exists "is_scam_probability" real,
  add column if not exists "facetdb_status" text,
  add column if not exists "facetdb_updated_at" timestamptz,
  add column if not exists "facetdb_reviewed" boolean default false,
  add column if not exists "facetdb_state_hash" text;

comment on column "public"."listings"."is_scam" is 'facetdb';

comment on column "public"."listings"."is_scam_probability" is 'facetdb';

comment on column "public"."listings"."facetdb_status" is 'facetdb';

comment on column "public"."listings"."facetdb_updated_at" is 'facetdb';

comment on column "public"."listings"."facetdb_reviewed" is 'facetdb';

comment on column "public"."listings"."facetdb_state_hash" is 'facetdb';

comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings';

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

grant select ("id", "title", "description", "is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash", "updated_at")
  on "public"."listings" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash")
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

commit;

-- plan, install: a table with no last-changed column
begin;

set local standard_conforming_strings = on;

set local lock_timeout = '10s';

lock table "public"."listings" in share row exclusive mode;

alter table "public"."listings"
  add column if not exists "is_scam" boolean,
  add column if not exists "is_scam_probability" real,
  add column if not exists "facetdb_status" text,
  add column if not exists "facetdb_updated_at" timestamptz,
  add column if not exists "facetdb_reviewed" boolean default false,
  add column if not exists "facetdb_state_hash" text;

comment on column "public"."listings"."is_scam" is 'facetdb';

comment on column "public"."listings"."is_scam_probability" is 'facetdb';

comment on column "public"."listings"."facetdb_status" is 'facetdb';

comment on column "public"."listings"."facetdb_updated_at" is 'facetdb';

comment on column "public"."listings"."facetdb_reviewed" is 'facetdb';

comment on column "public"."listings"."facetdb_state_hash" is 'facetdb';

comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings';

grant usage on schema "public" to "facetdb_worker";

grant select ("id", "title", "description", "is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash")
  on "public"."listings" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash")
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

commit;

-- plan, install: the table installed, the login there
begin;

set local standard_conforming_strings = on;

set local lock_timeout = '10s';

lock table "public"."listings" in share row exclusive mode;

alter table "public"."listings"
  add column if not exists "is_scam" boolean,
  add column if not exists "is_scam_probability" real,
  add column if not exists "facetdb_status" text,
  add column if not exists "facetdb_updated_at" timestamptz,
  add column if not exists "facetdb_reviewed" boolean default false,
  add column if not exists "facetdb_state_hash" text;

comment on column "public"."listings"."is_scam" is 'facetdb';

comment on column "public"."listings"."is_scam_probability" is 'facetdb';

comment on column "public"."listings"."facetdb_status" is 'facetdb';

comment on column "public"."listings"."facetdb_updated_at" is 'facetdb';

comment on column "public"."listings"."facetdb_reviewed" is 'facetdb';

comment on column "public"."listings"."facetdb_state_hash" is 'facetdb';

comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings';

grant usage on schema "public" to "facetdb_worker";

grant select ("id", "title", "description", "is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash", "updated_at")
  on "public"."listings" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash")
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

commit;

-- plan, install: a polling table from an earlier version, its state hash with the bare mark
begin;

set local standard_conforming_strings = on;

set local lock_timeout = '10s';

lock table "public"."listings" in share row exclusive mode;

alter table "public"."listings"
  add column if not exists "is_scam" boolean,
  add column if not exists "is_scam_probability" real,
  add column if not exists "facetdb_status" text,
  add column if not exists "facetdb_updated_at" timestamptz,
  add column if not exists "facetdb_reviewed" boolean default false,
  add column if not exists "facetdb_state_hash" text;

comment on column "public"."listings"."is_scam" is 'facetdb';

comment on column "public"."listings"."is_scam_probability" is 'facetdb';

comment on column "public"."listings"."facetdb_status" is 'facetdb';

comment on column "public"."listings"."facetdb_updated_at" is 'facetdb';

comment on column "public"."listings"."facetdb_reviewed" is 'facetdb';

comment on column "public"."listings"."facetdb_state_hash" is 'facetdb';

comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings';

grant usage on schema "public" to "facetdb_worker";

grant select ("id", "title", "description", "is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash", "updated_at")
  on "public"."listings" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash")
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

commit;

-- plan, uninstall
begin;

set local standard_conforming_strings = on;

set local lock_timeout = '10s';

lock table "public"."listings" in share row exclusive mode;

drop policy if exists "facetdb_reads" on "public"."listings";

drop policy if exists "facetdb_writes" on "public"."listings";

revoke all on "public"."listings" from "facetdb_worker";

alter table "public"."listings"
  drop column if exists "is_scam",
  drop column if exists "is_scam_probability",
  drop column if exists "facetdb_status",
  drop column if exists "facetdb_updated_at",
  drop column if exists "facetdb_reviewed",
  drop column if exists "facetdb_state_hash";

commit;

-- plan, prune: is_scam removed for is_spam, description no longer read
begin;

set local standard_conforming_strings = on;

set local lock_timeout = '10s';

lock table "public"."listings" in share row exclusive mode;

alter table "public"."listings"
  drop column if exists "is_scam",
  drop column if exists "is_scam_probability";

revoke select ("description") on "public"."listings" from "facetdb_worker";

commit;

-- connector, watch: the first poll by updated_at, over two pages
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" order by "updated_at", "id" limit $1;
-- binds: [2]
update "public"."listings" set "facetdb_status" = 'pending' where "id" in ($1, $2) and "facetdb_status" is null;
-- binds: ["1","2"]
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" where ("updated_at", "id") > ($1, $2) order by "updated_at", "id" limit $3;
-- binds: ["2026-11-03 10:00:00+00","2",2]

-- connector, watch: the next poll, from the last updated_at seen
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" where "updated_at" >= $1 order by "updated_at", "id" limit $2;
-- binds: ["2026-11-03 10:00:00+00",2]
update "public"."listings" set "facetdb_status" = 'pending' where "id" in ($1) and "facetdb_status" is null;
-- binds: ["3"]

-- connector, watch: the hourly full scan, without a last-changed column
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x from "public"."listings" order by "id" limit $1;
-- binds: [2]
update "public"."listings" set "facetdb_status" = 'pending' where "id" in ($1, $2) and "facetdb_status" is null;
-- binds: ["1","2"]
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x from "public"."listings" where "id" > $1 order by "id" limit $2;
-- binds: ["2",2]

-- connector, read
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" where "id" in ($1, $2);
-- binds: ["1","2"]

-- connector, write: the hash checked under a row lock, then the decision
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" where "id" = $1 for update;
-- binds: ["1"]
update "public"."listings" set "is_scam" = $2, "is_scam_probability" = $3, "facetdb_status" = $4, "facetdb_updated_at" = to_timestamp($5::double precision / 1000), "facetdb_reviewed" = $6, "facetdb_state_hash" = $7 where "id" = $1;
-- binds: ["1",true,0.93,"done",1700000000000,true,"0d5a7e381f0afa9fe6c56f5f7669d3849c7a0dbce8e8c71c5f501004390418bb"]

-- connector, current
select "id"::text as k, "is_scam"::text as q0v, "is_scam_probability"::text as q0p, "facetdb_status" as cs, round(extract(epoch from "facetdb_updated_at") * 1000)::bigint::text as cu, "facetdb_reviewed" as cr
         from "public"."listings" where "id"::text in ($1, $2);
-- binds: ["1","2"]

-- connector, scan: the first page, newest first
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" order by "id" desc limit $1;
-- binds: [3]

-- connector, scan: the page after a cursor
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" where "id" < $1 order by "id" desc limit $2;
-- binds: ["9",3]
