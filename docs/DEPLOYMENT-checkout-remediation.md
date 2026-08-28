# Deployment handoff: checkout audit remediation

Branch: `fix/checkout-audit-remediation`. This document reconstructs, from the
task ledger and per-task reports under `.superpowers/sdd/checkout-audit-remediation/`
(gitignored, not part of this repo's history), the deployment runbook and
owner-facing behaviour list produced during the release-readiness review of
this branch. Read this fully before deploying anything in it.

---

## 1. What this branch is

This is a 27-commit remediation of the checkout, cart, pricing and
order-lifecycle of this store, driven by a full audit of the money path:
`Checkout.tsx` -> `create-order` -> Kashier -> `kashier-webhook` ->
`fulfill_order()` for card payments, and `Checkout.tsx` -> `create-order` ->
`place_cod_order()` for Cash on Delivery. The headline fixes: the Kashier
webhook now validates the paid amount and currency, enforces a real payment
state machine, and no longer accepts an attacker-controlled signature key
list; a declined card payment can no longer show the customer a "success"
page; editing a product in the admin no longer regenerates variant ids and
silently breaking a paid order's fulfilment; a size typed as `41/42/43` can no
longer be saved as a single crammed variant; the cart now revalidates every
line against the database instead of trusting a frozen snapshot; Cash on
Delivery order creation is now rate-limited and capped so it cannot be used to
drain the catalog; coupon and percentage-discount math is now clamped and
floored so a typo can no longer post a negative total to the payment gateway;
cancellations and refunds now actually restore stock, which they never did
before; and the fake "display currency" selector, which relabelled prices
without ever converting them, has been removed.

Twelve tasks were implemented, reviewed, and fix-round-verified in sequence on
this one branch, followed by a final consolidated fix wave addressing findings
from two whole-branch reviews (see `final-fix-wave-report.md`). Nothing in
this list is speculative: every claim below traces to a specific task report
or to the SQL and TypeScript actually committed on this branch. Every SQL
confidence rating recorded across all twelve tasks is "medium", consistently,
and section 2 explains why that matters more than usual.

---

## 2. THE BIG RISK, now partly retired

> **STATUS UPDATE: all five migrations have since been applied to the live
> database and succeeded.** `supabase db push` reported `Finished supabase db
> push` with exit 0. Verified afterwards against real data: the 4 crammed
> variant rows became 15 correct per-size rows with zero still crammed; the
> `product_catalog` view carries `max_price` and `has_discount` and no longer
> carries `sale_price`; `rate_limit_attempts` and `cod_expiry_epoch` exist; the
> storefront catalog query returns all 4 products. `products.sale_price` held
> **0 rows**, so the irreversible drop destroyed nothing.
>
> One migration failed on its first attempt and was fixed before succeeding.
> `20260808000000` used a custom `app.order_write` setting to mark trusted
> writers; Supabase's `postgres` role is not a superuser and cannot install
> one (`ERROR: permission denied to set parameter`). It now keys on the owner
> of `public.orders` instead. See section 8 for why that matters and what not
> to reintroduce.
>
> **What is still unverified** is everything that needs live traffic rather
> than a migration run: the Kashier signature match, the `x-forwarded-for`
> shape behind the rate limiter, and the refund path. Sections 6, 8 and 10
> still apply in full. The rest of this section is kept as written, because it
> explains why the checks below exist.

Five migrations, `20260801000000`, `20260805000000`, `20260806000000`,
`20260807000000`, and `20260808000000`, totalling roughly 1,800 lines of SQL,
were written and reviewed by reading only. They were **never executed** at the
time this document was written. The
environment this branch was built in had no Docker and no local Postgres, so
`supabase db start` and `supabase db push` could not run here. Every implementer
and every reviewer on this branch independently rated their SQL confidence as
MEDIUM and their TypeScript confidence as HIGH, for exactly this reason: the
TypeScript was built, linted, and exercised by `node --test` scripts (66
assertions pass across five suites); the SQL was traced by hand, proven
algebraically in places, and never once run against a real database.

That is not a formality. Two of these five migrations contain logic that only
proves itself correct by reasoning about which rows a `NOT EXISTS` subquery
can and cannot see mid-statement, and one of them assumes a specific shape of
Kashier's `x-forwarded-for` header that nobody here could check. Reading SQL
carefully is not the same as running it against real data. **Staging
verification against a copy of real production data is mandatory before this
branch reaches production, not an optional nicety.** Section 3 is the
checklist for doing that.

---

## 3. Pre-production checklist

Work through this in order. Do not skip a step because a later one looks more
interesting.

### 3.1 Take a restore point

Before anything else, take a full backup or restore point of the production
database. This is the only rollback path for a migration that turns out to be
wrong after it has run (see section 7).

**Migration `20260805000000` drops `products.sale_price` irreversibly.** Once
it runs, that column and its data are gone. If there is any chance the sale
price values are wanted for historical reference (even though nothing in the
app ever charged them), export them first:

```sql
select id, name, sale_price
from public.products
where sale_price is not null;
```

Run that from the Supabase SQL editor and download the result as CSV, or from
a shell with the CLI:

```
supabase db execute --file - <<'SQL' > sale_price_export.csv
copy (
  select id, name, sale_price
  from public.products
  where sale_price is not null
) to stdout with csv header
SQL
```

### 3.2 Create a branch database from real production data

Do not test these migrations against a clean, empty database. Every real risk
in this branch is a data-shape risk: crammed variant sizes that already exist,
coupon codes that already collide once upper-cased, orders already sitting in
states the new state machine has to classify correctly, negative or
out-of-range `products.stock` rows. An empty database proves none of that. Use
a Supabase database branch (or a restored copy of production) so the
migrations run against the actual rows they will touch in production.

### 3.3 Push the migrations, capturing stdout

```
supabase db push --include-all > migration-output.log 2>&1
```

Capture the output; do not just watch it scroll. **Two of the five migrations
communicate real, actionable problems via `RAISE NOTICE` / `RAISE WARNING`,
not via a failure**, so a clean exit code does not mean nothing needs your
attention:

- `20260801000000` (crammed variant sizes): if any variant rows are truly
  unsalvageable (their corrected size collides with a row that already holds
  it), it prints `Deleting N unsalvageable variant row(s) ... M back-in-stock
  subscription(s) cascade away with them.` Read the count. Those subscriptions
  are gone; there is no query to recover which customers they were.
- `20260807000000` (coupon integrity): if two coupon codes collide once
  upper-cased (e.g. `save20` and `Save20` both exist), it prints
  `coupon_integrity: these coupon codes collide once case is ignored, so none
  of them were upper-cased and NONE of them can now be redeemed. Pick one of
  each pair, delete or rename the other, then upper-case the survivor: <ids>`.
  **This is not cosmetic. Both codes in a stranded pair stop working the
  moment this migration lands**, until you manually resolve the pair.

### 3.4 Specific things to watch for

- **Task 4's migration (`20260801000000`), duplicate-key risk.** Steps 1 and 3
  deduplicate crammed and padded sizes using a `NOT EXISTS` subquery that only
  sees the statement's own snapshot, not rows the same statement is updating.
  The implementer and reviewer traced this by hand and added an in-batch
  "lowest id wins" tiebreak specifically to close it, but it was never run. If
  you see `duplicate key value violates unique constraint` on this migration,
  it means that reasoning had a gap; stop and inspect the exact colliding
  `product_id, size, color` rows before re-running, do not just retry.
- **Task 8's deploy assertion (`20260808000000`, section 9).** A `do $assert$`
  block checks that six trusted functions (`fulfill_order`,
  `admin_update_order_status`, `cancel_abandoned_pending_orders`,
  `place_cod_order`, `release_order_stock`, `release_expired_cod_orders`) are
  all SECURITY DEFINER and all owned by the same role that owns
  `public.orders`, which is the condition the new
  `enforce_order_state_writer` trigger tests. If this migration fails here,
  **do not proceed to the edge function deploy.** The trigger it is protecting
  gates every write to `orders.status` / `orders.payment_status`; if the
  assertion is failing, checkout, fulfilment, refunds and cancellations are
  all about to break at once.
- **Task 7's stranded case-colliding coupon codes.** Covered in 3.3 above;
  repeated here because it is easy to miss in a long migration log.
- **Task 8's activity-log burst.** The migration's two backfill `UPDATE`
  statements each fire the existing `log_activity` trigger once per row they
  touch. Against a real production `orders` table this will write a burst of
  entries into `activity_logs` in the space of one migration run. This is
  expected, not a bug; do not be alarmed by a sudden spike in the admin
  activity log right after this migration.

### 3.5 Verification SQL: prove each migration did what it claims

Run these against the branch database after `db push`, before promoting
anything to production.

```sql
-- 20260801000000: no crammed, padded, or blank sizes remain
select id, product_id, size from public.product_variants
where size ~ '[/,]' or size <> btrim(size) or size = '';
-- expect 0 rows

-- 20260805000000: sale_price is gone, product_catalog exposes the new columns
select column_name from information_schema.columns
where table_name = 'products' and column_name = 'sale_price';
-- expect 0 rows
select min_price, max_price, has_discount from public.product_catalog limit 5;
-- expect it to return rows with no error

-- 20260806000000: abuse-control tables and the COD expiry epoch exist
select * from public.cod_expiry_epoch;
-- expect exactly 1 row, effective_from stamped
select jobname, schedule from cron.job
where jobname in ('release-expired-cod-orders', 'purge-rate-limit-attempts');
-- expect both scheduled

-- 20260807000000: no coupon code disagrees with its own upper-case form
-- except the ones the RAISE NOTICE already named as stranded
select code from public.coupons where code <> upper(code);

-- 20260808000000: the stale 2-argument release_order_stock overload is gone
select pronargs from pg_proc where proname = 'release_order_stock';
-- expect exactly one row, pronargs = 4
select jobname from cron.job where jobname = 'cancel-abandoned-pending-orders';
-- expect it scheduled
-- confirm the six trusted functions are SECURITY DEFINER and share the
-- owner of public.orders, which is what the trigger tests
select p.proname, p.prosecdef, pg_get_userbyid(p.proowner) as fn_owner,
       (select pg_get_userbyid(c.relowner) from pg_class c
        where c.oid = 'public.orders'::regclass) as orders_owner
from pg_proc p
where p.proname in ('fulfill_order', 'admin_update_order_status',
  'cancel_abandoned_pending_orders', 'place_cod_order',
  'release_order_stock', 'release_expired_cod_orders');
-- expect prosecdef = true and fn_owner = orders_owner on every row
```

---

## 4. Deploy order, with the reason

**Deploy the frontend bundle first. Push the migrations within minutes after.
Deploy the edge functions last.**

There is no ordering that has a zero-risk window, because the frontend, the
database, and the edge functions each depend on the other two. Pick the
lowest-traffic hour for this store and do all three in one sitting, as close
together as you can manage.

Why this specific order, not another one:

- If the **migration lands before the frontend**, an admin whose browser still
  has the old, cached bundle open will try to write `orders.status` directly
  through PostgREST the old way. The new `enforce_order_state_writer` trigger
  now rejects that write outright, and the admin sees a raw database error
  string (`order state must be changed through admin_update_order_status()`)
  surface in a toast, with no friendly message around it.
- If the **frontend lands first instead**, a fresh bundle calling the new
  `admin_update_order_status()` RPC before the migration that creates it has
  landed simply gets "function does not exist". This is a cleaner failure than
  the raw trigger error, and it self-heals the moment the migration lands a
  few minutes later, which is why frontend-first is the better of the two
  imperfect choices.
- **Edge functions go last**, after the migration, not before: the new
  `create-order` writes to `orders.client_request_id`, a column the migration
  in `20260806000000` creates. Deploying that function before the column
  exists means every order attempt fails.

### Edge functions to deploy

All of the following, including the two new ones:

| Function | verify_jwt | Why |
|---|---|---|
| `create-order` | `true` | The anon key is itself a valid JWT, so this still works for guests; it only rejects requests with no Supabase JWT at all. |
| `kashier-webhook` | `false` | Kashier's servers call this with no Supabase JWT. Authenticity is checked inside the function via the `x-kashier-signature` header instead. |
| `order-status` | `false` | **NEW.** A customer returning from Kashier's hosted payment page may be a guest with no Supabase session. The order reference itself is treated as the capability; the response carries only status fields, never money or customer details. |
| `send-order-confirmation` | `true` | **NEW.** Admin-only. The function asks the database `is_admin()` using the caller's own JWT before it sends anything. |
| `validate-coupon` | not set in `config.toml`, defaults to `true` | Same anon-key-as-JWT reasoning as `create-order`. |
| `sitemap` | `false` | Search-engine crawlers call this with no Supabase JWT, same as `robots.txt`. |
| `send-back-in-stock-notifications` | not set in `config.toml`, defaults to `true` | Unchanged by this branch; harmless to redeploy alongside the rest. |

Confirm `supabase/config.toml`'s `[functions.*]` blocks match the table above
before you deploy; each has an inline comment explaining the setting.

---

## 5. Environment variables

| Variable | Required | What breaks without it |
|---|---|---|
| `SUPABASE_URL` | Yes (auto-injected in production) | Every edge function that touches the database fails outright at startup. |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes (auto-injected in production) | Same as above; also the rate limiter's IP-hashing salt falls back to this key when `RATE_LIMIT_SALT` is unset. |
| `SUPABASE_ANON_KEY` | Yes | `send-order-confirmation` uses it to run the caller's own JWT through `is_admin()`. Without it the admin-authorization check cannot run and the function fails closed. |
| `KASHIER_MERCHANT_ID`, `KASHIER_API_KEY`, `KASHIER_SECRET_KEY` | Yes | Without these, `create-order` cannot build a Kashier checkout session at all, so online card payment is entirely unavailable; `kashier-webhook` cannot verify a signature, so no card payment can ever be marked paid. |
| `KASHIER_MODE` | Optional, defaults to `test` | Must be explicitly set to `live` for production. Left unset or at `test`, `create-order` builds sessions against Kashier's test iframe instead of the real one, so real customers cannot pay. |
| `RESEND_API_KEY`, `RESEND_FROM_EMAIL` | Yes for confirmation emails; also used as the Supabase Auth SMTP credentials | Without these, order confirmation emails fail silently on both the webhook path and the admin `send-order-confirmation` path (failure is logged, not surfaced, and never blocks fulfilment on purpose). The same key also drives signup and password-recovery emails via `[auth.email.smtp]` in `config.toml`, so account creation and password reset break too if it is missing. `RESEND_FROM_EMAIL` must be on a domain verified in Resend; the shared sandbox domain only delivers to the Resend account owner's own inbox. |
| `RATE_LIMIT_SALT` | **New, optional.** | If unset, the rate limiter hashes IPs using `SUPABASE_SERVICE_ROLE_KEY` instead, which is already secret and always present, so nothing breaks without it. Setting your own value is a privacy hardening (rotating it resets every open rate-limit window once) but is not required for the feature to work. |
| `SITE_URL` | Yes | Used to build the CORS allowlist inside `create-order` and the base URL the `sitemap` function emits. Missing or wrong, and browser calls to `create-order` can be rejected by CORS, or the sitemap can publish the wrong domain. |

---

## 6. Post-deploy smoke test

Do these as real actions against the live deployment, not against a branch
database. This is the minimum set that proves money actually moves correctly.

1. **Place a real Cash on Delivery order** at a low price point. Confirm it
   appears in the admin order list at `status = confirmed`,
   `payment_status = pending`, and that the ordered variant's stock count
   dropped by the ordered quantity.
2. **Place a real card payment** through the live Kashier iframe for a small
   amount. Watch `CheckoutSuccess` resolve to the confirmed state, not get
   stuck on "payment is being confirmed" or bounce to the failed page.
3. **Read the `kashier-webhook` function log** in the Supabase dashboard for
   the signature-match diagnostic line naming which signature construction
   matched. This is the single most important thing to check on this branch:
   the accepted signature constructions were deliberately cut from 8 to 2
   during this remediation, and that cut was never checked against live
   Kashier traffic, because there is no way to generate real Kashier
   signatures outside a live payment. If the log shows no match for a payment
   that genuinely succeeded, the order will sit at `pending` rather than
   `paid`. No money is lost in that case (Kashier holds the funds and retries
   its webhook for 24 hours), but the order needs a manual "Mark paid" in the
   admin, which now correctly takes the stock as well.
4. **Change an order's status in the admin.** Move a confirmed order through
   the pipeline (confirmed -> processing -> delivered) and confirm no error
   toast appears. Then cancel a different test order and confirm the
   confirmation dialog appears, and that the cancelled order's stock is
   visibly restored.
5. **Save a product in the admin** that has existing variants and an order
   still in flight against one of its sizes, then reload and confirm the
   order's line items still resolve (i.e. saving the product did not
   regenerate the variant id and orphan that order).
