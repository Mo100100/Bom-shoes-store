import { useT } from '@/contexts/LanguageContext'
import { useWhatsApp, whatsappUrl } from '@/hooks/useWhatsApp'

// "Which order?" is the first thing the owner has to ask on every WhatsApp
// message that arrives from a checkout page, so this one carries the
// reference in the prefilled text.
//
// Renders NOTHING when there is no usable number (see useWhatsApp): the
// alternative is a support link that opens a chat with a stranger.
export default function OrderWhatsAppLink({ reference }: { reference: string }) {
  const t = useT()
  const { phone } = useWhatsApp()
  if (!phone || !reference) return null

  return (
    <a
      href={whatsappUrl(phone, t.orderWhatsAppMessage(reference))}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center justify-center min-h-[44px] px-5 text-sm tracking-wider border border-foreground/30 hover:border-foreground transition-colors"
    >
      {t.orderWhatsAppCta}
    </a>
  )
}
