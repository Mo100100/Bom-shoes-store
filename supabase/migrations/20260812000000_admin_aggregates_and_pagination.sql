-- Move the admin's numbers out of the browser.
--
-- supabase/config.toml sets `max_rows = 1000`. Several admin screens did
-- `select('*')` with no limit and then reduced the result client side, so past
-- 1000 rows PostgREST silently returned the first page and every derived
-- figure was quietly wrong: no error, no warning, just a revenue total that
-- stopped growing. The dashboard also shipped every order's full `items` jsonb
-- to the browser on every visit purely to draw a five-bar chart.
--
-- What this migration adds:
--   1. admin_dashboard_summary()  -- every dashboard figure, computed in SQL,
--                                    bucketed by Africa/Cairo calendar days.
--   2. admin_orders_page()        -- one page of orders plus the two figures
--                                    that must span the WHOLE table (the
--                                    filtered total and the per-status counts).
--   3. coupon_redemption_counts / bundle_item_counts -- two grouped views, so
--                                    counting redemptions no longer means
--                                    downloading them.
--   4. admin_reorder_positions()  -- one statement for a whole reorder, in
--                                    place of one UPDATE per row per click.
--
-- All three functions follow admin_update_order_status(): SECURITY DEFINER,
-- pinned search_path, EXECUTE revoked from anon/public and granted to
-- `authenticated`, with is_admin() checked inside. The two views are
-- security_invoker so they stay under the caller's own RLS.

-- ---------------------------------------------------------------------------
-- 0. Indexes the new aggregates read through.
--
-- `orders` had no index but its primary key, so every figure below was a
-- sequential scan. At ~118 products and a few hundred orders that is free; at
-- the 10,000 orders these functions are being written for it is not.
-- ---------------------------------------------------------------------------
create index if not exists orders_created_at_idx
  on public.orders (created_at desc);

create index if not exists orders_status_idx
  on public.orders (status);

create index if not exists orders_payment_status_created_at_idx
  on public.orders (payment_status, created_at desc);

-- ---------------------------------------------------------------------------
-- 1. Dashboard aggregates.
--
-- TIMEZONE. Revenue was bucketed by UTC day for a store that sells in Cairo,
-- which is UTC+2 (UTC+3 in summer). Local time runs AHEAD of UTC, so the
-- mis-bucketed orders are the EARLY ones: an order placed at 00:30 local is
-- 22:30 UTC on the day before, and it landed on the PREVIOUS day's bar. The
-- window is local midnight to 02:00, and to 03:00 while DST is in force. Late
-- evening is fine: 23:00 local is 21:00 UTC, the same UTC day.
--
-- Days are cut on the 'Africa/Cairo' calendar date instead. The IANA zone, not
-- a fixed +02, because Egypt reinstated DST in 2023 and the offset is +03 for
-- part of the year: a hardcoded offset would be an hour wrong every summer.
--
-- Returns one jsonb object rather than a set, so the whole screen is a single
-- round trip and the response is a fixed size (4 scalars + p_days chart points
-- + 5 best sellers) no matter how many orders exist.
-- ---------------------------------------------------------------------------
create or replace function public.admin_dashboard_summary(p_days integer default 30)
returns jsonb
language plpgsql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_zone constant text := 'Africa/Cairo';
  v_days integer := least(greatest(coalesce(p_days, 30), 1), 365);
  v_today date;
  v_from date;
  v_result jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin_dashboard_summary: not authorised'
      using errcode = 'P0001', hint = 'not_admin';
  end if;

  v_today := (now() at time zone v_zone)::date;
  v_from := v_today - (v_days - 1);

  with totals as (
    select
      coalesce(sum(o.total_amount) filter (where o.payment_status = 'paid'), 0) as revenue,
      count(*) as order_count,
      count(*) filter (where o.status in ('pending', 'confirmed')) as pending_count
    from public.orders o
  ),
  -- generate_series, not the orders themselves, so a day with no sales is a
  -- zero on a continuous axis rather than a missing point.
  days as (
    select generate_series(v_from, v_today, interval '1 day')::date as day
  ),
  paid_by_day as (
    select
      (o.created_at at time zone v_zone)::date as day,
      sum(o.total_amount) as revenue
    from public.orders o
    where o.payment_status = 'paid'
      -- Half-open on local midnight of the first day, so the index on
      -- (payment_status, created_at) can be used instead of casting every row.
      and o.created_at >= (v_from::timestamp at time zone v_zone)
    group by 1
  ),
  chart as (
    select coalesce(jsonb_agg(
      jsonb_build_object('date', to_char(d.day, 'YYYY-MM-DD'), 'revenue', coalesce(p.revenue, 0))
      order by d.day
    ), '[]'::jsonb) as series
    from days d
    left join paid_by_day p on p.day = d.day
  ),
  -- Units per product across every paid order's items array. The quantity is
  -- read only when it really is a JSON number: one malformed line in one old
  -- order must not take the whole dashboard down with a cast error.
  seller_units as (
    select
      coalesce(item ->> 'product_id', item ->> 'name') as product_key,
      max(item ->> 'name') as name,
      sum(case when jsonb_typeof(item -> 'quantity') = 'number'
               then (item ->> 'quantity')::numeric else 0 end) as units
    from public.orders o
    cross join lateral jsonb_array_elements(
      case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end
    ) as item
    where o.payment_status = 'paid'
      and coalesce(item ->> 'product_id', item ->> 'name') is not null
    group by 1
    order by units desc
    limit 5
  ),
  sellers as (
    select coalesce(jsonb_agg(
      jsonb_build_object('name', coalesce(s.name, s.product_key), 'units', s.units)
      order by s.units desc
    ), '[]'::jsonb) as series
    from seller_units s
  )
  select jsonb_build_object(
    'revenue', t.revenue,
    'orders', t.order_count,
    'pending', t.pending_count,
    'products', (select count(*) from public.products),
    'revenue_by_day', c.series,
    'best_sellers', s.series
  )
  into v_result
  from totals t, chart c, sellers s;

  return v_result;
