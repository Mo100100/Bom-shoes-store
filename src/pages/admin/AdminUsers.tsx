import { useEffect, useMemo, useState } from 'react'
import { supabase, Profile } from '@/lib/supabase'
import { useAuth } from '@/contexts/AuthContext'
import { useLanguage, useT } from '@/contexts/LanguageContext'
import { Loader2, ChevronDown, Search } from 'lucide-react'
import LoadErrorPanel from '@/components/LoadErrorPanel'
import { toast } from 'sonner'

// PostgREST truncates every response at max_rows = 1000 (supabase/config.toml)
// and reports no error when it does, so this asks for exactly that many and
// asks for the true total alongside it. Deliberately NOT paginated: the search
// box and the last-admin guard below both reason over the loaded array, so a
// page would quietly narrow a search and weaken a safety check. A visible
// "showing the newest N of M" is the honest version of the same ceiling.
const MAX_ROWS = 1000

const ROLE_VALUES = ['customer', 'admin']
const ROLE_LABEL_MAP: Record<string, 'adminRoleCustomer' | 'adminRoleAdmin'> = {
  customer: 'adminRoleCustomer',
  admin: 'adminRoleAdmin',
}

export default function AdminUsers() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [totalProfiles, setTotalProfiles] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [search, setSearch] = useState('')
  const { profile: me, isAdmin } = useAuth()
  const t = useT()
  const { lang } = useLanguage()

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return profiles
    return profiles.filter(p =>
      (p.email || '').toLowerCase().includes(q) ||
      (p.full_name || '').toLowerCase().includes(q)
    )
  }, [profiles, search])

  async function load() {
    setLoading(true)
    const { data, error, count } = await supabase
      .from('profiles')
      .select('*', { count: 'exact' })
      .order('created_at', { ascending: false })
      .limit(MAX_ROWS)
    // An empty user list is impossible (whoever is reading this screen is in
    // it), so rendering one for a failed read would only ever be a lie.
    setLoadError(!!error)
    setProfiles(error ? [] : data || [])
    setTotalProfiles(error ? 0 : count || 0)
    setLoading(false)
  }
  useEffect(() => { load() }, [])

  async function updateRole(p: Profile, newRole: string) {
    // Losing the only other admin is not something to discover later: the
    // owner would be alone on the account with no way back except SQL.
    // Self-demotion is already impossible (the select is disabled, and a
    // trigger refuses it), so this is only ever about somebody else.
    const otherAdmins = profiles.filter(x => x.role === 'admin' && x.id !== me?.id)
    if (newRole !== 'admin' && p.role === 'admin' && otherAdmins.length === 1) {
      if (!confirm(t.adminLastAdminConfirm)) { load(); return }
    }
    const { data, error } = await supabase
      .from('profiles').update({ role: newRole }).eq('id', p.id).select('id')
    if (error) { toast.error(error.message); return }
    // A role change matching no row comes back with no error: an RLS denial
    // here would otherwise report a promotion or a demotion that never was.
    if (!data.length) { toast.error(t.adminSaveNotApplied); load(); return }
    toast.success(t.adminRoleUpdated)
    load()
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        {/* A count over a failed read would read as "you have no users". */}
        {!loadError && <p className="text-sm text-muted-foreground">{t.adminUsersCount(filtered.length)}</p>}
        {!loadError && totalProfiles > profiles.length && (
          <p className="text-sm text-terracotta">{t.adminListTruncated(profiles.length, totalProfiles)}</p>
        )}
      </div>

      <div className="relative mb-4 max-w-sm">
        <Search className="w-4 h-4 absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder={t.adminSearchUsers}
          className="w-full bg-transparent border border-border ps-9 pe-3 py-2 text-sm focus:border-foreground outline-none"
        />
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
                  <th className="text-start px-4 py-3">{t.fieldEmail}</th>
                  <th className="text-start px-4 py-3">{t.fieldFullName}</th>
                  <th className="text-start px-4 py-3">{t.adminDate}</th>
                  <th className="text-start px-4 py-3">{t.adminRole}</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-12 text-center text-muted-foreground">{t.adminNoUsers}</td>
                  </tr>
                )}
                {filtered.map(p => {
                  const isSelf = p.id === me?.id
                  return (
                    <tr key={p.id} className="border-t border-border hover:bg-muted/20">
                      <td className="px-4 py-3">
                        {p.email || t.dash}{isSelf && <span className="text-xs text-muted-foreground">{t.adminYouSuffix}</span>}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">{p.full_name || t.dash}</td>
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {new Date(p.created_at).toLocaleDateString(lang === 'ar' ? 'ar-EG' : 'en-US', { year: 'numeric', month: 'short', day: 'numeric' })}
                      </td>
                      <td className="px-4 py-3">
                        {isAdmin ? (
                          <div className="relative inline-block">
                            <select
                              value={p.role}
                              disabled={isSelf}
                              // ponytail: block self-demotion by disabling the control outright
                              // rather than a confirm() dialog -- nothing to misclick through,
                              // and it can't leave the app with zero admins by accident.
                              title={isSelf ? t.adminCantChangeOwnRole : undefined}
                              onChange={e => updateRole(p, e.target.value)}
                              className="appearance-none bg-transparent border border-border px-2.5 py-1 pe-7 text-xs cursor-pointer focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              {ROLE_VALUES.map(r => (
                                <option key={r} value={r}>{t[ROLE_LABEL_MAP[r]]}</option>
                              ))}
                            </select>
                            <ChevronDown className="w-3 h-3 absolute end-2 top-1/2 -translate-y-1/2 pointer-events-none" />
                          </div>
                        ) : (
                          <span className="text-xs">{t[ROLE_LABEL_MAP[p.role]] || p.role}</span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
