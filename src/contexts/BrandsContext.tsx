import { createContext, useContext, useEffect, useState, useRef, ReactNode, useCallback } from 'react'
import { supabase, Brand } from '@/lib/supabase'
import { brandLabel as labelFor } from '@/lib/brands'

type BrandsContextType = {
  brands: Brand[]
  loading: boolean
  loadError: boolean
  brandLabel: (value: string | null | undefined) => string
  reload: () => Promise<void>
}

const BrandsContext = createContext<BrandsContextType | undefined>(undefined)

// Same fetch-once shape as CategoriesContext, with the same label lookup:
// `brands.value` is an immutable primary key that products.brand stores, so
// `name` is the only thing safe to render (see src/lib/brands.ts).
//
// loadError exists because an empty array and a failed read are not the same
// thing: the /brands page must say "could not load" rather than draw an empty
// grid that reads as "the owner sells nothing".
export function BrandsProvider({ children }: { children: ReactNode }) {
  const [brands, setBrands] = useState<Brand[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // What is currently on screen, readable inside reload() without making
  // `brands` a dependency of it (that would rebuild reload on every fetch and
  // re-fire the mount effect below in a loop).
  const brandsRef = useRef<Brand[]>([])

  const reload = useCallback(async () => {
    // Back to true on a retry too: without this the retry button on /brands
    // looks inert, because nothing on screen changes until the request lands.
    setLoading(true)
    const { data, error } = await supabase.from('brands').select('*').order('position')
    if (error) {
      // A failed REFRESH keeps the good rows already showing: replacing a
      // working grid with an error message because a background reload blipped
      // is worse than data a few seconds stale. loadError is only for the case
      // where the failure leaves nothing to show at all.
      setLoadError(brandsRef.current.length === 0)
    } else {
      brandsRef.current = data || []
      setBrands(brandsRef.current)
      setLoadError(false)
    }
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  const brandLabel = useCallback(
    (value: string | null | undefined) => labelFor(brands, value),
    [brands]
  )

  return (
    <BrandsContext.Provider value={{ brands, loading, loadError, brandLabel, reload }}>
      {children}
    </BrandsContext.Provider>
  )
}

export function useBrands() {
  const ctx = useContext(BrandsContext)
  if (!ctx) throw new Error('useBrands must be used within BrandsProvider')
  return ctx
}
