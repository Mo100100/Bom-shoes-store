import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://pediesdpfmsdfceeknlb.supabase.co'
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBlZGllc2RwZm1zZGZjZWVrbmxiIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE3ODYwMjksImV4cCI6MjA5NzM2MjAyOX0.-PDnyFqZ371n5Hno30klvSaIQACpkwVFWCO40douhrw'

export const supabase = createClient(supabaseUrl, supabaseAnonKey)

// The edge functions reject an over-cap, rate-limited or otherwise refusable
// request with a machine-readable `code` (and the ceiling that was hit) in the
// response body, so the customer can be told what to actually change rather
// than "please try again". functions.invoke surfaces any non-2xx as a
// FunctionsHttpError whose `context` is the raw Response, which is the only
// place that body is reachable from. Anything else (a network drop, a 5xx with
// no body) yields nothing and the caller falls back to a generic message.
//
// `responded` says whether the server answered at all, which is a different
// question from whether it sent a code: a request that got no response may
// still have been processed (see the retry handling in Checkout.tsx).
export async function readServerError(err: unknown): Promise<{ responded: boolean; code?: string; limit?: number }> {
  const context = (err as { context?: unknown } | null)?.context
  if (!(context instanceof Response)) return { responded: false }
  // clone() itself throws synchronously if the body was already read, so the
  // whole read is guarded, not just the json() promise.
  try {
    return { responded: true, ...await context.clone().json() }
  } catch {
    return { responded: true }
  }
}

export type Product = {
  id: string
  name: string
  slug: string
  description: string | null
  price: number
  category: string | null
  image_url: string | null
  // Deprecated: superseded by product_variants (per-size/per-color stock).
  // Left in place because the DB still has them; do not read for new code.
  stock: number
  sizes: string[]
  colors: string[]
  featured: boolean
  created_at: string
  materials: string | null
  weight_grams: number | null
  tags: string[]
  // Free-text brand value, matching a public.brands.value (or null for
  // BOM Store's own in-house products). Added when the store became a
  // multi-brand retailer.
  brand: string | null
}

// Admin-managed product brand. `value` is stored free-text on products.brand
// (no FK). logo_url is null until a real licensed logo is uploaded, in which
// case the storefront shows it instead of the plain-text wordmark.
export type Brand = {
  value: string
  name: string
  logo_url: string | null
  position: number
  created_at: string
}

// cost_price (wholesale/COGS) deliberately lives in its own admin-only-select
// table, not on `products` -- see the migration for why.
export type ProductCost = {
  product_id: string
  cost_price: number | null
  updated_at: string
}

export type ProductImage = {
  id: string
  product_id: string
  url: string
  position: number
  is_featured: boolean
  created_at: string
}

export type ProductVariant = {
  id: string
  product_id: string
  size: string
  color: string
  sku: string | null
  barcode: string | null
  stock: number
  price_override: number | null
  created_at: string
}

// Row shape of the `product_catalog` view: a product plus stock/price/size/
// color info aggregated across its variants, for one-round-trip list pages.
export type ProductCatalogEntry = Product & {
  total_stock: number
  available_sizes: string[]
  available_colors: string[]
  // Bottom and top of the variant price range, both computed in SQL over the
  // IN-STOCK variants (all variants only when nothing is in stock). Equal
  // means one flat price; min < max means the grid shows a "from" price.
  min_price: number
  max_price: number
  // The single definition of "on sale": min_price is under the product's base
  // price, i.e. some purchasable variant really is discounted. Computed in the
  // view so the /sale filter and the SALE badge cannot disagree.
  has_discount: boolean
  // null (not 0) when the product has no reviews yet -- render "no ratings
  // yet", not a misleading 0-star average.
  avg_rating: number | null
  review_count: number
}

// One review per (product, user) -- enforced by a unique constraint.
// verified_purchase is set server-side by a trigger, never by the client.
export type Review = {
  id: string
  product_id: string
  user_id: string
  rating: number
  title: string | null
  body: string | null
  verified_purchase: boolean
  created_at: string
}

// Email capture for "notify me when back in stock" -- no account required.
// RLS allows public INSERT only; the client can never read these rows back
// (no SELECT policy), so there's nothing to fetch client-side beyond the
// insert response itself.
export type StockNotifyRequest = {
  id: string
  variant_id: string
  email: string
  notified: boolean
  created_at: string
}

export type Order = {
  id: string
  user_id: string | null
  customer_name: string | null
  customer_email: string | null
  customer_phone: string | null
  shipping_address: string | null
  total_amount: number | null
  status: string
  payment_status: string
  payment_method: string | null
  kashier_order_id: string | null
  items: any
  created_at: string
  coupon_id: string | null
  discount_amount: number
  // When this order actually took stock off the shelf (null = it never did).
  // Written only by the database functions; the admin list reads it to know
  // which status changes admin_update_order_status() will accept.
  stock_reserved_at: string | null
}

