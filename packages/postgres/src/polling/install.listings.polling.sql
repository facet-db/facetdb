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
