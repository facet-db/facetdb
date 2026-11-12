-- A quick run's sample data: the same marketplace `listings` table as seed.sql with 100 rows (five
-- of them written like a scam), for trying a change in minutes; the full example runs on
-- seed.sql's 2,000. Run in the Supabase SQL editor before `facetdb migrate`. Three categories in
-- rotation; `created_at` and `updated_at` default to now() so a timing query can compare them
-- with facetdb_updated_at.
create table if not exists public.listings (
  id serial primary key,
  title text not null,
  description text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.listings (title, description)
select
  case n % 3
    when 0 then (array['2015 Toyota Corolla, 98k km', 'Honda CB500 motorbike, serviced', 'Ford Transit van, long wheelbase', 'VW Golf 1.4, one owner'])[1 + (n / 3) % 4]
    when 1 then (array['Two-bedroom flat near the station', 'Room in a shared house, bills included', 'Family house with garden, 3 beds', 'Studio to rent, furnished'])[1 + (n / 3) % 4]
    else (array['Trek mountain bike, 29 inch', 'Road bike carbon frame, 56 cm', 'Kids bike with stabilisers', 'Shimano groupset and wheels'])[1 + (n / 3) % 4]
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
from generate_series(1, 100) as n;
