-- The Plain SQL dialect: every operation's SQL for the listings example (the conformance suite).
-- plan, install: a fresh table, the worker login missing
create table if not exists "facetdb_table_owners" (
  table_schema varchar(128) not null,
  table_name varchar(128) not null,
  column_name varchar(128) not null,
  mark varchar(4000) not null,
  primary key (table_schema, table_name, column_name)
);

alter table "main"."listings" add "is_scam" boolean;

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'is_scam';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'is_scam', 'facetdb');

alter table "main"."listings" add "is_scam_probability" real;

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'is_scam_probability';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'is_scam_probability', 'facetdb');

alter table "main"."listings" add "facetdb_status" varchar(4000);

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_status';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_status', 'facetdb');

alter table "main"."listings" add "facetdb_updated_at" timestamp(3);

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_updated_at';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_updated_at', 'facetdb');

alter table "main"."listings" add "facetdb_reviewed" boolean default false;

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_reviewed';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_reviewed', 'facetdb');

alter table "main"."listings" add "facetdb_state_hash" varchar(64);

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_state_hash';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_state_hash', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_state_hash';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_state_hash', 'facetdb:proj_listings');

-- the worker login: created by facetdb migrate with the password bound, never printed;

grant connect to "facetdb_worker";

grant select on "main"."listings" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash") on "main"."listings" to "facetdb_worker";

-- plan, install: a table with no last-changed column
create table if not exists "facetdb_table_owners" (
  table_schema varchar(128) not null,
  table_name varchar(128) not null,
  column_name varchar(128) not null,
  mark varchar(4000) not null,
  primary key (table_schema, table_name, column_name)
);

alter table "main"."listings" add "is_scam" boolean;

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'is_scam';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'is_scam', 'facetdb');

alter table "main"."listings" add "is_scam_probability" real;

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'is_scam_probability';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'is_scam_probability', 'facetdb');

alter table "main"."listings" add "facetdb_status" varchar(4000);

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_status';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_status', 'facetdb');

alter table "main"."listings" add "facetdb_updated_at" timestamp(3);

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_updated_at';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_updated_at', 'facetdb');

alter table "main"."listings" add "facetdb_reviewed" boolean default false;

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_reviewed';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_reviewed', 'facetdb');

alter table "main"."listings" add "facetdb_state_hash" varchar(64);

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_state_hash';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_state_hash', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_state_hash';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_state_hash', 'facetdb:proj_listings');

grant select on "main"."listings" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash") on "main"."listings" to "facetdb_worker";

-- plan, install: the table installed, the login there
create table if not exists "facetdb_table_owners" (
  table_schema varchar(128) not null,
  table_name varchar(128) not null,
  column_name varchar(128) not null,
  mark varchar(4000) not null,
  primary key (table_schema, table_name, column_name)
);

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'is_scam';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'is_scam', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'is_scam_probability';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'is_scam_probability', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_status';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_status', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_updated_at';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_updated_at', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_reviewed';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_reviewed', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_state_hash';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_state_hash', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_state_hash';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_state_hash', 'facetdb:proj_listings');

grant select on "main"."listings" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash") on "main"."listings" to "facetdb_worker";

-- plan, install: a polling table from an earlier version, its state hash with the bare mark
create table if not exists "facetdb_table_owners" (
  table_schema varchar(128) not null,
  table_name varchar(128) not null,
  column_name varchar(128) not null,
  mark varchar(4000) not null,
  primary key (table_schema, table_name, column_name)
);

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'is_scam';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'is_scam', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'is_scam_probability';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'is_scam_probability', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_status';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_status', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_updated_at';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_updated_at', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_reviewed';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_reviewed', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_state_hash';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_state_hash', 'facetdb');

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name = 'facetdb_state_hash';

insert into "facetdb_table_owners" (table_schema, table_name, column_name, mark) values ('main', 'listings', 'facetdb_state_hash', 'facetdb:proj_listings');

grant select on "main"."listings" to "facetdb_worker";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash") on "main"."listings" to "facetdb_worker";

-- plan, uninstall
revoke all on "main"."listings" from "facetdb_worker";

alter table "main"."listings" drop column "is_scam";

alter table "main"."listings" drop column "is_scam_probability";

alter table "main"."listings" drop column "facetdb_status";

alter table "main"."listings" drop column "facetdb_updated_at";

alter table "main"."listings" drop column "facetdb_reviewed";

alter table "main"."listings" drop column "facetdb_state_hash";

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings';

-- plan, prune: is_scam removed for is_spam, description no longer read
alter table "main"."listings" drop column "is_scam";

alter table "main"."listings" drop column "is_scam_probability";

delete from "facetdb_table_owners" where table_schema = 'main' and table_name = 'listings' and column_name in ('is_scam', 'is_scam_probability');

