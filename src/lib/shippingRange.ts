// The delivery line on the product page turns the per-governorate shipping
// prices into "Delivery EGP X" or "Delivery EGP X to EGP Y". This lives in its
// own dependency-free module (like variantDiff.ts) so scripts/shipping-range
// .test.mjs can run it under `node --test` without a Supabase client.
//
// Why zero is treated as unset rather than as free delivery:
// 20260714000000_checkout_shipping_config.sql seeds all 27 governorates at
// price 0 and expects the owner to enter real prices in the admin afterwards.
// A store that has not done that yet would otherwise be told "Delivery EGP
// 0.00 to any governorate" -- a free-shipping promise generated from a
// placeholder, which checkout then refuses to honour. One unset governorate is
// just as bad: "EGP 0 to EGP 120" reads as "free somewhere". So every region
// has to carry a real price before any number is shown at all; anything less
// falls back to naming the rule without a number.

export type ShippingRangeInput = { price: number }

export function shippingRange(regions: readonly ShippingRangeInput[]): { min: number; max: number } | null {
  const prices = regions.map(r => Number(r.price)).filter(n => Number.isFinite(n))
  if (prices.length === 0) return null
  if (prices.some(n => n <= 0)) return null
  return { min: Math.min(...prices), max: Math.max(...prices) }
}
