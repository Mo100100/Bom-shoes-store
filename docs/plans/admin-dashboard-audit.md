# Plan: Admin Dashboard Audit Remediation

Fixes the two bugs the store owner reported (brands never change, uploaded logo
never updates) plus everything the full admin audit found, including a live
privilege-escalation hole and two data-loss paths.

## Context

- React 18 + Vite + TypeScript SPA, Supabase Postgres/Auth/Edge Functions.
- Bilingual EN/AR, RTL. Egyptian store, EGP, ~118 products, real orders.
- Admin lives at `src/pages/admin/*`, guarded by `ProtectedRoute requireAdmin`.
- The database is LIVE and already carries the checkout remediation
  (migrations through `20260808000000`).
- No test framework (`tsc -b` + `eslint`). Verification is `pnpm build` +
  `pnpm lint` + `node --test` scripts for pure logic. Do NOT add vitest/jest.

## Evidence gathered before this plan (do not re-derive)

- `/brands` renders a HARDCODED array of 7 strings and never reads the database.
  Confirmed in a real browser: it shows Prada, Nike, Balenciaga, Adidas, Amiri,
  New Balance, Gucci. The `brands` table has 22 rows, none of which appear, and
  Nike/Adidas/Amiri/New Balance are not in the database at all.
- The logo IS updating. `store_settings.logo_url` points at the newest upload
  and that file serves HTTP 200. The uploaded image is 277x600 and `Logo.tsx`
  forces a square box, so it draws at 26x56 with 54% of the width empty.
  Measured in the live DOM.
- The favicon `<link>` keeps `type="image/svg+xml"` from `index.html` while the
  uploaded file is a `.ico`. Confirmed in the live DOM.
- `brands.value` is the PRIMARY KEY and `products.brand` stores it as free text
  with no foreign key. One row is corrupted: `value="ل"`, `name="Burberry"`.
- Of 118 products, 116 have `brand = null`.
- `profiles` INSERT policy is `with check (id = auth.uid())` with no role
  restriction, and `prevent_self_role_change` is `before update` only.

## Global Constraints

1. **No em dashes or en dashes** in any user-facing text or code comment. Use
   hyphens, colons, or rewrite. Hard project rule.
2. **All user-facing strings** go through the `t` object in
   `src/lib/translations.ts`, which currently has exactly 709 `en` and 709 `ar`
   keys. Adding a string means adding BOTH. Never let the counts drift.
3. **Follow existing architecture.** Match surrounding style and comment
   density. No new dependencies, no new state libraries. Reuse the existing
   context shape (`CategoriesContext` / `BrandsContext` with their `reload()`)
   rather than inventing a new pattern. No new abstraction until the same thing
   repeats three times.
4. **A Supabase `.update()` or `.delete()` that matches zero rows returns NO
   error.** Never treat "no error" as "saved" on a write that matters. Verify
   with a returned row (`.select()`) or an explicit count.
5. **Never render an empty state for a failed read.** Empty and broken must be
   visually distinct everywhere. `Shop.tsx` already has the correct
   `loadIdRef` + `loadError` pattern; copy it.
6. **Migrations** additive and idempotent, no hardcoded row UUIDs, and they
   must sort AFTER `20260808000000`. The database is live: never write a
   destructive migration, and treat every existing row as real customer data.
7. **SECURITY DEFINER functions** pin `search_path` and revoke EXECUTE from
   `anon`, `authenticated` and `public`, matching
   `20260704009002_harden_function_grants.sql`.
8. **No N+1 queries.** No database call inside a `.map`/`for`/`forEach`. Query
   count must not grow with row count. This is a hard project rule.
9. **Verification:** `pnpm build` AND `pnpm lint` must pass with 0 errors
   (9 pre-existing warnings are acceptable). Paste real output.
10. Do not fix findings outside your assigned task. Note them in your report.

---

## Task 1: Close the admin privilege-escalation hole

**Files:** new migration `20260809000000`, `src/contexts/AuthContext.tsx`

`profiles` INSERT is `with check (id = auth.uid())` with no restriction on
`role`, and the only guard is an UPDATE-only trigger. Any customer who signs up
can POST their own profile row with `role: 'admin'` and gain every admin RLS
policy in the schema: all orders, all customer names, phones and addresses,
price changes, order cancellation, and `admin_update_order_status`.

