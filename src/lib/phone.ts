// Egyptian mobile numbers are 11 digits starting 01. Customers type them in
// every shape a phone offers: +20, 0020, spaces, dashes, brackets, and
// Arabic-Indic digits from an Arabic keyboard (the store's default language).
// Every one of those is a number a courier can dial, so this normalises them
// instead of refusing them: a rejected checkout over formatting costs a sale,
// and a wrong number costs a delivery.

// Arabic-Indic (U+0660) and Extended Arabic-Indic / Persian (U+06F0). Both
// reach a form from an Egyptian phone keyboard depending on the layout.
function digitValue(d: string): string {
  const code = d.charCodeAt(0)
  if (code >= 0x0660 && code <= 0x0669) return String(code - 0x0660)
  if (code >= 0x06f0 && code <= 0x06f9) return String(code - 0x06f0)
  return d
}

export function toWesternDigits(raw: string): string {
  return raw.replace(/[٠-٩۰-۹]/g, digitValue)
}

// Returns the canonical 01xxxxxxxxx form, or null when it is not an Egyptian
// mobile number. Callers submit the normalised value so the courier always
// dials the same shape whatever the customer typed.
//
// Deliberately 01 + 9 digits rather than the four live operator prefixes
// (010/011/012/015): blocking a real customer is worse than accepting a
// number that will simply not connect, and a new prefix would otherwise be a
// silent outage at checkout.
export function normalizeEgyptPhone(raw: string): string | null {
  let digits = toWesternDigits(raw).replace(/\D/g, '')
  if (digits.startsWith('00')) digits = digits.slice(2) // 0020...
  if (digits.startsWith('20')) digits = digits.slice(2) // +20 / 20...
  // Typed without the leading zero, which is what the +20 form looks like once
  // the country code is gone.
  if (!digits.startsWith('0')) digits = `0${digits}`
  return /^01\d{9}$/.test(digits) ? digits : null
}
