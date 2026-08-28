-- Order lifecycle and stock accounting.
--
-- Everything that moves an order between states now agrees on one question:
-- does this order currently hold stock? orders.stock_reserved_at (added in
-- 20260806000000) is the single answer, and every writer either stamps it,
-- reads it, or clears it via release_order_stock().
--
-- Five holes closed here:
--   1. Cancellations never gave stock back. The admin order list wrote
--      `status` with a plain UPDATE, so a cancelled COD order kept its stock
--      deducted forever. Admin status changes now go through
--      admin_update_order_status(), which calls the existing
--      release_order_stock() -- there is deliberately no second "give stock
--      back" implementation in this file.
--   2. fulfill_order() guarded only on payment_status = 'paid', so a COD
--      order (status 'confirmed', payment 'pending', stock ALREADY taken by
--      place_cod_order) would have its units decremented a second time by any
--      path reaching it. It now refuses whenever stock_reserved_at is set, and
--      stamps that column itself so a paid online order can be released too.
--   3. Admin status changes bypassed stock accounting entirely: moving a
--      pending online order to 'processing' marked it as being fulfilled
--      without ever decrementing anything. Those transitions are now refused,
--      and a trigger stops the client from writing status/payment_status
--      directly at all.
--   4. Orders orphaned at 'pending' (create-order threw before the customer
--      ever saw a payment page, or the customer walked away from Kashier) are
--      cancelled by an hourly job. They never held stock, so this is pure
--      bookkeeping.
--   5. Legacy products.stock had no `>= 0` check, unlike product_variants, so
--      fulfill_order's no-variant fallback path could drive it negative.
--
-- Plus one guard on the other side of the same problem: a variant row that an
-- order still needs cannot be deleted out from under it.

-- ---------------------------------------------------------------------------
-- 0. Drop the stale two-argument release_order_stock.
--
-- 20260806000000 widened the signature from (uuid, text) to
-- (uuid, text, text, boolean) with `create or replace function`, which creates
-- a SECOND function rather than replacing the old one whenever a two-argument
-- version already exists. The old overload would keep its original EXECUTE
-- grants -- a publicly callable, stock-mutating function. That migration has
-- not been deployed anywhere yet, so this is defensive, but it costs one line.
-- ---------------------------------------------------------------------------
drop function if exists public.release_order_stock(uuid, text);

-- ---------------------------------------------------------------------------
-- 1. products.stock can never go negative.
--
-- product_variants.stock has had `check (stock >= 0)` since
-- 20260704002000; the legacy column it replaced never got one, and
-- fulfill_order still falls back to it for pre-variant order snapshots. Clean
-- whatever is already negative first (0 is the only truthful floor -- a
-- negative count is not a real quantity), then add the constraint.
--
-- Idempotent: the update matches nothing on a re-run and the constraint is
-- dropped-if-exists before it is added.
-- ---------------------------------------------------------------------------
update public.products set stock = 0 where stock < 0;

alter table public.products drop constraint if exists products_stock_non_negative;
alter table public.products add constraint products_stock_non_negative check (stock >= 0);

-- ---------------------------------------------------------------------------
-- 2. Backfill stock_reserved_at for orders that were paid before this landed.
--
-- fulfill_order() provably decremented stock for every order it marked paid,
-- so a paid order held stock even though nothing recorded that fact until now.
-- created_at is the closest available stamp (orders has no updated_at) and is
-- within minutes of the payment.
--
-- Without this, cancelling or refunding a historical paid order would silently
-- return nothing, because release_order_stock() refuses to release an order
-- that never recorded a reservation. Already-cancelled orders are left alone:
-- their goods were never given back and re-opening that decision is the
-- owner's call, not a migration's.
--
-- Idempotent: the `is null` guard makes a re-run a no-op.
-- ---------------------------------------------------------------------------
update public.orders
set stock_reserved_at = created_at
where payment_status = 'paid'
  and status <> 'cancelled'
  and stock_reserved_at is null
  and stock_released_at is null;

