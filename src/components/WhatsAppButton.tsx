import { useState } from 'react'
import { useLanguage, useT } from '@/contexts/LanguageContext'
import { useWhatsApp, whatsappUrl } from '@/hooks/useWhatsApp'

/**
 * Floating WhatsApp button that opens a chat with the store.
 * The number and the prefilled message come from the admin-editable
 * `site_content` row (key = 'whatsapp'); see useWhatsApp.
 */
export default function WhatsAppButton() {
  const { lang } = useLanguage()
  const t = useT()
  const [showTooltip, setShowTooltip] = useState(false)
  const { phone, messageEn, messageAr } = useWhatsApp()

  // No usable number (unset, or still the seeded placeholder) means no
  // button. A green button that opens a chat with a stranger looks like a
  // working support channel and is not one.
  if (!phone) return null

  const url = whatsappUrl(phone, lang === 'ar' ? messageAr : messageEn)
  const label = t.whatsappChat

  return (
    <div className="fixed bottom-6 end-6 z-40 flex flex-col items-end gap-3" dir="ltr">
      {showTooltip && (
        <div
          className="bg-foreground text-background text-sm px-4 py-2.5 rounded-full shadow-lg whitespace-nowrap animate-fade-in"
          style={{ animation: 'fadeUp 250ms ease-out both' }}
        >
          {label}
        </div>
      )}
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        onClick={() => setShowTooltip(false)}
        aria-label={label}
        className="group relative w-14 h-14 md:w-16 md:h-16 rounded-full bg-[#25D366] hover:bg-[#1FB958] text-white shadow-2xl flex items-center justify-center transition-all duration-300 hover:scale-110 cursor-pointer"
        style={{
          boxShadow: '0 8px 24px rgba(37, 211, 102, 0.45), 0 0 0 0 rgba(37, 211, 102, 0.4)',
          animation: 'pulseRing 2.5s ease-out infinite',
        }}
      >
        <svg
          viewBox="0 0 32 32"
          className="w-7 h-7 md:w-8 md:h-8 fill-white"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M16.001 3C9.373 3 4 8.373 4 15c0 2.385.696 4.605 1.896 6.479L4 29l7.737-1.852A11.94 11.94 0 0 0 16.001 27C22.629 27 28 21.627 28 15S22.629 3 16.001 3zm0 21.998a9.97 9.97 0 0 1-5.082-1.387l-.364-.216-4.595 1.1 1.117-4.477-.237-.376A9.966 9.966 0 0 1 6.002 15c0-5.514 4.485-9.999 9.999-9.999 5.514 0 9.999 4.485 9.999 9.999s-4.485 9.998-9.999 9.998zm5.471-7.501c-.3-.15-1.775-.875-2.05-.975-.275-.1-.475-.15-.675.15-.2.3-.775.975-.95 1.175-.175.2-.35.225-.65.075-.3-.15-1.267-.467-2.413-1.487-.892-.795-1.494-1.777-1.669-2.077-.175-.3-.019-.462.131-.612.135-.135.3-.35.45-.525.15-.175.2-.3.3-.5.1-.2.05-.375-.025-.525-.075-.15-.675-1.625-.925-2.225-.243-.583-.49-.503-.675-.513l-.575-.01c-.2 0-.525.075-.8.375-.275.3-1.05 1.025-1.05 2.5s1.075 2.9 1.225 3.1c.15.2 2.115 3.231 5.125 4.531.717.31 1.276.495 1.713.633.72.229 1.375.196 1.894.119.578-.086 1.775-.725 2.025-1.425.25-.7.25-1.3.175-1.425-.075-.125-.275-.2-.575-.35z"/>
        </svg>
      </a>
    </div>
  )
}
