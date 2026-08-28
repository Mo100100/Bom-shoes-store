import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCart } from '@/contexts/CartContext'
import { useAuth } from '@/contexts/AuthContext'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { supabase, readServerError } from '@/lib/supabase'
import { couponRejectionMessage, TAX_RATE } from '@/lib/cart'
import type { CreateOrderRequest, CreateOrderResponse } from '@/lib/kashier'
import {
  DEFAULT_CHECKOUT_CONFIG, fetchCheckoutConfig, fetchShippingConfig, regionLabel,
  type CheckoutConfig, type ShippingRegion,
} from '@/lib/checkoutConfig'
import { ArrowLeft, CreditCard, Banknote } from 'lucide-react'
import { toast } from 'sonner'
import { Link } from 'react-router-dom'
import { useSeo } from '@/hooks/useSeo'

const REQUEST_ID_KEY = 'bom-checkout-request-id'

// A new key, persisted so a reload picks it back up. Storage is wrapped the
// way CartContext wraps its own: in private mode it simply throws, and an
// unpersisted key is no worse than the ref-only behaviour this replaces.
function mintRequestId(): string {
  const id = crypto.randomUUID()
  try { sessionStorage.setItem(REQUEST_ID_KEY, id) }
  catch { /* sessionStorage is unavailable in private mode: the key just isn't persisted */ }
  return id
}

function readOrMintRequestId(): string {
  try {
    const stored = sessionStorage.getItem(REQUEST_ID_KEY)
    if (stored) return stored
  } catch { /* sessionStorage is unavailable in private mode: mint a fresh key */ }
  return mintRequestId()
}

