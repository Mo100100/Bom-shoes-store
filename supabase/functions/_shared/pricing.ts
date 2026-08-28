// Shared cart-pricing + coupon-evaluation logic used by both create-order
// and validate-coupon, so the two edge functions can never compute a
// different price, subtotal, or discount for the same cart/coupon. Every
// function here expects a service-role client (RLS bypassed) -- callers must
// never forward these results to a client without having recomputed
// server-side first.

import type { SupabaseClient } from 'npm:@supabase/supabase-js@2'

export type CartItemInput = {
  product_id: string
  size: string
  color: string
  quantity: number
}

export type ResolvedOrderItem = {
  product_id: string
  variant_id: string
  name: string
  size: string
  color: string
  quantity: number
  price: number
  image_url: string | null
}

export type ResolvedProduct = {
  id: string
  name: string
  price: number
  image_url: string | null
  category: string | null
}

export type PricingResult =
  | { ok: true; items: ResolvedOrderItem[]; subtotal: number; productById: Map<string, ResolvedProduct> }
  | { ok: false; error: string }

// Key for matching a cart line to its product_variants row -- size/color are
// matched exactly (case-sensitive) against what's stored, same as the
// unique(product_id, size, color) constraint on the table.
function variantKey(productId: string, size: string, color: string): string {
  return `${productId}::${size}::${color}`
}

// Resolves every cart line to its real product + product_variants row,
// building the authoritative order-item snapshot (with variant_id + real
// price) and cart subtotal. Never trusts client-sent price/name/stock.
//
// Factored out of create-order verbatim -- behavior is unchanged from the
// original implementation, including the "fail the line with a clear error
// if no matching variant" rule and the non-authoritative stock UX check.
export async function resolveCartPricing(
  admin: SupabaseClient,
  items: CartItemInput[],
): Promise<PricingResult> {
  const productIds = [...new Set(items.map(i => i.product_id))]

  const { data: products, error: productsError } = await admin
    .from('products')
    .select('id, name, price, image_url, category')
    .in('id', productIds)

  if (productsError) throw productsError

  const productById = new Map<string, ResolvedProduct>((products ?? []).map(p => [p.id, p]))

  const { data: variants, error: variantsError } = await admin
    .from('product_variants')
    .select('id, product_id, size, color, stock, price_override')
    .in('product_id', productIds)

  if (variantsError) throw variantsError

  const variantByKey = new Map((variants ?? []).map(v => [variantKey(v.product_id, v.size, v.color), v]))

  const orderItems: ResolvedOrderItem[] = []

  for (const item of items) {
    const product = productById.get(item.product_id)
    if (!product) {
      return { ok: false, error: `A product in your cart is no longer available` }
    }

    const variant = variantByKey.get(variantKey(item.product_id, item.size, item.color))
    if (!variant) {
      return { ok: false, error: `${product.name} is not available in size ${item.size} / ${item.color}` }
    }

    // Non-authoritative UX check only. The real, atomic stock gate is
    // fulfill_order() at payment-confirmation time -- this just gives the
    // user a fast, friendly error instead of a payment that later fails.
    if (variant.stock < item.quantity) {
      return {
        ok: false,
        error: `${product.name} (${item.size}/${item.color}) only has ${variant.stock} left in stock`,
      }
    }

    orderItems.push({
      product_id: product.id,
      variant_id: variant.id,
      name: product.name,
      size: item.size,
      color: item.color,
      quantity: item.quantity,
      price: variant.price_override ?? product.price,
      image_url: product.image_url,
    })
  }

  const subtotal = orderItems.reduce((sum, i) => sum + i.price * i.quantity, 0)

  return { ok: true, items: orderItems, subtotal, productById }
}

// ---------------------------------------------------------------------------
// Coupon / promotion evaluation
// ---------------------------------------------------------------------------

export type Coupon = {
  id: string
  code: string | null
  requires_code: boolean
  description: string | null
  discount_type: 'percentage' | 'fixed' | 'free_shipping' | 'buy_x_get_y'
  discount_value: number
  min_order_amount: number | null
  max_discount_amount: number | null
  usage_limit: number | null
  per_customer_limit: number | null
  starts_at: string | null
  ends_at: string | null
  active: boolean
  target_type: 'all' | 'category' | 'products'
  target_category: string | null
  target_product_ids: string[]
  // Buy-X-get-Y fields -- only meaningful when discount_type = 'buy_x_get_y'.
  // The "buy" and "get" pools are the SAME target_type/target_category/
  // target_product_ids scope above, deliberately -- one targeting mechanism,
  // not a second one (see computeBxgyDiscount).
  buy_quantity: number | null
  get_quantity: number | null
  get_discount_percent: number | null
  // When true, this coupon/promotion may combine with an independently
  // qualifying bundle discount (see resolveBestDiscount's precedence rule).
  stackable: boolean
}

