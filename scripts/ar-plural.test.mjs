// Run with: node --test scripts/ar-plural.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this
// is a plain node:test script over the Arabic count agreement used by the shop
// and cart item counters. Node 22 strips the TypeScript types on import, so no
// build step is needed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { translations } from '../src/lib/translations.ts'

const ar = translations.ar.shopPieces

test('1 and 2 use their own forms and carry no numeral', () => {
  assert.equal(ar(1), 'قطعة')
  assert.equal(ar(2), 'قطعتان')
})

test('3 to 10 take the plural', () => {
  assert.equal(ar(3), '3 قطع')
  assert.equal(ar(10), '10 قطع')
})

test('11 and up revert to the singular', () => {
  assert.equal(ar(11), '11 قطعة')
  assert.equal(ar(15), '15 قطعة')
  assert.equal(ar(100), '100 قطعة')
})

test('agreement is decided by the last two digits, not the whole number', () => {
  assert.equal(ar(103), '103 قطع')
  assert.equal(ar(111), '111 قطعة')
})

test('zero reads as a singular count, never as the plural', () => {
  assert.equal(ar(0), '0 قطعة')
})

test('the cart counter shares the same agreement', () => {
  assert.equal(translations.ar.cartPieces(2), 'قطعتان')
})
