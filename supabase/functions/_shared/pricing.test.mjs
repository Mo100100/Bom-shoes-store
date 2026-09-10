// Run with: node --test supabase/functions/_shared/pricing.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this
// is a plain node:test script over the pure money helpers in ./pricing.ts.
// Node 22 strips the TypeScript types on import, so no build step and no Deno
// runtime is needed (pricing.ts's only npm: import is `import type`, which is
// erased).

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  COUPON_UNAVAILABLE,
  checkUsageLimits,
  clampPercent,
  computeBxgyDiscount,
  computeDiscount,
  computeOrderTotal,
  evaluateCouponByCode,
  getBasicEligibility,
  normalizeCouponCode,
} from './pricing.ts'

function coupon(overrides = {}) {
  return {
    id: 'c1',
    code: 'SAVE20',
    requires_code: true,
    description: null,
    discount_type: 'percentage',
    discount_value: 20,
    min_order_amount: null,
    max_discount_amount: null,
    usage_limit: null,
    per_customer_limit: null,
    starts_at: null,
    ends_at: null,
    active: true,
    target_type: 'all',
    target_category: null,
    target_product_ids: [],
    buy_quantity: null,
    get_quantity: null,
    get_discount_percent: null,
    stackable: false,
    ...overrides,
  }
}

function ctx(subtotal, overrides = {}) {
  return {
    subtotal,
    items: [{ product_id: 'p1', size: '42', color: 'Black', quantity: 1 }],
    productById: new Map([['p1', { id: 'p1', name: 'Shoe', price: subtotal, image_url: null, category: 'Sneakers' }]]),
    resolvedItems: [
      { product_id: 'p1', variant_id: 'v1', name: 'Shoe', size: '42', color: 'Black', quantity: 1, price: subtotal, image_url: null },
    ],
    ...overrides,
  }
}

// --- percentage clamping -----------------------------------------------------

// Asserted directly, not only through computeDiscount: inside it the
// percentage clamp and the subtotal clamp are mutually redundant, so neither
// is observable in the output while the other stands (see computeDiscount's
// comment). This is what actually pins the percentage clamp down.
test('a percentage is clamped into 0..100 whatever an admin typed', () => {
  assert.equal(clampPercent(20), 20)
  assert.equal(clampPercent(150), 100)
  assert.equal(clampPercent(-50), 0)
  assert.equal(clampPercent(100), 100)
})

test('a percentage discount applies normally', () => {
  const { discountAmount } = computeDiscount(coupon({ discount_value: 20 }), ctx(1000))
  assert.equal(discountAmount, 200)
})

test('a percentage above 100 is clamped to the subtotal, never more', () => {
  // The bug this exists for: 150% used to discount 1500 off a 1000 cart and
  // post a negative amount to the payment gateway.
  const { discountAmount } = computeDiscount(coupon({ discount_value: 150 }), ctx(1000))
  assert.equal(discountAmount, 1000)
})

test('a negative percentage never becomes a surcharge', () => {
  const { discountAmount } = computeDiscount(coupon({ discount_value: -50 }), ctx(1000))
  assert.equal(discountAmount, 0)
})

test('max_discount_amount caps a percentage discount', () => {
  const { discountAmount } = computeDiscount(coupon({ discount_value: 50, max_discount_amount: 120 }), ctx(1000))
  assert.equal(discountAmount, 120)
})

test('max_discount_amount still applies to an over-100 percentage', () => {
  const { discountAmount } = computeDiscount(coupon({ discount_value: 150, max_discount_amount: 120 }), ctx(1000))
  assert.equal(discountAmount, 120)
})

// The two clamps in computeDiscount are mutually redundant, so with a small
// max_discount_amount either one alone still produces the right answer and
// removing either survives every assertion above. A cap ABOVE the subtotal
// separates them: only the percentage clamp keeps this at 1000, and only the
// subtotal clamp keeps it there if the percentage clamp goes.
test('an over-100 percentage under a cap larger than the cart is still capped at the cart', () => {
  const { discountAmount } = computeDiscount(coupon({ discount_value: 150, max_discount_amount: 5000 }), ctx(1000))
  assert.equal(discountAmount, 1000)
})

// Likewise the Math.max(0, ...): with a negative cap, Math.min picks the cap
// and only the floor stops the discount becoming a surcharge.
test('a negative max_discount_amount never becomes a surcharge', () => {
  const { discountAmount } = computeDiscount(coupon({ discount_value: 20, max_discount_amount: -500 }), ctx(1000))
  assert.equal(discountAmount, 0)
})

test('a fixed discount is capped at the subtotal', () => {
  const { discountAmount } = computeDiscount(coupon({ discount_type: 'fixed', discount_value: 5000 }), ctx(1000))
  assert.equal(discountAmount, 1000)
})

// Unlike the percentage branch above, nothing downstream caps a buy-x-get-y
// discount at the subtotal (resolveBestDiscount only caps when a bundle
// stacks), so this clamp is the only thing standing between a typo and a
// discount worth more than the goods.
test('an over-100 get_discount_percent gives the free units away, not more', () => {
  const bxgy = coupon({
    discount_type: 'buy_x_get_y',
    buy_quantity: 2,
    get_quantity: 1,
    get_discount_percent: 150,
  })
  const items = [
    { product_id: 'p1', variant_id: 'v1', name: 'Shoe', size: '42', color: 'Black', quantity: 3, price: 500, image_url: null },
  ]
  // One complete set of 3, so exactly one unit at 100% off: 500, not 750.
  assert.equal(computeBxgyDiscount(bxgy, items, new Map()), 500)
})