export type CouponEvalContext = {
  subtotal: number
  items: CartItemInput[]
  productById: Map<string, ResolvedProduct>
  // The same cart, already resolved to real per-line prices (price_override
  // ?? product base price) -- needed by BXGY (computeBxgyDiscount) and
  // bundles (findBestBundle), which discount specific *units* rather than
  // just the cart-level subtotal. Both create-order and validate-coupon
  // already have this from resolveCartPricing, so it's always supplied.
  resolvedItems: ResolvedOrderItem[]
  // The signed-in customer, read from the caller's already-verified JWT (see
  // _shared/auth.ts). null for a guest. This is the ONLY identity
  // per_customer_limit is counted against -- the customer email it used to
  // use is optional at checkout and never verified, so a blank one skipped
  // the limit entirely and any value at all could be invented.
  userId?: string | null
  // Only known by create-order (validate-coupon has no shipping context).
  // Defaults to 0, which is also what makes free_shipping's discountAmount
  // correctly read as 0 from validate-coupon's response.
  shippingCost?: number
}

// Every "no" that would otherwise tell the caller a code EXISTS shares one
// reason: not found, inactive, not started, expired, out of scope for this
// cart, usage limit reached. Distinguishing them turned validate-coupon into
// an oracle over the whole code space, and a customer never needs to know
// which of them it was. The two rejections below stay distinct because they
// tell the customer something they can act on.
export type CouponRejectionCode = 'unavailable' | 'min_order' | 'sign_in_required'

export type CouponRejection = {
  reasonCode: CouponRejectionCode
  reason: string
  // Only on 'min_order', so the storefront can show the real figure in the
  // customer's own language and currency format.
  minOrderAmount?: number
}

export const COUPON_UNAVAILABLE: CouponRejection = {
  reasonCode: 'unavailable',
  reason: 'This code cannot be applied to your cart',
}

// Coupon codes are stored upper case (see the coupons_code_upper_check
// constraint in the 20260807000000 migration and AdminCoupons' save), so
// `save20` and `SAVE20` are the same code instead of one working and one
// silently failing.
export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase()
}

// Does this single cart item fall within a coupon's target scope? Shared by
// getBasicEligibility (does ANY item match, for whole-order discounts) and
// computeBxgyDiscount (which items individually qualify as "buy"/"get"
// units) so the two can never disagree about what a coupon targets.
function itemMatchesCouponTarget(
  coupon: Pick<Coupon, 'target_type' | 'target_category' | 'target_product_ids'>,
  productId: string,
  productById: Map<string, ResolvedProduct>,
): boolean {
  if (coupon.target_type === 'category') return productById.get(productId)?.category === coupon.target_category
  if (coupon.target_type === 'products') return coupon.target_product_ids.includes(productId)
  return true // 'all'
}

export async function findCouponByCode(admin: SupabaseClient, code: string): Promise<Coupon | null> {
  const { data, error } = await admin
    .from('coupons')
    .select('*')
    .eq('code', normalizeCouponCode(code))
    .eq('requires_code', true)
    .maybeSingle()

  if (error) throw error
  return (data as Coupon | null) ?? null
}

// active / date-range / min-order / targeting checks -- shared by the
// explicit-code path and the auto-promotion path. Does NOT check
// usage_limit/per_customer_limit; see checkUsageLimits for that (auto
// promotions deliberately skip it, per spec -- they have no customer-typed
// code to throttle abuse of).
export function getBasicEligibility(
  coupon: Coupon,
  ctx: CouponEvalContext,
): { ok: true } | { ok: false; rejection: CouponRejection } {
  // Inactive, not started yet and expired all share COUPON_UNAVAILABLE: each
  // of them would otherwise confirm the code exists. See CouponRejectionCode.
  if (!coupon.active) {
    return { ok: false, rejection: COUPON_UNAVAILABLE }
  }

  const now = Date.now()
  if (coupon.starts_at && now < new Date(coupon.starts_at).getTime()) {
    return { ok: false, rejection: COUPON_UNAVAILABLE }
  }
  if (coupon.ends_at && now > new Date(coupon.ends_at).getTime()) {
    return { ok: false, rejection: COUPON_UNAVAILABLE }
  }
  // Deliberately NOT merged into COUPON_UNAVAILABLE: "spend 200 more and this
  // works" is the one rejection that is worth money to the store, so it keeps
  // its own message and its figure. The residual leak is narrow and is
  // covered by the rate limit: it only ever confirms the existence of codes
  // that carry a minimum, and only to a caller who is already inside the
  // per-IP ceiling in ../_shared/rate-limit.ts.
  if (coupon.min_order_amount != null && ctx.subtotal < coupon.min_order_amount) {
    return {
      ok: false,
      rejection: {
        reasonCode: 'min_order',
        reason: `This coupon requires a minimum order of ${coupon.min_order_amount}`,
        minOrderAmount: coupon.min_order_amount,
      },
    }
  }

  // Targeting semantics (deliberate simplification, documented per task):
  // whole-order discount if ANY cart line matches the target category/product
  // list -- not prorated to just the matching lines' subtotal. Simpler to
  // reason about and to show the customer ("10% off your order"); switch this
  // block (and computeDiscount's subtotal input) to a per-matching-line sum
  // if per-line proration is ever actually needed. (BXGY, below, is the one
  // discount_type that DOES need per-item matching -- see
  // itemMatchesCouponTarget/computeBxgyDiscount.)
  if (coupon.target_type !== 'all') {
    const matches = ctx.items.some(i => itemMatchesCouponTarget(coupon, i.product_id, ctx.productById))
    if (!matches) return { ok: false, rejection: COUPON_UNAVAILABLE }
  }

  return { ok: true }
}