end;
$$;

comment on function public.admin_dashboard_summary(integer) is
  'Every AdminDashboard figure in one round trip. Revenue days are Africa/Cairo calendar days, not UTC. Admin only.';

revoke execute on function public.admin_dashboard_summary(integer) from anon, public;
grant execute on function public.admin_dashboard_summary(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2. One page of orders, plus the counts that cannot come from a page.
--
-- The status pill counts and the result total have to span the whole table --
-- computing them from the loaded rows is exactly the bug this migration
-- exists to remove -- so they come back with the page rather than as six more
-- requests.
--
-- Why an RPC and not `.range()` against PostgREST: the admin searches by the
-- short order id shown in the table, which needs `id::text ilike`, and
-- PostgREST cannot express a cast in a filter. The per-status counts would
-- also be one request each.
--
-- p_sort/p_dir reach format() only through a whitelist (two column names, two
-- directions), never as caller text. The o.id tiebreak keeps paging stable:
-- without it two orders sharing a created_at can swap across a page boundary
-- and one of them is never shown.
-- ---------------------------------------------------------------------------
create or replace function public.admin_orders_page(
  p_status text default null,
  p_search text default null,
  p_sort text default 'date',
  p_dir text default 'desc',
  p_offset integer default 0,
  p_limit integer default 50
)
returns jsonb
language plpgsql
security definer
stable
set search_path to 'public', 'pg_temp'
as $$
declare
  v_col text;
  v_dir text;
  v_like text;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 500);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_rows jsonb;
  v_total bigint;
  v_counts jsonb;
