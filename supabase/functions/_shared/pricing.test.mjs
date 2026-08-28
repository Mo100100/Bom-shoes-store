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

test('a fixed discount is capped at the subtotal', () => {
  const { discountAmount } = computeDiscount(coupon({ discount_type: 'fixed', discount_value: 5000 }), ctx(1000))
  assert.equal(discountAmount, 1000)
})

// --- the charged total -------------------------------------------------------

test('the order total is rounded to cents', () => {
  assert.equal(computeOrderTotal(1000, 60, 80, 0), 1140)
  assert.equal(computeOrderTotal(0.115, 0, 0, 0), 0.12)
})

test('the order total is floored at 0, never negative', () => {
  assert.equal(computeOrderTotal(1000, 60, 80, 99999), 0)
})

test('a 100% coupon still leaves shipping and tax payable', () => {
  const subtotal = 1000
  const { discountAmount } = computeDiscount(coupon({ discount_value: 100 }), ctx(subtotal))
  assert.equal(computeOrderTotal(subtotal, 60, 80, discountAmount), 140)
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

test('a minimum order below the cart keeps its own actionable message', () => {
  const belowMin = getBasicEligibility(coupon({ min_order_amount: 2000 }), ctx(1000))
  assert.equal(belowMin.rejection.reasonCode, 'min_order')
  assert.equal(belowMin.rejection.minOrderAmount, 2000)
})

// --- per-customer limits -----------------------------------------------------

test('a per-customer-limited coupon is refused when there is no signed-in user', () => {
  const result = checkUsageLimits(coupon({ per_customer_limit: 1 }), new Map(), null)
  assert.equal(result.ok, false)
  assert.equal(result.rejection.reasonCode, 'sign_in_required')
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