export type RedemptionCounts = Map<string, { total: number; customer: number }>

// One grouped count covering EVERY candidate coupon (public.
// coupon_redemption_counts), rather than one or two COUNT queries per coupon
// from inside an eligibility loop -- the query count no longer grows with the
// number of active promotions. Coupons with neither limit set are left out of
// the call, and a call with nothing left to count is skipped entirely, so the
// ordinary cart pays nothing for this.
export async function fetchRedemptionCounts(
  admin: SupabaseClient,
  coupons: Coupon[],
  userId: string | null,
): Promise<RedemptionCounts> {
  const counts: RedemptionCounts = new Map()

  const ids = coupons.filter(c => c.usage_limit != null || c.per_customer_limit != null).map(c => c.id)
  if (ids.length === 0) return counts

  const { data, error } = await admin.rpc('coupon_redemption_counts', {
    p_coupon_ids: ids,
    p_user_id: userId,
  })
  if (error) throw error

  // count() is bigint, which some drivers hand back as a string.
  for (const row of (data ?? []) as Array<{ coupon_id: string; total_count: number; customer_count: number }>) {
    counts.set(row.coupon_id, { total: Number(row.total_count), customer: Number(row.customer_count) })
  }
  return counts
}

// usage_limit / per_customer_limit against counts already fetched above (see
// task notes: a best-effort count, an accepted race-tolerant tradeoff rather
// than a hard distributed lock -- a coupon-limit race has no inventory
// consequence, unlike stock).
//
// per_customer_limit is enforced against the AUTHENTICATED user id only. It
// used to be counted against the customer's email, which is optional at
// checkout and never verified: leaving it blank skipped the check and gave
// unlimited redemptions, and filling in another address reset the count. So a
// coupon that limits redemptions per customer now needs a customer we can
// actually identify, and is refused outright for a guest rather than quietly
// granted. That refusal is deliberately its own message, since "sign in" is
// something the customer can act on.
export function checkUsageLimits(
  coupon: Coupon,
  counts: RedemptionCounts,
  userId: string | null,
): { ok: true } | { ok: false; rejection: CouponRejection } {
  const count = counts.get(coupon.id)

  if (coupon.usage_limit != null && (count?.total ?? 0) >= coupon.usage_limit) {
    return { ok: false, rejection: COUPON_UNAVAILABLE }
  }

  if (coupon.per_customer_limit != null) {
    if (!userId) {
      return {
        ok: false,
        rejection: { reasonCode: 'sign_in_required', reason: 'Please sign in to use this code' },
      }
    }
    if ((count?.customer ?? 0) >= coupon.per_customer_limit) {
      return { ok: false, rejection: COUPON_UNAVAILABLE }
    }
  }

  return { ok: true }
}

// percentage -> % of subtotal, capped at max_discount_amount if set, and
//   never more than the subtotal itself.
// fixed -> the flat amount, capped at the subtotal itself so it can't go
//   negative.
// free_shipping -> no subtotal discount; the caller-supplied shippingCost
//   (0 by default) is the actual amount waived -- see CouponEvalContext.
// buy_x_get_y -> delegates to computeBxgyDiscount, which needs the resolved
//   per-line cart (ctx.resolvedItems) to discount specific units rather than
//   the subtotal as a whole.
export function computeDiscount(
  coupon: Coupon,
  ctx: CouponEvalContext,
): { discountAmount: number; freeShipping: boolean } {
  if (coupon.discount_type === 'percentage') {
    // discount_value is constrained to 0..100 in the database (see the
    // 20260807000000 migration) and clamped again here, the same way
    // computeBxgyDiscount already clamps get_discount_percent. Without it a
    // typo of 150 discounted 1.5x the subtotal and posted a NEGATIVE amount
    // to Kashier, which hard-breaks checkout. The final Math.min against the
    // subtotal makes that impossible for any discount_value at all, whatever
    // a legacy row or a direct SQL edit holds.
    const percent = Math.max(0, Math.min(100, coupon.discount_value)) / 100
    const raw = ctx.subtotal * percent
    const capped = coupon.max_discount_amount != null ? Math.min(raw, coupon.max_discount_amount) : raw
    return { discountAmount: Math.max(0, Math.min(capped, ctx.subtotal)), freeShipping: false }
  }

  if (coupon.discount_type === 'fixed') {
    return { discountAmount: Math.max(0, Math.min(coupon.discount_value, ctx.subtotal)), freeShipping: false }
  }

  if (coupon.discount_type === 'buy_x_get_y') {
    return { discountAmount: computeBxgyDiscount(coupon, ctx.resolvedItems, ctx.productById), freeShipping: false }
  }

  return { discountAmount: Math.max(0, ctx.shippingCost ?? 0), freeShipping: true }
}