begin
  if not public.is_admin() then
    raise exception 'admin_orders_page: not authorised'
      using errcode = 'P0001', hint = 'not_admin';
  end if;

  -- A search of '%' used to match every order; the wildcards are escaped so
  -- the box stays a plain substring search.
  if p_search is not null and btrim(p_search) <> '' then
    v_like := '%' || replace(replace(replace(btrim(p_search), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;

  v_col := case when p_sort = 'total' then 'total_amount' else 'created_at' end;
  v_dir := case when lower(coalesce(p_dir, 'desc')) = 'asc' then 'asc' else 'desc' end;

  execute format($q$
    select coalesce(jsonb_agg(to_jsonb(p) order by p.%1$I %2$s, p.id %2$s), '[]'::jsonb)
    from (
      select o.*
      from public.orders o
      where ($1 is null or o.status = $1)
        and ($2 is null
             or o.customer_name ilike $2
             or o.customer_email ilike $2
             or o.kashier_order_id ilike $2
             or o.id::text ilike $2)
      order by o.%1$I %2$s, o.id %2$s
      offset $3 limit $4
    ) p
  $q$, v_col, v_dir)
  into v_rows
  using p_status, v_like, v_offset, v_limit;

  select count(*)
  into v_total
  from public.orders o
  where (p_status is null or o.status = p_status)
    and (v_like is null
         or o.customer_name ilike v_like
         or o.customer_email ilike v_like
         or o.kashier_order_id ilike v_like
         or o.id::text ilike v_like);

  -- Deliberately NOT filtered by the search box: the pills say how many orders
  -- are in each state, which is what they said before pagination.
  select coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb)
  into v_counts
  from (select o.status, count(*) as n from public.orders o group by o.status) s;

  return jsonb_build_object('rows', v_rows, 'total', v_total, 'status_counts', v_counts);
end;
$$;

comment on function public.admin_orders_page(text, text, text, text, integer, integer) is
  'One page of orders for AdminOrders, with the whole-table filtered total and per-status counts. Admin only.';

revoke execute on function public.admin_orders_page(text, text, text, text, integer, integer) from anon, public;
grant execute on function public.admin_orders_page(text, text, text, text, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Counting without downloading.
--
-- AdminCoupons pulled every coupon_redemptions row in the store to tally them
-- in a loop, and AdminBundles did the same with bundle_items. Both were capped
-- at 1000 rows, so a busy coupon could read as unused on screen while the
-- checkout was already refusing it.
--
-- Views rather than functions: no parameters, nothing to gate, and PostgREST
-- can select them directly. security_invoker keeps them under the caller's own
-- RLS, so they expose nothing their base tables do not.
-- ---------------------------------------------------------------------------
create or replace view public.coupon_redemption_counts
with (security_invoker = true) as
select r.coupon_id, count(*)::bigint as redemption_count
from public.coupon_redemptions r
group by r.coupon_id;

comment on view public.coupon_redemption_counts is
  'One row per redeemed coupon. Sized by coupons, not redemptions, so the admin usage column stays correct past max_rows.';

create or replace view public.bundle_item_counts
with (security_invoker = true) as
select i.bundle_id, count(*)::bigint as item_count
from public.bundle_items i
group by i.bundle_id;

comment on view public.bundle_item_counts is
  'One row per non-empty bundle. Sized by bundles, not bundle items.';

-- ---------------------------------------------------------------------------
-- 4. Reorder in one statement.
--
-- Every arrow click in AdminBanners, the testimonials tab and the product
-- image gallery fired one UPDATE per row inside a Promise.all over a .map,
-- which is the N+1 write this project forbids, and none of the results were
-- checked while the UI had already drawn the new order. One call now rewrites
-- the whole list in a single statement and refuses to half-apply it, so a
-- reorder that did not land is reported instead of assumed.
--
-- p_table is matched against a fixed list before it reaches format(%I); no
-- other table can be reached through this function.
-- ---------------------------------------------------------------------------
create or replace function public.admin_reorder_positions(p_table text, p_ids uuid[])
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_updated integer;
begin
  if not public.is_admin() then
    raise exception 'admin_reorder_positions: not authorised'
      using errcode = 'P0001', hint = 'not_admin';
  end if;

  if p_table is null or p_table not in ('hero_banners', 'testimonials', 'product_images') then
    raise exception 'admin_reorder_positions: % is not reorderable', coalesce(p_table, '<null>')
      using errcode = 'P0001', hint = 'table_not_reorderable';
  end if;

  if p_ids is null or array_length(p_ids, 1) is null then
    return 0;
  end if;

  -- WITH ORDINALITY is the ordering: position becomes the index of the id in
  -- the array the client sent. Positions stay 0-based, matching the rows the
  -- storefront already orders by.
  execute format($q$
    update public.%I t
    set "position" = v.ord - 1
    from (select id, ord from unnest($1::uuid[]) with ordinality as u(id, ord)) v
    where t.id = v.id
  $q$, p_table)
  using p_ids;

  get diagnostics v_updated = row_count;

  -- Every id the caller sent must have matched a row. If one was deleted in
  -- another tab, the survivors have just been renumbered around the gap, which
  -- is a DIFFERENT order from the one on screen, and a non-zero row count would
  -- read as success at the call site. Raising rolls the whole statement back,
  -- so the list is either fully applied or untouched.
  if v_updated <> array_length(p_ids, 1) then
    raise exception 'admin_reorder_positions: % of % rows matched in %',
      v_updated, array_length(p_ids, 1), p_table
      using errcode = 'P0001', hint = 'reorder_incomplete';
  end if;

  return v_updated;
end;
$$;

comment on function public.admin_reorder_positions(text, uuid[]) is
  'Rewrites position 0..n-1 across hero_banners, testimonials or product_images in one statement. Raises (rolling the statement back) unless every id matched a row. Admin only.';

revoke execute on function public.admin_reorder_positions(text, uuid[]) from anon, public;
grant execute on function public.admin_reorder_positions(text, uuid[]) to authenticated;
