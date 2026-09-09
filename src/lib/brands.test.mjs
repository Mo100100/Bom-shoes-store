// Run with: node --test src/lib/brands.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this is
// a plain node:test script over the pure helpers in src/lib/brands.ts. Node 22
// strips the TypeScript types on import, so no build step is needed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  brandLabel, validateBrandName,
  MIN_BRAND_NAME_LENGTH, MAX_BRAND_NAME_LENGTH,
} from './brands.ts'

// The live corrupted row this task exists to repair: a stray key with a real
// display name. Every storefront surface must show 'Burberry', never 'ل'.
const BRANDS = [
  { value: 'Nike', name: 'Nike' },
  { value: 'ل', name: 'Burberry' },
  { value: 'New Balance', name: 'New Balance' },
]

test('brandLabel shows the display name, not the stored key', () => {
  assert.equal(brandLabel(BRANDS, 'ل'), 'Burberry')
  assert.equal(brandLabel(BRANDS, 'Nike'), 'Nike')
  assert.equal(brandLabel(BRANDS, 'New Balance'), 'New Balance')
})

test('brandLabel falls back to the raw value when no row matches', () => {
  // A brand deleted out from under a product: show what the product actually
  // holds rather than a blank, so the gap is visible.
  assert.equal(brandLabel(BRANDS, 'Gucci'), 'Gucci')
  assert.equal(brandLabel([], 'Gucci'), 'Gucci')
})

test('brandLabel returns an empty string for a product with no brand', () => {
  assert.equal(brandLabel(BRANDS, null), '')
  assert.equal(brandLabel(BRANDS, undefined), '')
  assert.equal(brandLabel(BRANDS, ''), '')
})

test('validateBrandName accepts a real brand name', () => {
  assert.equal(validateBrandName('Burberry', ['Nike']), null)
  assert.equal(validateBrandName('  Gucci  ', ['Nike']), null)
  assert.equal(validateBrandName('ديور', ['Nike']), null)
})

test('validateBrandName rejects the stray keystroke that created the ل row', () => {
  assert.equal(validateBrandName('ل', []), 'tooShort')
  assert.equal(validateBrandName('N', []), 'tooShort')
  assert.equal(validateBrandName('  ', []), 'required')
  assert.equal(validateBrandName('', []), 'required')
  assert.equal(validateBrandName('N'.repeat(MAX_BRAND_NAME_LENGTH + 1), []), 'tooLong')
  // The boundaries themselves are allowed.
  assert.equal(validateBrandName('N'.repeat(MIN_BRAND_NAME_LENGTH), []), null)
  assert.equal(validateBrandName('N'.repeat(MAX_BRAND_NAME_LENGTH), []), null)
})

test('validateBrandName rejects a duplicate regardless of case or padding', () => {
  assert.equal(validateBrandName('Nike', ['Nike']), 'duplicate')
  assert.equal(validateBrandName('nike', ['Nike']), 'duplicate')
  assert.equal(validateBrandName('  NIKE ', ['Nike']), 'duplicate')
  assert.equal(validateBrandName('Nike', [' nike ']), 'duplicate')
  assert.equal(validateBrandName('Nike Air', ['Nike']), null)
})
