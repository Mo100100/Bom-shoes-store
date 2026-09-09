-- product_catalog: only report sizes and colours a customer can actually buy,
-- and stop reporting a legacy product's stock as zero.
--
-- Two corrections to the same view, both about it telling the truth about
-- stock. Nothing about price changes: min_price, max_price and has_discount
-- keep the exact expressions 20260805000000 gave them, so no product's
-- displayed or charged price moves by this migration.
--
-- 1. available_sizes / available_colors aggregated EVERY variant row with no
--    stock predicate, while min_price and max_price on the same lines already
--    filtered on `pv.stock > 0`. So the Shop size and colour filters matched a
--    product on a size that is sold out: the customer filters to size 44, gets
--    a card, opens it and finds 44 greyed out. Aggregate only in-stock
--    variants, exactly as the price columns do. There is deliberately no
--    "fall back to all variants" branch here (min_price has one): a price with
--    no stock behind it still tells you what the pair costs, but a SIZE with
--    no stock behind it is simply not a size on offer.
--
-- 2. total_stock coalesced a missing variant aggregate to 0, so a product with
--    no product_variants rows at all -- the legacy shape products.stock still
--    exists for -- read as sold out. ProductCard paints its sold-out overlay
--    from this column, while ProductDetail and QuickViewModal both work around
--    it by falling back to products.stock themselves. Coalescing to p.stock
--    fixes it once, in the one place all three of them read from. Zero of the
--    118 live products have no variants today, so this is prevention.
--
--    Behaviour change this carries: a variant-less product with products.stock
--    > 0 now reads as in stock on the grid card as well, where it used to read
--    as sold out. That is the honest answer for the detail page, but the card
--    also had a quick-add "+" keyed off this column, and quick-add needs a
--    variant row to put in the cart. ProductCard therefore gates the "+" on
--    available_sizes as well, which is aggregated over stock > 0 variants and
--    so is empty exactly when there is nothing to add. Without that gate the
--    card would offer a "+" that can only ever answer "out of stock".
--
-- CREATE OR REPLACE, not DROP + CREATE: the column names, types and order are
-- unchanged (only the expressions behind three of them move), so REPLACE is
-- legal, and it is what keeps the view's grants and its dependents intact.
-- security_invoker has to be restated because REPLACE rewrites reloptions
-- wholesale -- see the note in 20260805000000, where it was silently lost the
-- same way.
--
-- Re-runnable: the statement is a full definition, not a delta, so applying it
-- twice leaves the same view.

-- REPLACE takes an ACCESS EXCLUSIVE lock on the view, so every storefront read
-- of product_catalog queues behind it. With the default lock_timeout of 0 that
-- wait is unbounded. Fail fast and re-run in a quieter minute instead.

set local lock_timeout = '3s';

create or replace view public.product_catalog
with (security_invoker = true) as
select
  c.*,
  c.min_price < c.price as has_discount
from (
  select
    p.*,
    coalesce(v.total_stock, p.stock) as total_stock,
    coalesce(v.available_sizes, '{}') as available_sizes,
    coalesce(v.available_colors, '{}') as available_colors,
    coalesce(v.min_price, p.price) as min_price,
    coalesce(v.max_price, p.price) as max_price,
    r.avg_rating,
    coalesce(r.review_count, 0) as review_count
  from public.products p
  left join (
    select
      pv.product_id,
      sum(pv.stock) as total_stock,
      array_agg(distinct pv.size) filter (where pv.stock > 0) as available_sizes,
      array_agg(distinct pv.color) filter (where pv.stock > 0) as available_colors,
      coalesce(
        min(coalesce(pv.price_override, pr.price)) filter (where pv.stock > 0),
        min(coalesce(pv.price_override, pr.price))
      ) as min_price,
      coalesce(
        max(coalesce(pv.price_override, pr.price)) filter (where pv.stock > 0),
        max(coalesce(pv.price_override, pr.price))
      ) as max_price
    from public.product_variants pv
    join public.products pr on pr.id = pv.product_id
    group by pv.product_id
  ) v on v.product_id = p.id
  left join (
    select
      product_id,
      avg(rating) as avg_rating,
      count(*)::int as review_count
    from public.reviews
    group by product_id
  ) r on r.product_id = p.id
) c;
