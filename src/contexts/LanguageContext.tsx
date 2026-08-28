import { createContext, useContext, useEffect, useState, ReactNode } from 'react'
import { translations, Lang } from '@/lib/translations'

type LanguageContextType = {
  lang: Lang
  setLang: (l: Lang) => void
  toggleLang: () => void
  dir: 'ltr' | 'rtl'
}

const LanguageContext = createContext<LanguageContextType | undefined>(undefined)

const LANG_KEY = 'bom-store-lang'

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    try {
      const stored = localStorage.getItem(LANG_KEY)
      if (stored === 'ar' || stored === 'en') return stored
    } catch { /* localStorage is unavailable in private mode: fall through to the default */ }
    // Default to Arabic since the user requested Arabic support
    return 'ar'
  })

  const dir = lang === 'ar' ? 'rtl' : 'ltr'

  function setLang(l: Lang) {
    setLangState(l)
  }

  function toggleLang() {
    setLangState(prev => (prev === 'ar' ? 'en' : 'ar'))
  }

  useEffect(() => {
    try { localStorage.setItem(LANG_KEY, lang) } catch { /* localStorage is unavailable in private mode: the choice just isn't persisted */ }
    document.documentElement.lang = lang
    document.documentElement.dir = dir
    document.body.classList.toggle('font-arabic', lang === 'ar')
  }, [lang, dir])

  return (
    <LanguageContext.Provider value={{ lang, setLang, toggleLang, dir }}>
      {children}
    </LanguageContext.Provider>
  )
}

export function useLanguage() {
  const ctx = useContext(LanguageContext)
  if (!ctx) throw new Error('useLanguage must be used within LanguageProvider')
  return ctx
}

export function useT() {
  const { lang } = useLanguage()
  return translations[lang]
}
