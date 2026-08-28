// supabase/functions/send-order-confirmation/index.ts
//
// Sends the order-confirmation email for an order the OWNER confirmed, which
// is the half of the lost-webhook path the database cannot do: when Kashier
// drops a webhook the admin marks the order paid (admin_update_order_status ->
// fulfill_order), and without this the customer whose webhook was lost - the
// exact person this feature exists for - would still never hear from the shop.
//
// Same email, same renderer as kashier-webhook: both call
// sendOrderConfirmationEmail in ../_shared/email-templates.ts.
//
// Admin only. The caller's own JWT is used to ask the database is_admin(),
// so the answer comes from PostgREST verifying that token, not from anything
// this function decodes itself. The recipient is never taken from the request:
// it is whatever customer_email the order already holds, so the worst an
// authorised misuse can do is re-send a customer their own confirmation.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { sendOrderConfirmationEmail } from '../_shared/email-templates.ts'

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
    if (!orderId || orderId.length > 64) {
      return jsonResponse({ error: 'Missing order reference' }, 400)
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const authHeader = req.headers.get('Authorization') ?? ''

    // is_admin() reads profiles.role for auth.uid(), so this call answers for
    // the caller's verified session and nobody else's.
    const caller = createClient(supabaseUrl, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: authHeader } },
    })
    const { data: isAdmin } = await caller.rpc('is_admin')
    if (isAdmin !== true) {
      return jsonResponse({ error: 'Not authorised' }, 403)
    }

    // Service role for the read: `orders` has no SELECT policy a guest order
    // would match, and the email needs the items and the total.
    const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!)
    const { data: order } = await admin
      .from('orders')
      .select('customer_name, customer_email, kashier_order_id, items, total_amount, payment_status')
      .eq('kashier_order_id', orderId)
      .maybeSingle()

    if (!order) {
      return jsonResponse({ error: 'Unknown order' }, 404)
    }
    // Only ever confirms an order that really is paid, so this cannot be used
    // to tell a customer their unpaid order is confirmed.
    if (order.payment_status !== 'paid') {
      return jsonResponse({ error: 'Order is not paid' }, 409)
    }

    await sendOrderConfirmationEmail(order)
    return jsonResponse({ sent: true })
  } catch (err) {
    console.error('send-order-confirmation error:', err)
    return jsonResponse({ error: 'Could not send the confirmation email.' }, 500)
  }
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
