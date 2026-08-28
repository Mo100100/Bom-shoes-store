# Plan: Checkout / Cart / Backend Audit Remediation

Remediates findings from the full audit of the Bom Shoes store (React 18 + Vite +
TypeScript SPA, Supabase Postgres/Auth/Edge Functions, Kashier payments, EGP).

## Context

- Storefront: `src/pages`, `src/components`, `src/contexts`, `src/lib`
- Backend: `supabase/functions/*` (Deno edge functions), `supabase/migrations/*.sql`
- Money path: `Checkout.tsx` -> `create-order` -> Kashier -> `kashier-webhook` -> `fulfill_order()`
- COD path: `Checkout.tsx` -> `create-order` -> `place_cod_order()`
- No test framework exists (`tsc -b` + `eslint` only). Verification is
  `pnpm build` (typecheck) + `pnpm lint` + one-off Node assert scripts for
  pure logic. Do NOT add vitest/jest.

## Global Constraints

1. **No em dashes or en dashes (`—`, `–`) in any user-facing text or code
   comments.** Use hyphens, colons, or rewrite. This is a hard project rule.
2. **Never trust the client for money.** Prices, discounts, shipping and totals
   are computed server-side from the database. The client sends only
   `product_id`, `size`, `color`, `quantity`, and a coupon code.
3. **Follow existing architecture.** Match surrounding code style, naming and
   comment density. Do not introduce new dependencies, new state libraries, or
   new abstractions. Reuse `src/lib/*` helpers and the `t` translation object.
4. **All user-facing strings go through the `t` translation object**
   (`src/lib/translations.ts`), which has `en` and `ar` entries. Adding a
   string means adding BOTH translations.
5. **Every migration is additive and idempotent** where possible
   (`create or replace`, `if not exists`, `drop policy if exists`). Never write
   a destructive migration. Never hardcode row UUIDs in a migration.
6. **SECURITY DEFINER functions** must pin `search_path` and revoke EXECUTE
   from `anon`, `authenticated` and `public`, matching the existing pattern in
   `20260704009002_harden_function_grants.sql`.
7. **No N+1 queries.** Batch with `in (...)` / joins. Query count must not grow
   with the number of cart items or products.
8. **Verification before done:** `pnpm build` must pass (it runs `tsc -b`) and
   `pnpm lint` must pass. Paste the actual command output in your report.
9. Do not fix findings outside your assigned task. Note them in your report
   instead. Another task probably owns them.

---

## Task 1: Harden the Kashier webhook

**File:** `supabase/functions/kashier-webhook/index.ts` (and
`supabase/functions/_shared/kashier-crypto.ts` if needed)

The webhook is the only path that marks an order paid and decrements stock.
Four defects:

1. **Amount/currency never validated.** Line ~80 selects `total_amount` but
   only uses it for the confirmation email; line ~92 fulfills on
   `event === 'pay' && data.status === 'SUCCESS'` alone. Compare the webhook's
   paid amount and currency against the stored order before fulfilling. Reject
   (log + do not fulfill) on mismatch. Allow a small rounding tolerance of at
   most 0.01 EGP. Currency must equal `'EGP'`.

2. **Signature key list is attacker-controlled.** The signed message is built
   from `data.signatureKeys`, which arrives inside the payload. Require that
   the security-critical fields are actually present in the signed key set:
   `merchantOrderId`, `amount`, `currency`, `status`. If any is missing from
   `signatureKeys`, reject the webhook as unverified. Also note `payload.event`
   is top-level and never signed, yet it gates fulfillment - treat an event
   value that is not in the signed set as untrusted and derive the outcome from
   the signed `status` field instead. Keep the existing constant-time compare.
   Reduce the number of accepted signature constructions to the minimum that
   works; accepting 8 variants widens the attack surface.

3. **No state machine.** The `else if (payload.event === 'pay')` branch
   (line ~101-105) sets `payment_status = 'failed'` with no guard on current
   state, so a declined retry after a successful payment flips a paid order to
   failed. Never transition away from `paid`. Never fulfill an order that is
   `cancelled` or `refunded`.

4. **Internal errors return 200,** killing Kashier's retry (line ~114-119). A
   thrown `rpcError` or transient DB failure must return 5xx so Kashier
   retries. Keep returning 200 only for genuinely-ignorable cases (unknown
   order, duplicate event, non-payment event, bad signature).

