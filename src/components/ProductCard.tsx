import { Link } from 'react-router-dom'
import { ProductCatalogEntry } from '@/lib/supabase'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useBrands } from '@/contexts/BrandsContext'
import { useCatalogPrice } from '@/hooks/useCatalogPrice'
import WishlistButton from '@/components/WishlistButton'
import { cn } from '@/lib/utils'
import { Eye, Plus, Loader2 } from 'lucide-react'

const NEW_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

type ProductCardProps = {
  product: ProductCatalogEntry
  /** Localized category label -- used as the small top label only when the
   *  product has no brand set. */
  categoryLabel: string
  /** Pre-formatted buy-x-get-y badge text, if an active promo applies. */
  bxgyBadge?: string
  /** Opens the quick-view modal. Optional: the homepage grid has no modal to
   *  open, so it omits this and the button simply isn't rendered. */
  onQuickView?: (productId: string) => void
  onQuickAdd: (product: ProductCatalogEntry) => void
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
  onQuickView,
  onQuickAdd,
  quickAdding = false,
  animationDelay,
  className = '',
}: ProductCardProps) {
  const t = useT()
  const { formatPrice } = useCurrency()
  const { brandLabel } = useBrands()
  const catalogPrice = useCatalogPrice()
  const isNew = Date.now() - new Date(p.created_at).getTime() < NEW_WINDOW_MS
  // has_discount comes straight from product_catalog, which computes it from
  // the rule the server actually charges by: coalesce(price_override,
  // products.price) per variant (supabase/functions/_shared/pricing.ts).
  // Reading it rather than re-deriving it here is what keeps this badge and
  // the /sale filter in Shop.tsx meaning the same thing.
  const hasSale = p.has_discount
  // products.brand stores brands.value, an immutable key that is not the
  // display name (the live row value='ل' has name='Burberry'). Look it up the
  // same way the category beside it is looked up.
  // Brand names are Latin, the category fallback is translated, so only the
  // brand run gets .latin-text (which keeps its tracking-* on the Arabic store).
  const brandName = brandLabel(p.brand)
  const topLabel = brandName || categoryLabel

  return (
    // The card is a <div> holding a <Link>, not one big <Link>: the wishlist,
    // quick-view and quick-add buttons used to sit INSIDE the link and cancel
    // it with preventDefault, so a tap that missed any of them by a few pixels
    // navigated to the product instead of doing what the customer aimed at.
    // A <button> descending from an <a> is also invalid HTML: the anchor
    // swallows the button's accessible name and activation is ambiguous.
    // Outside the link there is nothing to cancel and nothing to miss into.
    // `relative` is what the heart below positions against.
    <div
      className={cn(
        'group relative flex flex-col fade-up bg-background border border-border rounded-[14px] p-[18px] transition-all duration-300 hover:-translate-y-[3px] hover:shadow-[0_18px_44px_rgba(20,20,20,0.10)] hover:border-[#d6d1c5]',
        className
      )}
      style={animationDelay ? { animationDelay } : undefined}
    >
      {/* Without aria-label the link's name is the alt text, brand, name,
          price and every badge read out as one paragraph. */}
      <Link to={`/product/${p.slug}`} aria-label={p.name} className="block">
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
        </div>

        <div className="px-0.5">
          <span className={cn('block text-[11px] font-semibold tracking-[0.1em] uppercase text-muted-foreground mb-1', brandName && 'latin-text')}>
            {topLabel}
          </span>
          <h3 className="text-sm font-semibold uppercase tracking-wide leading-snug text-foreground min-h-[36px] group-hover:text-muted-foreground transition-colors">
            {p.name}
          </h3>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-base font-bold text-foreground">{catalogPrice(p)}</span>
            {hasSale && (
              <span className="text-xs text-muted-foreground line-through">{formatPrice(Number(p.price))}</span>
            )}
          </div>
        </div>
      </Link>

      {/* Sibling of the Link, not a child, so it is a real button and not a
          miss-tap into the product page. 30px = the card's 18px padding plus
          the 12px inset it used to have inside the image box, which keeps it
          exactly where it has always sat. */}
      <WishlistButton
        productId={p.id}
        className="absolute top-[30px] end-[30px] p-0 w-11 h-11 rounded-full bg-white/85 backdrop-blur-sm shadow-sm flex items-center justify-center"
      />

      <div className="px-0.5">
        <div className="mt-3.5 flex items-center justify-between gap-3">
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
          {/* 44px each and 12px apart: they were 34px targets 8px apart on a
              phone, which is under every touch guideline there is. */}
          <div className="flex items-center gap-3 shrink-0">
            {onQuickView && (
              <button
                onClick={() => onQuickView(p.id)}
                aria-label={t.shopQuickView}
                title={t.shopQuickView}
                className="w-11 h-11 rounded-full border border-border text-muted-foreground flex items-center justify-center hover:border-foreground hover:text-foreground hover:scale-105 transition-all cursor-pointer"
              >
                <Eye className="w-4 h-4" />
              </button>
            )}
            {/* Quick-add needs a variant to put in the cart, so a product with
                no in-stock variant row cannot be quick-added however much
                products.stock claims. total_stock now falls back to
                products.stock for legacy variant-less products, which would
                otherwise render a "+" that can only ever answer "out of
                stock". available_sizes is aggregated over stock > 0 variants
                only, so an empty one means there is nothing to add. */}
            {p.total_stock > 0 && p.available_sizes.length > 0 && (
              <button
                onClick={() => onQuickAdd(p)}
                disabled={quickAdding}
                aria-label={t.shopQuickAdd}
                title={t.shopQuickAdd}
                className="w-11 h-11 rounded-full border border-foreground text-foreground flex items-center justify-center hover:bg-foreground hover:text-background hover:scale-105 transition-all cursor-pointer disabled:opacity-50"
              >
                {quickAdding ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
