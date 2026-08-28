import { Link } from 'react-router-dom'
import { ProductCatalogEntry } from '@/lib/supabase'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import WishlistButton from '@/components/WishlistButton'
import { cn } from '@/lib/utils'
import { Plus, Loader2 } from 'lucide-react'

const NEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

type ProductCardProps = {
  product: ProductCatalogEntry
  /** Localized category label -- used as the small top label only when the
   *  product has no brand set. */
  categoryLabel: string
  /** Pre-formatted buy-x-get-y badge text, if an active promo applies. */
  bxgyBadge?: string
  onQuickView?: (productId: string) => void
  onQuickAdd: (product: ProductCatalogEntry, e: React.MouseEvent) => void
  quickAdding?: boolean
  animationDelay?: string
  className?: string
}

// Shared product grid card (homepage curated grid + Shop). Bordered white card
// with a soft "studio pedestal" media area (contained product shot), brand +
// name + price, a SALE/NEW pill and a circular add-to-cart -- matching the
// KICKS-style storefront design.
export default function ProductCard({
  product: p,
  categoryLabel,
  bxgyBadge,
  onQuickAdd,
  quickAdding = false,
  animationDelay,
  className = '',
}: ProductCardProps) {
  const t = useT()
  const { formatPrice } = useCurrency()
  const isNew = Date.now() - new Date(p.created_at).getTime() < NEW_WINDOW_MS
  // min_price/max_price/has_discount all come straight from product_catalog,
  // which computes them from the rule the server actually charges by:
  // coalesce(price_override, products.price) per variant
  // (supabase/functions/_shared/pricing.ts). Reading has_discount rather than
  // re-deriving it here is what keeps this badge and the /sale filter in
  // Shop.tsx meaning the same thing.
  const displayPrice = Number(p.min_price)
  const hasSale = p.has_discount
  // Sizes are not all the same price, so the lowest one is a starting price,
  // not the price. Showing it bare is how a 400 card charged 500 at checkout.
  const isFromPrice = Number(p.max_price) > displayPrice
  const topLabel = p.brand || categoryLabel

  return (
    <Link
      to={`/product/${p.slug}`}
      className={cn(
        'group flex flex-col fade-up bg-background border border-border rounded-[14px] p-[18px] transition-all duration-300 hover:-translate-y-[3px] hover:shadow-[0_18px_44px_rgba(20,20,20,0.10)] hover:border-[#d6d1c5]',
        className
      )}
      style={animationDelay ? { animationDelay } : undefined}
    >
      <div className="relative bg-[#f3f1ec] rounded-[10px] aspect-square overflow-hidden flex items-center justify-center mb-[18px]">
        <img
          src={p.image_url || ''}
          alt={p.name}
          loading="lazy"
          className="w-[82%] h-[82%] object-contain transition-transform duration-500 group-hover:scale-105"
        />

        {p.total_stock < 10 && p.total_stock > 0 && (
          <div className="absolute bottom-3 start-3 bg-foreground/90 text-background px-2.5 py-1 text-[10px] tracking-widest uppercase rounded-full">
            {t.shopOnlyLeft(p.total_stock)}
          </div>
        )}
        {p.total_stock === 0 && (
          <div className="absolute inset-0 flex items-center justify-center bg-background/60">
            <span className="text-[11px] tracking-widest uppercase text-muted-foreground">{t.productOutOfStock}</span>
          </div>
        )}
        {bxgyBadge && (
          <div className="absolute bottom-3 end-3 bg-background/90 backdrop-blur-sm px-2.5 py-1 text-[10px] tracking-widest uppercase rounded-full">
            {bxgyBadge}
          </div>
        )}

        <div className="absolute top-3 end-3">
          <WishlistButton
            productId={p.id}
            className="p-0 w-8 h-8 rounded-full bg-white/85 backdrop-blur-sm shadow-sm flex items-center justify-center"
          />
        </div>
      </div>

      <div className="px-0.5">
        <span className="block text-[11px] font-semibold tracking-[0.1em] uppercase text-muted-foreground mb-1">
          {topLabel}
        </span>
        <h3 className="text-sm font-semibold uppercase tracking-wide leading-snug text-foreground min-h-[36px] group-hover:text-muted-foreground transition-colors">
          {p.name}
        </h3>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-base font-bold text-foreground">
            {isFromPrice ? t.shopPriceFrom(formatPrice(displayPrice)) : formatPrice(displayPrice)}
          </span>
          {hasSale && (
            <span className="text-xs text-muted-foreground line-through">{formatPrice(Number(p.price))}</span>
          )}
        </div>
        <div className="mt-3.5 flex items-center justify-between gap-2">
          {hasSale ? (
            <span className="inline-block text-[10px] font-semibold tracking-[0.12em] uppercase text-white bg-terracotta px-2.5 py-1 rounded-full">
              {t.shopSale}
            </span>
          ) : isNew ? (
            <span className="inline-block text-[10px] font-semibold tracking-[0.12em] uppercase text-muted-foreground bg-[#f3f1ec] px-2.5 py-1 rounded-full">
              {t.shopNew}
            </span>
          ) : (
            <span />
          )}
          {p.total_stock > 0 && (
            <button
              onClick={(e) => onQuickAdd(p, e)}
              disabled={quickAdding}
              aria-label={t.shopQuickAdd}
              title={t.shopQuickAdd}
              className="shrink-0 w-[34px] h-[34px] rounded-full border border-foreground text-foreground flex items-center justify-center hover:bg-foreground hover:text-background hover:scale-105 transition-all cursor-pointer disabled:opacity-50"
            >
              {quickAdding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            </button>
          )}
        </div>
      </div>
    </Link>
  )
}