-- connector, watch: the first poll by updated_at, over two pages
select cast("id" as varchar(4000)) as k, cast("title" as varchar(4000)) as s0, cast("description" as varchar(4000)) as s1, "facetdb_state_hash" as h, false as x, cast("updated_at" as varchar(4000)) as c from "main"."listings" order by "updated_at", "id" fetch first :1 rows only;
-- binds: [2]
update "main"."listings" set "facetdb_status" = 'pending' where "id" in (:1, :2) and ("facetdb_status" is null or "facetdb_status" <> 'pending');
-- binds: ["1","2"]
select cast("id" as varchar(4000)) as k, cast("title" as varchar(4000)) as s0, cast("description" as varchar(4000)) as s1, "facetdb_state_hash" as h, false as x, cast("updated_at" as varchar(4000)) as c from "main"."listings" where ("updated_at" > :1 or ("updated_at" = :1 and "id" > :2)) order by "updated_at", "id" fetch first :3 rows only;
-- binds: ["2026-11-03 10:00:00+00","2",2]

-- connector, watch: the next poll, from the last updated_at seen
select cast("id" as varchar(4000)) as k, cast("title" as varchar(4000)) as s0, cast("description" as varchar(4000)) as s1, "facetdb_state_hash" as h, false as x, cast("updated_at" as varchar(4000)) as c from "main"."listings" where "updated_at" >= :1 order by "updated_at", "id" fetch first :2 rows only;
-- binds: ["2026-11-03 10:00:00+00",2]
update "main"."listings" set "facetdb_status" = 'pending' where "id" in (:1) and ("facetdb_status" is null or "facetdb_status" <> 'pending');
-- binds: ["3"]

-- connector, watch: the hourly full scan, without a last-changed column
select cast("id" as varchar(4000)) as k, cast("title" as varchar(4000)) as s0, cast("description" as varchar(4000)) as s1, "facetdb_state_hash" as h, false as x from "main"."listings" order by "id" fetch first :1 rows only;
-- binds: [2]
update "main"."listings" set "facetdb_status" = 'pending' where "id" in (:1, :2) and ("facetdb_status" is null or "facetdb_status" <> 'pending');
-- binds: ["1","2"]
select cast("id" as varchar(4000)) as k, cast("title" as varchar(4000)) as s0, cast("description" as varchar(4000)) as s1, "facetdb_state_hash" as h, false as x from "main"."listings" where "id" > :1 order by "id" fetch first :2 rows only;
-- binds: ["2",2]

-- connector, read
select cast("id" as varchar(4000)) as k, cast("title" as varchar(4000)) as s0, cast("description" as varchar(4000)) as s1, "facetdb_state_hash" as h, false as x, cast("updated_at" as varchar(4000)) as c from "main"."listings" where "id" in (:1, :2);
-- binds: ["1","2"]

-- connector, write: the hash checked under a row lock, then the decision
select cast("id" as varchar(4000)) as k, cast("title" as varchar(4000)) as s0, cast("description" as varchar(4000)) as s1, "facetdb_state_hash" as h, false as x, cast("updated_at" as varchar(4000)) as c from "main"."listings" where "id" = :1 for update;
-- binds: ["1"]
update "main"."listings" set "is_scam" = :2, "is_scam_probability" = :3, "facetdb_status" = :4, "facetdb_updated_at" = timestamp '1970-01-01 00:00:00' + :5 * interval '0.001' second, "facetdb_reviewed" = :6, "facetdb_state_hash" = :7 where "id" = :1;
-- binds: ["1",true,0.93,"done",1700000000000,true,"0d5a7e381f0afa9fe6c56f5f7669d3849c7a0dbce8e8c71c5f501004390418bb"]

-- connector, current
select cast("id" as varchar(4000)) as k, cast("is_scam" as varchar(4000)) as q0v, cast("is_scam_probability" as varchar(4000)) as q0p, "facetdb_status" as cs, cast(epoch_ms("facetdb_updated_at") as varchar(20)) as cu, "facetdb_reviewed" as cr
         from "main"."listings" where cast("id" as varchar(4000)) in (:1, :2);
-- binds: ["1","2"]

-- connector, scan: the first page, newest first
select cast("id" as varchar(4000)) as k, cast("title" as varchar(4000)) as s0, cast("description" as varchar(4000)) as s1, "facetdb_state_hash" as h, false as x, cast("updated_at" as varchar(4000)) as c from "main"."listings" order by "id" desc fetch first :1 rows only;
-- binds: [3]

-- connector, scan: the page after a cursor
select cast("id" as varchar(4000)) as k, cast("title" as varchar(4000)) as s0, cast("description" as varchar(4000)) as s1, "facetdb_state_hash" as h, false as x, cast("updated_at" as varchar(4000)) as c from "main"."listings" where "id" < :1 order by "id" desc fetch first :2 rows only;
-- binds: ["9",3]
