-- Anti-abuse controls for the public checkout surface.
--
-- Cash on Delivery is the only path that decrements REAL stock with no payment
-- (create-order -> place_cod_order). create-order runs with verify_jwt = true,
-- but the anon key shipped in the JS bundle is itself a valid JWT, so that gate
-- stops nobody: before this migration a script could place COD orders in a loop
-- and zero out the whole catalog, and nothing ever gave the stock back.
--
-- Three pieces here:
--   1. rate_limit_attempts + record_rate_limit_attempt(): a rolling-window
--      ledger the public edge functions consult before doing any real work.
--   2. release_order_stock(): idempotent "give the stock back" for one order.
--   3. release_expired_cod_orders(): the pg_cron job that applies (2) to COD
--      orders nobody ever started processing, so a reservation is never held
--      forever.

-- ---------------------------------------------------------------------------
-- 1. Rate-limit ledger
--
-- One row per attempt at a rate-limited endpoint. The IP is never stored raw:
-- the edge function sends an HMAC-SHA256 of it (see
-- supabase/functions/_shared/rate-limit.ts), which is enough to count repeat
-- callers and useless for identifying one. The phone IS stored as sent, and
-- only for COD orders, because orders.customer_phone already holds the same
-- value for the same order and an admin investigating abuse needs to be able
-- to match the two.
--
-- RLS is enabled with NO policies at all, matching stock_notify_requests'
-- read side: no client role can read or write this table. The only accessor is
-- the service-role key inside the edge functions.
-- ---------------------------------------------------------------------------
create table if not exists public.rate_limit_attempts (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null,
  ip_hash text not null,
  phone text,
  order_ref text,
  created_at timestamptz not null default now()
);

comment on table public.rate_limit_attempts is
  'Rolling-window ledger of attempts against the public edge functions (COD/online order creation, order-status, validate-coupon). Written and read only by record_rate_limit_attempt() via the service role; no client role has any policy. IPs are stored hashed, never raw.';

alter table public.rate_limit_attempts enable row level security;

-- Both counting queries are (endpoint, key, created_at >= window start), so
-- each gets its own covering index and neither ever scans the whole table.
create index if not exists rate_limit_attempts_ip_idx
  on public.rate_limit_attempts (endpoint, ip_hash, created_at desc);

create index if not exists rate_limit_attempts_phone_idx
  on public.rate_limit_attempts (endpoint, phone, created_at desc)
  where phone is not null;

