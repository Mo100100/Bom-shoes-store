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
  currency: typeof SETTLEMENT_CURRENCY
  formatPrice: (amount: number) => string
}

const CurrencyContext = createContext<CurrencyContextType | undefined>(undefined)

// Module-scope, one formatter per language, not one per formatPrice() call.
// Constructing an Intl.NumberFormat is far more expensive than calling
// .format() on an existing one, and formatPrice is called from every price on
// the page (57 call sites) -- building a fresh formatter inside the function
// meant a 50-card Shop grid constructed 50+ formatters on every render,
// including once per keystroke while typing a filter.
//
// ar-EG's default numbering system renders Arabic-Indic digits (verified
// with Intl.NumberFormat('ar-EG', ...) locally), but every other money string
// in this app uses Western digits even in Arabic text (see
// checkoutCodTooExpensive in translations.ts) while dates elsewhere DO use
// Arabic-Indic digits. Money follows the Western-digit convention here, so
// numberingSystem is pinned to 'latn' for Arabic too.
//
// trailingZeroDisplay strips ".00" from a whole-EGP price ("EGP 420", not
// "EGP 420.00") while still showing real cents ("EGP 420.50") -- the brief
// asked that cents survive, not that every whole-number price grow decoration
// it never had before.
const FORMATTERS: Record<'en' | 'ar', Intl.NumberFormat> = {
  en: new Intl.NumberFormat('en-US', {
    style: 'currency', currency: SETTLEMENT_CURRENCY, trailingZeroDisplay: 'stripIfInteger',
  }),
  ar: new Intl.NumberFormat('ar-EG', {
    style: 'currency', currency: SETTLEMENT_CURRENCY, numberingSystem: 'latn', trailingZeroDisplay: 'stripIfInteger',
  }),
}

export function CurrencyProvider({ children }: { children: ReactNode }) {
  const { lang } = useLanguage()

  // A malformed price (a bad catalog fetch, a NaN/Infinity slipping through)
  // must never reach a shopper as "EGPNaN" or, in Arabic, "not a number EGP"
  // -- fall back to 0 rather than propagate it into the formatter.
  function formatPrice(amount: number): string {
    return FORMATTERS[lang].format(Number.isFinite(amount) ? amount : 0)
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
