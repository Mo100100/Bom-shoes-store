import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useCart, CartItem } from '@/contexts/CartContext'
import { couponRejectionMessage, TAX_RATE } from '@/lib/cart'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { supabase, readServerError } from '@/lib/supabase'
import { Minus, Plus, X, ArrowRight, ShoppingBag, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useSeo } from '@/hooks/useSeo'

type CouponPreview = { amount: number; description: string | null; freeShipping: boolean }

// Same identity a cart line is keyed by everywhere else: product + size + colour.
function lineKey(item: CartItem): string {
  return `${item.product.id}-${item.size}-${item.color}`
}

export default function Cart() {
  const { items, updateQuantity, removeItem, totalItems, totalPrice, clearCart, revalidateCart, couponCode, setCouponCode } = useCart()
  const navigate = useNavigate()
  const t = useT()
  const { formatPrice } = useCurrency()

  useSeo({ title: `${t.cart} · ${t.brandName}`, description: t.cartEmptyDesc })

  const [couponInput, setCouponInput] = useState('')
  const [applying, setApplying] = useState(false)
  const [discount, setDiscount] = useState<CouponPreview | null>(null)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const [brokenImages, setBrokenImages] = useState<string[]>([])

  // Lines the customer can still buy. A line whose product or variant has
  // disappeared is shown but excluded here, so it never reaches the coupon
  // preview (the server would reject the whole cart because of it).
  const sellable = items.filter(i => !i.unavailable)
  const hasUnavailable = sellable.length !== items.length

  // Re-check the cart against the database for the customer who left this tab
  // open since yesterday (the provider only does it at hydration), then
  // preview the discount -- a coupon already applied in a previous visit
  // (persisted in localStorage), and with or without one, any auto-applied
  // promotion or bundle the cart already qualifies for. Those are applied at
  // checkout whether or not they are shown, so leaving them out made this
  // total disagree with the amount charged. Only runs once on mount; a later
  // cart-quantity edit won't refresh this preview (see task note: reasonable
  // preview, not bulletproof) -- the authoritative number is always recomputed
  // at order creation regardless.
  useEffect(() => {
    void revalidateCart()
    if (items.length > 0) {
      void previewDiscount(couponCode, { silent: true })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // `code` is optional: with one this validates it, without one it previews
  // whatever the cart qualifies for on its own.
  async function previewDiscount(code: string | null, opts?: { silent?: boolean }) {
    setApplying(true)
    try {
      const { data, error } = await supabase.functions.invoke('validate-coupon', {
        body: {
          ...(code ? { code } : {}),
          items: sellable.map(i => ({ product_id: i.product.id, size: i.size, color: i.color, quantity: i.quantity })),
        },
      })
      if (error) throw error
      if (!data?.valid) {
        // Only a typed code can be rejected. Drop it and fall back to the
        // no-code preview, so a dead code doesn't also hide a promotion the
        // cart still qualifies for.
        if (opts?.silent) setCouponCode(null)
        else toast.error(couponRejectionMessage(data, t, formatPrice))
        setDiscount(null)
        if (code) void previewDiscount(null, { silent: true })
        return
      }
      if (code) setCouponCode(code)
      setDiscount({ amount: data.discountAmount, description: data.description, freeShipping: !!data.freeShipping })
    } catch (err) {
      console.error(err)
      const { code: errorCode } = await readServerError(err)
      if (!opts?.silent) toast.error(errorCode === 'rate_limited' ? t.cartCouponTooMany : t.cartCouponInvalid)
      setDiscount(null)
    } finally {
      setApplying(false)
    }
  }

  function handleApplyClick() {
    const code = couponInput.trim()
    if (!code) return
    void previewDiscount(code)
  }

  function handleRemoveCoupon() {
    setCouponCode(null)
    setDiscount(null)
    setCouponInput('')
    // Removing the code doesn't remove an auto-applied promotion, so re-preview
    // without it rather than showing a total the checkout won't charge.
    void previewDiscount(null, { silent: true })
  }

  // Shipping is priced per governorate at checkout (the customer hasn't chosen
  // one yet here), so it's excluded from this running total and shown as
  // "calculated at checkout". A free-shipping coupon is noted but doesn't
  // change the number shown here.
  const tax = totalPrice * TAX_RATE
  const hasDiscount = !!discount && discount.amount > 0
  const grand = totalPrice + tax - (hasDiscount ? discount!.amount : 0)

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-cream flex flex-col items-center justify-center px-6 text-center">
        <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-6">
          <ShoppingBag className="w-7 h-7 text-muted-foreground" />
        </div>
        <p className="text-zen text-muted-foreground mb-4">{t.cartEyebrow}</p>
        <h1 className="font-display text-4xl md:text-5xl mb-4">{t.cartEmptyTitle}</h1>
        <p className="text-muted-foreground max-w-sm mb-8 font-light">
          {t.cartEmptyDesc}
        </p>
        <Link
          to="/shop"
          className="bg-foreground text-background px-7 py-3.5 text-sm tracking-widest uppercase hover:bg-foreground/85 transition-colors"
        >
          {t.cartEmptyCta}
        </Link>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-cream px-6 lg:px-10 py-12 lg:py-16">
      <div className="max-w-[1400px] mx-auto">
        <p className="text-zen text-muted-foreground mb-4">{t.cartEyebrow}</p>
        <h1 className="font-display text-4xl md:text-6xl mb-12">
          {t.cartPieces(totalItems)}
        </h1>

        <div className="grid lg:grid-cols-[1fr_400px] gap-12 lg:gap-16">
          {/* Items */}
          <div className="space-y-8">
            {items.map(item => {
              const key = lineKey(item)
              // An empty src re-requests the page itself and renders a broken
              // image, so the placeholder stands in for both a product with no
              // image and one whose image URL has since died.
              const showImage = !!item.product.image_url && !brokenImages.includes(key)
              const atMax = item.stock != null && item.quantity >= item.stock
              return (
              <div
                key={key}
                className={`flex gap-4 sm:gap-6 pb-8 border-b border-border last:border-0${item.unavailable ? ' opacity-60' : ''}`}
              >
                <Link to={`/product/${item.product.slug}`} className="flex-shrink-0 w-24 sm:w-32 aspect-square bg-muted overflow-hidden">
                  {showImage ? (
                    <img
                      src={item.product.image_url}
                      alt={item.product.name}
                      className="w-full h-full object-cover"
                      onError={() => setBrokenImages(current => current.includes(key) ? current : [...current, key])}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center" aria-hidden="true">
                      <ShoppingBag className="w-6 h-6 text-muted-foreground" />
                    </div>
                  )}
                </Link>
                <div className="flex-1 min-w-0">
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <Link
                        to={`/product/${item.product.slug}`}
                        className="font-display text-xl hover:text-muted-foreground transition-colors"
                      >
                        {item.product.name}
                      </Link>
                      <p className="text-xs text-muted-foreground tracking-wider uppercase mt-1">
                        {item.product.category}
                      </p>
                      <p className="text-sm text-muted-foreground mt-2">
                        {t.cartVariant(item.color, item.size)}
                      </p>
                    </div>
                    <button
                      onClick={() => removeItem(item.product.id, item.size, item.color)}
                      className="-m-3.5 w-11 h-11 flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                      aria-label={t.cartRemove}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                  {item.unavailable ? (
                    <div className="mt-4 flex items-center justify-between gap-4">
                      <p className="text-sm text-terracotta">{t.cartItemUnavailable}</p>
                      <button
                        onClick={() => removeItem(item.product.id, item.size, item.color)}
                        className="text-xs tracking-wider uppercase border border-border px-3 py-2 hover:bg-muted transition-colors cursor-pointer"
                      >
                        {t.cartRemove}
                      </button>
                    </div>
                  ) : (
                    <div className="mt-4 flex items-center justify-between">
                      <div>
                        <div className="flex items-center border border-border">
                          <button
                            onClick={() => updateQuantity(item.product.id, item.size, item.color, item.quantity - 1)}
                            className="w-11 h-11 flex items-center justify-center hover:bg-muted transition-colors cursor-pointer"
                            aria-label={t.cartDecrease}
                          >
                            <Minus className="w-3 h-3" />
                          </button>
                          {/* Announced on change: the buttons themselves say
                              nothing about the number they just moved. */}
                          <span className="w-10 text-center text-sm" aria-live="polite">{item.quantity}</span>
                          <button
                            onClick={() => updateQuantity(item.product.id, item.size, item.color, item.quantity + 1)}
                            disabled={atMax}
                            className="w-11 h-11 flex items-center justify-center hover:bg-muted transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            aria-label={t.cartIncrease}
                          >
                            <Plus className="w-3 h-3" />
                          </button>
                        </div>
                        {atMax && (
                          <p className="text-[11px] text-muted-foreground mt-1.5">{t.shopOnlyLeft(item.stock!)}</p>
                        )}
                      </div>
                      <p className="text-sm font-medium">
                        {formatPrice(item.unitPrice * item.quantity)}
                      </p>
                    </div>
                  )}
                </div>
              </div>
              )
            })}

            <div className="flex items-center justify-between gap-4 pt-4">
              {/* Two-step: emptying the whole basket is one tap on a small
                  target, and there is no undo. */}
              {confirmingClear ? (
                <div className="flex items-center gap-3 text-xs">
                  <span className="text-muted-foreground">{t.cartClearConfirm}</span>
                  <button
                    onClick={() => { clearCart(); setConfirmingClear(false) }}
                    className="tracking-wider uppercase border border-border px-3 py-2 hover:bg-muted transition-colors cursor-pointer"
                  >
                    {t.cartClearYes}
                  </button>
                  <button
                    onClick={() => setConfirmingClear(false)}
                    className="tracking-wider uppercase text-muted-foreground hover:text-foreground transition-colors px-2 py-2 cursor-pointer"
                  >
                    {t.cartClearCancel}
                  </button>
                </div>
              ) : (
                <button
                  onClick={() => setConfirmingClear(true)}
                  className="text-xs text-muted-foreground hover:text-foreground transition-colors tracking-wider uppercase cursor-pointer"
                >
                  {t.cartClear}
                </button>
              )}
              <Link
                to="/shop"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors tracking-wider uppercase"
              >
                {t.cartContinue}
              </Link>
            </div>
          </div>

          {/* Summary */}
          <aside className="lg:sticky lg:top-28 h-fit">
            <div className="border border-border p-6 lg:p-8 bg-card">
              <h2 className="font-display text-2xl mb-6">{t.checkoutYourOrder}</h2>

              {/* Coupon */}
              <div className="mb-6">
                {!couponCode ? (
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={couponInput}
                      onChange={e => setCouponInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleApplyClick() } }}
                      placeholder={t.cartCouponPlaceholder}
                      aria-label={t.cartCouponPlaceholder}
                      className="flex-1 min-w-0 bg-transparent border-b border-foreground/30 focus:border-foreground outline-none py-2 text-sm transition-colors"
                    />
                    <button
                      type="button"
                      onClick={handleApplyClick}
                      disabled={applying || !couponInput.trim()}
                      className="px-4 text-xs tracking-widest uppercase border border-border hover:bg-muted transition-colors disabled:opacity-50 cursor-pointer flex items-center justify-center"
                    >
                      {applying ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : t.cartCouponApply}
                    </button>
                  </div>
                ) : (
                  <div className="flex items-center justify-between gap-3 text-sm border border-border px-3 py-2">
                    <span className="truncate">
                      {couponCode}
                      {discount?.description ? ` · ${discount.description}` : ''}
                    </span>
                    <button
                      type="button"
                      onClick={handleRemoveCoupon}
                      className="p-1 -m-1 text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex-shrink-0"
                      aria-label={t.cartRemove}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              <dl className="space-y-3 text-sm">
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t.cartSubtotal}</dt>
                  <dd>{formatPrice(totalPrice)}</dd>
                </div>
                {hasDiscount && (
                  <div className="flex justify-between">
                    <dt className="text-muted-foreground">{t.cartDiscount}</dt>
                    <dd>−{formatPrice(discount!.amount)}</dd>
                  </div>
                )}
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t.cartShipping}</dt>
                  <dd className="text-muted-foreground text-xs">{discount?.freeShipping ? t.cartFree : t.cartShipAtCheckout}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-muted-foreground">{t.cartTax}</dt>
                  <dd>{formatPrice(tax)}</dd>
                </div>
                <div className="pt-3 mt-3 border-t border-border flex justify-between items-baseline">
                  <dt>{t.cartTotal}</dt>
                  <dd className="font-display text-2xl">{formatPrice(grand)}</dd>
                </div>
              </dl>
              <button
                onClick={() => navigate('/checkout')}
                disabled={hasUnavailable}
                className="mt-6 w-full bg-foreground text-background py-4 text-sm tracking-widest uppercase hover:bg-foreground/85 transition-colors flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t.cartCheckout}
                <ArrowRight className="w-4 h-4 flip-rtl" />
              </button>
              {hasUnavailable && (
                <p className="text-[11px] text-terracotta text-center mt-3">{t.cartRemoveUnavailable}</p>
              )}
              <p className="text-[11px] text-muted-foreground text-center mt-4">
                {t.cartSecure}
              </p>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}