-- Records one attempt and reports whether it is within the caller's limits.
-- Returns true = allowed, false = over the limit.
--
-- The attempt is recorded whether or not it was allowed, on purpose: an
-- attacker who keeps hammering keeps their own window full instead of getting
-- a fresh allowance the instant the oldest entry ages out.
--
-- The thresholds are NOT decided here. Every one of them lives beside the
-- endpoint it protects, in RATE_LIMITS in
-- supabase/functions/_shared/rate-limit.ts, so a new caller adds a rule there
-- rather than a new function here.
create or replace function public.record_rate_limit_attempt(
  p_endpoint text,
  p_ip_hash text,
  p_window_seconds integer,
  p_ip_limit integer,
  p_phone text default null,
  p_phone_limit integer default null,
  p_order_ref text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_since timestamptz := now() - make_interval(secs => greatest(coalesce(p_window_seconds, 0), 1));
  v_allowed boolean := true;
begin
  -- No key to count against (a proxy stripped the forwarded-for header, say).
  -- Fail open: never block a paying customer over a missing header.
  if p_endpoint is null or p_ip_hash is null then
    return true;
  end if;

  select count(*) < p_ip_limit into v_allowed
  from public.rate_limit_attempts
  where endpoint = p_endpoint and ip_hash = p_ip_hash and created_at >= v_since;

  if v_allowed and p_phone is not null and p_phone_limit is not null then
    select count(*) < p_phone_limit into v_allowed
    from public.rate_limit_attempts
    where endpoint = p_endpoint and phone = p_phone and created_at >= v_since;
  end if;

  insert into public.rate_limit_attempts (endpoint, ip_hash, phone, order_ref)
  values (p_endpoint, p_ip_hash, p_phone, p_order_ref);

  return v_allowed;
end;
$function$;

revoke execute on function public.record_rate_limit_attempt(text, text, integer, integer, text, integer, text)
  from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 2. Giving stock back
--
-- Two timestamps on orders, because "was stock ever taken for this order?" and
-- "has it already been given back?" are different questions and status alone
-- answers neither. A pending online order that is cancelled never reserved
-- anything, and returning stock for it would invent inventory out of nothing.
--
-- stock_reserved_at is stamped by place_cod_order() at the moment it commits
-- the decrement (see below). fulfill_order() does NOT stamp it yet, so paid
-- orders are currently out of scope for release_order_stock -- adding
-- `stock_reserved_at = now()` to fulfill_order's commit UPDATE is all that is
-- needed to bring them in.
-- ---------------------------------------------------------------------------
alter table public.orders add column if not exists stock_reserved_at timestamptz;
alter table public.orders add column if not exists stock_released_at timestamptz;

comment on column public.orders.stock_reserved_at is
  'When this order actually decremented stock. Set by place_cod_order(). NULL means no stock was ever taken, so there is nothing to give back.';
comment on column public.orders.stock_released_at is
  'When the reserved stock was given back. Set by release_order_stock(); its presence is what makes a release idempotent.';

-- Backfill COD orders placed before this migration: place_cod_order sets
-- status to 'confirmed' if and only if it committed the decrement, so a
-- confirmed cash order provably reserved its stock. created_at is the closest
-- available stamp (orders has no updated_at) and is within seconds of the
-- reservation, since COD orders are placed and confirmed in one request.
-- Idempotent: the `is null` guard makes a re-run a no-op.
update public.orders
set stock_reserved_at = created_at
where payment_method = 'cash'
  and status in ('confirmed', 'processing', 'shipped', 'delivered')
  and stock_reserved_at is null;

-- Returns the stock one order took back to product_variants / products.
--
-- Idempotent in both directions: it refuses to release an order that never
-- reserved (stock_reserved_at is null) and refuses to release one that has
-- already been released (stock_released_at is not null), so the same order can
-- never inflate inventory twice no matter how many times this is called or how
-- many callers race.
--
-- Rows are locked in the same canonical id order place_cod_order() uses
-- (variants by id, then products by id) so the two can never deadlock against
-- each other.
--
-- Service-role only. Cancellation and refund flows should call THIS rather
-- than writing their own decrement-reversal: pass the status the order should
-- end up in ('cancelled', 'refunded', ...).
create or replace function public.release_order_stock(p_order_id uuid, p_status text default 'cancelled')
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_items jsonb;
  v_reserved_at timestamptz;
  v_released_at timestamptz;
  v_item jsonb;
  v_variant_id uuid;
  v_product_id uuid;
  v_qty integer;
  v_stock integer;
begin
  select items, stock_reserved_at, stock_released_at
  into v_items, v_reserved_at, v_released_at
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    return false;
  end if;

  if v_reserved_at is null or v_released_at is not null then
    return false;
  end if;

  for v_variant_id in
    select distinct (i->>'variant_id')::uuid
    from jsonb_array_elements(coalesce(v_items, '[]'::jsonb)) i
    where i->>'variant_id' is not null
    order by 1
  loop
    select stock into v_stock from public.product_variants where id = v_variant_id for update;
  end loop;

  for v_product_id in
    select distinct (i->>'product_id')::uuid
    from jsonb_array_elements(coalesce(v_items, '[]'::jsonb)) i
    where i->>'variant_id' is null
    order by 1
  loop
    select stock into v_stock from public.products where id = v_product_id for update;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(v_items, '[]'::jsonb))
  loop
    v_qty := (v_item->>'quantity')::integer;
    if v_item->>'variant_id' is not null then
      update public.product_variants set stock = stock + v_qty where id = (v_item->>'variant_id')::uuid;
    else
      update public.products set stock = stock + v_qty where id = (v_item->>'product_id')::uuid;
    end if;
  end loop;

  update public.orders
  set stock_released_at = now(),
      status = coalesce(p_status, status)
  where id = p_order_id;

  return true;
end;
$function$;

revoke execute on function public.release_order_stock(uuid, text) from anon, authenticated, public;

-- place_cod_order, unchanged except for the stock_reserved_at stamp on its
-- commit UPDATE -- re-emitted in full because a function body cannot be
-- patched in place. The stamp goes in the SAME statement that confirms the
-- order, inside the same transaction as the decrement, so "stock was taken"
-- and "we recorded that stock was taken" can never disagree.
create or replace function public.place_cod_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_items jsonb;
  v_status text;
  v_payment_status text;
  v_coupon_id uuid;
  v_customer_email text;
  v_item jsonb;
  v_variant_id uuid;
  v_product_id uuid;
  v_qty integer;
  v_stock integer;
