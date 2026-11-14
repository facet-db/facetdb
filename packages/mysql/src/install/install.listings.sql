-- MySQL runs this script statement by statement, with no transaction around it: if it stops
-- part way, what ran stays, and running the same facetdb command again completes it. Run by
-- hand, give it to mysql --batch, which stops at the first error: the source command and a
-- paste go on past one.

set session lock_wait_timeout = 10;

create table if not exists `app`.`facetdb_table_owners` (
  `table_name` varchar(64) not null primary key,
  `project_id` varchar(255) not null,
  `source` varchar(255) not null,
  `installed_at` datetime(3) not null default current_timestamp(3)
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_bin;

insert into `app`.`facetdb_table_owners` (`table_name`, `project_id`, `source`) values ('listings', 'proj_listings', 'listings')
  on duplicate key update `table_name` = `table_name`;

-- stops the script here (Subquery returns more than 1 row) when another project owns this table
select (select 1 from `app`.`facetdb_table_owners` where `table_name` = 'listings' and `project_id` <> 'proj_listings'
        union all select 1) as `facetdb_owner_guard`;

alter table `app`.`listings`
  add column `is_scam` boolean comment 'facetdb',
  add column `is_scam_probability` float comment 'facetdb',
  add column `facetdb_status` varchar(16) not null default 'pending' comment 'facetdb',
  add column `facetdb_updated_at` datetime(3) comment 'facetdb',
  add column `facetdb_reviewed` boolean not null default false comment 'facetdb';

create table if not exists `app`.`facetdb_jobs` (
  `table_name` varchar(64) not null,
  `record_key` varbinary(1020) not null,
  `enqueued_at` datetime(3) not null default current_timestamp(3),
  `claimed_by` varchar(64),
  `claimed_at` datetime(3),
  `claim_token` char(32),
  primary key (`table_name`, `record_key`),
  index `facetdb_jobs_claimed_at` (`claimed_at`),
  index `facetdb_jobs_claim_token` (`claim_token`)
) engine = InnoDB default charset = utf8mb4 collate = utf8mb4_bin row_format = dynamic;

-- the worker password: facetdb migrate sends the one in the connection string of the source in
-- place of the placeholder and never prints it. Run by hand, write the password into this one
-- statement as a quoted literal, and never go on past an error: mysql --batch stops at the first
-- one, the source command and a paste do not.
create user if not exists 'facetdb_worker'@'%' identified by ? password expire never;

grant select (`id`, `title`, `description`, `is_scam`, `is_scam_probability`, `facetdb_status`, `facetdb_updated_at`, `facetdb_reviewed`)
  on `app`.`listings` to 'facetdb_worker'@'%';

grant update (`is_scam`, `is_scam_probability`, `facetdb_status`, `facetdb_updated_at`, `facetdb_reviewed`)
  on `app`.`listings` to 'facetdb_worker'@'%';

grant select, insert, update, delete on `app`.`facetdb_jobs` to 'facetdb_worker'@'%';

grant select on `app`.`facetdb_table_owners` to 'facetdb_worker'@'%';

drop trigger if exists `app`.`facetdb_listings_new`;

create definer = current_user trigger `app`.`facetdb_listings_new` before insert on `app`.`listings` for each row
set new.`facetdb_status` = 'pending';

drop trigger if exists `app`.`facetdb_listings_ins`;

create definer = current_user trigger `app`.`facetdb_listings_ins` after insert on `app`.`listings` for each row
insert into `app`.`facetdb_jobs` (`table_name`, `record_key`) values ('listings', cast(new.`id` as char character set utf8mb4))
  on duplicate key update `claimed_at` = null, `claimed_by` = null, `claim_token` = null;

drop trigger if exists `app`.`facetdb_listings_upd`;

delimiter //
create definer = current_user trigger `app`.`facetdb_listings_upd` before update on `app`.`listings` for each row
begin
  if not (cast(old.`title` as binary) <=> cast(new.`title` as binary))
     or not (cast(old.`description` as binary) <=> cast(new.`description` as binary)) then
    set new.`facetdb_status` = 'pending';
    insert into `app`.`facetdb_jobs` (`table_name`, `record_key`) values ('listings', cast(new.`id` as char character set utf8mb4))
      on duplicate key update `claimed_at` = null, `claimed_by` = null, `claim_token` = null;
  end if;
end//
delimiter ;
