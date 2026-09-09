import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight } from 'lucide-react'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useCatalogPrice } from '@/hooks/useCatalogPrice'
import { supabase, ProductCatalogEntry } from '@/lib/supabase'

/**
 * Sticky scroll showcase with transparent-background shoes. As the user
 * scrolls the page, the active shoe image transitions, rotates and floats.
 *
 * Products come from the admin's own pick (`site_content.showcase.product_ids`)
 * and only from the `fallback` pool Home passes in when that pick is empty.
 * Home owns that pool so it can hand the showcase products the curated grid is
 * NOT already showing: both sections used to take the head of the same
 * featured-then-recent ordering, so with no admin pick they drew the same five
 * shoes twice.
 */
export type ShowcaseConfig = {
  product_ids?: string[]
  label_en?: string
  label_ar?: string
}

type ShowcaseProps = {
  /** `site_content.showcase`, already fetched by Home. */
  config?: ShowcaseConfig
  /** Products to show when the admin has picked none. */
  fallback: ProductCatalogEntry[]
}

// Scroll cost per slide, in vh, on top of the one sticky viewport the section
// pins for. At 100vh a five-shoe showcase was six full screens of scrolling
// before the first buyable product; the transition still reads at 45.
const SCROLL_VH_PER_ITEM = 45

// How far a slide travels vertically between one slide and the next. Has to
// stay large enough that the outgoing shoe is off the frame by the time the
// incoming one is centred, or two shoes sit on screen at full opacity.
const TRAVEL_VH = 80

// Static tint since real products don't carry a "brand color" field --
// ponytail: one neutral tint for all slides, add per-product color if design wants it back.
const GLOW_COLOR = '#C9A98F'

