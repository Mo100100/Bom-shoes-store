// Run with: node --test src/lib/cart.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this is
// a plain node:test script over the pure helpers in src/lib/cart.ts. Node 22
// strips the TypeScript types on import, so no build step is needed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { clampQuantity, lineChange, reconcileLine } from './cart.ts'

test('clampQuantity never goes below one', () => {
  assert.equal(clampQuantity(10, 0), 1)
  assert.equal(clampQuantity(10, -5), 1)
})

test('clampQuantity caps at the stock last seen', () => {
  assert.equal(clampQuantity(3, 999), 3)
  assert.equal(clampQuantity(3, 2), 2)
})

test('clampQuantity leaves an unchecked line uncapped', () => {
  assert.equal(clampQuantity(null, 999), 999)
})

test('clampQuantity keeps its floor when the stock is zero', () => {
  // revalidateCart writes stock: 0 onto a sold-out line, so this is reachable.
  // The floor wins: a line rendering "0" that cannot be incremented is worse
  // than a flagged-unavailable line showing 1.
  assert.equal(clampQuantity(0, 3), 1)
  assert.equal(clampQuantity(0, 0), 1)
})

test('a line is priced by price_override, falling back to the product price', () => {
  assert.deepEqual(reconcileLine(1, 500, { stock: 4, price_override: 399 }), {
    available: true, unitPrice: 399, quantity: 1, stock: 4,
  })
  assert.deepEqual(reconcileLine(1, 500, { stock: 4, price_override: null }), {
    available: true, unitPrice: 500, quantity: 1, stock: 4,
  })
})

test('a price_override of zero is honoured, not treated as absent', () => {
  assert.equal(reconcileLine(1, 500, { stock: 1, price_override: 0 }).unitPrice, 0)
})

test('a deleted product, a missing variant and a sold-out variant are all unavailable', () => {
  assert.deepEqual(reconcileLine(1, undefined, { stock: 4, price_override: null }), { available: false })
  assert.deepEqual(reconcileLine(1, 500, undefined), { available: false })
  assert.deepEqual(reconcileLine(1, 500, { stock: 0, price_override: null }), { available: false })
})

test('a quantity above the remaining stock is clamped, not rejected', () => {
  assert.deepEqual(reconcileLine(9, 500, { stock: 2, price_override: null }), {
    available: true, unitPrice: 500, quantity: 2, stock: 2,
  })
})

const line = (over = {}) => ({ unitPrice: 500, quantity: 2, ...over })

test('an unchanged line reports no change', () => {
  assert.equal(lineChange(line(), line()), null)
})

test('a line that just went unavailable outranks any other change on it', () => {
  assert.equal(lineChange(line(), line({ unitPrice: 400, quantity: 1, unavailable: true })), 'unavailable')
})

test('a line that was ALREADY unavailable is not announced again', () => {
  assert.equal(lineChange(line({ unavailable: true }), line({ unavailable: true })), null)
})

test('a price move is reported, in either direction', () => {
  assert.equal(lineChange(line(), line({ unitPrice: 600 })), 'price')
  assert.equal(lineChange(line(), line({ unitPrice: 400 })), 'price')
})

test('an unverified stored price is never announced as a price change', () => {
  assert.equal(lineChange(line({ unitPriceUnverified: true }), line({ unitPrice: 399 })), null)
  // The quantity clamp on the same line still is.
  assert.equal(lineChange(line({ unitPriceUnverified: true }), line({ unitPrice: 399, quantity: 1 })), 'quantity')
})

test('a quantity clamped down to remaining stock is reported', () => {
  assert.equal(lineChange(line({ quantity: 5 }), line({ quantity: 2 })), 'quantity')
})

test('price wins over quantity when both moved, so one line yields one message', () => {
  assert.equal(lineChange(line(), line({ unitPrice: 600, quantity: 1 })), 'price')
})
