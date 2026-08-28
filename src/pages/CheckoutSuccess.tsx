import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useCart } from '@/contexts/CartContext'
import { useT } from '@/contexts/LanguageContext'
import { supabase } from '@/lib/supabase'
import { Check, Clock, Loader2 } from 'lucide-react'
import { useSeo } from '@/hooks/useSeo'

// Exactly what supabase/functions/order-status returns: the three state
// fields and nothing else (no total, no items, no customer details).
type OrderStatus = {
  status: string
  paymentStatus: string
  paymentMethod: string | null
}

type Outcome = 'checking' | 'confirmed' | 'pending' | 'failed'

// The only place payment_status/status/stock are ever mutated is
// fulfill_order() / place_cod_order(), called from the server -- so the
// server's copy of these two fields is the only truth about whether the
// customer actually paid.
//
// 'pending' is the honest answer for anything not yet resolved, and it is
// also where every unknown lands (see the caller): a webhook still in flight,
// an unreachable endpoint, a missing reference. It claims nothing.
function outcomeOf(s: OrderStatus): Exclude<Outcome, 'checking'> {
  // Paid is tested FIRST, before any failure test. An admin can cancel an
  // already-paid order (AdminOrders.tsx) when stock turns out to be missing
  // after payment, and sending that customer to /checkout/failed would tell
  // them "nothing was charged" about money that left their account.
  if (s.paymentStatus === 'paid') return 'confirmed'
  if (s.paymentStatus === 'failed' || s.status === 'cancelled') return 'failed'
  // Cash on delivery has no payment to wait for: place_cod_order() already
  // confirmed the order and reserved its stock, and payment_status stays
  // 'pending' the whole way through 'confirmed' -> 'processing' -> 'shipped'
  // -> 'delivered', until an admin marks the cash as collected. So any status
  // past 'pending' is a placed order ('cancelled' already returned above).
  if (s.paymentMethod === 'cash' && s.status !== 'pending') return 'confirmed'
  return 'pending'
}

export default function CheckoutSuccess() {
  const [params] = useSearchParams()
  const orderId = params.get('orderId') || ''
  const { clearCart } = useCart()
  const navigate = useNavigate()
  const cleared = useRef(false)
  const t = useT()

  const [checking, setChecking] = useState(!!orderId)
  const [order, setOrder] = useState<OrderStatus | null>(null)

  // Kashier redirects the browser back here for EVERY outcome (it takes a
  // single merchantRedirect URL), and that redirect can arrive before, after,
  // or entirely without the server-to-server webhook that marks an order
  // paid. So this page never assumes: it asks the server what was actually
  // recorded. (This used to render "order confirmed" and clear the basket
  // unconditionally, so a declined card got shown a success page.)
  const check = useCallback(async () => {
    if (!orderId) return
    setChecking(true)
    // functions-js only installs an AbortController when a timeout is passed,
    // and browser fetch has none of its own: without this a stalled request
    // (network handover, a cold start that never returns) leaves the customer
    // on the spinner forever, right after handing over their card details.
    const { data, error } = await supabase.functions.invoke<OrderStatus>('order-status', {
      body: { orderId },
      timeout: 15000,
    })
    setOrder(error ? null : data)
    setChecking(false)
  }, [orderId])

  useEffect(() => { check() }, [check])

  const outcome: Outcome = checking ? 'checking' : order ? outcomeOf(order) : 'pending'

  useEffect(() => {
    if (outcome === 'failed') {
      navigate(`/checkout/failed?orderId=${encodeURIComponent(orderId)}`, { replace: true })
      return
    }
    // The basket is only ever emptied on a confirmed order: a decline or a
    // payment still in flight leaves it untouched so the customer can retry
    // without rebuilding it.
    if (outcome === 'confirmed' && !cleared.current) {
      cleared.current = true
      clearCart()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [outcome])

  const seo = outcome === 'confirmed'
    ? { title: t.successTitle, description: t.successDesc }
    : outcome === 'pending'
      ? { title: t.pendingTitle, description: t.pendingDesc }
      : { title: t.successChecking, description: t.successCheckingDesc }
  useSeo({ title: `${seo.title} · ${t.brandName}`, description: seo.description })

  // 'failed' shows the same quiet placeholder for the single frame before the
  // redirect above lands.
  if (outcome === 'checking' || outcome === 'failed') {
    return (
      <div
        className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center"
        aria-busy="true"
        aria-live="polite"
      >
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground mb-6" />
        <p className="text-zen text-muted-foreground mb-2">{t.successChecking}</p>
        <p className="text-sm text-muted-foreground font-light">{t.successCheckingDesc}</p>
      </div>
    )
  }

  if (outcome === 'pending') {
    return (
      <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center">
        <div className="w-20 h-20 rounded-full border border-foreground/25 flex items-center justify-center mb-8">
          <Clock className="w-9 h-9 text-muted-foreground" strokeWidth={1.5} />
        </div>
        <p className="text-zen text-muted-foreground mb-4">{t.pendingEyebrow}</p>
        <h1 className="font-display text-4xl md:text-6xl mb-6 text-balance">
          {t.pendingTitle}
        </h1>
        <p className="text-muted-foreground max-w-md font-light mb-2">
          {t.pendingDesc}
        </p>
        {orderId && (
          <p className="text-xs text-muted-foreground tracking-widest uppercase mb-10">
            {t.successOrder(orderId)}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-center gap-4 mt-4">
          {/* Without a reference there is nothing to re-check, so the button
              would be inert: only the basket link is offered. */}
          {orderId && (
            <button
              type="button"
              onClick={check}
              className="bg-primary text-primary-foreground px-7 py-3.5 text-sm tracking-widest uppercase hover:bg-primary/90 transition-colors cursor-pointer"
            >
              {t.pendingCheckAgain}
            </button>
          )}
          <Link
            to="/cart"
            className="text-sm tracking-wider border-b border-foreground/30 pb-1 hover:border-foreground"
          >
            {t.failedBack}
          </Link>
        </div>
      </div>
    )
  }

  // From the server's payment_method, never the query string (which is the
  // customer's to edit): which copy they see follows the same truth the
  // outcome above does.
  const isCod = order?.paymentMethod === 'cash'

  return (
    <div className="min-h-[80vh] flex flex-col items-center justify-center px-6 text-center">
      <div className="w-20 h-20 rounded-full bg-foreground text-background flex items-center justify-center mb-8">
        <Check className="w-9 h-9" strokeWidth={1.5} />
      </div>
      <p className="text-zen text-muted-foreground mb-4">{t.successEyebrow}</p>
      <h1 className="font-display text-5xl md:text-7xl mb-6 text-balance">
        {t.successTitle}
      </h1>
      <p className="text-muted-foreground max-w-md font-light mb-2">
        {isCod ? t.successCodDesc : t.successDesc}
      </p>
      {orderId && (
        <p className="text-xs text-muted-foreground tracking-widest uppercase mb-10">
          {t.successOrder(orderId)}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-4 mt-4">
        <Link
          to="/shop"
          className="bg-primary text-primary-foreground px-7 py-3.5 text-sm tracking-widest uppercase hover:bg-primary/90 transition-colors"
        >
          {t.successContinue}
        </Link>
        <Link
          to="/account"
          className="text-sm tracking-wider border-b border-foreground/30 pb-1 hover:border-foreground"
        >
          {t.successViewOrders}
        </Link>
      </div>
    </div>
  )
}
