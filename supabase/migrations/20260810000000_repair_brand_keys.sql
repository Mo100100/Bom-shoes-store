-- Brand keys: repair every corrupted key, and stop another one being created.
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
-- The repair predicate below is the exact NEGATION of the CHECK constraint
-- added at the bottom, and that is deliberate rather than incidental. A CHECK
-- added NOT VALID skips the initial table scan, but Postgres still evaluates
-- it against the new row version of every LATER update of that row, whether or
-- not the update touches `value`. Every remaining brand write is such an
-- update: rename, position swap, logo upload, logo remove. So a violating row
-- that survived this migration would be frozen: unrenameable, unmovable, its
-- logo unchangeable, its key unfixable from any screen. Repairing exactly what
-- the constraint forbids is what guarantees no such row can exist.
--
-- Everything below is guarded and re-runnable: a second run finds no row
-- matching the predicate and says so, and the owner repairing a key by hand
-- first is the same no-op for that row.

comment on column public.brands.value is
  'Immutable identifier. products.brand stores this (free text, no FK). Seeded from the brand name at creation and never updated again -- rename `name` instead, which is what the storefront and the admin display.';

do $$
declare
  stray record;
  corrected text;
  repaired int := 0;
  survivors int;
begin
  for stray in
    select value, name, logo_url
    from public.brands
    -- The negation of brands_value_sane below. Keep the two in step.
    where not (value = btrim(value) and char_length(value) between 2 and 40)
  loop
    -- The display name is what the owner meant the key to be. Clamp it to the
    -- same ceiling the constraint enforces, so a repair can never manufacture
    -- the very row this migration exists to eliminate.
    -- Trimmed again AFTER the clamp: truncating at 40 can land on a space,
    -- and a trailing space is itself a violation.
    corrected := btrim(left(btrim(stray.name), 40));

    -- corrected is trimmed and at most 40 chars by construction, so length is
    -- the only rule left to check.
    if char_length(corrected) < 2 then
      -- No usable key can be derived (the name is as broken as the key). Fail
      -- loudly: a frozen row shipped quietly is far worse than a migration
      -- that stops and asks for a human.
      raise exception 'brands: cannot derive a valid key for row with value %, name % -- fix this row by hand first', stray.value, stray.name;
    end if;

    -- Products first: no foreign key means the order is free, and moving them
    -- before the key changes leaves no window where a product points at a key
    -- that exists under neither spelling.
    update public.products set brand = corrected where brand = stray.value;

    if exists (select 1 from public.brands where value = corrected) then
      -- The owner already added the brand under its correct name by hand: the
      -- products above are now on that row, so the stray key is dead weight.
      -- Carry its logo across first rather than throwing an upload away, and
      -- only where the survivor has none of its own.
      update public.brands
        set logo_url = coalesce(logo_url, stray.logo_url)
        where value = corrected;
      delete from public.brands where value = stray.value;
      raise notice 'brands: merged stray key % into existing %', stray.value, corrected;
    else
      update public.brands set value = corrected where value = stray.value;
      raise notice 'brands: repaired stray key % to %', stray.value, corrected;
    end if;
    repaired := repaired + 1;
  end loop;

  if repaired = 0 then
    -- Says "there was nothing to do", so it can never be mistaken for
    -- "the repair ran and found nothing to change".
    raise notice 'brands: no keys needed repair (already clean, or repaired by an earlier run)';
  end if;

  -- The constraint below is added NOT VALID, so nothing else will ever check
  -- this. Prove it here instead of assuming the loop above was exhaustive.
  select count(*) into survivors
  from public.brands
  where not (value = btrim(value) and char_length(value) between 2 and 40);
  if survivors > 0 then
    raise exception 'brands: % row(s) still violate the key rule after repair', survivors;
  end if;
end $$;

-- Belt and braces for the client-side validation in src/lib/brands.ts: a key
-- is at least two characters and carries no surrounding whitespace. NOT VALID
-- because the DO block above has just proved every existing row passes, so the
-- initial scan would only cost a lock on a live table to learn what is already
-- known. It still enforces every INSERT and UPDATE from here on.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'brands_value_sane'
      and conrelid = 'public.brands'::regclass
  ) then
    alter table public.brands
      add constraint brands_value_sane
      check (value = btrim(value) and char_length(value) between 2 and 40)
      not valid;
  end if;
end $$;
