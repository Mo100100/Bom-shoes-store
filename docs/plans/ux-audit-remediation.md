# Plan: UX Audit Remediation

Fixes what two full UX audits plus a live browser walkthrough found across the
storefront and purchase flow of the Bom Shoes store, plus the owner's explicit
instruction to remove the 8 percent tax.

## Context

- React 18 + Vite + TypeScript SPA, Supabase Postgres/Auth/Edge Functions,
  Kashier payments, Cash on Delivery, EGP.
- **Arabic-first**: `index.html` is `lang="ar" dir="rtl"`. Most customers are on
  a phone, on Egyptian mobile data, arriving from WhatsApp and Instagram.
- LIVE store: 118 products, 22 brands, 316 variant rows, real orders.
- Migrations through `20260813000000` are applied. The Supabase CLI is linked to
  the correct project (`nwkvxaavplatwjwwvgch`).
- No test framework. Verification is `pnpm build` + `pnpm lint` + `node --test`
  scripts for pure logic. Do NOT add vitest or jest.

## Owner decisions already made (do not re-litigate)

1. **Remove the 8 percent tax entirely.** Prices are tax-inclusive. This lowers
   what every customer pays by 8 percent.
2. Existing product URLs stay as they are (settled in an earlier round).
3. Every landing page section must work and be functional.

## Global Constraints

1. **No em dashes or en dashes** in any user-facing text or code comment. Use
   hyphens, colons, or rewrite. Hard project rule.
2. **All user-facing strings** go through the `t` object in
   `src/lib/translations.ts`, which currently has 745 `en` and 745 `ar` keys.
   Adding a string means adding BOTH. Verify parity by key NAME, never by count.
3. **Arabic is the default language.** Any copy you write in Arabic must read as
   natural Arabic, not a literal translation of an English brand voice. If an
   existing Arabic string is nonsense, fix it.
4. **Follow existing architecture.** Match surrounding style and comment
   density. No new dependencies, no new state libraries. Reuse what is there:
   `LoadErrorPanel`, `useBrands`, `useCategories`, `useCatalogPrice`,
   `StoreSettingsContext`, `src/lib/*` helpers. No new abstraction until the
   same thing repeats three times.
5. **Never trust the client for money.** The server recomputes every total.
6. **A Supabase write matching zero rows returns NO error.** Never treat "no
   error" as "saved" on a write that matters.
7. **Never render an empty state for a failed read.** Empty and broken must be
   visually distinct. `LoadErrorPanel` exists for this.
8. **No N+1 queries.** No database call inside a `.map`/`for`/`forEach`.
9. **Mobile first.** Tap targets at least 44px. Form inputs at least 16px or iOS
   zooms on focus and does not zoom back.
10. Migrations additive and idempotent, no hardcoded row UUIDs, sorting after
    `20260813000000`. The database is LIVE.
11. Verification: `pnpm build` AND `pnpm lint` must pass with 0 errors (11
    warnings is the current baseline). Paste real output.
12. Do not fix findings outside your assigned task. Note them in your report.

---

## Task 1: Remove the 8 percent tax

**Files:** `supabase/functions/create-order/index.ts`,
`supabase/functions/_shared/pricing.ts`, `src/lib/cart.ts`, `src/pages/Cart.tsx`,
`src/pages/Checkout.tsx`, `src/lib/translations.ts`

The owner's instruction: prices already include tax, so the added 8 percent must
go. This is a MONEY change. Every customer pays 8 percent less after it ships.

1. **The server is what actually charges.** `create-order/index.ts:51` defines
   `TAX_RATE = 0.08`, `:193` computes `tax`, and `:229` passes it into
   `computeOrderTotal`. Remove the tax from the charged total.
2. `computeOrderTotal` in `_shared/pricing.ts:742-748` takes `tax` as a
   parameter. Decide whether to drop the parameter or pass zero, and justify it.
   Dropping it is cleaner but touches a shared money function with other
   callers: check every caller before you choose.
3. Remove the client-side tax line from the Cart and Checkout summaries
   (`Cart.tsx:113`, `Checkout.tsx:178`, `src/lib/cart.ts:10`) so the displayed
   total matches the charged total exactly.
4. Remove any now-orphaned translation keys for the tax line, in BOTH locales.
5. **Check whether the stored `orders` rows have a tax column or a tax field in
   their JSON snapshot.** If historic orders recorded tax, leave that data
   alone: this change is forward-looking only, and past orders must still render
   correctly in the admin and in Account order history.

**Verification:** `pnpm build`, `pnpm lint`. State the before and after total for
a 1000 EGP cart with 60 EGP shipping, and confirm the client and server agree.
Confirm no caller of `computeOrderTotal` was left passing a stale argument.

---

