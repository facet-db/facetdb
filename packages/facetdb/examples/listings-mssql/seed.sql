-- The listings example's sample data on SQL Server 2016 and later or Azure SQL: a marketplace
-- `dbo.listings` table with 2,000 rows, run with the admin login before `facetdb migrate`
-- (sqlcmd -S <host> -d <database> -U <admin> -i seed.sql). Three categories in rotation, about one
-- row in twenty written like a scam (upfront payment, off-platform contact), so the backfill has
-- both answers to give. The insert names its columns: FacetDB adds its own to the table.
if object_id(N'dbo.listings', N'U') is null
  create table dbo.listings (
    id int identity(1, 1) primary key,
    title nvarchar(200) not null,
    description nvarchar(1000),
    created_at datetime2(3) not null default sysutcdatetime(),
    updated_at datetime2(3) not null default sysutcdatetime()
  );
go

with digits as (
  select d from (values (0), (1), (2), (3), (4), (5), (6), (7), (8), (9)) as v(d)
),
numbers as (
  select ones.d + 10 * tens.d + 100 * hundreds.d + 1000 * thousands.d + 1 as n
  from digits as ones
  cross join digits as tens
  cross join digits as hundreds
  cross join digits as thousands
  where thousands.d < 2
)
insert into dbo.listings (title, description)
select
  case n % 3
    when 0 then choose(1 + (n / 3) % 4, N'2015 Toyota Corolla, 98k km', N'Honda CB500 motorbike, serviced', N'Ford Transit van, long wheelbase', N'VW Golf 1.4, one owner')
    when 1 then choose(1 + (n / 3) % 4, N'Two-bedroom flat near the station', N'Room in a shared house, bills included', N'Family house with garden, 3 beds', N'Studio to rent, furnished')
    else choose(1 + (n / 3) % 4, N'Trek mountain bike, 29 inch', N'Road bike carbon frame, 56 cm', N'Kids bike with stabilisers', N'Shimano groupset and wheels')
  end
  + N' #' + cast(n as nvarchar(10)),
  case
    when n % 20 = 0 then
      N'URGENT. Owner abroad, item is at a shipping agent. Pay the deposit by gift card or crypto today and we deliver tomorrow. No viewing possible, contact only on WhatsApp +00 000 000.'
    when n % 3 = 0 then
      N'Full service history, MOT until next year, two keys. Viewing welcome at my home address, cash or bank transfer on collection.'
    when n % 3 = 1 then
      N'Close to shops and schools, recently redecorated, deposit and first month on signing. Viewings by appointment through the agency.'
    else
      N'Good condition, a few scratches, recently serviced. Collection only, happy to show it running before you pay.'
  end
from numbers
order by n;
go
