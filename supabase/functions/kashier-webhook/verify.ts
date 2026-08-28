// supabase/functions/kashier-webhook/verify.ts
//
// Pure, runtime-agnostic helpers for the Kashier webhook: signature
// verification, the paid-amount check and the order state machine. They live
// outside index.ts (which needs Deno.serve and a Supabase client) so
// verify-signature.test.mjs can import them under plain `node --test`.

import { hmacSha256Hex, sha256Hex, timingSafeEqual } from '../_shared/kashier-crypto.ts'

export type KashierWebhookData = {
  merchantOrderId?: string
  transactionId?: string
  status?: string
  signatureKeys?: string[]
  [key: string]: unknown
}

// Fields that MUST be inside data.signatureKeys for the payload to be
// actionable. signatureKeys arrives inside the (attacker-reachable) payload
// and decides what the HMAC actually covers, so a signature over a key set
// that omits any of these proves nothing about the order, the money or the
// outcome -- it is treated as unverified.
export const REQUIRED_SIGNATURE_KEYS = ['merchantOrderId', 'amount', 'currency', 'status']

// Kashier is an Egyptian gateway and create-order always charges in EGP
// (see its CURRENCY constant); anything else means the payment is not the one
// we asked for.
const PAYMENT_CURRENCY = 'EGP'

// Rounding tolerance in EGP between the gateway's amount and the stored total.
// Both sides derive from the same 2-decimal value, so this only absorbs float
// representation noise, never a genuine underpayment.
const AMOUNT_TOLERANCE = 0.01

export type PaymentOutcome = 'paid' | 'failed' | 'ignore'

const FAILED_STATUSES = ['FAILED', 'DECLINED', 'CANCELLED', 'CANCELED', 'REJECTED', 'ERROR']

// The only `event` values that may end in a fulfilled order. Everything else
// Kashier can send (refund, void, authorize) is ignored: see deriveOutcome.
const FULFILLABLE_EVENTS = ['pay', 'capture']

// Verifies x-kashier-signature over the data.signatureKeys fields.
// Construction: HMAC-SHA256 over "k=v" pairs in signatureKeys array order
// joined with "&", which is the construction Kashier documents for webhooks.
// It is tried against the Payment API key and the account Secret key, because
// the legacy hosted-checkout flow and the v3 Payment Sessions flow sign with
// different ones; the matching key is logged so it can be pinned to a single
// one later. Nothing else is accepted: every extra construction is another
// message an attacker can steer the signed bytes into.
export async function verifyKashierSignature(
  data: KashierWebhookData,
  signatureHeader: string,
  keys: string[],
): Promise<boolean> {
  const sigKeys = Array.isArray(data.signatureKeys)
    ? data.signatureKeys.filter(k => typeof k === 'string')
    : []

  const missing = REQUIRED_SIGNATURE_KEYS.filter(k => !sigKeys.includes(k))
  if (missing.length > 0) {
    console.error('kashier-webhook: rejected, signatureKeys omits security-critical fields:', missing.join(','))
    return false
  }

  const message = sigKeys.map(k => `${k}=${data[k]}`).join('&')

  for (const signKey of keys) {
    if (!signKey) continue
    const expected = await hmacSha256Hex(message, signKey)
    if (timingSafeEqual(expected, signatureHeader)) {
      console.log(`kashier-webhook: signature matched (key=${signKey === keys[0] ? 'api' : 'secret'})`)
      return true
    }
  }

  // Never log the signed message itself: it can carry masked card and customer
  // fields. The order reference, the key names and a one-way digest are enough
  // to find which orders are stuck if this ever starts firing.
  console.error('kashier-webhook: signature did not match, tried the api key and the secret key', JSON.stringify({
    merchantOrderId: data.merchantOrderId ?? null,
    keysTried: keys.filter(Boolean).length,
    signatureKeys: sigKeys,
    messageDigest: (await sha256Hex(message)).slice(0, 16),
  }))
  return false
}

// The outcome comes from the signed `status` field, which
// verifyKashierSignature guarantees is part of the signed key set.
//
// The top-level `event` (pay|refund|authorize|void|capture) sits outside
// `data` and is never signed, so it is used as a DENY-only filter and nothing
// more: it can drop a delivery but can never grant one. That asymmetry
// matters, because a refund or void notification can carry status 'SUCCESS'
// for the same order, amount and currency as the original payment. Without
// this filter, refunding an order that fulfill_order had marked 'failed'
// (out of stock) would come straight back in as a fresh, valid, signed
// "payment" and decrement the stock for money that was just returned.
export function deriveOutcome(data: KashierWebhookData, event?: unknown): PaymentOutcome {
  if (typeof event === 'string' && event.trim() && !FULFILLABLE_EVENTS.includes(event.trim().toLowerCase())) {
    return 'ignore'
  }
  const status = String(data.status ?? '').toUpperCase()
  if (status === 'SUCCESS') return 'paid'
  if (FAILED_STATUSES.includes(status)) return 'failed'
  return 'ignore'
}

// Never trust the gateway's word on what was charged without checking it
// against the total this store computed and stored at create-order time.
export function checkPaidAmount(
  data: KashierWebhookData,
  orderTotal: number | null,
): { ok: boolean; reason?: string } {
  const currency = String(data.currency ?? '').toUpperCase()
  if (currency !== PAYMENT_CURRENCY) {
    return { ok: false, reason: `currency '${currency || 'missing'}' is not ${PAYMENT_CURRENCY}` }
  }

  const raw = data.amount
  const paid = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN
  if (!Number.isFinite(paid)) {
    return { ok: false, reason: 'paid amount is missing or not a number' }
  }
  // orders.total_amount is a Postgres numeric: PostgREST sends it as a JSON
  // number, but every other reader in this codebase coerces defensively and
  // so does this one. A strict typeof check here would 400 every payment in
  // the store if that serialisation ever changed.
  const total = orderTotal === null || orderTotal === undefined ? NaN : Number(orderTotal)
  if (!Number.isFinite(total)) {
    return { ok: false, reason: 'order has no usable stored total to compare against' }
  }
  if (Math.abs(paid - total) > AMOUNT_TOLERANCE + 1e-9) {
    return { ok: false, reason: `paid ${paid} does not match order total ${total}` }
  }
  return { ok: true }
}

// The order state machine. Two rules it must never break: an order that is
// already paid never transitions away from paid (a declined retry after a
// successful payment must not flip it to failed), and an order that is
// cancelled or refunded is never fulfilled.
// Refund/void handling (releasing the stock back) is deliberately not here:
// it belongs with release_order_stock and lands separately.
export function planOrderTransition(
  order: { status?: string | null; payment_status?: string | null },
  outcome: PaymentOutcome,
): { action: 'fulfill' | 'fail' | 'ignore'; reason: string } {
  const paymentStatus = order.payment_status ?? ''
  const status = order.status ?? ''

  if (paymentStatus === 'paid') return { action: 'ignore', reason: 'order is already paid' }
  if (paymentStatus === 'refunded') return { action: 'ignore', reason: 'order is refunded' }
  if (status === 'cancelled') return { action: 'ignore', reason: 'order is cancelled' }

  if (outcome === 'paid') return { action: 'fulfill', reason: 'payment succeeded' }
  if (outcome === 'failed') return { action: 'fail', reason: 'payment failed' }
  return { action: 'ignore', reason: 'payment outcome is not actionable' }
}
