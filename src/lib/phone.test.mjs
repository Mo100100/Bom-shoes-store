// Run with: node --test src/lib/phone.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this is
// a plain node:test script over the pure helpers in src/lib/phone.ts. Node 22
// strips the TypeScript types on import, so no build step is needed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { normalizeEgyptPhone, toWesternDigits } from './phone.ts'

test('accepts the plain local form unchanged', () => {
  assert.equal(normalizeEgyptPhone('01012345678'), '01012345678')
  assert.equal(normalizeEgyptPhone('01512345678'), '01512345678')
})

test('accepts every country-code shape a customer types', () => {
  assert.equal(normalizeEgyptPhone('+201012345678'), '01012345678')
  assert.equal(normalizeEgyptPhone('00201012345678'), '01012345678')
  assert.equal(normalizeEgyptPhone('201012345678'), '01012345678')
  // Copied out of a contact card that dropped the leading zero.
  assert.equal(normalizeEgyptPhone('1012345678'), '01012345678')
})

test('ignores the spacing and punctuation people type', () => {
  assert.equal(normalizeEgyptPhone('010 1234 5678'), '01012345678')
  assert.equal(normalizeEgyptPhone('+20 (10) 1234-5678'), '01012345678')
  assert.equal(normalizeEgyptPhone('  01012345678  '), '01012345678')
})

test('accepts Arabic-Indic digits, which the Arabic keyboard produces', () => {
  assert.equal(normalizeEgyptPhone('٠١٠١٢٣٤٥٦٧٨'), '01012345678')
  assert.equal(normalizeEgyptPhone('۰۱۰۱۲۳۴۵۶۷۸'), '01012345678')
  assert.equal(toWesternDigits('٠١٢٣٤٥٦٧٨٩'), '0123456789')
})

test('rejects what a courier cannot dial', () => {
  assert.equal(normalizeEgyptPhone(''), null)
  assert.equal(normalizeEgyptPhone('0101234567'), null) // one digit short
  assert.equal(normalizeEgyptPhone('010123456789'), null) // one digit long
  assert.equal(normalizeEgyptPhone('0223456789'), null) // Cairo landline
  assert.equal(normalizeEgyptPhone('not a number'), null)
})
