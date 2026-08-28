// supabase/functions/validate-coupon/index.ts
//
// Read-only coupon-code lookup for the storefront checkout: recomputes the
// cart subtotal server-side via the shared pricing helper (never trusts a
// client-sent subtotal), looks the code up, and reports whether it's
// currently valid plus the discount it would apply. No DB writes -- a
// redemption is only ever recorded by fulfill_order() at payment
// confirmation (see supabase/migrations).
//
// This is the ONLY way a client should ever learn whether a coupon code
// works: `coupons` has no public SELECT policy (codes must not be listable
// by an anonymous client), so this always runs with the service-role key.
//
// This endpoint is for explicit customer-typed codes only (requires_code =
// true). Auto-apply promotions (and a standalone, no-code-needed bundle)
// need no lookup and are handled entirely inside create-order via
// resolveBestDiscount.
//
// This does NOT call resolveBestDiscount itself, on purpose -- it composes
// the same underlying building blocks (evaluateCouponByCode, findBestBundle,
// combineCouponWithBundle) directly instead. See resolveBestDiscount's doc
// comment in ../_shared/pricing.ts for exactly why: that function's
// winner-selection needs a real shippingCost to correctly decide whether a
// free_shipping coupon nets any value, which this endpoint never has. It
// does, however, replicate resolveBestDiscount's coupon-vs-bundle precedence
// (a bundle only stacks under a coupon that wins outright, otherwise the
// bundle alone is reported) so the two can never disagree about that. What
// IS fully shared, and can never drift between the two endpoints, is the
// actual bundle-matching and BXGY math (findBestBundle/computeBxgyDiscount)
// and the "sum + cap at subtotal, unit-overlap-safe" stacking arithmetic
// (combineCouponWithBundle).
//
// verify_jwt is left at its default (true), same reasoning as create-order:
// the anon-key frontend client calls this, and the anon key is itself a
// valid JWT, so guest checkout still works.

import { createClient } from 'npm:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'
import {
  resolveCartPricing,
  evaluateCouponByCode,
  fetchActiveBundlesWithItems,
  findBestBundle,
  combineCouponWithBundle,
  type CartItemInput,
  type Coupon,
} from '../_shared/pricing.ts'
import { checkRateLimit, RATE_LIMITS } from '../_shared/rate-limit.ts'

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
      customerEmail?: string
    } | null

    const code = body?.code?.trim()
    const items = body?.items

    if (!code) {
      return jsonResponse({ valid: false, reason: 'No coupon code provided' }, 400)
    }
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

    // This cleanly separates a code that exists from one that does not, which
    // makes it an enumeration oracle over the whole coupon code space. Capping
    // the guesses is the fix; a real customer tries a handful of codes and
    // never comes near the ceiling. See ../_shared/rate-limit.ts.
    if (!(await checkRateLimit(admin, req, RATE_LIMITS.validateCoupon))) {
      return jsonResponse({ valid: false, reason: 'Too many attempts. Please wait a moment and try again.' }, 429)
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
      customerEmail: body?.customerEmail ?? null,
    }

    const result = await evaluateCouponByCode(admin, code, ctx)

    if (!result.valid) {
      return jsonResponse({ valid: false, reason: result.reason })
    }

    // New: let a stackable code preview its bundle add-on too, so this
    // number matches what create-order will actually charge if the customer
    // checks out with this exact code (see resolveBestDiscount for the
    // identical rule applied cart-wide). Mirrors resolveBestDiscount's
    // precedence: a bundle only stacks UNDER a coupon that itself would win
    // outright (discountAmount >= the bundle's own). If the bundle is
    // bigger, create-order picks the bundle alone (no coupon, no stacking),
    // so report that outcome here too rather than promising a bigger,
    // never-actually-charged combined total.
    let discountAmount = result.discountAmount
    let discountType: Coupon['discount_type'] | 'bundle' = result.discountType
    let description = result.description
    if (result.coupon.stackable) {
      const bundles = await fetchActiveBundlesWithItems(admin)
      const bundleMatch = findBestBundle(pricing.items, bundles)
      if (bundleMatch) {
        if (result.discountAmount >= bundleMatch.discountAmount) {
          discountAmount = combineCouponWithBundle(
            result.coupon,
            result.discountAmount,
            pricing.items,
            pricing.productById,
            bundleMatch,
            pricing.subtotal,
          )
        } else {
          discountAmount = bundleMatch.discountAmount
          discountType = 'bundle'
          description = bundleMatch.bundle.name
        }
      }
    }

    return jsonResponse({
      valid: true,
      discountAmount,
      discountType,
      description,
      // No shipping context here (see CouponEvalContext), so discountAmount
      // is always 0 for free_shipping -- this flag is what lets the frontend
      // still show the benefit (force the Shipping line to FREE) instead of
      // silently showing nothing.
      freeShipping: result.freeShipping,
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
