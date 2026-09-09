import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

// The store's WhatsApp details live in the admin-editable `site_content` row
// (key = 'whatsapp'), same key/value table as checkout_config and shipping.
export type WhatsAppContent = {
  /** null whenever there is no number worth linking to; see PLACEHOLDER_PHONE. */
  phone: string | null
  messageEn: string
  messageAr: string
}

// The value the migration seeds the row with. It is not a real number: a link
// built from it opens a chat with a stranger, which is worse than no link at
// all, so it is treated exactly like an unset number and every WhatsApp
// action disappears until the owner sets a real one. Do NOT replace this with
// a guess -- the fix is an admin edit, not a code change.
const PLACEHOLDER_PHONE = '201234567890'

const DEFAULT_MESSAGE_EN = 'Hello BOM Store, I would like to ask about your shoes.'
const DEFAULT_MESSAGE_AR = 'مرحبا BOM Store، أرغب في الاستفسار عن أحذيتكم.'

const EMPTY: WhatsAppContent = { phone: null, messageEn: DEFAULT_MESSAGE_EN, messageAr: DEFAULT_MESSAGE_AR }

/** Digits only, which is the form wa.me takes and the form we compare in. */
function digits(phone: unknown): string {
  return typeof phone === 'string' ? phone.replace(/\D/g, '') : ''
}

// One read per page load, not one per component: the floating button is in
// the layout on every page and the order pages ask for the same row.
let inFlight: Promise<WhatsAppContent> | null = null

async function read(): Promise<WhatsAppContent> {
  try {
    const { data } = await supabase
      .from('site_content')
      .select('value')
      .eq('key', 'whatsapp')
      .maybeSingle()
    const value = (data?.value ?? {}) as Record<string, unknown>
    const phone = digits(value.phone)
    return {
      phone: phone && phone !== PLACEHOLDER_PHONE ? phone : null,
      messageEn: (value.message_en as string) || DEFAULT_MESSAGE_EN,
      messageAr: (value.message_ar as string) || DEFAULT_MESSAGE_AR,
    }
  } catch {
    // A failed read is not a licence to invent a number: no phone, no
    // WhatsApp action. The customer keeps the store's other contact routes
    // in the footer.
    return EMPTY
  }
}

function loadWhatsApp(): Promise<WhatsAppContent> {
  if (!inFlight) inFlight = read()
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
