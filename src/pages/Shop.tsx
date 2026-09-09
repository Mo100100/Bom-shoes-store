import { useEffect, useState, useMemo, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { toast } from 'sonner'
import { supabase, ProductCatalogEntry, Coupon } from '@/lib/supabase'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useCart } from '@/contexts/CartContext'
import { Loader2, SlidersHorizontal, X } from 'lucide-react'
import QuickViewModal from '@/components/QuickViewModal'
import ProductCard from '@/components/ProductCard'
import { useSeo } from '@/hooks/useSeo'
import { useCategories } from '@/contexts/CategoriesContext'
import { useBrands } from '@/contexts/BrandsContext'
import { compareSizes, firstInStockVariant } from '@/lib/sizes'

const SORT_VALUES = ['featured', 'price-asc', 'price-desc', 'newest']

export default function Shop() {
  const [params, setParams] = useSearchParams()
  // Every URL-backed filter is read LIVE, category included. It used to be
  // seeded into state once, so a category link followed while already on this
  // page changed the URL and nothing else, and browser back/forward across
  // category URLs moved the address bar past a grid that never re-filtered.
  const category = params.get('category') || 'All'
  const search = params.get('search') || ''
  const brand = params.get('brand') || ''
  const saleOnly = params.get('sale') === '1'
  const [sort, setSort] = useState('featured')
  // Collapsed on a phone: every colour and every size in the catalog, wrapping,
  // used to sit between the customer and the first product. Always open from md
  // up, where the row costs nothing.
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [products, setProducts] = useState<ProductCatalogEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
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
  const { brandLabel } = useBrands()
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

  // Guards against two overlapping loads (fast category/search switching, or
  // a retry click while the previous attempt is still in flight): only the
  // response matching the most recently started call is allowed to touch
  // state, so a slow failure can't land after a fast success and paint an
  // error banner over data that's already on screen (or vice versa).
  const loadIdRef = useRef(0)

  async function loadProducts() {
    const id = ++loadIdRef.current
    setLoading(true)
    setLoadError(false)
    try {
      // Category / brand / search / sale are independent server-side filters --
      // ANDed together by chaining on the same query.
      let query = supabase.from('product_catalog').select('*')
      if (category !== 'All') query = query.eq('category', category)
      if (brand) query = query.eq('brand', brand)
      // has_discount is the view's own "some in-stock variant is priced under
      // the base price" flag -- the exact column ProductCard's SALE badge
      // reads, so /sale and the badge can never mean different things.
      if (saleOnly) query = query.eq('has_discount', true)
      if (search) query = query.textSearch('search_vector', search, { type: 'websearch' })
      const { data, error } = await query
      if (error) throw error
      if (id !== loadIdRef.current) return
      setProducts(data || [])
    } catch {
      if (id !== loadIdRef.current) return
      setProducts([])
      setLoadError(true)
    } finally {
      if (id === loadIdRef.current) setLoading(false)
    }
  }

  useEffect(() => {
    loadProducts()
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // One writer for the URL-backed filters. Writes a COPY: the object
  // useSearchParams hands back is shared across renders, so mutating it in
  // place lets one control silently carry another's half-made edit.
  function writeParams(mutate: (next: URLSearchParams) => void, replace = false) {
    const next = new URLSearchParams(params)
    mutate(next)
    setParams(next, { replace })
  }

  // Pushed, not replaced, so back really does return to the previous category.
  function selectCategory(c: string) {
    writeParams(next => c === 'All' ? next.delete('category') : next.set('category', c))
  }

  function clearSearch() {
    writeParams(next => next.delete('search'), true)
  }

  // Everything the grid is filtered by, in one place: the four URL filters and
  // the four client-side ones. The empty state's button used to reset only the
  // category, which is almost never why the grid came back empty.
  function clearAllFilters() {
    setSelectedColors([])
    setSelectedSizes([])
    setMinPrice('')
    setMaxPrice('')
    writeParams(next => {
      next.delete('category')
      next.delete('brand')
      next.delete('sale')
      next.delete('search')
    })
  }

  // What is currently narrowing the grid, each with the one control that undoes
  // it. Rendered as chips so a collapsed filter panel on a phone can still say
  // what is active, and so the customer can drop one filter without dropping
  // all of them.
  const activeFilters: { key: string; label: string; clear: () => void }[] = [
    ...(category !== 'All' ? [{ key: 'category', label: categoryLabel(category), clear: () => selectCategory('All') }] : []),
    ...(brand ? [{ key: 'brand', label: brandLabel(brand) || brand, clear: () => writeParams(next => next.delete('brand')) }] : []),
    ...(saleOnly ? [{ key: 'sale', label: t.navSale, clear: () => writeParams(next => next.delete('sale')) }] : []),
    ...(search ? [{ key: 'search', label: `${t.searchLabel}: ${search}`, clear: clearSearch }] : []),
    ...selectedColors.map(c => ({ key: `color:${c}`, label: c, clear: () => toggleColor(c) })),
    ...selectedSizes.map(s => ({ key: `size:${s}`, label: `${t.productSize} ${s}`, clear: () => toggleSize(s) })),
    ...(minPrice ? [{ key: 'min', label: `${t.shopPriceMin}: ${minPrice}`, clear: () => setMinPrice('') }] : []),
    ...(maxPrice ? [{ key: 'max', label: `${t.shopPriceMax}: ${maxPrice}`, clear: () => setMaxPrice('') }] : []),
  ]

  function toggleColor(c: string) {
    setSelectedColors(current => current.includes(c) ? current.filter(x => x !== c) : [...current, c])
  }

  function toggleSize(s: string) {
    setSelectedSizes(current => current.includes(s) ? current.filter(x => x !== s) : [...current, s])
  }

  async function quickAdd(p: ProductCatalogEntry) {
    setQuickAddingId(p.id)
    const { data: variants, error } = await supabase.from('product_variants').select('*').eq('product_id', p.id).order('size').order('color')
    setQuickAddingId(null)
    // A failed stock check must not be reported as "out of stock" -- that's a
    // lie about inventory we never actually looked at.
    if (error) {
      toast.error(t.quickAddError)
      return
    }
    // Smallest in-stock size, not whatever row came back first, so the customer
    // gets a size they can predict and the toast tells them which one it is.
    const variant = firstInStockVariant(variants ?? [])
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
          {/* ?brand= carries brands.value, the immutable key products store,
              which is not the display name -- so the heading looks it up. */}
          <h1 className="font-display text-5xl md:text-7xl mb-6">{brandLabel(brand) || (saleOnly ? t.navSale : t.shopTitle)}</h1>
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
                onClick={() => writeParams(next => { next.delete('brand'); next.delete('sale') })}
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
        <div className="flex flex-col gap-4 bg-background/60 border border-border px-4 py-4 md:px-6 md:py-5 mb-8 md:mb-12">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4 md:gap-6">
            {/* No scrollbar-none here: on a narrow screen the scrollbar is the
                only sign that more categories exist past the edge. */}
            <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1">
              {CATEGORY_VALUES.map(c => (
                <button
                  key={c}
                  onClick={() => selectCategory(c)}
                  aria-pressed={category === c}
                  className={`min-h-[44px] md:min-h-0 px-4 py-1.5 text-sm whitespace-nowrap transition-colors cursor-pointer ${
                    category === c
                      ? 'bg-foreground text-background'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {categoryLabel(c)}
                </button>
              ))}
            </div>
            <div className="flex items-center justify-between gap-3">
              <button
                onClick={() => setFiltersOpen(open => !open)}
                aria-expanded={filtersOpen}
                aria-controls="shop-filters"
                className="md:hidden min-h-[44px] px-4 inline-flex items-center gap-2 border border-border text-sm cursor-pointer"
              >
                <SlidersHorizontal className="w-4 h-4" />
                {t.shopFilters}
                {activeFilters.length > 0 && (
                  <span className="bg-foreground text-background rounded-full w-5 h-5 text-[11px] flex items-center justify-center">
                    {activeFilters.length}
                  </span>
                )}
              </button>
              <div className="flex items-center gap-3">
                <span className="text-xs text-muted-foreground tracking-wider uppercase">{t.shopSort}</span>
                <select
                  value={sort}
                  onChange={(e) => setSort(e.target.value)}
                  dir={lang === 'ar' ? 'rtl' : 'ltr'}
                  className="bg-transparent text-base md:text-sm border-b border-foreground/30 py-1 focus:outline-none focus:border-foreground cursor-pointer"
                >
                  {SORT_VALUES.map(s => (
                    <option key={s} value={s}>{sortLabel(s)}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          {/* Color / size / price -- derived client-side from the loaded rows, filtered client-side too */}
          {(availableColors.length > 0 || availableSizes.length > 0) && (
            <div
              id="shop-filters"
              className={`flex-wrap items-center gap-4 md:gap-6 pt-1 md:flex ${filtersOpen ? 'flex' : 'hidden'}`}
            >
              {availableColors.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground tracking-wider uppercase">{t.productColor}</span>
                  {availableColors.map(c => (
                    <button
                      key={c}
                      onClick={() => toggleColor(c)}
                      aria-pressed={selectedColors.includes(c)}
                      className={`min-h-[44px] md:min-h-0 px-4 py-1 text-xs border transition-colors cursor-pointer ${
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
                      aria-pressed={selectedSizes.includes(s)}
                      className={`min-h-[44px] md:min-h-0 px-4 py-1 text-xs border transition-colors cursor-pointer ${
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
                  aria-label={`${t.shopFilterPrice}: ${t.shopPriceMin}`}
                  className="w-20 md:w-16 bg-transparent text-base md:text-xs border-b border-foreground/30 focus:outline-none focus:border-foreground py-1"
                />
                <span className="text-muted-foreground">-</span>
                <input
                  type="number"
                  min={0}
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder={t.shopPriceMax}
                  aria-label={`${t.shopFilterPrice}: ${t.shopPriceMax}`}
                  className="w-20 md:w-16 bg-transparent text-base md:text-xs border-b border-foreground/30 focus:outline-none focus:border-foreground py-1"
                />
              </div>
            </div>
          )}

          {/* Active filters -- outside the collapsible panel on purpose, so a
              phone with the panel shut still says what the grid is narrowed by
              and can undo any single one of them. */}
          {activeFilters.length > 0 && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
              <span className="text-xs text-muted-foreground tracking-wider uppercase me-1">{t.shopActiveFilters}</span>
              {activeFilters.map(f => (
                <button
                  key={f.key}
                  onClick={f.clear}
                  aria-label={t.shopRemoveFilter(f.label)}
                  className="min-h-[44px] md:min-h-0 px-3 py-1.5 inline-flex items-center gap-1.5 text-xs border border-foreground cursor-pointer hover:bg-foreground hover:text-background transition-colors"
                >
                  {f.label}
                  <X className="w-3 h-3" />
                </button>
              ))}
              <button
                onClick={clearAllFilters}
                className="min-h-[44px] md:min-h-0 px-1 text-xs tracking-wider uppercase text-muted-foreground hover:text-foreground underline underline-offset-4 cursor-pointer"
              >
                {t.shopClearAll}
              </button>
            </div>
          )}
        </div>

        {/* Grid */}
        {loading ? (
          <div className="py-24 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="py-24 text-center">
            <p className="text-terracotta">{t.shopLoadError}</p>
            <button
              onClick={() => loadProducts()}
              className="mt-4 text-sm border-b border-foreground pb-0.5 cursor-pointer"
            >
              {t.failedTryAgain}
            </button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="py-24 text-center">
            <p className="text-muted-foreground">{t.shopNoMatch}</p>
            {/* Clears the colour, size, price and brand filters too. Resetting
                only the category left the customer staring at the same empty
                grid, since the category is rarely what emptied it. */}
            <button
              onClick={activeFilters.length > 0 ? clearAllFilters : () => selectCategory('All')}
              className="mt-4 text-sm border-b border-foreground pb-0.5 cursor-pointer"
            >
              {activeFilters.length > 0 ? t.shopClearAll : t.shopViewAll}
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
