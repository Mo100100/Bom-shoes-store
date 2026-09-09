import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react'
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

  const reload = useCallback(async () => {
    const { data, error } = await supabase.from('brands').select('*').order('position')
    // Keep whatever was already showing on a failed reload rather than
    // blanking the brand bar the admin is looking at.
    if (error) setLoadError(true)
    else { setBrands(data || []); setLoadError(false) }
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
