// Who is calling? Shared by create-order (which stamps orders.user_id) and
// validate-coupon (which enforces per_customer_limit against that same id),
// so the two can never disagree about the customer's identity.
//
// The Edge Runtime already verified the caller's JWT signature before our
// code ever runs (verify_jwt defaults to true), so this only reads its
// claims. Guest checkouts arrive with the anon key's JWT (role: 'anon', no
// real user), logged-in customers with their access token (role:
// 'authenticated', sub: their user id) -- and a guest therefore has no
// verifiable identity at all, which is the whole reason a coupon limited per
// customer cannot be honoured for one.
export function getUserIdFromAuthHeader(req: Request): string | null {
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
