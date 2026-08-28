// supabase/functions/kashier-webhook/index.ts
//
// Kashier calls this directly, server-to-server, with no Supabase JWT --
// so verify_jwt = false for this function in supabase/config.toml.
// Authenticity is instead verified via the x-kashier-signature header
// (see verifyKashierSignature in ./verify.ts), per
// developers.kashier.io/payment/webhook.
//
// This is the ONLY place an order is ever marked paid: it calls the
// fulfill_order() Postgres function (SECURITY DEFINER, atomic stock check +
// decrement) and only emails the order confirmation if that succeeds. Because
// of that, everything the decision rests on has to be signed and checked:
// the signature must cover the order id, amount, currency and status
// (verify.ts), the paid amount must match the stored total, and the order's
// current state must allow the transition.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { renderOrderConfirmationEmail } from '../_shared/email-templates.ts'
import {
  checkPaidAmount,
  deriveOutcome,
  planOrderTransition,
  verifyKashierSignature,
  type KashierWebhookData,
} from './verify.ts'

type KashierWebhookPayload = {
  // Documented for completeness only: `event` sits outside `data` and is
  // therefore never covered by the signature, so nothing here reads it.
  event: string
  data: KashierWebhookData
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  try {
    const rawBody = await req.text()
    const payload = parsePayload(rawBody)
    if (!payload) {
      console.error('kashier-webhook: rejected, body is not valid JSON')
      return new Response('invalid body', { status: 400 })
    }

    const apiKey = Deno.env.get('KASHIER_API_KEY')
    if (!apiKey) throw new Error('KASHIER_API_KEY not configured')
    const secretKey = Deno.env.get('KASHIER_SECRET_KEY') ?? ''

    const signatureHeader = req.headers.get('x-kashier-signature')
    if (!signatureHeader || !(await verifyKashierSignature(payload.data, signatureHeader, [apiKey, secretKey]))) {
      console.error('kashier-webhook: rejected, invalid or missing x-kashier-signature')
      return new Response('invalid signature', { status: 401 })
    }

    const eventId = payload.data.transactionId
    const merchantOrderId = payload.data.merchantOrderId
    if (!eventId || !merchantOrderId) {
      console.error('kashier-webhook: payload missing transactionId/merchantOrderId')
      return new Response('ignored: missing ids', { status: 200 })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceRoleKey)

    // Idempotency fast path: if we've already recorded this exact event, this
    // is a Kashier retry of a delivery we already handled -- skip it. The
    // record is only written *after* processing succeeds (see below), so a
    // transient failure between here and there doesn't permanently block a
    // retry from ever fulfilling the order (fulfill_order's own
    // payment_status guard makes it safe to call again for the same order
    // even if two deliveries race past this check).
    const { data: existingEvent } = await admin
      .from('processed_webhook_events')
      .select('event_id')
      .eq('event_id', eventId)
      .maybeSingle()

    if (existingEvent) {
      return new Response('already processed', { status: 200 })
    }

    const { data: order, error: orderLookupError } = await admin
      .from('orders')
      .select('id, status, payment_status, customer_name, customer_email, items, total_amount, kashier_order_id')
      .eq('kashier_order_id', merchantOrderId)
      .single()

    if (orderLookupError || !order) {
      console.error('kashier-webhook: no order found for merchantOrderId', merchantOrderId)
      return new Response('ignored: unknown order', { status: 200 })
    }

    // The outcome comes from the signed `status` field, never from the
    // unsigned top-level `event` (see deriveOutcome). Anything that isn't a
    // clear success or failure -- a pending/authorized notification, a refund
    // or void, which land here with their own statuses -- changes nothing.
    const outcome = deriveOutcome(payload.data)
    const plan = planOrderTransition(order, outcome)
    if (plan.action === 'ignore') {
      console.log(`kashier-webhook: no state change for ${merchantOrderId}: ${plan.reason}`)
      return new Response('ignored: no state change', { status: 200 })
    }

    if (plan.action === 'fulfill') {
      // Never fulfill on the gateway's say-so alone: the amount and currency
      // actually paid must match the total this store computed and stored.
      const amountCheck = checkPaidAmount(payload.data, order.total_amount)
      if (!amountCheck.ok) {
        console.error(`kashier-webhook: rejected ${merchantOrderId}, ${amountCheck.reason}`)
        return new Response('rejected: amount mismatch', { status: 400 })
      }

      const { data: fulfilled, error: rpcError } = await admin.rpc('fulfill_order', { p_order_id: order.id })
      if (rpcError) throw rpcError

      if (fulfilled) {
        await sendOrderConfirmationEmail(order).catch(err =>
          console.error('kashier-webhook: failed to send confirmation email', err)
        )
      }
    } else {
      // Payment failed/declined/cancelled: mark it, but stock was never
      // touched (fulfill_order is only ever called on success), so there's
      // nothing to roll back. The payment_status filter re-checks in the
      // database what planOrderTransition checked in memory, so a delivery
      // racing a successful one still can't overwrite 'paid'.
      const { error: failError } = await admin
        .from('orders')
        .update({ payment_status: 'failed' })
        .eq('id', order.id)
        .eq('payment_status', 'pending')
      if (failError) throw failError
    }

    // Only mark this event processed now that we've actually handled it --
    // insert failures here just mean a redundant retry re-runs the (idempotent)
    // handling above, which is safe and far better than silently dropping it.
    await admin.from('processed_webhook_events').insert({ event_id: eventId })

    return new Response('ok', { status: 200 })
  } catch (err) {
    console.error('kashier-webhook error:', err)
    // 5xx on purpose: reaching here means a payment we were told about was
    // NOT applied (an rpc or database failure). Kashier must retry, otherwise
    // a paid order silently stays pending with its stock never decremented.
    // Genuinely ignorable deliveries return 200 above and never land here.
    return new Response('internal error', { status: 500 })
  }
})

function parsePayload(rawBody: string): KashierWebhookPayload | null {
  try {
    return JSON.parse(rawBody) as KashierWebhookPayload
  } catch {
    return null
  }
}

async function sendOrderConfirmationEmail(order: {
  customer_name: string | null
  customer_email: string | null
  kashier_order_id: string | null
  items: unknown
  total_amount: number | null
}) {
  const resendApiKey = Deno.env.get('RESEND_API_KEY')
  const fromEmail = Deno.env.get('RESEND_FROM_EMAIL')
  if (!resendApiKey || !fromEmail || !order.customer_email) {
    console.error('kashier-webhook: skipping confirmation email, missing RESEND config or customer email')
    return
  }

  const html = renderOrderConfirmationEmail({
    customerName: order.customer_name ?? 'there',
    orderRef: order.kashier_order_id ?? '',
    items: Array.isArray(order.items) ? order.items : [],
    total: order.total_amount ?? 0,
  })

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: fromEmail,
      to: order.customer_email,
      subject: `Your BOM Store order ${order.kashier_order_id} is confirmed`,
      html,
    }),
  })

  if (!res.ok) {
    console.error('kashier-webhook: Resend send failed', res.status, await res.text())
  }
}