## Task 2: Stop promising free shipping in dollars

**Files:** `src/lib/translations.ts`, and any component rendering these strings

The store charges EGP per governorate, and there is no dollar pricing or FX
source anywhere. These strings promise something the checkout does not honour,
and one of them runs across every page in the announcement bar:

- `translations.ts:15` / `:879` `announcement` - "Free shipping on orders over
  $200" / "شحن مجاني للطلبات فوق 200 دولار"
- `:105` / `:969` `marqueeLine2` - "Free shipping over $200"
- `:149` / `:1013` `homeTrust1Desc` - "Free on orders over $200, wherever you are."
- `:218` / `:1077` `productShip1` - "Free shipping on orders over $200"
- `:224` / `:1082` - "International shipping is 5 to 10 days", on a checkout that
  only accepts 27 Egyptian governorates

Replace all of them with copy that matches reality: delivery is priced per
governorate inside Egypt. **Read `src/lib/checkoutConfig.ts` for the real region
prices and use them to write honest copy.** If the owner has a genuine free
shipping threshold you cannot determine, write copy that states the real
situation without inventing a number, and say so in your report.

The announcement bar is admin-editable (`site_content.announcement`), so also
check whether the live value overrides the translation, and report which one the
customer actually sees today.

**Verification:** `pnpm build`, `pnpm lint`. List every string changed with its
before and after in both languages.

---

## Task 3: Make Arabic render correctly

**Files:** `src/index.css`, `src/pages/Login.tsx`, `src/pages/Signup.tsx`,
`src/lib/translations.ts`

1. **Letter-spacing is applied to Arabic text store-wide.** Arabic is cursive;
   `letter-spacing` severs the joins so words render as disconnected glyphs.
   `index.css:92-104` already neutralises this for `.text-zen` and `:64-74` for
   headings, but nothing neutralises Tailwind's `tracking-*` utilities, which
   appear on Arabic strings in at least 56 places across `Home.tsx`, `Shop.tsx`,
   `ProductDetail.tsx`, `ProductCard.tsx`, `Layout.tsx`, `Cart.tsx`,
   `Checkout.tsx`, `CheckoutSuccess.tsx`, `CheckoutFailed.tsx`, `Login.tsx`,
   `Signup.tsx` and `Account.tsx` - including the announcement bar at 0.25em,
   the navigation, every button, product names, form labels and the pay button.
   Fix this in CSS, at the root, rather than editing 56 call sites. Be careful
   not to kill letter-spacing for Latin text inside an Arabic page (brand names,
   prices, sizes are Latin), and say in your report how you handled that.
2. **Login and Signup force email and password into RTL.** `Login.tsx:54, 66`
   and `Signup.tsx:61, 73, 86` set `dir={lang === 'ar' ? 'rtl' : 'ltr'}`.
   `Checkout.tsx:323-324` already does this correctly for phone and email, with
   a comment explaining why. Carry that fix across.
3. **Brand voice that becomes nonsense in Arabic.** `checkoutFailed`
   (`translations.ts:353` / `:1210`) is "حدث شيء هادئ لدينا", and
   `checkoutTerms` renders "سياسة الإرجاع الهادئة" ("the quiet returns policy").
   Rewrite these so they read as natural Arabic. Look for others in the same
   voice while you are in the file.
4. `translations.ts:1147` pluralises Arabic with an English shape
   (`n === 1 ? 'قطعة' : 'قطع'`), so it renders "2 قطع" where Arabic needs the
   dual, and "15 قطع" where Arabic reverts to the singular. Fix the ones that
   are user-visible.

**Verification:** `pnpm build`, `pnpm lint`, and parity by key name. State how
you verified Latin text inside Arabic pages kept its spacing.

---

## Task 4: Make every landing page section work

**Files:** `src/pages/Home.tsx`, `src/components/ShoeShowcase3D.tsx`,
`src/pages/admin/AdminHomepage.tsx`, possibly a new section component

The owner's instruction is that every section must work and be functional.
Measured in a real browser at 390x844: the page is 6047px tall, the showcase is
4090px of it (six full screens), and the first buyable product is about 4100px
down.

1. **The hero is disabled** (`site_content.hero.enabled` is false), so the page
   has no hero, no `<h1>`, no value proposition, no search entry and no category
   entry. Determine why it is off, make the hero good enough to switch on, and
   switch it on. It must work with the owner's real content.
2. **The brand bar is disabled** (`categories_strip.enabled` is false), so 22
   brands with logos appear nowhere. Brand is the primary shopping axis for a
   multi-brand shoe store. Make it work and switch it on.
3. **Testimonials render nowhere.** There is an admin tab and rows in the
   `testimonials` table, and no consumer outside the admin. Either render them
   on the landing page or remove the editor - decide, and justify. Note the
   current rows are seeded English demo content, so whatever you build must look
   right when the owner replaces them with Arabic.
