// supabase/functions/create-order/index.ts
//
// Creates an order server-side: looks up REAL product + variant data (never
// trusts a price/total the client might send), recomputes the total,
// generates the order reference, inserts a 'pending' order, and returns a
// signed Kashier hosted-checkout URL.
//
// Each cart line is resolved to its product_variants row (matched by
// product_id + size + color) -- that variant's stock backs the pre-check and
// its price_override (falling back to the product's base price) is the
// authoritative price. The variant's id is stamped into the order item
// snapshot as `variant_id` so fulfill_order() can decrement the right row.
// This resolution now lives in ../_shared/pricing.ts so validate-coupon
// computes the exact same numbers.
//
// Stock is NOT touched here -- it is only ever decremented by
// fulfill_order() (see supabase/migrations), called from kashier-webhook
// once Kashier confirms the payment actually happened.
//
// verify_jwt is left at its default (true) in supabase/config.toml: the
// anon-key frontend client calls this, and the anon key itself is a valid
// JWT, so guest checkout still works. That also means the JWT gate keeps
// nobody out, since the anon key ships in the JS bundle -- the real limits on
// abuse are the rate limiter and the COD ceilings below, not the JWT.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { hmacSha256Hex } from '../_shared/kashier-crypto.ts'
import { resolveCartPricing, evaluateCouponByCode, resolveBestDiscount, type CartItemInput } from '../_shared/pricing.ts'
import { checkRateLimit, RATE_LIMITS } from '../_shared/rate-limit.ts'

type OrderItemInput = CartItemInput

type CustomerInput = {
  fullName: string
  email?: string
  phone: string
  address: string
  city: string
  country: string
  notes?: string
}

const TAX_RATE = 0.08
// Kashier is an Egyptian gateway and the store settles in EGP: every payment is
// always charged in EGP, regardless of the display currency an admin picks in
// store settings (which only controls how prices are shown to shoppers). The
// numeric price is sent to Kashier as-is in EGP, so prices should be entered as
// EGP amounts. Kept a fixed server-side constant (never trust a client-supplied
// currency) so the signed hash and the charged currency can't be tampered with.
const CURRENCY = 'EGP'

