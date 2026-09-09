import { useEffect, useState, Fragment } from 'react'
import { supabase, ActivityLog } from '@/lib/supabase'
import { useT } from '@/contexts/LanguageContext'
import { Loader2, ChevronDown, ChevronRight } from 'lucide-react'
import LoadErrorPanel from '@/components/LoadErrorPanel'
import { toast } from 'sonner'

const PAGE_SIZE = 50

function actionClass(action: string): string {
  if (action === 'INSERT') return 'border-emerald-700/50 text-emerald-700'
  if (action === 'DELETE') return 'border-red-700/50 text-red-700'
  return 'border-muted-foreground/40 text-muted-foreground' // UPDATE
}

export default function AdminActivityLog() {
  const [logs, setLogs] = useState<ActivityLog[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [filter, setFilter] = useState('all')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // actor_id -> display name. No FK-embeddable relationship from
  // activity_logs to profiles (actor_id references auth.users, not
  // profiles), so actor names are resolved with a separate lookup and
  // joined client-side -- same pattern AdminCoupons.tsx uses for redemption
  // counts/product names.
  const [actorNames, setActorNames] = useState<Record<string, string>>({})
  const t = useT()

  // Labels are singular for readability; the filter value itself is the real
  // entity_type stored on the row, which is the trigger's tg_table_name (i.e.
  // the plural table name -- 'products'/'orders'/'coupons').
  const FILTER_OPTIONS = [
    { value: 'all', label: t.shopAll },
    { value: 'products', label: t.adminProduct },
    { value: 'orders', label: t.adminOrder },
    { value: 'coupons', label: t.adminCoupon },
  ]

  function buildQuery(activeFilter: string) {
    let query = supabase.from('activity_logs').select('*').order('created_at', { ascending: false })
    if (activeFilter !== 'all') query = query.eq('entity_type', activeFilter)
    return query
  }

  async function loadActorNames(rows: ActivityLog[], known: Record<string, string>) {
    const missing = Array.from(new Set(rows.map(r => r.actor_id).filter((id): id is string => !!id && !known[id])))
    if (!missing.length) return
    const { data } = await supabase.from('profiles').select('id, email, full_name').in('id', missing)
    if (!data || !data.length) return
    setActorNames(prev => {
      const next = { ...prev }
      for (const p of data) next[p.id] = p.full_name || p.email || p.id
      return next
    })
  }

  async function load() {
    setLoading(true)
    const { data, error } = await buildQuery(filter).range(0, PAGE_SIZE - 1)
    const rows = error ? [] : data || []
    // "No activity recorded yet" for a failed read is how an audit trail stops
    // being an audit trail: nothing looks wrong.
    setLoadError(!!error)
    setLogs(rows)
    setHasMore(rows.length === PAGE_SIZE)
    setExpanded(new Set())
    await loadActorNames(rows, actorNames)
    setLoading(false)
  }
  useEffect(() => { load() }, [filter])

  async function loadMore() {
    setLoadingMore(true)
    const { data, error } = await buildQuery(filter).range(logs.length, logs.length + PAGE_SIZE - 1)
    // A failed page must not read as "that was the end of the log": keep the
    // button and say what happened, rather than silently hiding the rest.
    if (error) { toast.error(t.adminLoadError); setLoadingMore(false); return }
    const rows = data || []
    setLogs(prev => [...prev, ...rows])
    setHasMore(rows.length === PAGE_SIZE)
    await loadActorNames(rows, actorNames)
    setLoadingMore(false)
  }

  function toggle(id: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function actorLabel(l: ActivityLog): string {
    if (!l.actor_id) return t.adminSystem
    return actorNames[l.actor_id] || l.actor_id.slice(0, 8)
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-6 flex-wrap gap-3">
        <div className="flex items-center gap-1 overflow-x-auto scrollbar-none">
          {FILTER_OPTIONS.map(f => (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-3 py-1.5 text-xs tracking-wider uppercase whitespace-nowrap cursor-pointer transition-colors ${
                filter === f.value
                  ? 'bg-foreground text-background'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="py-24 flex justify-center">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : loadError ? (
        <LoadErrorPanel onRetry={load} />
      ) : logs.length === 0 ? (
        <div className="border border-border bg-card p-12 text-center">
          <p className="text-muted-foreground">{t.adminNoActivity}</p>
        </div>
      ) : (
        <div className="border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-xs tracking-widest uppercase text-muted-foreground">
                <tr>
                  <th className="text-start px-4 py-3">{t.adminTime}</th>
                  <th className="text-start px-4 py-3">{t.adminActor}</th>
                  <th className="text-start px-4 py-3">{t.adminAction}</th>
                  <th className="text-start px-4 py-3">{t.adminEntity}</th>
                  <th className="text-end px-4 py-3">{t.adminDetailsCol}</th>
                </tr>
              </thead>
              <tbody>
                {logs.map(l => (
                  <Fragment key={l.id}>
                    <tr
                      className="border-t border-border hover:bg-muted/20 cursor-pointer"
                      onClick={() => toggle(l.id)}
                    >
                      <td className="px-4 py-3 text-muted-foreground whitespace-nowrap">
                        {new Date(l.created_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}
                      </td>
                      <td className="px-4 py-3">{actorLabel(l)}</td>
                      <td className="px-4 py-3">
                        <span className={`text-xs px-2 py-0.5 border ${actionClass(l.action)}`}>{l.action}</span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-muted-foreground" title={l.entity_id || undefined}>
                        {l.entity_type}
                        {l.entity_id ? ` · ${l.entity_id.slice(0, 8)}` : ''}
                      </td>
                      <td className="px-4 py-3 text-end">
                        {/* Real <button>, not just the row's onClick, so the
                            toggle is reachable and operable from the keyboard
                            (a bare onClick on <tr> is invisible to Tab/Enter). */}
                        <button
                          type="button"
                          onClick={e => { e.stopPropagation(); toggle(l.id) }}
                          aria-expanded={expanded.has(l.id)}
                          aria-label={expanded.has(l.id) ? t.adminCollapseDetails : t.adminExpandDetails}
                          className="cursor-pointer p-1 -m-1"
                        >
                          {expanded.has(l.id)
                            ? <ChevronDown className="w-4 h-4 inline" />
                            : <ChevronRight className="w-4 h-4 inline" />}
                        </button>
                      </td>
                    </tr>
                    {expanded.has(l.id) && (
                      <tr className="border-t border-border bg-muted/10">
                        <td colSpan={5} className="px-4 py-3">
                          <pre className="text-xs font-mono whitespace-pre-wrap break-all">
                            {JSON.stringify(l.details, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
          {hasMore && (
            <div className="p-4 flex justify-center border-t border-border">
              <button
                onClick={loadMore}
                disabled={loadingMore}
                className="text-xs underline cursor-pointer disabled:opacity-50 flex items-center gap-2"
              >
                {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t.adminLoadMore}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
