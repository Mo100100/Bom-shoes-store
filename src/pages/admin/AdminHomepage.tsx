import { useEffect, useRef, useState } from 'react'
import ReactMarkdown from 'react-markdown'
import { supabase, Testimonial } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useT } from '@/contexts/LanguageContext'
import type { TranslationKey } from '@/lib/translations'
import { Loader2, Plus, X, Edit2, Trash2, ArrowUp, ArrowDown, Star } from 'lucide-react'
import LoadErrorPanel from '@/components/LoadErrorPanel'
import { toast } from 'sonner'

// Every one of these keys is pre-seeded by migration (see task context) --
// plain UPDATE is always correct here, there's no insert-then-conflict case.
const SITE_CONTENT_KEYS = [
  'hero', 'showcase', 'curated', 'limited_drop', 'trust_badges',
  'newsletter', 'categories_strip', 'announcement', 'footer_links', 'policies',
] as const
type SiteContentKey = typeof SITE_CONTENT_KEYS[number]

const TRUST_ICONS = ['Truck', 'ShieldCheck', 'RotateCcw', 'Lock', 'Package', 'Award', 'Heart', 'Star', 'CreditCard', 'Clock', 'Gift', 'Sparkles']

type ProductOption = { id: string; name: string; slug: string }

const TABS = [
  { key: 'hero', labelKey: 'adminHeroTab' },
  { key: 'showcase', labelKey: 'adminShowcaseTab' },
  { key: 'curated', labelKey: 'adminCuratedTab' },
  { key: 'limited_drop', labelKey: 'adminLimitedDropTab' },
  { key: 'trust_badges', labelKey: 'adminTrustBadgesTab' },
  { key: 'newsletter', labelKey: 'adminNewsletterTab' },
  { key: 'categories_strip', labelKey: 'adminBrandBarTab' },
  { key: 'announcement', labelKey: 'adminAnnouncementTab' },
  { key: 'footer_links', labelKey: 'adminFooterLinksTab' },
  { key: 'policies', labelKey: 'adminPoliciesTab' },
  { key: 'testimonials', labelKey: 'adminTestimonialsTab' },
] as const satisfies readonly { key: string; labelKey: TranslationKey }[]
type TabKey = typeof TABS[number]['key']

