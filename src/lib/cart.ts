// The two money-and-stock decisions a cart line makes, kept pure and out of
// CartContext so `src/lib/cart.test.mjs` can assert them under `node --test`
// (same arrangement as src/lib/sizes.ts). Everything about React, Supabase and
// localStorage stays in the context; only the arithmetic lives here.

// Sales tax rate shown on the Cart and Checkout pages. Must match the
// server's own TAX_RATE (supabase/functions/create-order/index.ts) -- the
// server recomputes the total from scratch and is authoritative, but a client
// estimate that disagrees just confuses the shopper before they even submit.
export const TAX_RATE = 0.08

// Just enough of a product_variants row to price and cap a line. Structural on
// purpose so this module stays free of the Supabase types.
export type VariantSnapshot = {
  stock: number
  price_override: number | null
}

export type LineDecision =
  /** Product deleted, size/colour gone, or nothing left to sell. */
  | { available: false }
  | { available: true; unitPrice: number; quantity: number; stock: number }

// The one quantity guard every caller routes through: at least one, and never
// past the stock last seen. A null stock means the line hasn't been checked
// against the database yet, so there is nothing to clamp to.
//
// The floor wins over the cap at stock 0, which is the one case where the two
// disagree. Such a line is already flagged unavailable and counts toward no
// total, so a quantity of 1 is just what it renders as; returning 0 would show
// the customer a "0" they cannot increment away from.
export function clampQuantity(stock: number | null, quantity: number): number {
  const atLeastOne = Math.max(1, Math.floor(quantity) || 1)
  return stock != null ? Math.max(1, Math.min(atLeastOne, stock)) : atLeastOne
}

// What a cart line becomes once the database has been consulted.
// `productPrice` is undefined when the product row itself is gone.
//
// The unit price is `price_override ?? products.price`, which is the rule the
// server charges by, verbatim (supabase/functions/_shared/pricing.ts). Anything
// else here would mean showing one number and billing another.
export function reconcileLine(
  requestedQuantity: number,
  productPrice: number | undefined,
  variant: VariantSnapshot | undefined,
): LineDecision {
  if (productPrice == null || !variant || variant.stock <= 0) return { available: false }
  return {
    available: true,
    unitPrice: variant.price_override ?? productPrice,
    quantity: clampQuantity(variant.stock, requestedQuantity),
    stock: variant.stock,
  }
}

// Just the coupon strings, structurally, so this module stays free of the
// translations import (same reason VariantSnapshot is structural above).
export type CouponStrings = {
  cartCouponMinOrder: (amount: string) => string
  cartCouponSignIn: string
  cartCouponInvalid: string
}

// Turns validate-coupon's machine-readable rejection into a translated
// message. Shared by the Cart and Checkout pages so the same rejection never
// reads differently on the two, and because the server's own `reason` is
// English-only and must never reach an Arabic customer.
//
// Every rejection that would otherwise confirm a code exists arrives as the
// same 'unavailable' (validate-coupon is a code oracle otherwise), so there is
// one generic message plus the two the customer can actually act on.
export function couponRejectionMessage(
  rejection: { reasonCode?: string; minOrderAmount?: number } | null | undefined,
  t: CouponStrings,
  formatPrice: (value: number) => string,
): string {
  if (rejection?.reasonCode === 'min_order' && typeof rejection.minOrderAmount === 'number') {
    return t.cartCouponMinOrder(formatPrice(rejection.minOrderAmount))
  }
  if (rejection?.reasonCode === 'sign_in_required') return t.cartCouponSignIn
  return t.cartCouponInvalid
}
