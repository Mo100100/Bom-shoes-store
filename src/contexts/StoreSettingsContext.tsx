import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react'
import { supabase } from '@/lib/supabase'

type StoreSettingsContextType = {
  logoUrl: string | null
  faviconUrl: string | null
  loading: boolean
  loadError: boolean
  reload: () => Promise<void>
}

const StoreSettingsContext = createContext<StoreSettingsContextType | undefined>(undefined)

// Singleton row id -- see supabase/migrations/20260704008000_store_settings_realtime.sql.
const STORE_SETTINGS_ID = '00000000-0000-0000-0000-000000000001'

// The <link rel="icon"> has to declare the type of the file it actually points
// at. index.html ships type="image/svg+xml" for the bundled /favicon.svg, and
// the uploaded favicon is deliberately NOT re-encoded (AdminSettings keeps it
// in its original format), so the type is read back off the URL.
const FAVICON_TYPES: Record<string, string> = {
  ico: 'image/x-icon',
  png: 'image/png',
  svg: 'image/svg+xml',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

function applyFavicon(url: string) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) return
  // Replace the whole <link> rather than patching .href: browsers hold on to
  // the icon they already fetched for a link element, and the type attribute
  // has to change with the href anyway. No cache-busting query is needed on
  // top of that -- every upload lands at favicon/<timestamp>-<name>, so a new
  // favicon is always a URL the browser has never seen.
  const next = document.createElement('link')
  next.rel = 'icon'
  const type = FAVICON_TYPES[url.split('?')[0].split('.').pop()?.toLowerCase() || '']
  if (type) next.type = type
  next.href = url
  link.replaceWith(next)
}

// The single reader of store_settings. Before this, Logo.tsx fetched the row
// once per mount (three times in Layout.tsx), App.tsx fetched it again for the
// favicon, and AdminSettings fetched it a fifth time -- five queries for one
// singleton row, none of which refetched after an upload, which is why the
// header kept showing the old logo. Same shape as BrandsContext: fetch once,
// expose reload() for the admin to call after it writes.
export function StoreSettingsProvider({ children }: { children: ReactNode }) {
  const [logoUrl, setLogoUrl] = useState<string | null>(null)
  const [faviconUrl, setFaviconUrl] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const reload = useCallback(async () => {
    const { data, error } = await supabase
      .from('store_settings')
      .select('logo_url, favicon_url')
      .eq('id', STORE_SETTINGS_ID)
      .maybeSingle()
    // A failed read keeps whatever was already showing: the storefront falls
    // back to the SVG monogram and index.html's static favicon, and the admin
    // gets loadError so it can say "could not read" instead of "None", which
    // reads as "my logo disappeared".
    setLoadError(!!error)
    if (!error) {
      setLogoUrl(data?.logo_url || null)
      setFaviconUrl(data?.favicon_url || null)
    }
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  useEffect(() => {
    // No favicon_url set: leave index.html's static /favicon.svg link alone.
    if (faviconUrl) applyFavicon(faviconUrl)
  }, [faviconUrl])

  return (
    <StoreSettingsContext.Provider value={{ logoUrl, faviconUrl, loading, loadError, reload }}>
      {children}
    </StoreSettingsContext.Provider>
  )
}

export function useStoreSettings() {
  const ctx = useContext(StoreSettingsContext)
  if (!ctx) throw new Error('useStoreSettings must be used within StoreSettingsProvider')
  return ctx
}
