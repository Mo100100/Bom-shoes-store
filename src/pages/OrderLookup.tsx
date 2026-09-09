import { useCallback, useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Loader2 } from 'lucide-react'
import { useT } from '@/contexts/LanguageContext'
import { useCurrency } from '@/contexts/CurrencyContext'
import { useSeo } from '@/hooks/useSeo'
import LoadErrorPanel from '@/components/LoadErrorPanel'
import OrderReference from '@/components/OrderReference'
import OrderWhatsAppLink from '@/components/OrderWhatsAppLink'
import { awaitingCash, fetchOrderStatus, orderStatusLabel, outcomeOf, OrderStatus, OrderStatusResult } from '@/lib/orderStatus'

// The 8-hex suffix is generated UPPERCASE (create-order) and
// kashier_order_id is plain text, so the function's `eq` is case sensitive.
// autoCapitalize="characters" only reaches virtual keyboards: a customer
// typing on a laptop, or pasting a reference a chat app has lowercased, would
// otherwise be told a perfectly valid reference does not exist. The BOM-
// prefix and the millisecond timestamp are unaffected by uppercasing, so this
// is safe on the whole string. Applied to the URL too, not just the field:
// the ?ref= a customer pastes out of a message is the same input.
function canonical(raw: string): string {
  return raw.trim().toUpperCase()
}

// Where a GUEST checks an order. Checkout does not require an account, so
// /account (behind ProtectedRoute) is not an answer for most buyers: it
// bounces them to /login for an order that has no user_id to find anyway.
//
// The order reference is the only capability here, exactly as it already is
// on the checkout return page: this page calls the same read-only
// order-status function, which is rate limited per IP and answers with the
// state of one order and nothing that identifies a person. Enumeration is not
// the risk the page adds: a reference is a millisecond timestamp plus 32 bits
// of entropy, so even pinning the day of purchase leaves roughly 10^17
// candidates against a ceiling of 120 attempts per 10 minutes per IP.
export default function OrderLookup() {
  const t = useT()
  const [params, setParams] = useSearchParams()
  // The URL is the source of truth so the page is bookmarkable and the back
  // button works. The success page links here with ?ref= already filled in.
  const queried = canonical(params.get('ref') || '')
  const [input, setInput] = useState(queried)
  const [result, setResult] = useState<OrderStatusResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [emptyError, setEmptyError] = useState(false)

  useSeo({
    title: `${t.orderLookupTitle} · ${t.brandName}`,
    description: t.orderLookupDesc,
    // The URL carries an order reference. Nothing here belongs in a search index.
    noindex: true,
  })

  const run = useCallback(async (reference: string) => {
    // Pressing Back off a result lands here with an empty ?ref=. Returning
    // without clearing would leave the previous order's status on screen and
    // draw an empty bordered OrderReference block with a copy button that
    // copies nothing.
    if (!reference) {
      setResult(null)
      setLoading(false)
      return
    }
    setLoading(true)
    setResult(await fetchOrderStatus(reference))
    setLoading(false)
  }, [])

  useEffect(() => { run(queried) }, [queried, run])

  function submit(e: React.FormEvent) {
    e.preventDefault()
    const reference = canonical(input)
    if (!reference) {
      setEmptyError(true)
      return
    }
    setEmptyError(false)
    // Re-submitting the SAME reference leaves the URL unchanged, so the
    // effect above would never fire: run it directly instead.
    if (reference === queried) run(reference)
    else setParams({ ref: reference })
  }

  return (
    <div className="min-h-[70vh] max-w-lg mx-auto px-6 py-16 md:py-24">
      <h1 className="font-display text-4xl md:text-5xl mb-4 text-balance">{t.orderLookupTitle}</h1>
      <p className="text-muted-foreground font-light mb-8">{t.orderLookupDesc}</p>

      <form onSubmit={submit} className="mb-10">
        <label htmlFor="order-ref" className="block text-[11px] tracking-widest uppercase text-muted-foreground mb-2">
          {t.orderRefLabel}
        </label>
        <div className="flex flex-col sm:flex-row gap-3">
          {/* dir="ltr" and .latin-text: the reference is always Latin, and on
              the Arabic store an RTL field puts the caret and the BOM- prefix
              on the wrong side of what the customer is pasting. text-base is
              16px, below which iOS zooms on focus and never zooms back. */}
          <input
            id="order-ref"
            name="orderReference"
            dir="ltr"
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            value={input}
            onChange={e => { setInput(e.target.value); setEmptyError(false) }}
            placeholder={t.orderLookupPlaceholder}
            aria-invalid={emptyError || undefined}
            aria-describedby={emptyError ? 'order-ref-error' : undefined}
            className="latin-text flex-1 min-h-[44px] border border-border bg-background px-3 py-2.5 text-base font-mono tracking-wider outline-none focus:border-foreground transition-colors"
          />
          <button
            type="submit"
            className="min-h-[44px] bg-primary text-primary-foreground px-6 text-sm tracking-widest uppercase hover:bg-primary/90 transition-colors cursor-pointer"
          >
            {t.orderLookupSubmit}
          </button>
        </div>
        {emptyError && (
          <p id="order-ref-error" className="mt-2 text-sm text-terracotta">{t.orderLookupEmpty}</p>
        )}
      </form>

      {loading && (
        <div className="flex items-center gap-3 text-muted-foreground" aria-busy="true" aria-live="polite">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">{t.successChecking}</span>
        </div>
      )}

      {/* A read that FAILED and a reference that does not exist are different
          answers and must never draw the same panel. */}
      {!loading && result?.kind === 'error' && <LoadErrorPanel onRetry={() => run(queried)} message={t.storeLoadError} />}

      {/* Deliberately NOT LoadErrorPanel: its answer is a retry button, and
          retrying is the one thing that makes a throttled shopper's situation
          worse. Waiting is the whole instruction. */}
      {!loading && result?.kind === 'rate_limited' && (
        <div className="border border-border p-6">
          <p className="text-muted-foreground font-light">{t.orderLookupTooMany}</p>
        </div>
      )}

      {!loading && result?.kind === 'not_found' && (
        <div className="border border-border p-6">
          <p className="text-muted-foreground font-light">{t.orderLookupNotFound}</p>
        </div>
      )}

      {!loading && result?.kind === 'found' && (
        <Result order={result.order} reference={queried} />
      )}
    </div>
  )
}

function Result({ order, reference }: { order: OrderStatus; reference: string }) {
  const t = useT()
  const { formatPrice } = useCurrency()
  const outcome = outcomeOf(order)

  return (
    <div className="flex flex-col gap-6">
      <OrderReference reference={reference} />
      <div>
        <p className="text-lg font-light mb-3">
          {outcome === 'confirmed'
            ? t.orderLookupConfirmed
            : outcome === 'failed'
              ? t.orderLookupFailed
              : t.orderLookupPending}
        </p>
        {outcome !== 'failed' && (
          <>
            <p className="text-[11px] tracking-widest uppercase text-muted-foreground">{t.orderLookupStatusLabel}</p>
            <p className="text-base">{orderStatusLabel(order.status, t)}</p>
          </>
        )}
        {awaitingCash(order) && order.total > 0 && (
          <p className="mt-3 text-sm">{t.successCodAmount(formatPrice(order.total))}</p>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <OrderWhatsAppLink reference={reference} />
        <Link
          to="/shop"
          className="inline-flex items-center min-h-[44px] text-sm tracking-wider border-b border-foreground/30 hover:border-foreground"
        >
          {t.successContinue}
        </Link>
      </div>
    </div>
  )
}
