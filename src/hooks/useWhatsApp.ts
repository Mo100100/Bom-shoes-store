import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { normalizeWhatsAppPhone, PLACEHOLDER_PHONE } from '@/lib/whatsappPhone'

// The store's WhatsApp details live in the admin-editable `site_content` row
// (key = 'whatsapp'), same key/value table as checkout_config and shipping.
export type WhatsAppContent = {
  /** null whenever there is no number worth linking to; see PLACEHOLDER_PHONE. */
  phone: string | null
  messageEn: string
  messageAr: string
}

const DEFAULT_MESSAGE_EN = 'Hello BOM Store, I would like to ask about your shoes.'
const DEFAULT_MESSAGE_AR = 'مرحبا BOM Store، أرغب في الاستفسار عن أحذيتكم.'

const EMPTY: WhatsAppContent = { phone: null, messageEn: DEFAULT_MESSAGE_EN, messageAr: DEFAULT_MESSAGE_AR }

// One read per page load, not one per component: the floating button is in
// the layout on every page and the order pages ask for the same row.
let inFlight: Promise<WhatsAppContent> | null = null

// Throws on a failed read, so loadWhatsApp below can tell that apart from a
// row that simply has no number in it. `error` was previously ignored, which
// made the two identical.
async function read(): Promise<WhatsAppContent> {
  const { data, error } = await supabase
    .from('site_content')
    .select('value')
    .eq('key', 'whatsapp')
    .maybeSingle()
  if (error) throw error
  const value = (data?.value ?? {}) as Record<string, unknown>
  // Normalised before the placeholder comparison, so the seeded number is
  // caught however it is spelled, and so a number the owner DOES set is
  // rejected when it is not dialable rather than rendered as a dead link.
  const phone = normalizeWhatsAppPhone(value.phone)
  return {
    phone: phone && phone !== PLACEHOLDER_PHONE ? phone : null,
    messageEn: (value.message_en as string) || DEFAULT_MESSAGE_EN,
    messageAr: (value.message_ar as string) || DEFAULT_MESSAGE_AR,
  }
}

function loadWhatsApp(): Promise<WhatsAppContent> {
  if (!inFlight) {
    inFlight = read().catch(err => {
      // Clear the cache so a later mount retries. Without this one transient
      // blip on first load removes WhatsApp from every page for the rest of
      // the session, and an owner who sets a real number stays invisible to
      // open tabs until someone reloads.
      inFlight = null
      console.error('useWhatsApp: could not read site_content.whatsapp:', err)
      // A failed read is still not a licence to invent a number: no phone, no
      // WhatsApp action. The customer keeps the store's other contact routes
      // in the footer.
      return EMPTY
    })
  }
  return inFlight
}

export function useWhatsApp(): WhatsAppContent {
  const [content, setContent] = useState<WhatsAppContent>(EMPTY)
  useEffect(() => {
    let live = true
    loadWhatsApp().then(next => { if (live) setContent(next) })
    return () => { live = false }
  }, [])
  return content
}

export function whatsappUrl(phone: string, message: string): string {
  return `https://wa.me/${phone}?text=${encodeURIComponent(message)}`
}
