import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useCart } from '@/contexts/CartContext'
import { useAuth } from '@/contexts/AuthContext'
import { useT, useLanguage } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { supabase, readServerError } from '@/lib/supabase'
import { couponRejectionMessage } from '@/lib/cart'
import { normalizeEgyptPhone } from '@/lib/phone'
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

// The delivery details of the last order placed from THIS browser, so a
// returning customer does not retype an address they already typed.
//
// localStorage rather than reading the customer's last order back from the
// database, because card payment is disabled: every order today is Cash on
// Delivery, most of them from a guest with no account, and an account-only
// answer would help almost nobody while adding a query to the checkout's
// critical path. The privacy trade on a shared phone is real, so: it is only
// what the customer typed on this device, it holds no payment data (there is
// none to hold), notes are excluded because they are the free-text field, and
// the form says the details were restored and offers a one-tap clear. The cart
// itself already persists here, so this is not a new class of stored data.
const SAVED_DETAILS_KEY = 'bom-delivery-details'

type SavedDetails = {
  fullName: string
  phone: string
  address: string
  city: string
  regionCode: string
}

function readSavedDetails(): Partial<SavedDetails> {
  try {
    const raw = localStorage.getItem(SAVED_DETAILS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    // Anything but an object (a hand-edited key, an older shape) is discarded
    // rather than spread into the form.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch { /* unavailable in private mode, or not valid JSON */ }
  return {}
}

function writeSavedDetails(d: SavedDetails) {
  try { localStorage.setItem(SAVED_DETAILS_KEY, JSON.stringify(d)) }
  catch { /* localStorage is unavailable in private mode: nothing is remembered */ }
}

// Every field the customer can be told about by name, in the order they are
// laid out on the page, so the first error is the first one they would reach.
const FIELD_ORDER = ['fullName', 'phone', 'email', 'regionCode', 'address', 'city'] as const
type FieldKey = (typeof FIELD_ORDER)[number]
type FieldErrors = Partial<Record<FieldKey, string>>

export default function Checkout() {
  const { items, totalPrice, clearCart, couponCode } = useCart()
  const { user, profile } = useAuth()
  const navigate = useNavigate()
  const t = useT()
  const { lang } = useLanguage()
  const { formatPrice } = useCurrency()

  useSeo({ title: `${t.checkoutShipping} · ${t.brandName}`, description: t.checkoutPaymentDesc })

  const [submitting, setSubmitting] = useState(false)
  const [saved] = useState(readSavedDetails)
  const [savedRestored, setSavedRestored] = useState(() => Object.keys(saved).length > 0)
  const [form, setForm] = useState(() => ({
    fullName: profile?.full_name || saved.fullName || '',
    email: user?.email || '',
    phone: saved.phone || '',
    address: saved.address || '',
    city: saved.city || '',
    regionCode: saved.regionCode || '',
    notes: '',
  }))
  const [errors, setErrors] = useState<FieldErrors>({})
  const [discountAmount, setDiscountAmount] = useState(0)
  const [couponError, setCouponError] = useState<string | null>(null)
  // Cash on Delivery is the default, and the only method the store accepts
  // today (site_content.checkout_config has online_enabled false). It is also
  // the majority choice in this market when both are on, so it stays the
  // default either way; the effect below only moves off it when cash itself
  // is switched off.
  const [paymentMethod, setPaymentMethod] = useState<'online' | 'cash'>('cash')
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
    fetchCheckoutConfig().then(
      cfg => {
        setCheckoutConfig(cfg)
        // Cash is already the default, so the only move needed is off it, when
        // the admin has switched cash off and left card on. A disabled method
        // must never be the pre-selected one.
        if (cfg.online_enabled && !cfg.cash_enabled) setPaymentMethod('online')
      },
      // fetchCheckoutConfig THROWS on a read error. Unhandled, that left the
      // state at its defaults with nothing selected and the wrong wording on
      // the submit button. Cash is the safe fallback: offering cash the store
      // does not take costs one phone call, offering card it cannot process
      // sends the customer into a payment form that does not exist.
      err => {
        console.error('Checkout: could not read site_content.checkout_config:', err)
        setCheckoutConfig(DEFAULT_CHECKOUT_CONFIG)
        setPaymentMethod('cash')
      },
    )
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
  // supabase/functions/_shared/pricing.ts), including its rounding to
  // piastres: a percentage coupon can land on a half-piastre, and without the
  // same rounding here the page would show a total one piastre off what the
  // customer is actually charged. Shipping is always the selected
  // governorate's price, and a waiver arrives as part of discountAmount
  // rather than by zeroing this. Zeroing it here as well double-counted the
  // waiver, which is why the whole total is reconciled from the preview now
  // and not just the discount line.
  const shipping = selectedRegion?.price ?? 0
  const grand = Math.max(0, Math.round((totalPrice + shipping - discountAmount) * 100) / 100)

  function setField(k: keyof typeof form, v: string) {
    setForm(f => ({ ...f, [k]: v }))
    // Clear this field's error the moment it is being corrected: leaving a red
    // message under a field the customer is actively fixing reads as "still
    // wrong" when it is not.
    setErrors(e => (k in e ? { ...e, [k]: undefined } : e))
  }

  // Phone is required (the courier calls the customer); email is optional but
  // must be usable when given. A governorate must be chosen so shipping can be
  // priced. Each message names its own field, and the caller focuses the first
  // one, so "something is wrong somewhere" never happens again.
  function validate(): FieldErrors {
    const e: FieldErrors = {}
    if (!form.fullName.trim()) e.fullName = t.errNameRequired
    if (!form.phone.trim()) e.phone = t.errPhoneRequired
    else if (!normalizeEgyptPhone(form.phone)) e.phone = t.errPhoneInvalid
    // The form is noValidate (see below), so the type="email" check is ours now.
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) e.email = t.errEmailInvalid
    if (!form.regionCode) e.regionCode = t.errRegionRequired
    if (!form.address.trim()) e.address = t.errAddressRequired
    if (!form.city.trim()) e.city = t.errCityRequired
    return e
  }

  function clearSavedDetails() {
    try { localStorage.removeItem(SAVED_DETAILS_KEY) }
    catch { /* nothing was persisted in the first place */ }
    // Emptying the fields as well: a "cleared" button that leaves the address
    // on screen has not cleared anything the person in front of it can see.
    setForm(f => ({ ...f, fullName: profile?.full_name || '', phone: '', address: '', city: '', regionCode: '' }))
    setSavedRestored(false)
    toast.success(t.checkoutSavedCleared)
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (sellable.length === 0) return
    if (hasUnavailable) {
      toast.error(t.checkoutUnavailable)
      return
    }

    const found = validate()
    setErrors(found)
    const firstKey = FIELD_ORDER.find(k => found[k])
    if (firstKey) {
      // Focus rather than just colour: on a phone the button is far below the
      // offending field, and focusing scrolls it into view, opens the right
      // keyboard, and makes a screen reader read the label, the invalid state
      // and the message (aria-invalid + aria-describedby on the control).
      document.getElementById(`checkout-${firstKey}`)?.focus()
      toast.error(found[firstKey] as string)
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
          // The canonical 01xxxxxxxxx form, not whatever spacing or +20 shape
          // was typed, so the courier and the admin list always read the same
          // number. validate() already proved it normalises.
          phone: normalizeEgyptPhone(form.phone) || form.phone,
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

      // The order exists, so these details are worth keeping for the next one.
      // Written only on a real order, never on every keystroke.
      writeSavedDetails({
        fullName: form.fullName,
        phone: normalizeEgyptPhone(form.phone) || form.phone,
        address: form.address,
        city: form.city,
        regionCode: form.regionCode,
      })

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
          {/* noValidate: the browser's own bubbles cannot say "11 digits
              starting 01", cannot be translated, and vanish before a screen
              reader gets to them. validate() below owns every message, and the
              required attributes stay for the semantics assistive tech reads. */}
          <form onSubmit={handleSubmit} noValidate className="space-y-10">
            <div>
              <p className="text-zen text-muted-foreground mb-3">{t.checkoutStep1}</p>
              <h1 className="font-display text-3xl md:text-4xl mb-8">{t.checkoutShipping}</h1>
              {savedRestored && (
                <div className="flex flex-wrap items-center gap-x-4 mb-6 -mt-4 text-xs text-muted-foreground">
                  <p>{t.checkoutSavedDetails}</p>
                  <button
                    type="button"
                    onClick={clearSavedDetails}
                    className="inline-flex items-center min-h-[44px] tracking-wider underline underline-offset-4 cursor-pointer"
                  >
                    {t.checkoutClearSaved}
                  </button>
                </div>
              )}
              <div className="grid sm:grid-cols-2 gap-4">
                <Field
                  id="checkout-fullName" name="name" autoComplete="name"
                  label={fieldFullName} value={form.fullName} onChange={v => setField('fullName', v)}
                  required dir={lang === 'ar' ? 'rtl' : 'ltr'} error={errors.fullName}
                />
                {/* Phone numbers and email addresses are always read
                    left-to-right, even on an Arabic page: forcing them RTL put
                    the leading + and the domain on the wrong end. They stay
                    aligned to the page's start edge (see rtl:text-right below). */}
                <Field
                  id="checkout-phone" name="tel" autoComplete="tel" type="tel" inputMode="tel"
                  label={fieldPhone} value={form.phone} onChange={v => setField('phone', v)}
                  required dir="ltr" error={errors.phone}
                  placeholder={t.fieldPhonePlaceholder} hint={t.fieldPhoneHint}
                />
                <Field
                  id="checkout-email" name="email" autoComplete="email" type="email" inputMode="email"
                  label={fieldEmail} value={form.email} onChange={v => setField('email', v)}
                  dir="ltr" error={errors.email}
                />
                <div className="block">
                  {/* A <label> must wrap (or point via htmlFor at) an actual form
                      control -- in the error state there isn't one, so this uses
                      htmlFor/id association instead of wrapping. A dangling
                      htmlFor with no matching id (the error branch) just reads as
                      plain text to assistive tech, unlike wrapping a <button> in
                      a <label>, which would misrepresent it as the field's control. */}
                  <label htmlFor="checkout-regionCode" className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{fieldRegion}</label>
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
                      id="checkout-regionCode"
                      name="address-level1"
                      autoComplete="address-level1"
                      value={form.regionCode}
                      onChange={e => setField('regionCode', e.target.value)}
                      required
                      aria-invalid={!!errors.regionCode}
                      aria-describedby={errors.regionCode ? 'checkout-regionCode-error' : undefined}
                      disabled={regionsLoading}
                      dir={lang === 'ar' ? 'rtl' : 'ltr'}
                      className={`w-full bg-transparent border-b ${errors.regionCode ? 'border-terracotta' : 'border-foreground/30'} focus:border-foreground outline-none py-2 text-sm transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed`}
                    >
                      <option value="" disabled>{regionsLoading ? t.checkoutRegionsLoading : t.checkoutSelectRegion}</option>
                      {/* The price rides along in the label, so the control
                          that raises "how much is delivery" answers it in the
                          same glance. A region left at the seed price of 0 is
                          shown bare rather than as free delivery the checkout
                          would not honour (same rule as src/lib/shippingRange.ts). */}
                      {regions.map(r => (
                        <option key={r.code} value={r.code}>
                          {r.price > 0 ? `${regionLabel(r, lang)} · ${formatPrice(r.price)}` : regionLabel(r, lang)}
                        </option>
                      ))}
                    </select>
                  )}
                  {errors.regionCode && (
                    <p id="checkout-regionCode-error" className="mt-1.5 text-xs text-terracotta">{errors.regionCode}</p>
                  )}
                </div>
                <div className="sm:col-span-2">
                  <Field
                    id="checkout-address" name="street-address" autoComplete="street-address"
                    label={fieldAddress} value={form.address} onChange={v => setField('address', v)}
                    required dir={lang === 'ar' ? 'rtl' : 'ltr'} error={errors.address}
                    placeholder={t.fieldAddressPlaceholder}
                  />
                </div>
                <Field
                  id="checkout-city" name="address-level2" autoComplete="address-level2"
                  label={fieldCity} value={form.city} onChange={v => setField('city', v)}
                  required dir={lang === 'ar' ? 'rtl' : 'ltr'} error={errors.city}
                  placeholder={t.fieldCityPlaceholder}
                />
                {/* Delivery notes are per order ("ring the bell twice"), never
                    a saved value, so autofill is explicitly off here. */}
                <Field
                  id="checkout-notes" name="notes" autoComplete="off"
                  label={fieldNotes} value={form.notes} onChange={v => setField('notes', v)}
                  dir={lang === 'ar' ? 'rtl' : 'ltr'}
                />
              </div>
            </div>

            <div>
              <p className="text-zen text-muted-foreground mb-3">{t.checkoutStep2}</p>
              <h2 className="font-display text-3xl md:text-4xl mb-2">{t.checkoutPayment}</h2>
              <p className="text-sm text-muted-foreground font-light mb-6">
                {t.checkoutPaymentDesc}
              </p>

              <div className="space-y-3">
                {/* Cash on delivery, first: it is the only method the store
                    accepts today, and the majority choice in this market when
                    both are on. */}
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
              {t.checkoutTerms}{' '}
              <Link to="/policies" className="border-b border-foreground/40 pb-0.5">{t.checkoutTermsLink}</Link>.
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
  id, label, value, onChange, type = 'text', required, dir,
  name, autoComplete, inputMode, placeholder, hint, error,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  type?: string
  required?: boolean
  dir?: 'rtl' | 'ltr'
  // name and autoComplete are what let a returning customer fill this whole
  // form from their saved contact card in one tap. autoComplete alone is not
  // enough on every browser: some only offer the card when the control is
  // also named.
  name: string
  autoComplete: string
  inputMode?: 'text' | 'tel' | 'email' | 'numeric'
  placeholder?: string
  // Shown while the field is valid, and replaced by the error when it is not:
  // both point at the same control through aria-describedby, so a screen
  // reader reads whichever one is currently true.
  hint?: string
  error?: string
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  // htmlFor/id association rather than wrapping the input in the <label>: the
  // hint and the error live in this block too, and a wrapping label swallows
  // their text into the field's accessible NAME instead of its description.
  return (
    <div className="block">
      <label htmlFor={id} className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">
        {label}
      </label>
      <input
        id={id}
        name={name}
        autoComplete={autoComplete}
        inputMode={inputMode}
        placeholder={placeholder}
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        required={required}
        aria-invalid={!!error}
        aria-describedby={describedBy}
        dir={dir}
        // rtl:text-right follows the PAGE direction, not the input's own, so a
        // dir="ltr" field still sits on the start edge of an Arabic form.
        className={`w-full bg-transparent border-b ${error ? 'border-terracotta' : 'border-foreground/30'} focus:border-foreground outline-none py-2 text-sm transition-colors rtl:text-right`}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-terracotta">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  )
}