5. **Log leak:** line ~165-169 logs the full reconstructed signed string on
   mismatch, which can contain masked card and customer fields. Log only the
   key names used and a digest, never the values.

**Verification:** `pnpm build` and `pnpm lint`. Add
`supabase/functions/kashier-webhook/verify-signature.test.mjs`, a plain Node
script using `node:assert` and `node --test` that asserts: a valid signature
passes; a payload whose `signatureKeys` omits `amount` is rejected; a tampered
`amount` fails; a paid order is not flipped to failed. Extract pure helpers so
they can be imported without the Deno runtime. Run it and paste output.

---

## Task 2: Stop showing the success page for failed payments

**Files:** `supabase/functions/create-order/index.ts`,
`src/pages/CheckoutSuccess.tsx`, `src/pages/CheckoutFailed.tsx`,
new edge function `supabase/functions/order-status/index.ts`

`merchantRedirect` is `/checkout/success?...` for every outcome (lines ~298 and
~346), and `CheckoutSuccess.tsx` clears the cart and renders "order confirmed"
with no server check. A declined card shows success. `/checkout/failed` is
routed in `App.tsx` but unreachable.

1. Add a small `order-status` edge function that takes an order reference and
   returns ONLY `{ status, paymentStatus, paymentMethod }` for that order. It
   must not leak totals, customer details or items. Look the order up by its
   public order reference. Set `verify_jwt = false` in `supabase/config.toml`
   with a comment explaining why (the customer may be a guest returning from
   Kashier), and treat the order reference as an unguessable capability - if it
   is not already random and unguessable, say so in your report rather than
   changing it.
2. `CheckoutSuccess.tsx` calls it on mount: show a loading state, then
   - confirmed/paid (or COD) -> current success UI, clear the cart
   - failed -> redirect to `/checkout/failed`
   - still pending -> a distinct "payment is being confirmed" state that does
     NOT claim success and does NOT clear the cart
   Only clear the cart on a confirmed outcome.
3. `CheckoutFailed.tsx` gets a retry path back to `/checkout` with the cart
   intact.
4. Keep `merchantRedirect` pointing at `/checkout/success` (Kashier uses one
   redirect URL) - the page now decides based on server truth. If Kashier
   supports a separate failure redirect URL, wire it too.

All new strings go through `t` with `en` + `ar`.

**Verification:** `pnpm build`, `pnpm lint`, output pasted.

---

## Task 3: Stop variant UUID churn from killing paid orders

**File:** `src/pages/admin/AdminProducts.tsx` (function `saveVariants`, ~line 161)

`saveVariants` does `delete().eq('product_id', productId)` then `insert(rows)`
on every product save, so every variant gets a NEW uuid. Orders snapshot
`variant_id`, and `fulfill_order` raises `variant % not found` when it is gone.
A customer pays, the owner edits that product, the webhook arrives, and the
paid order dies with stock never decremented.

Replace delete+insert with a diff that PRESERVES ids:
- Match existing rows by their `id` (the grid already loads rows with ids at
  line ~113). Rows the admin did not remove keep their id via `update`.
- Genuinely new rows get `insert`.
- Rows the admin removed get `delete`, but only those.
- The existing code comment justifies delete+insert because per-row updates can
  hit `unique (product_id, size, color)` mid-loop when two rows swap values.
  Solve that without churning ids: do the deletes first, then the updates, then
  the inserts, and if a swap can still collide, use a single `upsert` on the
  natural key or a two-phase update. Explain your chosen approach in a comment.
- Keep it batched. Do not issue one query per row in a loop over an unbounded
  set; group the operations.

**Verification:** `pnpm build`, `pnpm lint`. Also write
`scripts/variant-diff.test.mjs` (`node --test`) asserting the pure diff helper:
unchanged rows keep ids, edited rows keep ids, removed rows are deleted, added
rows are inserted, and a size/color swap between two rows does not violate the
unique key. Extract the diff logic as a pure exported function to make this
testable. Paste output.

---

## Task 4: Size correctness (the originally reported bug)