// A coupon AND an automatic promotion are the same row: requires_code = true
// + a unique `code` is a real coupon a customer types in; requires_code =
// false + code = null is an auto-applied promotion. Admin-only table -- the
// anon/authenticated client never queries this directly (no public RLS
// policy); validation goes through the validate-coupon / create-order edge
// functions.
export type Coupon = {
  id: string
  code: string | null
  requires_code: boolean
  description: string | null
  discount_type: 'percentage' | 'fixed' | 'free_shipping' | 'buy_x_get_y'
  discount_value: number
  min_order_amount: number | null
  max_discount_amount: number | null
  usage_limit: number | null
  per_customer_limit: number | null
  starts_at: string | null
  ends_at: string | null
  active: boolean
  target_type: 'all' | 'category' | 'products'
  target_category: string | null
  target_product_ids: string[]
  // Buy-X-get-Y fields -- only meaningful when discount_type = 'buy_x_get_y'.
  // The buy/get pool is the SAME target_type/target_category/
  // target_product_ids above (one targeting mechanism, not two).
  buy_quantity: number | null
  get_quantity: number | null
  get_discount_percent: number | null
  // When true, this coupon/promotion may combine with an independently
  // qualifying bundle discount (see supabase/functions/_shared/pricing.ts).
  stackable: boolean
  created_at: string
}

// A standalone "buy these products together for a discount" promotion --
// independent of the coupons table. Public SELECT (see migration); admin-only
// write.
export type Bundle = {
  id: string
  name: string
  description: string | null
  discount_type: 'percentage' | 'fixed'
  discount_value: number
  active: boolean
  created_at: string
}

// Required product_id + quantity for a bundle. Matched by product_id only
// (not size/color) -- bundles are product-level, not variant-level.
export type BundleItem = {
  id: string
  bundle_id: string
  product_id: string
  quantity: number
}

export type CouponRedemption = {
  id: string
  coupon_id: string
  order_id: string
  customer_email: string | null
  redeemed_at: string
}

// Per-user saved products. RLS restricts every row to user_id = auth.uid(),
// so the client only ever sees/mutates its own rows.
export type WishlistItem = {
  id: string
  user_id: string
  product_id: string
  created_at: string
}

// Singleton row -- always read/write id = '00000000-0000-0000-0000-000000000001'
// (seeded once by the migration; a check constraint forbids any other id).
// Public SELECT (storefront needs the active logo/favicon as an anon
// visitor); UPDATE is admin-only. No INSERT/DELETE from the client.
export type StoreSettings = {
  id: string
  logo_url: string | null
  favicon_url: string | null
  // The column still exists and is kept in sync with the DB row, but nothing
  // reads or writes it anymore -- the admin display-currency selector this
  // once backed was removed (CurrencyContext.tsx always renders EGP, the only
  // currency Kashier ever settles).
  currency: string
  updated_at: string
}

export type Profile = {
  id: string
  email: string | null
  full_name: string | null
  role: string
  created_at: string
}

// Public SELECT is RLS-restricted to active=true (storefront-safe for anon
// visitors); insert/update/delete is admin-only.
export type HeroBanner = {
  id: string
  title: string
  subtitle: string | null
  cta_text: string | null
  cta_link: string | null
  image_url: string | null
  position: number
  active: boolean
  created_at: string
}

// Populated only by the log_activity() trigger (see migrations) on
// products/orders/coupons -- no client, including an admin's own session,
// can insert/update/delete rows here directly (no RLS write policy exists
// for any role). actor_id is null for writes made by a service-role edge
// function (e.g. fulfill_order's own order updates).
// Homepage CMS copy, keyed by section (hero/showcase/curated/limited_drop/
// trust_badges/atelier) -- public SELECT, admin-only write. `value` shape
// varies per key; see AdminHomepage.tsx for the per-key field lists.
export type SiteContent = {
  key: string
  value: any
  updated_at: string
}

// Homepage social-proof quotes. Public SELECT is RLS-restricted to
// active=true (same convention as HeroBanner); insert/update/delete is
// admin-only. Ordered by `position` (same reorder pattern as hero_banners).
export type Testimonial = {
  id: string
  author_name: string
  author_title: string | null
  quote_en: string
  quote_ar: string
  rating: number | null
  avatar_url: string | null
  position: number
  active: boolean
  created_at: string
}

// Admin-managed product categories. `value` is stored as free text on
// products.category (no FK -- that column predates this table). Public
// SELECT; admin-only write. Ordered by `position`.
export type Category = {
  value: string
  label_en: string
  label_ar: string
  position: number
  created_at: string
}

export type ActivityLog = {
  id: string
  action: string
  entity_type: string
  entity_id: string | null
  actor_id: string | null
  details: any
  created_at: string
}
