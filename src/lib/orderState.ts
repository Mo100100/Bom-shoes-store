// The pure half of the order-status logic: what the server's answer MEANS,
// with no network in it.
//
// Split out of orderStatus.ts (which imports the supabase client) purely so
// `node --test scripts/order-state.test.mjs` can import it. These two
// predicates decide what a customer is told about their money -- whether the
// order went through, and whether a cash amount is disclosed at all -- so
// they are the ones worth a test.

// Exactly what supabase/functions/order-status returns. Deliberately thin:
// no customer details, no items, no address. `hasEmail` is a boolean, never
// the address itself, and it exists so the success page only promises a
// confirmation email when one was actually sent (email is optional at
// checkout).
export type OrderStatus = {
  status: string
  paymentStatus: string
  paymentMethod: string | null
  /**
   * ABSENT unless the courier still has cash to collect: the function returns
   * it only while `cashDue` holds, because a reference travels (forwarded,
   * screenshotted, bookmarked) and once the cash is in, the amount discloses
   * nothing but what an identified person spent. Undefined here means "the
   * server did not say", which is not the same as zero.
   */
  total?: number
  hasEmail: boolean
}

export type Outcome = 'confirmed' | 'pending' | 'failed'

// The only place payment_status/status/stock are ever mutated is
// fulfill_order() / place_cod_order(), called from the server -- so the
// server's copy of these two fields is the only truth about whether the
// customer actually paid.
//
// 'pending' is the honest answer for anything not yet resolved, and it is
// also where every unknown lands (see the callers): a webhook still in
// flight, an unreachable endpoint, a missing reference. It claims nothing.
export function outcomeOf(s: OrderStatus): Outcome {
  // Paid is tested FIRST, before any failure test. An admin can cancel an
  // already-paid order (AdminOrders.tsx) when stock turns out to be missing
  // after payment, and telling that customer "nothing was charged" about
  // money that left their account would be a lie.
  if (s.paymentStatus === 'paid') return 'confirmed'
  if (s.paymentStatus === 'failed' || s.status === 'cancelled') return 'failed'
  // Cash on delivery has no payment to wait for: place_cod_order() already
  // confirmed the order and reserved its stock, and payment_status stays
  // 'pending' the whole way through 'confirmed' -> 'processing' -> 'shipped'
  // -> 'delivered', until an admin marks the cash as collected. So any status
  // past 'pending' is a placed order ('cancelled' already returned above).
  if (s.paymentMethod === 'cash' && s.status !== 'pending') return 'confirmed'
  return 'pending'
}

// True while the courier still has cash to collect, which is the only time
// "have this amount ready" is worth saying.
//
// The edge function now applies this same test before it will even send the
// amount. This copy stays, and must stay: it is what protects the window
// before that function is deployed, and it is a superset of the server's gate
// (the callers pair it with `total > 0`, so a withheld total shows nothing
// either way).
export function awaitingCash(s: OrderStatus): boolean {
  return s.paymentMethod === 'cash' && s.paymentStatus !== 'paid' && s.status !== 'delivered' && s.status !== 'cancelled'
}
