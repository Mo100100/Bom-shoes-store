// Run with: node --test src/lib/slug.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this is
// a plain node:test script over the pure helpers in src/lib/slug.ts. Node 22
// strips the TypeScript types on import, so no build step is needed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { slugify, nextFreeSlug, FALLBACK_SLUG } from './slug.ts'

test('slugify keeps an Arabic name instead of erasing it', () => {
  // The whole bug: this used to return '' for every product in the shop.
  assert.equal(slugify('حذاء رياضي'), 'حذاء-رياضي')
  assert.equal(slugify('شوز نيمروس '), 'شوز-نيمروس')
  assert.equal(slugify('شوز  الكسندر ماكوين هاف'), 'شوز-الكسندر-ماكوين-هاف')
})

test('slugify still produces the usual slug for a Latin name', () => {
  assert.equal(slugify('Nike Air Max 90'), 'nike-air-max-90')
  assert.equal(slugify('  Air Force 1  '), 'air-force-1')
  assert.equal(slugify('nike-air-max-90'), 'nike-air-max-90', 'already a slug, unchanged')
})

test('slugify handles a mixed name and drops emoji', () => {
  assert.equal(slugify('شوز Nike 42'), 'شوز-nike-42')
  assert.equal(slugify('Nike 🔥 Air'), 'nike-air')
  assert.equal(slugify('شوز 🐮 برادا'), 'شوز-برادا')
})

test('slugify returns empty only when there is nothing sluggable left', () => {
  assert.equal(slugify(''), '')
  assert.equal(slugify('   '), '')
  assert.equal(slugify('🐮😀🙂'), '', 'emoji-only names fall back in nextFreeSlug')
  assert.equal(slugify('---'), '')
})

test('nextFreeSlug numbers a slug that is already taken', () => {
  assert.equal(nextFreeSlug('حذاء-رياضي', []), 'حذاء-رياضي')
  assert.equal(nextFreeSlug('حذاء-رياضي', ['حذاء-رياضي']), 'حذاء-رياضي-2')
  assert.equal(nextFreeSlug('حذاء-رياضي', ['حذاء-رياضي', 'حذاء-رياضي-2']), 'حذاء-رياضي-3')
  // Gaps are reused: -2 was freed by a deleted product.
  assert.equal(nextFreeSlug('nike', ['nike', 'nike-3']), 'nike-2')
})

test('nextFreeSlug falls back rather than returning an empty slug', () => {
  // The literal, not the imported constant: asserting against FALLBACK_SLUG
  // would pass for FALLBACK_SLUG = '', which is the blank slug this whole
  // module exists to prevent.
  assert.equal(nextFreeSlug('', []), 'product')
  assert.equal(nextFreeSlug('', ['product']), 'product-2')
  assert.equal(FALLBACK_SLUG, 'product', 'the fallback is what the app writes')
})

test('a generated slug cannot collide with the hand-typed live ones', () => {
  // 117 of the 118 live products carry a single emoji or Arabic letter typed
  // by hand. slugify() strips emoji entirely and a name is never one letter,
  // so nothing it produces can land on one of them.
  const live = ['🐮', '😀', 'ء', 'ق']
  assert.equal(nextFreeSlug(slugify('شوز أوف وايت'), live), 'شوز-أوف-وايت')
  assert.ok(!live.includes(nextFreeSlug(slugify('🐮'), live)))
})
