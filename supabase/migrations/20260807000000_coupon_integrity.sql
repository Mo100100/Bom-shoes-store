-- Coupon integrity: the database half of the coupon/pricing hardening (the
-- other half is supabase/functions/_shared/pricing.ts, which clamps the same
-- values defensively so a legacy row or a direct SQL edit can never reach the
-- money path).
--
-- Four additive, idempotent changes:
--   1. A percentage coupon can no longer hold a discount_value above 100. A
--      typo of 150 discounted 1.5x the subtotal, which sent a NEGATIVE amount
--      to Kashier and hard-broke checkout.
--   2. An automatic promotion can no longer carry a code. `coupons` has a
--      narrow public SELECT policy for auto-apply buy-x-get-y promotions (see
--      20260704009001_public_bxgy_promo_read.sql), so a code saved on one was
--      published to every visitor.
--   3. Coupon codes are normalised to upper case, so `save20` and `SAVE20`
--      are the same code rather than one working and one failing.
--   4. A grouped redemption count, so the promotion-eligibility loop in
--      pricing.ts stops issuing one COUNT per candidate coupon.

-- ---------------------------------------------------------------------------
-- 1. Percentage coupons: 0 <= discount_value <= 100
--
-- Existing out-of-range rows are clamped first (rather than deleted or
-- deactivated) so an admin's intent survives: 150 was always meant to be a
-- large discount, and 100 is the largest one that exists.
-- ---------------------------------------------------------------------------
update public.coupons
set discount_value = least(greatest(discount_value, 0), 100)
where discount_type = 'percentage'
  and (discount_value < 0 or discount_value > 100);

alter table public.coupons drop constraint if exists coupons_percentage_value_check;

alter table public.coupons
  add constraint coupons_percentage_value_check
  check (discount_type <> 'percentage' or (discount_value >= 0 and discount_value <= 100));

comment on column public.coupons.discount_value is
  'For discount_type = ''percentage'' this is a percentage and is constrained to 0..100 (an uncapped value produced a discount larger than the cart and a negative amount to charge). For ''fixed'' it is an EGP amount, capped at the subtotal at compute time. Ignored by ''free_shipping'' and ''buy_x_get_y'' (which uses get_discount_percent).';

-- ---------------------------------------------------------------------------
-- 2. requires_code = false implies code is null
--
-- Nulling a code on an auto promotion loses nothing: findCouponByCode only
-- ever matches requires_code = true, so such a code could never be redeemed
-- by typing it. It could only leak, which is what this stops.
-- ---------------------------------------------------------------------------
update public.coupons
set code = null
where requires_code = false and code is not null;

alter table public.coupons drop constraint if exists coupons_auto_promo_no_code_check;

alter table public.coupons
  add constraint coupons_auto_promo_no_code_check
  check (requires_code or code is null);

comment on column public.coupons.code is
  'The code a customer types. Stored upper case and looked up upper case, so entry is case-insensitive. Must be null when requires_code = false: an auto promotion needs no code, and active buy-x-get-y promotions are publicly readable, so a code stored on one would be published to every visitor.';

-- ---------------------------------------------------------------------------
-- 3. Upper-case codes
--
-- The case-insensitive `not exists` guard skips any code that collides with
-- another row once case is ignored (e.g. both 'save20' and 'Save20' exist).
-- Those two could never both work under a case-insensitive lookup anyway, so
-- they are left exactly as they are for an admin to resolve by hand rather
-- than picking a winner here.
--
-- The constraint is NOT VALID on purpose: it enforces upper case on every
-- future insert and update while tolerating any such legacy pair, so this
-- migration cannot fail on existing data.
-- ---------------------------------------------------------------------------
update public.coupons c
set code = upper(c.code)
where c.code is not null
  and c.code <> upper(c.code)
  and not exists (
    select 1 from public.coupons o
    where o.id <> c.id and upper(o.code) = upper(c.code)
  );

-- A skipped pair is not harmless: the lookup upper-cases every code a
-- customer types, so once this migration runs NEITHER member of the pair
-- resolves, where before it the exactly-typed one worked. Refusing to guess a
-- winner is right; doing it silently is not, so name them in the migration
-- output for the owner to fix by hand.
do $$
declare
  v_stranded text;
begin
  select string_agg(c.id::text || ' (' || c.code || ')', ', ' order by c.code)
  into v_stranded
  from public.coupons c
  where c.code is not null
    and c.code <> upper(c.code)
    and exists (
      select 1 from public.coupons o
      where o.id <> c.id and upper(o.code) = upper(c.code)
    );

  if v_stranded is not null then
    raise notice 'coupon_integrity: these coupon codes collide once case is ignored, so none of them were upper-cased and NONE of them can now be redeemed. Pick one of each pair, delete or rename the other, then upper-case the survivor: %', v_stranded;
  end if;
end $$;

alter table public.coupons drop constraint if exists coupons_code_upper_check;

alter table public.coupons
  add constraint coupons_code_upper_check
  check (code is null or code = upper(code))
  not valid;

-- ---------------------------------------------------------------------------
-- 4. Grouped redemption counts
--
-- pricing.ts used to call a per-coupon COUNT (two of them when the coupon had
-- both a usage_limit and a per_customer_limit) from inside its loop over
-- active auto-apply promotions, so the query count grew with the number of
-- promotions. This returns every candidate's counts in one round trip.
--
-- per_customer_limit is counted against orders.user_id, NOT the customer
-- email: email is optional at checkout and never verified, so counting it
-- meant the limit was skipped entirely by leaving the field blank, and could
-- be reset by inventing another address. orders.user_id comes from the
-- verified JWT and is the only identity here worth counting. Callers refuse a
-- per-customer-limited coupon outright when there is no signed-in user (see
-- checkUsageLimits in pricing.ts).
--
-- SECURITY DEFINER because coupon_redemptions is admin-only under RLS; only
-- the service role inside the edge functions may call it.
create or replace function public.coupon_redemption_counts(
  p_coupon_ids uuid[],
  p_user_id uuid default null
)
returns table (coupon_id uuid, total_count bigint, customer_count bigint)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select r.coupon_id,
         count(*) as total_count,
         count(*) filter (where p_user_id is not null and o.user_id = p_user_id) as customer_count
  from public.coupon_redemptions r
  join public.orders o on o.id = r.order_id
  where r.coupon_id = any(p_coupon_ids)
  group by r.coupon_id;
$$;

comment on function public.coupon_redemption_counts(uuid[], uuid) is
  'Total redemptions per coupon, plus how many of them belong to p_user_id, for every coupon in p_coupon_ids. One grouped count for the whole candidate set so coupon eligibility never issues a query per coupon. Service-role only.';

-- Same lockdown as every other SECURITY DEFINER function here (see
-- 20260704009002_harden_function_grants.sql).
revoke all on function public.coupon_redemption_counts(uuid[], uuid) from public;
revoke all on function public.coupon_redemption_counts(uuid[], uuid) from anon;
revoke all on function public.coupon_redemption_counts(uuid[], uuid) from authenticated;
grant execute on function public.coupon_redemption_counts(uuid[], uuid) to service_role;

-- Backs the join above: the count filters on coupon_id and reads each
-- redemption's order. The existing unique (coupon_id, order_id) index already
-- serves the coupon_id filter via its leading column, and orders.id is the
-- primary key, so no new index is needed.
