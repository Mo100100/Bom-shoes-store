import { useEffect, useState } from 'react'
import { supabase, StoreSettings } from '@/lib/supabase'
import { useCategories } from '@/contexts/CategoriesContext'
import { useBrands } from '@/contexts/BrandsContext'
import { compressImage } from '@/lib/compressImage'
import {
  DEFAULT_CHECKOUT_CONFIG, EGYPT_GOVERNORATES,
  type CheckoutConfig, type ShippingRegion,
} from '@/lib/checkoutConfig'
import { useT } from '@/contexts/LanguageContext'
import { Loader2, Plus, Trash2, ArrowUp, ArrowDown, X } from 'lucide-react'
import { toast } from 'sonner'

type Translations = ReturnType<typeof useT>

// Singleton row id -- see supabase/migrations/20260704008000_store_settings_realtime.sql.
// Always read/write this exact id; never a bare insert.
const STORE_SETTINGS_ID = '00000000-0000-0000-0000-000000000001'

type UploadField = 'logo_url' | 'favicon_url'
type SettingsState = Pick<StoreSettings, 'logo_url' | 'favicon_url'>

type WhatsAppContent = { phone: string; message_en: string; message_ar: string }
type ContactContentState = {
  email: string
  phone: string
  address_en: string
  address_ar: string
  map_url: string
  social_instagram: string
  social_facebook: string
  social_tiktok: string
  social_twitter: string
}

const EMPTY_WHATSAPP: WhatsAppContent = { phone: '', message_en: '', message_ar: '' }
const EMPTY_CONTACT: ContactContentState = {
  email: '', phone: '', address_en: '', address_ar: '', map_url: '',
  social_instagram: '', social_facebook: '', social_tiktok: '', social_twitter: '',
}

