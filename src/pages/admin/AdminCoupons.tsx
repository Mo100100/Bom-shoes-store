import { useEffect, useState } from 'react'
import { supabase, Coupon } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useT } from '@/contexts/LanguageContext'
import { Loader2, Plus, X, Edit2, Trash2 } from 'lucide-react'
import LoadErrorPanel from '@/components/LoadErrorPanel'
import { toast } from 'sonner'
import { useCategories } from '@/contexts/CategoriesContext'

type Translations = ReturnType<typeof useT>

const EMPTY: Partial<Coupon> = {
  code: '',
  requires_code: true,
  description: '',
  discount_type: 'percentage',
  discount_value: 0,
  min_order_amount: null,
  max_discount_amount: null,
  usage_limit: null,
  per_customer_limit: null,
  starts_at: null,
  ends_at: null,
  active: true,
  target_type: 'all',
  target_category: null,
  target_product_ids: [],
  buy_quantity: null,
  get_quantity: null,
  get_discount_percent: null,
  stackable: false,
}

type ProductOption = { id: string; name: string }

// `starts_at`/`ends_at` are stored as timestamptz ISO strings; <input
// type="datetime-local"> needs/returns a timezone-less "YYYY-MM-DDTHH:mm" in
// the browser's local time -- these just round-trip between the two.
function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}
function fromLocalInput(v: string): string | null {
  return v ? new Date(v).toISOString() : null
}

function discountLabel(c: Coupon, formatPrice: (n: number) => string, t: Translations): string {
  if (c.discount_type === 'percentage') return t.adminDiscountPercentOff(c.discount_value)
  if (c.discount_type === 'fixed') return t.adminDiscountFixedOff(formatPrice(c.discount_value))
  if (c.discount_type === 'buy_x_get_y') {
    return t.adminDiscountBxgyOff(c.buy_quantity ?? 0, c.get_quantity ?? 0, c.get_discount_percent ?? 0)
  }
  return t.adminFreeShipping
}

function dateRangeLabel(c: Coupon, t: Translations): string {
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : null)
  const start = fmt(c.starts_at)
  const end = fmt(c.ends_at)
  if (!start && !end) return t.adminNoDateLimit
  return `${start || t.adminAny} → ${end || t.adminAny}`
}

