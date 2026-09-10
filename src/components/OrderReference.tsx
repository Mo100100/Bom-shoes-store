import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { useT } from '@/contexts/LanguageContext'

// The order reference is the customer's ONLY record of a guest purchase: it
// is what the lookup page takes, what the store searches by, and what a
// WhatsApp message has to quote. It used to render as the smallest, faintest
// line on the page, inside a mixed Arabic/Latin sentence, with no way to copy
// it. This is that block done properly.
//
// The reference itself is always Latin (BOM-<millis>-<8 hex>), so it gets
// .latin-text (keeps its letter-spacing on the Arabic store, and isolates the
// bidi run) and its own dir="ltr", which is only possible because it is now
// its own element rather than half of a translated sentence.
export default function OrderReference({ reference }: { reference: string }) {
  const t = useT()
  const [copied, setCopied] = useState<'idle' | 'done' | 'failed'>('idle')

  useEffect(() => {
    if (copied === 'idle') return
    const timer = setTimeout(() => setCopied('idle'), 4000)
    return () => clearTimeout(timer)
  }, [copied])

  async function copy() {
    try {
      // Undefined outside a secure context, and it can reject even inside one
      // (permissions, an unfocused document), so both cases fall through to
      // the same honest message rather than a button that does nothing.
      await navigator.clipboard.writeText(reference)
      setCopied('done')
    } catch {
      setCopied('failed')
    }
  }

  return (
    <div className="w-full max-w-md border border-border bg-card p-4 text-start">
      <p className="text-[11px] tracking-widest uppercase text-muted-foreground mb-2">
        {t.orderRefLabel}
      </p>
      <div className="flex items-center gap-3">
        <span dir="ltr" className="latin-text flex-1 font-mono text-base md:text-lg tracking-wider break-all">
          {reference}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label={t.orderRefCopy}
          className="shrink-0 min-w-[44px] min-h-[44px] flex items-center justify-center border border-border hover:border-foreground transition-colors cursor-pointer"
        >
          {copied === 'done'
            ? <Check className="w-4 h-4" strokeWidth={1.5} />
            : <Copy className="w-4 h-4" strokeWidth={1.5} />}
        </button>
      </div>
      <p className="mt-3 text-xs text-muted-foreground font-light leading-relaxed" aria-live="polite">
        {copied === 'done' ? t.orderRefCopied : copied === 'failed' ? t.orderRefCopyFailed : t.orderRefKeep}
      </p>
    </div>
  )
}