// Ceiling on a single cash-on-delivery order. COD is the only path that
// decrements real stock against no payment at all, so one request must not be
// able to swallow a whole product line.
//
// 20 units: this is a shoe store, where a real basket is one to five pairs.
// Twenty is far past any consumer order and a genuine bulk buyer should be
// talking to the store, not the checkout form.
//
// 50,000 EGP: nobody hands a courier that much cash, and at typical prices
// here it sits above what the 20-unit cap allows for all but the most
// expensive lines, so the two ceilings cover each other. Online card orders
// are deliberately NOT capped: they are paid before anything ships and they
// reserve no stock.
const COD_MAX_ITEMS = 20
const COD_MAX_TOTAL = 50000

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ error: 'Method not allowed' }, 405)
  }

  try {
    const body = (await req.json().catch(() => null)) as {
      items?: OrderItemInput[]
      customer?: CustomerInput
      couponCode?: string
      lang?: string
      paymentMethod?: string
      regionCode?: string
    } | null

    const items = body?.items
    const customer = body?.customer
    const couponCode = typeof body?.couponCode === 'string' ? body.couponCode.trim() : ''
    const regionCode = typeof body?.regionCode === 'string' ? body.regionCode.trim() : ''
    // Only controls the language of Kashier's hosted payment page.
    const lang = body?.lang === 'ar' ? 'ar' : 'en'
    // 'cash' = Cash on Delivery (no Kashier redirect, stock reserved now);
    // anything else = pay online via Kashier (the default).
    const isCod = body?.paymentMethod === 'cash'

    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: 'Cart is empty' }, 400)
    }
    // Phone is required (courier calls the customer); email is optional. A
    // region is required so shipping can be priced.
    if (!customer?.fullName || !customer?.phone || !customer?.address || !customer?.city || !regionCode) {
      return jsonResponse({ error: 'Missing required customer details' }, 400)
    }
    for (const item of items) {
      if (!item.product_id || !item.size || !item.color || !Number.isInteger(item.quantity) || item.quantity < 1) {
        return jsonResponse({ error: 'Invalid item in cart' }, 400)
      }
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceRoleKey)

    // Rate limit before any real work. This endpoint reserves stock (COD),
    // writes an order row and creates a Kashier session, and it is reachable
    // by anyone holding the anon key out of the JS bundle. The attempt is
    // recorded whether or not it is allowed, so hammering never wins back an
    // allowance. Thresholds and their reasoning live in ../_shared/rate-limit.ts.
    const rule = isCod ? RATE_LIMITS.codOrder : RATE_LIMITS.onlineOrder
    if (!(await checkRateLimit(admin, req, rule, { phone: customer.phone }))) {
      return jsonResponse({ error: 'Too many orders from here just now. Please wait and try again.', code: 'rate_limited' }, 429)
    }

    // Cap the size of a COD order. Quantity is checkable now, before any
    // pricing work; the value cap needs the server-computed total and is
    // applied further down.
    if (isCod) {
      const totalQuantity = items.reduce((sum, i) => sum + i.quantity, 0)
      if (totalQuantity > COD_MAX_ITEMS) {
        return jsonResponse(
          { error: `Cash on delivery is limited to ${COD_MAX_ITEMS} items per order.`, code: 'cod_item_cap', limit: COD_MAX_ITEMS },
          400,
        )
      }
    }

    // Enforce the admin's enabled payment methods server-side -- a disabled
    // method must be rejected even if the client somehow sends it.
    const { data: cfgRow } = await admin
      .from('site_content').select('value').eq('key', 'checkout_config').maybeSingle()
    const cfg = (cfgRow?.value ?? {}) as { online_enabled?: boolean; cash_enabled?: boolean }
    const onlineEnabled = cfg.online_enabled !== false
    const cashEnabled = cfg.cash_enabled !== false
    if ((isCod && !cashEnabled) || (!isCod && !onlineEnabled)) {
      return jsonResponse({ error: 'That payment method is not available.' }, 400)
    }

    // Authoritative shipping: look the chosen region's price up from the
    // shipping config (never trust a client-sent shipping amount). An unknown
    // region code is rejected.
    const { data: shipRow } = await admin
      .from('site_content').select('value').eq('key', 'shipping').maybeSingle()
    const shipRegions = ((shipRow?.value as { regions?: Array<{ code: string; price: number; name_en?: string }> } | null)?.regions) ?? []
    const region = shipRegions.find(r => r.code === regionCode)
    if (!region) {
      return jsonResponse({ error: 'Please choose a valid delivery region.' }, 400)
    }

    const pricing = await resolveCartPricing(admin, items)
    if (!pricing.ok) {
      return jsonResponse({ error: pricing.error }, 400)
    }
    const { items: orderItems, subtotal, productById } = pricing

    const shipping = Math.max(0, Number(region.price) || 0)
    const tax = subtotal * TAX_RATE

    // Coupon/promotion/bundle resolution -- never trust anything the client
    // says about the discount, re-run the exact same evaluation
    // validate-coupon uses (both call resolveBestDiscount in
    // ../_shared/pricing.ts, so the two can never disagree on the money-
    // critical bundle/BXGY math; see that function's doc comment for the
    // full explicit-code-vs-auto-promotion-vs-bundle precedence rule).
    const couponCtx = {
      subtotal,
      items,
      productById,
      resolvedItems: orderItems,
      customerEmail: customer.email,
      shippingCost: shipping,
    }

    // ponytail: an explicit code that fails re-validation at this point
    // (expired/limit hit/etc between the customer entering it and paying)
    // just falls back to no discount from that code rather than blocking
    // checkout entirely -- matches the "best-effort" tradeoff already
    // accepted for usage limits elsewhere in this system.
    const explicit = couponCode ? await evaluateCouponByCode(admin, couponCode, couponCtx) : null
    const resolution = await resolveBestDiscount(admin, couponCtx, explicit)

    const discountAmount = resolution.discountAmount
    const winningCouponId = resolution.couponId

    // Round to cents so the stored total_amount exactly matches the amount
    // string used in the Kashier hash/redirect below (both derive from the
    // same rounded value, avoiding float-precision drift between the two).
    const total = Math.round((subtotal + shipping + tax - discountAmount) * 100) / 100

    // The value half of the COD ceiling, checked against the server's own
    // total rather than anything the client said it would be.
    if (isCod && total > COD_MAX_TOTAL) {
      return jsonResponse(
        { error: `Cash on delivery is limited to ${COD_MAX_TOTAL} ${CURRENCY} per order.`, code: 'cod_value_cap', limit: COD_MAX_TOTAL },
        400,
      )
    }

    const orderRef = `BOM-${Date.now()}-${crypto.randomUUID().slice(0, 8).toUpperCase()}`
    const userId = getUserIdFromAuthHeader(req)

    const { data: inserted, error: insertError } = await admin
      .from('orders')
      .insert({
        user_id: userId,
        customer_name: customer.fullName,
        customer_email: customer.email || null,
        customer_phone: customer.phone || null,
        shipping_address: `${customer.address}, ${customer.city}, ${region.name_en ?? regionCode}, ${customer.country}${customer.notes ? ' | ' + customer.notes : ''}`,
        total_amount: total,
        status: 'pending',
        payment_status: 'pending',
        payment_method: isCod ? 'cash' : 'kashier',
        kashier_order_id: orderRef,
        items: orderItems,
        coupon_id: winningCouponId,
        discount_amount: discountAmount,
      })
      .select('id')
      .single()

    if (insertError || !inserted) throw insertError ?? new Error('order insert returned no row')

    // Cash on Delivery: no Kashier redirect. Reserve stock atomically now
    // (place_cod_order can't oversell) and hand the customer straight to the
    // thank-you page. The order is 'confirmed' + payment 'pending' until an
    // admin marks the cash collected.
    if (isCod) {
      const { data: placed, error: codError } = await admin.rpc('place_cod_order', { p_order_id: inserted.id })
      if (codError) throw codError
      if (!placed) {
        // place_cod_order already marked the order cancelled/failed (out of
        // stock or a race). Tell the customer without leaking specifics.
        return jsonResponse({ error: 'Sorry, one of your items just went out of stock. Please review your cart.' }, 409)
      }
      return jsonResponse({ orderId: orderRef, cod: true, checkoutUrl: null, discountAmount })
    }

    const origin = resolveAllowedOrigin(req.headers.get('origin'))

    const checkoutUrl = await buildKashierCheckout({ orderRef, amount: total, origin, customerEmail: customer.email, lang })

    // ponytail: the frontend checkout summary needs this to show what was
    // actually applied (couponCode re-validation can differ from the Cart
    // page's live preview) -- cheap to include since discountAmount is
    // already computed above.
    return jsonResponse({ orderId: orderRef, checkoutUrl, discountAmount })
  } catch (err) {
    console.error('create-order error:', err)
    return jsonResponse({ error: 'Could not create order. Please try again.' }, 500)
  }
})

