-- MySQL runs this script statement by statement, with no transaction around it: if it stops
-- part way, what ran stays, and running the same facetdb command again completes it. Run by
-- hand, give it to mysql --batch, which stops at the first error: the source command and a
-- paste go on past one.

set session lock_wait_timeout = 10 /*M! , sql_mode = concat_ws(',', nullif(@@session.sql_mode, ''), 'NO_AUTO_CREATE_USER') */;

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

create table if not exists `app`.`facetdb_listings_answers` (
  `id` int not null primary key,
  `is_scam` boolean comment 'facetdb',
  `is_scam_probability` float comment 'facetdb',
  `facetdb_status` varchar(16) not null default 'pending' comment 'facetdb',
  `facetdb_updated_at` datetime(3) comment 'facetdb',
  `facetdb_reviewed` boolean not null default false comment 'facetdb',
  constraint `facetdb_listings_fk` foreign key (`id`) references `app`.`listings` (`id`)
    on delete cascade on update cascade
) engine = InnoDB default charset = utf8mb4 comment = 'facetdb';

create or replace sql security invoker view `app`.`listings_with_answers` as
select t.*,
  a.`is_scam`,
  a.`is_scam_probability`,
  coalesce(a.`facetdb_status`, 'pending') as `facetdb_status`,
  a.`facetdb_updated_at`,
  coalesce(a.`facetdb_reviewed`, 0) as `facetdb_reviewed`
  from `app`.`listings` t
  left join `app`.`facetdb_listings_answers` a on a.`id` = t.`id`;

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

grant select (`id`, `title`, `description`)
  on `app`.`listings` to 'facetdb_worker'@'%';

grant select, insert, update, delete on `app`.`facetdb_listings_answers` to 'facetdb_worker'@'%';

grant select on `app`.`listings_with_answers` to 'facetdb_worker'@'%';

grant select, insert, update, delete on `app`.`facetdb_jobs` to 'facetdb_worker'@'%';

grant select on `app`.`facetdb_table_owners` to 'facetdb_worker'@'%';

drop trigger if exists `app`.`facetdb_listings_ins`;

delimiter //
create definer = current_user trigger `app`.`facetdb_listings_ins` after insert on `app`.`listings` for each row
begin
  insert into `app`.`facetdb_listings_answers` (`id`) values (new.`id`)
    on duplicate key update `is_scam` = null, `is_scam_probability` = null, `facetdb_status` = 'pending', `facetdb_updated_at` = null, `facetdb_reviewed` = false;
  insert into `app`.`facetdb_jobs` (`table_name`, `record_key`) values ('listings', cast(new.`id` as char character set utf8mb4))
    on duplicate key update `claimed_at` = null, `claimed_by` = null, `claim_token` = null;
end//
delimiter ;

drop trigger if exists `app`.`facetdb_listings_upd`;

delimiter //
create definer = current_user trigger `app`.`facetdb_listings_upd` after update on `app`.`listings` for each row
begin
  if not (cast(old.`title` as binary) <=> cast(new.`title` as binary))
     or not (cast(old.`description` as binary) <=> cast(new.`description` as binary)) then
    insert into `app`.`facetdb_listings_answers` (`id`) values (new.`id`)
      on duplicate key update `facetdb_status` = 'pending';
    insert into `app`.`facetdb_jobs` (`table_name`, `record_key`) values ('listings', cast(new.`id` as char character set utf8mb4))
      on duplicate key update `claimed_at` = null, `claimed_by` = null, `claim_token` = null;
  end if;
end//
delimiter ;