begin
  select items, status, payment_status, coupon_id, customer_email
  into v_items, v_status, v_payment_status, v_coupon_id, v_customer_email
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'place_cod_order: order % not found', p_order_id;
  end if;

  -- Idempotency: only reserve stock for a freshly-placed, still-pending order.
  -- A second call (retry) sees status <> 'pending' and no-ops.
  if v_status <> 'pending' or v_payment_status = 'paid' then
    return false;
  end if;

  -- Pass 1: verify. Lock every referenced row up front and bail before
  -- mutating anything if any single item can't be satisfied.
  for v_variant_id in
    select distinct (i->>'variant_id')::uuid
    from jsonb_array_elements(coalesce(v_items, '[]'::jsonb)) i
    where i->>'variant_id' is not null
    order by 1
  loop
    select stock into v_stock from public.product_variants where id = v_variant_id for update;
    if not found then
      raise exception 'place_cod_order: variant % not found', v_variant_id;
    end if;
  end loop;

  for v_product_id in
    select distinct (i->>'product_id')::uuid
    from jsonb_array_elements(coalesce(v_items, '[]'::jsonb)) i
    where i->>'variant_id' is null
    order by 1
  loop
    select stock into v_stock from public.products where id = v_product_id for update;
    if not found then
      raise exception 'place_cod_order: product % not found', v_product_id;
    end if;
  end loop;

  for v_item in select * from jsonb_array_elements(coalesce(v_items, '[]'::jsonb))
  loop
    v_qty := (v_item->>'quantity')::integer;
    if v_item->>'variant_id' is not null then
      select stock into v_stock from public.product_variants where id = (v_item->>'variant_id')::uuid;
    else
      select stock into v_stock from public.products where id = (v_item->>'product_id')::uuid;
    end if;
    if v_stock < v_qty then
      raise exception 'place_cod_order: insufficient stock for item % (have %, need %)',
        coalesce(v_item->>'variant_id', v_item->>'product_id'), v_stock, v_qty;
    end if;
  end loop;

  -- Pass 2: commit stock.
  for v_item in select * from jsonb_array_elements(coalesce(v_items, '[]'::jsonb))
  loop
    v_qty := (v_item->>'quantity')::integer;
    if v_item->>'variant_id' is not null then
      update public.product_variants set stock = stock - v_qty where id = (v_item->>'variant_id')::uuid;
    else
      update public.products set stock = stock - v_qty where id = (v_item->>'product_id')::uuid;
    end if;
  end loop;

  -- Confirmed, awaiting cash on delivery. payment_status stays 'pending'.
  -- stock_reserved_at is what lets release_order_stock() know there is
  -- something to give back if this order is never processed.
  update public.orders
  set status = 'confirmed',
      stock_reserved_at = now()
  where id = p_order_id;

  -- Record the coupon redemption now that the order is committed.
  if v_coupon_id is not null then
    insert into public.coupon_redemptions (coupon_id, order_id, customer_email)
    values (v_coupon_id, p_order_id, v_customer_email)
    on conflict (coupon_id, order_id) do nothing;
  end if;

  return true;
exception
  when others then
    raise warning 'place_cod_order failed for order %: %', p_order_id, sqlerrm;
    update public.orders
    set status = 'cancelled', payment_status = 'failed'
    where id = p_order_id;
    return false;
end;
$function$;

revoke execute on function public.place_cod_order(uuid) from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 3. Expiring abandoned COD reservations
--
-- A COD order lands at status 'confirmed' with payment_status 'pending' and
-- holds its stock until an admin marks the cash collected. If nobody ever
-- touches it, that stock is held forever -- which is exactly the state a
-- scripted attacker leaves the catalog in.
--
-- The signal for "abandoned" is status still being 'confirmed': the admin
-- order list moves a real order on to 'processing'/'shipped'/'delivered' as it
-- is handled, so an order still sitting at 'confirmed' has not been started.
-- An order already in transit is therefore never touched, however long the
-- courier takes to bring the cash back.
--
-- The default window is 72 hours: long enough to cover a Friday/Saturday
-- weekend plus a working day, so a genuine order is never cancelled just
-- because the store was closed, and short enough that a scripted attack frees
-- the catalog again within three days rather than never.
--
-- Bounded at 500 orders per run so one very bad night cannot produce a single
-- unbounded transaction holding locks across the whole catalog. The next run
-- (15 minutes later) picks up the remainder.
-- ---------------------------------------------------------------------------
create or replace function public.release_expired_cod_orders(p_older_than_hours integer default 72)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_order_id uuid;
  v_released integer := 0;
begin
  for v_order_id in
    select id
    from public.orders
    where payment_method = 'cash'
      and payment_status = 'pending'
      and status = 'confirmed'
      and stock_reserved_at is not null
      and stock_released_at is null
      and stock_reserved_at < now() - make_interval(hours => greatest(coalesce(p_older_than_hours, 72), 1))
    order by stock_reserved_at
    limit 500
  loop
    if public.release_order_stock(v_order_id, 'cancelled') then
      v_released := v_released + 1;
    end if;
  end loop;

  -- Housekeeping, piggy-backed here so there is only one scheduled job to
  -- reason about: nothing reads a rate-limit row older than the longest
  -- window (6 hours), so keep a day of them for abuse investigation and drop
  -- the rest. Without this the ledger grows forever.
  delete from public.rate_limit_attempts where created_at < now() - interval '24 hours';

  return v_released;
end;
$function$;

revoke execute on function public.release_expired_cod_orders(integer) from anon, authenticated, public;

-- pg_cron is already in use here (see
-- 20260704007001_stock_notify_requests_and_cron.sql, which schedules the
-- back-in-stock mailer), so this is wired straight to it. Unlike that job this
-- one is pure SQL: it needs no edge function, no pg_net call and no Vault
-- secret, so there is no manual post-deploy step -- it starts working the
-- moment the migration lands.
--
-- Unscheduled first so a re-run of this migration cannot end up with two
-- copies of the job. cron.unschedule raises if the job does not exist, hence
-- the guard on cron.job.
do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'release-expired-cod-orders') then
    perform cron.unschedule('release-expired-cod-orders');
  end if;
end;
$cron$;

select cron.schedule(
  'release-expired-cod-orders',
  '*/15 * * * *',
  $$select public.release_expired_cod_orders()$$
);