**Files:** `src/pages/admin/AdminProducts.tsx`, `src/pages/ProductDetail.tsx`,
`src/components/QuickViewModal.tsx`, `src/pages/Shop.tsx`, `src/pages/Home.tsx`,
`src/lib/utils.ts` (or a new `src/lib/sizes.ts`), plus one new migration.

The reported symptom is a wrong size number in the cart. Root causes:

1. **Crammed sizes can still be created today.** `AdminProducts.tsx:580` is a
   bare `<input>` for the variant size and line ~166 stores `row.size.trim()`
   verbatim. An admin typing `41/42/43` creates ONE variant whose size is that
   whole string - exactly the bug the earlier data migration cleaned up.
   - Split on `/` and `,` at save time into one row per size, mirroring the
     existing tags pattern at `AdminProducts.tsx:497`. Preserve the entered
     stock semantics sensibly and explain your choice in a comment.
   - Validate a single size: reject empty and reject anything containing `/`
     or `,` after splitting. Show an inline error; do not silently drop.
   - Line ~285 rebuilds `products.sizes` from the same unsplit strings - fix
     that too, and `colors` at ~286.
2. **No server-side defence.** Add a migration with a `CHECK` constraint on
   `product_variants.size` rejecting values containing `/` or `,` or that are
   empty/whitespace. The table is defined in
   `20260704002000_product_images_and_variants.sql`. Guard the constraint so
   the migration does not fail if legacy bad rows exist: clean them in the same
   migration WITHOUT hardcoding uuids (use a pattern match), then add the
   constraint.
3. **Sizes are unordered everywhere.** No `.order()` on any
   `product_variants` query and no numeric sort anywhere.
   - Add ONE shared comparator (e.g. `compareSizes` in `src/lib/sizes.ts`) that
     sorts numerically when both values parse as numbers and falls back to
     `localeCompare` otherwise, so `9` sorts before `10` and before `40`.
   - Apply it wherever sizes are listed or defaulted: `ProductDetail.tsx:222`
     (`sizeOptions`) and the default selection at ~104, `QuickViewModal.tsx:75`
     and ~56, `Shop.tsx:122` (filter chips).
   - Add `.order('size')` / deterministic ordering to the variant queries at
     `ProductDetail.tsx:91`, `QuickViewModal.tsx:46`, `Shop.tsx:161`,
     `Home.tsx:75` so row order stops being arbitrary.
4. **Default selection is arbitrary and may be out of stock.**
   `ProductDetail.tsx:104` does `setSize(vars[0].size)` on an unordered array.
   Default to the first IN-STOCK variant for the default colour, using the
   comparator, and fall back sensibly when nothing is in stock.
5. **Switching colour leaves a stale size.** There is no effect resetting
   `size` when `color` changes, so the button reads "Out of stock" while other
   sizes in that colour are available. When the colour changes and the current
   size has no in-stock variant, auto-select the first in-stock size for that
   colour.
6. **Quick-add picks an arbitrary size.** `Shop.tsx:161-168` and
   `Home.tsx:75-79` do `variants?.find(v => v.stock > 0)` on an unordered
   fetch, so the customer gets a size they never chose. Make it deterministic
   (smallest in-stock size via the comparator) AND make the toast state the
   size that was added, using `t`.
7. **Two different fallbacks for the same concept:** `ProductDetail.tsx:107`
   uses `data.sizes[0]` while `QuickViewModal.tsx:59` uses
   `data.available_sizes[0]`. Unify.

**Verification:** `pnpm build`, `pnpm lint`, plus `src/lib/sizes.test.mjs`
(`node --test`) asserting: `9` before `10`, `10` before `40`, mixed
numeric/alpha ordering is stable, and the crammed-string splitter turns
`"41/42/43"` into `["41","42","43"]` and rejects `""`. Paste output.

---

## Task 5: Cart integrity

**Files:** `src/contexts/CartContext.tsx`, `src/pages/Cart.tsx`,
`src/components/ProductCard.tsx`

1. **Displayed price is not the charged price (critical).**
   `ProductCard.tsx:41-42` shows `sale_price ?? min_price` while
   `CartContext.tsx:93` totals `product.price`, and the server charges
   `price_override ?? products.price`. A product on sale advertises the sale
   price in the grid and charges full price. Unify the storefront on ONE price
   field that matches what the server actually charges. Read
   `supabase/functions/_shared/pricing.ts` to confirm the server's rule before
   choosing, and state the rule you settled on in your report.