// --- the charged total -------------------------------------------------------

test('the order total is rounded to cents', () => {
  assert.equal(computeOrderTotal(1000, 60, 0), 1060)
  assert.equal(computeOrderTotal(0.115, 0, 0), 0.12)
})

test('the order total is floored at 0, never negative', () => {
  assert.equal(computeOrderTotal(1000, 60, 99999), 0)
})

test('a 100% coupon still leaves shipping payable', () => {
  const subtotal = 1000
  const { discountAmount } = computeDiscount(coupon({ discount_value: 100 }), ctx(subtotal))
  assert.equal(computeOrderTotal(subtotal, 60, discountAmount), 60)
})

// --- case-insensitive codes --------------------------------------------------

test('coupon codes match regardless of case or surrounding space', () => {
  assert.equal(normalizeCouponCode('save20'), 'SAVE20')
  assert.equal(normalizeCouponCode('  SaVe20 '), 'SAVE20')
  assert.equal(normalizeCouponCode('SAVE20'), 'SAVE20')
})

// --- the code oracle ---------------------------------------------------------

// Enough of a client for findCouponByCode's one query chain.
const noSuchCoupon = {
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }) }),
}

test('a code that does not exist is rejected identically to one that does not apply', async () => {
  const missing = await evaluateCouponByCode(noSuchCoupon, 'NOPE', ctx(1000))
  const outOfScope = getBasicEligibility(coupon({ target_type: 'category', target_category: 'Boots' }), ctx(1000))

  assert.equal(missing.valid, false)
  assert.equal(outOfScope.ok, false)
  assert.deepEqual(
    { reasonCode: missing.reasonCode, reason: missing.reason },
    { reasonCode: outOfScope.rejection.reasonCode, reason: outOfScope.rejection.reason },
  )
  assert.equal(missing.reasonCode, COUPON_UNAVAILABLE.reasonCode)
})

test('an expired coupon is rejected identically too', () => {
  const expired = getBasicEligibility(coupon({ ends_at: '2020-01-01T00:00:00Z' }), ctx(1000))
  assert.deepEqual(expired.rejection, COUPON_UNAVAILABLE)
})

test('a cart within reach of the minimum keeps the actionable message', () => {
  // 1000 of a 2000 minimum: exactly at MIN_ORDER_HINT_RATIO.
  const belowMin = getBasicEligibility(coupon({ min_order_amount: 2000 }), ctx(1000))
  assert.equal(belowMin.rejection.reasonCode, 'min_order')
  assert.equal(belowMin.rejection.minOrderAmount, 2000)
})

test('a cart far below the minimum reveals nothing about the code', () => {
  // 1000 of a 5000 minimum. Otherwise a dictionary guess with a near-empty
  // cart confirms which codes exist.
  const farBelow = getBasicEligibility(coupon({ min_order_amount: 5000 }), ctx(1000))
  assert.deepEqual(farBelow.rejection, COUPON_UNAVAILABLE)
})

// --- per-customer limits -----------------------------------------------------

test('a per-customer-limited coupon is refused when there is no signed-in user', () => {
  const result = checkUsageLimits(coupon({ per_customer_limit: 1 }), new Map(), null)
  assert.equal(result.ok, false)
  assert.equal(result.rejection.reasonCode, 'sign_in_required')
})

test('an AUTO-applied promotion still reaches a guest despite a per-customer limit', () => {
  // A guest cannot hunt for an auto promotion, so there is nothing to refuse;
  // withholding it would silently stop serving every guest in a guest-checkout
  // store. Matches findBestAutoPromotion, which skips usage checks entirely.
  const result = checkUsageLimits(coupon({ per_customer_limit: 1 }), new Map(), null, {
    enforcePerCustomerLimit: false,
  })
  assert.equal(result.ok, true)
})

test('an AUTO-applied promotion still respects the global usage limit', () => {
  const counts = new Map([['c1', { total: 100, customer: 0 }]])
  const result = checkUsageLimits(coupon({ usage_limit: 100, per_customer_limit: 1 }), counts, null, {
    enforcePerCustomerLimit: false,
  })
  assert.equal(result.ok, false)
  assert.deepEqual(result.rejection, COUPON_UNAVAILABLE)
})

test('a per-customer-limited coupon applies for a signed-in user under the limit', () => {
  const counts = new Map([['c1', { total: 9, customer: 0 }]])
  assert.equal(checkUsageLimits(coupon({ per_customer_limit: 1 }), counts, 'user-1').ok, true)
})

test('a per-customer-limited coupon is refused once that user has hit the limit', () => {
  const counts = new Map([['c1', { total: 9, customer: 1 }]])
  const result = checkUsageLimits(coupon({ per_customer_limit: 1 }), counts, 'user-1')
  assert.equal(result.ok, false)
  assert.deepEqual(result.rejection, COUPON_UNAVAILABLE)
})

test('the overall usage limit is counted across all customers', () => {
  const counts = new Map([['c1', { total: 100, customer: 0 }]])
  const result = checkUsageLimits(coupon({ usage_limit: 100 }), counts, 'user-1')
  assert.equal(result.ok, false)
  assert.deepEqual(result.rejection, COUPON_UNAVAILABLE)
})

test('a coupon with neither limit needs no counts at all', () => {
  assert.equal(checkUsageLimits(coupon(), new Map(), null).ok, true)
})