export default function AdminHomepage() {
  const [tab, setTab] = useState<TabKey>('hero')
  const [loading, setLoading] = useState(true)
  // `null` means the content has never been read successfully. Saving writes
  // back the whole jsonb blob, so a draft built on a failed read would replace
  // the live seeded rows with `{}`. Keeping "not loaded" out of band from
  // "loaded and empty" is what makes that impossible: the tabs, and with them
  // every Save button, are not rendered at all while drafts is null.
  const [drafts, setDrafts] = useState<Record<string, any> | null>(null)
  const [products, setProducts] = useState<ProductOption[]>([])
  const { isAdmin } = useAuth()
  const t = useT()

  // Same guard as Shop.tsx: only the most recently started load may touch
  // state, so a slow failure can't land after a retry has already succeeded.
  const loadIdRef = useRef(0)

  async function load() {
    const id = ++loadIdRef.current
    setLoading(true)
    try {
      const [content, catalog] = await Promise.all([
        supabase.from('site_content').select('key, value').in('key', SITE_CONTENT_KEYS as unknown as string[]),
        supabase.from('product_catalog').select('id, name, slug').order('name'),
      ])
      if (id !== loadIdRef.current) return
      if (content.error || catalog.error) {
        setDrafts(null)
        setProducts([])
        return
      }
      const map: Record<string, any> = {}
      for (const row of content.data || []) map[row.key] = row.value
      setDrafts(map)
      setProducts(catalog.data || [])
    } catch {
      // postgrest-js reports a failed request as { error }, but a genuine throw
      // (auth refresh, malformed JSON) must not leave the spinner up forever.
      if (id !== loadIdRef.current) return
      setDrafts(null)
      setProducts([])
    } finally {
      if (id === loadIdRef.current) setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  function setField(key: SiteContentKey, field: string, value: any) {
    setDrafts(d => (d ? { ...d, [key]: { ...d[key], [field]: value } } : d))
  }

  async function saveKey(key: SiteContentKey) {
    // Second lock behind the render guard below: no draft, no write.
    if (!drafts) { toast.error(t.adminHomepageLoadError); return }
    const { data, error } = await supabase
      .from('site_content')
      .update({ value: drafts[key] || {} })
      .eq('key', key)
      .select('key, value')
    if (error) { toast.error(error.message); return }
    // A zero-row match returns no error, so an unchecked update would toast
    // "Saved" after an RLS denial or against a key that isn't seeded.
    if (!data.length) { toast.error(t.adminSaveNotApplied); return }
    // Re-sync this key from the row the database actually stored, instead of
    // leaving the editor on the copy read at mount.
    setDrafts(d => (d ? { ...d, [key]: data[0].value } : d))
    toast.success(t.adminSaved)
  }

  if (loading) {
    return (
      <div className="py-24 flex justify-center">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // A failed read is never dressed up as "nothing configured yet".
  if (!drafts) {
    return (
      <div className="py-24 text-center">
        <p className="text-terracotta">{t.adminHomepageLoadError}</p>
        <button
          onClick={() => load()}
          className="mt-4 text-sm border-b border-foreground pb-0.5 cursor-pointer"
        >
          {t.failedTryAgain}
        </button>
      </div>
    )
  }

  return (
    <div>
      <div className="flex gap-2 mb-6 flex-wrap">
        {TABS.map(item => (
          <button
            key={item.key}
            onClick={() => setTab(item.key)}
            className={`px-4 py-2 text-sm tracking-wider border cursor-pointer ${
              tab === item.key
                ? 'bg-primary text-primary-foreground border-primary'
                : 'border-border hover:bg-muted'
            }`}
          >
            {t[item.labelKey]}
          </button>
        ))}
      </div>

      {tab === 'hero' && <HeroTab value={drafts.hero || {}} setField={(f, v) => setField('hero', f, v)} onSave={() => saveKey('hero')} readOnly={!isAdmin} />}
      {tab === 'curated' && <CuratedTab value={drafts.curated || {}} setField={(f, v) => setField('curated', f, v)} onSave={() => saveKey('curated')} readOnly={!isAdmin} />}
      {tab === 'limited_drop' && <LimitedDropTab value={drafts.limited_drop || {}} setField={(f, v) => setField('limited_drop', f, v)} onSave={() => saveKey('limited_drop')} readOnly={!isAdmin} />}
      {tab === 'showcase' && (
        <ShowcaseTab
          value={drafts.showcase || { product_ids: [] }}
          setField={(f, v) => setField('showcase', f, v)}
          onSave={() => saveKey('showcase')}
          products={products}
          readOnly={!isAdmin}
        />
      )}
      {tab === 'trust_badges' && (
        <TrustBadgesTab
          value={drafts.trust_badges || { items: [] }}
          setField={(f, v) => setField('trust_badges', f, v)}
          onSave={() => saveKey('trust_badges')}
          readOnly={!isAdmin}
        />
      )}
      {tab === 'newsletter' && <NewsletterTab value={drafts.newsletter || {}} setField={(f, v) => setField('newsletter', f, v)} onSave={() => saveKey('newsletter')} readOnly={!isAdmin} />}
      {tab === 'categories_strip' && <BrandBarTab value={drafts.categories_strip || {}} setField={(f, v) => setField('categories_strip', f, v)} onSave={() => saveKey('categories_strip')} readOnly={!isAdmin} />}
      {tab === 'announcement' && <AnnouncementTab value={drafts.announcement || { lines: [] }} setField={(f, v) => setField('announcement', f, v)} onSave={() => saveKey('announcement')} readOnly={!isAdmin} />}
      {tab === 'footer_links' && <FooterLinksTab value={drafts.footer_links || { items: [] }} setField={(f, v) => setField('footer_links', f, v)} onSave={() => saveKey('footer_links')} readOnly={!isAdmin} />}
      {tab === 'policies' && <PoliciesTab value={drafts.policies || {}} setField={(f, v) => setField('policies', f, v)} onSave={() => saveKey('policies')} readOnly={!isAdmin} />}
      {tab === 'testimonials' && <TestimonialsTab />}
    </div>
  )
}

// ---------- shared field building blocks (same visual convention as
// AdminBanners/AdminCoupons' local `Field` component) ----------

function Field({ label, value, onChange, type = 'text', placeholder = '', disabled = false }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; disabled?: boolean }) {
  return (
    <label className="block">
      <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none disabled:opacity-40"
      />
    </label>
  )
}

function BilingualField({
  label, valueEn, valueAr, onEnChange, onArChange, textarea = false, disabled = false,
}: {
  label: string; valueEn: string; valueAr: string; onEnChange: (v: string) => void; onArChange: (v: string) => void; textarea?: boolean; disabled?: boolean
}) {
  const cls = 'w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none disabled:opacity-40'
  return (
    <div>
      <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{label}</span>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <span className="block text-[10px] tracking-widest uppercase text-muted-foreground mb-1">EN</span>
          {textarea
            ? <textarea rows={2} value={valueEn} disabled={disabled} onChange={e => onEnChange(e.target.value)} className={cls} />
            : <input value={valueEn} disabled={disabled} onChange={e => onEnChange(e.target.value)} className={cls} />}
        </div>
        <div>
          <span className="block text-[10px] tracking-widest uppercase text-muted-foreground mb-1">AR</span>
          {textarea
            ? <textarea rows={2} dir="rtl" value={valueAr} disabled={disabled} onChange={e => onArChange(e.target.value)} className={cls} />
            : <input dir="rtl" value={valueAr} disabled={disabled} onChange={e => onArChange(e.target.value)} className={cls} />}
        </div>
      </div>
    </div>
  )
}

function EnabledCheckbox({ checked, onChange, disabled }: { checked: boolean; onChange: (v: boolean) => void; disabled: boolean }) {
  const t = useT()
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={e => onChange(e.target.checked)}
        className="w-4 h-4 cursor-pointer disabled:opacity-40"
      />
      <span className="text-sm">{t.adminShowSection}</span>
    </label>
  )
}

function SaveBar({ onSave, readOnly }: { onSave: () => void; readOnly: boolean }) {
  const [saving, setSaving] = useState(false)
  const t = useT()
  return (
    <div className="pt-4 border-t border-border flex justify-end">
      <button
        disabled={readOnly || saving}
        onClick={async () => { setSaving(true); await onSave(); setSaving(false) }}
        className="px-5 py-2.5 text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 cursor-pointer flex items-center gap-2"
      >
        {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
        {t.adminSaveBtn}
      </button>
    </div>
  )
}

function Card({ children }: { children: React.ReactNode }) {
  return <div className="border border-border bg-card p-6 space-y-5 max-w-3xl">{children}</div>
}

// ---------- Hero ----------

function HeroTab({ value, setField, onSave, readOnly }: { value: any; setField: (f: string, v: any) => void; onSave: () => void; readOnly: boolean }) {
  const t = useT()
  return (
    <Card>
      <BilingualField label={t.adminFieldEyebrow} valueEn={value.eyebrow_en || ''} valueAr={value.eyebrow_ar || ''} onEnChange={v => setField('eyebrow_en', v)} onArChange={v => setField('eyebrow_ar', v)} disabled={readOnly} />
      <BilingualField label={t.adminFieldTitleLine1} valueEn={value.title1_en || ''} valueAr={value.title1_ar || ''} onEnChange={v => setField('title1_en', v)} onArChange={v => setField('title1_ar', v)} disabled={readOnly} />
      <BilingualField label={t.adminFieldTitleLine2} valueEn={value.title2_en || ''} valueAr={value.title2_ar || ''} onEnChange={v => setField('title2_en', v)} onArChange={v => setField('title2_ar', v)} disabled={readOnly} />
      <BilingualField label={t.adminFieldSubtitle} valueEn={value.subtitle_en || ''} valueAr={value.subtitle_ar || ''} onEnChange={v => setField('subtitle_en', v)} onArChange={v => setField('subtitle_ar', v)} textarea disabled={readOnly} />
      <BilingualField label={t.adminFieldPrimaryCtaText} valueEn={value.cta1_text_en || ''} valueAr={value.cta1_text_ar || ''} onEnChange={v => setField('cta1_text_en', v)} onArChange={v => setField('cta1_text_ar', v)} disabled={readOnly} />
      <Field label={t.adminFieldPrimaryCtaLink} value={value.cta1_link || ''} onChange={v => setField('cta1_link', v)} placeholder="/shop" disabled={readOnly} />
      <BilingualField label={t.adminFieldSecondaryCtaText} valueEn={value.cta2_text_en || ''} valueAr={value.cta2_text_ar || ''} onEnChange={v => setField('cta2_text_en', v)} onArChange={v => setField('cta2_text_ar', v)} disabled={readOnly} />
      <Field label={t.adminFieldSecondaryCtaLink} value={value.cta2_link || ''} onChange={v => setField('cta2_link', v)} placeholder="/shop" disabled={readOnly} />
      <BilingualField label={t.adminFieldScrollHint} valueEn={value.scroll_text_en || ''} valueAr={value.scroll_text_ar || ''} onEnChange={v => setField('scroll_text_en', v)} onArChange={v => setField('scroll_text_ar', v)} disabled={readOnly} />
      <EnabledCheckbox checked={value.enabled !== false} onChange={v => setField('enabled', v)} disabled={readOnly} />
      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Curated ----------

function CuratedTab({ value, setField, onSave, readOnly }: { value: any; setField: (f: string, v: any) => void; onSave: () => void; readOnly: boolean }) {
  const t = useT()
  return (
    <Card>
      <BilingualField label={t.adminFieldEyebrow} valueEn={value.eyebrow_en || ''} valueAr={value.eyebrow_ar || ''} onEnChange={v => setField('eyebrow_en', v)} onArChange={v => setField('eyebrow_ar', v)} disabled={readOnly} />
      <BilingualField label={t.adminFieldHeading} valueEn={value.heading_en || ''} valueAr={value.heading_ar || ''} onEnChange={v => setField('heading_en', v)} onArChange={v => setField('heading_ar', v)} disabled={readOnly} />
      <BilingualField label={t.adminFieldViewAllText} valueEn={value.view_all_en || ''} valueAr={value.view_all_ar || ''} onEnChange={v => setField('view_all_en', v)} onArChange={v => setField('view_all_ar', v)} disabled={readOnly} />
      <Field label={t.adminFieldProductLimit} type="number" value={String(value.limit ?? 5)} onChange={v => setField('limit', Number(v) || 0)} disabled={readOnly} />
      <EnabledCheckbox checked={value.enabled !== false} onChange={v => setField('enabled', v)} disabled={readOnly} />
      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Limited Drop ----------

function LimitedDropTab({ value, setField, onSave, readOnly }: { value: any; setField: (f: string, v: any) => void; onSave: () => void; readOnly: boolean }) {
  const t = useT()
  return (
    <Card>
      <BilingualField label={t.adminFieldEyebrow} valueEn={value.eyebrow_en || ''} valueAr={value.eyebrow_ar || ''} onEnChange={v => setField('eyebrow_en', v)} onArChange={v => setField('eyebrow_ar', v)} disabled={readOnly} />
      <BilingualField label={t.adminFieldTitleLine1} valueEn={value.title1_en || ''} valueAr={value.title1_ar || ''} onEnChange={v => setField('title1_en', v)} onArChange={v => setField('title1_ar', v)} disabled={readOnly} />
      <BilingualField label={t.adminFieldTitleLine2} valueEn={value.title2_en || ''} valueAr={value.title2_ar || ''} onEnChange={v => setField('title2_en', v)} onArChange={v => setField('title2_ar', v)} disabled={readOnly} />
      <BilingualField label={t.adminFieldSubtitle} valueEn={value.subtitle_en || ''} valueAr={value.subtitle_ar || ''} onEnChange={v => setField('subtitle_en', v)} onArChange={v => setField('subtitle_ar', v)} textarea disabled={readOnly} />
      <BilingualField label={t.adminFieldCtaText} valueEn={value.cta_text_en || ''} valueAr={value.cta_text_ar || ''} onEnChange={v => setField('cta_text_en', v)} onArChange={v => setField('cta_text_ar', v)} disabled={readOnly} />
      <Field label={t.adminFieldCtaLink} value={value.cta_link || ''} onChange={v => setField('cta_link', v)} placeholder="/shop" disabled={readOnly} />
      <Field label={t.adminImageUrl} value={value.image_url || ''} onChange={v => setField('image_url', v)} placeholder="https://…" disabled={readOnly} />
      <div>
        <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminCountdownMode}</label>
        <select
          value={value.countdown_mode || 'auto'}
          disabled={readOnly}
          onChange={e => setField('countdown_mode', e.target.value)}
          className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer disabled:opacity-40"
        >
          <option value="auto">{t.adminCountdownAuto}</option>
          <option value="manual">{t.adminCountdownManual}</option>
          <option value="off">{t.adminCountdownOff}</option>
        </select>
      </div>
      {value.countdown_mode === 'manual' && (
        <Field
          label={t.adminManualTarget}
          type="datetime-local"
          value={value.manual_target ? value.manual_target.slice(0, 16) : ''}
          onChange={v => setField('manual_target', v ? new Date(v).toISOString() : null)}
          disabled={readOnly}
        />
      )}
      <EnabledCheckbox checked={value.enabled !== false} onChange={v => setField('enabled', v)} disabled={readOnly} />
      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Showcase ----------

function ShowcaseTab({
  value, setField, onSave, products, readOnly,
}: { value: any; setField: (f: string, v: any) => void; onSave: () => void; products: ProductOption[]; readOnly: boolean }) {
  const t = useT()
  const ids: string[] = value.product_ids || []
  const [pick, setPick] = useState('')
  const byId = Object.fromEntries(products.map(p => [p.id, p]))
  const available = products.filter(p => !ids.includes(p.id))

  function add() {
    if (!pick) return
    setField('product_ids', [...ids, pick])
    setPick('')
  }
  function remove(idx: number) {
    setField('product_ids', ids.filter((_, i) => i !== idx))
  }
  function move(idx: number, dir: -1 | 1) {
    const swap = idx + dir
    if (swap < 0 || swap >= ids.length) return
    const next = [...ids]
    ;[next[idx], next[swap]] = [next[swap], next[idx]]
    setField('product_ids', next)
  }

  return (
    <Card>
      <BilingualField label={t.adminFieldLabel} valueEn={value.label_en || ''} valueAr={value.label_ar || ''} onEnChange={v => setField('label_en', v)} onArChange={v => setField('label_ar', v)} disabled={readOnly} />

      <div>
        <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminShowcaseProducts}</span>
        <div className="space-y-2 mb-3">
          {ids.map((id, idx) => (
            <div key={id + idx} className="flex items-center gap-2 border border-border px-3 py-2">
              <span className="flex-1 text-sm truncate">{byId[id]?.name || id}</span>
              <button type="button" onClick={() => move(idx, -1)} disabled={readOnly || idx === 0} className="p-1 hover:bg-muted disabled:opacity-30 cursor-pointer" aria-label={t.adminMoveUp}>
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={() => move(idx, 1)} disabled={readOnly || idx === ids.length - 1} className="p-1 hover:bg-muted disabled:opacity-30 cursor-pointer" aria-label={t.adminMoveDown}>
                <ArrowDown className="w-3.5 h-3.5" />
              </button>
              <button type="button" onClick={() => remove(idx)} disabled={readOnly} className="p-1 text-red-700 hover:bg-muted disabled:opacity-30 cursor-pointer" aria-label={t.adminRemoveRow}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          {ids.length === 0 && <p className="text-sm text-muted-foreground">{t.adminNoShowcaseProducts}</p>}
        </div>
        {!readOnly && (
          <div className="flex gap-2">
            <select
              value={pick}
              onChange={e => setPick(e.target.value)}
              className="flex-1 bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none cursor-pointer"
            >
              <option value="" disabled>{t.adminSelectProductToAdd}</option>
              {available.map(p => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
            <button type="button" onClick={add} disabled={!pick} className="px-4 py-2 text-sm border border-border hover:bg-muted disabled:opacity-40 cursor-pointer flex items-center gap-1">
              <Plus className="w-3.5 h-3.5" /> {t.adminAdd}
            </button>
          </div>
        )}
      </div>

      <EnabledCheckbox checked={value.enabled !== false} onChange={v => setField('enabled', v)} disabled={readOnly} />
      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Trust Badges ----------

function TrustBadgesTab({ value, setField, onSave, readOnly }: { value: any; setField: (f: string, v: any) => void; onSave: () => void; readOnly: boolean }) {
  const t = useT()
  const items: any[] = value.items || []

  function updateItem(idx: number, field: string, v: any) {
    setField('items', items.map((it, i) => (i === idx ? { ...it, [field]: v } : it)))
  }
  function addItem() {
    setField('items', [...items, { icon: 'Truck', title_en: '', title_ar: '', desc_en: '', desc_ar: '' }])
  }
  function removeItem(idx: number) {
    setField('items', items.filter((_, i) => i !== idx))
  }

  return (
    <Card>
      <BilingualField label={t.adminFieldEyebrow} valueEn={value.eyebrow_en || ''} valueAr={value.eyebrow_ar || ''} onEnChange={v => setField('eyebrow_en', v)} onArChange={v => setField('eyebrow_ar', v)} disabled={readOnly} />

      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminBadges}</span>
          {!readOnly && (
            <button type="button" onClick={addItem} className="text-xs underline cursor-pointer">{t.adminAddBadge}</button>
          )}
        </div>
        <div className="space-y-4">
          {items.map((it, idx) => (
            <div key={idx} className="border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <select
                  value={it.icon || 'Truck'}
                  disabled={readOnly}
                  onChange={e => updateItem(idx, 'icon', e.target.value)}
                  className="bg-transparent border border-border px-2 py-1.5 text-sm focus:border-foreground outline-none cursor-pointer disabled:opacity-40"
                >
                  {TRUST_ICONS.map(icon => <option key={icon} value={icon}>{icon}</option>)}
                </select>
                <button type="button" onClick={() => removeItem(idx)} disabled={readOnly} className="p-1 text-red-700 hover:bg-muted disabled:opacity-30 cursor-pointer" aria-label={t.adminRemoveBadge}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <BilingualField label={t.adminFieldTitle} valueEn={it.title_en || ''} valueAr={it.title_ar || ''} onEnChange={v => updateItem(idx, 'title_en', v)} onArChange={v => updateItem(idx, 'title_ar', v)} disabled={readOnly} />
              <BilingualField label={t.adminFieldDescription} valueEn={it.desc_en || ''} valueAr={it.desc_ar || ''} onEnChange={v => updateItem(idx, 'desc_en', v)} onArChange={v => updateItem(idx, 'desc_ar', v)} disabled={readOnly} />
            </div>
          ))}
          {items.length === 0 && <p className="text-sm text-muted-foreground">{t.adminNoBadges}</p>}
        </div>
      </div>

      <EnabledCheckbox checked={value.enabled !== false} onChange={v => setField('enabled', v)} disabled={readOnly} />
      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Newsletter ----------

function NewsletterTab({ value, setField, onSave, readOnly }: { value: any; setField: (f: string, v: any) => void; onSave: () => void; readOnly: boolean }) {
  const t = useT()
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    supabase.from('newsletter_subscribers').select('*', { count: 'exact', head: true }).then(
      ({ count }) => setCount(count ?? 0),
      () => setCount(null),
    )
  }, [])

  return (
    <Card>
      <BilingualField label={t.adminFieldTitle} valueEn={value.title_en || ''} valueAr={value.title_ar || ''} onEnChange={v => setField('title_en', v)} onArChange={v => setField('title_ar', v)} disabled={readOnly} />
      <BilingualField label={t.adminFieldSubtitle} valueEn={value.subtitle_en || ''} valueAr={value.subtitle_ar || ''} onEnChange={v => setField('subtitle_en', v)} onArChange={v => setField('subtitle_ar', v)} textarea disabled={readOnly} />
      <EnabledCheckbox checked={value.enabled !== false} onChange={v => setField('enabled', v)} disabled={readOnly} />
      <p className="text-sm text-muted-foreground">
        {count === null ? t.adminSubscriberLoading : t.adminSubscriberCount(count)}
      </p>
      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Brand Bar ----------
// Note: the underlying site_content key is still `categories_strip` (kept to
// avoid a migration); it now controls the homepage brand-logos bar.

function BrandBarTab({ value, setField, onSave, readOnly }: { value: any; setField: (f: string, v: any) => void; onSave: () => void; readOnly: boolean }) {
  const t = useT()
  return (
    <Card>
      <p className="text-sm text-muted-foreground">
        {t.adminBrandBarNote}
      </p>
      <EnabledCheckbox checked={value.enabled !== false} onChange={v => setField('enabled', v)} disabled={readOnly} />
      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Announcement Bar ----------

function AnnouncementTab({ value, setField, onSave, readOnly }: { value: any; setField: (f: string, v: any) => void; onSave: () => void; readOnly: boolean }) {
  const t = useT()
  const lines: any[] = value.lines || []

  function updateLine(idx: number, field: string, v: any) {
    setField('lines', lines.map((l, i) => (i === idx ? { ...l, [field]: v } : l)))
  }
  function addLine() {
    setField('lines', [...lines, { en: '', ar: '' }])
  }
  function removeLine(idx: number) {
    setField('lines', lines.filter((_, i) => i !== idx))
  }
  function move(idx: number, dir: -1 | 1) {
    const swap = idx + dir
    if (swap < 0 || swap >= lines.length) return
    const next = [...lines]
    ;[next[idx], next[swap]] = [next[swap], next[idx]]
    setField('lines', next)
  }

  return (
    <Card>
      <EnabledCheckbox checked={value.enabled !== false} onChange={v => setField('enabled', v)} disabled={readOnly} />

      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminLines}</span>
          {!readOnly && (
            <button type="button" onClick={addLine} className="text-xs underline cursor-pointer">{t.adminAddLine}</button>
          )}
        </div>
        <div className="space-y-3">
          {lines.map((l, idx) => (
            <div key={idx} className="border border-border p-4 space-y-3">
              <BilingualField label={t.adminLineN(idx + 1)} valueEn={l.en || ''} valueAr={l.ar || ''} onEnChange={v => updateLine(idx, 'en', v)} onArChange={v => updateLine(idx, 'ar', v)} disabled={readOnly} />
              <div className="flex items-center justify-end gap-1">
                <button type="button" onClick={() => move(idx, -1)} disabled={readOnly || idx === 0} className="p-1 hover:bg-muted disabled:opacity-30 cursor-pointer" aria-label={t.adminMoveUp}>
                  <ArrowUp className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={() => move(idx, 1)} disabled={readOnly || idx === lines.length - 1} className="p-1 hover:bg-muted disabled:opacity-30 cursor-pointer" aria-label={t.adminMoveDown}>
                  <ArrowDown className="w-3.5 h-3.5" />
                </button>
                <button type="button" onClick={() => removeLine(idx)} disabled={readOnly} className="p-1 text-red-700 hover:bg-muted disabled:opacity-30 cursor-pointer" aria-label={t.adminRemoveLine}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
          {lines.length === 0 && <p className="text-sm text-muted-foreground">{t.adminNoLines}</p>}
        </div>
      </div>

      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Footer Links ----------

function FooterLinksTab({ value, setField, onSave, readOnly }: { value: any; setField: (f: string, v: any) => void; onSave: () => void; readOnly: boolean }) {
  const t = useT()
  const items: any[] = value.items || []

  function updateItem(idx: number, field: string, v: any) {
    setField('items', items.map((it, i) => (i === idx ? { ...it, [field]: v } : it)))
  }
  function addItem() {
    setField('items', [...items, { label_en: '', label_ar: '', url: '' }])
  }
  function removeItem(idx: number) {
    setField('items', items.filter((_, i) => i !== idx))
  }

  return (
    <Card>
      <div>
        <div className="flex items-center justify-between mb-3">
          <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminLinks}</span>
          {!readOnly && (
            <button type="button" onClick={addItem} className="text-xs underline cursor-pointer">{t.adminAddLink}</button>
          )}
        </div>
        <div className="space-y-4">
          {items.map((it, idx) => (
            <div key={idx} className="border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{t.adminLinkN(idx + 1)}</span>
                <button type="button" onClick={() => removeItem(idx)} disabled={readOnly} className="p-1 text-red-700 hover:bg-muted disabled:opacity-30 cursor-pointer" aria-label={t.adminRemoveLink}>
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
              <BilingualField label={t.adminFieldLabel} valueEn={it.label_en || ''} valueAr={it.label_ar || ''} onEnChange={v => updateItem(idx, 'label_en', v)} onArChange={v => updateItem(idx, 'label_ar', v)} disabled={readOnly} />
              <Field label={t.adminFieldUrl} value={it.url || ''} onChange={v => updateItem(idx, 'url', v)} placeholder="/pages/about" disabled={readOnly} />
            </div>
          ))}
          {items.length === 0 && <p className="text-sm text-muted-foreground">{t.adminNoLinks}</p>}
        </div>
      </div>

      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Policies & Cancellations (markdown page) ----------

function PoliciesTab({ value, setField, onSave, readOnly }: { value: any; setField: (f: string, v: any) => void; onSave: () => void; readOnly: boolean }) {
  const t = useT()
  const [preview, setPreview] = useState<'en' | 'ar' | null>(null)
  const cls = 'w-full bg-transparent border border-border px-3 py-2 text-sm font-mono focus:border-foreground outline-none disabled:opacity-40'

  return (
    <Card>
      <p className="text-sm text-muted-foreground">{t.adminPoliciesHint}</p>
      <BilingualField label={t.adminFieldTitle} valueEn={value.title_en || ''} valueAr={value.title_ar || ''} onEnChange={v => setField('title_en', v)} onArChange={v => setField('title_ar', v)} disabled={readOnly} />

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminPoliciesBodyEn}</span>
          <button type="button" onClick={() => setPreview(p => p === 'en' ? null : 'en')} className="text-xs underline cursor-pointer">
            {preview === 'en' ? t.adminPoliciesEdit : t.adminPoliciesPreview}
          </button>
        </div>
        {preview === 'en' ? (
          <div className="prose-policies border border-border p-4 text-sm max-h-96 overflow-y-auto">
            <ReactMarkdown>{value.body_md_en || ''}</ReactMarkdown>
          </div>
        ) : (
          <textarea rows={14} value={value.body_md_en || ''} disabled={readOnly} onChange={e => setField('body_md_en', e.target.value)} className={cls} />
        )}
      </div>

      <div>
        <div className="flex items-center justify-between mb-2">
          <span className="block text-xs tracking-widest uppercase text-muted-foreground">{t.adminPoliciesBodyAr}</span>
          <button type="button" onClick={() => setPreview(p => p === 'ar' ? null : 'ar')} className="text-xs underline cursor-pointer">
            {preview === 'ar' ? t.adminPoliciesEdit : t.adminPoliciesPreview}
          </button>
        </div>
        {preview === 'ar' ? (
          <div dir="rtl" className="prose-policies border border-border p-4 text-sm max-h-96 overflow-y-auto">
            <ReactMarkdown>{value.body_md_ar || ''}</ReactMarkdown>
          </div>
        ) : (
          <textarea rows={14} dir="rtl" value={value.body_md_ar || ''} disabled={readOnly} onChange={e => setField('body_md_ar', e.target.value)} className={cls} />
        )}
      </div>

      <SaveBar onSave={onSave} readOnly={readOnly} />
    </Card>
  )
}

// ---------- Testimonials (full CRUD, mirrors AdminBanners.tsx) ----------

const EMPTY_TESTIMONIAL: Partial<Testimonial> = {
  author_name: '', author_title: '', quote_en: '', quote_ar: '', rating: 5, avatar_url: '', position: 0, active: true,
}

function TestimonialsTab() {
  const [rows, setRows] = useState<Testimonial[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState<Partial<Testimonial> | null>(null)
  const [saving, setSaving] = useState(false)
  const { isAdmin } = useAuth()
  const t = useT()

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('testimonials').select('*').order('position')
    // A failed read must not read as "no testimonials", which is an invitation
    // to type the live ones in again.
    setLoadError(!!error)
    setRows(error ? [] : data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  function openNew() {
    const nextPosition = rows.length ? Math.max(...rows.map(r => r.position)) + 1 : 0
    setEditing({ ...EMPTY_TESTIMONIAL, position: nextPosition })
  }
  function openEdit(r: Testimonial) {
    setEditing({ ...r })
  }

  async function toggleActive(r: Testimonial) {
    const { error } = await supabase.from('testimonials').update({ active: !r.active }).eq('id', r.id)
    if (error) { toast.error(error.message); return }
    load()
  }

  async function move(row: Testimonial, direction: -1 | 1) {
    const idx = rows.findIndex(r => r.id === row.id)
    const swapIdx = idx + direction
    if (swapIdx < 0 || swapIdx >= rows.length) return
    const reordered = [...rows]
    ;[reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]]
    setRows(reordered)
    await Promise.all(reordered.map((r, i) => supabase.from('testimonials').update({ position: i }).eq('id', r.id)))
    load()
  }

  async function handleSave() {
    if (!editing) return
    if (!editing.author_name?.trim()) { toast.error(t.adminAuthorNameRequired); return }
    if (!editing.quote_en?.trim() || !editing.quote_ar?.trim()) { toast.error(t.adminQuoteRequired); return }
    setSaving(true)
    try {
      const payload = {
        author_name: editing.author_name.trim(),
        author_title: editing.author_title?.trim() || null,
        quote_en: editing.quote_en.trim(),
        quote_ar: editing.quote_ar.trim(),
        rating: editing.rating === null || editing.rating === undefined || (editing.rating as any) === '' ? null : Number(editing.rating),
        avatar_url: editing.avatar_url?.trim() || null,
        position: Number(editing.position) || 0,
        active: !!editing.active,
      }

      if (editing.id) {
        const { data, error } = await supabase.from('testimonials').update(payload).eq('id', editing.id).select('id')
        if (error) throw error
        // A zero-row match returns no error: without this an edited quote that
        // never landed would still toast "Testimonial updated".
        if (!data.length) throw new Error(t.adminSaveNotApplied)
      } else {
        const { error } = await supabase.from('testimonials').insert(payload)
        if (error) throw error
      }

      toast.success(editing.id ? t.adminTestimonialUpdated : t.adminTestimonialCreated)
      setEditing(null)
      load()
    } catch (e: any) {
      toast.error(e.message || t.adminGenericError)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(r: Testimonial) {
    if (!confirm(t.adminTestimonialDeleteConfirm(r.author_name))) return
    const { error } = await supabase.from('testimonials').delete().eq('id', r.id)
    if (error) { toast.error(error.message); return }
    toast.success(t.adminTestimonialDeleted)
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        {/* A count over a failed read would read as "you have none". */}
        {!loadError && <p className="text-sm text-muted-foreground">{t.adminTestimonialsCount(rows.length)}</p>}
        {isAdmin && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 text-sm tracking-wider hover:bg-primary/90 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {t.adminAddTestimonial}
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-24 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <LoadErrorPanel onRetry={load} />
      ) : (
        <div className="border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs tracking-widest uppercase text-muted-foreground">
                <tr>
                  <th className="text-start px-4 py-3">{t.adminColOrder}</th>
                  <th className="text-start px-4 py-3">{t.adminColAuthor}</th>
                  <th className="text-start px-4 py-3">{t.adminColQuote}</th>
                  <th className="text-start px-4 py-3">{t.adminColRating}</th>
                  <th className="text-start px-4 py-3">{t.adminColActive}</th>
                  <th className="text-end px-4 py-3">{t.adminActions}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, idx) => (
                  <tr key={r.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button onClick={() => move(r, -1)} disabled={idx === 0} className="p-1 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer" aria-label={t.adminMoveUp}>
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => move(r, 1)} disabled={idx === rows.length - 1} className="p-1 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer" aria-label={t.adminMoveDown}>
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-muted overflow-hidden flex-shrink-0">
                          {r.avatar_url && <img src={r.avatar_url} alt="" className="w-full h-full object-cover" />}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">{r.author_name}</p>
                          {r.author_title && <p className="text-xs text-muted-foreground truncate max-w-[180px]">{r.author_title}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground truncate max-w-[240px]">{r.quote_en}</td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {r.rating ? (
                        <span className="inline-flex items-center gap-1"><Star className="w-3.5 h-3.5 fill-current" />{r.rating}</span>
                      ) : t.dash}
                    </td>
                    <td className="px-4 py-3">
                      <input type="checkbox" checked={r.active} onChange={() => toggleActive(r)} className="w-4 h-4 cursor-pointer" aria-label={t.adminColActive} />
                    </td>
                    <td className="px-4 py-3 text-end">
                      <button onClick={() => openEdit(r)} className="p-1.5 hover:bg-muted cursor-pointer" aria-label={t.adminEditTestimonial}>
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDelete(r)} className="p-1.5 hover:bg-muted text-red-700 cursor-pointer" aria-label={t.adminTestimonialDeleted}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">{t.adminNoTestimonials}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-50 bg-foreground/50 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-background w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-6 border-b border-border sticky top-0 bg-background z-10">
              <h2 className="font-display text-2xl">{editing.id ? t.adminEditTestimonial : t.adminNewTestimonial}</h2>
              <button onClick={() => setEditing(null)} className="p-2 cursor-pointer" aria-label={t.adminClose}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <div className="grid grid-cols-2 gap-4">
                <Field label={t.adminAuthorName} value={editing.author_name || ''} onChange={v => setEditing({ ...editing, author_name: v })} />
                <Field label={t.adminAuthorTitle} value={editing.author_title || ''} onChange={v => setEditing({ ...editing, author_title: v })} placeholder={t.adminAuthorTitlePlaceholder} />
              </div>
              <div>
                <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminQuoteEn}</label>
                <textarea
                  value={editing.quote_en || ''}
                  onChange={e => setEditing({ ...editing, quote_en: e.target.value })}
                  rows={3}
                  className="w-full bg-transparent border border-border p-3 text-sm focus:border-foreground outline-none"
                />
              </div>
              <div>
                <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminQuoteAr}</label>
                <textarea
                  dir="rtl"
                  value={editing.quote_ar || ''}
                  onChange={e => setEditing({ ...editing, quote_ar: e.target.value })}
                  rows={3}
                  className="w-full bg-transparent border border-border p-3 text-sm focus:border-foreground outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field
                  label={t.adminRating15}
                  type="number"
                  value={editing.rating != null ? String(editing.rating) : ''}
                  onChange={v => setEditing({ ...editing, rating: v === '' ? null : Math.max(1, Math.min(5, Number(v))) })}
                />
                <Field label={t.adminAvatarUrl} value={editing.avatar_url || ''} onChange={v => setEditing({ ...editing, avatar_url: v })} placeholder="https://…" />
              </div>
              <div className="grid grid-cols-2 gap-4 items-end">
                <Field label={t.adminPosition} type="number" value={String(editing.position ?? 0)} onChange={v => setEditing({ ...editing, position: Number(v) })} />
                <label className="flex items-center gap-2 cursor-pointer pb-2.5">
                  <input
                    type="checkbox"
                    checked={editing.active ?? true}
                    onChange={e => setEditing({ ...editing, active: e.target.checked })}
                    className="w-4 h-4"
                  />
                  <span className="text-sm">{t.adminActiveLabel}</span>
                </label>
              </div>
            </div>
            <div className="p-6 border-t border-border flex items-center justify-end gap-3 sticky bottom-0 bg-background">
              <button onClick={() => setEditing(null)} className="px-5 py-2.5 text-sm border border-border hover:bg-muted cursor-pointer">
                {t.adminCancel}
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="px-5 py-2.5 text-sm bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 cursor-pointer flex items-center gap-2"
              >
                {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {editing.id ? t.adminSaveBtn : t.adminCreateBtn}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