4. **`site_content.atelier` is orphaned**: content exists, no editor, no
   consumer. Decide whether to render it or drop it, and justify.
5. **The showcase is six viewports for five shoes.** Its height is
   `itemCount * 100vh` (`ShoeShowcase3D.tsx:169`). Cut the scroll cost hard.
   Also: the shoe image and the product title are `pointer-events-none` so the
   biggest tap targets on the page do nothing, and the one working CTA is a raw
   `<a href>` that triggers a full page reload instead of a router `Link`.
6. **On mobile the showcase text overlaps the product image.** Measured at
   390x844, scroll 0: the eyebrow, price, description and CTA all render inside
   the image's bounds with no scrim. This is the first impression on the
   dominant device. Fix the mobile layout.
7. **The showcase and the curated grid show the same five products**, because
   both pull featured-then-recent. Of 118 products the homepage exposes five.
   Make them show different things.
8. **The countdown is fabricated.** `Home.tsx:29` defaults to now plus three
   days whenever no real target resolves, and being `useState`-initialised it
   resets on every page load and never expires. A permanent fake urgency timer
   is a dark pattern: either drive it from a real date or do not render it.
9. The homepage has no error state: a failed catalog fetch renders an empty
   curated grid forever. Use `LoadErrorPanel`.

Design guidance: do NOT redesign the brand. The store has an established
identity (cream ground, gold `#B8860B`, display serif, Arabic-first). This task
is about making existing sections work, cutting dead weight, and getting a
customer to a product faster.

**Verification:** `pnpm build`, `pnpm lint`. State the new page height and the
scroll distance to the first buyable product, at 390x844.

---

## Task 5: Let a guest find their order

**Files:** `src/pages/CheckoutSuccess.tsx`, `src/pages/CheckoutFailed.tsx`,
`src/App.tsx`, possibly a new page, `supabase/functions/order-status/index.ts`

A guest cannot retrieve an order. `CheckoutSuccess.tsx:187-192` links to
`/account`, which is behind `ProtectedRoute`, so a guest is bounced to `/login`
with no explanation. There is no lookup-by-reference route. The only record of
the purchase is a 26-character reference (`BOM-1789123456789-4F2A9C1B`) rendered
once, in the smallest lowest-contrast text on the page, with no copy button.

1. Make the order reference prominent and copyable on both the success and
   failed pages.
2. Give a guest a way to check their order later. An `order-status` edge
   function already exists and returns only `{ status, paymentStatus,
   paymentMethod }` for a reference. Decide the safest design: the reference is
   the capability, so consider what an attacker with a guessed reference learns,
   and do not widen what the endpoint returns without saying why.
3. Do not link a guest to `/account`. Show them what is actually useful.
4. **A card decline should offer Cash on Delivery.** `CheckoutFailed.tsx:27-32`
   only offers "try again" back to checkout. The basket is deliberately
   preserved, so the offer is the only missing piece, and COD is the payment
   method most of these customers prefer anyway.
5. **Contacting the store about an order should carry the reference.** The
   WhatsApp button builds a fixed generic message
   (`WhatsAppButton.tsx:46-47`). On the success, pending and failed states,
   offer a WhatsApp action that prefills the order reference so the owner is not
   asking "which order?" every time.
6. The success page promises "a confirmation has been sent to your inbox" even
   when the customer gave no email (email is optional). Only say it when true.
7. For a COD order, the most useful sentence on the success page is the amount
   to have ready in cash. Currently the page shows no total at all.

**Verification:** `pnpm build`, `pnpm lint`. Describe exactly what a guest sees
and can do after a COD order, after a card success, and after a card decline.

---

## Task 6: Make the forms usable on a phone

**Files:** `src/pages/Checkout.tsx`, `src/pages/Login.tsx`,
`src/pages/Signup.tsx`, `src/pages/Cart.tsx`, `src/index.css`

1. **Every input is 14px, so iOS zooms on focus and does not zoom back.** All
   fields use `text-sm`. Fix at the CSS root so inputs are at least 16px on
   touch devices, without blowing up the desktop design.
2. **There is no autofill anywhere in the app**: zero `autoComplete` and zero
   `name` attributes across `src/pages` and `src/components`. The `Field`
   component (`Checkout.tsx:507-534`) accepts neither. A returning customer
   should be able to fill name, phone, address and city from their saved contact
   card in one tap. Add the right `autoComplete` tokens and input modes.
3. **Phone input is unguided.** `Checkout.tsx:323` is a bare `type="tel"` with no
   placeholder, no `inputMode`, no pattern and no hint about `01...` versus
   `+20...`. The courier calls this number and a mistyped one is a failed
   delivery.
