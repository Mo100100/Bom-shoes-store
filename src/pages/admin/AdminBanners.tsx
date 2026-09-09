import { useEffect, useState } from 'react'
import { supabase, HeroBanner } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useT } from '@/contexts/LanguageContext'
import { Loader2, Plus, X, Edit2, Trash2, ArrowUp, ArrowDown } from 'lucide-react'
import { toast } from 'sonner'

const EMPTY: Partial<HeroBanner> = {
  title: '', subtitle: '', cta_text: '', cta_link: '', image_url: '', position: 0, active: true,
}

export default function AdminBanners() {
  const [banners, setBanners] = useState<HeroBanner[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [editing, setEditing] = useState<Partial<HeroBanner> | null>(null)
  const [saving, setSaving] = useState(false)
  const { isAdmin } = useAuth()
  const t = useT()

  async function load() {
    setLoading(true)
    const { data, error } = await supabase.from('hero_banners').select('*').order('position')
    // An empty table and a failed read looked identical here, and the empty
    // one invites the owner to re-create banners the storefront still shows.
    setLoadError(!!error)
    setBanners(error ? [] : data || [])
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  function openNew() {
    // New banners default to the end of the list, not position 0, so they
    // don't jump ahead of everything already ordered.
    const nextPosition = banners.length ? Math.max(...banners.map(b => b.position)) + 1 : 0
    setEditing({ ...EMPTY, position: nextPosition })
  }
  function openEdit(b: HeroBanner) {
    setEditing({ ...b })
  }

  async function toggleActive(b: HeroBanner) {
    const { error } = await supabase.from('hero_banners').update({ active: !b.active }).eq('id', b.id)
    if (error) { toast.error(error.message); return }
    load()
  }

  // Swaps this row with its neighbor in the currently-ordered list, then
  // reassigns 0..n-1 positions across the whole list -- simpler and more
  // robust than juggling raw position values, which can collide if rows were
  // ever saved with duplicate/default positions. List is short and
  // low-frequency to reorder, so re-writing every row is cheap.
  async function move(banner: HeroBanner, direction: -1 | 1) {
    const idx = banners.findIndex(b => b.id === banner.id)
    const swapIdx = idx + direction
    if (swapIdx < 0 || swapIdx >= banners.length) return
    const reordered = [...banners]
    ;[reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]]
    setBanners(reordered)
    await Promise.all(reordered.map((b, i) => supabase.from('hero_banners').update({ position: i }).eq('id', b.id)))
    load()
  }

  async function handleSave() {
    if (!editing) return
    if (!editing.title?.trim()) { toast.error(t.adminBannerTitleRequired); return }
    setSaving(true)
    try {
      const payload = {
        title: editing.title.trim(),
        subtitle: editing.subtitle?.trim() || null,
        cta_text: editing.cta_text?.trim() || null,
        cta_link: editing.cta_link?.trim() || null,
        image_url: editing.image_url?.trim() || null,
        position: Number(editing.position) || 0,
        active: !!editing.active,
      }

      if (editing.id) {
        const { data, error } = await supabase.from('hero_banners').update(payload).eq('id', editing.id).select('id')
        if (error) throw error
        // A zero-row match returns no error, so without this an RLS denial or
        // a banner deleted in another tab would report "Banner updated".
        if (!data.length) throw new Error(t.adminSaveNotApplied)
      } else {
        const { error } = await supabase.from('hero_banners').insert(payload)
        if (error) throw error
      }

      toast.success(editing.id ? t.adminBannerUpdated : t.adminBannerCreated)
      setEditing(null)
      load()
    } catch (e: any) {
      toast.error(e.message || t.adminGenericError)
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete(b: HeroBanner) {
    if (!confirm(t.adminDeleteConfirm(b.title))) return
    const { error } = await supabase.from('hero_banners').delete().eq('id', b.id)
    if (error) { toast.error(error.message); return }
    toast.success(t.adminBannerDeleted)
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        {/* A count over a failed read would read as "you have no banners". */}
        {!loadError && <p className="text-sm text-muted-foreground">{t.adminBannerCount(banners.length)}</p>}
        {isAdmin && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 text-sm tracking-wider hover:bg-primary/90 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            {t.adminAddBanner}
          </button>
        )}
      </div>

      {loading ? (
        <div className="py-24 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <div className="border border-terracotta bg-card p-12 text-center">
          <p className="text-terracotta">{t.adminLoadError}</p>
          <button
            onClick={() => load()}
            className="mt-4 text-sm border-b border-foreground pb-0.5 cursor-pointer"
          >
            {t.failedTryAgain}
          </button>
        </div>
      ) : (
        <div className="border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs tracking-widest uppercase text-muted-foreground">
                <tr>
                  <th className="text-start px-4 py-3">{t.adminBannerOrderCol}</th>
                  <th className="text-start px-4 py-3">{t.adminBannerCol}</th>
                  <th className="text-start px-4 py-3">{t.adminBannerCta}</th>
                  <th className="text-start px-4 py-3">{t.adminActiveLabel}</th>
                  <th className="text-end px-4 py-3">{t.adminActions}</th>
                </tr>
              </thead>
              <tbody>
                {banners.map((b, idx) => (
                  <tr key={b.id} className="border-t border-border">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => move(b, -1)}
                          disabled={idx === 0}
                          className="p-1 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          aria-label={t.adminMoveUp}
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => move(b, 1)}
                          disabled={idx === banners.length - 1}
                          className="p-1 hover:bg-muted disabled:opacity-30 disabled:cursor-not-allowed cursor-pointer"
                          aria-label={t.adminMoveDown}
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-muted overflow-hidden flex-shrink-0">
                          {b.image_url && <img src={b.image_url} alt="" className="w-full h-full object-cover" />}
                        </div>
                        <div className="min-w-0">
                          <p className="font-medium truncate">{b.title}</p>
                          {b.subtitle && <p className="text-xs text-muted-foreground truncate max-w-[240px]">{b.subtitle}</p>}
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {b.cta_text || t.dash}
                    </td>
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={b.active}
                        onChange={() => toggleActive(b)}
                        className="w-4 h-4 cursor-pointer"
                        aria-label={t.adminActiveLabel}
                      />
                    </td>
                    <td className="px-4 py-3 text-end">
                      <button onClick={() => openEdit(b)} className="p-1.5 hover:bg-muted cursor-pointer" aria-label={t.adminEditBanner}>
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => handleDelete(b)} className="p-1.5 hover:bg-muted text-red-700 cursor-pointer" aria-label={t.adminDeleteBanner}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
                {banners.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-4 py-12 text-center text-muted-foreground">{t.adminNoBanners}</td>
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
              <h2 className="font-display text-2xl">{editing.id ? t.adminEditBanner : t.adminNewBanner}</h2>
              <button onClick={() => setEditing(null)} className="p-2 cursor-pointer" aria-label={t.adminClose}>
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-5">
              <Field label={t.adminBannerTitleField} value={editing.title || ''} onChange={v => setEditing({ ...editing, title: v })} />
              <div>
                <label className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{t.adminBannerSubtitle}</label>
                <textarea
                  value={editing.subtitle || ''}
                  onChange={e => setEditing({ ...editing, subtitle: e.target.value })}
                  rows={2}
                  className="w-full bg-transparent border border-border p-3 text-sm focus:border-foreground outline-none"
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <Field label={t.adminBannerCtaText} value={editing.cta_text || ''} onChange={v => setEditing({ ...editing, cta_text: v })} />
                <Field label={t.adminBannerCtaLink} value={editing.cta_link || ''} onChange={v => setEditing({ ...editing, cta_link: v })} placeholder="/shop?category=Boots" />
              </div>
              <Field label={t.adminImageUrl} value={editing.image_url || ''} onChange={v => setEditing({ ...editing, image_url: v })} placeholder="https://…" />
              {editing.image_url && (
                <div className="w-full aspect-[21/9] bg-muted overflow-hidden">
                  <img src={editing.image_url} alt="" className="w-full h-full object-cover" />
                </div>
              )}
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

function Field({ label, value, onChange, type = 'text', placeholder = '' }: { label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string }) {
  return (
    <label className="block">
      <span className="block text-xs tracking-widest uppercase text-muted-foreground mb-2">{label}</span>
      <input
        type={type}
        value={value}
        placeholder={placeholder}
        onChange={e => onChange(e.target.value)}
        className="w-full bg-transparent border border-border px-3 py-2 text-sm focus:border-foreground outline-none"
      />
    </label>
  )
}
