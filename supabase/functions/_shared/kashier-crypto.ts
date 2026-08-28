// Shared HMAC-SHA256 helper used by both create-order (to build the hosted
// checkout "hash" param) and kashier-webhook (to verify "x-kashier-signature").
// Kept in one place so the two crypto call sites can't silently drift apart --
// per developers.kashier.io, both use the same algorithm and the same
// Payment API key as the secret.
export async function hmacSha256Hex(message: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message))
  return [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// One-way digest of a string, used only so a signature mismatch can be logged
// and correlated without ever writing the signed message itself to the logs
// (it can contain masked card and customer fields).
export async function sha256Hex(message: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(message))
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('')
}

// Constant-time string compare so signature checks aren't timing-attackable.
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let mismatch = 0
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return mismatch === 0
}