1. Restrict what a user may insert for themselves so `role` cannot be anything
   but the default customer role. Prefer a `BEFORE INSERT` trigger that forces
   the role (belt and braces with a tightened policy `with check`), because a
   policy alone is easy for a future migration to widen by accident. Reuse the
   existing `prevent_self_role_change` function if it can be extended to cover
   INSERT cleanly; otherwise add a sibling and say why.
2. **Audit the live data in the same migration**: report, via `RAISE NOTICE`,
   how many `profiles` rows currently hold `role = 'admin'`. Do NOT delete or
   demote anyone automatically - the owner's own account is an admin and you
   cannot tell it apart from an intruder. Print the count and the emails so the
   owner can check the list by eye.
3. Make the client side stop sending `role` at all on signup
   (`AuthContext.tsx:90-95`), so the trusted default is the only path.
4. Consider whether profile creation belongs in a database trigger on
   `auth.users` instead of the browser. If you judge that too large a change
   for this task, say so and leave the client insert in place behind the new
   server-side guard.

**Verification:** `pnpm build`, `pnpm lint`. State exactly what a malicious
signup can and cannot write after the change, and confirm a NORMAL signup still
works end to end (this is the one thing that must not break).

---

## Task 2: Stop failed reads from destroying live data

**Files:** `src/pages/admin/AdminHomepage.tsx`, `src/pages/admin/AdminBundles.tsx`

Two screens swallow a load error, render "nothing configured yet", and then let
Save write that emptiness over live content.

1. `AdminHomepage.tsx:45-69` - `load()` discards both errors, leaving
   `drafts = {}`. Every tab renders `value={drafts.hero || {}}`, which looks
   like an unconfigured section. `saveKey` (L66) then writes
   `{ value: drafts[key] || {} }` over the live seeded row. The owner opens the
   editor after a network blip, types a headline, saves, and the hero, buttons
   and Arabic copy on the live site are gone.
2. `AdminBundles.tsx:67-71` and `:103-117` - `loadItems` ignores its error, so
   `itemRows` falls back to a single blank row, indistinguishable from an empty
   bundle. `saveItems` then unconditionally DELETEs every `bundle_items` row and
   inserts the non-blank ones, which is none. Opening a bundle to fix a typo
   deletes its products.

For both: surface the load failure, and REFUSE to save when the underlying data
never loaded. A save must never be able to write an empty payload derived from
a failed read. Add the missing error state and a retry.

3. `AdminHomepage.saveKey` also does not reload after saving and writes back the
   whole jsonb blob it read at mount, so a second tab or a concurrent edit is
   silently overwritten. Reload after save, and state in your report whether you
   addressed the lost-update race or judged it out of scope.

**Verification:** `pnpm build`, `pnpm lint`. Describe exactly what now happens
on a failed load followed by a Save attempt.

---

## Task 3: Make brands real (the first reported bug)

**Files:** `src/pages/Brands.tsx`, `src/components/ProductCard.tsx`,
`src/pages/ProductDetail.tsx`, `src/pages/admin/AdminSettings.tsx`,
`src/pages/admin/AdminProducts.tsx`, `src/contexts/BrandsContext.tsx`,
new migration `20260810000000`

Three compounding causes. Fix all three.

1. **`Brands.tsx:13` is a hardcoded array of 7 brand names** and never calls
   `useBrands()`. This is the whole reported bug: the page cannot change. Drive
   it from the `brands` table, including each brand's `logo_url`. The stale
   comment at `Brands.tsx:8-12` claims the table "hasn't been migrated in yet"
   and that `Shop.tsx` does not filter by brand: both are false
   (`20260712000000_brands.sql`, and `Shop.tsx:81` filters). Remove it.
2. **`ProductCard.tsx:52` renders the raw `products.brand` value**, so a brand
   whose key is `ل` displays as `ل` to customers. Categories on the same line go
   through `categoryLabel()`. Add the mirror-image lookup for brands via
   `useBrands()`, falling back to the raw value when there is no matching row.
3. **`ProductDetail.tsx` never shows the brand at all.** Add it, using the same
   lookup.
4. **Renaming a brand only changes `name`, never `value`**
   (`AdminSettings.tsx:278-282`), and `value` is the primary key that
   `products.brand` stores. This is how `value="ل" / name="Burberry"` was
   created and it is unfixable from the UI today. Decide and implement ONE of:
   (a) make renaming a real operation that updates the key and every product
   referencing it, inside a transaction; or (b) drop the separate `name` and
   edit a single field. State your choice and why. If you pick (a), it needs a
   SECURITY DEFINER function - a client cannot update a PK and all referencing
   rows atomically.
