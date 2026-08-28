// Run with: node --test src/lib/sizes.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this is
// a plain node:test script over the pure helpers in src/lib/sizes.ts. Node 22
// strips the TypeScript types on import, so no build step is needed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { splitSizes, compareSizes, firstInStockVariant, defaultSizeForColor } from './sizes.ts'

function variant(size, color, stock) {
  return { size, color, stock }
}

test('compareSizes orders sizes numerically, not as text', () => {
  assert.ok(compareSizes('9', '10') < 0, '9 must sort before 10')
  assert.ok(compareSizes('10', '40') < 0, '10 must sort before 40')
  assert.deepEqual(['40', '9', '10', '41'].sort(compareSizes), ['9', '10', '40', '41'])
})

test('compareSizes keeps mixed numeric/alpha ordering stable', () => {
  // Numbers first, then words alphabetically, whatever order they arrive in.
  const expected = ['9', '41', 'L', 'M', 'XL']
  assert.deepEqual(['XL', '41', 'M', '9', 'L'].sort(compareSizes), expected)
  assert.deepEqual(['M', '9', 'XL', 'L', '41'].sort(compareSizes), expected)
  assert.equal(compareSizes('L', 'L'), 0)
})

test('splitSizes turns a crammed size box into one size per entry', () => {
  assert.deepEqual(splitSizes('41/42/43'), ['41', '42', '43'])
  assert.deepEqual(splitSizes('41, 42 / 43'), ['41', '42', '43'])
  assert.deepEqual(splitSizes(' 41 '), ['41'])
  assert.deepEqual(splitSizes('41/41/42'), ['41', '42'], 'duplicates are dropped')
})

test('splitSizes rejects a box with no usable size in it', () => {
  assert.deepEqual(splitSizes(''), [])
  assert.deepEqual(splitSizes('   '), [])
  assert.deepEqual(splitSizes('//,'), [])
})

test('splitSizes never returns a segment the DB CHECK constraint would reject', () => {
  for (const size of splitSizes('41/42, 43')) {
    assert.ok(!/[/,]/.test(size), `${size} still holds a separator`)
    assert.ok(size.trim().length > 0)
  }
})

test('firstInStockVariant picks the smallest in-stock size', () => {
  const variants = [variant('44', 'black', 2), variant('9', 'black', 0), variant('10', 'black', 3)]
  assert.equal(firstInStockVariant(variants)?.size, '10')
  assert.equal(firstInStockVariant([variant('41', 'black', 0)]), undefined)
  assert.equal(firstInStockVariant([]), undefined)
})

test('firstInStockVariant breaks a size tie on colour, whatever the input order', () => {
  const white = variant('41', 'white', 1)
  const black = variant('41', 'black', 1)
  assert.equal(firstInStockVariant([white, black])?.color, 'black')
  assert.equal(firstInStockVariant([black, white])?.color, 'black')
})

test('defaultSizeForColor prefers an in-stock size for that colour', () => {
  // 41 is the smallest black size but is sold out, so anything that ignores
  // stock returns '41' and fails here. That is the brief item 4 defect.
  const variants = [
    variant('41', 'black', 0),
    variant('42', 'black', 5),
    variant('40', 'white', 5),
  ]
  assert.equal(defaultSizeForColor(variants, 'black'), '42')
  assert.equal(defaultSizeForColor(variants, 'white'), '40')
})

test('defaultSizeForColor falls back to the smallest size when the colour is sold out', () => {
  const variants = [variant('44', 'black', 0), variant('42', 'black', 0)]
  assert.equal(defaultSizeForColor(variants, 'black'), '42')
  assert.equal(defaultSizeForColor(variants, 'green'), '', 'unknown colour selects nothing')
})
