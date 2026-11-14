-- WAL: readers never wait for the writer and the writer never waits for readers, so the
-- application and the FacetDB worker do not block each other. The mode is persistent (the file
-- keeps it after this script), and SQLite cannot change it inside a transaction, so it runs
-- before begin.
pragma journal_mode = wal;

begin immediate;

create table if not exists "facetdb_jobs" (
  "table_name" text not null,
  "record_key" text not null,
  "enqueued_at" text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "claimed_by" text,
  "claimed_at" text,
  primary key ("table_name", "record_key")
);

create index if not exists "facetdb_jobs_queue" on "facetdb_jobs" ("table_name", "enqueued_at");

create table if not exists "facetdb_table_owners" (
  "table_name" text primary key,
  "project_id" text not null,
  "installed_at" text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "worker_id" text,
  "heartbeat_at" text
);

insert or ignore into "facetdb_table_owners" ("table_name", "project_id") values ('listings', 'proj_listings');

alter table "listings" add column "is_scam" /* facetdb */ integer;

alter table "listings" add column "is_scam_probability" /* facetdb */ real;

alter table "listings" add column "facetdb_status" /* facetdb */ text not null default 'pending';

alter table "listings" add column "facetdb_updated_at" /* facetdb */ text;

alter table "listings" add column "facetdb_reviewed" /* facetdb */ integer not null default 0;

drop trigger if exists "facetdb_listings_ins";

create trigger "facetdb_listings_ins" after insert on "listings"
begin
  update "listings" set "facetdb_status" = 'pending' where rowid = new.rowid and "facetdb_status" is not 'pending';
  insert into "facetdb_jobs" ("table_name", "record_key") values ('listings', new."id")
    on conflict ("table_name", "record_key") do update set "claimed_by" = null, "claimed_at" = null;
end;

drop trigger if exists "facetdb_listings_upd";

create trigger "facetdb_listings_upd" after update of "title", "description" on "listings"
begin
  update "listings" set "facetdb_status" = 'pending' where rowid = new.rowid and "facetdb_status" is not 'pending';
  insert into "facetdb_jobs" ("table_name", "record_key") values ('listings', new."id")
    on conflict ("table_name", "record_key") do update set "claimed_by" = null, "claimed_at" = null;
end;

commit;
