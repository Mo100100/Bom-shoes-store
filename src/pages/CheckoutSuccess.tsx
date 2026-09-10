import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '@/contexts/AuthContext'
import { useCart } from '@/contexts/CartContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useT } from '@/contexts/LanguageContext'
import { Check, Clock, Loader2 } from 'lucide-react'
import { useSeo } from '@/hooks/useSeo'
import OrderReference from '@/components/OrderReference'
import OrderWhatsAppLink from '@/components/OrderWhatsAppLink'
import { awaitingCash, fetchOrderStatus, outcomeOf, OrderStatus } from '@/lib/orderStatus'

type Outcome = 'checking' | 'confirmed' | 'pending' | 'failed'

export default function CheckoutSuccess() {
  const [params] = useSearchParams()
  const orderId = params.get('orderId') || ''
  const { clearCart } = useCart()
  const { user } = useAuth()
  const { formatPrice } = useCurrency()
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
    const result = await fetchOrderStatus(orderId)
    // A missing reference and an unreachable endpoint both land on 'pending'
    // below, which claims nothing.
    setOrder(result.kind === 'found' ? result.order : null)
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
          {/* Email is optional at checkout, so the promise is only made to
              the customers who actually left an address. */}
          {order?.hasEmail && ` ${t.pendingEmailSoon}`}
        </p>
        {orderId && <div className="mt-6 mb-8 flex justify-center w-full"><OrderReference reference={orderId} /></div>}
        <div className="flex flex-wrap items-center justify-center gap-4 mt-4">
          {/* Without a reference there is nothing to re-check, so the button
              would be inert: only the basket link is offered. */}
          {orderId && (
            <button
              type="button"
              onClick={check}
              className="min-h-[44px] bg-primary text-primary-foreground px-7 text-sm tracking-widest uppercase hover:bg-primary/90 transition-colors cursor-pointer"
            >
              {t.pendingCheckAgain}
            </button>
          )}
          <OrderWhatsAppLink reference={orderId} />
          <Link
            to="/cart"
            className="inline-flex items-center min-h-[44px] text-sm tracking-wider border-b border-foreground/30 hover:border-foreground"
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
      {/* Nothing was paid on a cash order, so it cannot say "payment received". */}
      <p className="text-zen text-muted-foreground mb-4">{isCod ? t.successCodEyebrow : t.successEyebrow}</p>
      <h1 className="font-display text-5xl md:text-7xl mb-6 text-balance">
        {t.successTitle}
      </h1>
      <p className="text-muted-foreground max-w-md font-light mb-2">
        {isCod ? t.successCodDesc : t.successDesc}
        {order?.hasEmail && ` ${t.successEmailSent}`}
      </p>
      {/* The single most useful sentence on a cash order: the amount to have
          ready for the courier. It comes from the server's recorded total,
          never from the basket, which this page has just cleared. */}
      {order && awaitingCash(order) && order.total > 0 && (
        <p className="text-lg mb-2">{t.successCodAmount(formatPrice(order.total))}</p>
      )}
      {orderId && <div className="mt-6 mb-8 flex justify-center w-full"><OrderReference reference={orderId} /></div>}
      <div className="flex flex-wrap items-center justify-center gap-4 mt-4">
        <Link
          to="/shop"
          className="inline-flex items-center min-h-[44px] bg-primary text-primary-foreground px-7 text-sm tracking-widest uppercase hover:bg-primary/90 transition-colors"
        >
          {t.successContinue}
        </Link>
        <OrderWhatsAppLink reference={orderId} />
        {/* Checkout takes no account, so most buyers here are guests and
            /account (behind ProtectedRoute) would bounce them to /login for
            an order that has no user_id anyway. Guests get the lookup page,
            with the reference already in the URL so the page is bookmarkable;
            signed-in customers keep their order history. */}
        {user ? (
          <Link
            to="/account"
            className="inline-flex items-center min-h-[44px] text-sm tracking-wider border-b border-foreground/30 hover:border-foreground"
          >
            {t.successViewOrders}
          </Link>
        ) : orderId && (
          <Link
            to={`/order?ref=${encodeURIComponent(orderId)}`}
            className="inline-flex items-center min-h-[44px] text-sm tracking-wider border-b border-foreground/30 hover:border-foreground"
          >
            {t.orderLookupTrack}
          </Link>
        )}
      </div>
    </div>
  )
}
