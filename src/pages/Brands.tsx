import { useEffect, useState } from 'react'
import { Link, Navigate } from 'react-router-dom'
import { useT } from '@/contexts/LanguageContext'
import { useBrands } from '@/contexts/BrandsContext'
import { useSeo } from '@/hooks/useSeo'
import { supabase } from '@/lib/supabase'
import { ArrowUpRight, Loader2 } from 'lucide-react'

export default function Brands() {
  const t = useT()
  // The brands the admin actually manages. This page used to render a
  // hardcoded array of seven names, which is why editing a brand in the admin
  // never changed anything here.
  const { brands, loading, loadError, reload } = useBrands()
  // The admin can hide this page entirely (site_content.site_visibility);
  // Layout already hides the nav link, but this page is also reachable by a
  // direct URL/bookmark, so it needs its own check.
  const [hidden, setHidden] = useState(false)
  const [checked, setChecked] = useState(false)

  useEffect(() => {
    supabase
      .from('site_content')
      .select('value')
      .eq('key', 'site_visibility')
      .maybeSingle()
      .then(({ data }) => {
        setHidden((data?.value as { brands_page_enabled?: boolean } | undefined)?.brands_page_enabled === false)
        setChecked(true)
      }, () => setChecked(true))
  }, [])

  useSeo({ title: `${t.navBrands} · ${t.brandName}`, description: t.brandsSubtitle })

  if (checked && hidden) return <Navigate to="/" replace />

  return (
    <div className="px-6 lg:px-10 py-16 lg:py-24 bg-cream min-h-screen">
      <div className="max-w-[1400px] mx-auto">
        <div className="text-center mb-16">
          <p className="text-zen text-muted-foreground mb-4">{t.brandsEyebrow}</p>
          <h1 className="font-display text-5xl md:text-7xl">{t.navBrands}</h1>
        </div>
        {loading ? (
          <div className="py-24 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          // Never an empty grid for a failed read: "we carry nothing" and
          // "the list did not load" must not look the same.
          <div className="py-24 text-center">
            <p className="text-terracotta">{t.brandsLoadError}</p>
            <button
              onClick={() => reload()}
              className="mt-4 text-sm border-b border-foreground pb-0.5 cursor-pointer"
            >
              {t.failedTryAgain}
            </button>
          </div>
        ) : brands.length === 0 ? (
          <div className="py-24 text-center">
            <p className="text-muted-foreground">{t.brandsEmpty}</p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {brands.map(b => (
              // The link carries `value` (what products.brand stores and
              // Shop.tsx filters on), the tile shows `name`.
              <Link
                key={b.value}
                to={`/shop?brand=${encodeURIComponent(b.value)}`}
                className="group flex items-center justify-between gap-3 border border-border bg-background px-6 py-8 hover:border-foreground hover:bg-foreground hover:text-background transition-colors"
              >
                {b.logo_url ? (
                  <img
                    src={b.logo_url}
                    alt={b.name}
                    loading="lazy"
                    className="h-8 md:h-10 w-auto max-w-[70%] object-contain"
                  />
                ) : (
                  <span className="font-display text-xl md:text-2xl">{b.name}</span>
                )}
                <ArrowUpRight className="w-5 h-5 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
