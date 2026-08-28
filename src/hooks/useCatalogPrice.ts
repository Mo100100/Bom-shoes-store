import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { ProductCatalogEntry } from '@/lib/supabase'

// The one place the storefront turns a product_catalog row into a price label
// for a grid, list or dropdown, i.e. anywhere the shopper has not picked a
// size yet.
//
// min_price is the cheapest variant, so it is only THE price when every
// variant costs the same. When they differ it is a starting price and has to
// say so, otherwise the card advertises 400 and the checkout charges 500 for
// the size the shopper actually wants. Every such surface calls this, so they
// cannot drift apart into telling shoppers different things.
//
// Not for a surface where a specific variant is selected -- there the answer
// is that variant's own price_override ?? products.price, which is the rule
// the server charges by (supabase/functions/_shared/pricing.ts).
export function useCatalogPrice() {
  const t = useT()
  const { formatPrice } = useCurrency()

  return function catalogPrice(p: Pick<ProductCatalogEntry, 'min_price' | 'max_price'>): string {
    const lowest = formatPrice(Number(p.min_price))
    return Number(p.max_price) > Number(p.min_price) ? t.shopPriceFrom(lowest) : lowest
  }
}