export default function Checkout() {
  const { items, totalPrice, clearCart, couponCode } = useCart()
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const t = useT()
  const { lang } = useLanguage()
  const { formatPrice } = useCurrency()

  useSeo({ title: `${t.checkoutShipping} · ${t.brandName}`, description: t.checkoutPaymentDesc })

  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    fullName: profile?.full_name || '',
    email: user?.email || '',
    phone: '',
    address: '',
    city: '',
    regionCode: '',
    notes: '',
  })
  const [discountAmount, setDiscountAmount] = useState(0)
  const [couponError, setCouponError] = useState<string | null>(null)
  const [paymentMethod, setPaymentMethod] = useState<'online' | 'cash'>('online')
  const [checkoutConfig, setCheckoutConfig] = useState<CheckoutConfig>(DEFAULT_CHECKOUT_CONFIG)
  const [regions, setRegions] = useState<ShippingRegion[]>([])
  const [regionsLoading, setRegionsLoading] = useState(true)
  const [regionsError, setRegionsError] = useState(false)

  // Idempotency key for this checkout attempt. A Cash on Delivery order is
  // placed and its stock reserved before the response is sent, so a submit
  // whose response is lost (connection drops, phone sleeps) leaves an order
  // the customer cannot see -- and pressing the button again would place a
  // second one. Sending the same key means the server returns that first
  // order instead. It is regenerated only when the server actually answered:
  // that answer decided the attempt, so the next press is a genuinely new
  // order rather than a retry.
  //
  // Held in sessionStorage, not just a ref: what a customer actually does
  // when "Place order" hangs is RELOAD the page, and a ref does not survive
  // that. A fresh uuid would sail past orders_client_request_id_key and place
  // a second COD order against the same stock. sessionStorage is the right
  // scope -- per tab, survives a reload, gone when the tab closes.
  const requestIdRef = useRef('')
  if (!requestIdRef.current) requestIdRef.current = readOrMintRequestId()

  // Which governorates can be shipped to (site_content.shipping). The select
  // is required, so a failed fetch here would otherwise leave the customer
  // with an empty, silently unusable dropdown -- loading/error state and a
  // retry are how they find out and recover.
  //
  // loadIdRef guards a retry click that overlaps the original call: if the
  // first attempt fails AFTER a second (retry) attempt already succeeded,
  // its stale rejection must not stomp the regions the retry just loaded and
  // re-lock the select behind an error banner.
  const shippingLoadIdRef = useRef(0)

  function loadShipping() {
    const id = ++shippingLoadIdRef.current
    setRegionsLoading(true)
    setRegionsError(false)
    fetchShippingConfig().then(
      cfg => {
        if (id !== shippingLoadIdRef.current) return
        setRegions(cfg.regions)
        setRegionsLoading(false)
      },
      () => {
        if (id !== shippingLoadIdRef.current) return
        setRegionsError(true)
        setRegionsLoading(false)
      }
    )
  }

  // Which payment methods the admin has enabled (site_content.checkout_config).
  useEffect(() => {
    fetchCheckoutConfig().then(cfg => {
      setCheckoutConfig(cfg)
      // If online is off, default the selection to cash (and vice versa) so a
      // disabled method is never the pre-selected one.
      if (!cfg.online_enabled && cfg.cash_enabled) setPaymentMethod('cash')
      else if (cfg.online_enabled && !cfg.cash_enabled) setPaymentMethod('online')
    })
    loadShipping()
  }, [])

  const selectedRegion = regions.find(r => r.code === form.regionCode) || null

  // Lines the customer can still buy. Revalidation can flag one at any moment
  // (including while this page sits open), and totalPrice already leaves those
  // out, so the summary and the submitted payload have to as well: otherwise
  // this page lists three lines above a subtotal that only covers two, and the
  // order dies server-side in resolveCartPricing with no client-side warning.
  const sellable = items.filter(i => !i.unavailable)
  const hasUnavailable = sellable.length !== items.length

  // Live preview of every discount this cart gets: the coupon carried over
  // from the Cart page AND any auto-applied promotion or bundle. The server
  // resolves both (the same call create-order makes), so this runs even with
  // no coupon code -- an auto-promotion used to be applied at checkout but
  // never previewed, which made the summary disagree with the amount charged.
  // The authoritative number still comes back from create-order at submit
  // time below and overwrites this if it differs.
  //
  // regionCode goes with it because a free_shipping coupon is worth exactly
  // the shipping cost: without it the preview valued every such candidate at
  // 0, so an auto free-shipping promo was never shown and an explicit
  // free-shipping code could lose a comparison here that it wins server-side.
  // The client sends only the CODE; validate-coupon prices it itself from the
  // same config create-order uses.
  useEffect(() => {
    if (sellable.length === 0) { setDiscountAmount(0); return }
    let cancelled = false
    supabase.functions.invoke('validate-coupon', {
      body: {
        ...(couponCode ? { code: couponCode } : {}),
        items: sellable.map(i => ({ product_id: i.product.id, size: i.size, color: i.color, quantity: i.quantity })),
        ...(form.regionCode ? { regionCode: form.regionCode } : {}),
      },
    }).then(({ data }) => {
      if (cancelled) return
      setDiscountAmount(data?.valid ? data.discountAmount : 0)
      // A code carried over from the basket can be rejected here (it expired,
      // or it is limited per customer and this shopper is not signed in). The
      // discount silently vanishing between the two pages, with the same code
      // still shown as applied, is worse than saying why.
      setCouponError(couponCode && data && !data.valid ? couponRejectionMessage(data, t, formatPrice) : null)
    }).catch(() => { if (!cancelled) { setDiscountAmount(0); setCouponError(null) } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [couponCode, form.regionCode])

  // Exactly the server's own arithmetic (computeOrderTotal in
  // supabase/functions/_shared/pricing.ts): shipping is always the selected
  // governorate's price, and a waiver arrives as part of discountAmount
  // rather than by zeroing this. Zeroing it here as well double-counted the
  // waiver, which is why the whole total is reconciled from the preview now
  // and not just the discount line.
  const shipping = selectedRegion?.price ?? 0
  const tax = totalPrice * TAX_RATE
  const grand = Math.max(0, totalPrice + shipping + tax - discountAmount)

  function setField(k: keyof typeof form, v: string) {
    setForm(f => ({ ...f, [k]: v }))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (sellable.length === 0) return
    if (hasUnavailable) {
      toast.error(t.checkoutUnavailable)
      return
    }
    // Phone is required (the courier calls the customer); email is optional.
    // A governorate must be chosen so shipping can be priced.
    if (!form.fullName || !form.phone || !form.address || !form.city || !form.regionCode) {
      toast.error(t.checkoutRequired)
      return
    }

    setSubmitting(true)

    try {
      // The edge function looks up real product prices/stock server-side and
      // computes the total itself -- it never trusts anything the client
      // sends beyond which product/size/color/quantity was picked. The order
      // id, order row, and Kashier checkout URL (with its signed hash) are
      // all generated server-side too; see supabase/functions/create-order.
      const body: CreateOrderRequest = {
        items: sellable.map(i => ({
          product_id: i.product.id,
          size: i.size,
          color: i.color,
          quantity: i.quantity,
        })),
        customer: {
          fullName: form.fullName,
          email: form.email || undefined,
          phone: form.phone,
          address: form.address,
          city: form.city,
          country: lang === 'ar' ? 'مصر' : 'Egypt',
          notes: form.notes,
        },
        regionCode: form.regionCode,
        ...(couponCode ? { couponCode } : {}),
        lang,
        paymentMethod,
        clientRequestId: requestIdRef.current,
      }

      const { data, error } = await supabase.functions.invoke<CreateOrderResponse>('create-order', { body })

      if (error) throw error

      // The server answered and the order exists: this key has done its job.
      // Retiring it now (and out of sessionStorage) means a customer who
      // comes back to checkout in the same tab places a genuinely new order
      // instead of being handed this one again.
      requestIdRef.current = mintRequestId()

      // Reconcile with what the server actually applied (it re-validates the
      // coupon independently and may land on a different number than the
      // preview above, e.g. it just expired).
      setDiscountAmount(data?.discountAmount ?? 0)

      // Cash on Delivery: the order is already placed + stock reserved, so go
      // straight to the thank-you page (no Kashier redirect).
      if (data?.cod) {
        clearCart()
        navigate(`/checkout/success?orderId=${encodeURIComponent(data.orderId)}`)
        return
      }

      if (!data?.checkoutUrl) throw new Error('BOM Store: create-order did not return a checkout URL')

      // Note: We do NOT clear cart here because the user might return from a failed payment.
      // The cart will be cleared on the success page.
      window.location.href = data.checkoutUrl
    } catch (err: any) {
      console.error(err)
      const { responded, code, limit } = await readServerError(err)
      // The server decided this attempt (it rejected the cart, the coupon, the
      // cap): the next press is a new order, not a retry of this one. A
      // failure with no response leaves the key in place so a retry can be
      // recognised as the same order.
      if (responded) requestIdRef.current = mintRequestId()
      // The cap messages quote the ceiling, so they are only used when the
      // server actually sent one -- a body that could not be read falls back
      // to the generic message rather than telling the customer they are
      // "limited to 0 items".
      const hasLimit = typeof limit === 'number'
      toast.error(
        code === 'rate_limited' ? t.checkoutTooManyOrders
          : code === 'cod_item_cap' && hasLimit ? t.checkoutCodTooManyItems(limit)
            : code === 'cod_value_cap' && hasLimit ? t.checkoutCodTooExpensive(limit)
              : t.checkoutFailed,
      )
      setSubmitting(false)
    }
  }

  if (items.length === 0) {
    return (
      <div className="min-h-screen bg-cream flex flex-col items-center justify-center px-6 text-center">
        <p className="text-zen text-muted-foreground mb-4">{t.cartEyebrow}</p>
        <Link to="/shop" className="font-display text-2xl mb-3">{t.cartEmptyTitle}</Link>
        <Link to="/shop" className="text-sm text-muted-foreground underline-offset-2 hover:underline">
          {t.cartEmptyCta}
        </Link>
      </div>
    )
  }

  const fieldFullName = `${t.fieldFullName}${t.fieldRequired}`
  const fieldEmail = `${t.fieldEmail}${t.fieldOptional}`
  const fieldPhone = `${t.fieldPhone}${t.fieldRequired}`
  const fieldRegion = `${t.fieldRegion}${t.fieldRequired}`
  const fieldAddress = `${t.fieldAddress}${t.fieldRequired}`
  const fieldCity = `${t.fieldCity}${t.fieldRequired}`
  const fieldNotes = t.fieldNotes

  return (
    <div className="min-h-screen bg-cream px-6 lg:px-10 py-12 lg:py-16">
      <div className="max-w-[1400px] mx-auto">
        <Link
          to="/cart"
          className="inline-flex items-center gap-2 text-xs tracking-widest uppercase text-muted-foreground hover:text-foreground mb-10"
        >
          <ArrowLeft className="w-3.5 h-3.5 flip-rtl" />
          {t.checkoutBack}
        </Link>

        <div className="grid lg:grid-cols-[1fr_440px] gap-12 lg:gap-16">
          <form onSubmit={handleSubmit} className="space-y-10">
            <div>
              <p className="text-zen text-muted-foreground mb-3">{t.checkoutStep1}</p>
              <h1 className="font-display text-3xl md:text-4xl mb-8">{t.checkoutShipping}</h1>
              <div className="grid sm:grid-cols-2 gap-4">
                <Field label={fieldFullName} value={form.fullName} onChange={v => setField('fullName', v)} required dir={lang === 'ar' ? 'rtl' : 'ltr'} />
                {/* Phone numbers and email addresses are always read
                    left-to-right, even on an Arabic page: forcing them RTL put
                    the leading + and the domain on the wrong end. They stay
                    aligned to the page's start edge (see rtl:text-right below). */}
                <Field label={fieldPhone} type="tel" value={form.phone} onChange={v => setField('phone', v)} required dir="ltr" />
                <Field label={fieldEmail} type="email" value={form.email} onChange={v => setField('email', v)} dir="ltr" />
                <div className="block">
                  {/* A <label> must wrap (or point via htmlFor at) an actual form
                      control -- in the error state there isn't one, so this uses
                      htmlFor/id association instead of wrapping. A dangling
                      htmlFor with no matching id (the error branch) just reads as
                      plain text to assistive tech, unlike wrapping a <button> in
                      a <label>, which would misrepresent it as the field's control. */}
                  <label htmlFor="checkout-region" className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{fieldRegion}</label>
                  {regionsError ? (
                    <div className="flex items-center gap-3 py-2">
                      <p className="text-sm text-terracotta">{t.checkoutRegionsError}</p>
                      <button
                        type="button"
                        onClick={loadShipping}
                        className="text-xs tracking-widest uppercase border-b border-foreground pb-0.5 cursor-pointer shrink-0"
                      >
                        {t.failedTryAgain}
                      </button>
                    </div>
                  ) : (
                    <select
                      id="checkout-region"
                      value={form.regionCode}
                      onChange={e => setField('regionCode', e.target.value)}
                      required
                      disabled={regionsLoading}
                      dir={lang === 'ar' ? 'rtl' : 'ltr'}
                      className="w-full bg-transparent border-b border-foreground/30 focus:border-foreground outline-none py-2 text-sm transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <option value="" disabled>{regionsLoading ? t.checkoutRegionsLoading : t.checkoutSelectRegion}</option>
                      {regions.map(r => (
                        <option key={r.code} value={r.code}>{regionLabel(r, lang)}</option>
                      ))}
                    </select>
                  )}
                </div>
                <div className="sm:col-span-2">
                  <Field label={fieldAddress} value={form.address} onChange={v => setField('address', v)} required dir={lang === 'ar' ? 'rtl' : 'ltr'} />
                </div>
                <Field label={fieldCity} value={form.city} onChange={v => setField('city', v)} required dir={lang === 'ar' ? 'rtl' : 'ltr'} />
                <Field label={fieldNotes} value={form.notes} onChange={v => setField('notes', v)} dir={lang === 'ar' ? 'rtl' : 'ltr'} />
              </div>
            </div>

            <div>
              <p className="text-zen text-muted-foreground mb-3">{t.checkoutStep2}</p>
              <h2 className="font-display text-3xl md:text-4xl mb-2">{t.checkoutPayment}</h2>
              <p className="text-sm text-muted-foreground font-light mb-6">
                {t.checkoutPaymentDesc}
              </p>

              <div className="space-y-3">
                {/* Pay online (Kashier) */}
                {checkoutConfig.online_enabled && (
                <button
                  type="button"
                  onClick={() => setPaymentMethod('online')}
                  aria-pressed={paymentMethod === 'online'}
                  className={`w-full text-start border p-5 transition-colors cursor-pointer ${paymentMethod === 'online' ? 'border-foreground bg-muted/30' : 'border-border hover:border-foreground/40'}`}
                >
                  <div className="flex items-start gap-4">
                    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${paymentMethod === 'online' ? 'border-foreground' : 'border-muted-foreground'}`}>
                      {paymentMethod === 'online' && <span className="w-2 h-2 rounded-full bg-foreground" />}
                    </span>
                    <div className="flex-1">
                      <h3 className="font-display text-lg mb-1 flex items-center gap-2"><CreditCard className="w-4 h-4" /> {t.checkoutPayOnline}</h3>
                      <p className="text-sm text-muted-foreground font-light leading-relaxed">{t.checkoutKashierDesc}</p>
                      <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground tracking-wider">
                        <span className="px-2 py-1 border border-border">VISA</span>
                        <span className="px-2 py-1 border border-border">MASTERCARD</span>
                        <span className="px-2 py-1 border border-border">MEEZA</span>
                        <span className="px-2 py-1 border border-border">FAWRY</span>
                        <span className="px-2 py-1 border border-border">VODAFONE CASH</span>
                      </div>
                    </div>
                  </div>
                </button>
                )}

                {/* Cash on delivery */}
                {checkoutConfig.cash_enabled && (
                <button
                  type="button"
                  onClick={() => setPaymentMethod('cash')}
                  aria-pressed={paymentMethod === 'cash'}
                  className={`w-full text-start border p-5 transition-colors cursor-pointer ${paymentMethod === 'cash' ? 'border-foreground bg-muted/30' : 'border-border hover:border-foreground/40'}`}
                >
                  <div className="flex items-start gap-4">
                    <span className={`mt-0.5 w-4 h-4 rounded-full border-2 shrink-0 flex items-center justify-center ${paymentMethod === 'cash' ? 'border-foreground' : 'border-muted-foreground'}`}>
                      {paymentMethod === 'cash' && <span className="w-2 h-2 rounded-full bg-foreground" />}
                    </span>
                    <div className="flex-1">
                      <h3 className="font-display text-lg mb-1 flex items-center gap-2"><Banknote className="w-4 h-4" /> {t.checkoutCashOnDelivery}</h3>
                      <p className="text-sm text-muted-foreground font-light leading-relaxed">{t.checkoutCashDesc}</p>
                    </div>
                  </div>
                </button>
                )}
              </div>
            </div>

            {hasUnavailable && (
              <div className="border border-terracotta/40 bg-terracotta/5 p-4 text-sm">
                <p className="text-terracotta mb-2">{t.checkoutUnavailable}</p>
                <Link to="/cart" className="text-xs tracking-wider uppercase underline underline-offset-4">
                  {t.checkoutBackToBasket}
                </Link>
              </div>
            )}

            <button
              type="submit"
              // regionsError/regionsLoading: the select is removed from the DOM (or
              // disabled) in those states, so native `required` never gets a chance
              // to fire and the customer would otherwise see "please complete all
              // required fields" while every visible field IS complete -- disabling
              // the button keeps the on-screen region error/loading message as the
              // only explanation, instead of a contradicting toast.
              disabled={submitting || hasUnavailable || regionsLoading || regionsError}
              className="w-full bg-foreground text-background py-4 text-sm tracking-widest uppercase hover:bg-foreground/85 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-2 cursor-pointer"
            >
              {submitting ? t.checkoutPreparing : paymentMethod === 'cash' ? (
                <>
                  <Banknote className="w-4 h-4" />
                  {t.checkoutPlaceOrder(formatPrice(grand))}
                </>
              ) : (
                <>
                  <CreditCard className="w-4 h-4" />
                  {t.checkoutContinue(formatPrice(grand))}
                </>
              )}
            </button>
            <p className="text-[11px] text-muted-foreground text-center">
              {t.checkoutTerms}
            </p>
          </form>

          {/* Summary */}
          <aside className="lg:sticky lg:top-28 h-fit">
            <div className="border border-border p-6 lg:p-8 bg-card">
              <h2 className="font-display text-2xl mb-6">{t.checkoutYourOrder}</h2>
              <div className="space-y-4 mb-6 max-h-80 overflow-y-auto">
                {sellable.map(item => (
                  <div key={`${item.product.id}-${item.size}-${item.color}`} className="flex gap-3">
                    <div className="w-14 h-14 bg-muted overflow-hidden flex-shrink-0 relative">
                      <img src={item.product.image_url || ''} alt="" className="w-full h-full object-cover" />
                      <span className="absolute -top-1 -end-1 w-5 h-5 bg-foreground text-background text-[10px] rounded-full flex items-center justify-center">
                        {item.quantity}
                      </span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{item.product.name}</p>
                      <p className="text-xs text-muted-foreground">{t.cartVariant(item.color, item.size)}</p>
                    </div>
                    <p className="text-sm">{formatPrice(item.unitPrice * item.quantity)}</p>
                  </div>
                ))}
              </div>
              {couponError && (
                <p className="text-xs text-terracotta mb-4">{couponError}</p>
              )}
              <dl className="space-y-2 text-sm border-t border-border pt-4">
                <div className="flex justify-between"><dt className="text-muted-foreground">{t.cartSubtotal}</dt><dd>{formatPrice(totalPrice)}</dd></div>
                {discountAmount > 0 && (
                  <div className="flex justify-between"><dt className="text-muted-foreground">{t.cartDiscount}</dt><dd>−{formatPrice(discountAmount)}</dd></div>
                )}
                <div className="flex justify-between"><dt className="text-muted-foreground">{t.cartShipping}</dt><dd>{!selectedRegion ? '-' : shipping === 0 ? t.cartFree : formatPrice(shipping)}</dd></div>
                <div className="flex justify-between"><dt className="text-muted-foreground">{t.cartTax}</dt><dd>{formatPrice(tax)}</dd></div>
                <div className="pt-3 border-t border-border flex justify-between items-baseline">
                  <dt>{t.cartTotal}</dt>
                  <dd className="font-display text-2xl">{formatPrice(grand)}</dd>
                </div>
              </dl>
            </div>
          </aside>
        </div>
      </div>
    </div>
  )
}

function Field({
  label, value, onChange, type = 'text', required, dir
}: {
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  dir?: 'rtl' | 'ltr'
}) {
  return (
    <label className="block">
      <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">
        {label}
      </span>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        required={required}
        dir={dir}
        // rtl:text-right follows the PAGE direction, not the input's own, so a
        // dir="ltr" field still sits on the start edge of an Arabic form.
        className="w-full bg-transparent border-b border-foreground/30 focus:border-foreground outline-none py-2 text-sm transition-colors rtl:text-right"
      />
    </label>
  )
}