5. **`handleAddBrand` has no validation** on a value that becomes an immutable
   primary key (`AdminSettings.tsx:264-276`). One stray keystroke created the
   `ل` row. Add validation: non-empty after trim, a sane length, and a
   duplicate/case-collision check against existing brands. `handleAddCategory`
   (`:221`) has the identical flaw - fix it too, it is the same three lines.
6. **Repair the corrupted data** in the migration, WITHOUT hardcoding UUIDs:
   the brand whose `value` is a single stray character but whose `name` is a
   real brand. Move products pointing at the old key onto the corrected one and
   fix the key. Guard every step so the migration is idempotent and cannot fail
   if the owner has already fixed it by hand.
7. **The admin product table has no Brand column** (`AdminProducts.tsx:463-476`),
   which is why 116 of 118 products silently have no brand. Add it so the owner
   can see the gap at a glance.
8. **`AdminProducts.tsx:551` category select**: when a product's category is not
   in the list the control DISPLAYS "Sneakers" while `editing.category` keeps
   the old value, so the payload writes the old value and the admin sees a
   change that did not happen. Same class as the brand select
   (`:564-573`, which renders blank in that situation). Make both honest.

**Verification:** `pnpm build`, `pnpm lint`. Add
`src/lib/brands.test.mjs` (`node --test`) for whatever pure helper you extract
(the label lookup and the add-brand validation). Confirm the `/brands` page now
reflects the database.

---

## Task 4: Make the logo and favicon actually update (the second reported bug)

**Files:** `src/components/Logo.tsx`, `src/App.tsx`, `src/components/Layout.tsx`,
`src/pages/admin/AdminSettings.tsx`, new `src/contexts/StoreSettingsContext.tsx`
(or equivalent), `index.html`

The database is correct and the file serves fine. Three separate defects.

1. **The logo is squeezed.** The uploaded image is 277x600; `Logo.tsx` forces
   `width: size, height: size` with `object-contain`, so it draws at 26x56 and
   looks unchanged. Render an admin-uploaded logo at its natural aspect ratio
   within a height budget, rather than forcing a square. The built-in SVG
   monogram fallback IS square and must keep its current appearance. This is a
   visual change to the site header: keep it tasteful and consistent in both
   LTR and RTL, and do not let a very wide logo blow out the header layout.
2. **Nothing refetches after an upload.** `Logo.tsx:19-31` and `App.tsx:38-52`
   each fetch once with `[]` deps. `Layout.tsx` mounts `<Logo>` three times
   (`:403`, `:681`, `:778`) and `App.tsx` fetches the same singleton row again
   for the favicon: four queries for one row that changes once a year, and the
   header still shows the old logo after an upload. Hoist it into ONE context
   with a `reload()`, matching the existing `BrandsContext`/`CategoriesContext`
   shape, and have `AdminSettings.handleUpload` call `reload()` on success.
   Note `App.tsx:56` wraps every route including `/admin` in `<Layout />`, so
   the admin is looking at the same stale header.
3. **The favicon declares the wrong MIME type.** `App.tsx:47-48` swaps only
   `.href`, leaving `type="image/svg+xml"` from `index.html:5` while the
   uploaded file is a `.ico`/`.png`. Set `type` to match the real file, and
   handle favicon cache-busting. Note the favicon is deliberately NOT compressed
   (`AdminSettings.tsx:138`) so it keeps its original format.
4. **Old logo objects are never deleted** (`AdminSettings.tsx:132-160`), unlike
   product images which are cleaned up (`AdminProducts.tsx:282-283`). Every
   re-upload permanently consumes the free tier. Remove the previous object on
   a successful replace, and make a failure to delete non-fatal.
5. `store_settings` has NO `updated_at` trigger anywhere, so that column is
   stale by design. Do not use it to detect changes. Either add a trigger or
   leave it and correct the misleading comment.

**Verification:** `pnpm build`, `pnpm lint`. State the rendered dimensions of a
277x600 logo before and after your change.

---

## Task 5: Stop the admin lying about writes and reads

**Files:** all of `src/pages/admin/*`, `src/contexts/AuthContext.tsx`

