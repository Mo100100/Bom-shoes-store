// Diffing the admin variant grid against what is already in product_variants.
//
// Why this exists: orders snapshot `variant_id` into their items JSON and
// fulfill_order() looks the row up by that id, so re-creating variant rows on
// every product save (the old delete + insert) handed every variant a new uuid
// and killed any paid order still waiting on its webhook.
//
// The hard part is `unique (product_id, size, color)`. Naive per-row updates
// collide when two rows swap size/color: updating row A to row B's current
// key hits the constraint before row B is touched. This module avoids that by
// matching desired rows to existing rows by their NATURAL KEY first, and only
// falling back to the row id for a genuine rename. A swap therefore becomes
// two rows that each keep their own size/color while their other fields move
// across, so no update ever targets a key another surviving row still holds.
//
// Pure and dependency-free on purpose: `scripts/variant-diff.test.mjs` imports
// it directly under `node --test`.

// The subset of an existing DB row the diff needs.
export type ExistingVariant = {
  id: string
  size: string
  color: string
}

// One row of the admin grid, already trimmed and coerced. `id` is present only
// for rows that were loaded from the DB.
export type DesiredVariant = {
  id?: string
  size: string
  color: string
  sku: string | null
  barcode: string | null
  stock: number
  price_override: number | null
}

export type VariantDiff = {
  // Ids of rows the admin removed. Nothing else is ever deleted.
  deletes: string[]
  // Rows that keep an existing id.
  updates: (DesiredVariant & { id: string })[]
  // Genuinely new rows, with no id so the DB generates one.
  inserts: Omit<DesiredVariant, 'id'>[]
}

function naturalKey(row: { size: string; color: string }): string {
  // JSON so one size/color pair can never collide with a different pair that
  // happens to concatenate to the same string.
  return JSON.stringify([row.size, row.color])
}

export function diffVariants(existing: ExistingVariant[], desired: DesiredVariant[]): VariantDiff {
  const byKey = new Map<string, ExistingVariant>()
  const byId = new Map<string, ExistingVariant>()
  for (const row of existing) {
    byKey.set(naturalKey(row), row)
    byId.set(row.id, row)
  }

  const claimed = new Set<string>()
  const updates: (DesiredVariant & { id: string })[] = []
  const inserts: Omit<DesiredVariant, 'id'>[] = []

  // Pass 1: the desired size/color already exists, so that row keeps its id
  // and only its other fields change. This is what makes swaps safe.
  const unmatched: DesiredVariant[] = []
  for (const row of desired) {
    const hit = byKey.get(naturalKey(row))
    if (hit && !claimed.has(hit.id)) {
      claimed.add(hit.id)
      updates.push({ ...row, id: hit.id })
    } else {
      unmatched.push(row)
    }
  }

  // Pass 2: a rename. The row's size/color matches nothing in the DB, so its
  // own id keeps it: the update targets a key no surviving row holds.
  for (const row of unmatched) {
    const hit = row.id ? byId.get(row.id) : undefined
    if (hit && !claimed.has(hit.id)) {
      claimed.add(hit.id)
      updates.push({ ...row, id: hit.id })
    } else {
      // Either brand new, or its id was already claimed / no longer exists.
      // Drop the stale id and let the DB mint one.
      const { id: _stale, ...fields } = row
      inserts.push(fields)
    }
  }

  const deletes = existing.filter(row => !claimed.has(row.id)).map(row => row.id)
  return { deletes, updates, inserts }
}