export type CouponEvalResult =
  | {
      valid: true
      coupon: Coupon
      discountAmount: number
      discountType: Coupon['discount_type']
      description: string | null
      freeShipping: boolean
    }
  | ({ valid: false } & CouponRejection)

// Full validation for a customer-typed code: lookup (requires_code = true
// only -- this is not for auto-promotions), active/date/min-order/targeting,
// usage limits, then the discount. Used by both validate-coupon and
// create-order's explicit-couponCode path so they can never disagree.
export async function evaluateCouponByCode(
  admin: SupabaseClient,
  code: string,
  ctx: CouponEvalContext,
): Promise<CouponEvalResult> {
  const coupon = await findCouponByCode(admin, code)
  // Deliberately the same rejection a real-but-unusable code gets: telling
  // the two apart is what made this an enumeration oracle.
  if (!coupon) {
    return { valid: false, ...COUPON_UNAVAILABLE }
  }

  const basic = getBasicEligibility(coupon, ctx)
  if (!basic.ok) return { valid: false, ...basic.rejection }

  const userId = ctx.userId ?? null
  const counts = await fetchRedemptionCounts(admin, [coupon], userId)
  const usage = checkUsageLimits(coupon, counts, userId)
  if (!usage.ok) return { valid: false, ...usage.rejection }

  const { discountAmount, freeShipping } = computeDiscount(coupon, ctx)

  return {
    valid: true,
    coupon,
    discountAmount,
    discountType: coupon.discount_type,
    description: coupon.description,
    freeShipping,
  }
}

// Finds the single best currently-active auto-apply promotion (requires_code
// = false) for this cart -- active/date/min-order/targeting checks only, no
// usage limits (see getBasicEligibility's doc comment for why) and no code
// lookup. "Best" = highest discountAmount once every candidate's shipping
// context (if any) is applied; resolveBestDiscount compares this against the
// explicit-code discount and applies whichever is larger.
//
// Excludes discount_type = 'buy_x_get_y' -- BXGY promotions are their own
// independent candidate group (see findBestAutoBxgyPromotion), not compared
// head-to-head with percentage/fixed/free_shipping here. See
// resolveBestDiscount's precedence-rule comment for why.
export async function findBestAutoPromotion(
  admin: SupabaseClient,
  ctx: CouponEvalContext,
): Promise<{ coupon: Coupon; discountAmount: number; freeShipping: boolean } | null> {
  const { data, error } = await admin.from('coupons').select('*').eq('requires_code', false).eq('active', true)

  if (error) throw error

  let best: { coupon: Coupon; discountAmount: number; freeShipping: boolean } | null = null

  for (const coupon of (data ?? []) as Coupon[]) {
    if (coupon.discount_type === 'buy_x_get_y') continue
    if (!getBasicEligibility(coupon, ctx).ok) continue

    const { discountAmount, freeShipping } = computeDiscount(coupon, ctx)
    if (!best || discountAmount > best.discountAmount) {
      best = { coupon, discountAmount, freeShipping }
    }
  }

  return best
}

// Same as findBestAutoPromotion, but for the OTHER independent candidate
// group: auto-apply (requires_code = false) buy_x_get_y promotions only.
// Per the task spec, BXGY coupons also get their usage_limit/
// per_customer_limit enforced even when auto-applied (unlike the
// percentage/fixed/free_shipping auto-promotions above, which deliberately
// skip that check -- see getBasicEligibility's doc comment) since a BXGY
// promo can reasonably be capped ("first 100 orders").
export async function findBestAutoBxgyPromotion(
  admin: SupabaseClient,
  ctx: CouponEvalContext,
): Promise<{ coupon: Coupon; discountAmount: number } | null> {
  const { data, error } = await admin
    .from('coupons')
    .select('*')
    .eq('requires_code', false)
    .eq('active', true)
    .eq('discount_type', 'buy_x_get_y')

  if (error) throw error

  let best: { coupon: Coupon; discountAmount: number } | null = null

  // Eligibility first, then ONE grouped redemption count for whatever
  // survives it. This used to await one or two COUNT queries per coupon from
  // inside the loop, so the query count grew with the number of active BXGY
  // promotions; it is now two queries in total however many there are.
  const userId = ctx.userId ?? null
  const candidates = ((data ?? []) as Coupon[]).filter(coupon => getBasicEligibility(coupon, ctx).ok)
  const counts = await fetchRedemptionCounts(admin, candidates, userId)

  for (const coupon of candidates) {
    if (!checkUsageLimits(coupon, counts, userId).ok) continue

    const { discountAmount } = computeDiscount(coupon, ctx)
    if (!best || discountAmount > best.discountAmount) {
      best = { coupon, discountAmount }
    }
  }

  return best
}