1. **Twelve writes treat "no error" as "saved"** while a zero-row match returns
   no error. Under an RLS denial or a stale key each shows a success toast
   having written nothing: `AdminSettings.tsx:148-154, 172, 184, 195, 231, 279,
   318, 330`, `AdminProducts.tsx:82, 291-292, 343`, `AdminUsers.tsx:41-46`,
   `AdminHomepage.tsx:65-69`. Make a write that matters verify it actually wrote.
   Do NOT bolt a new abstraction onto every call site: find the smallest change
   consistent with the existing style, and apply it to the writes where a silent
   no-op misleads the owner.
2. **Nine screens cannot tell "empty" from "broken."** Every admin load
   destructures `{ data }` and drops the error: `AdminOrders.tsx:68`,
   `AdminCoupons.tsx:81-85`, `AdminBundles.tsx:53-57`, `AdminBanners.tsx:22`,
   `AdminUsers.tsx:32-36`, `AdminActivityLog.tsx:48, 59, 71`,
   `AdminHomepage.tsx:48-51, 635`, `AdminDashboard.tsx:80-83`,
   `AdminProducts.tsx:141`, `AdminSettings.tsx:70-99`. A failed read renders
   "No orders yet" or, worse in settings, shows the logo as "None" - which reads
   as "my logo disappeared". Add error states with retry. Loading and empty
   states already exist and are fine.
3. **A transient profile-read failure locks the owner out of his own admin.**
   `AuthContext.tsx:22-49` ignores the read error, falls through to an INSERT
   that also ignores its error, leaves `profile` null, so `isAdmin` is false and
   `ProtectedRoute` bounces the owner to the storefront. Handle the error and
   distinguish "no profile" from "could not read the profile". Also fix the
   double `loadProfile` race between `loadUser()` and the `INITIAL_SESSION`
   auth event.
4. `AdminUsers.tsx:103` - demoting the last remaining OTHER admin has no
   confirmation. Self-demotion is already blocked client side and by a trigger.
5. `AdminUsers.tsx` has no empty state: a search matching nothing renders a
   table header over a void.

**Verification:** `pnpm build`, `pnpm lint`. List every write you changed and
how it now proves it wrote.

---

## Task 6: Fix the numbers and the queries behind them

**Files:** `src/pages/admin/AdminDashboard.tsx`, `AdminOrders.tsx`,
`AdminCoupons.tsx`, `AdminBundles.tsx`, `AdminBanners.tsx`, `AdminHomepage.tsx`

1. **Revenue is wrong past 1000 orders.** `AdminDashboard.tsx:80-83` does
   `select('*')` on `orders` with no limit while `supabase/config.toml:13` sets
   `max_rows = 1000`, then sums client side. Revenue, order counts, the 30-day
   chart and best sellers all silently under-report. It also pulls every order's
   full `items` jsonb to the browser on every visit. Compute these server side
   (a view or an RPC) so the numbers are correct and the payload is small.
2. **`AdminOrders.tsx:66-74` has no pagination**, so past 1000 orders the oldest
   are unreachable from the admin entirely, and the status counts at `:177` and
   the total at `:181` are computed over the truncated set.
   `AdminActivityLog.tsx:69-77` already paginates correctly: follow it.
3. **`AdminCoupons.tsx:81-89` pulls every redemption row in the store** to count
   them in a loop, capped at 1000, so usage counts under-report and a coupon can
   look unused while customers are refused. `AdminBundles.tsx:55, 61` has the
   same shape. Count server side.
4. **N+1 writes on reorder.** `AdminBanners.tsx:49-58` and
   `AdminHomepage.tsx:655-664` issue one UPDATE per row per arrow click inside
   a `.map`, and none of the results are checked while the UI optimistically
   shows the new order. This violates the project's hard N+1 rule.
   `AdminProducts.tsx:304` (image reorder) is the same.
5. **Revenue is bucketed by UTC day** (`AdminDashboard.tsx:31-42`) for an
   Egyptian store at UTC+2/+3, so every order after 22:00 local lands on the
   next day's bar.
6. `AdminDashboard.tsx:276` renders `p.price` for low-stock items, but the
   authoritative variant pricing is `min_price`/`max_price`/`has_discount` on
   `product_catalog`. A product with a `price_override` shows one number here
   and another on the shop page.

**Verification:** `pnpm build`, `pnpm lint`. For each list, state the query
count for 50 rows and for 5000 rows and confirm it does not grow with row count.

---

## Task 7: Correctness and polish across the admin

**Files:** `src/pages/admin/*`, `src/lib/*`

