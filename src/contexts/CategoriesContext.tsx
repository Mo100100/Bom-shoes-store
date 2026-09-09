import { createContext, useContext, useEffect, useState, useRef, ReactNode, useCallback } from 'react'
import { supabase, Category } from '@/lib/supabase'
import { useLanguage } from '@/contexts/LanguageContext'

type CategoriesContextType = {
  categories: Category[]
  loading: boolean
  loadError: boolean
  categoryLabel: (value: string) => string
  reload: () => Promise<void>
}

const CategoriesContext = createContext<CategoriesContextType | undefined>(undefined)

// Fetch once, and hold on to what was fetched. A failed read used to set the
// list to EMPTY, which is the same lie the admin screens tell when they draw an
// empty state over a broken read, except this one is app-wide: the settings
// list, the product editor's category select and the shop filters all go blank
// at once. Mirrors BrandsContext, which was fixed the same way.
export function CategoriesProvider({ children }: { children: ReactNode }) {
  const { lang } = useLanguage()
  const [categories, setCategories] = useState<Category[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  // What is currently on screen, readable inside reload() without making
  // `categories` a dependency of it.
  const categoriesRef = useRef<Category[]>([])

  const reload = useCallback(async () => {
    // Back to true on a retry too, so a caller's retry is visible.
    setLoading(true)
    const { data, error } = await supabase.from('categories').select('*').order('position')
    if (error) {
      // A failed REFRESH keeps the good rows already showing. loadError is
      // only for the case where the failure leaves nothing to show at all.
      setLoadError(categoriesRef.current.length === 0)
    } else {
      categoriesRef.current = data || []
      setCategories(categoriesRef.current)
      setLoadError(false)
    }
    setLoading(false)
  }, [])

  useEffect(() => { reload() }, [reload])

  function categoryLabel(value: string): string {
    const c = categories.find(c => c.value === value)
    if (!c) return value
    return lang === 'ar' ? c.label_ar : c.label_en
  }

  return (
    <CategoriesContext.Provider value={{ categories, loading, loadError, categoryLabel, reload }}>
      {children}
    </CategoriesContext.Provider>
  )
}

export function useCategories() {
  const ctx = useContext(CategoriesContext)
  if (!ctx) throw new Error('useCategories must be used within CategoriesProvider')
  return ctx
}