// ---------------------------------------------------------------------------
// Buy-X-get-Y
// ---------------------------------------------------------------------------

// Expands each resolved cart line that falls within a coupon's target scope
// into one entry per unit (a line of quantity 3 at $50 becomes three $50
// entries) -- the unit, not the cart line, is BXGY's unit of discounting.
function expandQualifyingUnitPrices(
  coupon: Pick<Coupon, 'target_type' | 'target_category' | 'target_product_ids'>,
  items: ResolvedOrderItem[],
  productById: Map<string, ResolvedProduct>,
): number[] {
  const prices: number[] = []
  for (const item of items) {
    if (!itemMatchesCouponTarget(coupon, item.product_id, productById)) continue
    for (let i = 0; i < item.quantity; i++) prices.push(item.price)
  }
  return prices
}

// "Buy buy_quantity, get get_quantity at get_discount_percent off" -- the
// buy/get pool is the SAME target scope (target_type/target_category/
// target_product_ids), not a separate buy-collection vs get-collection (see
// the Coupon type's doc comment). Complete sets = floor(qualifying units /
// (buy_quantity + get_quantity)); each complete set discounts get_quantity
// units. Standard, customer-favorable convention: discount the CHEAPEST
// qualifying units, not the most expensive ones or an arbitrary subset.
export function computeBxgyDiscount(
  coupon: Coupon,
  items: ResolvedOrderItem[],
  productById: Map<string, ResolvedProduct>,
): number {
  if (coupon.discount_type !== 'buy_x_get_y') return 0
  if (!coupon.buy_quantity || !coupon.get_quantity || coupon.get_discount_percent == null) return 0

  const setSize = coupon.buy_quantity + coupon.get_quantity
  const unitPrices = expandQualifyingUnitPrices(coupon, items, productById)
  const sets = Math.floor(unitPrices.length / setSize)
  if (sets <= 0) return 0

  unitPrices.sort((a, b) => a - b)
  const discountedUnitCount = sets * coupon.get_quantity
  const cheapestUnits = unitPrices.slice(0, discountedUnitCount)

  const percent = Math.max(0, Math.min(100, coupon.get_discount_percent)) / 100
  return cheapestUnits.reduce((sum, price) => sum + price * percent, 0)
}

// ---------------------------------------------------------------------------
// Bundles
// ---------------------------------------------------------------------------

export type Bundle = {
  id: string
  name: string
  description: string | null
  discount_type: 'percentage' | 'fixed'
  discount_value: number
  active: boolean
  created_at: string
}

export type BundleItem = {
  id: string
  bundle_id: string
  product_id: string
  quantity: number
}

export type BundleWithItems = Bundle & { items: BundleItem[] }

// Fetches every active bundle plus its required items in two round trips
// (not N+1) -- same shape of query as resolveCartPricing's
// products/product_variants pair above.
export async function fetchActiveBundlesWithItems(admin: SupabaseClient): Promise<BundleWithItems[]> {
  const { data: bundles, error: bundlesError } = await admin.from('bundles').select('*').eq('active', true)
  if (bundlesError) throw bundlesError
  if (!bundles || bundles.length === 0) return []

  const { data: items, error: itemsError } = await admin
    .from('bundle_items')
    .select('*')
    .in(
      'bundle_id',
      bundles.map(b => b.id),
    )
  if (itemsError) throw itemsError

  const itemsByBundle = new Map<string, BundleItem[]>()
  for (const item of (items ?? []) as BundleItem[]) {
    const arr = itemsByBundle.get(item.bundle_id) ?? []
    arr.push(item)
    itemsByBundle.set(item.bundle_id, arr)
  }

  return (bundles as Bundle[]).map(b => ({ ...b, items: itemsByBundle.get(b.id) ?? [] }))
}

