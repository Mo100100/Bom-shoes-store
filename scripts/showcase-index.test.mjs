// Run with: node --test scripts/showcase-index.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this
// is a plain node:test script over the pure helpers in src/lib/showcaseIndex.ts.
// Node 22 strips the TypeScript types on import, so no build step is needed.
//
// The bug these guard: the showcase used to derive the copy index and the
// slide position from two different formulas, so the price and the "view
// product" link pointed at a different shoe than the one on screen for about
// half of every slide, and the tail of the section showed no shoe at all.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { showcasePosition, showcaseProgressFor } from '../src/lib/showcaseIndex.ts'

// The band the component treats as "this slide is the one on screen".
const isActive = (rawPos, i) => Math.abs(rawPos - i) <= 0.5

test('progress 0 selects the first slide and progress 1 the last', () => {
  for (const n of [1, 2, 3, 5, 12]) {
    assert.equal(showcasePosition(0, n).active, 0)
    assert.equal(showcasePosition(1, n).active, n - 1)
  }
})

test('the last slide is centred at the section bottom, so there is no dead scroll', () => {
  // rawPos reaching itemCount - 1 is what puts the final shoe in the frame at
  // progress 1. The old formula reached itemCount, half a slide past it.
  for (const n of [2, 3, 5, 12]) {
    assert.equal(showcasePosition(1, n).rawPos, n - 1)
  }
})

test('the copy index and the active slide index are the same value', () => {
  for (const n of [1, 2, 3, 5, 12]) {
    for (let step = 0; step <= 200; step++) {
      const { rawPos, active } = showcasePosition(step / 200, n)
      // One source of truth: the slide the copy describes is the slide the
      // shopper can see and tap.
      assert.ok(isActive(rawPos, active), `slide ${active} is not the visible one at progress ${step / 200} of ${n}`)
      // And it is the nearest one: no other slide is closer to the centre.
      for (let i = 0; i < n; i++) {
        assert.ok(Math.abs(rawPos - i) >= Math.abs(rawPos - active) - 1e-9)
      }
    }
  }
})

test('exactly one slide is ever the active one', () => {
  for (const n of [1, 2, 3, 5, 12]) {
    for (let step = 0; step <= 200; step++) {
      const { rawPos, active } = showcasePosition(step / 200, n)
      const visible = []
      for (let i = 0; i < n; i++) if (i === active) visible.push(i)
      assert.deepEqual(visible, [active], `at progress ${step / 200} of ${n}`)
      assert.ok(Number.isInteger(active))
      assert.ok(rawPos >= 0 && rawPos <= n - 1)
    }
  }
})

test('no progress value, in range or out of it, selects an out-of-range slide', () => {
  for (const n of [1, 2, 3, 5, 12]) {
    for (const p of [-5, -0.001, 0, 0.333, 0.5, 0.666, 0.999, 1, 1.001, 42]) {
      const { active } = showcasePosition(p, n)
      assert.ok(active >= 0 && active <= n - 1, `progress ${p} of ${n} selected ${active}`)
    }
  }
})

test('a single slide does not divide by zero', () => {
  for (const p of [0, 0.5, 1]) {
    const { rawPos, active } = showcasePosition(p, 1)
    assert.equal(rawPos, 0)
    assert.equal(active, 0)
  }
  assert.equal(showcaseProgressFor(0, 1), 0)
})

test('the dot indicator scrolls to the progress that centres its own slide', () => {
  for (const n of [1, 2, 3, 5, 12]) {
    for (let i = 0; i < n; i++) {
      const p = showcaseProgressFor(i, n)
      assert.ok(p >= 0 && p <= 1)
      assert.equal(showcasePosition(p, n).active, i)
    }
  }
})
