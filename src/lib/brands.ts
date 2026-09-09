// Brand identity: the display lookup, and the rules a new brand key must pass.
//
// `brands.value` is the PRIMARY KEY and `products.brand` stores it as free
// text with no foreign key, so the key is an IMMUTABLE identifier and `name`
// is the editable display label. Nothing in the admin may change `value` once
// a row exists: that is what stops a rename from orphaning every product
// pointing at the old key, which is exactly how the live row
// value='ل' / name='Burberry' came to exist.
//
// Because the key never changes, every screen has to render `name` rather than
// the raw stored value -- brandLabel() is the brand-side mirror of
// CategoriesContext.categoryLabel().
//
// Pure and dependency-free on purpose: `src/lib/brands.test.mjs` imports it
// directly under `node --test`.

// Just enough of a brand row to label with. Structural so this module stays
// free of the Supabase types.
export type LabelledBrand = {
  value: string
  name: string
}

// A key is created from the name typed at add time, so the name rules are the
// key rules. Two characters minimum because a single stray keystroke is what
// produced the corrupted row, and a one-character key is never a real brand.
export const MIN_BRAND_NAME_LENGTH = 2
export const MAX_BRAND_NAME_LENGTH = 40

export type BrandNameError = 'required' | 'tooShort' | 'tooLong' | 'duplicate'

// Returns the brand's display name, falling back to the raw stored value when
// no row matches (a brand deleted out from under a product, or a value that
// predates the table). Never returns the raw value when a row exists.
export function brandLabel(brands: readonly LabelledBrand[], value: string | null | undefined): string {
  if (!value) return ''
  return brands.find(b => b.value === value)?.name || value
}

// Validation for a value that is about to become a primary key. Categories run
// the identical rule on their `label_en` (their PK is `value`, seeded from it),
// so `existing` is a plain string list rather than a row shape.
//
// The duplicate check is case-insensitive: 'nike' and 'Nike' are distinct
// primary keys but the same brand to a customer, and two rows one letter apart
// in case is unmanageable from the admin list.
export function validateBrandName(raw: string, existing: readonly string[]): BrandNameError | null {
  const name = raw.trim()
  if (!name) return 'required'
  if (name.length < MIN_BRAND_NAME_LENGTH) return 'tooShort'
  if (name.length > MAX_BRAND_NAME_LENGTH) return 'tooLong'
  const folded = name.toLocaleLowerCase()
  if (existing.some(e => e.trim().toLocaleLowerCase() === folded)) return 'duplicate'
  return null
}
