-- The smoke's second table, seeded after the listings example's seed.sql into the dev
-- database: four sellers for Add a source to install on. The install answers no existing row
-- (they wait for "Answer existing records"), so the one written like the example's scams reaches
-- no review card in the smoke; it is there for whoever presses Start afterwards, when the fake
-- provider answers it unsure.
create table if not exists public.sellers (
  id serial primary key,
  bio text not null,
  country text not null
);

insert into public.sellers (bio, country) values
  ('Selling my old bikes, collection from my garage, happy to show them running', 'NL'),
  ('Family clearing out the loft: books, a pram and two lamps, photos on request', 'BE'),
  ('Small shop with invoices and returns, viewing welcome in opening hours', 'DE'),
  ('URGENT: new here, cash only, deposit by gift card today, contact only on WhatsApp', 'FR');