// Finds the single best-savings bundle the cart currently satisfies.
// Matches by product_id only (not size/color -- bundles are product-level).
// Only a bundle's REQUIRED quantity of each product counts toward its own
// price/savings math; any extra units of that product are priced normally
// and left alone. When the same product_id appears in the cart at more than
// one price point (e.g. two variants with different price_override), which
// units get "consumed" by the bundle is chosen to maximize the bundle's own
// savings (customer-favorable, rather than leaving it to depend on cart line
// order) -- see the per-discount_type comment inline below for exactly which
// units that means for 'percentage' vs 'fixed'.
// If more than one bundle is simultaneously satisfiable, only the single
// bundle with the highest savings is returned -- two bundles can never both
// claim a discount on the same product.
export function findBestBundle(
  items: ResolvedOrderItem[],
  bundles: BundleWithItems[],
): { bundle: Bundle; discountAmount: number; requiredByProduct: Map<string, number> } | null {
  const unitPricesByProduct = new Map<string, number[]>()
  for (const item of items) {
    const arr = unitPricesByProduct.get(item.product_id) ?? []
    for (let i = 0; i < item.quantity; i++) arr.push(item.price)
    unitPricesByProduct.set(item.product_id, arr)
  }

  let best: { bundle: Bundle; discountAmount: number; requiredByProduct: Map<string, number> } | null = null

  for (const bundle of bundles) {
    if (!bundle.active || bundle.items.length === 0) continue

    // Collapse to one required quantity per product_id first -- guards
    // against a bundle admin accidentally saving two bundle_items rows for
    // the same product (no unique constraint enforces one row each), which
    // would otherwise double-count the same cart units against both rows.
    const requiredByProduct = new Map<string, number>()
    for (const required of bundle.items) {
      requiredByProduct.set(required.product_id, (requiredByProduct.get(required.product_id) ?? 0) + required.quantity)
    }

    let regularPrice = 0
    let satisfied = true

    for (const [productId, requiredQuantity] of requiredByProduct) {
      const units = unitPricesByProduct.get(productId) ?? []
      if (units.length < requiredQuantity) {
        satisfied = false
        break
      }
      // Which units get "consumed" by the bundle only matters when a
      // product has more than one price point in the cart (different
      // variants). Percentage discounts are maximized -- genuinely
      // customer-favorable, per the function's own convention -- by
      // consuming the MOST expensive units first, since the discount is a
      // % of whichever units get assigned. Fixed discounts keep consuming
      // the cheapest first: regularPrice almost always exceeds
      // discount_value, which makes the choice immaterial there anyway.
      const ordered =
        bundle.discount_type === 'percentage' ? [...units].sort((a, b) => b - a) : [...units].sort((a, b) => a - b)
      for (let i = 0; i < requiredQuantity; i++) regularPrice += ordered[i]
    }

    if (!satisfied) continue

    const discountedPrice =
      bundle.discount_type === 'percentage'
        ? Math.max(0, regularPrice * (1 - bundle.discount_value / 100))
        : Math.max(0, regularPrice - bundle.discount_value)

    const discountAmount = Math.max(0, regularPrice - discountedPrice)
    if (discountAmount > 0 && (!best || discountAmount > best.discountAmount)) {
      best = { bundle, discountAmount, requiredByProduct }
    }
  }

  return best
}

// The amount actually charged. Rounded to cents so the stored total_amount
// and the amount string in the Kashier hash derive from one value (no float
// drift between them), and floored at 0 so no combination of discounts can
// ever post a negative amount to the gateway. Every discount above is already
// capped at the subtotal, so this floor is the last line of defence rather
// than the first.
export function computeOrderTotal(
  subtotal: number,
  shipping: number,
  tax: number,
  discountAmount: number,
): number {
  return Math.max(0, Math.round((subtotal + shipping + tax - discountAmount) * 100) / 100)
}

// ---------------------------------------------------------------------------
// Combining bundles, BXGY coupons, and regular coupons/promotions
// ---------------------------------------------------------------------------

export type DiscountResolution = {
  discountAmount: number
  freeShipping: boolean
  couponId: string | null
  bundleId: string | null
  discountType: Coupon['discount_type'] | 'bundle' | null
  description: string | null
}

// Sums a discount amount with a stacked bundle's, capped at the cart
// subtotal so the combined total can never go negative. Exact for
// percentage/fixed/free_shipping (subtotal-level discounts); buy_x_get_y
// needs the unit-overlap-aware wrapper below (combineCouponWithBundle)
// instead of calling this directly. Kept exported/shared so
// resolveBestDiscount (create-order) and validate-coupon's preview can never
// disagree on the sum itself, even though they arrive at it from different
// call shapes.
export function combineWithBundle(
  discountAmount: number,
  bundleMatch: { discountAmount: number } | null,
  subtotal: number,
): number {
  return bundleMatch ? Math.min(subtotal, discountAmount + bundleMatch.discountAmount) : discountAmount
}

