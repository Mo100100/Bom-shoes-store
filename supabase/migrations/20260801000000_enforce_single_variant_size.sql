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
-- add a CHECK constraint so the database refuses a crammed, padded or blank
-- size from any client. The admin form splits on '/' and ',' before saving;
-- this is the server-side backstop for anything that bypasses it.
--
-- IDS ARE PRESERVED WHEREVER POSSIBLE, and that is the point of the ordering
-- below. A variant id is referenced by orders (items JSON -> fulfill_order()
-- looks the row up by id and raises 'variant % not found' when it is gone, so
-- deleting one can fail a PAID order's webhook) and by
-- stock_notify_requests.variant_id, which is ON DELETE CASCADE, so deleting one
-- silently drops every back-in-stock subscription for it. A crammed row sitting
-- at stock 0 is exactly where customers click "notify me". So every crammed row
-- is REWRITTEN IN PLACE to its first size, keeping its id; only the rows that
-- genuinely collide with an existing row are deleted, and the count of
-- subscriptions that go with them is raised as a NOTICE.
--
-- This mirrors what src/lib/variantDiff.ts pass 2 already does when an admin
-- re-saves such a product: the row keeps its id and its size is corrected.
--
-- Idempotent: every step matches nothing on a second run, and the constraint is
-- dropped-if-exists before it is added.

begin;

-- ---------------------------------------------------------------------------
-- 1. Trim padded sizes in place. ' 41 ' passes a btrim-only check but never
--    matches a cart line, because the pricing resolver compares size exactly.
--    Skipped (and left to step 5) when the trimmed value would collide with a
--    row that already holds it.
--
--    TWO guards, because they catch different collisions. The NOT EXISTS sees
--    only the statement's snapshot, so it catches rows this UPDATE is NOT
--    touching but is blind to rows it IS touching: ' 41' and '41 ' in one
--    product and colour both trim to '41', neither sees the other at snapshot
--    time, and both would be set to '41' -> duplicate key, migration aborts.
--    The second guard dedupes WITHIN the batch by letting the lowest id win;
--    the losers fall through to step 5, which already handles collisions.
-- ---------------------------------------------------------------------------
update public.product_variants v
set size = btrim(v.size)
where v.size <> btrim(v.size)
  and btrim(v.size) <> ''
  and not exists (
    select 1 from public.product_variants o
    where o.product_id = v.product_id
      and o.color = v.color
      and o.size = btrim(v.size)
      and o.id <> v.id
  )
  and v.id = (
    select o.id from public.product_variants o
    where o.product_id = v.product_id
      and o.color = v.color
      and o.size <> btrim(o.size)
      and btrim(o.size) = btrim(v.size)
    order by o.id
    limit 1
  );

-- ---------------------------------------------------------------------------
-- 2. Capture every size a crammed row was carrying BEFORE it is rewritten.
--    Step 3 destroys the crammed string, so the remaining sizes have to be
--    held somewhere first.
-- ---------------------------------------------------------------------------
create temporary table crammed_variant_parts on commit drop as
select v.id, v.product_id, v.color, v.stock, v.price_override,
       btrim(s.part) as part, s.ord
from public.product_variants v
cross join lateral unnest(regexp_split_to_array(v.size, '[/,]')) with ordinality as s(part, ord)
where v.size ~ '[/,]';

delete from crammed_variant_parts where part = '';

-- ---------------------------------------------------------------------------
-- 3. Rewrite each crammed row IN PLACE to its first size, keeping its id and
--    therefore its orders and its back-in-stock subscriptions.
--
--    `first_part` is one candidate per crammed row: its first non-blank size.
--    `winner` then dedupes ACROSS rows, because two crammed rows in the same
--    product and colour can name the same first size: A = '41/42' and
--    B = '41/43' both want '41', neither can see the other in the NOT EXISTS
--    (a subquery sees the statement's snapshot, never the rows the statement
--    is itself updating), and both would be set to '41' -> duplicate key on
--    the non-deferrable unique (product_id, size, color), aborting the whole
--    migration. Lowest id wins; the loser falls through to step 5, and step 4
--    still re-inserts every size it was carrying, so no size is lost.
--
--    The NOT EXISTS is still needed alongside it: it catches collisions with
--    rows this statement is not touching at all.
--
--    ponytail: always the FIRST part, never "the first part nobody else took".
--    Picking a non-colliding part would preserve a few more ids, but which
--    parts are free depends on what the other rows in the batch claimed, which
--    is a sequential assignment no reviewer can check by reading. The cost is
--    one lost id per same-first-size collision, which step 5 reports.
--
--    Stock: least(stock, 1). The crammed rows stored the COUNT of sizes as the
--    stock, so keeping it would claim five pairs of every size and let the
--    store oversell. 1 marks the size sellable without inventing quantity; the
--    owner tops up real per-size counts in the admin. A row already at 0 stays
--    at 0.
-- ---------------------------------------------------------------------------
with first_part as (
  select distinct on (id) id, product_id, color, part
  from crammed_variant_parts
  order by id, ord
), winner as (
  select distinct on (product_id, color, part) id, product_id, color, part
  from first_part
  order by product_id, color, part, id
)
update public.product_variants v
set size = w.part,
    stock = least(v.stock, 1)
from winner w
where v.id = w.id
  and not exists (
    select 1 from public.product_variants o
    where o.product_id = w.product_id
      and o.color = w.color
      and o.size = w.part
      and o.id <> v.id
  );

-- ---------------------------------------------------------------------------
-- 4. Add the sizes that had nowhere to go: every other size the crammed rows
--    named, plus the first size of any row step 3 could not rewrite. These are
--    genuinely new rows, so a new id is correct for them.
-- ---------------------------------------------------------------------------
insert into public.product_variants (product_id, size, color, stock, price_override)
select p.product_id, p.part, p.color, least(p.stock, 1), p.price_override
from crammed_variant_parts p
on conflict (product_id, size, color) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Whatever is left is unsalvageable: a crammed or padded row whose corrected
--    size is already held by another row (so the correct data survives under a
--    different id), or a row whose size is entirely blank. Say out loud how
--    many back-in-stock subscriptions cascade away with them, since nothing
--    else would ever tell the owner.
-- ---------------------------------------------------------------------------
do $$
declare
  doomed_variants int;
  doomed_subscriptions int;
begin
  select count(*) into doomed_variants
  from public.product_variants
  where size ~ '[/,]' or size <> btrim(size) or size = '';

  select count(*) into doomed_subscriptions
  from public.stock_notify_requests r
  join public.product_variants v on v.id = r.variant_id
  where v.size ~ '[/,]' or v.size <> btrim(v.size) or v.size = '';

  if doomed_variants > 0 then
    raise notice 'Deleting % unsalvageable variant row(s) whose corrected size is already taken; % back-in-stock subscription(s) cascade away with them.',
      doomed_variants, doomed_subscriptions;
  end if;
end $$;

delete from public.product_variants
where size ~ '[/,]' or size <> btrim(size) or size = '';

-- ---------------------------------------------------------------------------
-- 6. The legacy products.sizes array feeds the storefront fallback for products
--    with no variants at all, so it has to be cleaned the same way or the bug
--    survives down that path.
-- ---------------------------------------------------------------------------
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
  where raw ~ '[/,]' or raw <> btrim(raw) or raw = ''
);

-- ---------------------------------------------------------------------------
-- 7. The actual defence: one trimmed, non-empty size per row, always. This is
--    what the previous fixup was missing. It matches splitSizes() in
--    src/lib/sizes.ts exactly, padding included: a size that is not already
--    trimmed can never match a cart line, so it must not be storable.
-- ---------------------------------------------------------------------------
alter table public.product_variants
  drop constraint if exists product_variants_size_single;

alter table public.product_variants
  add constraint product_variants_size_single
  check (size !~ '[/,]' and size = btrim(size) and size <> '');

commit;