6. **Apply a coupon at checkout**, including one with a free-shipping effect
   if the store has one configured, and confirm the checkout summary total
   matches what actually gets charged. Expect the summary to show something
   like "Shipping 70 / Discount 70" rather than "Free" when shipping is
   waived by a coupon; this is deliberate (see section 9) and correct.

---

## 7. Rollback

There are no down-migrations on this branch. Match the response to what
actually failed; do not reach for a full restore by default.

- **Frontend deploy is bad** (a visual bug, a JS error, a broken flow):
  redeploy the previous frontend build. The database and edge functions
  underneath are unaffected.
- **One edge function deploy is bad**: redeploy the previous version of just
  that function. Supabase keeps prior deployments; this is the cheapest
  rollback available and has no data implications.
- **A migration fails partway through** (a duplicate-key error, the deploy
  assertion in `20260808000000` tripping): each migration runs inside its own
  transaction, so a failure rolls the whole migration back automatically. The
  database is left exactly as it was before that migration ran. Fix the SQL
  and re-run; do not force a partial migration through by hand.
- **A migration succeeds but production behaviour turns out wrong** (an
  unexpected status transition gets rejected, stock accounting looks off,
  the coupon-collision notice surfaces problems you did not expect): there is
  no down-migration. The only clean rollback is restoring the backup taken in
  section 3.1. Restoring loses every write made after that backup, so treat it
  as a last resort: prefer a narrow forward-fix migration (dropping a bad
  constraint, correcting a function body) if the problem is small enough to
  name precisely.
