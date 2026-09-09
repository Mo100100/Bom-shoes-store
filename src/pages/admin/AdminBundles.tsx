import { useEffect, useRef, useState } from 'react'
import { supabase, Bundle } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useT } from '@/contexts/LanguageContext'
import { Loader2, Plus, X, Edit2, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

type Translations = ReturnType<typeof useT>

const EMPTY: Partial<Bundle> = {
  name: '',
  description: '',
  discount_type: 'percentage',
  discount_value: 0,
  active: true,
}

type ProductOption = { id: string; name: string }

// Local editable row for the bundle-items list. `_key` is a stable React key
// that exists even before a row has been saved to the DB (no `id` yet) --
// same approach as AdminProducts' VariantRow.
type ItemRow = {
  id?: string
  product_id: string
  quantity: number
  _key: string
}

function blankItemRow(): ItemRow {
  return { product_id: '', quantity: 1, _key: crypto.randomUUID() }
}

function discountLabel(b: Bundle, formatPrice: (n: number) => string, t: Translations): string {
  return b.discount_type === 'percentage' ? t.adminDiscountPercentOff(b.discount_value) : t.adminDiscountFixedOff(formatPrice(b.discount_value))
}

export default function AdminBundles() {
  const [bundles, setBundles] = useState<Bundle[]>([])
  const [itemCounts, setItemCounts] = useState<Record<string, number>>({})
  const [products, setProducts] = useState<ProductOption[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<Partial<Bundle> | null>(null)
  // `null` means this bundle's items were never read successfully. saveItems
  // replaces the whole list, so an unloaded list must never reach it: that
  // would delete the bundle's real products and put nothing back.
  const [itemRows, setItemRows] = useState<ItemRow[] | null>([])
  const [itemsLoading, setItemsLoading] = useState(false)
  const itemsLoadIdRef = useRef(0)
  const [saving, setSaving] = useState(false)
  const { isAdmin } = useAuth()
  const { formatPrice, currency } = useCurrency()
  const t = useT()

  async function load() {
    setLoading(true)
    const [{ data: bundleRows }, { data: itemRowsData }, { data: productRows }] = await Promise.all([
      supabase.from('bundles').select('*').order('created_at', { ascending: false }),
      supabase.from('bundle_items').select('bundle_id'),
      supabase.from('products').select('id, name').order('name'),
    ])
    setBundles(bundleRows || [])
    setProducts(productRows || [])
    const counts: Record<string, number> = {}
    for (const r of itemRowsData || []) counts[r.bundle_id] = (counts[r.bundle_id] || 0) + 1
    setItemCounts(counts)
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function loadItems(bundleId: string) {
    // Held as null for the whole round trip, so the rows on screen always
    // belong to the bundle being edited: reopening a different bundle can
    // never leave the previous one's items sitting in the editor, ready to be
    // saved over the new bundle. The id guard is Shop.tsx's: only the most
    // recent call may land, so a slow response can't overwrite a newer one.
    const id = ++itemsLoadIdRef.current
    setItemRows(null)
    setItemsLoading(true)
    const { data, error } = await supabase.from('bundle_items').select('*').eq('bundle_id', bundleId)
    if (id !== itemsLoadIdRef.current) return
    setItemsLoading(false)
    if (error) return
    const rows: ItemRow[] = data.map(i => ({ id: i.id, product_id: i.product_id, quantity: i.quantity, _key: i.id }))
    setItemRows(rows.length ? rows : [blankItemRow()])
  }

  function openNew() {
    // Drop any bundle-items read still in flight from a bundle opened before
    // this one, so its rows can't land in the new bundle's editor.
    itemsLoadIdRef.current++
    setItemsLoading(false)
    setEditing({ ...EMPTY })
    setItemRows([blankItemRow()])
  }
  async function openEdit(b: Bundle) {
    setEditing({ ...b })
    await loadItems(b.id)
  }

  function updateItemRow(key: string, field: keyof ItemRow, value: string | number) {
    setItemRows(rows => rows && rows.map(r => (r._key === key ? { ...r, [field]: value } : r)))
  }
  function addItemRow() {
    setItemRows(rows => rows && [...rows, blankItemRow()])
  }
  function removeItemRow(key: string) {
    setItemRows(rows => rows && rows.filter(r => r._key !== key))
  }

  async function toggleActive(b: Bundle) {
    const { error } = await supabase.from('bundles').update({ active: !b.active }).eq('id', b.id)
    if (error) { toast.error(error.message); return }
    load()
  }

  // Full replace against the DB for this bundle: delete every existing
  // bundle_items row, then insert the current set in one batch -- same
  // reasoning as AdminProducts.saveVariants (a per-row update loop can race
  // against unique/foreign-key constraints mid-loop; delete+insert sidesteps
  // that entirely, and this is an admin-only, low-traffic screen).
  //
  // `current` is a parameter, not state: this function deletes every existing
  // row for the bundle, so it must be impossible to call it with a list that
  // came from a failed read. handleSave is the only caller and it cannot get
  // past its own guard with a null list.
  async function saveItems(bundleId: string, current: ItemRow[]) {
    const rows = current
      .filter(r => r.product_id) // ponytail: skip incomplete rows, don't persist rows with no product picked
      .map(row => ({
        bundle_id: bundleId,
        product_id: row.product_id,
        quantity: Number(row.quantity) || 1,
      }))
    const { error: delError } = await supabase.from('bundle_items').delete().eq('bundle_id', bundleId)
    if (delError) throw delError
    if (rows.length) {
      const { error: insError } = await supabase.from('bundle_items').insert(rows)
      if (insError) throw insError
    }
  }

  async function handleSave() {
    if (!editing) return
    if (!editing.name?.trim()) { toast.error(t.adminNameRequired); return }
    // The items list never loaded: saving would wipe the bundle's products.
    if (!itemRows) { toast.error(t.adminBundleItemsLoadError); return }
    setSaving(true)
    try {
      const payload = {
        name: editing.name.trim(),
        description: editing.description?.trim() || null,
        discount_type: editing.discount_type || 'percentage',
        discount_value: Number(editing.discount_value) || 0,
        active: !!editing.active,
      }

      let bundleId = editing.id
      if (bundleId) {
        const { data, error } = await supabase.from('bundles').update(payload).eq('id', bundleId).select('id')
        if (error) throw error
        // A zero-row match returns no error, so without this an RLS denial or
        // a bundle deleted in another tab would report success.
        if (!data.length) throw new Error(t.adminSaveNotApplied)
      } else {
        const { data, error } = await supabase.from('bundles').insert(payload).select().single()
        if (error) throw error
        bundleId = data.id
      }

      await saveItems(bundleId!, itemRows)

      toast.success(editing.id ? t.adminBundleUpdated : t.adminBundleCreated)
      setEditing(null)
      load()
    } catch (e: any) {
      toast.error(e.message || t.adminGenericError)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(b: Bundle) {
    if (!confirm(t.adminDeleteConfirm(b.name))) return
    const { error } = await supabase.from('bundles').delete().eq('id', b.id)
    if (error) { toast.error(error.message); return }
    toast.success(t.adminBundleDeleted)
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <p className="text-sm text-muted-foreground">{t.adminBundleCount(bundles.length)}</p>
        {isAdmin && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 text-sm tracking-wider hover:bg-primary/90 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {t.adminAddBundle}
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-24 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <div className="border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs tracking-widest uppercase text-muted-foreground">
                <tr>
                  <th className="text-start px-4 py-3">{t.adminName}</th>
                  <th className="text-start px-4 py-3">{t.adminDiscount}</th>
                  <th className="text-start px-4 py-3">{t.adminItems}</th>
                  <th className="text-start px-4 py-3">{t.adminActiveLabel}</th>
                  <th className="text-end px-4 py-3">{t.adminActions}</th>
                </tr>
              </thead>
              <tbody>
                {bundles.map(b => (
                  <tr key={b.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <p className="font-medium">{b.name}</p>
                      {b.description && <p className="text-xs text-muted-foreground truncate max-w-[240px]">{b.description}</p>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{discountLabel(b, formatPrice, t)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{itemCounts[b.id] || 0}</td>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={b.active}
                        onChange={() => toggleActive(b)}
                        className="w-4 h-4 cursor-pointer"
                        aria-label={t.adminActiveLabel}
                      />
                    </td>
                    <td className="px-4 py-3 text-end">
                      <button onClick={() => openEdit(b)} className="p-1.5 hover:bg-muted cursor-pointer" aria-label={t.adminEditBundle}>
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDelete(b)} className="p-1.5 hover:bg-muted text-red-700 cursor-pointer" aria-label={t.adminDeleteBundle}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {bundles.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">{t.adminNoBundles}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 bg-foreground/50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-background w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-border sticky top-0 bg-background z-10">
              <h2 className="font-display text-2xl">{editing.id ? t.adminEditBundle : t.adminNewBundle}</h2>
              <button onClick={() => setEditing(null)} className="p-2 cursor-pointer" aria-label={t.adminClose}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <Field label={t.adminName} value={editing.name || ''} onChange={v => setEditing({ ...editing, name: v })} />

              <div>
                <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminDescription}</label>
                <textarea
                  value={editing.description || ''}
                  onChange={e => setEditing({ ...editing, description: e.target.value })}
                  rows={2}
                  className="w-full bg-transparent border border-border p-3 text-sm focus:border-foreground outline-none"
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminDiscountType}</label>
                  <select
                    value={editing.discount_type || 'percentage'}
                    onChange={e => setEditing({ ...editing, discount_type: e.target.value as Bundle['discount_type'] })}
                    className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
                  >
                    <option value="percentage">{t.adminPercentage}</option>
                    <option value="fixed">{t.adminFixedAmount}</option>
                  </select>
                </div>
                <Field
                  label={editing.discount_type === 'percentage' ? t.adminDiscountPercentField : t.adminDiscountAmountField(currency)}
                  type="number"
                  value={String(editing.discount_value ?? 0)}
                  onChange={v => setEditing({ ...editing, discount_value: Number(v) })}
                />
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!editing.active}
                  onChange={e => setEditing({ ...editing, active: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-sm">{t.adminActiveLabel}</span>
              </label>

              {/* --- Required products --- */}
              <div className="pt-2 border-t border-border">
                <div className="flex items-center justify-between mb-2 mt-4">
                  <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminRequiredProducts}</span>
                  {itemRows && <button type="button" onClick={addItemRow} className="text-xs underline cursor-pointer">{t.adminAddRow}</button>}
                </div>
                {itemsLoading ? (
                  <div className="py-6 flex justify-center">
                    <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                  </div>
                ) : itemRows === null ? (
                  // A failed read is never shown as "no products yet": the rows
                  // editor is replaced outright and Save stays disabled.
                  <div className="py-6 text-center">
                    <p className="text-sm text-terracotta">{t.adminBundleItemsLoadError}</p>
                    <button
                      type="button"
                      onClick={() => editing.id && loadItems(editing.id)}
                      className="mt-3 text-sm border-b border-foreground pb-0.5 cursor-pointer"
                    >
                      {t.failedTryAgain}
                    </button>
                  </div>
                ) : (
                  <div className="space-y-2">
                    {itemRows.map(row => (
                      <div key={row._key} className="grid grid-cols-[1fr_5rem_1.5rem] gap-2 items-center">
                        <select
                          value={row.product_id}
                          onChange={e => updateItemRow(row._key, 'product_id', e.target.value)}
                          className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none cursor-pointer"
                        >
                          <option value="" disabled>{t.adminSelectProduct}</option>
                          {products.map(p => (
                            <option key={p.id} value={p.id}>{p.name}</option>
                          ))}
                        </select>
                        <input
                          type="number"
                          min={1}
                          value={row.quantity}
                          onChange={e => updateItemRow(row._key, 'quantity', Number(e.target.value) || 1)}
                          className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none"
                        />
                        <button type="button" onClick={() => removeItemRow(row._key)} className="p-1 text-red-700 cursor-pointer" aria-label={t.adminRemoveRow}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="p-6 border-t border-border flex items-center justify-end gap-3 sticky bottom-0 bg-background">
              <button onClick={() => setEditing(null)} className="px-5 py-2.5 text-sm border border-border hover:bg-muted cursor-pointer">
                {t.adminCancel}
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !itemRows}
                className="px-5 py-2.5 text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 cursor-pointer flex items-center gap-2"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {editing.id ? t.adminSaveBtn : t.adminCreateBtn}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function Field({ label, value, onChange, type = 'text' }: { label: string; value: string; onChange: (v: string) => void; type?: string }) {
  return (
    <label className="block">
      <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{label}</span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
      />
    </label>
  )
}
