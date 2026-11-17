-- The CockroachDB dialect: every operation's SQL for the listings example (the conformance suite).
-- plan, install: a fresh table, the worker login missing
begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column "facetdb_state_hash" text;
comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "is_scam" boolean;
comment on column "public"."listings"."is_scam" is 'facetdb';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "is_scam_probability" real;
comment on column "public"."listings"."is_scam_probability" is 'facetdb';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "facetdb_status" text;
comment on column "public"."listings"."facetdb_status" is 'facetdb';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "facetdb_updated_at" timestamptz;
comment on column "public"."listings"."facetdb_updated_at" is 'facetdb';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "facetdb_reviewed" boolean default false;
comment on column "public"."listings"."facetdb_reviewed" is 'facetdb';
commit;

-- the worker login: facetdb migrate runs create user if not exists "facetdb_worker" with login password $1 here, with a SCRAM verifier of the password bound, never printed;
-- run by hand, create it first: create user "facetdb_worker" with login password '<a long random password>';

grant usage on schema "public" to "facetdb_worker";

grant select on table "public"."listings" to "facetdb_worker";

grant update on table "public"."listings" to "facetdb_worker";

-- plan, install: a table with no last-changed column
begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column "facetdb_state_hash" text;
comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "is_scam" boolean;
comment on column "public"."listings"."is_scam" is 'facetdb';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "is_scam_probability" real;
comment on column "public"."listings"."is_scam_probability" is 'facetdb';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "facetdb_status" text;
comment on column "public"."listings"."facetdb_status" is 'facetdb';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "facetdb_updated_at" timestamptz;
comment on column "public"."listings"."facetdb_updated_at" is 'facetdb';
commit;

begin;
set local autocommit_before_ddl = off;
alter table "public"."listings"
  add column if not exists "facetdb_reviewed" boolean default false;
comment on column "public"."listings"."facetdb_reviewed" is 'facetdb';
commit;

grant usage on schema "public" to "facetdb_worker";

grant select on table "public"."listings" to "facetdb_worker";

grant update on table "public"."listings" to "facetdb_worker";

-- plan, install: the table installed, the login there
comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings';

comment on column "public"."listings"."is_scam" is 'facetdb';

comment on column "public"."listings"."is_scam_probability" is 'facetdb';

comment on column "public"."listings"."facetdb_status" is 'facetdb';

comment on column "public"."listings"."facetdb_updated_at" is 'facetdb';

comment on column "public"."listings"."facetdb_reviewed" is 'facetdb';

grant usage on schema "public" to "facetdb_worker";

grant select on table "public"."listings" to "facetdb_worker";

grant update on table "public"."listings" to "facetdb_worker";

-- plan, install: a polling table from an earlier version, its state hash with the bare mark
comment on column "public"."listings"."facetdb_state_hash" is 'facetdb:proj_listings';

comment on column "public"."listings"."is_scam" is 'facetdb';

comment on column "public"."listings"."is_scam_probability" is 'facetdb';

comment on column "public"."listings"."facetdb_status" is 'facetdb';

comment on column "public"."listings"."facetdb_updated_at" is 'facetdb';

comment on column "public"."listings"."facetdb_reviewed" is 'facetdb';

grant usage on schema "public" to "facetdb_worker";

grant select on table "public"."listings" to "facetdb_worker";

grant update on table "public"."listings" to "facetdb_worker";

-- plan, uninstall
revoke all on table "public"."listings" from "facetdb_worker";

alter table "public"."listings"
  drop column if exists "is_scam",
  drop column if exists "is_scam_probability",
  drop column if exists "facetdb_status",
  drop column if exists "facetdb_updated_at",
  drop column if exists "facetdb_reviewed",
  drop column if exists "facetdb_state_hash";

-- plan, prune: is_scam removed for is_spam, description no longer read
alter table "public"."listings"
  drop column if exists "is_scam",
  drop column if exists "is_scam_probability";

-- connector, watch: the first poll by updated_at, over two pages
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" order by "updated_at", "id" limit $1;
-- binds: [2]
update "public"."listings" set "facetdb_status" = 'pending' where "id" in ($1, $2) and ("facetdb_status" is null or "facetdb_status" <> 'pending');
-- binds: ["1","2"]
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" where ("updated_at", "id") > ($1, $2) order by "updated_at", "id" limit $3;
-- binds: ["2026-11-03 10:00:00+00","2",2]

-- connector, watch: the next poll, from the last updated_at seen
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x, "updated_at"::text as c from "public"."listings" where "updated_at" >= $1 order by "updated_at", "id" limit $2;
-- binds: ["2026-11-03 10:00:00+00",2]
update "public"."listings" set "facetdb_status" = 'pending' where "id" in ($1) and ("facetdb_status" is null or "facetdb_status" <> 'pending');
-- binds: ["3"]

-- connector, watch: the hourly full scan, without a last-changed column
select "id"::text as k, "title"::text as s0, "description"::text as s1, "facetdb_state_hash" as h, false as x from "public"."listings" order by "id" limit $1;
-- binds: [2]
update "public"."listings" set "facetdb_status" = 'pending' where "id" in ($1, $2) and ("facetdb_status" is null or "facetdb_status" <> 'pending');
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
