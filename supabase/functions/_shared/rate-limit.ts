// supabase/functions/_shared/rate-limit.ts
//
// Rolling-window rate limiting for the public edge functions.
//
// Every one of them is reachable by anyone holding the anon key out of the JS
// bundle (verify_jwt = true does not help: the anon key is itself a valid
// JWT), and CORS is '*'. Without this a script can place cash-on-delivery
// orders in a loop until the catalog reads zero, or enumerate order references
// and coupon codes at full speed.
//
// The counting lives in public.record_rate_limit_attempt() (see
// supabase/migrations/20260806000000_checkout_abuse_controls.sql) so the
// count-and-record is one atomic round trip rather than a read followed by a
// write that another request can slip between. This module owns the two things
// the database should not: how a caller is identified, and what the limits are.

import { hmacSha256Hex } from './kashier-crypto.ts'

type SupabaseLike = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>
}

export type RateLimitRule = {
  /** Groups attempts in the ledger. One value per protected endpoint. */
  endpoint: string
  /** How far back the count looks, in seconds. */
  windowSeconds: number
  /** Max attempts per hashed IP in the window. */
  ipLimit: number
  /** Max attempts per phone number in the window. Omitted where there is no phone. */
  phoneLimit?: number
}

const HOUR = 3600

// Thresholds. Every number here is set so a real customer cannot reach it.
//
// Every IP ceiling assumes carrier-grade NAT, which is the norm on Egyptian
// mobile networks: a single address can legitimately be dozens of unrelated
// shoppers at once. The per-IP numbers are sized for that shared address, not
// for one household, because the cost of getting them wrong is a real customer
// who simply cannot buy.
//
// cod_order is the tight one: it is the only path that decrements real stock
// with no payment. Five COD orders from one phone in six hours is already well
// past anything a genuine shopper does (an honest reorder or a split delivery
// is two or three), and the phone limit is the one that actually bites an
// honest-looking flood. 60 per IP per six hours allows a busy shared address
// while still capping a script at 60 reservations per six hours instead of
// thousands a minute. The expiry job then returns even those.
//
// online_order is deliberately looser: it reserves no stock, and every retry
// of a declined card legitimately creates another order row. It exists only to
// stop unbounded row insertion and unbounded Kashier session creation.
//
// order_status and validate_coupon are read-only existence oracles, and both
// are called AUTOMATICALLY rather than only on a user action: order-status on
// every CheckoutSuccess mount, and validate-coupon on every Cart and Checkout
// mount, coupon or no coupon (it now previews auto-applied promotions too, so
// the storefront total matches the amount charged). So their ceilings have to
// cover a page-load per shopper, not a deliberate attempt per shopper.
//
// validate_coupon is therefore the loosest of the four: an ordinary shopper
// with no coupon at all spends two of its allowance just walking from the
// basket to the checkout form, so 240 per 10 minutes is roughly 120 unrelated
// shoppers behind one carrier-NAT address. It costs nothing defensively: an
// enumerator still gets only about 34k tries a day against a code space
// vastly larger than that, and the response no longer tells them whether a
// code they guessed actually exists (see validate-coupon/index.ts), which is
// what made enumeration worth attempting in the first place.
export const RATE_LIMITS = {
  codOrder: { endpoint: 'cod_order', windowSeconds: 6 * HOUR, ipLimit: 60, phoneLimit: 5 },
  onlineOrder: { endpoint: 'online_order', windowSeconds: HOUR, ipLimit: 120, phoneLimit: 15 },
  orderStatus: { endpoint: 'order_status', windowSeconds: 600, ipLimit: 120 },
  validateCoupon: { endpoint: 'validate_coupon', windowSeconds: 600, ipLimit: 240 },
} satisfies Record<string, RateLimitRule>

// Never store or log a raw IP. HMAC rather than a bare SHA-256 because the
// IPv4 space is small enough to reverse a plain digest of by brute force in
// minutes; with a secret key the hash is only comparable, not reversible.
//
// The key is RATE_LIMIT_SALT when set, otherwise the service-role key, which
// is already secret, already present in every function's environment and
// stable across invocations. That default means this works with no new
// configuration; rotating it just resets everyone's window once.
async function hashIp(ip: string): Promise<string> {
  const salt = Deno.env.get('RATE_LIMIT_SALT') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || ''
  if (!salt) {
    // An empty key makes this a plain unsalted digest, and the IPv4 space is
    // small enough to reverse one of those by brute force in minutes -- so the
    // ledger would then hold effectively-recoverable IP addresses. This should
    // be impossible (SUPABASE_SERVICE_ROLE_KEY is injected into every function)
    // and is loud rather than silent because it is a privacy regression, not a
    // functional one: rate limiting still works either way.
    console.error('rate-limit: neither RATE_LIMIT_SALT nor SUPABASE_SERVICE_ROLE_KEY is set, IP hashes are UNSALTED and reversible. Set RATE_LIMIT_SALT.')
  }
  return await hmacSha256Hex(ip, salt)
}

// x-forwarded-for is "<client>, <proxy>, ..." and anything a client sends is
// prepended to what the platform appends, so the FIRST entry is attacker
// controlled and the LAST is the peer our own gateway actually saw. Taking the
// last is the only entry a caller cannot forge, and when nothing was forwarded
// the header holds a single value, where first and last are the same thing.
//
// UNVERIFIED against a real deployment, and this is the assumption to check
// first if anything here misbehaves: if Supabase's edge appends its own relay
// address, or a CDN sits in front, the last hop is IDENTICAL for every
// customer and the whole store shares one counter, at which point the COD
// limit stops the 61st customer of the day from buying at all. Log a real
// x-forwarded-for from the deployed project and confirm the shape before
// trusting this keying.
export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for') ?? ''
  const hops = forwarded.split(',').map(h => h.trim()).filter(Boolean)
  return hops.length > 0 ? hops[hops.length - 1] : (req.headers.get('x-real-ip') || null)
}

// Digits only, so '0100 123 4567' and '+201001234567' are not counted as two
// different customers. Kept as the last 11 digits: an Egyptian mobile number
// is 11 digits, with or without a country code in front.
export function normalizePhone(phone: string | null | undefined): string | null {
  const digits = (phone ?? '').replace(/\D/g, '')
  return digits ? digits.slice(-11) : null
}

/**
 * Records this attempt and reports whether the caller is still within the
 * rule's limits. Returns true to proceed, false to reject with 429.
 *
 * Fails OPEN: if the ledger itself is unreachable, a real customer must still
 * be able to buy. The failure is logged so it does not pass unnoticed.
 */
export async function checkRateLimit(
  admin: SupabaseLike,
  req: Request,
  rule: RateLimitRule,
  opts: { phone?: string | null; orderRef?: string | null } = {},
): Promise<boolean> {
  const ip = clientIp(req)
  if (!ip) return true

  try {
    const { data, error } = await admin.rpc('record_rate_limit_attempt', {
      p_endpoint: rule.endpoint,
      p_ip_hash: await hashIp(ip),
      p_window_seconds: rule.windowSeconds,
      p_ip_limit: rule.ipLimit,
      p_phone: rule.phoneLimit ? normalizePhone(opts.phone) : null,
      p_phone_limit: rule.phoneLimit ?? null,
      p_order_ref: opts.orderRef ?? null,
    })
    if (error) throw error
    return data !== false
  } catch (err) {
    console.error(`rate-limit: ledger unavailable for ${rule.endpoint}, allowing request:`, err)
    return true
  }
}
