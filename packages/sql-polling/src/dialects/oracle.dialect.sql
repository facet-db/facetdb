-- The Oracle dialect: every operation's SQL for the listings example (the conformance suite).
-- plan, install: a fresh table, the worker login missing
alter table "listings" add ("is_scam" number(1));

comment on column "listings"."is_scam" is 'facetdb';

alter table "listings" add ("is_scam_probability" number);

comment on column "listings"."is_scam_probability" is 'facetdb';

alter table "listings" add ("facetdb_status" varchar2(255 char));

comment on column "listings"."facetdb_status" is 'facetdb';

alter table "listings" add ("facetdb_updated_at" timestamp(3));

comment on column "listings"."facetdb_updated_at" is 'facetdb';

alter table "listings" add ("facetdb_reviewed" number(1) default 0);

comment on column "listings"."facetdb_reviewed" is 'facetdb';

alter table "listings" add ("facetdb_state_hash" varchar2(64));

comment on column "listings"."facetdb_state_hash" is 'facetdb';

comment on column "listings"."facetdb_state_hash" is 'facetdb:proj_listings';

-- the worker login FACETDB_WORKER: created by facetdb migrate with the password of the source's connection string, bound, never printed;

grant create session to "FACETDB_WORKER";

grant select on "listings" to "FACETDB_WORKER";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash") on "listings" to "FACETDB_WORKER";

-- plan, install: a table with no last-changed column
alter table "listings" add ("is_scam" number(1));

comment on column "listings"."is_scam" is 'facetdb';

alter table "listings" add ("is_scam_probability" number);

comment on column "listings"."is_scam_probability" is 'facetdb';

alter table "listings" add ("facetdb_status" varchar2(255 char));

comment on column "listings"."facetdb_status" is 'facetdb';

alter table "listings" add ("facetdb_updated_at" timestamp(3));

comment on column "listings"."facetdb_updated_at" is 'facetdb';

alter table "listings" add ("facetdb_reviewed" number(1) default 0);

comment on column "listings"."facetdb_reviewed" is 'facetdb';

alter table "listings" add ("facetdb_state_hash" varchar2(64));

comment on column "listings"."facetdb_state_hash" is 'facetdb';

comment on column "listings"."facetdb_state_hash" is 'facetdb:proj_listings';

grant select on "listings" to "FACETDB_WORKER";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash") on "listings" to "FACETDB_WORKER";

-- plan, install: the table installed, the login there
comment on column "listings"."is_scam" is 'facetdb';

comment on column "listings"."is_scam_probability" is 'facetdb';

comment on column "listings"."facetdb_status" is 'facetdb';

comment on column "listings"."facetdb_updated_at" is 'facetdb';

comment on column "listings"."facetdb_reviewed" is 'facetdb';

comment on column "listings"."facetdb_state_hash" is 'facetdb';

comment on column "listings"."facetdb_state_hash" is 'facetdb:proj_listings';

grant select on "listings" to "FACETDB_WORKER";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash") on "listings" to "FACETDB_WORKER";

-- plan, install: a polling table from an earlier version, its state hash with the bare mark
comment on column "listings"."is_scam" is 'facetdb';

comment on column "listings"."is_scam_probability" is 'facetdb';

comment on column "listings"."facetdb_status" is 'facetdb';

comment on column "listings"."facetdb_updated_at" is 'facetdb';

comment on column "listings"."facetdb_reviewed" is 'facetdb';

comment on column "listings"."facetdb_state_hash" is 'facetdb';

comment on column "listings"."facetdb_state_hash" is 'facetdb:proj_listings';

grant select on "listings" to "FACETDB_WORKER";

grant update ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash") on "listings" to "FACETDB_WORKER";

-- plan, uninstall
grant select on "listings" to "FACETDB_WORKER";

revoke all on "listings" from "FACETDB_WORKER";

alter table "listings" drop ("is_scam", "is_scam_probability", "facetdb_status", "facetdb_updated_at", "facetdb_reviewed", "facetdb_state_hash");

-- plan, prune: is_scam removed for is_spam, description no longer read
alter table "listings" drop ("is_scam", "is_scam_probability");