- **Rate limiting starts rejecting real customers** (see section 8, the
  `clientIp` risk): this cannot be fixed by rolling back the frontend. It
  needs an edge function hotfix to `_shared/rate-limit.ts`'s `clientIp()`
  function, deployed the same way as any other edge function change.

---

## 8. Open risks and unverified assumptions

Everything below cannot be verified without a live deployment, and none of it
was tested end to end before this branch was written.

**Highest risk: the `clientIp()` last-hop assumption.** The new rate limiter
(`supabase/functions/_shared/rate-limit.ts`) identifies a caller by the
**last** entry in the `x-forwarded-for` header, on the reasoning that anything
a client sends is prepended to what the real network path appends, so the
last hop is the one the platform's own gateway actually saw. This is standard
proxy-chain reasoning, but it depends on Supabase's edge infrastructure (and
any CDN in front of it) appending exactly one hop of its own, and that could
not be checked from the environment this branch was built in.

Failure mode if the assumption is wrong: if Supabase's edge appends its own
relay address, or a CDN sits in front and does the same, the last hop is
**identical for every customer**, and the entire store shares a single
rate-limit counter. Once that shared counter fills, say after 20 real Cash on
Delivery orders from 20 different genuine customers in six hours, the 21st
customer of the day gets a 429 that reads to them like an ordinary error, and
nothing alerts anyone that this happened. This is a silent revenue outage, not
a graceful degradation, and it is the single highest-risk unverified
assumption on this branch.

