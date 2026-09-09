import { supabase } from '@/lib/supabase'

// Exactly what supabase/functions/order-status returns. Deliberately thin:
// no customer details, no items, no address. `hasEmail` is a boolean, never
// the address itself, and it exists so the success page only promises a
// confirmation email when one was actually sent (email is optional at
// checkout).
export type OrderStatus = {
  status: string
  paymentStatus: string
  paymentMethod: string | null
  total: number
  hasEmail: boolean
}

// "not_found" and "error" are kept apart because a mistyped reference and an
// unreachable endpoint must never draw the same screen (see the lookup page,
// and LoadErrorPanel).
export type OrderStatusResult =
  | { kind: 'found'; order: OrderStatus }
  | { kind: 'not_found' }
  | { kind: 'error' }

export async function fetchOrderStatus(orderId: string): Promise<OrderStatusResult> {
  // functions-js only installs an AbortController when a timeout is passed,
  // and browser fetch has none of its own: without this a stalled request
  // (network handover, a cold start that never returns) leaves the customer
  // on the spinner forever, right after handing over their card details.
  const { data, error } = await supabase.functions.invoke<OrderStatus>('order-status', {
    body: { orderId },
    timeout: 15000,
  })
  if (!error && data) return { kind: 'found', order: data }
  // invoke surfaces any non-2xx as a FunctionsHttpError whose `context` is
  // the raw Response; anything else (a network drop) has no status at all.
  const context = (error as { context?: unknown } | null)?.context
  const status = context instanceof Response ? context.status : 0
  return { kind: status === 404 ? 'not_found' : 'error' }
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
export function awaitingCash(s: OrderStatus): boolean {
  return s.paymentMethod === 'cash' && s.paymentStatus !== 'paid' && s.status !== 'delivered' && s.status !== 'cancelled'
}