// Removes a bundle's already-claimed units from a cart view, so a
// buy_x_get_y discount can be recomputed against only what's left -- see
// combineCouponWithBundle for why. Consumes the SAME price points, in the
// same order, that findBestBundle itself assumed for this bundle's
// discount_type (cheapest-first for 'fixed', most-expensive-first for
// 'percentage'), so the two never disagree about which physical units the
// bundle used.
function subtractBundleUnits(
  items: ResolvedOrderItem[],
  bundle: Pick<Bundle, 'discount_type'>,
  requiredByProduct: Map<string, number>,
): ResolvedOrderItem[] {
  const linesByProduct = new Map<string, ResolvedOrderItem[]>()
  for (const item of items) {
    const arr = linesByProduct.get(item.product_id) ?? []
    arr.push(item)
    linesByProduct.set(item.product_id, arr)
  }

  const result: ResolvedOrderItem[] = []
  for (const [productId, lines] of linesByProduct) {
    let toRemove = requiredByProduct.get(productId) ?? 0
    if (toRemove <= 0) {
      result.push(...lines)
      continue
    }
    const ordered =
      bundle.discount_type === 'percentage'
        ? [...lines].sort((a, b) => b.price - a.price)
        : [...lines].sort((a, b) => a.price - b.price)
    for (const line of ordered) {
      const removeFromLine = Math.min(line.quantity, toRemove)
      toRemove -= removeFromLine
      const remainingQuantity = line.quantity - removeFromLine
      if (remainingQuantity > 0) result.push({ ...line, quantity: remainingQuantity })
    }
  }

  return result
}

// Combines a coupon's own discount with a stacked bundle's. For
// percentage/fixed/free_shipping coupons this is exact -- they discount the
// subtotal as a whole, not specific units, so a plain sum (combineWithBundle)
// can't double-count anything.
//
// buy_x_get_y is different: it discounts specific UNITS, and so does a
// bundle's required quantity -- when they target overlapping units, naively
// summing both mechanisms' discounts credits the same physical units to
// both (e.g. a cart with only enough units to satisfy ONE mechanism would
// otherwise get credited for both). So for buy_x_get_y: recompute the BXGY
// discount against only the units the bundle's required quantities didn't
// already claim, then take whichever is larger -- the coupon's own
// (unreserved) amount, or bundle + the recomputed remainder. That keeps
// stacking a strict bonus (never worse than not stacking at all) while never
// double-crediting a unit to both mechanisms.
export function combineCouponWithBundle(
  coupon: Coupon,
  discountAmount: number,
  resolvedItems: ResolvedOrderItem[],
  productById: Map<string, ResolvedProduct>,
  bundleMatch: { bundle: Bundle; discountAmount: number; requiredByProduct: Map<string, number> } | null,
  subtotal: number,
): number {
  if (!bundleMatch) return discountAmount

  if (coupon.discount_type === 'buy_x_get_y') {
    const remainingItems = subtractBundleUnits(resolvedItems, bundleMatch.bundle, bundleMatch.requiredByProduct)
    const recomputed = computeBxgyDiscount(coupon, remainingItems, productById)
    const stacked = combineWithBundle(recomputed, bundleMatch, subtotal)
    return Math.max(discountAmount, stacked)
  }

  return combineWithBundle(discountAmount, bundleMatch, subtotal)
}