**The exact check that closes it:** log the raw `x-forwarded-for` header from
one real request against the deployed project
(`console.log(req.headers.get('x-forwarded-for'))` in any edge function, then
read it back in the Supabase function logs) from two different customer
devices, and confirm the last entry differs between them. This instruction is
also in the code comment directly above `clientIp()`.

**The pre-agreed fallback:** if the last entry does not differ between
devices, switch `clientIp()` to read the first entry instead, and accept that
it becomes spoofable by a client that sends its own fake header, or key the
limiter on a different signal entirely.

Other open items, all recorded in the task reports as unverifiable without a
live database or deployment:

- The 8-to-2 reduction in accepted Kashier signature constructions (see
  section 6, item 3) has never been checked against a real Kashier payload.
- All five migrations were reviewed by reading only; the duplicate-key dedup
  logic in `20260801000000` and the deploy assertion in `20260808000000` are
  the two pieces most worth a real staging run before anyone else touches
  this data.
- The rate limiter's "bounded damage" claim is weaker than it first reads: a
  phone number can be rotated for free, and a client on a routed IPv6 /64 gets
  a fresh rate-limit counter for every address it uses. The per-IP and
  per-phone caps raise the cost of an attack; they are not a hard ceiling. The
  actual backstop is the 14-day stock-release job, which is what guarantees
  any damage is temporary.
