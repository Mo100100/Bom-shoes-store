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
-- A BLOCKED attempt is deliberately NOT recorded. Recording it would make a
-- tripped window self-sustaining: on a carrier-grade NAT address, which is the
-- norm on Egyptian mobile networks, every subsequent real customer's rejected
-- attempt would push the window forward again and it would never drain. Only
-- allowed attempts count towards the limit, so the window always empties on
-- its own after windowSeconds of quiet.
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

  -- Serialize every caller sharing this (endpoint, ip) key for the rest of the
  -- transaction. Without it this is a check-then-insert race: under READ
  -- COMMITTED, concurrent transactions cannot see each other's uncommitted
  -- inserts, so N simultaneous requests all read the same count, all pass, and
  -- an attacker who fires requests in parallel rather than in sequence walks
  -- straight past the limit. Scripts parallelize by default, so this lock is
  -- what makes the limit real.
  --
  -- ponytail: one lock per (endpoint, ip) key, so unrelated callers never
  -- contend. Held only to the end of this transaction, which is two indexed
  -- counts and one insert. Known ceiling: the PHONE count is serialized only
  -- against callers sharing this IP, so a parallel attacker spread across many
  -- IPs can still race the per-phone limit. That attacker has already defeated
  -- the per-IP limit, which is the binding one, so the extra lock is not worth
  -- the contention. Take a second lock on the phone key if that ever changes.
  perform pg_advisory_xact_lock(hashtextextended(p_endpoint || p_ip_hash, 0));

  select count(*) < p_ip_limit into v_allowed
  from public.rate_limit_attempts
  where endpoint = p_endpoint and ip_hash = p_ip_hash and created_at >= v_since;

  if v_allowed and p_phone is not null and p_phone_limit is not null then
    select count(*) < p_phone_limit into v_allowed
    from public.rate_limit_attempts
    where endpoint = p_endpoint and phone = p_phone and created_at >= v_since;
  end if;

  if v_allowed then
    insert into public.rate_limit_attempts (endpoint, ip_hash, phone, order_ref)
    values (p_endpoint, p_ip_hash, p_phone, p_order_ref);
  end if;

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

-- The moment this migration landed, captured at execution time rather than
-- written as a literal, so it is the real deploy instant however long after
-- authoring the push happens.
--
-- The automatic expiry job below refuses to touch any order created at or
-- before this instant. That is a hard safety boundary, NOT an optimisation:
-- the owner's existing COD orders were placed under a system that had no
-- expiry, advancing an order's status is an entirely optional admin dropdown
-- (AdminOrders.tsx updateStatus), and a delivered order whose status was never
-- advanced still reads 'confirmed'. Without this gate, every historical COD
-- order the owner delivered without touching that dropdown would be mass
-- cancelled on the job's first run, inventing phantom stock for goods already
-- sold. Pre-existing orders are the owner's business and this job must never
-- touch them.
--
-- Single row, enforced by the `check (id)` on a boolean primary key. The
-- `on conflict do nothing` means re-running this migration keeps the ORIGINAL
-- stamp rather than moving the boundary forward.
create table if not exists public.cod_expiry_epoch (
  id boolean primary key default true check (id),
  effective_from timestamptz not null default now()
);

comment on table public.cod_expiry_epoch is
  'Single row holding the instant the COD expiry job was introduced. release_expired_cod_orders() never considers an order created at or before it, so orders placed before this feature existed are never auto-cancelled.';

alter table public.cod_expiry_epoch enable row level security;

insert into public.cod_expiry_epoch (id) values (true) on conflict (id) do nothing;

