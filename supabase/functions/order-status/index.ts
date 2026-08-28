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
// from Kashier's hosted page may be a guest with no Supabase session. The
// order reference is therefore the sole capability, which is exactly why the
// response is this thin -- ONLY the three state fields, never the total, the
// customer details or the items. Holding a reference reveals nothing beyond
// the state of that one order. It runs with the service-role key because
// `orders` has no public SELECT policy (a guest order has no user_id to match
// on).

import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

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

    const { data: order, error } = await admin
      .from('orders')
      .select('status, payment_status, payment_method')
      .eq('kashier_order_id', orderId)
      .maybeSingle()

    if (error) throw error
    if (!order) {
      return jsonResponse({ error: 'Order not found' }, 404)
    }

    return jsonResponse({
      status: order.status,
      paymentStatus: order.payment_status,
      paymentMethod: order.payment_method,
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