- Refund and void handling trusts `event` only indirectly, because Kashier's
  `event` field is not itself signed. The combination of "order must currently
  be `paid`", "amount must match the full order total", and a per-order
  ledger entry closes the gap as far as reasoning alone can, but it was never
  tested against a real Kashier refund.
- The deploy assertion in `20260808000000` (section 3.4) only runs the first
  time that migration is applied. A future migration that re-creates one of
  the six guarded functions under a different owner, or drops SECURITY
  DEFINER from it, is not caught by anything automatic; whoever writes it has
  to remember to re-assert or copy the block.
- The order-write guard keys on the owner of `public.orders`. An earlier
  attempt used a custom `app.order_write` setting, which **failed on the real
  database**: Supabase's `postgres` role is not a superuser and cannot install
  a custom parameter on a function (`ERROR: permission denied to set parameter
  "app.order_write"`). An attempt before that inferred trust from
  `service_role` membership, which is not guaranteed either. The ownership
  test needs no special privilege and fails closed. This is recorded because
  both dead ends look reasonable on paper and someone will be tempted to
  reintroduce one.

---

## 9. What changed for you, day to day

Plain language, no jargon.

- **Sale prices are gone.** The "Sale price" field has been removed from the
  product editor. It never actually changed what a customer paid at checkout
  (the store always charged the regular price, or a per-size price override,
  whichever applied), so removing it does not change anything about past
  orders. Real discounts still work exactly as before, through the per-size
  price override field.