2. **Cart is never revalidated (critical).** `CartContext.tsx:29-36` hydrates a
   frozen `Product` snapshot from `localStorage` and nothing ever refetches, so
   stale prices, renamed/deleted products and pre-migration crammed sizes
   persist forever. This is the direct cause of the reported bug.
   - On cart hydration (and on the Cart page mount), revalidate every line
     against the database in ONE batched query (`in (...)` over product ids
     plus their variants - no N+1, no per-item await in a loop).
   - Refresh price/name/image from the server, drop lines whose product or
     variant no longer exists, and clamp quantities to available stock.
   - Surface what changed to the user with a clear message ("some items were
     updated"), translated. Do not silently mutate their cart.
3. **Quantity is unbounded.** `updateQuantity` has a lower bound but no upper
   bound and consults no stock, so a user can reach 999 and only find out after
   filling in the whole checkout form. Clamp to available stock in the context
   (one guard, all callers) and disable the `+` control at the maximum with a
   translated hint.
4. **Deleted/unavailable items have no UI state.** Add an "item is no longer
   available" line state with a remove action, and stop rendering
   `src={item.product.image_url || ''}` (an empty `src` refetches the page and
   shows a broken-image glyph) - use a placeholder and `onError`.
5. `localStorage.setItem` at `CartContext.tsx:47-53` is not wrapped in
   try/catch while the reads are - it throws in Safari private mode. Match the
   existing guarded pattern.
6. `clearCart` (`Cart.tsx:183-188`) destroys the cart with no confirmation from
   a 28px target. Add a confirmation step.

**Verification:** `pnpm build`, `pnpm lint`. Prove the batching: state the
number of queries issued for a 50-line cart and confirm it does not grow with
line count. Paste output.

---

## Task 6: Stop anonymous COD from destroying inventory

**Files:** `supabase/functions/create-order/index.ts`, new migration

COD is the only path that decrements real stock with no payment.
`create-order` runs with `verify_jwt = true`, but the project's own config
comment confirms the public anon key is itself a valid JWT, so this is
effectively open to anyone with the key from the JS bundle. CORS is `*`. There
is no rate limit, no per-phone/per-IP cap, and no expiry on unpaid COD
reservations. A script can zero out the entire catalog in seconds.

1. Add rate limiting to COD order creation. Record attempts in a new table
   (order reference, phone, IP hash, created_at) and reject beyond a sane
   threshold per phone and per IP over a rolling window. Pick and document the
   thresholds. Hash the IP; do not store it raw.
2. Cap a single COD order: maximum total quantity and maximum total value.
   Reject beyond it with a clear translated message.
3. Add an expiry path for unpaid COD reservations so stock is not held forever:
   a SQL function that releases stock for COD orders still unpaid after a
   documented window, restoring `product_variants.stock`. Wire it to `pg_cron`
   if the project already uses it (check the migrations first); if not, add the
   function plus a comment on how to schedule it, and say so in your report.
   Releasing stock must be idempotent - a released order cannot be released
   twice.
4. Consider requiring the order to be tied to an authenticated user OR passing
   a lightweight challenge for guest COD, and report the tradeoff. Do not break
   guest checkout - it is a deliberate product decision.

**Verification:** `pnpm build`, `pnpm lint`. State exactly which thresholds you
chose and why. Paste output.

---

## Task 7: Coupon and pricing hardening

**Files:** `supabase/functions/_shared/pricing.ts`,
`supabase/functions/create-order/index.ts`, `supabase/functions/validate-coupon/index.ts`,
new migration

1. **`per_customer_limit` is trivially bypassed.** `pricing.ts:255` guards on
   `coupon.per_customer_limit != null && customerEmail`, but email is optional
   at checkout and never verified. Leaving it blank skips the check entirely,
   giving unlimited redemptions. Enforce the limit against the authenticated
   user id when present, and refuse to apply a per-customer-limited coupon at
   all when there is no verifiable identity.
2. **Percentage discount is uncapped and the total is never floored.**
   `pricing.ts:283-287` caps only if `max_discount_amount` is set, and
   `coupons.discount_value` has no constraint. A typo of `150` on a percentage
   coupon produces a discount of 1.5x subtotal and a NEGATIVE total posted to
   Kashier, hard-breaking checkout. Add a `check (discount_value <= 100)` for
   percentage coupons via migration AND clamp defensively in `pricing.ts`.
   Floor the final total at 0 in `create-order`.
3. **`validate-coupon` is an unthrottled code oracle** - it distinguishes
   invalid from valid codes with no rate limit or logging, so the code space can
   be enumerated. Add rate limiting (reuse Task 6's mechanism if it landed;
   coordinate via the ledger note in your dispatch) and stop distinguishing
   "does not exist" from "not applicable to this cart" in the response.
4. **Coupon lookup is case-sensitive** (`pricing.ts:186`) so `save20` fails
   where `SAVE20` works. Normalise case on both sides.
5. **N+1:** `pricing.ts:399-408` calls `checkUsageLimits` (1-2 COUNT queries)
   inside a per-coupon loop, so query count grows with the number of active
   auto-promotions. Batch it into a single grouped count.
6. **Auto-promotions are applied server-side but never previewed,** so the UI
   total disagrees with the amount charged whenever an auto-promotion or bundle
   applies (customer-favourable, but the receipt does not match the button).
   Make `validate-coupon` able to return the resolved best discount for a cart
   with NO code entered, and have `Checkout.tsx` show it. Keep the server
   authoritative.
7. **No constraint enforces `code IS NULL` when `requires_code = false`** - an
   admin saving a code on an auto-promo publishes it to every visitor via the
   public read policy. Add the constraint.

**Verification:** `pnpm build`, `pnpm lint`, plus a `node --test` script for the
pure discount math: percentage clamped at 100, total floored at 0,
`max_discount_amount` respected, case-insensitive code match. Paste output.

---

## Task 8: Order lifecycle and stock accounting

**Files:** new migration(s), `src/pages/admin/AdminOrders.tsx`

1. **Cancellations and refunds never restore stock.** `AdminOrders.tsx:59` sets
   `status` with a plain update, and refund/void webhook events are ignored. A
   cancelled COD order or refunded card order keeps its stock deducted forever.
   Add a `release_order_stock(p_order_id)` SECURITY DEFINER function that
   restores stock exactly once (idempotent - track a released flag on the
   order), and call it when an order moves to `cancelled` or `refunded`.
2. **`fulfill_order` can double-decrement a COD order.** It guards only on
   `v_payment_status = 'paid'` (`20260704003001:41`), but a COD order sits at
   `status='confirmed'`, `payment_status='pending'` with stock ALREADY
   decremented by `place_cod_order`. Any path reaching `fulfill_order` for that
   id decrements the same units twice. `place_cod_order` has the symmetric
   guard and `fulfill_order` does not. Add it.
3. **Admin status changes bypass stock accounting entirely.** Moving a
   `pending` online order to `processing` marks it fulfilled without ever
   decrementing stock. Route admin status transitions through functions that
   keep stock consistent, and reject transitions that would corrupt it.
4. **Orphaned `pending` orders.** If `createKashierSession` throws, the order
   row is left `pending` forever (`create-order:162-207`). Add cleanup for
   abandoned pending orders (they never held stock, so this is bookkeeping) and
   make the client side of a lost-response retry idempotent so a customer
   retrying does not place a second COD order.
5. **Legacy `products.stock` has no `>= 0` constraint** unlike
   `product_variants`, so the no-variant fallback path in `fulfill_order` can go
   negative. Add it, cleaning any negative rows first.

**Verification:** `pnpm build`, `pnpm lint`. State the state machine you
enforced (which transitions are legal). Paste output.

---

## Task 9: Currency correctness

**File:** `src/contexts/CurrencyContext.tsx` (and `src/pages/ProductDetail.tsx`
JSON-LD at ~368)

1. **Display currency lies about the charge (critical).** `CurrencyContext.tsx:52-57`
   swaps the symbol with NO FX conversion while `create-order:48` always charges
   `EGP`. An admin setting USD makes the store show `$420` and charge 420 EGP.
   Either implement real conversion with a server-provided rate, or restrict the
   display currency to what is actually charged. Given there is no FX source in
   the project, the correct minimal fix is to stop offering a display currency
   that differs from the settlement currency - do that unless you find a real
   rate source in the codebase. Explain your decision.
2. **`Math.round` per value** means the displayed column does not add up
   (100 + 8 tax renders as 100 + 8 = 109) and cents are destroyed. Replace the
   hand-rolled `symbolFor` concatenation with `Intl.NumberFormat` using
   `ar-EG` / `en-US` per the active language, which fixes rounding, thousands
   separators, locale digits and currency placement in one edit.
3. **No bidi isolation** on the suffix form, so `420 EGP` can reorder inside an
   Arabic paragraph. `Intl.NumberFormat` with `style: 'currency'` handles this;
   otherwise wrap in `<bdi>`.
4. The JSON-LD at `ProductDetail.tsx:368-369` publishes the same wrong currency
   label to Google. It must emit the real settlement currency and an unformatted
   numeric price.
5. The 8% tax rate is a magic number duplicated in `Cart.tsx:84` and
   `Checkout.tsx:85`. Extract one shared constant and confirm it matches the
   server's rate in `_shared/pricing.ts`.

**Verification:** `pnpm build`, `pnpm lint`, output pasted.

---

## Task 10: Loading, empty and error states

**Files:** `src/components/QuickViewModal.tsx`, `src/lib/checkoutConfig.ts`,
`src/pages/Checkout.tsx`, `src/pages/Shop.tsx`, `src/pages/ProductDetail.tsx`,
`src/components/Layout.tsx`, `src/components/ErrorBoundary.tsx`

The codebase already has the correct pattern (two-arg `.then(ok, fail)` with an
explicit fallback) in `CurrencyContext.tsx:45-48`, `Layout.tsx:117-128` and
`WhatsAppButton.tsx:32-43`. These fetches just do not use it.

1. **QuickView infinite spinner (critical).** `QuickViewModal.tsx:34-64`
   destructures `{ data }` with no error branch; on failure or a deleted
   product `ready` is permanently false and the modal never resolves. Add an
   error/not-found state.
2. **Shipping config failure makes checkout impossible (critical).**
   `checkoutConfig.ts:62-70` swallows the error and returns `{regions: []}`;
   `Checkout.tsx:53` has no error state. The required governorate select renders
   only its disabled placeholder and checkout cannot be completed, with zero
   feedback. Add loading + error states and a retry.
3. **Swallowed fetch errors that lie to the user:**
   - `Shop.tsx:73` - a failed catalog fetch renders "no pieces match your
     filters", blaming the user's filters. Add an error state with retry.
   - `ProductDetail.tsx:80-85` - a failed fetch renders "Product not found", a
     fake 404 for a product that exists.
   - `Shop.tsx:161-166` / `Home.tsx:75-79` - a failed variant fetch shows "out
     of stock", a lie about inventory.
   - `ProductDetail.tsx:167-198` - `addBundleToBag` ignores the error, falls
     back to `p.sizes[0]` with no stock check, adds an unsellable line, and
     shows a SUCCESS toast.
   - `ProductDetail.tsx:118-130` - failed reviews fetch renders "no reviews yet".
   - `Layout.tsx:184-190` - failed search renders "No results found"; and while
     `searching` is true nothing renders at all (no spinner).
4. **`ErrorBoundary.tsx:27-28` dumps a raw JS stack trace to end users in
   production** and is untranslated. Show a translated friendly message; log the
   stack to the console only.
5. `Cart.tsx:215-222` - the coupon Apply button disables but shows no spinner.

**Verification:** `pnpm build`, `pnpm lint`, output pasted.

---

## Task 11: i18n, RTL, accessibility and mobile

**Files:** `src/lib/translations.ts`, `src/components/Layout.tsx`,
`src/index.css`, `index.html`, `src/pages/Shop.tsx`, `src/pages/Cart.tsx`,
`src/pages/Checkout.tsx`, `src/pages/ProductDetail.tsx`,
`src/components/QuickViewModal.tsx`, `src/components/RatingStars.tsx`,
`src/components/ShoeShowcase3D.tsx`, `src/components/CountdownTimer.tsx`

This is a bilingual EN/AR RTL store. Batch of same-shape fixes.

**i18n - add `en` + `ar` keys and route these through `t`:**
`Cart.tsx:145` (`Size {item.size}`), `ProductDetail.tsx:331`,
`QuickViewModal.tsx:91`, `Shop.tsx:169`, `Home.tsx:80` - four surfaces show the
size in three different formats; unify on one translated format, and
`Checkout.tsx:318` is a fifth. Also: `Layout.tsx:281, 325, 335, 369, 533, 290,
530` aria-labels (note `t.account` already exists at translations.ts:737 and is
unused at :369), `Layout.tsx:378` and `:735` inline `lang === 'ar' ? ... : ...`
ternaries that bypass `t`, `QuickViewModal.tsx:105, 111`,
`ProductDetail.tsx:32, 443`, `RatingStars.tsx:18`, `ShoeShowcase3D.tsx:290`,
`CountdownTimer.tsx:19` default labels.

**Style rule violations (hard project rule):** `Shop.tsx:288` uses an en dash as
the price-range separator; `Checkout.tsx:329` uses an em dash for unset
shipping. Replace both.

**RTL:**
- `Layout.tsx:298` - `absolute start-1/2 -translate-x-1/2`: in RTL `start-1/2`
  is `right:50%` so it needs `translateX(+50%)`. The entire desktop nav is
  offset by its own width in Arabic. Add `rtl:translate-x-1/2`.
- `index.css:234-239` + `Layout.tsx:255` - the marquee keyframe translates left
  on a `width:max-content` RTL track, so the ticker scrolls the wrong way and
  opens a growing blank gap.
- `index.css:330` - `[dir="rtl"] .flip-rtl { transform: scaleX(-1) }` overrides
  Tailwind's composed `--tw-transform` instead of composing, so
  `group-hover:translate-x-1` silently dies in Arabic (`Home.tsx:143, 184, 305`).
  Use `--tw-scale-x: -1` or `rtl:-scale-x-100`.
- `ShoeShowcase3D.tsx:271` - literal `→` with no flip.
- `Layout.tsx:311` - underline uses physical `origin-left`.
- `Checkout.tsx:199-200` - phone and email inputs get `dir="rtl"` in Arabic;
  they must be `dir="ltr"` with `text-align: start`.
- `index.html:2` is hardcoded `lang="ar" dir="rtl"` and JS only corrects it
  after mount, so English users get an RTL flash on every cold load.

**Accessibility:**
- `Layout.tsx:527-603` - the mobile menu is a full-screen overlay with no
  `role="dialog"`, no `aria-modal`, no focus trap, no Escape handler and no
  scroll lock. Tab escapes behind it. The Escape pattern already exists at
  `Layout.tsx:100-107` for the search panel; apply it here.
- `Layout.tsx:332-363` and `366-426` - dropdowns have no `aria-expanded` /
  `aria-haspopup` and close only on outside `mousedown`, so they cannot be
  dismissed by keyboard.
- `Layout.tsx:464-493` - search input has no accessible name; the suggestion
  list has no `role="listbox"` / `aria-activedescendant` and no arrow-key
  navigation.
- Selection state is colour-only (no `aria-pressed`): `Shop.tsx:210-222,
  245-257, 264-275`, `ProductDetail.tsx:486-498, 514-528`,
  `QuickViewModal.tsx:142-153, 165-179`. `Checkout.tsx:237, 264` already does
  this correctly - match it.
- Unlabelled inputs: `Cart.tsx:207-214`, `Shop.tsx:280-296`,
  `ProductDetail.tsx:626-633`.
- `ProductDetail.tsx:506-508` - "Size guide" is a focusable button with NO
  `onClick`. Either wire it or remove it.
- No global `:focus-visible` style exists in `index.css`; inputs use
  `outline-none` plus a colour-only border change. Add a visible focus ring.
- `Cart.tsx:165` - quantity changes are silent to screen readers; add
  `aria-live`.
- `Layout.tsx:254-264` - the marquee has no pause control (WCAG 2.2.2).
  `prefers-reduced-motion` at `index.css:355` is a partial mitigation.
- `QuickViewModal.tsx:113-116` - loading branch has no `aria-busy`/`aria-live`.

**Mobile:**
- `Layout.tsx:321-328` - the search button is `hidden md:flex` and the mobile
  menu has no search entry, so **search is entirely unreachable on mobile**.
- `ProductDetail.tsx:485` - colour swatch row has no `flex-wrap` and overflows
  at 375px with 5+ colours (`QuickViewModal.tsx:140` already wraps).
- `ProductDetail.tsx:438` - gallery thumbnails do not wrap or scroll.
- Tap targets under 44px: `Cart.tsx:148-154` remove button is ~24px and its
  negative margin shrinks the hit area further; `Cart.tsx:158-172` qty buttons
  ~28px; `ProductDetail.tsx:510-530` and `QuickViewModal.tsx:161` size cells
  ~40px; `Layout.tsx:321-450` header icons ~36px.
- `Shop.tsx:209` - the category row scrolls but `scrollbar-none` removes the
  only affordance that more exist.

Do not restructure components. Keep every change minimal and local.

**Verification:** `pnpm build`, `pnpm lint`. Confirm no em/en dashes remain in
changed files. Paste output.

---

## Task 12: Remove the dead `sale_price` column and label "from" prices

Added mid-plan after the store owner decided two open questions. Task 5
discovered that `products.sale_price` is a DEAD column: the admin offers a
"Sale price" field and the storefront displayed it, but no server code ever
reads it (`grep -rn sale_price supabase/functions/` returns nothing). Every
sale the owner entered showed customers a discount and then charged them full
price. Owner's decisions, both binding:

1. **Remove `sale_price` entirely.** Discounts continue through the per-variant
   `price_override`, which already works end to end and IS charged correctly.
2. **Show "from X" in the grid when a product's variants differ in price**, and
   a plain price when they do not.

**Files:** `src/components/ProductCard.tsx`, `src/pages/Shop.tsx`,
`src/pages/admin/AdminProducts.tsx`, `src/lib/translations.ts`, `src/lib/supabase.ts`,
plus one migration and the `product_catalog` view.

**Migration timestamp: `20260805000000`.**

### Item 1: remove `sale_price`

- Drop the "Sale price" input from the admin product form and every write of it.
- Remove it from the `product_catalog` view and from the TypeScript types.
- Drop the column itself, but ONLY after confirming nothing reads it. Search
  the WHOLE repo, not just edge functions - client code, views, types, seeds.
- `src/pages/Shop.tsx:72` currently implements the `/sale` filter as
  `.not('sale_price','is',null)`. Rebuild that filter so `/sale` means "has a
  real, chargeable discount": at least one variant whose `price_override` is
  below the product's base `price`. This needs the view to expose something
  the filter can use (for example a `has_discount` boolean or a
  `max_effective_price`), computed in SQL, not by fetching every product and
  filtering client-side. Do not introduce an N+1 or a client-side scan.
- The SALE badge in `ProductCard.tsx` must mean exactly the same thing as the
  `/sale` filter. They currently disagree; after this task they must not.

### Item 2: "from" pricing

- `product_catalog` exposes `min_price`. The grid renders it as a flat price,
  so a product with size 43 at 400 and everything else at 500 shows 400 and
  charges 500 for size 42.
- When a product's variants differ in effective price, render the grid price
  as a "from" price using a translated string (`en` and `ar`). When every
  variant is the same price, render it plain with no prefix.
- This needs the view to expose enough to tell the two cases apart (for
  example `max_price` alongside `min_price`). Add it in SQL.
- Consider whether `min_price` should ignore out-of-stock variants: a price
  backed only by a sold-out size is not a price anyone can pay. Decide, apply
  it consistently to BOTH the displayed price and the SALE badge, and state
  your decision and its reasoning in your report.

### Constraints specific to this task

- The migration must be additive and idempotent, must hardcode no uuids, and
  must not break `product_catalog`'s existing consumers. `create or replace
  view` resets `reloptions`, so if the view was created `with (security_invoker
  = true)`, preserve that - check `20260704002000_product_images_and_variants.sql`
  against `20260712000001_product_catalog_add_brand.sql`, because the latter
  may already have dropped it.
- Dropping a column is the one destructive act allowed here, and only because
  the owner explicitly asked for it. Confirm zero readers first and say so in
  your report. If you find ANY reader you did not expect, stop and report
  instead of dropping.

**Verification:** `pnpm build`, `pnpm lint` (0 errors). State every place
`sale_price` appeared before and confirm each is gone. Paste output.