export default function AdminCoupons() {
  const [coupons, setCoupons] = useState<Coupon[]>([])
  const [usageCounts, setUsageCounts] = useState<Record<string, number>>({})
  const [products, setProducts] = useState<ProductOption[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState<Partial<Coupon> | null>(null)
  const [saving, setSaving] = useState(false)
  const { isAdmin } = useAuth()
  const { formatPrice, currency } = useCurrency()
  const { categories } = useCategories()
  const t = useT()
  const CATEGORY_VALUES = categories.map(c => c.value)

  async function load() {
    setLoading(true)
    const [couponRes, redemptionRes, productRes] = await Promise.all([
      supabase.from('coupons').select('*').order('created_at', { ascending: false }),
      // Grouped in SQL. This used to download every redemption row in the shop
      // and tally them in a loop, capped at max_rows = 1000, so a busy code
      // could read as barely used here while the checkout was already
      // refusing it. The view is one row per redeemed coupon, so its size
      // follows the coupon list rather than the order book.
      supabase.from('coupon_redemption_counts').select('coupon_id, redemption_count'),
      supabase.from('products').select('id, name').order('name'),
    ])
    // "No coupons yet" over live discount codes invites the owner to create a
    // second SAVE20 that then stacks with the first one.
    const failed = !!(couponRes.error || redemptionRes.error || productRes.error)
    setLoadError(failed)
    setCoupons(failed ? [] : couponRes.data || [])
    setProducts(failed ? [] : productRes.data || [])
    const counts: Record<string, number> = {}
    if (!failed) for (const r of redemptionRes.data || []) counts[r.coupon_id] = Number(r.redemption_count) || 0
    setUsageCounts(counts)
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  function openNew() {
    setEditing({ ...EMPTY })
  }
  function openEdit(c: Coupon) {
    setEditing({ ...c })
  }

  async function toggleActive(c: Coupon) {
    const { error } = await supabase.from('coupons').update({ active: !c.active }).eq('id', c.id)
    if (error) { toast.error(error.message); return }
    load()
  }

  async function handleSave() {
    if (!editing) return
    if (editing.requires_code && !editing.code?.trim()) {
      toast.error(t.adminCodeRequired)
      return
    }
    setSaving(true)
    try {
      const payload = {
        // Stored upper case so a customer typing `save20` matches `SAVE20`
        // (the lookup upper-cases too). The database enforces both this and
        // the null on an auto promotion; see the 20260807000000 migration.
        code: editing.requires_code ? editing.code!.trim().toUpperCase() : null,
        requires_code: !!editing.requires_code,
        description: editing.description?.trim() || null,
        discount_type: editing.discount_type || 'percentage',
        discount_value: Number(editing.discount_value) || 0,
        min_order_amount: editing.min_order_amount === null || editing.min_order_amount === undefined || (editing.min_order_amount as any) === '' ? null : Number(editing.min_order_amount),
        max_discount_amount: editing.max_discount_amount === null || editing.max_discount_amount === undefined || (editing.max_discount_amount as any) === '' ? null : Number(editing.max_discount_amount),
        usage_limit: editing.usage_limit === null || editing.usage_limit === undefined || (editing.usage_limit as any) === '' ? null : Number(editing.usage_limit),
        per_customer_limit: editing.per_customer_limit === null || editing.per_customer_limit === undefined || (editing.per_customer_limit as any) === '' ? null : Number(editing.per_customer_limit),
        starts_at: editing.starts_at || null,
        ends_at: editing.ends_at || null,
        active: !!editing.active,
        target_type: editing.target_type || 'all',
        target_category: editing.target_type === 'category' ? (editing.target_category || null) : null,
        target_product_ids: editing.target_type === 'products' ? (editing.target_product_ids || []) : [],
        buy_quantity: editing.discount_type === 'buy_x_get_y' ? Number(editing.buy_quantity) || null : null,
        get_quantity: editing.discount_type === 'buy_x_get_y' ? Number(editing.get_quantity) || null : null,
        get_discount_percent: editing.discount_type === 'buy_x_get_y' ? Number(editing.get_discount_percent) || null : null,
        stackable: !!editing.stackable,
      }

      if (editing.id) {
        const { data, error } = await supabase.from('coupons').update(payload).eq('id', editing.id).select('id')
        if (error) throw error
        // A zero-row match returns no error, so without this a tightened limit
        // or an end date that never landed would still toast "Coupon updated".
        if (!data.length) throw new Error(t.adminSaveNotApplied)
      } else {
        const { error } = await supabase.from('coupons').insert(payload)
        if (error) throw error
      }

      toast.success(editing.id ? t.adminCouponUpdated : t.adminCouponCreated)
      setEditing(null)
      load()
    } catch (e: any) {
      toast.error(e.message || t.adminGenericError)
    } finally {
      setSaving(false)
    }
  }

  // Deleting a redeemed coupon is money history, not a list entry.
  // coupon_redemptions.coupon_id cascades on delete while orders.coupon_id has
  // no delete action, so the database either refuses the delete with a raw
  // Postgres message or, for an order that was since removed, destroys the
  // redemption rows the per-customer limit is counted from. Neither is
  // something to find out by clicking.
  async function handleDelete(c: Coupon) {
    const used = usageCounts[c.id] || 0
    // The counts come from the same read that renders this row, and a failed
    // read renders LoadErrorPanel instead of the table, so this is never a
    // guess at zero.
    if (used > 0) { toast.error(t.adminCouponHasRedemptions(used)); return }
    if (!confirm(t.adminCouponDeleteConfirm(c.code || t.adminThisAutoPromotion))) return
    const { data, error } = await supabase.from('coupons').delete().eq('id', c.id).select('id')
    // An order can carry coupon_id without a redemption row (it was placed but
    // never paid), so the foreign key can still refuse what the count allowed.
    // That refusal arrives as a raw English constraint message otherwise.
    if (error?.code === '23503') { toast.error(t.adminCouponOnOrders); return }
    if (error) { toast.error(error.message); return }
    // A zero-row delete returns no error: an RLS denial would otherwise toast
    // "Coupon deleted" over a coupon the checkout is still applying.
    if (!data.length) { toast.error(t.adminDeleteFailed); return }
    toast.success(t.adminCouponDeleted)
    load()
  }

  function toggleTargetProduct(id: string) {
    setEditing(prev => {
      if (!prev) return prev
      const set = new Set(prev.target_product_ids || [])
      if (set.has(id)) set.delete(id); else set.add(id)
      return { ...prev, target_product_ids: Array.from(set) }
    })
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        {/* A count over a failed read would read as "you have no coupons". */}
        {!loadError && <p className="text-sm text-muted-foreground">{t.adminCouponCount(coupons.length)}</p>}
        {isAdmin && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 text-sm tracking-wider hover:bg-primary/90 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {t.adminAddCoupon}
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-24 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <LoadErrorPanel onRetry={load} />
      ) : (
        <div className="border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs tracking-widest uppercase text-muted-foreground">
                <tr>
                  <th className="text-start px-4 py-3">{t.adminCouponCode}</th>
                  <th className="text-start px-4 py-3">{t.adminDiscount}</th>
                  <th className="text-start px-4 py-3">{t.adminCouponStackable}</th>
                  <th className="text-start px-4 py-3">{t.adminActiveLabel}</th>
                  <th className="text-start px-4 py-3">{t.adminCouponUsage}</th>
                  <th className="text-start px-4 py-3">{t.adminCouponDates}</th>
                  <th className="text-end px-4 py-3">{t.adminActions}</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map(c => (
                  <tr key={c.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <p className="font-mono font-medium">{c.code || t.adminCouponAutoApply}</p>
                      {c.description && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{c.description}</p>}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{discountLabel(c, formatPrice, t)}</td>
                    <td className="px-4 py-3 text-muted-foreground">{c.stackable ? t.yes : t.dash}</td>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={c.active}
                        onChange={() => toggleActive(c)}
                        className="w-4 h-4 cursor-pointer"
                        aria-label={t.adminActiveLabel}
                      />
                    </td>
                    <td className="px-4 py-3">
                      {usageCounts[c.id] || 0} / {c.usage_limit ?? '∞'}
                    </td>
                    <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">{dateRangeLabel(c, t)}</td>
                    <td className="px-4 py-3 text-end">
                      <button onClick={() => openEdit(c)} className="p-1.5 hover:bg-muted cursor-pointer" aria-label={t.adminEditCoupon}>
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDelete(c)} className="p-1.5 hover:bg-muted text-red-700 cursor-pointer" aria-label={t.adminDeleteCoupon}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {coupons.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">{t.adminNoCoupons}</td>
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
              <h2 className="font-display text-2xl">{editing.id ? t.adminEditCoupon : t.adminNewCoupon}</h2>
              <button onClick={() => setEditing(null)} className="p-2 cursor-pointer" aria-label={t.adminClose}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!editing.requires_code}
                  onChange={e => setEditing({ ...editing, requires_code: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-sm">{editing.requires_code ? t.adminRequiresCode : t.adminAppliesAutomatically}</span>
              </label>

              {editing.requires_code && (
                <Field label={t.adminCouponCode} value={editing.code || ''} onChange={v => setEditing({ ...editing, code: v.toUpperCase() })} />
              )}

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
                    onChange={e => setEditing({ ...editing, discount_type: e.target.value as Coupon['discount_type'] })}
                    className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
                  >
                    <option value="percentage">{t.adminPercentage}</option>
                    <option value="fixed">{t.adminFixedAmount}</option>
                    <option value="free_shipping">{t.adminFreeShipping}</option>
                    <option value="buy_x_get_y">{t.adminBuyXGetY}</option>
                  </select>
                </div>
                <Field
                  label={editing.discount_type === 'percentage' ? t.adminDiscountPercentField : t.adminDiscountAmountField(currency)}
                  type="number"
                  value={String(editing.discount_value ?? 0)}
                  onChange={v => setEditing({ ...editing, discount_value: Number(v) })}
                  disabled={editing.discount_type === 'free_shipping' || editing.discount_type === 'buy_x_get_y'}
                />
              </div>

              {editing.discount_type === 'buy_x_get_y' && (
                <div className="grid grid-cols-3 gap-4">
                  <Field label={t.adminBuyQuantity} type="number" value={editing.buy_quantity != null ? String(editing.buy_quantity) : ''} onChange={v => setEditing({ ...editing, buy_quantity: v === '' ? null : Number(v) })} />
                  <Field label={t.adminGetQuantity} type="number" value={editing.get_quantity != null ? String(editing.get_quantity) : ''} onChange={v => setEditing({ ...editing, get_quantity: v === '' ? null : Number(v) })} />
                  <Field label={t.adminGetDiscountPercent} type="number" value={editing.get_discount_percent != null ? String(editing.get_discount_percent) : ''} onChange={v => setEditing({ ...editing, get_discount_percent: v === '' ? null : Number(v) })} />
                </div>
              )}

              <div className="grid grid-cols-2 gap-4">
                <Field label={t.adminMinOrderAmount(currency)} type="number" value={editing.min_order_amount != null ? String(editing.min_order_amount) : ''} onChange={v => setEditing({ ...editing, min_order_amount: v === '' ? null : Number(v) })} />
                <Field label={t.adminMaxDiscountAmount(currency)} type="number" value={editing.max_discount_amount != null ? String(editing.max_discount_amount) : ''} onChange={v => setEditing({ ...editing, max_discount_amount: v === '' ? null : Number(v) })} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field label={t.adminUsageLimit} type="number" value={editing.usage_limit != null ? String(editing.usage_limit) : ''} onChange={v => setEditing({ ...editing, usage_limit: v === '' ? null : Number(v) })} />
                <Field label={t.adminPerCustomerLimit} type="number" value={editing.per_customer_limit != null ? String(editing.per_customer_limit) : ''} onChange={v => setEditing({ ...editing, per_customer_limit: v === '' ? null : Number(v) })} />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field label={t.adminStartsAt} type="datetime-local" value={toLocalInput(editing.starts_at)} onChange={v => setEditing({ ...editing, starts_at: fromLocalInput(v) })} />
                <Field label={t.adminEndsAt} type="datetime-local" value={toLocalInput(editing.ends_at)} onChange={v => setEditing({ ...editing, ends_at: fromLocalInput(v) })} />
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

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={!!editing.stackable}
                  onChange={e => setEditing({ ...editing, stackable: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-sm">{t.adminStackableLabel}</span>
              </label>

              <div className="pt-2 border-t border-border">
                <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2 mt-4">{t.adminAppliesTo}</label>
                <select
                  value={editing.target_type || 'all'}
                  onChange={e => setEditing({ ...editing, target_type: e.target.value as Coupon['target_type'] })}
                  className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
                >
                  <option value="all">{t.adminWholeOrder}</option>
                  <option value="category">{t.adminACategory}</option>
                  <option value="products">{t.adminSpecificProducts}</option>
                </select>

                {editing.target_type === 'category' && (
                  <select
                    value={editing.target_category || ''}
                    onChange={e => setEditing({ ...editing, target_category: e.target.value })}
                    className="w-full mt-3 bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
                  >
                    <option value="" disabled>{t.adminSelectCategory}</option>
                    {CATEGORY_VALUES.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                )}

                {editing.target_type === 'products' && (
                  <div className="mt-3 max-h-48 overflow-y-auto border border-border p-3 space-y-2">
                    {products.length === 0 && <p className="text-sm text-muted-foreground">{t.adminNoProductsYet}</p>}
                    {products.map(p => (
                      <label key={p.id} className="flex items-center gap-2 cursor-pointer text-sm">
                        <input
                          type="checkbox"
                          checked={(editing.target_product_ids || []).includes(p.id)}
                          onChange={() => toggleTargetProduct(p.id)}
                          className="w-4 h-4"
                        />
                        {p.name}
                      </label>
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
                disabled={saving}
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

function Field({ label, value, onChange, type = 'text', disabled = false }: { label: string; value: string; onChange: (v: string) => void; type?: string; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{label}</span>
      <input
        type={type}
        value={value}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none disabled:opacity-40"
      />
    </label>
  )
}