// The single top-level "what discount does this cart get" function. BOTH
// endpoints now call it: create-order to settle the REAL, charged total, and
// validate-coupon to preview it. They used to differ, which is exactly how
// the storefront ended up showing a total the receipt disagreed with whenever
// an auto-promotion or a bundle applied.
//
// One thing does NOT survive the preview, and validate-coupon compensates for
// it: winner-selection here requires discountAmount > 0 (so a free_shipping
// coupon worth nothing at the margin never burns a usage_limit slot -- see
// the (iii) block below), and validate-coupon has no real shippingCost to
// give (see CouponEvalContext), so a free_shipping candidate always nets a
// placeholder 0 there and can never win. The freeShipping BOOLEAN carries
// that signal instead; see validate-coupon for exactly how, and for the one
// remaining preview gap it leaves.
//
// Considers THREE independent candidates against the ORIGINAL cart:
//   (i)   the best bundle match (findBestBundle)
//   (ii)  the best buy_x_get_y coupon, explicit-code or auto-apply
//   (iii) the existing percentage/fixed/free_shipping result (best of
//         explicit-code vs auto-promotion, unchanged precedence)
//
// PRECEDENCE RULE (deliberate scoping decision, not an oversight): the
// winner is whichever SINGLE candidate has the largest discountAmount --
// UNLESS that winning candidate is a coupon (ii or iii) with stackable =
// true AND a bundle (i) *also* independently qualifies, in which case the
// two combine via combineCouponWithBundle (sum both discounts, capped at the
// cart subtotal so it can never go negative -- with a unit-overlap-safe
// recompute for buy_x_get_y specifically, see that function's doc comment).
// A bundle winning outright never goes looking for a stackable coupon to add
// on top of itself, and two bundles/two BXGY coupons/etc never stack with
// each other -- stacking is ONLY ever "one stackable coupon on top of one
// qualifying bundle". On an exact tie
// between the three top-level candidates, (iii) beats (ii) beats (i) --
// i.e. this engine's pre-existing percentage/fixed/free_shipping behavior
// is preserved as the default, and the newer mechanisms only take over when
// they're strictly better for the customer.
//
// `explicit` is the caller's own evaluateCouponByCode(...) result for
// whatever code (if any) the customer typed -- passed in rather than
// re-looked-up here so callers that also need the raw valid/reason (i.e.
// validate-coupon) only hit the DB once for it.
export async function resolveBestDiscount(
  admin: SupabaseClient,
  ctx: CouponEvalContext,
  explicit: CouponEvalResult | null,
): Promise<DiscountResolution> {
  const explicitValid = explicit && explicit.valid ? explicit : null
  const explicitRegular = explicitValid && explicitValid.coupon.discount_type !== 'buy_x_get_y' ? explicitValid : null
  const explicitBxgy = explicitValid && explicitValid.coupon.discount_type === 'buy_x_get_y' ? explicitValid : null

  const [autoRegular, autoBxgy, bundles] = await Promise.all([
    findBestAutoPromotion(admin, ctx),
    findBestAutoBxgyPromotion(admin, ctx),
    fetchActiveBundlesWithItems(admin),
  ])
  const bundleMatch = findBestBundle(ctx.resolvedItems, bundles)

  // (iii) percentage/fixed/free_shipping -- ties favor the explicit code,
  // since the customer took an action to enter it (unchanged precedent).
  let regular: { coupon: Coupon; discountAmount: number; freeShipping: boolean; description: string | null } | null = null
  if (
    explicitRegular &&
    explicitRegular.discountAmount > 0 &&
    (!autoRegular || explicitRegular.discountAmount >= autoRegular.discountAmount)
  ) {
    regular = {
      coupon: explicitRegular.coupon,
      discountAmount: explicitRegular.discountAmount,
      freeShipping: explicitRegular.freeShipping,
      description: explicitRegular.description,
    }
  } else if (autoRegular && autoRegular.discountAmount > 0) {
    regular = {
      coupon: autoRegular.coupon,
      discountAmount: autoRegular.discountAmount,
      freeShipping: autoRegular.freeShipping,
      description: autoRegular.coupon.description,
    }
  }

  // (ii) buy_x_get_y -- same explicit-vs-auto tie-break as (iii).
  let bxgy: { coupon: Coupon; discountAmount: number } | null = null
  if (
    explicitBxgy &&
    explicitBxgy.discountAmount > 0 &&
    (!autoBxgy || explicitBxgy.discountAmount >= autoBxgy.discountAmount)
  ) {
    bxgy = { coupon: explicitBxgy.coupon, discountAmount: explicitBxgy.discountAmount }
  } else if (autoBxgy && autoBxgy.discountAmount > 0) {
    bxgy = autoBxgy
  }

  // Pick the single top-level winner. Checked in (iii), (ii), (i) order so a
  // strict `>` (not `>=`) means an exact tie resolves in favor of the
  // earlier-checked group -- see the precedence-rule comment above.
  type Winner = 'regular' | 'bxgy' | 'bundle' | null
  let winner: Winner = null
  let winnerAmount = 0

  if (regular && regular.discountAmount > winnerAmount) {
    winner = 'regular'
    winnerAmount = regular.discountAmount
  }
  if (bxgy && bxgy.discountAmount > winnerAmount) {
    winner = 'bxgy'
    winnerAmount = bxgy.discountAmount
  }
  if (bundleMatch && bundleMatch.discountAmount > winnerAmount) {
    winner = 'bundle'
    winnerAmount = bundleMatch.discountAmount
  }

  if (winner === null) {
    return { discountAmount: 0, freeShipping: false, couponId: null, bundleId: null, discountType: null, description: null }
  }

  let discountAmount = winnerAmount
  let freeShipping = false
  let couponId: string | null = null
  let bundleId: string | null = null
  let discountType: DiscountResolution['discountType'] = null
  let description: string | null = null

  if (winner === 'regular') {
    couponId = regular!.coupon.id
    freeShipping = regular!.freeShipping
    discountType = regular!.coupon.discount_type
    description = regular!.description
  } else if (winner === 'bxgy') {
    couponId = bxgy!.coupon.id
    discountType = 'buy_x_get_y'
    description = bxgy!.coupon.description
  } else {
    bundleId = bundleMatch!.bundle.id
    discountType = 'bundle'
    description = bundleMatch!.bundle.name
  }

  // Stacking: ONLY when the winner is a coupon (regular or BXGY) that is
  // itself stackable, and a bundle independently qualifies too -- see the
  // precedence-rule comment above for why this never runs the other way
  // (a winning bundle never goes looking for a coupon to add on top).
  // combineCouponWithBundle handles the BXGY-vs-bundle unit-overlap case
  // (see its own doc comment); for regular coupons it's a plain sum.
  const winningCoupon = winner === 'regular' ? regular!.coupon : winner === 'bxgy' ? bxgy!.coupon : null
  if (winningCoupon?.stackable && bundleMatch) {
    bundleId = bundleMatch.bundle.id
    discountAmount = combineCouponWithBundle(winningCoupon, discountAmount, ctx.resolvedItems, ctx.productById, bundleMatch, ctx.subtotal)
  }

  return { discountAmount, freeShipping, couponId, bundleId, discountType, description }
}
