import { useEffect, useLayoutEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { Loader2, ShoppingBag, X } from 'lucide-react'
import { toast } from 'sonner'
import { supabase, ProductImage, ProductVariant, ProductCatalogEntry } from '@/lib/supabase'
import { useCart } from '@/contexts/CartContext'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import RatingStars from '@/components/RatingStars'
import { compareSizes, defaultSizeForColor, firstInStockVariant } from '@/lib/sizes'

type QuickViewModalProps = {
  productId: string | null
  onClose: () => void
}

export default function QuickViewModal({ productId, onClose }: QuickViewModalProps) {
  const [product, setProduct] = useState<ProductCatalogEntry | null>(null)
  const [images, setImages] = useState<ProductImage[]>([])
  const [variants, setVariants] = useState<ProductVariant[]>([])
  const [loading, setLoading] = useState(false)
  // Deleted product vs. a fetch that simply failed are different situations
  // and need different messages: notFound means the product really is gone,
  // loadError means we don't actually know and a retry might work.
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [retryTick, setRetryTick] = useState(0)
  const [size, setSize] = useState('')
  const [color, setColor] = useState('')
  const { addItem } = useCart()
  const t = useT()
  const { formatPrice } = useCurrency()

  // useLayoutEffect, not useEffect: the reset below has to land BEFORE the
  // browser paints. A passive effect runs after paint, so opening product B
  // right after product A failed showed A's error for one frame -- and so did
  // reopening the same product that just failed. Moving the reset out of the
  // async load() body did nothing about that (calling an async function
  // already runs it synchronously up to its first await, so both versions
  // queued the reset in the same pass); running the pass earlier is the fix.
  useLayoutEffect(() => {
    if (!productId) return
    let cancelled = false

    setLoading(true)
    setNotFound(false)
    setLoadError(false)

    async function load() {
      try {
        const { data, error } = await supabase
          .from('product_catalog')
          .select('*')
          .eq('id', productId)
          .maybeSingle()

        if (cancelled) return
        if (error) throw error

        if (data) {
          setProduct(data)
          const [{ data: imgs }, { data: vars }] = await Promise.all([
            supabase.from('product_images').select('*').eq('product_id', data.id).order('position'),
            supabase.from('product_variants').select('*').eq('product_id', data.id).order('size').order('color'),
          ])
          if (cancelled) return
          setImages(imgs || [])
          setVariants(vars || [])

          // Same preference as ProductDetail: the first in-stock combo, then the
          // legacy flat arrays for products with no variants yet. Those arrays
          // are products.sizes/colors, NOT the catalog view's available_sizes /
          // available_colors, which are aggregated FROM the variants and so are
          // always empty on exactly the products this branch is meant to serve.
          if (vars && vars.length > 0) {
            const defaultColor = (firstInStockVariant(vars) ?? vars[0]).color
            setColor(defaultColor)
            setSize(defaultSizeForColor(vars, defaultColor))
          } else {
            setColor(data.colors[0] ?? '')
            setSize([...data.sizes].sort(compareSizes)[0] ?? '')
          }
        } else {
          setProduct(null)
          setNotFound(true)
        }
      } catch {
        if (cancelled) return
        setProduct(null)
        setLoadError(true)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [productId, retryTick])

  // Guards against showing the previous product's data while the next one loads.
  const ready = !loading && !notFound && !loadError && product?.id === productId

  const hasVariants = variants.length > 0
  const colorOptions = hasVariants ? Array.from(new Set(variants.map(v => v.color))) : (product?.colors ?? [])
  // Sorted so 9 comes before 10 and before 40; the DB can only order sizes as
  // text, which puts 10 before 9.
  const sizeOptions = Array.from(
    new Set(hasVariants ? variants.map(v => v.size) : (product?.sizes ?? []))
  ).sort(compareSizes)
  const selectedVariant = hasVariants ? variants.find(v => v.color === color && v.size === size) : undefined
  // price_override ?? products.price, matching ProductDetail and the rule the
  // server charges by. NOT min_price: that is the cheapest variant across the
  // whole product, so falling back to it quoted 400 for a size that has no
  // override and therefore costs the base 500.
  const effectivePrice = selectedVariant ? (selectedVariant.price_override ?? product?.price ?? 0) : (product?.price ?? 0)
  // The selected variant's own stock, and products.stock for the legacy
  // no-variant shape -- exactly as ProductDetail does it, and the same
  // fallback product_catalog.total_stock itself now makes (see
  // supabase/migrations/20260814000000_catalog_stock_truth.sql), so the grid
  // card's sold-out overlay and this button can no longer disagree.
  const outOfStock = hasVariants ? (!selectedVariant || selectedVariant.stock === 0) : (product?.stock ?? 0) === 0
  const mainImage = images[0]?.url || product?.image_url || ''

  function sizeAvailable(s: string) {
    if (!hasVariants) return true
    const v = variants.find(v => v.color === color && v.size === s)
    return !!v && v.stock > 0
  }

  // Switching colour used to strand the picker on a size that colour doesn't
  // stock, so the button read "Out of stock" while other sizes were sellable.
  // Move to that colour's first in-stock size whenever the current one isn't.
  useEffect(() => {
    if (!hasVariants || !color) return
    if (variants.some(v => v.color === color && v.size === size && v.stock > 0)) return
    setSize(defaultSizeForColor(variants, color))
  }, [variants, hasVariants, color, size])

  function handleAdd() {
    if (!product) return
    if (!size) { toast.error(t.productChooseSize); return }
    if (!addItem(product, size, color, 1, selectedVariant)) { toast.error(t.productStockMaxed); return }
    toast.success(t.productAdded, { description: t.productAddedSize(product.name, size) })
    onClose()
  }

  return (
    <Dialog.Root open={productId !== null} onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 z-50 fade-in" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[92vw] max-w-2xl max-h-[85vh] overflow-y-auto bg-background scale-in focus:outline-none"
          aria-describedby={undefined}
        >
          <Dialog.Close
            className="absolute top-4 end-4 w-11 h-11 flex items-center justify-center cursor-pointer hover:text-foreground/60 transition-colors z-10"
            aria-label={t.close}
          >
            <X className="w-5 h-5" />
          </Dialog.Close>

          {/* Always mounted (even mid-load) so Radix never warns about a missing Title. */}
          <Dialog.Title className="sr-only">{product?.name || t.quickViewTitle}</Dialog.Title>

          {loading ? (
            <div className="min-h-[360px] flex items-center justify-center" role="status" aria-busy="true">
              <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              <span className="sr-only">{t.loading}</span>
            </div>
          ) : notFound ? (
            <div className="min-h-[360px] flex flex-col items-center justify-center text-center px-6">
              <p className="text-muted-foreground">{t.quickViewNotFound}</p>
            </div>
          ) : loadError ? (
            <div className="min-h-[360px] flex flex-col items-center justify-center text-center px-6 gap-4">
              <p className="text-terracotta">{t.quickViewError}</p>
              <button
                onClick={() => setRetryTick(n => n + 1)}
                className="text-xs tracking-widest uppercase border-b border-foreground pb-0.5 cursor-pointer"
              >
                {t.failedTryAgain}
              </button>
            </div>
          ) : ready && product && (
            <div className="grid sm:grid-cols-2 gap-8 p-6 sm:p-8">
              <div className="aspect-square bg-muted overflow-hidden">
                <img src={mainImage} alt={product.name} className="w-full h-full object-cover" />
              </div>

              <div>
                <h2 className="font-display text-2xl mb-2 text-balance">
                  {product.name}
                </h2>
                <div className="mb-6">
                  <p className="font-display text-xl text-muted-foreground mb-1.5">
                    {formatPrice(Number(effectivePrice))}
                  </p>
                  <RatingStars rating={product.avg_rating} count={product.review_count} />
                </div>

                {colorOptions.length > 0 && (
                  <div className="mb-6">
                    <div className="flex items-center justify-between mb-3">
                      <span className="text-xs tracking-widest uppercase text-muted-foreground">{t.productColor}</span>
                      <span className="text-xs text-foreground/70">{color}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {colorOptions.map(c => (
                        <button
                          key={c}
                          onClick={() => setColor(c)}
                          aria-pressed={color === c}
                          className={`px-3.5 py-1.5 text-sm border transition-colors cursor-pointer ${
                            color === c
                              ? 'border-foreground bg-foreground text-background'
                              : 'border-border hover:border-foreground/50'
                          }`}
                        >
                          {c}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {sizeOptions.length > 0 && (
                  <div className="mb-8">
                    <span className="text-xs tracking-widest uppercase text-muted-foreground block mb-3">{t.productSize}</span>
                    <div className="grid grid-cols-5 gap-1.5">
                      {sizeOptions.map(s => {
                        const available = sizeAvailable(s)
                        return (
                          <button
                            key={s}
                            onClick={() => available && setSize(s)}
                            disabled={!available}
                            aria-pressed={size === s}
                            className={`min-h-[44px] text-sm border transition-colors ${
                              !available
                                ? 'border-border/50 text-muted-foreground/40 cursor-not-allowed'
                                : size === s
                                ? 'border-foreground bg-foreground text-background cursor-pointer'
                                : 'border-border hover:border-foreground/50 cursor-pointer'
                            }`}
                          >
                            {s}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                )}

                <button
                  onClick={handleAdd}
                  disabled={outOfStock}
                  className="w-full bg-foreground text-background py-3.5 text-sm tracking-widest uppercase hover:bg-foreground/90 transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center gap-2 mb-4"
                >
                  {outOfStock ? t.productOutOfStock : (
                    <>
                      <ShoppingBag className="w-4 h-4" />
                      {t.productAddToBag}
                    </>
                  )}
                </button>

                <Link
                  to={`/product/${product.slug}`}
                  onClick={onClose}
                  className="block text-center text-xs tracking-widest uppercase text-muted-foreground hover:text-foreground"
                >
                  {t.quickViewDetails}
                </Link>
              </div>
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
