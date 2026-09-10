// supabase/functions/order-status/index.ts
//
// Tells the checkout return page what actually happened to an order.
//
// Kashier supports a single merchantRedirect URL, so the browser lands back on
// /checkout/success for every outcome -- paid, declined, and "the webhook
// hasn't arrived yet". The page therefore has to ask the server rather than
// assume, and this is what it asks.
//
// Read-only. payment_status/status/stock are only ever mutated by
// fulfill_order() / place_cod_order(), so nothing a customer does with this
// endpoint can change an order.
//
// verify_jwt = false (see supabase/config.toml): the customer coming back
// from Kashier's hosted page may be a guest with no Supabase session, and the
// same guest has no /account to look the order up in later. The order
// reference is therefore the sole capability, which is why the response stays
// this thin. It runs with the service-role key because `orders` has no public
// SELECT policy (a guest order has no user_id to match on). Guessing at that
// capability is rate limited per IP, see ../_shared/rate-limit.ts.
//
// The response carries the three state fields, a BOOLEAN for whether an email
// was recorded, and the total ONLY while cash is still owed. What it
// deliberately still does not carry: the email address, the name, the phone,
// the delivery address, or the items. So a reference reveals nothing that
// identifies a person and nothing that lets its holder act on the order --
// they cannot pay it, cancel it, redirect it, or contact the buyer.
//
// The two additions each answer a question the customer cannot answer any
// other way:
//   total     -- a cash-on-delivery buyer has to hand the courier an exact
//                amount, and the basket is cleared the moment the order is
//                confirmed, so the server is the only remaining source of it.
//                (create-order does not return it either.) Never taken from
//                the client: the amount shown is the amount recorded.
//   hasEmail  -- the success page used to promise "a confirmation has been
//                sent to your inbox" to every buyer, including the ones who
//                left the optional email field blank.
//
// The threat the total is withheld against is not enumeration, it is a KNOWN
// reference: forwarded in a WhatsApp thread, screenshotted into a family
// group, left in the history of a shared phone, read off a courier manifest.
// /order?ref= is a URL guests are told to keep, so the number of people
// holding one is deliberately large. Once the cash is collected the amount
// answers no question the holder still has, and all it discloses is what an
// identified person spent -- so it is returned only while it is the one thing
// the buyer genuinely cannot get any other way.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { checkRateLimit, RATE_LIMITS } from '../_shared/rate-limit.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    const body = (await req.json().catch(() => null)) as { orderId?: string } | null
    const orderId = typeof body?.orderId === 'string' ? body.orderId.trim() : ''

    // References have a fixed shape (BOM-<millis>-<8 hex>, see create-order),
    // so anything longer is not one: bounded here rather than in the database.
    if (!orderId || orderId.length > 64) {
      return jsonResponse({ error: 'Missing order reference' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceRoleKey)

    // This endpoint answers "does this order reference exist" with a 200 or a
    // 404, which makes it an existence oracle, and the reference is a public
    // millisecond timestamp plus 32 bits of entropy. That is unguessable in
    // one shot but not against unlimited guessing, so the guessing is what
    // gets capped. The success page calls this once on mount plus once per
    // manual retry, nowhere near the ceiling. See ../_shared/rate-limit.ts.
    if (!(await checkRateLimit(admin, req, RATE_LIMITS.orderStatus, { orderRef: orderId }))) {
      return jsonResponse({ error: 'Too many requests. Please wait a moment and try again.' }, 429)
    }

    const { data: order, error } = await admin
      .from('orders')
      .select('status, payment_status, payment_method, total_amount, customer_email')
      .eq('kashier_order_id', orderId)
      .maybeSingle()

    if (error) throw error
    if (!order) {
      return jsonResponse({ error: 'Order not found' }, 404)
    }

    // Whether the courier still has cash to collect. payment_method is 'cash'
    // or 'kashier' (create-order), payment_status walks
    // pending -> paid/failed/refunded and status walks
    // pending -> confirmed -> processing -> shipped -> delivered, or
    // cancelled. A cash order sits at payment_status 'pending' the whole way
    // until an admin marks the cash collected, so 'delivered' and 'cancelled'
    // are the two states where nothing is owed despite that.
    //
    // The client repeats this test (awaitingCash in src/lib/orderStatus.ts)
    // and must keep repeating it: this gate only takes effect once the
    // function is deployed, and the client one is a superset of it.
    const cashDue = order.payment_method === 'cash'
      && order.payment_status !== 'paid'
      && order.status !== 'delivered'
      && order.status !== 'cancelled'

    return jsonResponse({
      status: order.status,
      paymentStatus: order.payment_status,
      paymentMethod: order.payment_method,
      // total_amount is numeric, which postgrest returns as a string. Omitted
      // (JSON.stringify drops undefined) rather than zeroed, so the client
      // can tell "nothing to collect" from "the server did not say".
      total: cashDue ? Number(order.total_amount) || 0 : undefined,
      hasEmail: !!order.customer_email,
    })
  } catch (err) {
    console.error('order-status error:', err)
    return jsonResponse({ error: 'Could not read order status. Please try again.' }, 500)
  }
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