-- connector, watch: the first poll by updated_at, over two pages
select to_char("id") as k, to_char("title") as s0, to_char("description") as s1, "facetdb_state_hash" as h, 0 as x, to_char("updated_at") as c from "listings" order by "updated_at", "id" fetch first :1 rows only;
-- binds: [2]
update "listings" set "facetdb_status" = 'pending' where "id" in (:1, :2) and "facetdb_status" is null;
-- binds: ["1","2"]
select to_char("id") as k, to_char("title") as s0, to_char("description") as s1, "facetdb_state_hash" as h, 0 as x, to_char("updated_at") as c from "listings" where ("updated_at" > :1 or ("updated_at" = :1 and "id" > :2)) order by "updated_at", "id" fetch first :3 rows only;
-- binds: ["2026-11-03 10:00:00+00","2",2]

-- connector, watch: the next poll, from the last updated_at seen
select to_char("id") as k, to_char("title") as s0, to_char("description") as s1, "facetdb_state_hash" as h, 0 as x, to_char("updated_at") as c from "listings" where "updated_at" >= :1 order by "updated_at", "id" fetch first :2 rows only;
-- binds: ["2026-11-03 10:00:00+00",2]
update "listings" set "facetdb_status" = 'pending' where "id" in (:1) and "facetdb_status" is null;
-- binds: ["3"]

-- connector, watch: the hourly full scan, without a last-changed column
select to_char("id") as k, to_char("title") as s0, to_char("description") as s1, "facetdb_state_hash" as h, 0 as x from "listings" order by "id" fetch first :1 rows only;
-- binds: [2]
update "listings" set "facetdb_status" = 'pending' where "id" in (:1, :2) and "facetdb_status" is null;
-- binds: ["1","2"]
select to_char("id") as k, to_char("title") as s0, to_char("description") as s1, "facetdb_state_hash" as h, 0 as x from "listings" where "id" > :1 order by "id" fetch first :2 rows only;
-- binds: ["2",2]

-- connector, read
select to_char("id") as k, to_char("title") as s0, to_char("description") as s1, "facetdb_state_hash" as h, 0 as x, to_char("updated_at") as c from "listings" where "id" in (:1, :2);
-- binds: ["1","2"]

-- connector, write: the hash checked under a row lock, then the decision
select to_char("id") as k, to_char("title") as s0, to_char("description") as s1, "facetdb_state_hash" as h, 0 as x, to_char("updated_at") as c from "listings" where "id" = :1 for update;
-- binds: ["1"]
update "listings" set "is_scam" = :2, "is_scam_probability" = :3, "facetdb_status" = :4, "facetdb_updated_at" = timestamp '1970-01-01 00:00:00' + numtodsinterval(:5 / 1000, 'SECOND'), "facetdb_reviewed" = :6, "facetdb_state_hash" = :7 where "id" = :1;
-- binds: ["1",1,0.93,"done",1700000000000,1,"0d5a7e381f0afa9fe6c56f5f7669d3849c7a0dbce8e8c71c5f501004390418bb"]

-- connector, current
select to_char("id") as k, "is_scam" as q0v, to_char("is_scam_probability") as q0p, "facetdb_status" as cs, to_char(extract(day from ("facetdb_updated_at" - timestamp '1970-01-01 00:00:00')) * 86400000 + extract(hour from ("facetdb_updated_at" - timestamp '1970-01-01 00:00:00')) * 3600000 + extract(minute from ("facetdb_updated_at" - timestamp '1970-01-01 00:00:00')) * 60000 + round(extract(second from ("facetdb_updated_at" - timestamp '1970-01-01 00:00:00')) * 1000)) as cu, "facetdb_reviewed" as cr
         from "listings" where to_char("id") in (:1, :2);
-- binds: ["1","2"]

-- connector, scan: the first page, newest first
select to_char("id") as k, to_char("title") as s0, to_char("description") as s1, "facetdb_state_hash" as h, 0 as x, to_char("updated_at") as c from "listings" order by "id" desc fetch first :1 rows only;
-- binds: [3]

-- connector, scan: the page after a cursor
select to_char("id") as k, to_char("title") as s0, to_char("description") as s1, "facetdb_state_hash" as h, 0 as x, to_char("updated_at") as c from "listings" where "id" < :1 order by "id" desc fetch first :2 rows only;
-- binds: ["9",3]
