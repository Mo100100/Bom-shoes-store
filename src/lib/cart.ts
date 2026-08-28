// The two money-and-stock decisions a cart line makes, kept pure and out of
// CartContext so `src/lib/cart.test.mjs` can assert them under `node --test`
// (same arrangement as src/lib/sizes.ts). Everything about React, Supabase and
// localStorage stays in the context; only the arithmetic lives here.

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
