-- Permanent fix for crammed variant sizes.
--
-- product_variants.size was being filled with slash-joined strings such as
-- '41/42/43' in a SINGLE row, which is why the cart showed a size the customer
-- never picked. 20260715000000_fix_crammed_variant_sizes.sql cleaned the rows
-- that existed at the time by listing ~90 uuids, but it added no constraint and
-- fixed no input path, so an admin typing '41/42/43' recreated the bug the same
-- afternoon.
--
-- This migration closes it for good: clean whatever is bad right now by PATTERN
-- (no hardcoded uuids, so it stays correct however the data has moved on), then
-- add a CHECK constraint so the database refuses a crammed or blank size from
-- any client. The admin form splits on '/' and ',' before saving; this is the
-- server-side backstop for anything that bypasses it.
--
-- Idempotent: the cleanup steps match nothing on a second run, and the
-- constraint is dropped-if-exists before it is added.

begin;

-- 1. Expand every crammed variant into one row per size, keeping the colour,
--    price override and product it belonged to.
--
--    Stock: least(stock, 1). The crammed rows stored the COUNT of sizes as the
--    stock, so copying it across would claim 5 pairs of every size and let the
--    store oversell. 1 marks the size as sellable without inventing quantity;
--    the owner tops up the real per-size counts in the admin. A crammed row
--    that was already at 0 stays at 0.
--
--    on conflict do nothing: the split size may already exist as its own row
--    for that product and colour, and the existing row is the trustworthy one.
insert into public.product_variants (product_id, size, color, stock, price_override)
select v.product_id, s.part, v.color, least(v.stock, 1), v.price_override
from public.product_variants v
cross join lateral (
  select btrim(part) as part
  from regexp_split_to_table(v.size, '[/,]') as part
) s
where v.size ~ '[/,]'
  and s.part <> ''
on conflict (product_id, size, color) do nothing;

-- 2. Drop the originals, plus any row whose size is blank or whitespace. Both
--    shapes are unsellable: the storefront renders them as a size button
--    nobody can meaningfully choose, and step 1 has already preserved whatever
--    real sizes a crammed row was carrying.
delete from public.product_variants
where size ~ '[/,]' or btrim(size) = '';

-- 3. The legacy products.sizes array feeds the storefront fallback for products
--    with no variants at all, so it has to be cleaned the same way or the bug
--    survives down that path.
update public.products p
set sizes = coalesce((
  select array_agg(distinct s.part order by s.part)
  from unnest(p.sizes) as raw
  cross join lateral (
    select btrim(part) as part
    from regexp_split_to_table(raw, '[/,]') as part
  ) s
  where s.part <> ''
), array[]::text[])
where exists (
  select 1 from unnest(p.sizes) as raw
  where raw ~ '[/,]' or btrim(raw) = ''
);

-- 4. The actual defence: one size per row, always. This is what the previous
--    fixup was missing.
alter table public.product_variants
  drop constraint if exists product_variants_size_single;

alter table public.product_variants
  add constraint product_variants_size_single
  check (size !~ '[/,]' and btrim(size) <> '');

commit;
