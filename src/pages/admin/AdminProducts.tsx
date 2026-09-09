import { useEffect, useMemo, useState } from 'react'
import { supabase, Product, ProductImage, ProductCatalogEntry } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useCategories } from '@/contexts/CategoriesContext'
import { useBrands } from '@/contexts/BrandsContext'
import { compressImage } from '@/lib/compressImage'
import { diffVariants, DesiredVariant } from '@/lib/variantDiff'
import { splitSizes } from '@/lib/sizes'
import { Loader2, Plus, X, Edit2, Trash2, Star, Search, ChevronUp, ChevronDown } from 'lucide-react'
import LoadErrorPanel from '@/components/LoadErrorPanel'
import { toast } from 'sonner'

type SortKey = 'name' | 'price'
type SortDir = 'asc' | 'desc'

const EMPTY: Partial<Product> = {
  name: '', slug: '', description: '', price: 0, category: 'Sneakers',
  brand: null, featured: false, materials: '', weight_grams: null, tags: [],
}

// Local editable row for the variant list. `_key` is a stable React key that
// exists even before a row has been saved to the DB (no `id` yet).
type VariantRow = {
  id?: string
  size: string
  color: string
  sku: string
  barcode: string
  stock: number
  price_override: string
  _key: string
}

function blankVariantRow(): VariantRow {
  return { size: '', color: '', sku: '', barcode: '', stock: 0, price_override: '', _key: crypto.randomUUID() }
}

// A row is filler (the blank one openNew() seeds, or one the admin cleared)
// only when BOTH halves of the natural key are empty. Half a row is a mistake.
function isBlankVariantRow(row: VariantRow): boolean {
  return !row.size.trim() && !row.color.trim()
}

// The single derivation of "what the grid means" -- product_variants AND the
// legacy products.sizes/stock/colors columns are both built from this, so they
// can never disagree about which sizes exist.
//
// One size box can name several sizes ('41/42/43'), which is how a whole
// slash-joined string used to end up in one variant row and then in the cart.
// Each named size becomes its own row here.
//
// Stock is the stock of EACH size the row expands to, not a total to divide:
// an admin typing 41/42/43 with stock 2 has two pairs in each of those sizes,
// and splitting 2 across three sizes would invent a fractional or zero count
// nobody entered. The id and the sku identify one physical variant, so only
// the first expanded size can keep them; the rest are new rows to be filled in.
function expandVariantRows(rows: VariantRow[]): DesiredVariant[] {
  return rows.flatMap(row => {
    const color = row.color.trim()
    if (!color) return []
    return splitSizes(row.size).map((size, index) => ({
      id: index === 0 ? row.id : undefined,
      size,
      color,
      sku: index === 0 ? (row.sku.trim() || null) : null,
      barcode: index === 0 ? (row.barcode.trim() || null) : null,
      stock: Number(row.stock) || 0,
      price_override: row.price_override.trim() === '' ? null : Number(row.price_override),
    }))
  })
}

// Recomputes products.image_url from the current product_images rows so every
// page that still reads that legacy column (cart, admin orders list, etc.)
// keeps showing a sensible thumbnail. Featured image wins; otherwise first by
// position; empty string if the gallery is empty.
async function syncFeaturedImage(productId: string) {
  const { data } = await supabase.from('product_images').select('*').eq('product_id', productId).order('position')
  const rows = data || []
  const featured = rows.find(i => i.is_featured) || rows[0]
  await supabase.from('products').update({ image_url: featured?.url || '' }).eq('id', productId)
}

