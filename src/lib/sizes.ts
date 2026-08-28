// Size strings: splitting what an admin typed, and ordering sizes for display.
//
// Why this exists: variant sizes used to be entered as one slash-joined string
// ('41/42/43') stored in a SINGLE product_variants row, so the cart showed a
// "size" nobody picked. splitSizes() is the input-side fix (mirrored by a CHECK
// constraint on product_variants.size), compareSizes() is the display-side one
// so `9` lists before `10` instead of after it.
//
// Pure and dependency-free on purpose: `src/lib/sizes.test.mjs` imports it
// directly under `node --test`.

// The separators an admin realistically types between sizes. Not global, so
// .test() stays stateless.
const SIZE_SEPARATORS = /[/,]/

// Just enough of a variant row to order and pick from. Structural on purpose so
// this module stays free of the Supabase types.
export type SizedVariant = {
  size: string
  color: string
  stock: number
}

// One entered size box -> the sizes it actually means. '41/42, 43' becomes
// ['41','42','43']; blank segments and duplicates are dropped, so a box holding
// nothing usable returns [] and the caller can reject the row.
export function splitSizes(input: string): string[] {
  const parts = input.split(SIZE_SEPARATORS).map(s => s.trim()).filter(Boolean)
  return Array.from(new Set(parts))
}

// Numeric when both sides are numbers, so 9 sorts before 10 and before 40.
// Numbers come before words when the two are mixed; everything else falls back
// to localeCompare so 'L' and 'XL' still order predictably.
export function compareSizes(a: string, b: string): number {
  const aNum = a.trim() !== '' && Number.isFinite(Number(a))
  const bNum = b.trim() !== '' && Number.isFinite(Number(b))
  if (aNum && bNum) return Number(a) - Number(b)
  if (aNum) return -1
  if (bNum) return 1
  return a.localeCompare(b)
}

// The variant a quick-add should pick: smallest in-stock size, so the same
// card always adds the same thing instead of whatever the fetch returned first.
export function firstInStockVariant<T extends SizedVariant>(variants: T[]): T | undefined {
  return variants.filter(v => v.stock > 0).sort((a, b) => compareSizes(a.size, b.size))[0]
}

// Which size the picker should land on for a colour: its smallest in-stock
// size, or its smallest size at all when that colour is sold out, so the
// selection is never left empty.
export function defaultSizeForColor(variants: SizedVariant[], color: string): string {
  const forColor = variants.filter(v => v.color === color)
  const inStock = firstInStockVariant(forColor)
  if (inStock) return inStock.size
  return [...forColor].sort((a, b) => compareSizes(a.size, b.size))[0]?.size ?? ''
}
