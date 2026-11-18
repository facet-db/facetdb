-- The listings example's sample data on SQLite 3.35 and later (a libSQL server reads it too): a
-- marketplace `listings` table with 2,000 rows, run before `facetdb migrate`
-- (sqlite3 listings.db < seed.sql). Three categories in rotation, about one row in twenty written
-- like a scam (upfront payment, off-platform contact), so the backfill has both answers to give.
create table if not exists listings (
  id integer primary key,
  title text not null,
  description text,
  created_at text not null default current_timestamp,
  updated_at text not null default current_timestamp
);

with recursive numbers(n) as (
  select 1
  union all
  select n + 1 from numbers where n < 2000
)
insert into listings (title, description)
select
  case n % 3
    when 0 then case (n / 3) % 4 when 0 then '2015 Toyota Corolla, 98k km' when 1 then 'Honda CB500 motorbike, serviced' when 2 then 'Ford Transit van, long wheelbase' else 'VW Golf 1.4, one owner' end
    when 1 then case (n / 3) % 4 when 0 then 'Two-bedroom flat near the station' when 1 then 'Room in a shared house, bills included' when 2 then 'Family house with garden, 3 beds' else 'Studio to rent, furnished' end
    else case (n / 3) % 4 when 0 then 'Trek mountain bike, 29 inch' when 1 then 'Road bike carbon frame, 56 cm' when 2 then 'Kids bike with stabilisers' else 'Shimano groupset and wheels' end
  end
  || ' #' || n,
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
from numbers;