-- ---------------------------------------------------------------------------
-- 3. fulfill_order(): never decrement stock twice, and record that it took it.
--
-- Re-emitted in full (a function body cannot be patched in place) from
-- 20260704003001, with exactly two changes:
--
--   - A stock_reserved_at guard. The payment_status = 'paid' guard alone is
--     blind to a Cash on Delivery order, which sits at status 'confirmed',
--     payment_status 'pending' with its stock ALREADY committed by
--     place_cod_order(). place_cod_order has the symmetric guard (it refuses
--     any order that is not still 'pending'); this is the missing half. It
--     deliberately does NOT try to also mark such an order paid: a COD order
--     reaching the card-payment webhook is not a state this store can produce,
--     so the safe move is to change nothing and say so loudly.
--   - stock_reserved_at is stamped in the same UPDATE that marks the order
--     paid, inside the same transaction as the decrement, so "stock was taken"
--     and "we recorded that stock was taken" can never disagree. This is what
--     lets release_order_stock() give a refunded card order's stock back.
-- ---------------------------------------------------------------------------
-- `set app.order_write` is what lets this function's own UPDATE past
-- enforce_order_state_writer (section 4). It is part of the definition rather
-- than an ALTER FUNCTION so that anyone re-emitting this body carries it
-- across; dropping it silently breaks every payment.
create or replace function public.fulfill_order(p_order_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
set app.order_write = 'on'
as $function$
declare
  v_items jsonb;
  v_item jsonb;
  v_payment_status text;
  v_reserved_at timestamptz;
  v_coupon_id uuid;
  v_customer_email text;
  v_variant_id uuid;
  v_product_id uuid;
  v_qty integer;
  v_stock integer;
begin
  select items, payment_status, stock_reserved_at, coupon_id, customer_email
  into v_items, v_payment_status, v_reserved_at, v_coupon_id, v_customer_email
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'fulfill_order: order % not found', p_order_id;
  end if;

  -- Idempotency guard: the order row itself is the source of truth, not the
  -- caller's transactionId ledger.
  if v_payment_status = 'paid' then
    return false;
  end if;

  -- The other half of that guard: this order's units are already off the
  -- shelf, so decrementing them again would sell inventory nobody has.
  if v_reserved_at is not null then
    raise warning 'fulfill_order: order % already reserved stock at %, refusing to decrement it twice',
      p_order_id, v_reserved_at;
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
    select stock into v_stock
    from public.product_variants
    where id = v_variant_id
    for update;

    if not found then
      raise exception 'fulfill_order: variant % not found', v_variant_id;
    end if;
  end loop;

  for v_product_id in
    select distinct (i->>'product_id')::uuid
    from jsonb_array_elements(coalesce(v_items, '[]'::jsonb)) i
    where i->>'variant_id' is null
    order by 1
  loop
    select stock into v_stock
    from public.products
    where id = v_product_id
    for update;

    if not found then
      raise exception 'fulfill_order: product % not found', v_product_id;
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
      raise exception 'fulfill_order: insufficient stock for item % (have %, need %)',
        coalesce(v_item->>'variant_id', v_item->>'product_id'), v_stock, v_qty;
    end if;
  end loop;

  -- Pass 2: commit. Every item passed the check above, so it's safe to
  -- decrement all of them and mark the order paid.
  for v_item in select * from jsonb_array_elements(coalesce(v_items, '[]'::jsonb))
  loop
    v_qty := (v_item->>'quantity')::integer;

    if v_item->>'variant_id' is not null then
      update public.product_variants
      set stock = stock - v_qty
      where id = (v_item->>'variant_id')::uuid;
    else
      update public.products
      set stock = stock - v_qty
      where id = (v_item->>'product_id')::uuid;
    end if;
  end loop;

  update public.orders
  set payment_status = 'paid',
      status = 'processing',
      stock_reserved_at = now()
  where id = p_order_id;

  -- Record the redemption now that stock is committed and the order is paid.
  -- ON CONFLICT DO NOTHING keeps a redelivered webhook from ever
  -- double-counting the same order against the coupon's usage totals.
  if v_coupon_id is not null then
    insert into public.coupon_redemptions (coupon_id, order_id, customer_email)
    values (v_coupon_id, p_order_id, v_customer_email)
    on conflict (coupon_id, order_id) do nothing;
  end if;

  return true;
exception
  when others then
    -- The EXCEPTION clause rolls back everything done in this block (the
    -- stock decrements, the redemption insert, and locks above), but code
    -- below still runs in the live transaction -- so this update is the only
    -- effect that survives, recording the failure without any partial stock
    -- changes.
    raise warning 'fulfill_order failed for order %: %', p_order_id, sqlerrm;

    update public.orders
    set payment_status = 'failed'
    where id = p_order_id;

    return false;
end;
$function$;

comment on function public.fulfill_order(uuid) is
  'Atomically checks stock and decrements it (in product_variants, keyed by each order item''s variant_id; falling back to legacy products.stock by product_id for pre-deploy order snapshots with no variant_id) for every item on an order, marks it paid, stamps stock_reserved_at and records a coupon_redemptions row if the order has a coupon_id. Refuses any order that is already paid or that already holds a stock reservation (a Cash on Delivery order). Only ever called after Kashier confirms successful payment. Rolls back and marks the order failed if any item is out of stock or has no resolvable variant/product.';

revoke all on function public.fulfill_order(uuid) from public;
revoke execute on function public.fulfill_order(uuid) from anon, authenticated;
grant execute on function public.fulfill_order(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. The client can no longer write order state directly.
--
-- "Admins can update orders" (base schema) let the admin order list PATCH
-- /rest/v1/orders with any status it liked, which is how a pending online
-- order could be moved to 'processing' with its stock never decremented, and
-- how a cancellation could be recorded without giving the goods back.
--
-- The policy stays (it is what admin_update_order_status's own reads and this
-- table's other columns rely on); this trigger takes the two state columns out
-- of the client's reach instead.
--
-- What the trigger trusts is a TRANSACTION-LOCAL FLAG, not a role. Every
-- trusted database function carries `set app.order_write = 'on'` in its own
-- definition (see the ALTER FUNCTION block below for the ones defined in
-- earlier migrations), which Postgres applies for the duration of that call
-- and reverts on exit, so it can never leak to the caller or across a pooled
-- connection. A client cannot set it: PostgREST only ever sets the request.*
-- GUCs from the JWT and headers, never an arbitrary one.
--
-- Role identity is NOT used to infer trust. An earlier draft allowed anything
-- that was a member of service_role, on the assumption that the role owning
-- the SECURITY DEFINER functions is a superuser and therefore a member of
-- every role. That assumption is FALSE on Supabase cloud, where `postgres` is
-- not a superuser, and if it does not hold, every stock-moving function in the
-- schema loses its write at once: a total checkout outage. The one role name
-- still accepted is the literal 'service_role', because the edge functions
-- write orders through PostgREST (kashier-webhook marking a payment failed,
-- create-order closing an order whose payment session could not be built) and
-- cannot set a transaction-local GUC from there. That is a string comparison
-- against the role PostgREST switches to, not an inference from a grant.
--
-- Deliberately NOT a full state machine: the state machine lives in
-- admin_update_order_status(), where it can also move stock. Duplicating it
-- here would mean two copies to keep in agreement.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_order_state_writer()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  -- An ALLOWLIST: the write is refused unless it comes from inside a function
  -- that declares app.order_write, or from the service role. Naming the client
  -- roles to deny instead would silently stop covering any new
  -- PostgREST-reachable role Supabase or a later migration adds; this fails
  -- closed for every path nobody has thought of yet.
  if (new.status is distinct from old.status
      or new.payment_status is distinct from old.payment_status)
     and current_setting('app.order_write', true) is distinct from 'on'
     and current_user <> 'service_role' then
    raise exception 'order state must be changed through admin_update_order_status()'
      using errcode = 'P0001', hint = 'order_direct_write';
  end if;
  return new;
end;
$function$;

comment on function public.enforce_order_state_writer() is
  'BEFORE UPDATE trigger on orders: refuses a status/payment_status change made directly by a client role, so every state change goes through admin_update_order_status() (or the service-role paths) and stock accounting cannot be bypassed.';

-- Deliberately NOT security definer: it has to see the role actually running
-- the statement. It reads nothing but NEW and OLD, so it needs no privileges
-- of its own. Triggers fire regardless of EXECUTE grants, so closing the RPC
-- surface costs nothing (same treatment as the trigger functions in
-- 20260704009002).
revoke execute on function public.enforce_order_state_writer() from public, anon, authenticated;

drop trigger if exists enforce_order_state_writer on public.orders;
create trigger enforce_order_state_writer
  before update on public.orders
  for each row execute function public.enforce_order_state_writer();

-- The trusted writers defined in earlier migrations get the same flag. ALTER
-- FUNCTION rather than a re-emitted body: their logic is not changing here and
-- two copies of place_cod_order in this repo would be worse than one line
-- each. Postgres applies the setting for the duration of the call and reverts
-- it on exit, exactly as it does for search_path.
--
-- If a LATER migration re-emits one of these bodies, it must carry
-- `set app.order_write = 'on'` with it. The assertion at the end of this file
-- is the check for that: it fails the deploy rather than letting the store
-- discover it at the checkout.
alter function public.place_cod_order(uuid) set app.order_write = 'on';
alter function public.release_order_stock(uuid, text, text, boolean) set app.order_write = 'on';
alter function public.release_expired_cod_orders(integer) set app.order_write = 'on';

-- ---------------------------------------------------------------------------
-- 5. The one way an admin changes an order's state.
--
-- The state machine, in full. `active` below means one of confirmed,
-- processing, shipped, delivered.
--
--   active   -> active     allowed, in BOTH directions. Advancing an order is
--                          the owner's daily workflow and correcting a misclick
--                          is part of it; none of these moves touch stock.
--   anything -> cancelled  allowed. This is the only transition that moves
--                          stock: whatever the order reserved is given back,
--                          exactly once, by release_order_stock().
--   pending  -> active     REFUSED unless the order actually holds stock
--                          (paid, or stock_reserved_at set). A pending order
--                          is an online order whose payment never landed: it
--                          reserved nothing, so marking it processing/shipped
--                          would ship goods the inventory still counts as
--                          available. In practice this refuses every pending
--                          order, which is the point.
--   cancelled -> anything  REFUSED. Cancelling put the goods back on the shelf
--                          and they may already be sold to someone else, so a
--                          cancellation is terminal. Re-place the order.
--   anything -> pending    REFUSED. 'pending' means "created, nothing decided
--                          yet" and only create-order can produce it.
--
-- payment_status is separately settable to 'paid' and to nothing else, and
-- only on an order still awaiting payment that has not been cancelled or
-- released. Two shapes:
--   cash order            -- the goods were reserved at placement, so this is
--                            just the "cash collected" button.
--   pending online order  -- the payment landed but the webhook never did.
--                            This one goes through fulfill_order(), so the
--                            stock is actually taken, and it writes an
--                            ORDER_FULFILLED_BY_ADMIN activity_logs entry.
--                            Without it the owner's only answer to a dropped
--                            webhook would be to cancel an order the customer
--                            has already paid for.
-- No admin action ever writes 'refunded' -- only a real refund reported by
-- Kashier does.
--
-- Cancelling a PAID order leaves payment_status alone (release_order_stock
-- treats a null p_payment_status as "keep it"). The money really was taken;
-- writing 'refunded' before anyone has refunded anything would hide a debt the
-- owner still owes the customer.
--
-- SECURITY DEFINER and callable by `authenticated`, unlike the service-role
-- functions in this schema: the admin order list calls it from the browser.
-- It is gated internally by is_admin(), the same pattern the admin RLS
-- policies use, and anon is revoked outright.
-- ---------------------------------------------------------------------------
create or replace function public.admin_update_order_status(
  p_order_id uuid,
  p_status text default null,
  p_payment_status text default null
)
returns boolean
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
-- See fulfill_order above: this is what gets its writes past
-- enforce_order_state_writer, and it must survive any re-emission.
set app.order_write = 'on'
as $function$
declare
  v_status text;
  v_payment_status text;
  v_payment_method text;
  v_reserved_at timestamptz;
  v_released_at timestamptz;
  v_changed boolean := false;
begin
  if not public.is_admin() then
    raise exception 'admin_update_order_status: not authorised'
      using errcode = 'P0001', hint = 'not_admin';
  end if;

  select status, payment_status, payment_method, stock_reserved_at, stock_released_at
  into v_status, v_payment_status, v_payment_method, v_reserved_at, v_released_at
  from public.orders
  where id = p_order_id
  for update;

  if not found then
    raise exception 'admin_update_order_status: order % not found', p_order_id
      using errcode = 'P0001', hint = 'order_not_found';
  end if;

  -- Recording that the money arrived. 'paid' is the only value an admin may
  -- ever write, and only on an order that is still awaiting payment and has
  -- not been cancelled or released: a released order's goods are back on the
  -- shelf and must never read as paid.
  if p_payment_status is not null and p_payment_status is distinct from v_payment_status then
    if p_payment_status <> 'paid'
       or v_payment_status <> 'pending'
       or v_status = 'cancelled'
       or v_released_at is not null then
      raise exception 'admin_update_order_status: cannot set payment_status % on order % (currently %, method %)',
        p_payment_status, p_order_id, v_payment_status, v_payment_method
        using errcode = 'P0001', hint = 'payment_not_markable';
    end if;

    if v_payment_method = 'cash' then
      -- Cash on delivery: the stock was reserved at placement, so the money
      -- arriving changes nothing but the payment status.
      update public.orders set payment_status = 'paid' where id = p_order_id;

    elsif v_status = 'pending' and v_reserved_at is null then
      -- An online order whose webhook never arrived. Kashier has the money,
      -- the order holds no stock, and without this the owner's only options
      -- would be to cancel a paid order or to run SQL by hand.
      --
      -- This is the ONLY admin path that takes stock, and it takes it the same
      -- way the webhook does: fulfill_order() locks every referenced row,
      -- refuses if any line cannot be satisfied, decrements, marks the order
      -- paid and stamps stock_reserved_at. Re-raising on a false return rolls
      -- back its own "payment failed" marking with it, so an order that could
      -- not be fulfilled today is left exactly as it was and can be retried
      -- once the shelf is restocked.
      if not public.fulfill_order(p_order_id) then
        raise exception 'admin_update_order_status: could not fulfil order %', p_order_id
          using errcode = 'P0001', hint = 'fulfill_failed';
      end if;

      -- Stock moving on an admin's say-so rather than a verified payment is
      -- exactly the kind of thing that must never be silent.
      insert into public.activity_logs (action, entity_type, entity_id, actor_id, details)
      values (
        'ORDER_FULFILLED_BY_ADMIN',
        'orders',
        p_order_id,
        auth.uid(),
        jsonb_build_object('reason', 'payment confirmed by admin, webhook never arrived')
      );

      -- fulfill_order moved the order on as well as marking it paid.
      v_status := 'processing';

    else
      raise exception 'admin_update_order_status: order % cannot be marked paid from status %', p_order_id, v_status
        using errcode = 'P0001', hint = 'payment_not_markable';
    end if;

    -- Keep the local copy honest: a caller passing both arguments at once must
    -- not have the status branch below act on the payment status this call
    -- just replaced.
    v_payment_status := 'paid';
    v_changed := true;
  end if;

  if p_status is null or p_status = v_status then
    return v_changed;
  end if;

  if p_status not in ('confirmed', 'processing', 'shipped', 'delivered', 'cancelled') then
    raise exception 'admin_update_order_status: % is not a settable order status', p_status
      using errcode = 'P0001', hint = 'status_not_settable';
  end if;

  if v_status = 'cancelled' then
    raise exception 'admin_update_order_status: order % is cancelled and cannot be reopened', p_order_id
      using errcode = 'P0001', hint = 'order_cancelled';
  end if;

  if p_status = 'cancelled' then
    -- The single "give the stock back" implementation, reused rather than
    -- repeated. It is idempotent in both directions: an order that reserved
    -- nothing (a pending online order) and an order already released both
    -- return false, and the plain UPDATE below then just records the
    -- cancellation.
    if not public.release_order_stock(
      p_order_id,
      'cancelled',
      case when v_payment_status = 'paid' then null else 'failed' end,
      false
    ) then
      update public.orders
      set status = 'cancelled',
          payment_status = case when payment_status = 'pending' then 'failed' else payment_status end
      where id = p_order_id;
    end if;
    return true;
  end if;

  -- Everything left is a move into the active set. Only an order that holds
  -- stock may be advanced. If the money really did arrive, marking it paid is
  -- the way in: that path takes the stock first (see above). This refusal
  -- says only what the database can actually know, which is that no payment
  -- and no reservation is recorded -- never that the customer did not pay.
  if v_status = 'pending' and v_payment_status <> 'paid' and v_reserved_at is null then
    raise exception 'admin_update_order_status: order % has no payment or reservation recorded and cannot be advanced', p_order_id
      using errcode = 'P0001', hint = 'order_never_reserved';
  end if;

  update public.orders set status = p_status where id = p_order_id;
  return true;
end;
$function$;

comment on function public.admin_update_order_status(uuid, text, text) is
  'The only way an admin changes an order''s status or records that it was paid. Enforces the order state machine (cancellations are terminal, an order holding no stock cannot be advanced) and routes every cancellation through release_order_stock() and every admin fulfilment of a pending online order through fulfill_order(), so stock moves exactly once and never silently. Admin-gated by is_admin().';

revoke execute on function public.admin_update_order_status(uuid, text, text) from anon, public;
grant execute on function public.admin_update_order_status(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 6. A variant an order still needs cannot be deleted.
--
-- The admin product editor preserves variant ids on save (src/lib/variantDiff.ts),
-- but an admin can still remove a variant row outright. fulfill_order() raises
-- 'variant % not found' when the id is gone, so: a customer pays, the owner
-- deletes that size while the payment is in flight, the webhook lands, and the
-- PAID order dies with its stock never decremented.
--
-- The guard is deliberately NARROW -- only orders that could still be
-- fulfilled, i.e. still pending with no payment recorded. Everything else is
-- safe to delete over:
--   - A paid or COD order has already decremented its stock; fulfill_order
--     will never run for it again.
--   - release_order_stock() adds stock back with a plain UPDATE that matches
--     no rows when the variant is gone, so a later cancellation degrades to
--     "no stock returned for a size that no longer exists", not an error.
-- Blocking on those would mean a size that ever sold could never be removed
-- from the catalog, which is not a trade worth making for a shoe shop.
--
-- The window this refuses in is therefore the few minutes a customer spends on
-- the Kashier payment page, and the hourly job in section 8 closes even that.
--
-- A soft-delete/archived flag was the alternative. It was rejected because it
-- would have to be honoured by every read path in the app (storefront product
-- pages, quick view, cart revalidation, the product_catalog view, the admin
-- grid) and one missed filter silently sells an archived size.
-- ---------------------------------------------------------------------------
-- SECURITY DEFINER so the lookup sees every order regardless of who is doing
-- the delete: an RLS-filtered read here would let the guard pass silently for
-- a role that simply cannot see the order holding the variant.
create or replace function public.prevent_live_variant_delete()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $function$
declare
  v_order_ref text;
begin
  select coalesce(o.kashier_order_id, o.id::text) into v_order_ref
  from public.orders o
  where o.status = 'pending'
    and o.payment_status = 'pending'
    and o.stock_reserved_at is null
    and exists (
      select 1
      from jsonb_array_elements(coalesce(o.items, '[]'::jsonb)) i
      where i->>'variant_id' = old.id::text
    )
  limit 1;

  if v_order_ref is not null then
    raise exception 'product variant % is on order %, which is still awaiting payment', old.id, v_order_ref
      using errcode = 'P0001', hint = 'variant_in_live_order';
  end if;

  return old;
end;
$function$;

comment on function public.prevent_live_variant_delete() is
  'BEFORE DELETE trigger on product_variants: refuses to remove a variant that an order still awaiting payment references, because fulfill_order() raises when the variant id is gone and the paid order would die with its stock never decremented.';

revoke execute on function public.prevent_live_variant_delete() from public, anon, authenticated;

drop trigger if exists prevent_live_variant_delete on public.product_variants;
create trigger prevent_live_variant_delete
  before delete on public.product_variants
  for each row execute function public.prevent_live_variant_delete();

-- ---------------------------------------------------------------------------
-- 7. One order per checkout attempt, however many times the request is sent.
--
-- If the response to create-order is lost (the customer's connection drops
-- after the order was committed), pressing "place order" again places a SECOND
-- Cash on Delivery order and reserves the stock twice. The client sends a
-- request id it keeps across a lost response (src/pages/Checkout.tsx) and
-- create-order returns the original order for a repeat of the same id.
--
-- Stored for COD orders only, which are the only ones that reserve stock -- a
-- duplicated online order holds nothing and is cleaned up by section 8. The
-- unique index is what makes the guarantee real: two requests racing past
-- create-order's lookup cannot both insert.
-- ---------------------------------------------------------------------------
alter table public.orders add column if not exists client_request_id text;

comment on column public.orders.client_request_id is
  'Idempotency key sent by the checkout page, stored for Cash on Delivery orders only. A repeat of the same key returns the original order instead of placing a second one.';

create unique index if not exists orders_client_request_id_key
  on public.orders (client_request_id)
  where client_request_id is not null;

-- ---------------------------------------------------------------------------
-- 8. Cancelling orders that were never paid for.
--
-- An order is inserted 'pending' before the Kashier session is created. If
-- that call throws, or the customer closes the payment page, the row sits at
-- 'pending' forever: it clutters the admin list, it keeps
-- prevent_live_variant_delete above blocking, and nothing else will ever
-- resolve it.
--
-- Two bounds carried over from release_expired_cod_orders in 20260806000000,
-- because "pending orders never held stock" is only true of orders this
-- system produced. The admin dropdown this task replaces offered 'pending' as
-- a freely selectable value, so a COD order the owner ever set back to
-- 'pending' reads exactly like an abandoned one, was NOT covered by that
-- migration's backfill (which skips 'pending'), and would be cancelled here
-- with its held stock never returned:
--   - cod_expiry_epoch: nothing created at or before the instant that feature
--     landed is ever considered. Pre-existing orders are the owner's business.
--   - payment_method <> 'cash': a cash order is never abandoned in this sense.
--     It reserves its stock at placement, and release_expired_cod_orders owns
--     its expiry -- but only for a CONFIRMED one, which is the gap below.
--
-- KNOWN GAP, deliberately left to the admin rather than automated. A COD order
-- stuck at status = 'pending' belongs to neither job: this one excludes it by
-- payment_method, and release_expired_cod_orders requires status =
-- 'confirmed'. It is produced by one narrow failure -- create-order committed
-- the insert but the place_cod_order RPC never completed -- so it holds no
-- stock and costs no money. What it does do is match prevent_live_variant_delete
-- forever, permanently blocking removal of the variants it references. The
-- remedy is manual and already available: admin cancel is allowed from any
-- status. Automating it was judged the riskier option, because widening either
-- job's predicate to reach these rows also brings genuinely stock-holding COD
-- orders into range of a cancellation that would not return their stock.
--
-- 72 hours, not a few: Kashier retries a webhook for 24 hours, and cancelling
-- an order whose delivery is merely late would leave a real payment attached
-- to a cancelled order. Anything arriving after the cancellation is refused by
-- the webhook's state machine and logged loudly there, so the failure mode is
-- visible rather than silent.
--
-- Bounded at 500 per run so one bad night cannot produce a single unbounded
-- transaction.
--
-- A function rather than the one inline statement the rate-limit purge in
-- 20260806000000 uses, for one reason: it writes orders.status, so it needs to
-- carry `set app.order_write = 'on'` past enforce_order_state_writer, and a
-- cron command string has nowhere to put that.
-- ---------------------------------------------------------------------------
create or replace function public.cancel_abandoned_pending_orders(p_older_than_hours integer default 72)
returns integer
language plpgsql
security definer
set search_path to 'public', 'pg_temp'
set app.order_write = 'on'
as $function$
declare
  v_cancelled integer := 0;
begin
  with doomed as (
    select id
    from public.orders
    where status = 'pending'
      and payment_status = 'pending'
      and payment_method <> 'cash'
      and stock_reserved_at is null
      and stock_released_at is null
      and created_at > (select effective_from from public.cod_expiry_epoch limit 1)
      and created_at < now() - make_interval(hours => greatest(coalesce(p_older_than_hours, 72), 1))
    order by created_at
    limit 500
  )
  update public.orders o
  set status = 'cancelled', payment_status = 'failed'
  from doomed d
  where o.id = d.id;

  get diagnostics v_cancelled = row_count;
  return v_cancelled;
end;
$function$;

comment on function public.cancel_abandoned_pending_orders(integer) is
  'Closes online orders left at pending because the customer never paid (or the payment session could not be created). They hold no stock, so this is bookkeeping. Bounded by cod_expiry_epoch so pre-existing orders are never touched.';

revoke execute on function public.cancel_abandoned_pending_orders(integer) from anon, authenticated, public;

do $cron$
begin
  if exists (select 1 from cron.job where jobname = 'cancel-abandoned-pending-orders') then
    perform cron.unschedule('cancel-abandoned-pending-orders');
  end if;
end;
$cron$;

select cron.schedule(
  'cancel-abandoned-pending-orders',
  '37 * * * *',
  $$select public.cancel_abandoned_pending_orders()$$
);

-- ---------------------------------------------------------------------------
-- 9. Assert the write flag actually landed.
--
-- enforce_order_state_writer refuses any order state change that does not
-- carry app.order_write, so a typo in one of the ALTER FUNCTION lines above
-- takes out that path completely: COD checkout, payment fulfilment, refunds,
-- cancellations. Fail the deploy here instead of finding out at the checkout.
--
-- Scope, precisely: this catches a typo the FIRST time this migration is
-- applied, and nothing after that. An applied migration never runs again, so
-- a LATER migration re-emitting one of these bodies without the setting is
-- NOT caught here -- whoever writes it has to re-assert, or copy this block.
-- ---------------------------------------------------------------------------
do $assert$
declare
  v_missing text;
begin
  select string_agg(p.proname, ', ')
  into v_missing
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public'
    and p.proname in (
      'place_cod_order', 'fulfill_order', 'release_order_stock',
      'admin_update_order_status', 'release_expired_cod_orders',
      'cancel_abandoned_pending_orders'
    )
    and not coalesce(array_to_string(p.proconfig, ',') like '%app.order_write=on%', false);

  if v_missing is not null then
    raise exception 'app.order_write is not set on: %. Order state writes from those functions would be refused.', v_missing;
  end if;
end;
$assert$;
