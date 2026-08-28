import { useEffect, useState, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { supabase, ProductCatalogEntry, Coupon } from '@/lib/supabase'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useCart } from '@/contexts/CartContext'
import { Loader2 } from 'lucide-react'
import QuickViewModal from '@/components/QuickViewModal'
import ProductCard from '@/components/ProductCard'
import { useSeo } from '@/hooks/useSeo'
import { useCategories } from '@/contexts/CategoriesContext'
import { compareSizes, firstInStockVariant } from '@/lib/sizes'

const SORT_VALUES = ['featured', 'price-asc', 'price-desc', 'newest']

export default function Shop() {
  const [params, setParams] = useSearchParams()
  const initialCategory = params.get('category') || 'All'
  const search = params.get('search') || ''
  const brand = params.get('brand') || ''
  const saleOnly = params.get('sale') === '1'
  const [category, setCategory] = useState(initialCategory)
  const [sort, setSort] = useState('featured')
  const [products, setProducts] = useState<ProductCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [selectedColors, setSelectedColors] = useState<string[]>([])
  const [selectedSizes, setSelectedSizes] = useState<string[]>([])
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [quickViewId, setQuickViewId] = useState<string | null>(null)
  const [quickAddingId, setQuickAddingId] = useState<string | null>(null)
  const [bxgyPromos, setBxgyPromos] = useState<Coupon[]>([])
  const t = useT()
  const { lang } = useLanguage()
  const { addItem } = useCart()
  const { categories, categoryLabel: dbCategoryLabel } = useCategories()
  const CATEGORY_VALUES = ['All', ...categories.map(c => c.value)]
  function categoryLabel(c: string): string {
    return c === 'All' ? t.shopAll : dbCategoryLabel(c)
  }

  function sortLabel(s: string): string {
    switch (s) {
      case 'featured': return t.shopSortFeatured
      case 'price-asc': return t.shopSortPriceAsc
      case 'price-desc': return t.shopSortPriceDesc
      case 'newest': return t.shopSortNewest
      default: return s
    }
  }

  // Reflects the active search/category so the tab title and shared links
  // aren't all just "Shop all" -- reuses the same labels already rendered
  // in the header above.
  useSeo({
    title: search
      ? `${t.shopSearchingFor(search)} · ${t.brandName}`
      : category !== 'All'
      ? `${categoryLabel(category)} · ${t.shopTitle} · ${t.brandName}`
      : `${t.shopTitle} · ${t.brandName}`,
    description: t.shopSubtitle,
  })

  useEffect(() => {
    async function load() {
      setLoading(true)
      // Category / brand / search / sale are independent server-side filters --
      // ANDed together by chaining on the same query.
      let query = supabase.from('product_catalog').select('*')
      if (category !== 'All') query = query.eq('category', category)
      if (brand) query = query.eq('brand', brand)
      if (saleOnly) query = query.not('sale_price', 'is', null)
      if (search) query = query.textSearch('search_vector', search, { type: 'websearch' })
      const { data } = await query
      setProducts(data || [])
      setLoading(false)
    }
    load()
  }, [category, search, brand, saleOnly])

  // Active, auto-apply (no code needed) buy-x-get-y promotions -- the only
  // coupon rows the storefront can read at all (see the public RLS policy
  // added alongside this feature; every other coupon row, including any real
  // code, stays admin-only). One query for the whole page, not per-card.
  useEffect(() => {
    supabase
      .from('coupons')
      .select('*')
      .eq('requires_code', false)
      .eq('active', true)
      .eq('discount_type', 'buy_x_get_y')
      .then(({ data }) => setBxgyPromos(data || []))
  }, [])

  // Informational badge only -- date range and exact target match are
  // checked here for display, but the authoritative eligibility (and the
  // actual discount) is always computed server-side at checkout, so an edge
  // case this misses just means a missing badge, never a wrong charge.
  function bxgyBadgeFor(p: ProductCatalogEntry): Coupon | undefined {
    const now = Date.now()
    return bxgyPromos.find(c => {
      if (!c.buy_quantity || !c.get_quantity || c.get_discount_percent == null) return false
      if (c.starts_at && now < new Date(c.starts_at).getTime()) return false
      if (c.ends_at && now > new Date(c.ends_at).getTime()) return false
      if (c.target_type === 'category') return c.target_category === p.category
      if (c.target_type === 'products') return c.target_product_ids.includes(p.id)
      return true // 'all'
    })
  }

  const sorted = useMemo(() => {
    const copy = [...products]
    switch (sort) {
      case 'price-asc': return copy.sort((a, b) => a.min_price - b.min_price)
      case 'price-desc': return copy.sort((a, b) => b.min_price - a.min_price)
      case 'newest': return copy.sort((a, b) => b.created_at.localeCompare(a.created_at))
      default: return copy.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0))
    }
  }, [products, sort])

  // Color/size chips derive from what's already loaded -- no extra query.
  const availableColors = useMemo(() => Array.from(new Set(products.flatMap(p => p.available_colors))), [products])
  // Sorted so the chips read 9, 10, 40 rather than 10, 40, 9.
  const availableSizes = useMemo(() => Array.from(new Set(products.flatMap(p => p.available_sizes))).sort(compareSizes), [products])

  // Client-side on top of the server-filtered set: color/size/price. Empty
  // selection = no filter, and all four filter dimensions compose (AND).
  const filtered = useMemo(() => sorted.filter(p => {
    if (selectedColors.length && !p.available_colors.some(c => selectedColors.includes(c))) return false
    if (selectedSizes.length && !p.available_sizes.some(s => selectedSizes.includes(s))) return false
    if (minPrice && p.min_price < Number(minPrice)) return false
    if (maxPrice && p.min_price > Number(maxPrice)) return false
    return true
  }), [sorted, selectedColors, selectedSizes, minPrice, maxPrice])

  function selectCategory(c: string) {
    setCategory(c)
    if (c === 'All') {
      params.delete('category')
    } else {
      params.set('category', c)
    }
    setParams(params, { replace: true })
  }

  function clearSearch() {
    params.delete('search')
    setParams(params, { replace: true })
  }

  function toggleColor(c: string) {
    setSelectedColors(current => current.includes(c) ? current.filter(x => x !== c) : [...current, c])
  }

  function toggleSize(s: string) {
    setSelectedSizes(current => current.includes(s) ? current.filter(x => x !== s) : [...current, s])
  }

  async function quickAdd(p: ProductCatalogEntry, e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setQuickAddingId(p.id)
    const { data: variants } = await supabase.from('product_variants').select('*').eq('product_id', p.id).order('size').order('color')
    // Smallest in-stock size, not whatever row came back first, so the customer
    // gets a size they can predict and the toast tells them which one it is.
    const variant = firstInStockVariant(variants ?? [])
    setQuickAddingId(null)
    if (!variant) {
      toast.error(t.productOutOfStock)
      return
    }
    if (!addItem(p, variant.size, variant.color, 1, variant)) {
      toast.error(t.productStockMaxed)
      return
    }
    toast.success(t.productAdded, { description: t.productAddedSize(p.name, variant.size) })
  }

  return (
    <div className="px-6 lg:px-10 py-12 lg:py-16 bg-cream min-h-screen">
      <div className="max-w-[1400px] mx-auto">
        {/* Header */}
        <div className="text-center mb-16">
          <p className="text-zen text-muted-foreground mb-4">{brand ? t.navBrands : saleOnly ? t.navSale : t.shopEyebrow}</p>
          <h1 className="font-display text-5xl md:text-7xl mb-6">{brand || (saleOnly ? t.navSale : t.shopTitle)}</h1>
          {search ? (
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <p className="text-muted-foreground font-light">{t.shopSearchingFor(search)}</p>
              <button
                onClick={clearSearch}
                className="text-xs tracking-widest uppercase border-b border-foreground pb-0.5 cursor-pointer"
              >
                {t.shopClearSearch}
              </button>
            </div>
          ) : (brand || saleOnly) ? (
            <div className="flex items-center justify-center gap-3 flex-wrap">
              <p className="text-muted-foreground font-light">{products.length} {products.length === 1 ? t.piece : t.pieces}</p>
              <button
                onClick={() => { params.delete('brand'); params.delete('sale'); setParams(params, { replace: true }) }}
                className="text-xs tracking-widest uppercase border-b border-foreground pb-0.5 cursor-pointer"
              >
                {t.shopClearSearch}
              </button>
            </div>
          ) : (
            <p className="text-muted-foreground font-light max-w-md mx-auto">
              {t.shopSubtitle}
            </p>
          )}
        </div>

        {/* Filter bar */}
        <div className="flex flex-col gap-6 bg-background/60 border border-border px-6 py-5 mb-12">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-6">
            <div className="flex items-center gap-1 overflow-x-auto scrollbar-none -mx-1 px-1">
              {CATEGORY_VALUES.map(c => (
                <button
                  key={c}
                  onClick={() => selectCategory(c)}
                  className={`px-4 py-1.5 text-sm whitespace-nowrap transition-colors cursor-pointer ${
                    category === c
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {categoryLabel(c)}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <span className="text-xs text-muted-foreground tracking-wider uppercase">{t.shopSort}</span>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value)}
                dir={lang === 'ar' ? 'rtl' : 'ltr'}
                className="bg-transparent text-sm border-b border-foreground/30 py-1 focus:outline-none focus:border-foreground cursor-pointer"
              >
                {SORT_VALUES.map(s => (
                  <option key={s} value={s}>{sortLabel(s)}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Color / size / price -- derived client-side from the loaded rows, filtered client-side too */}
          {(availableColors.length > 0 || availableSizes.length > 0) && (
            <div className="flex flex-wrap items-center gap-6 pt-1">
              {availableColors.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground tracking-wider uppercase">{t.productColor}</span>
                  {availableColors.map(c => (
                    <button
                      key={c}
                      onClick={() => toggleColor(c)}
                      className={`px-3 py-1 text-xs border transition-colors cursor-pointer ${
                        selectedColors.includes(c)
                          ? 'border-foreground bg-foreground text-background'
                          : 'border-border hover:border-foreground/50'
                      }`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
              )}
              {availableSizes.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground tracking-wider uppercase">{t.productSize}</span>
                  {availableSizes.map(s => (
                    <button
                      key={s}
                      onClick={() => toggleSize(s)}
                      className={`px-3 py-1 text-xs border transition-colors cursor-pointer ${
                        selectedSizes.includes(s)
                          ? 'border-foreground bg-foreground text-background'
                          : 'border-border hover:border-foreground/50'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground tracking-wider uppercase">{t.shopFilterPrice}</span>
                <input
                  type="number"
                  min={0}
                  value={minPrice}
                  onChange={(e) => setMinPrice(e.target.value)}
                  placeholder={t.shopPriceMin}
                  className="w-16 bg-transparent text-xs border-b border-foreground/30 focus:outline-none focus:border-foreground py-1"
                />
                <span className="text-muted-foreground">–</span>
                <input
                  type="number"
                  min={0}
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder={t.shopPriceMax}
                  className="w-16 bg-transparent text-xs border-b border-foreground/30 focus:outline-none focus:border-foreground py-1"
                />
              </div>
            </div>
          )}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="py-24 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-24 text-center">
            <p className="text-muted-foreground">{t.shopNoMatch}</p>
            <button
              onClick={() => selectCategory('All')}
              className="mt-4 text-sm border-b border-foreground pb-0.5"
            >
              {t.shopViewAll}
            </button>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted-foreground tracking-wider mb-6">
              {t.shopPieces(filtered.length)}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-14">
              {filtered.map((p, i) => {
                const bxgyPromo = bxgyBadgeFor(p)
                const bxgyBadge = bxgyPromo
                  ? t.shopBxgyBadge(bxgyPromo.buy_quantity!, bxgyPromo.get_quantity!, bxgyPromo.get_discount_percent!)
                  : undefined
                return (
                  <ProductCard
                    key={p.id}
                    product={p}
                    categoryLabel={categoryLabel(p.category)}
                    bxgyBadge={bxgyBadge}
                    onQuickView={setQuickViewId}
                    onQuickAdd={quickAdd}
                    quickAdding={quickAddingId === p.id}
                    animationDelay={`${(i % 8) * 60}ms`}
                  />
                )
              })}
            </div>
          </>
        )}
      </div>

      <QuickViewModal productId={quickViewId} onClose={() => setQuickViewId(null)} />
    </div>
  )
}
