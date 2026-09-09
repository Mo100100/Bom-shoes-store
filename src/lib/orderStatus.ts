import { supabase } from '@/lib/supabase'
import type { Translations } from '@/lib/translations'
import type { OrderStatus } from '@/lib/orderState'

// The state predicates and the shape of the answer live in orderState.ts, so
// `node --test` can reach them without pulling in the supabase client. They
// are re-exported here because this module is the one every screen already
// imports from.
export type { OrderStatus, Outcome } from '@/lib/orderState'
export { outcomeOf, awaitingCash } from '@/lib/orderState'

// "not_found", "rate_limited" and "error" are kept apart because a mistyped
// reference, a shopper who has been throttled, and an unreachable endpoint
// must never draw the same screen (see the lookup page, and LoadErrorPanel).
// The throttled one especially: the generic panel's answer is a retry button,
// and retrying is the one thing that makes it worse.
export type OrderStatusResult =
  | { kind: 'found'; order: OrderStatus }
  | { kind: 'not_found' }
  | { kind: 'rate_limited' }
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
  if (status === 404) return { kind: 'not_found' }
  if (status === 429) return { kind: 'rate_limited' }
  return { kind: 'error' }
}

// The order and payment status values are database enums, and a raw one on a
// customer's screen ("cancelled" on an Arabic page) is a bug. Three screens
// had grown their own copy of this map -- the account order history, the guest
// lookup and the admin dashboard -- which is the project's rule-of-three, so
// it lives here beside the rest of the order-status logic. An unknown value
// falls back to itself rather than to a wrong label.
export function orderStatusLabel(status: string, t: Translations): string {
  switch (status) {
    case 'pending': return t.statusPending
    case 'confirmed': return t.statusConfirmed
    case 'processing': return t.statusProcessing
    case 'shipped': return t.statusShipped
    case 'delivered': return t.statusDelivered
    case 'cancelled': return t.statusCancelled
    case 'paid': return t.statusPaid
    case 'failed': return t.statusFailed
    case 'refunded': return t.statusRefunded
    default: return status
  }
}