1. **Arabic product names produce an empty slug.** `AdminProducts.tsx:327`
   strips everything outside `[a-z0-9]`, so "حذاء رياضي" collapses to `''`.
   This is an Arabic-first store: the product saves with an empty slug, its URL
   is unroutable, and the second such product collides on the unique constraint
   with a raw Postgres error. Generate a usable slug for non-Latin names and
   guarantee uniqueness. Existing products may already be affected: check and
   repair them in a migration (`20260811000000`) without hardcoding UUIDs.
2. **Deleting a coupon destroys its redemption history.**
   `AdminCoupons.tsx:159-165`; `coupon_redemptions.coupon_id` is
   `on delete cascade` while `orders.coupon_id` has no delete action. Either the
   delete is refused with a raw untranslated Postgres message, or redemptions
   are silently destroyed and per-customer limits lose their history. Warn
   properly, and translate the refusal.
3. **Delete guards proceed when their own count query fails.**
   `AdminSettings.tsx:241-245` and `:287-289` read `{ count }` with no error
   check, so a failed count is `null`, which is falsy, and the delete proceeds -
   orphaning every product that referenced the brand or category.
4. **Position swaps are two non-atomic updates with ignored errors**
   (`AdminSettings.tsx:256-259`, `:300-303`). A half-applied swap leaves two
   rows sharing a position and every later swap of that pair is a silent no-op.
   `handleAddBrand:268` also computes `max(position)+1` from the client's array,
   so two admins adding at once collide.
5. `AdminHomepage.tsx:182-185` (`handleToggleBrandsPage`) replaces the whole
   `site_visibility` jsonb with a single key, discarding any other flag. Latent
   today, one key exists.
6. `AdminOrders.tsx:259` labels the number of order LINES as "pieces": an order
   of 2 products with 3 each reads as "2 pieces".
7. `AdminOrders.tsx:83-89` - `refusalMessage` misses the `not_admin`,
   `order_not_found` and `status_not_settable` hints the RPC also raises, so
   those surface as raw English SQL. `AdminOrders.tsx:118-134` discards the
   RPC's boolean and toasts success even on a no-op.
8. `AdminProducts.tsx:309` accepts a negative price; `costPrice` (`:577`) is
   unvalidated; `AdminSettings.tsx:405` turns a cleared shipping field into 0,
   i.e. free shipping, saved on blur with a success toast.
9. `AdminProducts.tsx:19` and its two `|| 'Sneakers'` fallbacks hardcode a
   category that could be deleted, creating orphan-category products.

**Verification:** `pnpm build`, `pnpm lint`, plus `node --test` for the slug
generator (Arabic input, Latin input, collision handling).

---

## Task 8: Accessibility, i18n and UX across the admin

**Files:** `src/pages/admin/*`

1. `AdminOrders.tsx:241-244` - the expandable order row is a `<tr onClick>` with
   no `tabIndex`, no `role`, no `aria-expanded` and no key handler, so the most
   used table in the admin is unreachable by keyboard.
   `AdminActivityLog.tsx:153-166` already solved this with a real `<button>`
   and a comment explaining why: carry it across.
2. **Dates are hardcoded to `en-US` in five places**: `AdminDashboard.tsx:39`,
   `AdminOrders.tsx:256`, `AdminUsers.tsx:91`, `AdminActivityLog.tsx:142`,
   `AdminCoupons.tsx:59`. An Arabic admin gets English month names.
   `useLanguage()` is already available in all five.
3. `AdminLayout.tsx:162, 178` - `aria-label="Close menu"` and
   `"Open admin menu"` are hardcoded English while `t.navCloseMenu` and
   `t.navOpenMenu` already exist and are used by the storefront `Layout.tsx`.
4. `AdminLayout.tsx:46-71` - the realtime new-order toast closes over `t` and
   `formatPrice` with `[]` deps, so after switching language every toast keeps
   arriving in the language the tab loaded in.
5. `AdminHomepage.tsx:779` - a delete button labelled
   `aria-label={t.adminTestimonialDeleted}` ("Testimonial deleted"), announcing
   a past-tense status instead of the action.
6. `AdminCoupons.tsx:63` - the date range uses a directional arrow that points
   the wrong way in RTL.
7. Remove-row buttons with no confirmation: `AdminHomepage.tsx:331, 402, 508,
   553` and `AdminBundles.tsx:311`. Nothing persists until Save, but Save is one
   click away and there is no undo.

Keep every change minimal and local. Do not restructure components.

**Verification:** `pnpm build`, `pnpm lint`. Confirm the `en`/`ar` key counts
still match exactly and that no long dashes were introduced.
