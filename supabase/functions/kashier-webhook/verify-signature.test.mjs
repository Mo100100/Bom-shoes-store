// Run with: node --test supabase/functions/kashier-webhook/verify-signature.test.mjs
//
// There is no test framework in this project (tsc -b + eslint only), so this
// is a plain node:test script over the pure helpers in ./verify.ts. Node 22
// strips the TypeScript types on import, so no build step and no Deno runtime
// is needed.

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { hmacSha256Hex } from '../_shared/kashier-crypto.ts'
import { checkPaidAmount, deriveOutcome, planOrderTransition, verifyKashierSignature } from './verify.ts'

const API_KEY = 'test-payment-api-key'
const SECRET_KEY = 'test-secret-key'
const KEYS = [API_KEY, SECRET_KEY]

function paidPayload(overrides = {}) {
  return {
    merchantOrderId: 'BOM-1234567890-ABCD1234',
    transactionId: 'TX-1',
    amount: '499.00',
    currency: 'EGP',
    status: 'SUCCESS',
    maskedCard: '512345******2346',
    signatureKeys: ['merchantOrderId', 'amount', 'currency', 'status', 'maskedCard'],
    ...overrides,
  }
}

// Mirrors the construction verify.ts accepts: "k=v" pairs in signatureKeys
// array order, joined with "&", HMAC-SHA256 hex.
function sign(data, key = API_KEY) {
  const message = data.signatureKeys.map(k => `${k}=${data[k]}`).join('&')
  return hmacSha256Hex(message, key)
}

test('a valid signature passes', async () => {
  const data = paidPayload()
  assert.equal(await verifyKashierSignature(data, await sign(data), KEYS), true)
})

test('a valid signature made with the account secret key also passes', async () => {
  const data = paidPayload()
  assert.equal(await verifyKashierSignature(data, await sign(data, SECRET_KEY), KEYS), true)
})

test('signatureKeys omitting amount is rejected even with a correct signature', async () => {
  const data = paidPayload({
    signatureKeys: ['merchantOrderId', 'currency', 'status', 'maskedCard'],
  })
  assert.equal(await verifyKashierSignature(data, await sign(data), KEYS), false)
})

test('a tampered amount fails the signature check', async () => {
  const data = paidPayload()
  const signature = await sign(data)
  assert.equal(await verifyKashierSignature({ ...data, amount: '1.00' }, signature, KEYS), false)
})

test('a signature over a re-ordered key set is not accepted', async () => {
  const data = paidPayload()
  const signature = await sign({ ...data, signatureKeys: [...data.signatureKeys].reverse() })
  assert.equal(await verifyKashierSignature(data, signature, KEYS), false)
})

test('the paid amount must match the stored total in EGP', () => {
  assert.equal(checkPaidAmount(paidPayload(), 499).ok, true)
  // Within the 0.01 rounding tolerance.
  assert.equal(checkPaidAmount(paidPayload({ amount: '499.01' }), 499).ok, true)
  assert.equal(checkPaidAmount(paidPayload({ amount: '498.50' }), 499).ok, false)
  assert.equal(checkPaidAmount(paidPayload({ amount: '1.00' }), 499).ok, false)
  assert.equal(checkPaidAmount(paidPayload({ currency: 'USD' }), 499).ok, false)
  assert.equal(checkPaidAmount(paidPayload({ amount: undefined }), 499).ok, false)
  assert.equal(checkPaidAmount(paidPayload(), null).ok, false)
})

test('the outcome comes from the signed status, not the unsigned event', () => {
  assert.equal(deriveOutcome(paidPayload()), 'paid')
  assert.equal(deriveOutcome(paidPayload({ status: 'FAILED' })), 'failed')
  assert.equal(deriveOutcome(paidPayload({ status: 'PENDING' })), 'ignore')
  assert.equal(deriveOutcome(paidPayload({ status: undefined })), 'ignore')
})

test('a paid order is never flipped to failed', () => {
  const paidOrder = { status: 'processing', payment_status: 'paid' }
  assert.equal(planOrderTransition(paidOrder, 'failed').action, 'ignore')
  assert.equal(planOrderTransition(paidOrder, 'paid').action, 'ignore')
})

test('cancelled and refunded orders are never fulfilled', () => {
  assert.equal(planOrderTransition({ status: 'cancelled', payment_status: 'pending' }, 'paid').action, 'ignore')
  assert.equal(planOrderTransition({ status: 'processing', payment_status: 'refunded' }, 'paid').action, 'ignore')
})

test('a pending order still fulfills on success and fails on decline', () => {
  const pendingOrder = { status: 'pending', payment_status: 'pending' }
  assert.equal(planOrderTransition(pendingOrder, 'paid').action, 'fulfill')
  assert.equal(planOrderTransition(pendingOrder, 'failed').action, 'fail')
  assert.equal(planOrderTransition(pendingOrder, 'ignore').action, 'ignore')
})
