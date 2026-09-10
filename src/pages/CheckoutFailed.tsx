import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useT } from '@/contexts/LanguageContext'
import { useSeo } from '@/hooks/useSeo'
import OrderReference from '@/components/OrderReference'
import OrderWhatsAppLink from '@/components/OrderWhatsAppLink'
import { fetchCheckoutConfig, CheckoutConfig } from '@/lib/checkoutConfig'

export default function CheckoutFailed() {
  const [params] = useSearchParams()
  const orderId = params.get('orderId') || ''
  const t = useT()

  // Which ways to pay this page may offer comes from the same
  // admin-editable site_content.checkout_config the checkout form reads, so
  // it can never send a customer to a payment method that is switched off.
  // Null until it resolves, and null FOREVER if the read fails: offering
  // nothing is better than offering a method that turns out to be disabled,
  // and a page whose whole job is to undo a dead end must not create another
  // one. fetchCheckoutConfig throws on a failed read now, so the rejection
  // handler below is a live path rather than the dead code it used to be.
  const [config, setConfig] = useState<CheckoutConfig | null>(null)
  useEffect(() => { fetchCheckoutConfig().then(setConfig, () => setConfig(null)) }, [])

  useSeo({ title: `${t.failedTitle} · ${t.brandName}`, description: t.failedDesc })

  return (
    <div className="min-h-[70vh] flex flex-col items-center justify-center px-6 text-center">
      <p className="text-zen text-muted-foreground mb-4">{t.failedEyebrow}</p>
      <h1 className="font-display text-5xl md:text-6xl mb-6 text-balance">
        {t.failedTitle}
      </h1>
      <p className="text-muted-foreground max-w-md font-light mb-4">
        {t.failedDesc}
      </p>
      {/* Cash on delivery is what most customers here prefer anyway, and the
          basket is deliberately kept on a decline, so the offer is the whole
          fix. It cannot preselect the method for them: the payment choice
          lives in Checkout.tsx's own state. */}
      {config?.cash_enabled && (
        <p className="text-muted-foreground max-w-md font-light mb-4">{t.failedPayCashDesc}</p>
      )}
      {orderId && <div className="mt-4 mb-8 flex justify-center w-full"><OrderReference reference={orderId} /></div>}
      <div className="flex flex-wrap items-center justify-center gap-4 mt-4">
        {config?.cash_enabled && (
          <Link
            to="/checkout"
            className="inline-flex items-center min-h-[44px] bg-primary text-primary-foreground px-7 text-sm tracking-widest uppercase hover:bg-primary/90 transition-colors"
          >
            {t.failedPayCash}
          </Link>
        )}
        {/* Only when cards are actually switched on: retrying a payment
            method the store no longer accepts is a dead end. */}
        {config?.online_enabled && (
          <Link
            to="/checkout"
            className={`inline-flex items-center min-h-[44px] px-7 text-sm tracking-widest uppercase transition-colors ${
              config.cash_enabled
                ? 'border border-foreground/30 hover:border-foreground'
                : 'bg-primary text-primary-foreground hover:bg-primary/90'
            }`}
          >
            {t.failedTryAgain}
          </Link>
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