- **The currency switcher is gone.** Store settings used to let you pick USD
  as a display currency. It never converted anything; it just swapped the
  dollar sign onto the same Egyptian-pound number, so a "$420" price was
  actually charging 420 EGP, about 22 dollars. It has been removed so this
  cannot happen again. Every price now always shows and charges in EGP.
- **Coupons with a "per customer" limit no longer apply to shoppers who are
  not signed in.** There is no reliable way to know who a signed-out shopper
  is, so a per-customer-limited coupon now simply will not apply for them.
  Coupons without that limit, and the store's automatic promotions, still work
  for everyone as before.
- **Cancelling an order now asks you to confirm first**, and it puts the
  stock back into inventory for good when you do. There is no undo: if you
  cancel by mistake, the customer has to place a new order.
- **The app can no longer change an order's paid or shipped state behind the
  scenes.** A database rule now refuses any change to an order's status or
  payment status unless it comes from the store's own trusted code paths or
  from the admin panel. This stops a bug, or a stolen public key, from quietly
  rewriting whether an order was paid. Editing an order by hand in Supabase's
  SQL editor still works normally, because that runs as the database owner,
  which the rule trusts.
- **The "Size guide" button on product pages is gone.** It was a button that
  did nothing when clicked; there was no size guide content anywhere to open.