4. **A returning customer retypes their whole address.** Nothing reads their
   last order and nothing is cached locally. Decide the smallest honest fix and
   justify it. Do not store anything sensitive where it does not belong.
5. Validation errors name no field: one generic toast, no `aria-invalid`, no
   inline message, no focus move. Tell the customer which field and why, in
   Arabic.

**Verification:** `pnpm build`, `pnpm lint`. List every field with the
`autoComplete` token you gave it.

---

## Task 7: Fix the cart and checkout experience

**Files:** `src/pages/Cart.tsx`, `src/pages/Checkout.tsx`,
`src/contexts/CartContext.tsx`

1. **Cash on Delivery is not the default and is listed second**, in a market
   where it is the majority. `Checkout.tsx:61` initialises to `'online'`.
2. **The payment section's intro contradicts the COD option.**
   `Checkout.tsx:372-374` renders "You will be redirected to Kashier" ABOVE both
   choices, so a customer choosing cash reads that they will be sent to a card
   gateway.
3. **On a phone the checkout button sits below every cart line.**
   `Cart.tsx:146` stacks the summary after all items. With ten items that is
   roughly four screens past things the customer already decided to buy.
4. **The cart never mentions Cash on Delivery.** Its only reassurance line talks
   exclusively about card payment.
5. **Shipping is "calculated at checkout" with no number and no range**, so the
   customer must fill in name, phone and address before learning the cost. Put
   the price in the governorate option labels too, so the control that raises the
   question answers it.
6. Decrementing quantity from 1 silently deletes the line, with no undo, while
   "clear basket" is correctly confirmed. The smaller, likelier mistake is
   unprotected.
7. "Your basket was updated" does not say what changed. An unexplained change
   immediately before paying is a trust event.
8. No delivery estimate anywhere in the flow, and the terms and returns text is
   not a link even though `/policies` exists and is routed.

**Verification:** `pnpm build`, `pnpm lint`. State the field count and the
number of taps for a COD purchase, before and after.

---

## Task 8: Fix the shop and product pages

**Files:** `src/pages/Shop.tsx`, `src/pages/ProductDetail.tsx`,
`src/components/ProductCard.tsx`, `src/components/Layout.tsx`, and one migration

1. **The category filter desyncs from the URL.** `Shop.tsx:19, 23` holds
   `category` in state seeded once from params, while `search`, `brand` and
   `sale` are read live. So every category link in the footer does nothing if
   the customer is already on the Shop page, and browser back and forward across
   category URLs do not work.
2. **The empty state's only button does not clear most filters.**
   `Shop.tsx:365-374` offers a button that resets the category, but the grid is
   usually empty because of colour, size, price or brand filters. Give it a real
   clear-all, and show which filters are active.
3. **The size and colour filters match out-of-stock variants.**
   `available_sizes` and `available_colors` in `product_catalog` aggregate every
   variant with no stock predicate, unlike `min_price`/`max_price` on the same
   lines which correctly use `filter (where pv.stock > 0)`. Fix in a migration
   (`20260814000000`). Note only 2 of 316 variant rows are currently out of
   stock, so this is prevention, not an emergency.
4. **Filters are always fully expanded on mobile** and push the grid below the
   fold: every colour and every size in the catalog, wrapping, before the first
   product. Give them a collapse or a drawer, and an active-filter summary.
5. **Search is desktop-only in the header** (`hidden md:flex`), so on a phone it
   costs hamburger, scroll, tap, type. With 118 products and 22 brands, search
   is the fastest path to purchase.
6. **`ProductDetail.tsx:582` renders the raw category key**, untranslated, while
   every other surface routes it through `categoryLabel()`.
7. **There is no size guide anywhere**, across 22 brands, and no returns
   reassurance on the product page. This is the top cause of shoe cart
   abandonment and of returns, and returns are the expensive half for a solo
   operator. Build something honest and useful, or state plainly why not.
8. **The product page shows no stock signal and no delivery estimate**, though
   the grid card shows "only N left". Out-of-stock sizes are greyed with no
   explanation.
9. `ProductCard.tsx:81-85` paints a sold-out overlay from `total_stock === 0`,
   which the view coalesces from a missing variant aggregate.
   `QuickViewModal.tsx:116-120` and `ProductDetail.tsx:318` both already fall
   back to `products.stock` with comments naming this exact bug. Currently zero
   products are affected, so fix it as prevention.
10. Quick-view and quick-add are 34px targets sitting 8px apart inside the
    card's link, both relying on `preventDefault`. A missed tap navigates
    instead of adding.

**Verification:** `pnpm build`, `pnpm lint`, plus `node --test` for any pure
helper you extract. Confirm the migration sorts after `20260813000000` and does
not change what any existing product costs.
