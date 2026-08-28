import { useEffect, useMemo, useState } from 'react'
import { supabase, Product, ProductImage, ProductCatalogEntry } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useCategories } from '@/contexts/CategoriesContext'
import { useBrands } from '@/contexts/BrandsContext'
import { compressImage } from '@/lib/compressImage'
import { diffVariants, DesiredVariant } from '@/lib/variantDiff'
import { Loader2, Plus, X, Edit2, Trash2, Star, Search, ChevronUp, ChevronDown } from 'lucide-react'
import { toast } from 'sonner'

type SortKey = 'name' | 'price'
type SortDir = 'asc' | 'desc'

const EMPTY: Partial<Product> = {
  name: '', slug: '', description: '', price: 0, category: 'Sneakers',
  brand: null, featured: false, sale_price: null, materials: '', weight_grams: null, tags: [],
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
  const [editing, setEditing] = useState<Partial<Product> | null>(null)
  const [saving, setSaving] = useState(false)
  const [images, setImages] = useState<ProductImage[]>([])
  const [uploading, setUploading] = useState(false)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [variantRows, setVariantRows] = useState<VariantRow[]>([])
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
  const { categories, categoryLabel } = useCategories()
  const { brands } = useBrands()
  const CATEGORY_VALUES = categories.map(c => c.value)

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
    const { data } = await supabase.from('product_catalog').select('*').order('created_at', { ascending: false })
    setProducts(data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function loadImages(productId: string) {
    const { data } = await supabase.from('product_images').select('*').eq('product_id', productId).order('position')
    setImages(data || [])
  }

  async function loadVariants(productId: string) {
    const { data } = await supabase.from('product_variants').select('*').eq('product_id', productId).order('created_at')
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
  }

  async function loadCostPrice(productId: string) {
    const { data } = await supabase.from('product_costs').select('cost_price').eq('product_id', productId).maybeSingle()
    setCostPrice(data?.cost_price ?? null)
  }

  function openNew() {
    setEditing({ ...EMPTY })
    setImages([])
    setVariantRows([blankVariantRow()])
    setCostPrice(null)
    setDragIndex(null)
  }
  async function openEdit(p: ProductCatalogEntry) {
    setEditing({ ...p })
    setDragIndex(null)
    await Promise.all([loadImages(p.id), loadVariants(p.id), loadCostPrice(p.id)])
  }

  function updateVariantRow(key: string, field: keyof VariantRow, value: string | number) {
    setVariantRows(rows => rows.map(r => (r._key === key ? { ...r, [field]: value } : r)))
  }
  function addVariantRow() {
    setVariantRows(rows => [...rows, blankVariantRow()])
  }
  function removeVariantRow(key: string) {
    setVariantRows(rows => rows.filter(r => r._key !== key))
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
  // write per operation kind.
  async function saveVariants(productId: string) {
    const desired: DesiredVariant[] = variantRows
      .filter(r => r.size.trim() && r.color.trim()) // ponytail: skip incomplete rows, don't persist half-filled variants
      .map(row => ({
        id: row.id,
        size: row.size.trim(),
        color: row.color.trim(),
        sku: row.sku.trim() || null,
        barcode: row.barcode.trim() || null,
        stock: Number(row.stock) || 0,
        price_override: row.price_override.trim() === '' ? null : Number(row.price_override),
      }))

    // Read the current rows rather than trusting the grid's copy: only the DB
    // knows which ids are still there to be kept, updated or removed.
    const { data: existing, error: loadError } = await supabase
      .from('product_variants').select('id, size, color').eq('product_id', productId)
    if (loadError) throw loadError

    const { deletes, updates, inserts } = diffVariants(existing || [], desired)

    if (deletes.length) {
      const { error } = await supabase.from('product_variants').delete().in('id', deletes)
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
    await supabase.from('product_images').delete().eq('id', img.id)
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
        sale_price: editing.sale_price === null || editing.sale_price === undefined || (editing.sale_price as any) === '' ? null : Number(editing.sale_price),
        materials: editing.materials?.trim() ? editing.materials.trim() : null,
        weight_grams: editing.weight_grams === null || editing.weight_grams === undefined || (editing.weight_grams as any) === '' ? null : Number(editing.weight_grams),
        tags: editing.tags || [],
      }

      let productId = editing.id
      if (productId) {
        const { error } = await supabase.from('products').update(payload).eq('id', productId)
        if (error) throw error
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

      await saveVariants(productId!)
      await supabase.from('product_costs').upsert({ product_id: productId, cost_price: costPrice })

      // Keep legacy products.stock/sizes/colors in sync from the variants we
      // just wrote, so pages that still read those flat columns directly
      // (Shop, ProductDetail, Cart) don't go stale now that variants are the
      // real source of truth.
      const validRows = variantRows.filter(r => r.size.trim() && r.color.trim())
      await supabase.from('products').update({
        stock: validRows.reduce((sum, r) => sum + (Number(r.stock) || 0), 0),
        sizes: Array.from(new Set(validRows.map(r => r.size.trim()))),
        colors: Array.from(new Set(validRows.map(r => r.color.trim()))),
      }).eq('id', productId)

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
    if (error) { toast.error(error.message); return }
    toast.success(t.adminDeleted)
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <p className="text-sm text-muted-foreground">{t.adminPieces(visibleProducts.length)}</p>
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
                    value={editing.category || 'Sneakers'}
                    onChange={e => setEditing({ ...editing, category: e.target.value })}
                    className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
                  >
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
                    value={editing.brand ?? ''}
                    onChange={e => setEditing({ ...editing, brand: e.target.value || null })}
                    className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
                  >
                    <option value="">{t.adminBrandNoneOption}</option>
                    {brands.map(b => (
                      <option key={b.value} value={b.value}>{b.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={`${t.adminCostPrice} (${currency})`} type="number" value={costPrice != null ? String(costPrice) : ''} onChange={v => setCostPrice(v === '' ? null : Number(v))} />
                <Field label={`${t.adminSalePrice} (${currency})`} type="number" value={editing.sale_price != null ? String(editing.sale_price) : ''} onChange={v => setEditing({ ...editing, sale_price: v === '' ? null : Number(v) })} />
              </div>
              <div className="grid grid-cols-2 gap-4">
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
                <div className="overflow-x-auto">
                  <div className="min-w-[640px] space-y-2">
                    <div className="grid grid-cols-[1fr_1fr_4.5rem_1fr_1fr_6rem_1.5rem] gap-2 text-[10px] tracking-widest uppercase text-muted-foreground">
                      <span>{t.adminColSize}</span><span>{t.adminColColor}</span><span>{t.adminColStock}</span><span>{t.adminColSku}</span><span>{t.adminColBarcode}</span><span>{t.adminColPriceOverride}</span><span />
                    </div>
                    {variantRows.map(row => (
                      <div key={row._key} className="grid grid-cols-[1fr_1fr_4.5rem_1fr_1fr_6rem_1.5rem] gap-2 items-center">
                        <input value={row.size} onChange={e => updateVariantRow(row._key, 'size', e.target.value)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                        <input value={row.color} onChange={e => updateVariantRow(row._key, 'color', e.target.value)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                        <input type="number" value={row.stock} onChange={e => updateVariantRow(row._key, 'stock', Number(e.target.value) || 0)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                        <input value={row.sku} onChange={e => updateVariantRow(row._key, 'sku', e.target.value)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                        <input value={row.barcode} onChange={e => updateVariantRow(row._key, 'barcode', e.target.value)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                        <input type="number" value={row.price_override} onChange={e => updateVariantRow(row._key, 'price_override', e.target.value)} className="w-full bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none" />
                        <button type="button" onClick={() => removeVariantRow(row._key)} className="p-1 text-red-700 cursor-pointer" aria-label={t.adminRemoveRow}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ))}
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
