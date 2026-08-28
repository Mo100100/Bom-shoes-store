-- Remove the dead products.sale_price column and teach product_catalog the
-- rest of the real pricing rule.
--
-- sale_price was never read by any order path: create-order, fulfill_order
-- and _shared/pricing.ts all charge coalesce(price_override, products.price),
-- so every "sale" the admin entered advertised a discount the checkout
-- then refused to honour. The store owner asked for the column to go; real
-- discounts continue through product_variants.price_override, which already
-- is charged. Dropping a column is the one destructive step here and was
-- explicitly authorised.
--
-- product_catalog loses sale_price and gains two columns:
--   max_price    -- the top of the variant price range, so the grid can tell
--                   a flat "500" apart from a "from 400" without a second
--                   query or a client-side scan.
--   has_discount -- ONE SQL definition of "this product really is on sale".
--                   The /sale filter and the SALE badge both read this same
--                   column, so they cannot drift apart again (they already
--                   had: the filter tested sale_price, the badge tested
--                   min_price < price).
--
-- min_price and max_price now prefer IN-STOCK variants, falling back to all
-- variants only when nothing is in stock at all (so a sold-out product still
-- shows what it cost rather than jumping to its base price). A price backed
-- solely by a sold-out size is not a price anyone can pay, which is the same
-- lie sale_price was telling. has_discount is derived from that same
-- min_price via the nested select rather than recomputing the expression, so
-- the displayed price, the badge and the filter are one rule, not three.
--
-- DROP + CREATE, not CREATE OR REPLACE: removing sale_price changes the
-- column set of `select p.*`, and CREATE OR REPLACE VIEW rejects any change
-- to the existing leading columns. Nothing depends on this view (no RLS
-- policy, no other view; the app and the sitemap function query it only at
-- runtime), so a plain DROP is safe.
--
-- The view is recreated `with (security_invoker = true)`. 20260704002000 and
-- 20260704007000 both set it; 20260712000001 silently reset it, because
-- CREATE OR REPLACE VIEW replaces reloptions wholesale and that migration
-- passed none. Restoring it changes nobody's visibility: products,
-- product_variants and reviews each have a `for select using (true)` policy,
-- so it just puts the view back under the querying role's RLS instead of the
-- view owner's, which is what the original migration intended.

drop view if exists public.product_catalog;

alter table public.products drop column if exists sale_price;

create view public.product_catalog
with (security_invoker = true) as
select
  c.*,
  c.min_price < c.price as has_discount
from (
  select
    p.*,
    coalesce(v.total_stock, 0) as total_stock,
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
      array_agg(distinct pv.size) as available_sizes,
      array_agg(distinct pv.color) as available_colors,
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