-- Backfill COD orders placed before this migration: place_cod_order sets
-- status to 'confirmed' if and only if it committed the decrement, so a
-- confirmed cash order provably reserved its stock. created_at is the closest
-- available stamp (orders has no updated_at) and is within seconds of the
-- reservation, since COD orders are placed and confirmed in one request.
--
-- This exists ONLY so an admin-initiated cancellation or refund (Task 8) can
-- release a historical order on purpose. It does NOT make those orders
-- eligible for the automatic job, which is gated on cod_expiry_epoch above and
-- does not rely on this backfill for its bound.
--
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
-- payment_status is driven to a TERMINAL value alongside the status, so a
-- released order can never be marked paid afterwards. Leaving it at 'pending'
-- would keep the admin order list's "mark cash collected" button live on an
-- order whose goods have been put back on the shelf.
--
-- Every release writes an explicit activity_logs entry (action
-- 'STOCK_RELEASE') recording the order reference, the units returned and
-- whether it was automatic. Inventory must never move silently. That insert is
-- deliberately NOT wrapped in its own exception block, unlike log_activity():
-- if the audit entry cannot be written, the release should fail and be
-- retried, not proceed unlogged.
--
-- Service-role only. Cancellation and refund flows should call THIS rather
-- than writing their own decrement-reversal: pass the status the order should
-- end up in ('cancelled', 'refunded', ...) and the matching payment_status.
create or replace function public.release_order_stock(
  p_order_id uuid,
  p_status text default 'cancelled',
  p_payment_status text default 'failed',
  p_automatic boolean default false
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_items jsonb;
  v_reserved_at timestamptz;
  v_released_at timestamptz;
  v_order_ref text;
  v_units integer := 0;
  v_item jsonb;
  v_variant_id uuid;
  v_product_id uuid;
  v_qty integer;
  v_stock integer;
begin
  select items, stock_reserved_at, stock_released_at, kashier_order_id
  into v_items, v_reserved_at, v_released_at, v_order_ref
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
    v_units := v_units + v_qty;
    if v_item->>'variant_id' is not null then
      update public.product_variants set stock = stock + v_qty where id = (v_item->>'variant_id')::uuid;
    else
      update public.products set stock = stock + v_qty where id = (v_item->>'product_id')::uuid;
    end if;
  end loop;

  update public.orders
  set stock_released_at = now(),
      status = coalesce(p_status, status),
      payment_status = coalesce(p_payment_status, payment_status)
  where id = p_order_id;

  -- Same shape as log_activity(): (action, entity_type, entity_id, actor_id,
  -- details). actor_id is null because there is no client session behind a
  -- service-role or cron write, which is exactly what `automatic` records.
  insert into public.activity_logs (action, entity_type, entity_id, actor_id, details)
  values (
    'STOCK_RELEASE',
    'orders',
    p_order_id,
    auth.uid(),
    jsonb_build_object(
      'order_ref', v_order_ref,
      'units_returned', v_units,
      'automatic', p_automatic,
      'status', p_status,
      'payment_status', p_payment_status
    )
  );

  return true;
end;
$function$;

revoke execute on function public.release_order_stock(uuid, text, text, boolean) from anon, authenticated, public;

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
-- The signal for "abandoned" is status still being 'confirmed'. That signal is
-- WEAKER than it looks and the window is sized accordingly: advancing an order
-- to 'processing'/'shipped'/'delivered' is an optional dropdown in the admin
-- order list (AdminOrders.tsx updateStatus) with no prompt, no default advance
-- and no reminder, so a real order that the owner shipped without touching the
-- dashboard also sits at 'confirmed'.
--
-- The default window is therefore 14 days, not a few days. This job exists to
-- defeat a bot flood, not to tidy up slow deliveries. A bot's reservations can
-- sit for two weeks without meaningful harm, whereas a genuine COD order that
-- is shipped, delayed over a weekend and paid the following week must never be
-- cancelled underneath the courier. If that happened the store would put
-- already-sold shoes back on the shelf and oversell them.
--
-- Two further guards on the same worry:
--   - Nothing created at or before cod_expiry_epoch.effective_from is ever
--     considered, so the owner's pre-existing orders are untouchable.
--   - Every release writes an activity_logs entry, so no inventory moves
--     silently.
--
-- Bounded at 500 orders per run so one very bad night cannot produce a single
-- unbounded transaction holding locks across the whole catalog. The next run
-- picks up the remainder.
-- ---------------------------------------------------------------------------
create or replace function public.release_expired_cod_orders(p_older_than_hours integer default 336)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
as $function$
declare
  v_order_id uuid;
  v_released integer := 0;
  v_epoch timestamptz;
begin
  select effective_from into v_epoch from public.cod_expiry_epoch limit 1;
  if v_epoch is null then
    raise warning 'release_expired_cod_orders: cod_expiry_epoch is empty, refusing to run';
    return 0;
  end if;

  for v_order_id in
    select id
    from public.orders
    where payment_method = 'cash'
      and payment_status = 'pending'
      and status = 'confirmed'
      and created_at > v_epoch
      and stock_reserved_at is not null
      and stock_released_at is null
      and stock_reserved_at < now() - make_interval(hours => greatest(coalesce(p_older_than_hours, 336), 1))
    order by stock_reserved_at
    limit 500
  loop
    -- Per-order subtransaction. Without it, one order with a malformed items
    -- entry raises on the quantity cast, rolls the whole run back, and gets
    -- picked first again next time because the loop is ordered oldest-first --
    -- so the job would fail forever and never release anything. Skip the bad
    -- row, warn, carry on.
    begin
      if public.release_order_stock(v_order_id, 'cancelled', 'failed', true) then
        v_released := v_released + 1;
      end if;
    exception when others then
      raise warning 'release_expired_cod_orders: skipping order %: %', v_order_id, sqlerrm;
    end;
  end loop;

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
-- TWO jobs, deliberately not one. The ledger cleanup used to be piggy-backed
-- inside release_expired_cod_orders, which meant a single poison order would
-- have taken the cleanup down with it and let rate_limit_attempts grow
-- unbounded. Separate entries fail independently.
--
-- Unscheduled first so a re-run of this migration cannot end up with two
-- copies of a job. cron.unschedule raises if the job does not exist, hence the
-- guard on cron.job.
do $cron$
declare
  v_job text;
begin
  foreach v_job in array array['release-expired-cod-orders', 'purge-rate-limit-attempts']
  loop
    if exists (select 1 from cron.job where jobname = v_job) then
      perform cron.unschedule(v_job);
    end if;
  end loop;
end;
$cron$;

-- Hourly, not every 15 minutes: the window is 14 days, so the exact minute a
-- reservation is released is irrelevant and there is no reason to scan for it
-- four times an hour.
select cron.schedule(
  'release-expired-cod-orders',
  '7 * * * *',
  $$select public.release_expired_cod_orders()$$
);

-- Nothing reads a rate-limit row older than the longest window (6 hours), so
-- keep a day of them for abuse investigation and drop the rest. Without this
-- the ledger grows forever. Inline SQL: a one-statement job does not need a
-- function wrapped around it.
select cron.schedule(
  'purge-rate-limit-attempts',
  '23 * * * *',
  $$delete from public.rate_limit_attempts where created_at < now() - interval '24 hours'$$
);
