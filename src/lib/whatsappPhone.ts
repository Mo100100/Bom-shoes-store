// Turning whatever the owner typed into the admin's phone field into something
// wa.me can actually dial.
//
// Split out of useWhatsApp.ts (which imports React and the supabase client) so
// `node --test scripts/whatsapp-phone.test.mjs` can reach it. The hook's whole
// stated job is that a dead wa.me link never renders, and this is the part
// that decides it.

// The value the migration seeds the row with. It is not a real number: a link
// built from it opens a chat with a stranger, which is worse than no link at
// all, so it is treated exactly like an unset number and every WhatsApp
// action disappears until the owner sets a real one. Do NOT replace this with
// a guess -- the fix is an admin edit, not a code change.
export const PLACEHOLDER_PHONE = '201234567890'

/**
 * Canonical wa.me digits, or '' when there is nothing dialable.
 *
 * wa.me wants a full international number with no plus and no leading zero,
 * and the owner types the number the way they say it out loud. Same job and
 * the same reasoning as normalizePhone() in
 * supabase/functions/_shared/rate-limit.ts -- one number, many spellings --
 * but the shapes differ: the server keeps the last 11 digits to COUNT by, and
 * this has to produce something DIALABLE, so it is the country code that has
 * to survive here rather than be discarded.
 *
 * A bare local number gets Egypt's country code because Egypt is the only
 * country this store delivers to (27 governorates, see checkoutConfig.ts).
 */
export function normalizeWhatsAppPhone(raw: unknown): string {
  let digits = typeof raw === 'string' ? raw.replace(/\D/g, '') : ''
  if (digits.startsWith('00')) digits = digits.slice(2)      // 0020 100 ...
  else if (digits.startsWith('0')) digits = digits.slice(1)  // local 0100 ...
  // Still short enough to be a local number with no country code on it, which
  // is what an Egyptian owner types by default: 10 digits without the trunk
  // zero, 11 with a longer local prefix.
  if (digits.length === 10 || digits.length === 11) digits = `20${digits}`
  // E.164 allows 8 to 15 digits. Outside that it is a typo, not a number, and
  // rendering a link to it is exactly the dead end this guard exists to stop.
  return digits.length >= 8 && digits.length <= 15 ? digits : ''
}
