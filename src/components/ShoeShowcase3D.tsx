import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useCatalogPrice } from '@/hooks/useCatalogPrice'
import { supabase, ProductCatalogEntry } from '@/lib/supabase'

/**
 * Sticky 3D scroll showcase with transparent-background shoes.
 * As the user scrolls the page, the active shoe image transitions,
 * rotates and floats in 3D space.
 *
 * Data comes from the real product catalog (admin-curated via the
 * `site_content` row key='showcase', or a featured/recent fallback pool --
 * same pattern Home.tsx uses) -- never hardcoded fake products/prices.
 */
type ShowcaseItem = {
  src: string
  enTitle: string
  // Both ends of the variant price range, so the slide can say "from X" for a
  // product whose sizes differ in price rather than quoting only the cheapest.
  minPrice: number
  maxPrice: number
  slug: string
}

// Static tint since real products don't carry a "brand color" field --
// ponytail: one neutral tint for all slides, add per-product color if design wants it back.
const GLOW_COLOR = '#C9A98F'

export default function ShoeShowcase3D() {
  const t = useT()
  const { lang } = useLanguage()
  const catalogPrice = useCatalogPrice()
  const sectionRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const [scrollProgress, setScrollProgress] = useState(0)
  const [items, setItems] = useState<ShowcaseItem[] | null>(null)
  const [labels, setLabels] = useState<{ en: string; ar: string } | null>(null)

  // Fetch admin-curated showcase products (site_content key='showcase'), or
  // fall back to the featured/recent pool -- same fallback Home.tsx uses so
  // the homepage is never empty/broken on a fresh catalog.
  useEffect(() => {
    let cancelled = false
    async function load() {
      const { data: content } = await supabase
        .from('site_content')
        .select('value')
        .eq('key', 'showcase')
        .maybeSingle()

      const value = (content?.value || {}) as { product_ids?: string[]; label_en?: string; label_ar?: string }
      const productIds = value.product_ids ?? []

      let products: ProductCatalogEntry[] = []
      if (productIds.length > 0) {
        const { data } = await supabase.from('product_catalog').select('*').in('id', productIds)
        const byId = new Map((data || []).map(p => [p.id, p]))
        products = productIds.map(id => byId.get(id)).filter((p): p is ProductCatalogEntry => !!p)
      } else {
        const { data: featured } = await supabase
          .from('product_catalog')
          .select('*')
          .eq('featured', true)
          .order('created_at', { ascending: false })
          .limit(6)
        const { data: recent } = await supabase
          .from('product_catalog')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(6)
        products = (featured && featured.length > 0 ? featured : recent) || []
      }

      if (cancelled) return
      setItems(products.map(p => ({
        src: p.image_url || '',
        enTitle: p.name,
        minPrice: p.min_price,
        maxPrice: p.max_price,
        slug: p.slug,
      })))
      if (value.label_en || value.label_ar) {
        setLabels({ en: value.label_en || '', ar: value.label_ar || '' })
      }
    }
    load().catch(() => { if (!cancelled) setItems([]) })
    return () => { cancelled = true }
  }, [])

  // Section top offset + scrollable height, read from the DOM once (mount + resize)
  // instead of on every scroll tick — keeps the scroll handler free of layout reads.
  const metricsRef = useRef({ sectionTop: 0, sectionHeight: 1 })
  const tickingRef = useRef(false)
  const resizeTickingRef = useRef(false)
  const reducedMotionRef = useRef(false)

  const itemCount = items?.length ?? 0

  useEffect(() => {
    if (itemCount === 0) return

    reducedMotionRef.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    function measure() {
      const el = sectionRef.current
      if (!el) return
      const rect = el.getBoundingClientRect()
      metricsRef.current = {
        sectionTop: window.scrollY + rect.top,
        sectionHeight: el.offsetHeight - window.innerHeight,
      }
    }

    function applyScroll() {
      const { sectionTop, sectionHeight } = metricsRef.current
      const scrolled = window.scrollY - sectionTop
      const progress = Math.max(0, Math.min(1, scrolled / sectionHeight))
      setScrollProgress(progress)
      setActive(Math.min(itemCount - 1, Math.floor(progress * itemCount)))
    }

    // Batch to one update per animation frame no matter how many scroll events fire.
    function onScroll() {
      if (tickingRef.current) return
      tickingRef.current = true
      requestAnimationFrame(() => {
        applyScroll()
        tickingRef.current = false
      })
    }

    function onResize() {
      if (resizeTickingRef.current) return
      resizeTickingRef.current = true
      requestAnimationFrame(() => {
        measure()
        applyScroll()
        resizeTickingRef.current = false
      })
    }

    measure()
    applyScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('resize', onResize, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
    }
  }, [itemCount])

  // Loading (fetch in flight) or genuinely empty catalog -- render nothing
  // rather than fake placeholder products, same graceful-degradation as the
  // homepage's hero banners.
  if (!items || items.length === 0) return null

  const current = items[active]
  const eyebrow = labels ? (lang === 'ar' ? labels.ar : labels.en) : t.showcaseEyebrow
  const reducedMotion = reducedMotionRef.current
  // Continuous scroll position (0..N) used to drive the bottom-to-top slide
  const rawPos = scrollProgress * itemCount
  const floatY = reducedMotion ? 0 : Math.sin(scrollProgress * Math.PI * 3) * 24

  return (
    <section
      ref={sectionRef}
      className="relative bg-[#0A0907] text-white"
      style={{ height: `${itemCount * 100}vh` }}
    >
      <div className="sticky top-0 h-screen flex items-center justify-center overflow-hidden">
        {/* Subtle background gradient that shifts */}
        <div
          className="absolute inset-0 transition-all duration-1000"
          style={{
            background: `radial-gradient(circle at 50% 50%, ${GLOW_COLOR}33 0%, #0A0907 60%)`,
          }}
        />

        {/* Decorative index counter */}
        <div className="absolute top-10 left-10 right-10 flex items-center justify-between text-xs tracking-[0.3em] uppercase font-light opacity-80 text-shadow-sm">
          <span>0{active + 1} / 0{itemCount}</span>
          <span>{t.showcaseLabel}</span>
        </div>

        {/* Progress bar */}
        <div className="absolute top-0 left-0 right-0 h-px bg-white/10">
          <div
            className="h-full bg-white/70 transition-all duration-100"
            style={{ width: `${scrollProgress * 100}%` }}
          />
        </div>

        {/* Shoes slide in from the bottom and exit through the top */}
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          {items.map((s, i) => {
            // diff > 0 → this shoe has already scrolled past (move it upward / off the top)
            // diff < 0 → this shoe hasn't appeared yet (park it below)
            const diff = rawPos - i
            const isActive = Math.abs(diff) < 0.5
            // Distance from "centered": 1 unit of diff = 100vh of vertical travel
            const baseTranslateY = -diff * 100 // vh
            // Fade out as it leaves the centred band
            const opacity = isActive ? 1 : Math.max(0, 1 - (Math.abs(diff) - 0.5) * 1.4)
            const scale = isActive ? 1 : Math.max(0.75, 1 - Math.abs(diff) * 0.12)
            // Reduced motion: skip the translate/scale slide entirely and just
            // crossfade opacity in place (same 600ms ease timing, no parallax).
            const transform = reducedMotion
              ? 'none'
              : `translateY(calc(${baseTranslateY}vh + ${isActive ? floatY : 0}px)) scale(${scale})`
            const transition = reducedMotion
              ? 'opacity 600ms ease'
              : 'opacity 600ms ease, transform 600ms cubic-bezier(0.16, 1, 0.3, 1)'
            return (
              <img
                key={i}
                src={s.src}
                alt={s.enTitle}
                loading={i === 0 ? 'eager' : 'lazy'}
                decoding="async"
                width={1024}
                height={1024}
                fetchPriority={i === 0 ? 'high' : 'auto'}
                className="absolute w-[60vw] max-w-[680px] h-auto select-none"
                style={{
                  opacity: reducedMotion ? (isActive ? 1 : 0) : opacity,
                  transform,
                  transition,
                  filter: isActive ? 'drop-shadow(0 60px 80px rgba(0,0,0,0.55))' : 'drop-shadow(0 30px 40px rgba(0,0,0,0.35))',
                  willChange: 'transform, opacity',
                }}
                draggable={false}
              />
            )
          })}
        </div>

        {/* Product info card - right side (or left in RTL) */}
        <div className="relative z-10 w-full max-w-[1400px] mx-auto px-6 lg:px-10 grid lg:grid-cols-2 gap-10 items-center pointer-events-none">
          <div className="hidden lg:block" />
          <div className="text-start lg:text-end max-w-md lg:ms-auto lg:rtl:ms-0 lg:rtl:me-auto">
            <p
              key={`eb-${active}`}
              className="text-xs tracking-[0.3em] uppercase font-light opacity-80 mb-3 text-shadow-sm"
              style={{ animation: 'fadeUp 600ms 100ms ease-out both' }}
            >
              {eyebrow}
            </p>
            <h3
              key={`t-${active}`}
              className="font-display text-5xl md:text-6xl lg:text-7xl leading-[0.95] mb-4 text-shadow-lg"
              style={{ animation: 'fadeUp 600ms 200ms ease-out both' }}
            >
              {current.enTitle}
            </h3>
            <p
              key={`p-${active}`}
              className="text-2xl font-light opacity-95 mb-6 text-shadow"
              style={{ animation: 'fadeUp 600ms 300ms ease-out both' }}
            >
              {catalogPrice({ min_price: current.minPrice, max_price: current.maxPrice })}
            </p>
            <p
              key={`d-${active}`}
              className="text-sm font-light leading-relaxed opacity-80 mb-8 max-w-sm lg:ms-auto text-shadow"
              style={{ animation: 'fadeUp 600ms 400ms ease-out both' }}
            >
              {t.showcaseDesc}
            </p>
            <a
              href={`/product/${current.slug}`}
              className="group pointer-events-auto inline-flex items-center gap-2 text-sm tracking-wider border-b border-white/70 pb-1 hover:border-white transition-colors text-shadow-sm"
              style={{ animation: 'fadeUp 600ms 500ms ease-out both' }}
            >
              {t.showcaseCta}
              <span className="inline-block transition-transform duration-300 group-hover:translate-x-1">→</span>
            </a>
          </div>
        </div>

        {/* Side dots navigation */}
        <div className="absolute end-6 top-1/2 -translate-y-1/2 flex flex-col gap-3">
          {items.map((_, i) => (
            <button
              key={i}
              onClick={() => {
                const el = sectionRef.current
                if (!el) return
                const rect = el.getBoundingClientRect()
                const sectionTop = window.scrollY + rect.top
                const sectionHeight = el.offsetHeight - window.innerHeight
                const target = sectionTop + (i / itemCount) * sectionHeight + 50
                window.scrollTo({ top: target, behavior: 'smooth' })
              }}
              aria-label={`Go to slide ${i + 1}`}
              className="showcase-dot w-2 h-2 rounded-full cursor-pointer"
              style={{
                backgroundColor: i === active ? '#fff' : 'rgba(255,255,255,0.3)',
                '--dot-scale': i === active ? 1.5 : 1,
              } as CSSProperties}
            />
          ))}
        </div>

        {/* Scroll hint - only at the top */}
        {scrollProgress < 0.05 && (
          <div className="absolute bottom-10 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 opacity-60">
            <span className="text-[10px] tracking-[0.3em] uppercase">{t.showcaseScroll}</span>
            <span className="w-px h-10 bg-white/40 animate-pulse" />
          </div>
        )}
      </div>
    </section>
  )
}
