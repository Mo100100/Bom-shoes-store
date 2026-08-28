// Run with: node --test scripts/variant-diff.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this
// is a plain node:test script over the pure helper in src/lib/variantDiff.ts.
// Node 22 strips the TypeScript types on import, so no build step is needed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { diffVariants } from '../src/lib/variantDiff.ts'

function desired(id, size, color, extra = {}) {
  return { id, size, color, sku: null, barcode: null, stock: 0, price_override: null, ...extra }
}

// Applies a diff the way Postgres would: deletes first, then updates, then
// inserts, checking unique(product_id, size, color) after every single row
// rather than at the end of the batch. That is what makes a naive swap fail,
// so it is what the swap test needs to prove does not happen here.
function applyDiff(existing, diff) {
  const rows = existing.filter(r => !diff.deletes.includes(r.id)).map(r => ({ ...r }))
  const assertUnique = () => {
    const keys = rows.map(r => `${r.size}/${r.color}`)
    assert.equal(new Set(keys).size, keys.length, `unique(product_id, size, color) violated: ${keys.join(', ')}`)
  }
  for (const row of diff.updates) {
    const target = rows.find(r => r.id === row.id)
    assert.ok(target, `update targets a row that is not there: ${row.id}`)
    Object.assign(target, row)
    assertUnique()
  }
  let generated = 0
  for (const row of diff.inserts) {
    assert.ok(!('id' in row), 'inserted rows must not carry an id')
    rows.push({ ...row, id: `generated-${++generated}` })
    assertUnique()
  }
  return rows
}

test('unchanged rows keep their ids and nothing else happens', () => {
  const existing = [{ id: 'a', size: '41', color: 'red' }, { id: 'b', size: '42', color: 'red' }]
  const diff = diffVariants(existing, [desired('a', '41', 'red'), desired('b', '42', 'red')])

  assert.deepEqual(diff.deletes, [])
  assert.deepEqual(diff.inserts, [])
  assert.deepEqual(diff.updates.map(r => r.id), ['a', 'b'])
})

test('editing stock/sku keeps the row id', () => {
  const existing = [{ id: 'a', size: '41', color: 'red' }]
  const diff = diffVariants(existing, [desired('a', '41', 'red', { stock: 7, sku: 'SKU-1' })])

  assert.deepEqual(diff.deletes, [])
  assert.deepEqual(diff.inserts, [])
  assert.equal(diff.updates.length, 1)
  assert.equal(diff.updates[0].id, 'a')
  assert.equal(diff.updates[0].stock, 7)
  assert.equal(diff.updates[0].sku, 'SKU-1')
})

test('renaming a size keeps the row id instead of recreating the row', () => {
  const existing = [{ id: 'a', size: '41', color: 'red' }]
  const diff = diffVariants(existing, [desired('a', '42', 'red')])

  assert.deepEqual(diff.deletes, [])
  assert.deepEqual(diff.inserts, [])
  assert.deepEqual(diff.updates, [desired('a', '42', 'red')])
  assert.deepEqual(applyDiff(existing, diff), [{ id: 'a', size: '42', color: 'red', sku: null, barcode: null, stock: 0, price_override: null }])
})

test('only the removed row is deleted, the rest keep their ids', () => {
  const existing = [
    { id: 'a', size: '41', color: 'red' },
    { id: 'b', size: '42', color: 'red' },
    { id: 'c', size: '43', color: 'red' },
  ]
  const diff = diffVariants(existing, [desired('a', '41', 'red'), desired('c', '43', 'red')])

  assert.deepEqual(diff.deletes, ['b'])
  assert.deepEqual(diff.inserts, [])
  assert.deepEqual(diff.updates.map(r => r.id), ['a', 'c'])
})

test('a row the admin just typed is inserted with no id', () => {
  const existing = [{ id: 'a', size: '41', color: 'red' }]
  const diff = diffVariants(existing, [desired('a', '41', 'red'), desired(undefined, '42', 'red', { stock: 3 })])

  assert.deepEqual(diff.deletes, [])
  assert.deepEqual(diff.updates.map(r => r.id), ['a'])
  assert.equal(diff.inserts.length, 1)
  assert.equal(diff.inserts[0].size, '42')
  assert.equal(diff.inserts[0].stock, 3)
  assert.ok(!('id' in diff.inserts[0]))
})

test('a stale id that is no longer in the DB becomes an insert', () => {
  const diff = diffVariants([], [desired('gone', '41', 'red')])

  assert.deepEqual(diff.deletes, [])
  assert.deepEqual(diff.updates, [])
  assert.equal(diff.inserts.length, 1)
  assert.ok(!('id' in diff.inserts[0]))
})

test('swapping size between two rows does not violate the unique key', () => {
  const existing = [{ id: 'a', size: '41', color: 'red' }, { id: 'b', size: '42', color: 'red' }]
  // The admin swapped the two sizes, taking each row's stock with it.
  const diff = diffVariants(existing, [desired('a', '42', 'red', { stock: 1 }), desired('b', '41', 'red', { stock: 2 })])

  assert.deepEqual(diff.deletes, [])
  assert.deepEqual(diff.inserts, [])

  // applyDiff throws if any intermediate state duplicates a size/color pair.
  const rows = applyDiff(existing, diff)
  assert.deepEqual(rows.map(r => ({ id: r.id, size: r.size, stock: r.stock })).sort((x, y) => x.id.localeCompare(y.id)), [
    { id: 'a', size: '41', stock: 2 },
    { id: 'b', size: '42', stock: 1 },
  ])
})

test('swapping color between two rows does not violate the unique key either', () => {
  const existing = [{ id: 'a', size: '41', color: 'red' }, { id: 'b', size: '41', color: 'blue' }]
  const diff = diffVariants(existing, [desired('a', '41', 'blue', { stock: 1 }), desired('b', '41', 'red', { stock: 2 })])

  assert.deepEqual(diff.deletes, [])
  assert.deepEqual(diff.inserts, [])
  applyDiff(existing, diff)
})

test('renaming into a key freed by a removed row does not collide', () => {
  const existing = [{ id: 'a', size: '41', color: 'red' }, { id: 'b', size: '42', color: 'red' }]
  // Row b is gone from the grid and row a takes over its size.
  const diff = diffVariants(existing, [desired('a', '42', 'red')])

  // Natural key wins: the surviving (42, red) variant is the one that already
  // held that key, so orders pointing at it still resolve.
  assert.deepEqual(diff.deletes, ['a'])
  assert.deepEqual(diff.inserts, [])
  assert.deepEqual(diff.updates.map(r => r.id), ['b'])
  assert.deepEqual(applyDiff(existing, diff).map(r => ({ id: r.id, size: r.size, color: r.color })), [
    { id: 'b', size: '42', color: 'red' },
  ])
})

test('every existing id is either kept or deleted, never both', () => {
  const existing = [
    { id: 'a', size: '41', color: 'red' },
    { id: 'b', size: '42', color: 'red' },
    { id: 'c', size: '43', color: 'red' },
  ]
  const diff = diffVariants(existing, [desired('a', '44', 'red'), desired('c', '43', 'red'), desired(undefined, '45', 'red')])

  const kept = diff.updates.map(r => r.id)
  assert.equal(new Set([...kept, ...diff.deletes]).size, existing.length)
  assert.equal(kept.filter(id => diff.deletes.includes(id)).length, 0)
  applyDiff(existing, diff)
})