// Only ever redirect the customer's browser (post-payment, from Kashier's
// hosted checkout page) back to a known site origin. A caller hitting this
// function directly (curl, not the browser) can set an arbitrary Origin
// header; without this check that would become an open redirect on our own
// legitimate Kashier checkout link (phishing vector). SITE_URL must be set to
// the store's real origin(s) (comma-separated if there's more than one, e.g.
// a preview + production domain).
function resolveAllowedOrigin(requestOrigin: string | null): string {
  const allowed = (Deno.env.get('SITE_URL') ?? '')
    .split(',')
    .map(o => o.trim().replace(/\/$/, ''))
    .filter(Boolean)

  if (allowed.length === 0) {
    throw new Error('SITE_URL not configured; cannot build a trusted Kashier merchant redirect URL')
  }

  if (requestOrigin && allowed.includes(requestOrigin.replace(/\/$/, ''))) {
    return requestOrigin
  }

  return allowed[0]
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

// The Edge Runtime already verified the caller's JWT signature before our
// code ever runs (verify_jwt defaults to true) -- so we just read its claims,
// no need to re-verify. Guest checkouts arrive with the anon key's JWT
// (role: 'anon', no real user), logged-in users with their access token
// (role: 'authenticated', sub: their user id).
function getUserIdFromAuthHeader(req: Request): string | null {
  try {
    const authHeader = req.headers.get('Authorization') ?? ''
    const token = authHeader.replace(/^Bearer\s+/i, '')
    const payloadB64 = token.split('.')[1]
    if (!payloadB64) return null
    const payload = JSON.parse(atob(payloadB64.replace(/-/g, '+').replace(/_/g, '/')))
    return payload.role === 'authenticated' && payload.sub ? payload.sub : null
  } catch {
    return null
  }
}

type CheckoutOpts = { orderRef: string; amount: number; origin: string; customerEmail: string; lang: string }

// Returns the URL to redirect the customer to for payment. Prefers the modern
// Payment Sessions API (payments.kashier.io) when KASHIER_SECRET_KEY is set;
// otherwise falls back to the legacy signed iframe hosted-checkout URL so
// checkout never hard-breaks if the secret hasn't been configured yet.
async function buildKashierCheckout(opts: CheckoutOpts): Promise<string> {
  if (Deno.env.get('KASHIER_SECRET_KEY')) {
    return await createKashierSession(opts)
  }
  console.warn('create-order: KASHIER_SECRET_KEY not set -- using legacy iframe checkout URL')
  return await buildKashierCheckoutUrl(opts)
}

// Modern integration: POST a payment session to Kashier and redirect the
// customer to the returned `sessionUrl` (payments.kashier.io). Per
// developers.kashier.io/payment/payment-sessions. Auth is server-to-server:
// Authorization = the account Secret Key, api-key = the Payment API Key.
async function createKashierSession(opts: CheckoutOpts): Promise<string> {
  const mid = Deno.env.get('KASHIER_MERCHANT_ID')
  const apiKey = Deno.env.get('KASHIER_API_KEY')
  const secretKey = Deno.env.get('KASHIER_SECRET_KEY')
  if (!mid || !apiKey || !secretKey) throw new Error('Kashier Payment Sessions credentials are not configured')

  const mode = Deno.env.get('KASHIER_MODE') === 'live' ? 'live' : 'test'
  const apiBase = mode === 'live' ? 'https://api.kashier.io' : 'https://test-api.kashier.io'
  const supabaseUrl = Deno.env.get('SUPABASE_URL')!

  // `order` becomes the webhook's merchantOrderId, which kashier-webhook matches
  // against orders.kashier_order_id -- so it MUST be our orderRef.
  const requestBody = {
    amount: opts.amount.toFixed(2),
    currency: CURRENCY,
    order: opts.orderRef,
    merchantId: mid,
    merchantRedirect: `${opts.origin}/checkout/success?orderId=${encodeURIComponent(opts.orderRef)}`,
    display: opts.lang === 'ar' ? 'ar' : 'en',
    type: 'one-time',
    allowedMethods: 'card,wallet',
    interactionSource: 'ECOMMERCE',
    enable3DS: true,
    serverWebhook: `${supabaseUrl}/functions/v1/kashier-webhook`,
    description: `BOM Store order ${opts.orderRef}`,
    customer: { email: opts.customerEmail, reference: opts.orderRef },
    metaData: { orderRef: opts.orderRef },
  }

  const res = await fetch(`${apiBase}/v3/payment/sessions`, {
    method: 'POST',
    headers: {
      'Authorization': secretKey,
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  })

  const json = await res.json().catch(() => null) as { sessionUrl?: string } | null
  if (!res.ok || !json?.sessionUrl) {
    console.error('create-order: Kashier session creation failed', res.status, JSON.stringify(json))
    throw new Error('Kashier session creation failed')
  }
  return json.sessionUrl
}

// Legacy fallback: signed iframe hosted-checkout URL.
// hash = HMAC-SHA256("/?payment=" + mid + "." + orderId + "." + amount + "." + currency, apiKey).
async function buildKashierCheckoutUrl(opts: { orderRef: string; amount: number; origin: string }): Promise<string> {
  const mid = Deno.env.get('KASHIER_MERCHANT_ID')
  const apiKey = Deno.env.get('KASHIER_API_KEY')
  if (!mid || !apiKey) throw new Error('Kashier credentials are not configured')

  // ponytail: KASHIER_MODE isn't in the task's env list -- added because
  // without it there's no way to point at Kashier's live endpoint later
  // without editing code. Defaults to test, which is all that's available
  // (this store isn't live yet).
  const mode = Deno.env.get('KASHIER_MODE') === 'live' ? 'live' : 'test'
  const baseUrl = mode === 'live' ? 'https://iframe.kashier.io/payment' : 'https://test-iframe.kashier.io/payment'

  const amountStr = opts.amount.toFixed(2)
  const path = `/?payment=${mid}.${opts.orderRef}.${amountStr}.${CURRENCY}`
  const hash = await hmacSha256Hex(path, apiKey)

  const merchantRedirect = `${opts.origin}/checkout/success?orderId=${encodeURIComponent(opts.orderRef)}`

  const params = new URLSearchParams({
    mid,
    orderId: opts.orderRef,
    amount: amountStr,
    currency: CURRENCY,
    hash,
    merchantRedirect,
    mode,
  })

  return `${baseUrl}?${params.toString()}`
}
