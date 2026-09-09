// Run with: node --test scripts/shipping-range.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this
// is a plain node:test script over the pure helper in src/lib/shippingRange.ts.
// Node 22 strips the TypeScript types on import, so no build step is needed.
//
// What this guards: the product page's delivery line. The shipping migration
// seeds all 27 governorates at price 0 for the owner to fill in later, so a
// helper that treats 0 as a real price turns that placeholder into a printed
// free-delivery promise the checkout will not honour.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { shippingRange } from '../src/lib/shippingRange.ts'

const regions = (...prices) => prices.map(price => ({ price }))

test('the seeded all-zero config yields no range', () => {
  assert.equal(shippingRange(regions(0, 0, 0)), null)
})

test('one unpriced governorate among priced ones yields no range', () => {
  assert.equal(shippingRange(regions(100, 0, 120)), null)
})

test('a negative price is treated as unset too', () => {
  assert.equal(shippingRange(regions(100, -50)), null)
})

test('all priced yields the real min and max', () => {
  assert.deepEqual(shippingRange(regions(150, 100, 200)), { min: 100, max: 200 })
})

test('a single priced region yields a flat price', () => {
  assert.deepEqual(shippingRange(regions(120)), { min: 120, max: 120 })
})

test('every region on the same price yields a flat price', () => {
  assert.deepEqual(shippingRange(regions(75, 75, 75)), { min: 75, max: 75 })
})

test('an empty region list yields no range', () => {
  assert.equal(shippingRange([]), null)
})

test('non-finite prices are ignored, not counted as unset', () => {
  assert.deepEqual(shippingRange(regions(100, NaN, 200)), { min: 100, max: 200 })
  assert.deepEqual(shippingRange([{ price: 100 }, { price: 'abc' }, { price: undefined }, { price: 200 }]), { min: 100, max: 200 })
})

// Number(null) is 0, not NaN, so a null price does NOT reach the finite
// filter -- it lands on the zero rule instead, which is the honest answer for
// a governorate nobody has priced.
test('a null price is unset, not ignored', () => {
  assert.equal(shippingRange([{ price: 100 }, { price: null }]), null)
})

test('a list of nothing but non-finite prices yields no range', () => {
  assert.equal(shippingRange(regions(NaN, Infinity)), null)
})
