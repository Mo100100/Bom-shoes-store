// Run with: node --test scripts/order-state.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this
// is a plain node:test script over the pure predicates in
// src/lib/orderState.ts. Node 22 strips the TypeScript types on import, so no
// build step is needed. (They live in their own module rather than in
// orderStatus.ts precisely so this file can import them: that one pulls in the
// supabase client.)
//
// These two decide what a customer is told about money -- whether the order
// went through at all, and whether a cash amount is disclosed -- so every
// state combination the database can produce is walked, not just the happy
// ones.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { awaitingCash, outcomeOf } from '../src/lib/orderState.ts'

// The real vocabularies, from supabase/migrations: orders.status walks
// pending -> confirmed -> processing -> shipped -> delivered, or cancelled;
// payment_status is pending/paid/failed/refunded; payment_method is written as
// 'cash' or 'kashier' by create-order.
const STATUSES = ['pending', 'confirmed', 'processing', 'shipped', 'delivered', 'cancelled']
const PAYMENT_STATUSES = ['pending', 'paid', 'failed', 'refunded']
const METHODS = ['cash', 'kashier']

function order(status, paymentStatus, paymentMethod) {
  return { status, paymentStatus, paymentMethod, hasEmail: false }
}

test('paid wins over every failure signal, including a cancelled paid order', () => {
  // An admin can cancel an order that was already charged (AdminOrders.tsx).
  // Telling that customer "nothing was charged" would be a lie about money.
  for (const status of STATUSES) {
    assert.equal(outcomeOf(order(status, 'paid', 'kashier')), 'confirmed', status)
    assert.equal(outcomeOf(order(status, 'paid', 'cash')), 'confirmed', status)
  }
})

test('a failed payment or a cancelled order reads as failed', () => {
  for (const status of STATUSES) {
    assert.equal(outcomeOf(order(status, 'failed', 'kashier')), 'failed', status)
  }
  for (const paymentStatus of ['pending', 'failed', 'refunded']) {
    assert.equal(outcomeOf(order('cancelled', paymentStatus, 'cash')), 'failed', paymentStatus)
  }
})

test('a placed cash order is confirmed even though its payment is still pending', () => {
  for (const status of ['confirmed', 'processing', 'shipped', 'delivered']) {
    assert.equal(outcomeOf(order(status, 'pending', 'cash')), 'confirmed', status)
  }
})

test('anything unresolved claims nothing and stays pending', () => {
  assert.equal(outcomeOf(order('pending', 'pending', 'cash')), 'pending')
  assert.equal(outcomeOf(order('pending', 'pending', 'kashier')), 'pending')
  assert.equal(outcomeOf(order('confirmed', 'pending', 'kashier')), 'pending')
  assert.equal(outcomeOf(order('shipped', 'pending', 'kashier')), 'pending')
  // No payment method recorded at all: still not a claim that anything worked.
  assert.equal(outcomeOf(order('pending', 'pending', null)), 'pending')
})

test('outcomeOf answers with one of the three outcomes for every combination', () => {
  for (const status of STATUSES) {
    for (const paymentStatus of PAYMENT_STATUSES) {
      for (const method of [...METHODS, null]) {
        const outcome = outcomeOf(order(status, paymentStatus, method))
        assert.ok(
          ['confirmed', 'pending', 'failed'].includes(outcome),
          `${method}/${status}/${paymentStatus} -> ${outcome}`,
        )
      }
    }
  }
})

// awaitingCash is the predicate that decides whether an amount of money is
// disclosed at all, on both the success page and the guest lookup, and the
// edge function now applies the same test before it will send the total.
test('cash is still owed while the order is on its way', () => {
  for (const status of ['pending', 'confirmed', 'processing', 'shipped']) {
    assert.equal(awaitingCash(order(status, 'pending', 'cash')), true, status)
  }
})

test('nothing is owed once the cash is collected, delivered or cancelled', () => {
  assert.equal(awaitingCash(order('shipped', 'paid', 'cash')), false)
  assert.equal(awaitingCash(order('delivered', 'pending', 'cash')), false)
  assert.equal(awaitingCash(order('delivered', 'paid', 'cash')), false)
  assert.equal(awaitingCash(order('cancelled', 'pending', 'cash')), false)
  assert.equal(awaitingCash(order('cancelled', 'failed', 'cash')), false)
})

test('a card order never asks the customer to have cash ready', () => {
  for (const status of STATUSES) {
    for (const paymentStatus of PAYMENT_STATUSES) {
      assert.equal(awaitingCash(order(status, paymentStatus, 'kashier')), false, `${status}/${paymentStatus}`)
      assert.equal(awaitingCash(order(status, paymentStatus, null)), false, `${status}/${paymentStatus}`)
    }
  }
})

test('the client gate matches the edge function gate exactly', () => {
  // supabase/functions/order-status/index.ts computes cashDue with exactly
  // these terms. If the two ever drift, a total could be sent for an order the
  // client would not show it for, or the reverse.
  const cashDue = o =>
    o.paymentMethod === 'cash'
    && o.paymentStatus !== 'paid'
    && o.status !== 'delivered'
    && o.status !== 'cancelled'
  for (const status of STATUSES) {
    for (const paymentStatus of PAYMENT_STATUSES) {
      for (const method of [...METHODS, null]) {
        const o = order(status, paymentStatus, method)
        assert.equal(awaitingCash(o), cashDue(o), `${method}/${status}/${paymentStatus}`)
      }
    }
  }
})
