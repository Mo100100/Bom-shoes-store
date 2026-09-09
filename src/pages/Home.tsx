import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase, ProductCatalogEntry } from '@/lib/supabase'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useCart } from '@/contexts/CartContext'
import {
  ArrowRight, Truck, ShieldCheck, RotateCcw, Lock,
  Package, Award, Heart, Star, CreditCard, Clock, Gift, Sparkles, Globe, LayoutGrid,
} from 'lucide-react'
import { toast } from 'sonner'
import ShoeShowcase3D from '@/components/ShoeShowcase3D'
import ProductCard from '@/components/ProductCard'
import CountdownTimer from '@/components/CountdownTimer'
import { useSeo } from '@/hooks/useSeo'
import { useBrands } from '@/contexts/BrandsContext'
import { useCategories } from '@/contexts/CategoriesContext'
import { firstInStockVariant } from '@/lib/sizes'

const TRUST_ICONS: Record<string, typeof Truck> = {
  Truck, ShieldCheck, RotateCcw, Lock, Package, Award, Heart, Star, CreditCard, Clock, Gift, Sparkles, Globe,
}

export default function Home() {
  const [featured, setFeatured] = useState<ProductCatalogEntry[]>([])
  const [recent, setRecent] = useState<ProductCatalogEntry[]>([])
  const [productsLoading, setProductsLoading] = useState(true)
  const [dropEndsAt, setDropEndsAt] = useState<Date | null>(null)
  // ponytail: fallback drop deadline when no auto-promo/manual target set.
  const [placeholderDrop] = useState(() => new Date(Date.now() + 3 * 24 * 60 * 60 * 1000))
  const [quickAddingId, setQuickAddingId] = useState<string | null>(null)
  const [content, setContent] = useState<Record<string, any>>({})
  const t = useT()
  const { lang } = useLanguage()
  const { addItem } = useCart()
  const { brands, brandLabel } = useBrands()
  const { categoryLabel } = useCategories()

  useSeo({ title: `${t.brandName} · ${t.brandTagline}`, description: t.homeHeroSubtitle })

  useEffect(() => {
    async function load() {
      const { data: f } = await supabase
        .from('product_catalog').select('*').eq('featured', true)
        .order('created_at', { ascending: false }).limit(10)
      const { data: r } = await supabase
        .from('product_catalog').select('*')
        .order('created_at', { ascending: false }).limit(10)
      if (f) setFeatured(f)
      if (r) setRecent(r)
      setProductsLoading(false)
    }
    load()
  }, [])

  useEffect(() => {
    supabase.from('site_content').select('key, value').then(({ data }) => {
      const map: Record<string, any> = {}
      for (const row of data || []) map[row.key] = row.value
      setContent(map)
    })
  }, [])

  // Auto countdown target: soonest-ending public auto-apply promo (only used
  // when the drop is in 'auto' mode; today it's 'manual').
  useEffect(() => {
    const mode = content.limited_drop?.countdown_mode ?? 'auto'
    if (mode !== 'auto') return
    supabase.from('coupons').select('ends_at')
      .eq('requires_code', false).eq('active', true).eq('discount_type', 'buy_x_get_y')
      .not('ends_at', 'is', null).order('ends_at', { ascending: true }).limit(1)
      .then(({ data }) => setDropEndsAt(data?.[0]?.ends_at ? new Date(data[0].ends_at) : null))
  }, [content.limited_drop])

  async function quickAdd(p: ProductCatalogEntry, e: React.MouseEvent) {
    e.preventDefault()
    e.stopPropagation()
    setQuickAddingId(p.id)
    const { data: variants, error } = await supabase.from('product_variants').select('*').eq('product_id', p.id).order('size').order('color')
    setQuickAddingId(null)
    // A failed stock check must not be reported as "out of stock" -- that's a
    // lie about inventory we never actually looked at.
    if (error) { toast.error(t.quickAddError); return }
    // Smallest in-stock size, not whatever row came back first, so the customer
    // gets a size they can predict and the toast tells them which one it is.
    const variant = firstInStockVariant(variants ?? [])
    if (!variant) { toast.error(t.productOutOfStock); return }
    if (!addItem(p, variant.size, variant.color, 1, variant)) { toast.error(t.productStockMaxed); return }
    toast.success(t.productAdded, { description: t.productAddedSize(p.name, variant.size) })
  }

  const pool = featured.length > 0 ? featured : recent
  const heroProduct = pool[0]
  const lookThumbs = pool.slice(0, 2)
  const curatedLimit = content.curated?.limit ?? 5
  const curated = pool.slice(0, curatedLimit)

  const heroC = content.hero
  const curatedC = content.curated
  const dropC = content.limited_drop
  const trustC = content.trust_badges
  const heroEnabled = heroC?.enabled !== false
  const showcaseEnabled = content.showcase?.enabled !== false
  const curatedEnabled = curatedC?.enabled !== false
  const dropEnabled = dropC?.enabled !== false
  const trustEnabled = trustC?.enabled !== false
  const brandBarEnabled = content.categories_strip?.enabled !== false

  const dropTarget = dropC?.countdown_mode === 'manual' && dropC?.manual_target
    ? new Date(dropC.manual_target)
    : (dropEndsAt || placeholderDrop)

  const pick = (en?: string, ar?: string) => (lang === 'ar' ? (ar ?? en) : (en ?? ar)) || ''

  const trustItems = trustC?.items?.length ? trustC.items : [
    { icon: 'Globe', title_en: t.homeTrust1Title, title_ar: t.homeTrust1Title, desc_en: t.homeTrust1Desc, desc_ar: t.homeTrust1Desc },
    { icon: 'ShieldCheck', title_en: t.homeTrust2Title, title_ar: t.homeTrust2Title, desc_en: t.homeTrust2Desc, desc_ar: t.homeTrust2Desc },
    { icon: 'RotateCcw', title_en: t.homeTrust3Title, title_ar: t.homeTrust3Title, desc_en: t.homeTrust3Desc, desc_ar: t.homeTrust3Desc },
    { icon: 'Lock', title_en: t.homeTrust4Title, title_ar: t.homeTrust4Title, desc_en: t.homeTrust4Desc, desc_ar: t.homeTrust4Desc },
  ]

  return (
    <div className="bg-cream">
      {/* ===== HERO ===== */}
      {heroEnabled && (
      <section className="relative bg-cream overflow-hidden px-6 lg:px-8 pt-16 lg:pt-20 pb-14">
        {/* Vertical scroll hint */}
        <div className="hidden lg:flex items-center gap-3.5 absolute start-6 top-1/2 -translate-y-1/2 -rotate-90 origin-left text-[10px] tracking-[0.3em] uppercase text-muted-foreground">
          <span className="relative w-1 h-1 rounded-full bg-muted-foreground before:content-[''] before:absolute before:-top-0.5 before:left-1/2 before:-translate-x-1/2 before:w-px before:h-7 before:bg-muted-foreground" />
          <span>{pick(heroC?.scroll_text_en, heroC?.scroll_text_ar) || t.homeHeroScroll}</span>
        </div>

        <div className="max-w-[1320px] mx-auto grid lg:grid-cols-[0.95fr_1.05fr] gap-10 items-center min-h-[calc(88vh-140px)]">
          {/* Copy */}
          <div className="py-5">
            <span className="inline-block text-xs tracking-[0.18em] uppercase font-medium text-muted-foreground mb-7 fade-up">
              {pick(heroC?.eyebrow_en, heroC?.eyebrow_ar) || t.homeEyebrow}
            </span>
            <h1 className="font-display font-extrabold text-[clamp(56px,9vw,132px)] leading-[0.92] tracking-[-0.02em] text-foreground mb-8 fade-up fade-up-2">
              <span className="block">{pick(heroC?.title1_en, heroC?.title1_ar) || t.homeHeroTitle1}</span>
              <span className="block ps-[0.2em]">{pick(heroC?.title2_en, heroC?.title2_ar) || t.homeHeroTitle2}</span>
            </h1>
            <p className="text-[17px] text-muted-foreground max-w-[460px] leading-relaxed mb-11 fade-up fade-up-3">
              {pick(heroC?.subtitle_en, heroC?.subtitle_ar) || t.homeHeroSubtitle}
            </p>
            <div className="flex flex-wrap items-center gap-7 fade-up fade-up-4">
              <Link
                to={heroC?.cta1_link ?? '/shop'}
                className="group inline-flex items-center gap-2.5 bg-foreground text-background rounded-lg px-9 py-[18px] text-[13px] font-semibold tracking-[0.08em] uppercase hover:bg-[#2a2a2a] transition-colors"
              >
                {pick(heroC?.cta1_text_en, heroC?.cta1_text_ar) || t.homeHeroCta1}
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform flip-rtl" />
              </Link>
              <Link
                to={heroC?.cta2_link ?? '/shop'}
                className="relative inline-flex items-center text-[13px] font-semibold tracking-[0.08em] uppercase pb-1 border-b border-foreground hover:opacity-70 transition-opacity"
              >
                {pick(heroC?.cta2_text_en, heroC?.cta2_text_ar) || t.homeHeroCta2}
              </Link>
            </div>
          </div>

          {/* Visual */}
          <div className="relative flex items-center justify-center">
            {productsLoading ? (
              <div className="w-full aspect-[4/3] max-h-[720px] rounded-lg bg-muted/60 animate-pulse" />
            ) : (
              <img
                src={heroC?.image_url || heroProduct?.image_url || ''}
                alt={t.brandName}
                className="w-full aspect-[4/3] max-h-[720px] object-cover rounded-lg"
              />
            )}
            {heroProduct && (
              <Link
                to={`/product/${heroProduct.slug}`}
                className="group absolute end-0 bottom-10 bg-[#f3f1ec] border border-[#ece8df] rounded-[14px] p-[18px] flex items-center gap-4 min-w-[280px] shadow-[0_8px_28px_rgba(20,20,20,0.10)] scale-in"
              >
                <div className="flex gap-2 shrink-0">
                  {lookThumbs.map((p, i) => (
                    <span key={`${p.id}-${i}`} className="w-12 h-12 rounded-full overflow-hidden bg-white border border-[#e1ddd3]">
                      <img src={p.image_url || ''} alt="" className="w-full h-full object-cover" />
                    </span>
                  ))}
                </div>
                <div>
                  <h3 className="font-sans text-sm font-bold tracking-[0.04em] uppercase leading-tight">{heroProduct.name}</h3>
                  <p className="text-xs text-muted-foreground uppercase tracking-[0.06em] mt-0.5 mb-2.5">
                    {/* products.brand holds brands.value, an immutable key
                        that is not the display name, so it goes through the
                        same lookup every other brand render uses. */}
                    {brandLabel(heroProduct.brand) || t.brandName}
                  </p>
                  <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold tracking-[0.1em] uppercase">
                    {t.homeShopTheLook}
                    <ArrowRight className="w-3 h-3 group-hover:translate-x-1 transition-transform flip-rtl" />
                  </span>
                </div>
              </Link>
            )}
          </div>
        </div>
      </section>
      )}

      {/* ===== BRAND BAR ===== */}
      {brandBarEnabled && brands.length > 0 && (
      <section className="bg-[#efece6] border-y border-border px-6 lg:px-8 py-8">
        <div className="max-w-[1320px] mx-auto flex flex-col md:flex-row items-center gap-6">
          <div className="flex-1 flex items-center justify-between flex-wrap gap-x-6 gap-y-4">
            {brands.map(b => (
              <Link
                key={b.value}
                to={`/shop?brand=${encodeURIComponent(b.value)}`}
                className="group inline-flex items-center"
                aria-label={b.name}
              >
                {b.logo_url ? (
                  <img src={b.logo_url} alt={b.name} className="h-6 w-auto object-contain opacity-80 group-hover:opacity-100 transition-opacity" />
                ) : (
                  <span className="font-display text-[22px] md:text-[26px] font-semibold tracking-[0.04em] leading-none text-foreground/85 group-hover:text-foreground transition-colors">
                    {b.name}
                  </span>
                )}
              </Link>
            ))}
          </div>
          <Link
            to="/brands"
            className="inline-flex items-center gap-3.5 bg-foreground text-background rounded-full px-5 py-3.5 text-xs tracking-[0.12em] uppercase font-semibold hover:bg-[#2a2a2a] transition-colors shrink-0"
          >
            <LayoutGrid className="w-4 h-4" />
            {t.shopViewAll}
          </Link>
        </div>
      </section>
      )}

      {/* ===== 3D SCROLL SHOWCASE (kept -- signature feature) ===== */}
      {showcaseEnabled && <ShoeShowcase3D />}

      {/* ===== CURATED FOR YOU ===== */}
      {curatedEnabled && (
      <section className="bg-background px-6 lg:px-8 py-20 lg:py-24">
        <div className="max-w-[1320px] mx-auto">
          <div className="flex items-end justify-between gap-6 mb-12">
            <div>
              <span className="block text-xs tracking-[0.18em] uppercase font-medium text-terracotta mb-2">
                {pick(curatedC?.eyebrow_en, curatedC?.eyebrow_ar) || t.homeFeaturedEyebrow}
              </span>
              <h2 className="font-display font-bold text-[clamp(40px,5vw,60px)] leading-none tracking-[-0.015em]">
                {pick(curatedC?.heading_en, curatedC?.heading_ar) || t.homeFeaturedTitle}
              </h2>
            </div>
            <Link
              to="/shop"
              className="hidden md:inline-flex items-center gap-2 text-[13px] font-semibold tracking-[0.1em] uppercase pb-2 border-b border-foreground hover:gap-3 transition-all"
            >
              {pick(curatedC?.view_all_en, curatedC?.view_all_ar) || t.homeFeaturedViewAll}
              <ArrowRight className="w-4 h-4 flip-rtl" />
            </Link>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 lg:gap-6">
            {productsLoading
              ? [1, 2, 3, 4, 5].map(i => (
                  <div key={i} className="border border-border rounded-[14px] p-[18px] animate-pulse">
                    <div className="aspect-square bg-muted/60 rounded-[10px] mb-[18px]" />
                    <div className="h-3 w-1/2 bg-muted/60 mb-2" />
                    <div className="h-3 w-2/3 bg-muted/60" />
                  </div>
                ))
              : curated.map((p, i) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    categoryLabel={categoryLabel(p.category)}
                    onQuickAdd={quickAdd}
                    quickAdding={quickAddingId === p.id}
                    animationDelay={`${(i % 5) * 60}ms`}
                  />
                ))}
          </div>
        </div>
      </section>
      )}

      {/* ===== LIMITED DROP ===== */}
      {dropEnabled && (
      <section className="bg-[#0a0a0a] text-white">
        <div className="max-w-[1320px] mx-auto grid lg:grid-cols-[0.8fr_1.2fr] items-stretch min-h-[520px]">
          <div className="relative overflow-hidden aspect-[16/9] lg:aspect-auto">
            <img
              src={dropC?.image_url ?? '/brands/limited-drop.jpg'}
              alt=""
              loading="lazy"
              className="absolute inset-0 w-full h-full object-cover"
            />
          </div>
          <div className="grid lg:grid-cols-[1fr_auto] items-center gap-10 lg:gap-12 px-8 lg:px-14 py-14">
            <div>
              <span className="block text-xs tracking-[0.18em] uppercase text-[#9a9a9a] mb-4">
                {pick(dropC?.eyebrow_en, dropC?.eyebrow_ar) || t.homeDropEyebrow}
              </span>
              <h2 className="font-display font-bold text-[clamp(34px,4vw,56px)] leading-[1.05] tracking-[-0.01em] uppercase mb-6">
                <span className="block">{pick(dropC?.title1_en, dropC?.title1_ar) || t.homeDropTitle1}</span>
                <span className="block">{pick(dropC?.title2_en, dropC?.title2_ar) || t.homeDropTitle2}</span>
              </h2>
              <p className="text-[#b8b8b8] leading-relaxed max-w-sm mb-8">
                {pick(dropC?.subtitle_en, dropC?.subtitle_ar) || t.homeDropSubtitle}
              </p>
              <Link
                to={dropC?.cta_link ?? '/shop'}
                className="group inline-flex items-center gap-2.5 border border-white/50 text-white rounded-lg px-8 py-4 text-[13px] font-semibold tracking-[0.08em] uppercase hover:bg-white hover:text-foreground transition-colors"
              >
                {pick(dropC?.cta_text_en, dropC?.cta_text_ar) || t.homeDropCta}
                <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform flip-rtl" />
              </Link>
            </div>
            {dropC?.countdown_mode !== 'off' && (
              <CountdownTimer
                target={dropTarget}
                labels={{ days: t.homeDropDays, hours: t.homeDropHrs, minutes: t.homeDropMins, seconds: t.homeDropSecs }}
                className="shrink-0"
              />
            )}
          </div>
        </div>
      </section>
      )}

      {/* ===== FEATURES BAR ===== */}
      {trustEnabled && (
      <section className="bg-background">
        <div className="max-w-[1320px] mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 px-6 lg:px-8 py-9">
          {trustItems.map((item: any, i: number) => {
            const Icon = TRUST_ICONS[item.icon] ?? Truck
            return (
              <div
                key={i}
                className={`flex items-center gap-4 px-4 lg:px-7 py-2 ${i > 0 ? 'lg:border-s border-border' : ''}`}
              >
                <Icon className="w-6 h-6 shrink-0 text-foreground" strokeWidth={1.6} />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[13px] font-bold tracking-[0.08em] uppercase text-foreground">
                    {pick(item.title_en, item.title_ar)}
                  </span>
                  <span className="text-xs text-muted-foreground">{pick(item.desc_en, item.desc_ar)}</span>
                </div>
              </div>
            )
          })}
        </div>
      </section>
      )}
    </div>
  )
}
