// supabase/functions/validate-coupon/index.ts
//
// Read-only preview of what a cart will actually be charged in discounts:
// recomputes the cart subtotal server-side via the shared pricing helper
// (never trusts a client-sent subtotal), then runs the SAME resolution
// create-order runs (resolveBestDiscount in ../_shared/pricing.ts). No DB
// writes -- a redemption is only ever recorded at payment confirmation (see
// supabase/migrations).
//
// `code` is optional. With one, this validates the customer's typed code and
// previews the result. WITHOUT one it previews the auto-applied promotions
// and bundles the cart already qualifies for, which is the point: those are
// applied server-side at checkout, so leaving them out of the preview meant
// the storefront's total disagreed with the amount charged whenever one
// applied.
//
// This is the ONLY way a client should ever learn whether a coupon code
// works: `coupons` has no public SELECT policy for codes (they must not be
// listable by an anonymous client), so this always runs with the service-role
// key. It is also, for that reason, an oracle over the code space, so it is
// rate limited (../_shared/rate-limit.ts) and every rejection that would
// otherwise confirm a code exists shares one identical reason (see
// CouponRejectionCode in ../_shared/pricing.ts).
//
// resolveBestDiscount needs a real shipping cost to value a free_shipping
// coupon at all. The caller may send `regionCode` (the checkout page does,
// once a governorate is picked) and this looks that region's price up from
// site_content.shipping -- the SAME config create-order prices by, and never
// a price the client sends, which would let a caller inflate a free_shipping
// coupon into an arbitrary discount. An unknown code is rejected exactly as
// create-order rejects it.
//
// Without a regionCode (the basket page, which has no address yet) shipping
// is 0, so a free_shipping coupon nets 0 there and can never win the
// comparison. The freeShipping boolean carries it instead, reported when the
// customer's own valid code grants free shipping and nothing else beat it.
//
// verify_jwt is left at its default (true), same reasoning as create-order:
// the anon-key frontend client calls this, and the anon key is itself a valid
// JWT, so guest checkout still works. The caller's real identity, when there
// is one, comes from the same verified JWT create-order reads.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import { resolveCartPricing, evaluateCouponByCode, resolveBestDiscount, type CartItemInput } from '../_shared/pricing.ts'
import { checkRateLimit, RATE_LIMITS } from '../_shared/rate-limit.ts'
import { getUserIdFromAuthHeader } from '../_shared/auth.ts'

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return jsonResponse({ valid: false, reason: 'Method not allowed' }, 405)
  }

  try {
    const body = (await req.json().catch(() => null)) as {
      code?: string
      items?: CartItemInput[]
      regionCode?: string
    } | null

    const code = body?.code?.trim() ?? ''
    const items = body?.items
    const regionCode = typeof body?.regionCode === 'string' ? body.regionCode.trim() : ''

    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse({ valid: false, reason: 'Cart is empty' }, 400)
    }
    for (const item of items) {
      if (!item.product_id || !item.size || !item.color || !Number.isInteger(item.quantity) || item.quantity < 1) {
        return jsonResponse({ valid: false, reason: 'Invalid item in cart' }, 400)
      }
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const admin = createClient(supabaseUrl, serviceRoleKey)

    // Capping the guesses is what keeps this from being a usable enumeration
    // oracle; the identical-rejection rule below is the other half. A real
    // customer tries a handful of codes and never comes near the ceiling.
    // See ../_shared/rate-limit.ts.
    if (!(await checkRateLimit(admin, req, RATE_LIMITS.validateCoupon))) {
      return jsonResponse(
        { valid: false, code: 'rate_limited', reason: 'Too many attempts. Please wait a moment and try again.' },
        429,
      )
    }

    // Authoritative shipping, looked up the same way create-order looks it up
    // (see that file around the site_content.shipping read). No region sent
    // means no address chosen yet, which is 0 rather than an error.
    let shippingCost = 0
    if (regionCode) {
      const { data: shipRow } = await admin
        .from('site_content').select('value').eq('key', 'shipping').maybeSingle()
      const shipRegions = ((shipRow?.value as { regions?: Array<{ code: string; price: number }> } | null)?.regions) ?? []
      const region = shipRegions.find(r => r.code === regionCode)
      if (!region) {
        return jsonResponse({ valid: false, reason: 'Please choose a valid delivery region.' }, 400)
      }
      shippingCost = Math.max(0, Number(region.price) || 0)
    }

    const pricing = await resolveCartPricing(admin, items)
    if (!pricing.ok) {
      return jsonResponse({ valid: false, reason: pricing.error }, 400)
    }

    const ctx = {
      subtotal: pricing.subtotal,
      items,
      productById: pricing.productById,
      resolvedItems: pricing.items,
      userId: getUserIdFromAuthHeader(req),
      shippingCost,
    }

    const explicit = code ? await evaluateCouponByCode(admin, code, ctx) : null

    // A typed code that cannot be used is the only thing that fails here; the
    // no-code preview always resolves (to zero if nothing applies).
    if (explicit && !explicit.valid) {
      return jsonResponse({
        valid: false,
        reasonCode: explicit.reasonCode,
        reason: explicit.reason,
        minOrderAmount: explicit.minOrderAmount,
      })
    }

    // The same call create-order makes, so the previewed number and the
    // charged number come from one implementation of the precedence rules
    // (explicit code vs auto-promotion vs bundle, and the one stacking case).
    const resolution = await resolveBestDiscount(admin, ctx, explicit)

    return jsonResponse({
      valid: true,
      discountAmount: resolution.discountAmount,
      discountType: resolution.discountType,
      description: resolution.description,
      // See the free_shipping note in this file's header: only meaningful
      // when there is no regionCode, since with a real shipping cost the
      // waiver is already inside discountAmount (that is how create-order
      // charges it too -- computeOrderTotal subtracts it from the total).
      freeShipping: !!(explicit?.valid && explicit.freeShipping && resolution.discountAmount === 0),
    })
  } catch (err) {
    console.error('validate-coupon error:', err)
    return jsonResponse({ valid: false, reason: 'Could not validate coupon. Please try again.' }, 500)
  }
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}