- **Clicking "Mark paid" now really takes the stock out of inventory**, the
  same as a genuine card payment does. Before this branch it marked the order
  paid without touching stock at all.
- **You cannot delete a shoe size from a product if a customer's order is
  still waiting on payment for that exact size.** The admin will tell you why.
  Once that order is paid or cancelled, the size can be deleted again as
  normal.
- **Two automatic jobs now run quietly in the background.** One returns stock
  from unpaid Cash on Delivery orders that sat unpaid for 14 days. The other
  closes out abandoned online-payment attempts after 72 hours; those never
  actually held any stock, so nothing physical changes when it runs, the order
  just gets marked closed instead of sitting there forever.
- **There are now limits on how fast someone can place orders or try coupon
  codes.** This stops a script from placing hundreds of Cash on Delivery
  orders in seconds to drain your stock, or from guessing coupon codes one
  after another. A real customer shopping normally will never come close to
  these limits.
- **The checkout summary can now show "Shipping 70 / Discount 70" instead of
  "Free"** when a coupon waives shipping. The amount the customer actually
  pays is identical either way; it is just shown as two line items adding to
  the same total instead of one word, so the summary matches what the receipt
  will say.
- **Shop and homepage product cards have a small eye icon** next to the
  "add to bag" icon. Clicking it opens a quick look at the product without
  leaving the page. This button already existed visually before but was
  disconnected and did nothing; it now works.

---

## 10. Known remaining work

These are deferred items from the task reports with real functional weight,
worth scheduling soon rather than treating as finished:

1. **None of `supabase/functions/**` is type-checked.** `tsconfig.app.json`
   only includes `src`, so every edge function on the money path
   (`create-order`, `kashier-webhook`, `order-status`, `validate-coupon`)
   ships with no compiler safety net at all.
2. **`checkoutConfig.ts`'s shipping-config fetch still swallows its own
   errors.** If the admin turns off online payment and that config fetch
   fails for any reason, a customer can still be offered a payment method the
   admin turned off, and the order is only rejected on the server side after
   they submit.
3. **`prevent_live_variant_delete` runs one sequential scan per deleted
   variant.** Fine at this store's current size; it will need a proper index
   once order volume grows.
4. **The COD retry-idempotency lookup runs before the rate limiter, by
   design**, which hands anyone holding the public anon key one free indexed
   database lookup per request. Deliberate tradeoff (a genuine retry must not
   burn a rate-limit allowance), recorded so nobody "fixes" it by accident.
5. **The COD stock-release job can lock up to 500 orders' worth of variant
   rows in a single transaction.** Fine today; worth capping lower or
   batching if order volume grows substantially.
6. **Mobile search has no visible close button**, and closing it another way
   drops keyboard and screen-reader focus to the page body instead of
   somewhere useful.
7. **The site's focus ring colour fails accessibility contrast requirements**
   (roughly 2.4 to 2.7:1 against a 3:1 minimum) on white and cream
   backgrounds. This is a design-token-level fix, not a one-line patch.
8. **A product card can show a "From" price next to a sold-out size chip.**
   `product_catalog`'s `min_price`/`max_price` prefer in-stock variants while
   `available_sizes`/`available_colors` list every variant, so the two can
   disagree on a partially sold-out product.
9. **`ProductDetail.tsx` keeps its own near-duplicate copy of
   `ProductCard.tsx`.** Flagged during Task 12's review as worth
   consolidating; not done on this branch.
10. **`CurrencyContext`'s context value and its `formatPrice` helper are not
    memoised.** Harmless today because the provider tree is built once at
    startup, but would cause unnecessary re-renders if that ever changes.
