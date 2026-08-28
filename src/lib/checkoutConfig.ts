import { supabase } from '@/lib/supabase'

// Config lives in the site_content key/value table (see
// supabase/migrations/20260714000000_checkout_shipping_config.sql):
//   checkout_config -> which payment methods appear at checkout
//   shipping        -> per-governorate delivery price
// Both are public-read, admin-write.

export type CheckoutConfig = { online_enabled: boolean; cash_enabled: boolean }

export type ShippingRegion = {
  code: string
  name_en: string
  name_ar: string
  price: number
}
export type ShippingConfig = { regions: ShippingRegion[] }

export const DEFAULT_CHECKOUT_CONFIG: CheckoutConfig = { online_enabled: true, cash_enabled: true }

// The 27 Egyptian governorates -- single source of truth for the admin's
// "restore all governorates" action (matches the migration seed).
export const EGYPT_GOVERNORATES: ShippingRegion[] = [
  { code: 'cairo', name_en: 'Cairo', name_ar: 'القاهرة', price: 0 },
  { code: 'giza', name_en: 'Giza', name_ar: 'الجيزة', price: 0 },
  { code: 'alexandria', name_en: 'Alexandria', name_ar: 'الإسكندرية', price: 0 },
  { code: 'qalyubia', name_en: 'Qalyubia', name_ar: 'القليوبية', price: 0 },
  { code: 'port_said', name_en: 'Port Said', name_ar: 'بورسعيد', price: 0 },
  { code: 'suez', name_en: 'Suez', name_ar: 'السويس', price: 0 },
  { code: 'dakahlia', name_en: 'Dakahlia', name_ar: 'الدقهلية', price: 0 },
  { code: 'sharqia', name_en: 'Sharqia', name_ar: 'الشرقية', price: 0 },
  { code: 'gharbia', name_en: 'Gharbia', name_ar: 'الغربية', price: 0 },
  { code: 'monufia', name_en: 'Monufia', name_ar: 'المنوفية', price: 0 },
  { code: 'beheira', name_en: 'Beheira', name_ar: 'البحيرة', price: 0 },
  { code: 'kafr_el_sheikh', name_en: 'Kafr El Sheikh', name_ar: 'كفر الشيخ', price: 0 },
  { code: 'damietta', name_en: 'Damietta', name_ar: 'دمياط', price: 0 },
  { code: 'ismailia', name_en: 'Ismailia', name_ar: 'الإسماعيلية', price: 0 },
  { code: 'fayoum', name_en: 'Fayoum', name_ar: 'الفيوم', price: 0 },
  { code: 'beni_suef', name_en: 'Beni Suef', name_ar: 'بني سويف', price: 0 },
  { code: 'minya', name_en: 'Minya', name_ar: 'المنيا', price: 0 },
  { code: 'asyut', name_en: 'Asyut', name_ar: 'أسيوط', price: 0 },
  { code: 'sohag', name_en: 'Sohag', name_ar: 'سوهاج', price: 0 },
  { code: 'qena', name_en: 'Qena', name_ar: 'قنا', price: 0 },
  { code: 'luxor', name_en: 'Luxor', name_ar: 'الأقصر', price: 0 },
  { code: 'aswan', name_en: 'Aswan', name_ar: 'أسوان', price: 0 },
  { code: 'red_sea', name_en: 'Red Sea', name_ar: 'البحر الأحمر', price: 0 },
  { code: 'new_valley', name_en: 'New Valley', name_ar: 'الوادي الجديد', price: 0 },
  { code: 'matrouh', name_en: 'Matrouh', name_ar: 'مطروح', price: 0 },
  { code: 'north_sinai', name_en: 'North Sinai', name_ar: 'شمال سيناء', price: 0 },
  { code: 'south_sinai', name_en: 'South Sinai', name_ar: 'جنوب سيناء', price: 0 },
]

export async function fetchCheckoutConfig(): Promise<CheckoutConfig> {
  const { data } = await supabase
    .from('site_content')
    .select('value')
    .eq('key', 'checkout_config')
    .maybeSingle()
  return { ...DEFAULT_CHECKOUT_CONFIG, ...(data?.value as Partial<CheckoutConfig> | undefined) }
}

// Unlike fetchCheckoutConfig above, a failure here cannot fall back to a safe
// default: the governorate select is required, and an empty region list means
// checkout cannot be completed at all. Throwing lets the caller (Checkout.tsx)
// tell the customer and offer a retry, instead of silently rendering an
// empty, unusable dropdown.
export async function fetchShippingConfig(): Promise<ShippingConfig> {
  const { data, error } = await supabase
    .from('site_content')
    .select('value')
    .eq('key', 'shipping')
    .maybeSingle()
  if (error) throw error
  const regions = (data?.value as ShippingConfig | undefined)?.regions
  return { regions: Array.isArray(regions) ? regions : [] }
}

export function regionLabel(r: ShippingRegion, lang: string): string {
  return lang === 'ar' ? r.name_ar : r.name_en
}