export default function AdminSettings() {
  const [settings, setSettings] = useState<SettingsState | null>(null)
  const [loading, setLoading] = useState(true)
  const [uploadingLogo, setUploadingLogo] = useState(false)
  const [uploadingFavicon, setUploadingFavicon] = useState(false)
  const [whatsapp, setWhatsapp] = useState<WhatsAppContent>(EMPTY_WHATSAPP)
  const [contact, setContact] = useState<ContactContentState>(EMPTY_CONTACT)
  const [savingWhatsapp, setSavingWhatsapp] = useState(false)
  const [savingContact, setSavingContact] = useState(false)
  const { categories, reload: reloadCategories } = useCategories()
  const [newLabelEn, setNewLabelEn] = useState('')
  const [newLabelAr, setNewLabelAr] = useState('')
  const [savingCategory, setSavingCategory] = useState(false)
  const { brands, reload: reloadBrands } = useBrands()
  const [newBrandName, setNewBrandName] = useState('')
  const [savingBrand, setSavingBrand] = useState(false)
  // brand `value` whose logo is currently uploading (null = none)
  const [uploadingBrandLogo, setUploadingBrandLogo] = useState<string | null>(null)
  const [checkoutConfig, setCheckoutConfig] = useState<CheckoutConfig>(DEFAULT_CHECKOUT_CONFIG)
  const [savingCheckout, setSavingCheckout] = useState(false)
  const [brandsPageEnabled, setBrandsPageEnabled] = useState(true)
  const [savingVisibility, setSavingVisibility] = useState(false)
  const [regions, setRegions] = useState<ShippingRegion[]>([])
  const [savingShipping, setSavingShipping] = useState(false)
  const t = useT()

  async function load() {
    setLoading(true)
    const { data } = await supabase
      .from('store_settings')
      .select('logo_url, favicon_url')
      .eq('id', STORE_SETTINGS_ID)
      .maybeSingle()
    setSettings(data || { logo_url: null, favicon_url: null })

    const { data: content } = await supabase
      .from('site_content')
      .select('key, value')
      .in('key', ['whatsapp', 'contact', 'checkout_config', 'shipping', 'site_visibility'])
    for (const row of content || []) {
      if (row.key === 'whatsapp') setWhatsapp({ ...EMPTY_WHATSAPP, ...row.value })
      if (row.key === 'checkout_config') setCheckoutConfig({ ...DEFAULT_CHECKOUT_CONFIG, ...row.value })
      if (row.key === 'site_visibility') setBrandsPageEnabled((row.value as { brands_page_enabled?: boolean })?.brands_page_enabled !== false)
      if (row.key === 'shipping') {
        const rs = (row.value as { regions?: ShippingRegion[] })?.regions
        setRegions(Array.isArray(rs) ? rs : [])
      }
      if (row.key === 'contact') {
        const v = row.value as Record<string, string | null>
        setContact({
          email: v.email || '', phone: v.phone || '',
          address_en: v.address_en || '', address_ar: v.address_ar || '',
          map_url: v.map_url || '',
          social_instagram: v.social_instagram || '', social_facebook: v.social_facebook || '',
          social_tiktok: v.social_tiktok || '', social_twitter: v.social_twitter || '',
        })
      }
    }
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function handleSaveWhatsapp() {
    setSavingWhatsapp(true)
    const { error } = await supabase
      .from('site_content')
      .update({ value: whatsapp })
      .eq('key', 'whatsapp')
    setSavingWhatsapp(false)
    if (error) { toast.error(error.message || t.adminSaveFailed); return }
    toast.success(t.adminSaved)
  }

  async function handleSaveContact() {
    setSavingContact(true)
    // Store nulls, not empty strings, for fields the admin left blank -- the
    // storefront footer treats "" and null the same, but null is the honest
    // representation of "not set" the migration seeded.
    const value = Object.fromEntries(
      Object.entries(contact).map(([k, v]) => [k, v || null])
    )
    const { error } = await supabase
      .from('site_content')
      .update({ value })
      .eq('key', 'contact')
    setSavingContact(false)
    if (error) { toast.error(error.message || t.adminSaveFailed); return }
    toast.success(t.adminSaved)
  }

  async function handleUpload(field: UploadField, raw: File | undefined, setUploading: (v: boolean) => void) {
    if (!raw) return
    setUploading(true)
    try {
      const prefix = field === 'logo_url' ? 'logo' : 'favicon'
      // Compress the logo; leave the favicon untouched (it must stay tiny/native).
      const file = field === 'logo_url' ? await compressImage(raw, { maxDim: 600 }) : raw
      const path = `${prefix}/${Date.now()}-${file.name}`
      const { error: upErr } = await supabase.storage.from('store-assets').upload(path, file)
      if (upErr) throw upErr
      const { data: pub } = supabase.storage.from('store-assets').getPublicUrl(path)
      // UPDATE, not upsert: store_settings is a migration-seeded singleton with
      // an admin-only UPDATE policy and NO insert policy (a check constraint
      // makes the one row the only possible row). An upsert issues INSERT ... ON
      // CONFLICT, whose INSERT arm the missing insert policy rejects with an RLS
      // violation even though the row already exists -- so update the seeded row.
      const { error: dbErr } = await supabase
        .from('store_settings')
        .update({ [field]: pub.publicUrl })
        .eq('id', STORE_SETTINGS_ID)
      if (dbErr) throw dbErr
      setSettings(prev => ({ ...(prev || { logo_url: null, favicon_url: null }), [field]: pub.publicUrl }))
      toast.success(t.adminSaved)
    } catch (e: any) {
      toast.error(e.message || t.adminUploadFailed)
    } finally {
      setUploading(false)
    }
  }

  // ----- Payment methods shown at checkout -----
  async function handleToggleCheckout(patch: Partial<CheckoutConfig>) {
    const next = { ...checkoutConfig, ...patch }
    // Guard: at least one method must stay enabled, else no one can check out.
    if (!next.online_enabled && !next.cash_enabled) {
      toast.error(t.adminAtLeastOnePayment)
      return
    }
    setCheckoutConfig(next)
    setSavingCheckout(true)
    const { error } = await supabase.from('site_content').update({ value: next }).eq('key', 'checkout_config')
    setSavingCheckout(false)
    if (error) { toast.error(error.message || t.adminSaveFailed); return }
    toast.success(t.adminSaved)
  }

  // ----- Brands page visibility (nav link + /brands page) -----
  async function handleToggleBrandsPage(enabled: boolean) {
    setBrandsPageEnabled(enabled)
    setSavingVisibility(true)
    const { error } = await supabase
      .from('site_content')
      .update({ value: { brands_page_enabled: enabled } })
      .eq('key', 'site_visibility')
    setSavingVisibility(false)
    if (error) { toast.error(error.message || t.adminSaveFailed); return }
    toast.success(t.adminSaved)
  }

  // ----- Shipping price per governorate -----
  async function saveRegions(next: ShippingRegion[]) {
    setRegions(next)
    setSavingShipping(true)
    const { error } = await supabase.from('site_content').update({ value: { regions: next } }).eq('key', 'shipping')
    setSavingShipping(false)
    if (error) { toast.error(error.message || t.adminSaveFailed); return }
    toast.success(t.adminSaved)
  }
  function handleRegionPrice(code: string, price: number) {
    saveRegions(regions.map(r => r.code === code ? { ...r, price: Math.max(0, price) } : r))
  }
  function handleRemoveRegion(code: string) {
    saveRegions(regions.filter(r => r.code !== code))
  }
  function handleRestoreGovernorates() {
    // Add any of the 27 that are missing (keeps existing prices for ones present).
    const have = new Set(regions.map(r => r.code))
    const merged = [...regions, ...EGYPT_GOVERNORATES.filter(g => !have.has(g.code))]
    saveRegions(merged)
  }

  async function handleAddCategory() {
    const label_en = newLabelEn.trim()
    const label_ar = newLabelAr.trim()
    if (!label_en || !label_ar) { toast.error(t.adminBothNamesRequired); return }
    setSavingCategory(true)
    const position = categories.length ? Math.max(...categories.map(c => c.position)) + 1 : 0
    const { error } = await supabase
      .from('categories')
      .insert({ value: label_en, label_en, label_ar, position })
    setSavingCategory(false)
    if (error) { toast.error(error.message || t.adminCouldNotAddCategory); return }
    setNewLabelEn('')
    setNewLabelAr('')
    toast.success(t.adminCategoryAdded)
    reloadCategories()
  }

  async function handleUpdateCategoryLabel(value: string, field: 'label_en' | 'label_ar', text: string) {
    const { error } = await supabase.from('categories').update({ [field]: text }).eq('value', value)
    if (error) { toast.error(error.message || t.adminSaveFailed); return }
    reloadCategories()
  }

  async function handleDeleteCategory(value: string) {
    if (!confirm(t.adminDeleteConfirm(value))) return
    // ponytail: a simple existence check, not a foreign key -- products.category
    // has always been free text, so this is the same protection an FK ON DELETE
    // RESTRICT would give without a schema change.
    const { count } = await supabase
      .from('products')
      .select('id', { count: 'exact', head: true })
      .eq('category', value)
    if (count) { toast.error(t.adminCategoryInUse(count)); return }
    const { error } = await supabase.from('categories').delete().eq('value', value)
    if (error) { toast.error(error.message || t.adminDeleteFailed); return }
    toast.success(t.adminCategoryDeleted)
    reloadCategories()
  }

  async function handleMoveCategory(index: number, direction: -1 | 1) {
    const target = categories[index + direction]
    const current = categories[index]
    if (!target) return
    await Promise.all([
      supabase.from('categories').update({ position: target.position }).eq('value', current.value),
      supabase.from('categories').update({ position: current.position }).eq('value', target.value),
    ])
    reloadCategories()
  }

  // ----- Brands (mirror of categories, plus a logo upload per brand) -----
  async function handleAddBrand() {
    const name = newBrandName.trim()
    if (!name) { toast.error(t.adminBrandNameRequired); return }
    setSavingBrand(true)
    const position = brands.length ? Math.max(...brands.map(b => b.position)) + 1 : 0
    // value == name (same convention categories use); products.brand stores it.
    const { error } = await supabase.from('brands').insert({ value: name, name, position })
    setSavingBrand(false)
    if (error) { toast.error(error.message || t.adminCouldNotAddBrand); return }
    setNewBrandName('')
    toast.success(t.adminBrandAdded)
    reloadBrands()
  }

  async function handleUpdateBrandName(value: string, name: string) {
    const { error } = await supabase.from('brands').update({ name }).eq('value', value)
    if (error) { toast.error(error.message || t.adminSaveFailed); return }
    reloadBrands()
  }

  async function handleDeleteBrand(value: string) {
    if (!confirm(t.adminDeleteConfirm(value))) return
    // Same free-text guard categories use -- products.brand isn't an FK.
    const { count } = await supabase
      .from('products').select('id', { count: 'exact', head: true }).eq('brand', value)
    if (count) { toast.error(t.adminBrandInUse(count)); return }
    const { error } = await supabase.from('brands').delete().eq('value', value)
    if (error) { toast.error(error.message || t.adminDeleteFailed); return }
    toast.success(t.adminBrandDeleted)
    reloadBrands()
  }

  async function handleMoveBrand(index: number, direction: -1 | 1) {
    const target = brands[index + direction]
    const current = brands[index]
    if (!target) return
    await Promise.all([
      supabase.from('brands').update({ position: target.position }).eq('value', current.value),
      supabase.from('brands').update({ position: current.position }).eq('value', target.value),
    ])
    reloadBrands()
  }

  async function handleUploadBrandLogo(value: string, raw: File | undefined) {
    if (!raw) return
    setUploadingBrandLogo(value)
    try {
      // Compress before upload (keeps transparent-webp logos small).
      const file = await compressImage(raw, { maxDim: 600 })
      const safe = value.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()
      const path = `brands/${safe}-${Date.now()}-${file.name}`
      const { error: upErr } = await supabase.storage.from('store-assets').upload(path, file)
      if (upErr) throw upErr
      const { data: pub } = supabase.storage.from('store-assets').getPublicUrl(path)
      const { error: dbErr } = await supabase.from('brands').update({ logo_url: pub.publicUrl }).eq('value', value)
      if (dbErr) throw dbErr
      toast.success(t.adminSaved)
      reloadBrands()
    } catch (e: any) {
      toast.error(e.message || t.adminUploadFailed)
    } finally {
      setUploadingBrandLogo(null)
    }
  }

  async function handleRemoveBrandLogo(value: string) {
    const { error } = await supabase.from('brands').update({ logo_url: null }).eq('value', value)
    if (error) { toast.error(error.message || t.adminSaveFailed); return }
    reloadBrands()
  }

  if (loading) {
    return (
      <div className="py-24 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="max-w-xl space-y-8">
      <UploadField
        label={t.adminLogo}
        currentUrl={settings?.logo_url || null}
        uploading={uploadingLogo}
        onChange={file => handleUpload('logo_url', file, setUploadingLogo)}
        t={t}
      />
      <UploadField
        label={t.adminFavicon}
        currentUrl={settings?.favicon_url || null}
        uploading={uploadingFavicon}
        onChange={file => handleUpload('favicon_url', file, setUploadingFavicon)}
        t={t}
      />
      {/* ----- Payment methods at checkout ----- */}
      <div className="border border-border bg-card p-6 space-y-4">
        <div>
          <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminPaymentMethods}</span>
          <p className="text-[11px] text-muted-foreground mt-1.5">{t.adminPaymentMethodsHint}</p>
        </div>
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span className="text-sm">{t.checkoutPayOnline}</span>
          <input
            type="checkbox"
            checked={checkoutConfig.online_enabled}
            disabled={savingCheckout}
            onChange={e => handleToggleCheckout({ online_enabled: e.target.checked })}
            className="w-4 h-4 accent-foreground cursor-pointer"
          />
        </label>
        <label className="flex items-center justify-between gap-3 cursor-pointer">
          <span className="text-sm">{t.checkoutCashOnDelivery}</span>
          <input
            type="checkbox"
            checked={checkoutConfig.cash_enabled}
            disabled={savingCheckout}
            onChange={e => handleToggleCheckout({ cash_enabled: e.target.checked })}
            className="w-4 h-4 accent-foreground cursor-pointer"
          />
        </label>
      </div>

      {/* ----- Shipping price per governorate ----- */}
      <div className="border border-border bg-card p-6 space-y-4">
        <div>
          <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminShipping}</span>
          <p className="text-[11px] text-muted-foreground mt-1.5">{t.adminShippingHint}</p>
        </div>
        <div className="space-y-2">
          {regions.map(r => (
            <div key={r.code} className="flex items-center gap-2">
              <span className="flex-1 min-w-0 text-sm truncate">
                {r.name_en} <span className="text-muted-foreground">· {r.name_ar}</span>
              </span>
              <input
                type="number"
                min={0}
                defaultValue={r.price}
                onBlur={e => {
                  const v = Number(e.target.value)
                  if (!Number.isNaN(v) && v !== r.price) handleRegionPrice(r.code, v)
                }}
                className="w-24 bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
              />
              <span className="text-[11px] text-muted-foreground w-8">EGP</span>
              <button
                type="button"
                onClick={() => handleRemoveRegion(r.code)}
                className="p-2 text-red-700 hover:bg-muted cursor-pointer flex-shrink-0"
                aria-label={t.adminDelete}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {regions.length === 0 && (
            <p className="text-[11px] text-muted-foreground py-2">{t.adminShippingEmpty}</p>
          )}
        </div>
        <button
          type="button"
          onClick={handleRestoreGovernorates}
          disabled={savingShipping}
          className="text-xs tracking-wide border border-border px-3 py-2 hover:bg-muted cursor-pointer disabled:opacity-50 inline-flex items-center gap-2"
        >
          <Plus className="w-3.5 h-3.5" />
          {t.adminRestoreGovernorates}
        </button>
      </div>

      <div className="border border-border bg-card p-6 space-y-4">
        <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminCategories}</span>
        <div className="space-y-2">
          {categories.map((c, i) => (
            <div key={c.value} className="flex items-center gap-2">
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => handleMoveCategory(i, -1)}
                  disabled={i === 0}
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                  aria-label={t.adminMoveUp}
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => handleMoveCategory(i, 1)}
                  disabled={i === categories.length - 1}
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                  aria-label={t.adminMoveDown}
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
              </div>
              <input
                type="text"
                defaultValue={c.label_en}
                onBlur={e => e.target.value.trim() && e.target.value !== c.label_en && handleUpdateCategoryLabel(c.value, 'label_en', e.target.value.trim())}
                placeholder={t.adminEnglishName}
                className="flex-1 min-w-0 bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
              />
              <input
                type="text"
                dir="rtl"
                defaultValue={c.label_ar}
                onBlur={e => e.target.value.trim() && e.target.value !== c.label_ar && handleUpdateCategoryLabel(c.value, 'label_ar', e.target.value.trim())}
                placeholder="الاسم بالعربية"
                className="flex-1 min-w-0 bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
              />
              <button
                type="button"
                onClick={() => handleDeleteCategory(c.value)}
                className="p-2 text-red-700 hover:bg-muted cursor-pointer flex-shrink-0"
                aria-label={t.adminDeleteCategory}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <input
            type="text"
            value={newLabelEn}
            onChange={e => setNewLabelEn(e.target.value)}
            placeholder={t.adminEnglishName}
            className="flex-1 min-w-0 bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
          />
          <input
            type="text"
            dir="rtl"
            value={newLabelAr}
            onChange={e => setNewLabelAr(e.target.value)}
            placeholder="الاسم بالعربية"
            className="flex-1 min-w-0 bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
          />
          <button
            type="button"
            onClick={handleAddCategory}
            disabled={savingCategory}
            className="p-2 border border-border hover:bg-muted cursor-pointer disabled:opacity-50 flex-shrink-0"
            aria-label={t.adminAddCategory}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* ----- Brands ----- */}
      <div className="border border-border bg-card p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminBrands}</span>
            <p className="text-[11px] text-muted-foreground mt-1.5">{t.adminBrandsHint}</p>
          </div>
          <label className="flex items-center gap-2 shrink-0 cursor-pointer">
            <span className="text-xs text-muted-foreground whitespace-nowrap">{t.adminShowBrandsPage}</span>
            <input
              type="checkbox"
              checked={brandsPageEnabled}
              disabled={savingVisibility}
              onChange={e => handleToggleBrandsPage(e.target.checked)}
              className="w-4 h-4 accent-foreground cursor-pointer"
            />
          </label>
        </div>
        <div className="space-y-2">
          {brands.map((b, i) => (
            <div key={b.value} className="flex items-center gap-2">
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => handleMoveBrand(i, -1)}
                  disabled={i === 0}
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                  aria-label={t.adminMoveUp}
                >
                  <ArrowUp className="w-3 h-3" />
                </button>
                <button
                  type="button"
                  onClick={() => handleMoveBrand(i, 1)}
                  disabled={i === brands.length - 1}
                  className="p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                  aria-label={t.adminMoveDown}
                >
                  <ArrowDown className="w-3 h-3" />
                </button>
              </div>

              {/* Logo preview + upload */}
              <div className="w-14 h-11 shrink-0 border border-border bg-muted/40 flex items-center justify-center overflow-hidden relative">
                {b.logo_url ? (
                  <>
                    <img src={b.logo_url} alt={b.name} className="w-full h-full object-contain" />
                    <button
                      type="button"
                      onClick={() => handleRemoveBrandLogo(b.value)}
                      className="absolute top-0 end-0 bg-background/80 p-0.5 text-red-700 hover:bg-background cursor-pointer"
                      aria-label={t.adminRemoveLogo}
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </>
                ) : (
                  <span className="text-[9px] text-muted-foreground uppercase tracking-wider">{t.adminNoLogo}</span>
                )}
              </div>
              <label className={`text-[11px] underline shrink-0 ${uploadingBrandLogo === b.value ? 'opacity-50' : 'cursor-pointer'}`}>
                {uploadingBrandLogo === b.value ? t.adminUploading : t.adminUploadLogo}
                <input
                  type="file"
                  accept="image/webp,image/png,image/*"
                  className="hidden"
                  disabled={uploadingBrandLogo === b.value}
                  onChange={e => { handleUploadBrandLogo(b.value, e.target.files?.[0]); e.target.value = '' }}
                />
              </label>

              <input
                type="text"
                defaultValue={b.name}
                onBlur={e => e.target.value.trim() && e.target.value !== b.name && handleUpdateBrandName(b.value, e.target.value.trim())}
                placeholder={t.adminBrandName}
                className="flex-1 min-w-0 bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
              />
              <button
                type="button"
                onClick={() => handleDeleteBrand(b.value)}
                className="p-2 text-red-700 hover:bg-muted cursor-pointer flex-shrink-0"
                aria-label={t.adminDeleteBrand}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          <input
            type="text"
            value={newBrandName}
            onChange={e => setNewBrandName(e.target.value)}
            placeholder={t.adminBrandName}
            className="flex-1 min-w-0 bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
          />
          <button
            type="button"
            onClick={handleAddBrand}
            disabled={savingBrand}
            className="p-2 border border-border hover:bg-muted cursor-pointer disabled:opacity-50 flex-shrink-0"
            aria-label={t.adminAddBrand}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      <div className="border border-border bg-card p-6 space-y-4">
        <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminWhatsapp}</span>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">{t.adminPhoneNumber}</label>
          <input
            type="text"
            value={whatsapp.phone}
            onChange={e => setWhatsapp(prev => ({ ...prev, phone: e.target.value }))}
            placeholder="+201234567890"
            className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">{t.adminMessageEnglish}</label>
          <textarea
            value={whatsapp.message_en}
            onChange={e => setWhatsapp(prev => ({ ...prev, message_en: e.target.value }))}
            rows={3}
            className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none resize-none"
          />
        </div>
        <div>
          <label className="block text-xs text-muted-foreground mb-1">{t.adminMessageArabic}</label>
          <textarea
            value={whatsapp.message_ar}
            onChange={e => setWhatsapp(prev => ({ ...prev, message_ar: e.target.value }))}
            dir="rtl"
            rows={3}
            className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none resize-none"
          />
        </div>
        <button
          onClick={handleSaveWhatsapp}
          disabled={savingWhatsapp}
          className="text-xs tracking-wider uppercase border border-foreground px-4 py-2 hover:bg-foreground hover:text-background transition-colors disabled:opacity-50 cursor-pointer"
        >
          {savingWhatsapp ? t.adminSavingBtn : t.adminSaveBtn}
        </button>
      </div>

      <div className="border border-border bg-card p-6 space-y-4">
        <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminContactSocial}</span>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t.fieldEmail}</label>
            <input
              type="email"
              value={contact.email}
              onChange={e => setContact(prev => ({ ...prev, email: e.target.value }))}
              className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t.fieldPhone}</label>
            <input
              type="text"
              value={contact.phone}
              onChange={e => setContact(prev => ({ ...prev, phone: e.target.value }))}
              className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t.adminAddressEnglish}</label>
            <input
              type="text"
              value={contact.address_en}
              onChange={e => setContact(prev => ({ ...prev, address_en: e.target.value }))}
              className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t.adminAddressArabic}</label>
            <input
              type="text"
              dir="rtl"
              value={contact.address_ar}
              onChange={e => setContact(prev => ({ ...prev, address_ar: e.target.value }))}
              className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
            />
          </div>
          <div className="col-span-2">
            <label className="block text-xs text-muted-foreground mb-1">{t.adminMapUrl}</label>
            <input
              type="text"
              value={contact.map_url}
              onChange={e => setContact(prev => ({ ...prev, map_url: e.target.value }))}
              className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t.adminInstagramUrl}</label>
            <input
              type="text"
              value={contact.social_instagram}
              onChange={e => setContact(prev => ({ ...prev, social_instagram: e.target.value }))}
              className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t.adminFacebookUrl}</label>
            <input
              type="text"
              value={contact.social_facebook}
              onChange={e => setContact(prev => ({ ...prev, social_facebook: e.target.value }))}
              className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t.adminTiktokUrl}</label>
            <input
              type="text"
              value={contact.social_tiktok}
              onChange={e => setContact(prev => ({ ...prev, social_tiktok: e.target.value }))}
              className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
            />
          </div>
          <div>
            <label className="block text-xs text-muted-foreground mb-1">{t.adminTwitterUrl}</label>
            <input
              type="text"
              value={contact.social_twitter}
              onChange={e => setContact(prev => ({ ...prev, social_twitter: e.target.value }))}
              className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
            />
          </div>
        </div>
        <button
          onClick={handleSaveContact}
          disabled={savingContact}
          className="text-xs tracking-wider uppercase border border-foreground px-4 py-2 hover:bg-foreground hover:text-background transition-colors disabled:opacity-50 cursor-pointer"
        >
          {savingContact ? t.adminSavingBtn : t.adminSaveBtn}
        </button>
      </div>
    </div>
  )
}

function UploadField({
  label,
  currentUrl,
  uploading,
  onChange,
  t,
}: {
  label: string
  currentUrl: string | null
  uploading: boolean
  onChange: (file: File | undefined) => void
  t: Translations
}) {
  return (
    <div className="border border-border bg-card p-6">
      <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-4">{label}</span>
      <div className="flex items-center gap-4">
        <div className="w-16 h-16 bg-muted flex items-center justify-center overflow-hidden flex-shrink-0">
          {currentUrl ? (
            <img src={currentUrl} alt={t.adminCurrentLabel(label)} className="w-full h-full object-contain" />
          ) : (
            <span className="text-[10px] text-muted-foreground">{t.adminNone}</span>
          )}
        </div>
        <label className={`text-xs underline ${uploading ? 'opacity-50' : 'cursor-pointer'}`}>
          {uploading ? t.adminUploading : t.adminUploadLabel(label)}
          <input
            type="file"
            accept="image/*"
            className="hidden"
            disabled={uploading}
            onChange={e => { onChange(e.target.files?.[0]); e.target.value = '' }}
          />
        </label>
      </div>
    </div>
  )
}
