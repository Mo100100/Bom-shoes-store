// Product slugs: the key `/product/:slug` looks a product up by, and the only
// URL a product has.
//
// Why this exists: the generator in AdminProducts kept `[a-z0-9]` and nothing
// else, so an Arabic name collapsed to the empty string. This store is Arabic
// first (index.html is lang="ar" dir="rtl") and every one of its ~118 products
// is named in Arabic, so the generator was useless for every product the owner
// has ever added: they worked around it by typing a single arbitrary character
// or an emoji into the slug box, which is why the live table holds slugs like
// 'ء' and '🐮'. The same habit produced the corrupted brand key 'ل'.
//
// The slug therefore KEEPS Arabic instead of transliterating it. A percent
// encoded Arabic URL is what an Arabic site should have, browsers render it
// back as Arabic in the address bar, and a transliteration table would be one
// more thing to keep in step between here and the database.
//
// Pure and dependency-free on purpose: `src/lib/slug.test.mjs` imports it
// directly under `node --test`.

// What a slug may keep: ASCII alphanumerics plus the Arabic block, which
// covers Arabic letters, the Arabic-Indic digits and the harakat. Everything
// else -- spaces, punctuation, emoji, Latin accents -- becomes a separator.
// The same class is written out in the 20260813000000 migration; keep the two
// in step if either changes.
const SLUG_STRIP = /[^a-z0-9\u0600-\u06ff]+/g
const SLUG_EDGE_DASHES = /^-+|-+$/g

// A name made entirely of what SLUG_STRIP removes (all emoji, say) still has
// to produce a routable URL, so it gets this and a number from nextFreeSlug.
export const FALLBACK_SLUG = 'product'

// Turns a product name, or a slug the admin typed by hand, into a slug.
// Idempotent: slugify(slugify(x)) === slugify(x).
export function slugify(raw: string): string {
  return raw.toLowerCase().replace(SLUG_STRIP, '-').replace(SLUG_EDGE_DASHES, '')
}

// `base`, or the first of base-2, base-3 ... that `taken` does not hold.
// products.slug is UNIQUE, so without this the second Arabic product hit that
// constraint and the owner saw a raw Postgres message.
export function nextFreeSlug(base: string, taken: Iterable<string>): string {
  const stem = base || FALLBACK_SLUG
  const used = new Set(taken)
  if (!used.has(stem)) return stem
  let n = 2
  while (used.has(`${stem}-${n}`)) n++
  return `${stem}-${n}`
}