export default function ShoeShowcase3D({ config, fallback }: ShowcaseProps) {
  const t = useT()
  const { lang } = useLanguage()
  const catalogPrice = useCatalogPrice()
  const sectionRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(0)
  const [scrollProgress, setScrollProgress] = useState(0)
  const [picked, setPicked] = useState<ProductCatalogEntry[] | null>(null)

  const ids = config?.product_ids

  // Only the admin's explicit pick needs a query: the fallback pool is already
  // in memory, fetched once by Home for the curated grid.
  useEffect(() => {
    if (!ids || ids.length === 0) { setPicked(null); return }
    let cancelled = false
    supabase.from('product_catalog').select('*').in('id', ids).then(({ data }) => {
      if (cancelled) return
      const byId = new Map((data || []).map(p => [p.id, p]))
      // Admin order, not database order, and silently drops an id whose
      // product was since deleted or unpublished.
      setPicked(ids.map(id => byId.get(id)).filter((p): p is ProductCatalogEntry => !!p))
    })
    return () => { cancelled = true }
  }, [ids])

  const products = picked ?? fallback
  const items = useMemo(() => products.map(p => ({
    src: p.image_url || '',
    title: p.name,
    // Both ends of the variant price range, so the slide can say "from X" for
    // a product whose sizes differ in price rather than quoting the cheapest.
    minPrice: p.min_price,
    maxPrice: p.max_price,
    slug: p.slug,
  })), [products])

  // Section top offset + scrollable height, read from the DOM once (mount + resize)
  // instead of on every scroll tick: keeps the scroll handler free of layout reads.
  const metricsRef = useRef({ sectionTop: 0, sectionHeight: 1 })
  const tickingRef = useRef(false)
  const resizeTickingRef = useRef(false)
  const reducedMotionRef = useRef(false)

  const itemCount = items.length

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
  if (itemCount === 0) return null

  const current = items[active]
  const label = lang === 'ar'
    ? (config?.label_ar || config?.label_en)
    : (config?.label_en || config?.label_ar)
  const eyebrow = label || t.showcaseEyebrow
  const reducedMotion = reducedMotionRef.current
  // Continuous scroll position (0..N) used to drive the bottom-to-top slide
  const rawPos = scrollProgress * itemCount
  const floatY = reducedMotion ? 0 : Math.sin(scrollProgress * Math.PI * 3) * 24

  return (
    <section
      ref={sectionRef}
      className="relative bg-[#0A0907] text-white"
      style={{ height: `${100 + itemCount * SCROLL_VH_PER_ITEM}vh` }}
    >
      <div className="sticky top-0 h-screen flex items-end lg:items-center justify-center overflow-hidden">
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

        {/* Shoes slide in from the bottom and exit through the top. On a phone
            they sit in the TOP half so the copy below never lands on the photo;
            from lg the copy is beside them and both can be centred. */}
        <div className="absolute inset-x-0 top-[12%] bottom-[42%] lg:top-0 lg:bottom-0 flex items-center justify-center">
          {items.map((s, i) => {
            // diff > 0 → this shoe has already scrolled past (move it upward / off the top)
            // diff < 0 → this shoe hasn't appeared yet (park it below)
            const diff = rawPos - i
            const isActive = Math.abs(diff) < 0.5
            const baseTranslateY = -diff * TRAVEL_VH // vh
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
              // The shoe is the biggest thing on the screen, so it is the
              // link -- it used to be inert decoration. Only the slide the
              // shopper can actually see takes taps or keyboard focus.
              <Link
                key={i}
                to={`/product/${s.slug}`}
                aria-label={s.title}
                aria-hidden={!isActive}
                tabIndex={isActive ? 0 : -1}
                className="absolute w-[62vw] max-w-[260px] lg:w-[60vw] lg:max-w-[680px] rounded-2xl overflow-hidden"
                style={{
                  opacity: reducedMotion ? (isActive ? 1 : 0) : opacity,
                  transform,
                  transition,
                  pointerEvents: isActive ? 'auto' : 'none',
                  willChange: 'transform, opacity',
                }}
              >
                <img
                  src={s.src}
                  alt=""
                  loading={i === 0 ? 'eager' : 'lazy'}
                  decoding="async"
                  width={1024}
                  height={1024}
                  fetchPriority={i === 0 ? 'high' : 'auto'}
                  // A portrait catalog photo would otherwise run the full
                  // height of the phone and back under the copy.
                  className="w-full h-auto max-h-[42vh] lg:max-h-[68vh] object-contain select-none"
                  style={{
                    filter: isActive
                      ? 'drop-shadow(0 60px 80px rgba(0,0,0,0.55))'
                      : 'drop-shadow(0 30px 40px rgba(0,0,0,0.35))',
                  }}
                  draggable={false}
                />
              </Link>
            )
          })}
        </div>

        {/* Phone-only scrim: the copy sits over the lower part of the frame, so
            it needs a ground of its own or it reads on top of the photo. */}
        <div className="absolute inset-x-0 bottom-0 h-[58%] bg-gradient-to-t from-[#0A0907] via-[#0A0907]/90 to-transparent pointer-events-none lg:hidden" />

        {/* Product info card - right side (or left in RTL), bottom on a phone */}
        <div className="relative z-10 w-full max-w-[1400px] mx-auto px-6 lg:px-10 pb-14 lg:pb-0 grid lg:grid-cols-2 gap-10 items-center pointer-events-none">
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
              className="font-display text-4xl sm:text-5xl lg:text-7xl leading-[0.95] mb-4 text-shadow-lg"
              style={{ animation: 'fadeUp 600ms 200ms ease-out both' }}
            >
              <Link to={`/product/${current.slug}`} className="pointer-events-auto">
                {current.title}
              </Link>
            </h3>
            <p
              key={`p-${active}`}
              className="text-xl md:text-2xl font-light opacity-95 mb-5 text-shadow"
              style={{ animation: 'fadeUp 600ms 300ms ease-out both' }}
            >
              {catalogPrice({ min_price: current.minPrice, max_price: current.maxPrice })}
            </p>
            <p
              key={`d-${active}`}
              className="text-sm font-light leading-relaxed opacity-80 mb-5 max-w-sm lg:ms-auto text-shadow"
              style={{ animation: 'fadeUp 600ms 400ms ease-out both' }}
            >
              {t.showcaseDesc}
            </p>
            {/* Router Link, not a raw anchor: an <a href> here reloaded the
                whole SPA, throwing away the cart context and every cached
                query to open a page the router already had. */}
            <Link
              to={`/product/${current.slug}`}
              className="group pointer-events-auto inline-flex items-center gap-2 min-h-[44px] text-sm tracking-wider border-b border-white/70 hover:border-white transition-colors text-shadow-sm"
              style={{ animation: 'fadeUp 600ms 500ms ease-out both' }}
            >
              {t.showcaseCta}
              <ArrowRight className="w-4 h-4 group-hover:translate-x-1 transition-transform flip-rtl" />
            </Link>
          </div>
        </div>

        {/* Side dots navigation. The dot is 8px but its button is 44, which is
            the smallest thing a thumb can hit reliably. */}
        <div className="absolute end-2 top-1/2 -translate-y-1/2 flex flex-col">
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
              aria-label={t.showcaseSlideLabel(i + 1)}
              className="flex items-center justify-center w-11 h-11 cursor-pointer"
            >
              <span
                className="showcase-dot block w-2 h-2 rounded-full"
                style={{
                  backgroundColor: i === active ? '#fff' : 'rgba(255,255,255,0.3)',
                  '--dot-scale': i === active ? 1.5 : 1,
                } as CSSProperties}
              />
            </button>
          ))}
        </div>

        {/* Scroll hint - only at the top */}
        {scrollProgress < 0.05 && (
          <div className="absolute bottom-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 opacity-60">
            <span className="text-[10px] tracking-[0.3em] uppercase">{t.showcaseScroll}</span>
            <span className="w-px h-6 bg-white/40 animate-pulse" />
          </div>
        )}
      </div>
    </section>
  )
}
