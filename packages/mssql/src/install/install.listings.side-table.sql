-- FacetDB runs this script as one transaction: if a statement fails, all of it rolls back and nothing is changed.
-- Run by hand (sqlcmd, SSMS), a check before each statement skips the rest once one failed; then run set noexec off.
set xact_abort on;
set ansi_nulls on;
set quoted_identifier on;
begin transaction;
go

if @@trancount = 0 set noexec on;
go

set lock_timeout 10000;
go

if @@trancount = 0 set noexec on;
go

if object_id(N'[dbo].[facetdb_table_owners]', N'U') is null
  create table [dbo].[facetdb_table_owners] (
    [table_schema] sysname not null,
    [table_name] sysname not null,
    [project_id] nvarchar(256) not null,
    [project_name] nvarchar(256) not null,
    [installed_at] datetime2(3) not null default sysutcdatetime(),
    primary key ([table_schema], [table_name])
  );
go

if @@trancount = 0 set noexec on;
go

if not exists (select 1 from [dbo].[facetdb_table_owners] with (updlock, holdlock) where [table_schema] = N'dbo' and [table_name] = N'listings')
  insert into [dbo].[facetdb_table_owners] ([table_schema], [table_name], [project_id], [project_name])
  values (N'dbo', N'listings', N'proj_listings', N'Listings');
go

if @@trancount = 0 set noexec on;
go

declare @owner nvarchar(256) = (select [project_id] from [dbo].[facetdb_table_owners] where [table_schema] = N'dbo' and [table_name] = N'listings');
if @owner <> N'proj_listings'
begin
  declare @refused nvarchar(2048) = concat(N'FacetDB: dbo.listings already carries FacetDB columns from another project (', @owner, N'); one table belongs to one project. Uninstall there first, or point this project at another table.');
  throw 51000, @refused, 1;
end;
go

if @@trancount = 0 set noexec on;
go

if object_id(N'[dbo].[facetdb_listings_answers]', N'U') is null
begin
  create table [dbo].[facetdb_listings_answers] (
    [id] int not null constraint [facetdb_listings_answers_pkey] primary key,
    [is_scam] bit null,
    [is_scam_probability] real null,
    [facetdb_status] varchar(16) null,
    [facetdb_updated_at] datetime2(3) null,
    [facetdb_reviewed] bit null,
    constraint [facetdb_listings_answers_fkey] foreign key ([id]) references [dbo].[listings] ([id])
      on delete cascade on update cascade
  );
  exec sys.sp_addextendedproperty @name = N'facetdb', @value = N'facetdb',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'TABLE', @level1name = N'facetdb_listings_answers';
end;
go

if @@trancount = 0 set noexec on;
go

create or alter view [dbo].[listings_with_answers]
as
select t.[id],
       t.[title],
       t.[description],
       a.[is_scam],
       a.[is_scam_probability],
       coalesce(a.[facetdb_status], 'pending') as [facetdb_status],
       a.[facetdb_updated_at],
       coalesce(a.[facetdb_reviewed], cast(0 as bit)) as [facetdb_reviewed]
  from [dbo].[listings] t
  left join [dbo].[facetdb_listings_answers] a on a.[id] = t.[id];
go

if @@trancount = 0 set noexec on;
go

if not exists (select 1 from sys.extended_properties where class = 1 and minor_id = 0
                 and major_id = object_id(N'[dbo].[listings_with_answers]') and name = N'facetdb')
  exec sys.sp_addextendedproperty @name = N'facetdb', @value = N'facetdb',
    @level0type = N'SCHEMA', @level0name = N'dbo',
    @level1type = N'VIEW', @level1name = N'listings_with_answers';
go

if @@trancount = 0 set noexec on;
go

if object_id(N'[dbo].[facetdb_jobs]', N'U') is null
begin
  create table [dbo].[facetdb_jobs] (
    [table_name] nvarchar(128) not null,
    [record_key] nvarchar(322) collate Latin1_General_100_BIN2 not null,
    [enqueued_at] datetime2(3) not null default sysutcdatetime(),
    [claimed_by] nvarchar(128) null,
    [claimed_at] datetime2(3) null,
    [claim_token] char(32) null,
    primary key ([table_name], [record_key]) with (ignore_dup_key = on)
  );
  create index [facetdb_jobs_claimed] on [dbo].[facetdb_jobs] ([table_name], [claimed_at]);
end;
go

if @@trancount = 0 set noexec on;
go

drop trigger if exists [dbo].[facetdb_listings];
go

if @@trancount = 0 set noexec on;
go

create trigger [dbo].[facetdb_listings] on [dbo].[listings]
with execute as owner
after insert, update
as
begin
  set nocount on;
  -- FacetDB's reads here run at read committed whatever the application's level; SQL Server gives
  -- the application its own level back when the trigger returns.
  set transaction isolation level read committed;
  -- A statement that changed no row has nothing to queue: its firing ends here, before any write.
  if not exists (select 1 from inserted) return;
  -- An update that sets a state column, or an insert (which sets every column): the worker's own
  -- update sets none of them.
  if update([title])
     or update([description])
  begin
    -- The record's side row back to pending; the table itself is never written.
    update a set [facetdb_status] = 'pending'
      from [dbo].[facetdb_listings_answers] a
      join inserted i on i.[id] = a.[id]
     where a.[facetdb_status] is null or a.[facetdb_status] <> 'pending';
    -- A record without a side row gets one, pending.
    insert into [dbo].[facetdb_listings_answers] ([id], [facetdb_status])
    select i.[id], 'pending'
      from inserted i
     where not exists (select 1 from [dbo].[facetdb_listings_answers] a with (readcommittedlock) where a.[id] = i.[id]);
    -- A key already queued keeps its job, its claim cleared, so the new state is asked too.
    update j set [claimed_by] = null, [claimed_at] = null, [claim_token] = null
      from [dbo].[facetdb_jobs] j
      join inserted i on j.[table_name] = N'[dbo].[listings]' and j.[record_key] = convert(nvarchar(322), i.[id]);
    -- A key not queued yet is queued.
    insert into [dbo].[facetdb_jobs] ([table_name], [record_key])
    select N'[dbo].[listings]', convert(nvarchar(322), i.[id])
      from inserted i
     where not exists (select 1 from [dbo].[facetdb_jobs] j
                        where j.[table_name] = N'[dbo].[listings]' and j.[record_key] = convert(nvarchar(322), i.[id]));
  end
end;
go

if @@trancount = 0 set noexec on;
go

-- @p1 is the worker password from the source's connection string: facetdb migrate binds it
-- here and never prints it.
if database_principal_id(N'facetdb_worker') is null
begin
  declare @create nvarchar(max) = N'create user [facetdb_worker] with password = N''' + replace(@p1 collate Latin1_General_100_BIN2, N'''', N'''''') + N'''';
  exec (@create);
end;
go

if @@trancount = 0 set noexec on;
go

grant select ([id], [title], [description])
  on [dbo].[listings] to [facetdb_worker];
go

if @@trancount = 0 set noexec on;
go

grant select, insert, update on [dbo].[facetdb_listings_answers] to [facetdb_worker];
go

if @@trancount = 0 set noexec on;
go

grant select, insert, update, delete on [dbo].[facetdb_jobs] to [facetdb_worker];
go

if @@trancount = 0 set noexec on;
go

grant select on [dbo].[facetdb_table_owners] to [facetdb_worker];
go

if @@trancount = 0 set noexec on;
go

commit transaction;
go
