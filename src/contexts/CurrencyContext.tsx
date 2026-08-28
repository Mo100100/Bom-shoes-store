import { createContext, useContext, ReactNode } from 'react'
import { useLanguage } from '@/contexts/LanguageContext'

// Kashier is an Egyptian gateway and every order is settled in EGP, no matter
// what a shopper sees (see supabase/functions/create-order). There is no FX
// rate source anywhere in this project, so a display currency that differs
// from the settlement currency would show one number and charge another.
// The store used to let an admin pick a display currency for cosmetics only
// (see supabase/migrations/20260704010000_store_currency.sql) -- that selector
// is removed; the display currency is now always the settlement currency.
export const SETTLEMENT_CURRENCY = 'EGP'

type CurrencyContextType = {
  currency: string
  formatPrice: (amount: number) => string
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined)

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const { lang } = useLanguage()

  // Intl.NumberFormat replaces the old hand-rolled symbol + Math.round
  // concatenation: it rounds to the currency's minor unit instead of
  // discarding it, adds thousands separators, and wraps the result in RLM/LRM
  // marks so it can't reorder inside an Arabic sentence.
  //
  // ar-EG's default numbering system renders Arabic-Indic digits (verified
  // with Intl.NumberFormat('ar-EG', ...) locally), but every other money
  // string in this app uses Western digits even in Arabic text (see
  // checkoutCodTooExpensive in translations.ts, which calls
  // `.toLocaleString('en-US')` on its own Arabic translation) while dates
  // elsewhere DO use Arabic-Indic digits. Money follows the Western-digit
  // convention here, so numberingSystem is pinned to 'latn' for Arabic too.
  function formatPrice(amount: number): string {
    return new Intl.NumberFormat(lang === 'ar' ? 'ar-EG' : 'en-US', {
      style: 'currency',
      currency: SETTLEMENT_CURRENCY,
      numberingSystem: 'latn',
    }).format(amount)
  }

  return (
    <CurrencyContext.Provider value={{ currency: SETTLEMENT_CURRENCY, formatPrice }}>
      {children}
    </CurrencyContext.Provider>
  )
}

export function useCurrency() {
  const ctx = useContext(CurrencyContext)
  if (!ctx) throw new Error('useCurrency must be used within CurrencyProvider')
  return ctx
}