export default function AdminProducts() {
  const [products, setProducts] = useState<ProductCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState<Partial<Product> | null>(null)
  const [saving, setSaving] = useState(false)
  const [images, setImages] = useState<ProductImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [variantRows, setVariantRows] = useState<VariantRow[]>([])
  // Per-row validation messages, keyed by VariantRow._key. Set on save,
  // cleared as soon as the admin edits the row they belong to.
  const [variantErrors, setVariantErrors] = useState<Record<string, string>>({})
  // cost_price lives in its own admin-only-select table (product_costs), not
  // on products/product_catalog -- see migration comment. Tracked separately
  // here rather than on `editing` since it's not part of the Product type.
  const [costPrice, setCostPrice] = useState<number | null>(null)
  const [search, setSearch] = useState('')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [sortKey, setSortKey] = useState<SortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('asc')
  const { isAdmin } = useAuth()
  const t = useT()
  const { formatPrice, currency } = useCurrency()
  const { categories, categoryLabel, loadError: categoriesLoadError } = useCategories()
  const { brands, brandLabel, loadError: brandsLoadError } = useBrands()
  const CATEGORY_VALUES = categories.map(c => c.value)
  // What the two selects in the editor are actually bound to. A product can
  // hold a category or brand that is no longer in its list (renamed, deleted,
  // or seeded before the table existed); a <select> whose value matches no
  // <option> renders the FIRST option instead, so the control claimed the
  // product was a Sneaker while `editing.category` still held the old value
  // and the save wrote the old value back. Both now render the stored value as
  // an explicit "not in list" option, so the screen cannot disagree with the
  // payload.
  const editingCategory = editing?.category || 'Sneakers'
  const editingBrand = editing?.brand ?? ''

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(dir => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const visibleProducts = useMemo(() => {
    const q = search.trim().toLowerCase()
    let rows = products.filter(p => {
      if (q && !p.name.toLowerCase().includes(q)) return false
      if (categoryFilter !== 'all' && p.category !== categoryFilter) return false
      return true
    })
    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        const diff = sortKey === 'name'
          ? a.name.localeCompare(b.name)
          : Number(a.price) - Number(b.price)
        return sortDir === 'asc' ? diff : -diff
      })
    }
    return rows
  }, [products, search, categoryFilter, sortKey, sortDir])

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('product_catalog').select('*').order('created_at', { ascending: false })
    // A failed read is not an empty catalog: "No products yet" over 118 live
    // products is exactly the kind of thing that sends an owner looking for a
    // backup that was never needed.
    setLoadError(!!error)
    setProducts(error ? [] : data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function loadImages(productId: string) {
    const { data } = await supabase.from('product_images').select('*').eq('product_id', productId).order('position')
    setImages(data || [])
  }

  // Returns whether the rows in the grid are the ones the database holds.
  // handleSave replaces the whole variant set from this grid, so an empty grid
  // built from a FAILED read would delete every size the product has, with its
  // stock. openEdit refuses to open the editor at all in that case.
  async function loadVariants(productId: string): Promise<boolean> {
    const { data, error } = await supabase.from('product_variants').select('*').eq('product_id', productId).order('created_at')
    if (error) return false
    const rows: VariantRow[] = (data || []).map(v => ({
      id: v.id,
      size: v.size,
      color: v.color,
      sku: v.sku || '',
      barcode: v.barcode || '',
      stock: v.stock,
      price_override: v.price_override != null ? String(v.price_override) : '',
      _key: v.id,
    }))
    setVariantRows(rows)
    setVariantErrors({})
    return true
  }

  // Same contract as loadVariants, and for the same reason: handleSave upserts
  // whatever is in the box, so a failed read would write null over the real
  // cost price and every profit figure on the dashboard with it.
  async function loadCostPrice(productId: string): Promise<boolean> {
    const { data, error } = await supabase.from('product_costs').select('cost_price').eq('product_id', productId).maybeSingle()
    if (error) return false
    setCostPrice(data?.cost_price ?? null)
    return true
  }

  function openNew() {
    setEditing({ ...EMPTY })
    setImages([])
    setVariantRows([blankVariantRow()])
    setVariantErrors({})
    setCostPrice(null)
    setDragIndex(null)
  }
  async function openEdit(p: ProductCatalogEntry) {
    setDragIndex(null)
    const [, variantsLoaded, costLoaded] = await Promise.all([loadImages(p.id), loadVariants(p.id), loadCostPrice(p.id)])
    // Opened only once its sizes and its cost are really in hand, so Save can
    // never write an emptiness that came from a dropped read.
    if (!variantsLoaded || !costLoaded) { toast.error(t.adminLoadError); return }
    setEditing({ ...p })
  }

  function updateVariantRow(key: string, field: keyof VariantRow, value: string | number) {
    setVariantRows(rows => rows.map(r => (r._key === key ? { ...r, [field]: value } : r)))
    clearVariantError(key)
  }
  function addVariantRow() {
    setVariantRows(rows => [...rows, blankVariantRow()])
  }
  function removeVariantRow(key: string) {
    setVariantRows(rows => rows.filter(r => r._key !== key))
    clearVariantError(key)
  }
  function clearVariantError(key: string) {
    setVariantErrors(errors => (key in errors ? Object.fromEntries(Object.entries(errors).filter(([k]) => k !== key)) : errors))
  }

  // Writes the grid to product_variants as a diff that PRESERVES row ids.
  // Orders snapshot `variant_id` and fulfill_order() looks the row up by that
  // id, so the old delete + insert gave every variant a new uuid on every
  // product save and killed any paid order still waiting on its webhook.
  //
  // unique(product_id, size, color) was the reason for delete + insert: naive
  // per-row updates collide when two rows swap size/color. diffVariants()
  // matches desired rows to existing rows by their natural key first and only
  // then by id, so a swap leaves both rows on their own size/color while the
  // other fields move across, and no update ever targets a key a surviving row
  // still holds. Order is deletes -> updates -> inserts so a size/color or sku
  // freed by a removed row is available again before another row reuses it.
  //
  // Four queries at most, whatever the row count: one read plus one batched
  // write per operation kind. `desired` comes from expandVariantRows() in
  // handleSave so the legacy columns below are built from the very same list.
  async function saveVariants(productId: string, desired: DesiredVariant[]) {
    // Read the current rows rather than trusting the grid's copy: only the DB
    // knows which ids are still there to be kept, updated or removed.
    const { data: existing, error: loadError } = await supabase
      .from('product_variants').select('id, size, color').eq('product_id', productId)
    if (loadError) throw loadError

    const { deletes, updates, inserts } = diffVariants(existing || [], desired)

    if (deletes.length) {
      const { error } = await supabase.from('product_variants').delete().in('id', deletes)
      // The database refuses to remove a variant an order is still waiting to
      // be paid for: fulfill_order() looks the row up by id when the payment
      // lands, and a missing row kills that paid order with its stock never
      // decremented. Deletes run first here, so no other variant write has
      // happened, but the product row above IS already committed -- which is
      // exactly what the message says.
      if (error?.hint === 'variant_in_live_order') throw new Error(t.adminVariantInLiveOrder)
      if (error) throw error
    }
    if (updates.length) {
      // upsert on the primary key: one statement for every kept row.
      const { error } = await supabase.from('product_variants')
        .upsert(updates.map(row => ({ ...row, product_id: productId })))
      if (error) throw error
    }
    if (inserts.length) {
      const { error } = await supabase.from('product_variants')
        .insert(inserts.map(row => ({ ...row, product_id: productId })))
      if (error) throw error
    }
  }

  async function handleUpload(files: FileList | null) {
    if (!files || !files.length || !editing?.id) return
    const productId = editing.id
    setUploading(true)
    try {
      let position = images.length ? Math.max(...images.map(i => i.position)) + 1 : 0
      for (const raw of Array.from(files)) {
        // Compress before upload to stay lean on free-tier storage/egress.
        const file = await compressImage(raw, { maxDim: 1200 })
        const path = `${productId}/${Date.now()}-${file.name}`
        const { error: upErr } = await supabase.storage.from('product-images').upload(path, file)
        if (upErr) throw upErr
        const { data: pub } = supabase.storage.from('product-images').getPublicUrl(path)
        const { error: insErr } = await supabase.from('product_images').insert({
          product_id: productId, url: pub.publicUrl, position: position++,
        })
        if (insErr) throw insErr
      }
      await loadImages(productId)
      await syncFeaturedImage(productId)
    } catch (e: any) {
      toast.error(e.message || t.adminRequired)
    } finally {
      setUploading(false)
    }
  }

  async function handleDeleteImage(img: ProductImage) {
    if (!editing?.id) return
    // ponytail: storage path is derived from the public URL (bucket name is
    // unique in this project) rather than stored separately.
    const path = img.url.split('/product-images/')[1]
    if (path) await supabase.storage.from('product-images').remove([decodeURIComponent(path)])
    // The file is already gone by here, so a row that survives leaves a broken
    // image in the gallery. Silence was the worst of the three outcomes.
    const { data, error } = await supabase.from('product_images').delete().eq('id', img.id).select('id')
    if (error || !data?.length) toast.error(error?.message || t.adminDeleteFailed)
    await loadImages(editing.id)
    await syncFeaturedImage(editing.id)
  }

  async function handleSetFeatured(img: ProductImage) {
    if (!editing?.id) return
    await supabase.from('product_images').update({ is_featured: false }).eq('product_id', editing.id)
    await supabase.from('product_images').update({ is_featured: true }).eq('id', img.id)
    await loadImages(editing.id)
    await syncFeaturedImage(editing.id)
  }

  async function handleDropImage(dropIndex: number) {
    if (dragIndex === null || dragIndex === dropIndex || !editing?.id) { setDragIndex(null); return }
    const reordered = [...images]
    const [moved] = reordered.splice(dragIndex, 1)
    reordered.splice(dropIndex, 0, moved)
    setImages(reordered)
    setDragIndex(null)
    await Promise.all(reordered.map((img, idx) => supabase.from('product_images').update({ position: idx }).eq('id', img.id)))
  }

  async function handleSave() {
    if (!editing) return
    if (!editing.name || !editing.price) { toast.error(t.adminRequired); return }

    // Reject half-filled rows and size boxes holding nothing usable, inline on
    // the offending row. Dropping them silently is how a product could be saved
    // with fewer sizes than the admin thought they had entered.
    const rowErrors: Record<string, string> = {}
    for (const row of variantRows) {
      if (isBlankVariantRow(row)) continue
      if (!row.color.trim()) rowErrors[row._key] = t.adminVariantColorRequired
      else if (splitSizes(row.size).length === 0) rowErrors[row._key] = t.adminVariantSizeRequired
    }
    setVariantErrors(rowErrors)
    if (Object.keys(rowErrors).length > 0) { toast.error(t.adminVariantRowsInvalid); return }

    const desiredVariants = expandVariantRows(variantRows)
    setSaving(true)
    try {
      const isNew = !editing.id
      const slug = editing.slug || editing.name!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
      const payload = {
        name: editing.name,
        slug,
        description: editing.description || '',
        price: Number(editing.price),
        category: editing.category || 'Sneakers',
        brand: editing.brand?.trim() ? editing.brand.trim() : null,
        featured: !!editing.featured,
        materials: editing.materials?.trim() ? editing.materials.trim() : null,
        weight_grams: editing.weight_grams === null || editing.weight_grams === undefined || (editing.weight_grams as any) === '' ? null : Number(editing.weight_grams),
        tags: editing.tags || [],
      }

      let productId = editing.id
      if (productId) {
        const { data, error } = await supabase.from('products').update(payload).eq('id', productId).select('id')
        if (error) throw error
        // A zero-row match returns no error: an RLS denial, or a product
        // deleted in another tab, would otherwise toast "Product updated"
        // over a row that never changed. The variant writes below would then
        // be attached to a product the owner thinks holds the new price.
        if (!data.length) throw new Error(t.adminSaveNotApplied)
      } else {
        // stock/sizes/colors/image_url are legacy columns this form no longer
        // edits directly; seed them so NOT NULL constraints are satisfied,
        // the variant/image sync below fills in the real values right after.
        const { data, error } = await supabase
          .from('products')
          .insert({ ...payload, stock: 0, sizes: [], colors: [], image_url: '' })
          .select()
          .single()
        if (error) throw error
        productId = data.id
      }

      await saveVariants(productId!, desiredVariants)
      // The cost price is what every profit figure on the dashboard is built
      // from, so a rejected write here must not pass as a saved product.
      const { error: costError } = await supabase
        .from('product_costs').upsert({ product_id: productId, cost_price: costPrice })
      if (costError) throw costError

      // Keep legacy products.stock/sizes/colors in sync from the variants we
      // just wrote, so pages that still read those flat columns directly
      // (Shop, ProductDetail, Cart) don't go stale now that variants are the
      // real source of truth. Same `desiredVariants` list the variant rows came
      // from, so the legacy columns can't reintroduce a crammed size.
      const { error: legacyError } = await supabase.from('products').update({
        stock: desiredVariants.reduce((sum, v) => sum + v.stock, 0),
        sizes: Array.from(new Set(desiredVariants.map(v => v.size))),
        colors: Array.from(new Set(desiredVariants.map(v => v.color))),
      }).eq('id', productId)
      // The zero-row case is already covered by the UPDATE above (same row,
      // same id), but a rejected write is not: Shop, ProductDetail and Cart
      // still read these flat columns, so a silent failure here sells a size
      // that no longer exists.
      if (legacyError) throw legacyError

      toast.success(isNew ? t.adminCreateSuccess : t.adminUpdateSuccess)
      if (isNew) {
        // Keep the modal open so photos can be added right away, now that
        // the product has an id to attach them to.
        setEditing(prev => (prev ? { ...prev, id: productId } : prev))
        await Promise.all([loadImages(productId!), loadVariants(productId!)])
      } else {
        setEditing(null)
      }
      load()
    } catch (e: any) {
      toast.error(e.message || t.adminRequired)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(p: ProductCatalogEntry) {
    if (!confirm(t.adminDeleteConfirm(p.name))) return
    const { error } = await supabase.from('products').delete().eq('id', p.id)
    // Deleting a product cascades to its variants, so the same live-order
    // guard applies. Its own message, though: nothing was removed and nothing
    // was saved here, unlike the save path.
    if (error?.hint === 'variant_in_live_order') { toast.error(t.adminProductInLiveOrder); return }
    if (error) { toast.error(error.message); return }
    toast.success(t.adminDeleted)
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        {/* A count over a failed read would read as "you have no products". */}
        {!loadError && <p className="text-sm text-muted-foreground">{t.adminPieces(visibleProducts.length)}</p>}
        {isAdmin && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 text-sm tracking-wider hover:bg-primary/90 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {t.adminAddProduct}
          </button>
        )}
      </div>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={t.adminSearchProducts}
            className="w-full bg-transparent border border-border ps-9 pe-3 py-2 text-sm focus:border-foreground outline-none"
          />
        </div>
        <select
          value={categoryFilter}
          onChange={e => setCategoryFilter(e.target.value)}
          className="bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
        >
          <option value="all">{t.adminAllCategories}</option>
          {CATEGORY_VALUES.map(c => (
            <option key={c} value={c}>{categoryLabel(c)}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className="py-24 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <LoadErrorPanel onRetry={load} />
      ) : visibleProducts.length === 0 ? (
        <div className="border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground">{t.adminNoProducts}</p>
        </div>
      ) : (
        <div className="border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs tracking-widest uppercase text-muted-foreground">
                <tr>
                  <th className="text-start px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleSort('name')}
                      className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground"
                    >
                      {t.adminProduct}
                      {sortKey === 'name' && (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
                    </button>
                  </th>
                  <th className="text-start px-4 py-3">{t.adminCategory}</th>
                  <th className="text-start px-4 py-3">{t.adminBrandField}</th>
                  <th className="text-start px-4 py-3">
                    <button
                      type="button"
                      onClick={() => toggleSort('price')}
                      className="inline-flex items-center gap-1 cursor-pointer hover:text-foreground"
                    >
                      {t.adminPrice}
                      {sortKey === 'price' && (sortDir === 'asc' ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />)}
                    </button>
                  </th>
                  <th className="text-start px-4 py-3">{t.adminStock}</th>
                  <th className="text-start px-4 py-3">{t.adminFeatured}</th>
                  <th className="text-end px-4 py-3">{t.adminActions}</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map(p => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-muted overflow-hidden flex-shrink-0">
                          {p.image_url && <img src={p.image_url} alt="" className="w-full h-full object-cover" />}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">{p.name}</p>
                          <p className="text-xs text-muted-foreground truncate">{p.slug}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">{categoryLabel(p.category)}</td>
                    {/* Brands were invisible here, which is why 116 of 118
                        products silently have none. An unset brand reads as a
                        gap, not as a blank cell. */}
                    <td className="px-4 py-3 text-muted-foreground">
                      {p.brand ? brandLabel(p.brand) : <span className="opacity-50">{t.dash}</span>}
                    </td>
                    <td className="px-4 py-3">{formatPrice(Number(p.price))}</td>
                    <td className="px-4 py-3">
                      <span className={p.total_stock < 10 ? 'text-red-700' : ''}>{p.total_stock}</span>
                    </td>
                    <td className="px-4 py-3">{p.featured ? t.yes : t.dash}</td>
                    <td className="px-4 py-3 text-end">
                      <button
                        onClick={() => openEdit(p)}
                        className="p-1.5 hover:bg-muted cursor-pointer"
                        aria-label={t.adminEditProduct}
                      >
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button
                        onClick={() => handleDelete(p)}
                        className="p-1.5 hover:bg-muted text-red-700 cursor-pointer"
                        aria-label={t.adminDeleteProduct}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 bg-foreground/50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-background w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-border sticky top-0 bg-background z-10">
              <h2 className="font-display text-2xl">
                {editing.id ? t.adminEditProduct : t.adminNewProduct}
              </h2>
              <button onClick={() => setEditing(null)} className="p-2 cursor-pointer" aria-label={t.adminClose}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <Field label={t.adminName} value={editing.name || ''} onChange={v => setEditing({ ...editing, name: v })} />
              <Field label={t.adminSlug} value={editing.slug || ''} onChange={v => setEditing({ ...editing, slug: v })} />
              <div>
                <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminDescription}</label>
                <textarea
                  value={editing.description || ''}
                  onChange={e => setEditing({ ...editing, description: e.target.value })}
                  rows={3}
                  className="w-full bg-transparent border border-border p-3 text-sm focus:border-foreground outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={`${t.adminPrice} (${currency})`} type="number" value={String(editing.price || 0)} onChange={v => setEditing({ ...editing, price: Number(v) })} />
                <div>
                  <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminCategory}</label>
                  <select
                    value={editingCategory}
                    onChange={e => setEditing({ ...editing, category: e.target.value })}
                    className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
                  >
                    {/* Same reasoning as the brand select below: when the
                        LIST failed to load, "no longer in the list" would be a
                        guess, so show the stored value plainly instead. */}
                    {!CATEGORY_VALUES.includes(editingCategory) && (
                      <option value={editingCategory}>
                        {categoriesLoadError ? editingCategory : t.adminOptionNotInList(editingCategory)}
                      </option>
                    )}
                    {CATEGORY_VALUES.map(c => (
                      <option key={c} value={c}>{categoryLabel(c)}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminBrandField}</label>
                  <select
                    value={editingBrand}
                    onChange={e => setEditing({ ...editing, brand: e.target.value || null })}
                    className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
                  >
                    <option value="">{t.adminBrandNoneOption}</option>
                    {/* An unmatched value still has to be shown, or the
                        control would display "None" over a product that has a
                        brand. But when the brand LIST failed to load, "no
                        longer in the list" would be a guess: show the stored
                        value plainly instead. */}
                    {editingBrand && !brands.some(b => b.value === editingBrand) && (
                      <option value={editingBrand}>
                        {brandsLoadError ? editingBrand : t.adminOptionNotInList(editingBrand)}
                      </option>
                    )}
                    {brands.map(b => (
                      <option key={b.value} value={b.value}>{b.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={`${t.adminCostPrice} (${currency})`} type="number" value={costPrice != null ? String(costPrice) : ''} onChange={v => setCostPrice(v === '' ? null : Number(v))} />
                <Field label={t.adminMaterials} value={editing.materials || ''} onChange={v => setEditing({ ...editing, materials: v })} />
                <Field label={t.adminWeightGrams} type="number" value={editing.weight_grams != null ? String(editing.weight_grams) : ''} onChange={v => setEditing({ ...editing, weight_grams: v === '' ? null : Number(v) })} />
              </div>
              <Field label={t.adminTagsCsv} value={(editing.tags || []).join(', ')} onChange={v => setEditing({ ...editing, tags: v.split(',').map(s => s.trim()).filter(Boolean) })} />
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={editing.featured || false}
                  onChange={e => setEditing({ ...editing, featured: e.target.checked })}
                  className="w-4 h-4"
                />
                <span className="text-sm">{t.adminFeaturedCheckbox}</span>
              </label>

              {/* --- Photo gallery --- */}
              <div className="pt-2 border-t border-border">
                <div className="flex items-center justify-between mb-2 mt-4">
                  <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminPhotos}</span>
                  {editing.id ? (
                    <label className={`text-xs underline ${uploading ? 'opacity-50' : 'cursor-pointer'}`}>
                      {uploading ? t.adminUploading : t.adminUploadImages}
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        className="hidden"
                        disabled={uploading}
                        onChange={e => { handleUpload(e.target.files); e.target.value = '' }}
                      />
                    </label>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t.adminSaveFirstForPhotos}</span>
                  )}
                </div>
                {images.length > 0 && (
                  <div className="flex flex-wrap gap-3">
                    {images.map((img, idx) => (
                      <div
                        key={img.id}
                        draggable
                        onDragStart={() => setDragIndex(idx)}
                        onDragOver={e => e.preventDefault()}
                        onDrop={() => handleDropImage(idx)}
                        className="relative w-20 h-20 border border-border cursor-move group flex-shrink-0"
                        title={t.adminDragReorder}
                      >
                        <img src={img.url} alt="" className="w-full h-full object-cover" />
                        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between bg-foreground/70 px-1 py-0.5">
                          <button
                            type="button"
                            onClick={() => handleSetFeatured(img)}
                            className="cursor-pointer"
                            aria-label={t.adminSetFeatured}
                            title={t.adminSetFeatured}
                          >
                            <Star className={`w-3.5 h-3.5 ${img.is_featured ? 'fill-yellow-400 text-yellow-400' : 'text-background'}`} />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteImage(img)}
                            className="cursor-pointer"
                            aria-label={t.adminDeleteImage}
                            title={t.adminDeleteImage}
                          >
                            <Trash2 className="w-3.5 h-3.5 text-background" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* --- Variants --- */}
              <div className="pt-2 border-t border-border">
                <div className="flex items-center justify-between mb-2 mt-4">
                  <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminVariants}</span>
                  <button type="button" onClick={addVariantRow} className="text-xs underline cursor-pointer">{t.adminAddRow}</button>
                </div>
                <p className="text-xs text-muted-foreground mb-2">{t.adminVariantSizeHint}</p>
                <div className="overflow-x-auto">
                  <div className="min-w-[640px] space-y-2">
                    <div className="grid grid-cols-[1fr_1fr_4.5rem_1fr_1fr_6rem_1.5rem] gap-2 text-[10px] tracking-widest uppercase text-muted-foreground">
                      <span>{t.adminColSize}</span><span>{t.adminColColor}</span><span>{t.adminColStock}</span><span>{t.adminColSku}</span><span>{t.adminColBarcode}</span><span>{t.adminColPriceOverride}</span><span />
                    </div>
                    {variantRows.map(row => {
                      const rowError = variantErrors[row._key]
                      return (
                        <div key={row._key}>
                          <div className="grid grid-cols-[1fr_1fr_4.5rem_1fr_1fr_6rem_1.5rem] gap-2 items-center">
                            <input value={row.size} onChange={e => updateVariantRow(row._key, 'size', e.target.value)} aria-invalid={!!rowError} placeholder={t.adminVariantSizePlaceholder} className={`w-full bg-transparent border px-2 py-1.5 text-sm focus:border-foreground outline-none ${rowError ? 'border-red-700' : 'border-border'}`} />
                            <input value={row.color} onChange={e => updateVariantRow(row._key, 'color', e.target.value)} aria-invalid={!!rowError} className={`w-full bg-transparent border px-2 py-1.5 text-sm focus:border-foreground outline-none ${rowError ? 'border-red-700' : 'border-border'}`} />
                            <input type="number" value={row.stock} onChange={e => updateVariantRow(row._key, 'stock', Number(e.target.value) || 0)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                            <input value={row.sku} onChange={e => updateVariantRow(row._key, 'sku', e.target.value)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                            <input value={row.barcode} onChange={e => updateVariantRow(row._key, 'barcode', e.target.value)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                            <input type="number" value={row.price_override} onChange={e => updateVariantRow(row._key, 'price_override', e.target.value)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                            <button type="button" onClick={() => removeVariantRow(row._key)} className="p-1 text-red-700 cursor-pointer" aria-label={t.adminRemoveRow}>
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                          {rowError && <p className="text-xs text-red-700 mt-1">{rowError}</p>}
                        </div>
                      )
                    })}
                  </div>
                </div>
              </div>
            </div>
            <div className="p-6 border-t border-border flex items-center justify-end gap-3 sticky bottom-0 bg-background">
              <button
                onClick={() => setEditing(null)}
                className="px-5 py-2.5 text-sm border border-border hover:bg-muted cursor-pointer"
              >
                {t.adminCancel}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2.5 text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 cursor-pointer flex items-center gap-2"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {editing.id ? t.adminSave : t.adminCreate}
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
