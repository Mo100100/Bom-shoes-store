-- Brand keys: repair the corrupted row, and stop another one being created.
--
-- `brands.value` is the PRIMARY KEY and `products.brand` stores it as free
-- text with no foreign key, so the key is an identifier the admin may never
-- change: `name` is the editable display label and every screen renders it
-- through brandLabel() (src/lib/brands.ts). Renaming a brand therefore touches
-- `name` only and can no longer leave products pointing at a key that is gone.
--
-- What that model could not fix on its own is the row already in the live
-- database: value = a single stray Arabic letter, name = 'Burberry'. It was
-- created by an unvalidated add and then "renamed", which only ever wrote
-- `name`. Its key has to be corrected once, here, together with any product
-- pointing at it.
--
-- Everything below is guarded and re-runnable: a second run finds no row
-- matching the predicate and does nothing, and the owner repairing it by hand
-- first is the same no-op.

comment on column public.brands.value is
  'Immutable identifier. products.brand stores this (free text, no FK). Seeded from the brand name at creation and never updated again -- rename `name` instead, which is what the storefront and the admin display.';

do $$
declare
  stray record;
  corrected text;
begin
  -- "A single character that is not the real name": narrow enough that no
  -- healthy row can match, and stated as a rule rather than as a hardcoded
  -- key or row id.
  for stray in
    select value, name
    from public.brands
    where char_length(btrim(value)) = 1
      and char_length(btrim(name)) > 1
      and btrim(name) <> btrim(value)
  loop
    corrected := btrim(stray.name);

    -- Products first: no foreign key means the order is free, and moving them
    -- before the key changes leaves no window where a product points at a key
    -- that exists under neither spelling.
    update public.products set brand = corrected where brand = stray.value;

    if exists (select 1 from public.brands where value = corrected) then
      -- The owner already added the brand under its correct name by hand: the
      -- products above are now on that row, so the stray key is dead weight.
      delete from public.brands where value = stray.value;
      raise notice 'brands: merged stray key % into existing %', stray.value, corrected;
    else
      update public.brands set value = corrected where value = stray.value;
      raise notice 'brands: repaired stray key % to %', stray.value, corrected;
    end if;
  end loop;
end $$;

-- Belt and braces for the client-side validation in src/lib/brands.ts: a key
-- is at least two characters and carries no surrounding whitespace. NOT VALID
-- on purpose -- the database is live, and a constraint that refuses to be
-- added because of some row nobody has looked at yet would take the migration
-- down with it. NOT VALID still enforces every INSERT and UPDATE from here on,
-- which is the only thing this needs to do.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'brands_value_sane'
  ) then
    alter table public.brands
      add constraint brands_value_sane
      check (value = btrim(value) and char_length(value) between 2 and 40)
      not valid;
  end if;
end $$;
