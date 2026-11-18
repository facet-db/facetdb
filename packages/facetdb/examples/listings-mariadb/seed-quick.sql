-- A quick run's sample data on MariaDB 10.5 and later (MySQL 8 reads it too): the same marketplace
-- `listings` table as seed.sql with 100 rows (five of them written like a scam), for trying a
-- change in minutes. Run it with the admin login before `facetdb migrate`
-- (mariadb --host <host> --user <admin> --password <database> < seed-quick.sql).
create table if not exists listings (
  id int auto_increment primary key,
  title varchar(200) not null,
  description text,
  created_at timestamp(3) not null default current_timestamp(3),
  updated_at timestamp(3) not null default current_timestamp(3)
) engine = InnoDB;

insert into listings (title, description)
select
  concat(
    case n % 3
      when 0 then elt(1 + (n div 3) % 4, '2015 Toyota Corolla, 98k km', 'Honda CB500 motorbike, serviced', 'Ford Transit van, long wheelbase', 'VW Golf 1.4, one owner')
      when 1 then elt(1 + (n div 3) % 4, 'Two-bedroom flat near the station', 'Room in a shared house, bills included', 'Family house with garden, 3 beds', 'Studio to rent, furnished')
      else elt(1 + (n div 3) % 4, 'Trek mountain bike, 29 inch', 'Road bike carbon frame, 56 cm', 'Kids bike with stabilisers', 'Shimano groupset and wheels')
    end,
    ' #', n),
  case
    when n % 20 = 0 then
      'URGENT. Owner abroad, item is at a shipping agent. Pay the deposit by gift card or crypto today and we deliver tomorrow. No viewing possible, contact only on WhatsApp +00 000 000.'
    when n % 3 = 0 then
      'Full service history, MOT until next year, two keys. Viewing welcome at my home address, cash or bank transfer on collection.'
    when n % 3 = 1 then
      'Close to shops and schools, recently redecorated, deposit and first month on signing. Viewings by appointment through the agency.'
    else
      'Good condition, a few scratches, recently serviced. Collection only, happy to show it running before you pay.'
  end
from (
  select ones.d + 10 * tens.d + 1 as n
  from (select 0 as d union all select 1 union all select 2 union all select 3 union all select 4 union all select 5 union all select 6 union all select 7 union all select 8 union all select 9) as ones
  cross join (select 0 as d union all select 1 union all select 2 union all select 3 union all select 4 union all select 5 union all select 6 union all select 7 union all select 8 union all select 9) as tens
) as numbers
order by n;
